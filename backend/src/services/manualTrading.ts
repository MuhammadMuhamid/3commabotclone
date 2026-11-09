import { createHash } from "node:crypto";
import { Prisma, type ExchangeAccount, type ManualOrder, type SmartTrade } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol, parsePair } from "../lib/symbols.js";
import { canonicalJson } from "../contract/realizationEventContract.js";
import {
  classifyExchangeFailure, clientOrderId, describeUncertainFailure, floorToStep,
} from "./binance.js";
import {
  BinanceManualExchange, type ManualExchangeAdapter, type ManualLotRules, type ManualOrderIntent,
  type ManualOrderSnapshot, ManualOrderNotFoundError,
} from "./manualExchange.js";
import { sendExecutionNotification } from "./push.js";
import { SUBMITTED_ABSENCE_SETTLE_MS } from "./strategyOrderIntent.js";
import {
  type BotOrderOrigin, type BotRiskLimits, evaluateBotHalt, evaluateBotRisk, getBotRiskLimits,
  readBotHaltState, readBotRiskSnapshot, setBotTradingHalted, shouldLatchHalt,
} from "./riskControls.js";
import { calcRealizedPnl } from "./smartTrade.js";
import {
  admitSpotEntry, clearanceForFirstSubmission, noteSpotExit, readShariahContext,
  shariahScopeForManualAccount,
} from "./shariah.js";

/** Every manual-order lifecycle status that is NOT terminal. */
export const PENDING_STATUSES = ["requested", "submitted", "open", "partially_filled"];
export const MAINNET_MANUAL_CONFIRMATION = "PLACE_MAINNET_ORDER";
const accountSubmitLocks = new Set<string>();

export class ManualTradingError extends Error {
  /**
   * `code` is a stable machine-readable reason for refusals a caller must be
   * able to tell apart (D2: `command_in_progress`, `command_outcome_unknown`,
   * `request_id_reused`, `order_not_found_at_exchange`). Optional; most
   * refusals carry only the message, as before.
   */
  constructor(message: string, readonly httpStatus: number = 400, readonly code?: string) {
    super(message);
    this.name = "ManualTradingError";
  }
}

/**
 * The halt refused a manual order that has not reached the exchange yet.
 *
 * `terminal` says what the reconciler must do with it. An ENTRY is finished:
 * it is recorded `rejected` with the halt reason, because resubmitting it
 * after a resume would open a position at a price, and a moment, nobody
 * chose. An automated EXIT is only held — it stays `requested` and goes out
 * once the halt lifts — because an exit is never abandoned.
 */
export class ManualHaltRefusal extends ManualTradingError {
  constructor(message: string, readonly terminal: boolean) {
    super(message, 409);
    this.name = "ManualHaltRefusal";
  }
}

export interface SubmitManualOrderInput {
  requestId: string;
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quoteQuantity?: number;
  baseQuantity?: number;
  limitPrice?: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  positionId?: string;
  mainnetConfirmation?: string;
  /**
   * The Platform's authenticated Shariah decision. `unknown` because it is
   * caller-supplied: only the shared contract's validator interprets it.
   *
   * It needs no separate signature. `requireManualAuth` verifies an HMAC over a
   * canonical hash of the entire body, so this block is covered by the same
   * signature as `side` and `symbol` — flipping EXCLUDED to ELIGIBLE, or
   * `enforce` to `off`, or the base asset, invalidates the request before it
   * reaches here.
   */
  shariah?: unknown;
}

type AdapterFactory = (account: ExchangeAccount) => ManualExchangeAdapter;
const defaultAdapter: AdapterFactory = (account) => new BinanceManualExchange(account);

export function manualLifecycleStatus(status: ManualOrderSnapshot["status"]): string {
  return ({ NEW: "open", PARTIALLY_FILLED: "partially_filled", FILLED: "filled",
    CANCELED: "canceled", REJECTED: "rejected", EXPIRED: "canceled" } as const)[status];
}

export function manualProtectionState(tp: number | null, sl: number | null, filledBase: number): string {
  return tp == null && sl == null ? "none" : filledBase > 0 ? "active" : "pending_entry";
}

export function resolveManualProtectionLevels(current: { tp: number | null; sl: number | null },
  patch: { tp?: number | null; sl?: number | null }): { tp: number | null; sl: number | null; state: string } {
  const tp = patch.tp === undefined ? current.tp : patch.tp;
  const sl = patch.sl === undefined ? current.sl : patch.sl;
  if (tp != null && (!(tp > 0) || (sl != null && tp <= sl)))
    throw new ManualTradingError("take profit must be positive and above stop loss", 422);
  if (sl != null && !(sl > 0)) throw new ManualTradingError("stop loss must be positive", 422);
  return { tp, sl, state: tp == null && sl == null ? "removed" : "active" };
}

export function assertManualAccountGate(account: ExchangeAccount, confirmation?: string): void {
  if (!config.manualTradingEnabled) throw new ManualTradingError("manual trading is disabled", 404);
  if (account.exchange !== "binance" || account.marketType.toLowerCase() !== "spot") {
    throw new ManualTradingError("manual trading supports Binance Spot accounts only", 422);
  }
  if (!account.testnet) {
    if (!config.mainnetManualTradingEnabled) {
      throw new ManualTradingError("mainnet manual trading is disabled", 403);
    }
    if (confirmation !== MAINNET_MANUAL_CONFIRMATION) {
      throw new ManualTradingError(
        `mainnet confirmation must be exactly ${MAINNET_MANUAL_CONFIRMATION}`, 400);
    }
  }
}

function intentFromOrder(order: ManualOrder): ManualOrderIntent {
  return { symbol: order.symbol, side: order.side as "BUY" | "SELL",
    orderType: order.orderType as "MARKET" | "LIMIT",
    quoteQuantity: order.requestedQuoteQty ?? undefined,
    baseQuantity: order.requestedBaseQty ?? undefined,
    limitPrice: order.limitPrice ?? undefined, clientOrderId: order.clientOrderId,
    // Carried through from the durable row, so a first submission and a
    // reconciliation resubmission are proved by the same stored decision.
    shariahContext: order.shariahContext };
}

function isComplete(status: string): boolean {
  return ["filled", "canceled", "rejected", "failed"].includes(status);
}

/** True for an exchange order id that came from the exchange, not from a dry-run simulation. */
function isRealExchangeOrderId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length > 0 && !id.startsWith("dry-");
}

/** Below this, two cumulative quantities are the same quantity. */
const QTY_EPSILON = 1e-12;

/** D1/I5: an entry still working at the exchange after its position closed. */
export const ENTRY_WORKING_AFTER_EXIT = "entry_working_after_exit";
/** D1/I4: a separate position holding a late fill. Protection is OFF. */
export const LATE_FILL_UNPROTECTED = "late_fill_unprotected";
/** D1/I7: the closedReason of a position closed because only dust remained. */
export const DUST_CLOSED_REASON = "dust_below_exchange_minimum";

/**
 * Operator-facing flags written to `ManualOrder.error`. A later snapshot clears
 * a transient note ("reconciliation pending ...") but must never erase one of
 * these: they record something the operator has to act on.
 */
const DURABLE_FLAG_PREFIXES = [
  "LATE FILL", "LATE SELL FILL", "ENTRY STILL WORKING", "ENTRY REFRESH FAILED", "DUST",
];

function durableFlag(error: string | null): string | null {
  return error != null && DURABLE_FLAG_PREFIXES.some((prefix) => error.startsWith(prefix))
    ? error : null;
}

function baseAssetOf(symbol: string): string {
  try { return parsePair(symbol).base; } catch { return normalizeSymbol(symbol); }
}

function entryWorkingMessage(tradeId: string, filledBase: number, symbol: string): string {
  return `ENTRY STILL WORKING: position ${tradeId} was closed while this LIMIT BUY is still ` +
    `working at the exchange (${filledBase} ${baseAssetOf(symbol)} filled so far). Further ` +
    "fills will NOT reopen that position and will NOT be protected by TP/SL. Cancel this order " +
    "through the cancel route if you do not want them.";
}

/** Effects that must not run inside the ledger transaction (logs, push). */
type AfterCommit = () => void;

/**
 * Apply one authoritative exchange snapshot and update the canonical SmartTrade ledger.
 *
 * D1 invariants, under any owner policy for a still-working entry:
 *
 *   I1  a closed (non-active) trade is never reactivated from a snapshot;
 *   I2  every snapshot applies as a DELTA over what this order already booked —
 *       remaining = acquired − exited — so a duplicate, an older or a
 *       re-read-unchanged snapshot changes nothing, and a partial exit taken
 *       while the entry is still working is never undone;
 *   I4  a BUY fill that lands after its trade closed is recorded, flagged and
 *       kept sellable as its own unprotected position; a SELL fill that lands
 *       after its position closed is flagged instead of silently dropped;
 *   I5  an entry still working when its trade closes is flagged.
 */
export async function applyManualSnapshot(orderId: string, snapshot: ManualOrderSnapshot): Promise<ManualOrder> {
  const afterCommit: AfterCommit[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.manualOrder.findUnique({ where: { id: orderId } });
    if (!before) throw new ManualTradingError("manual order not found", 404);
    // Cancel/reconcile requests can overlap after obtaining their exchange
    // snapshots. Do not let the slower, older response regress terminal truth
    // or cumulative fills. Equal quote fill is intentionally accepted because
    // a later trades lookup can correct BUY net base commission downward.
    if (isComplete(before.status) ||
        snapshot.executedQuoteQuantity + 1e-9 < before.filledQuoteQty) {
      return before;
    }
    /*
     * I2: with an unchanged cumulative quote, the only legitimate base change is
     * that commission correction (DOWN). A HIGHER base at the same quote is the
     * gross figure of a fill already netted — a trades lookup that failed on
     * this pass — and is not new: keep the netted figure.
     */
    const sameQuote = before.filledQuoteQty > 0 &&
      Math.abs(snapshot.executedQuoteQuantity - before.filledQuoteQty) <= 1e-9;
    const executedBase = sameQuote
      ? Math.min(snapshot.executedBaseQuantity, before.filledBaseQty)
      : snapshot.executedBaseQuantity;
    const deltaBase = executedBase - before.filledBaseQty;
    const deltaQuote = Math.max(0, snapshot.executedQuoteQuantity - before.filledQuoteQty);
    const status = manualLifecycleStatus(snapshot.status);
    // A simulated (`dry-`) id never replaces an id the exchange really assigned.
    const exchangeOrderId = isRealExchangeOrderId(before.exchangeOrderId) &&
      !isRealExchangeOrderId(snapshot.exchangeOrderId)
      ? before.exchangeOrderId : (snapshot.exchangeOrderId || before.exchangeOrderId);
    let protectionState = manualProtectionState(
      before.takeProfitPrice, before.stopLossPrice, executedBase);
    let error: string | null = before.side === "SELL" ? durableFlag(before.error) : null;

    if (before.side === "BUY") {
      const existing = await tx.smartTrade.findUnique({ where: { manualOrderId: before.id } });
      const pricing = { entryPrice: snapshot.averagePrice, currentPrice: snapshot.averagePrice,
        buyPrice: snapshot.averagePrice, exchangeOrderId };
      if (!existing) {
        if (executedBase > 0) {
          await tx.smartTrade.create({ data: { source: "manual", exchangeAccountId: before.exchangeAccountId,
            botName: "Manual", pair: before.symbol, direction: "long", status: "active", ...pricing,
            quantity: executedBase, quoteSpent: snapshot.executedQuoteQuantity,
            clientOrderId: before.clientOrderId, manualTpPrice: before.takeProfitPrice,
            manualSlPrice: before.stopLossPrice, protectionType: "bot-managed", protectionState,
            manualOrderId: before.id } });
        }
      } else if (existing.status === "active") {
        if (Math.abs(deltaBase) > QTY_EPSILON || deltaQuote > QTY_EPSILON) {
          // I2: add only what is new; exits already taken stay taken.
          await tx.smartTrade.update({ where: { id: existing.id }, data: { ...pricing,
            quantity: Math.max(0, existing.quantity + deltaBase),
            quoteSpent: existing.quoteSpent + deltaQuote,
            manualTpPrice: before.takeProfitPrice, manualSlPrice: before.stopLossPrice,
            protectionType: "bot-managed", protectionState } });
        }
      } else {
        // I1: the trade is closed and stays closed, whatever this snapshot says.
        protectionState = isComplete(status) ? "removed" : ENTRY_WORKING_AFTER_EXIT;
        error = durableFlag(before.error);
        // An entry that has stopped working is no longer "still working".
        if (isComplete(status) && error?.startsWith("ENTRY STILL WORKING")) error = null;
        /*
         * OWNER POLICY HOOK — deliberately not implemented. Whether a working
         * entry's remainder is CANCELLED before an exit, or a late fill is
         * automatically PROTECTED, is the owner's decision (scout-3 §5.7). A
         * policy would plug in here and in the I5 flag below. Until then the
         * Bot only records, flags, and keeps the late quantity sellable.
         */
        if (deltaBase > QTY_EPSILON) {
          const late = await recordLateEntryFill(tx, before, existing, deltaBase, deltaQuote,
            snapshot, executedBase, !isComplete(status));
          error = late.message;
          afterCommit.push(() => {
            console.error(`[manual] ${late.message}`);
            void sendExecutionNotification({ side: "buy", symbol: before.symbol, quantity: deltaBase,
              quoteAmount: deltaQuote, price: snapshot.averagePrice ?? 0,
              orderId: `${snapshot.exchangeOrderId || before.clientOrderId}-late-${late.positionId}` })
              .catch((e) => console.error("late-fill notification failed", e));
          });
        } else if (!error && !isComplete(status)) {
          // I5, for a trade closed by a path that did not stamp it (e.g. dust).
          error = entryWorkingMessage(existing.id, executedBase, before.symbol);
        }
      }
    }

    if (before.side === "SELL" && before.linkedPositionId && deltaBase > QTY_EPSILON) {
      const position = await tx.smartTrade.findUnique({ where: { id: before.linkedPositionId } });
      if (position?.status === "active") {
        const remaining = Math.max(0, position.quantity - deltaBase);
        const ratio = position.quantity > 0 ? remaining / position.quantity : 0;
        const realised = calcRealizedPnl(deltaQuote, position.quoteSpent);
        const closes = remaining <= position.quantity * 0.001;
        await tx.smartTrade.update({ where: { id: position.id }, data:
          closes
            ? { status: "closed", closedAt: new Date(), closedReason: "manual_sell",
                protectionState: "removed", currentPrice: snapshot.averagePrice,
                pnlUsdt: realised.pnlUsdt, pnlPct: realised.pnlPct }
            : { quantity: remaining, quoteSpent: position.quoteSpent * ratio } });
        if (closes && position.manualOrderId) {
          await flagEntryStillWorking(tx, position.id, position.manualOrderId, afterCommit);
        }
      } else if (position) {
        // I4 (SELL side): this used to be dropped without a trace.
        const message = `LATE SELL FILL: ${fmtQty(deltaBase)} ${baseAssetOf(before.symbol)} of this ` +
          `SELL filled after its position ${position.id} was already closed` +
          `${position.closedReason ? ` (${position.closedReason})` : ""}. It was NOT deducted from ` +
          "any tracked position, so the wallet now holds less than the ledgers expect: check the " +
          "account balance and every other position in this asset.";
        error = message;
        afterCommit.push(() => console.error(`[manual] ${message}`));
      }
    }

    return tx.manualOrder.update({ where: { id: orderId }, data: {
      status, exchangeOrderId,
      filledBaseQty: executedBase,
      filledQuoteQty: snapshot.executedQuoteQuantity,
      averageFillPrice: snapshot.averagePrice, submittedAt: before.submittedAt ?? new Date(),
      completedAt: isComplete(status) ? new Date() : null, protectionState, error,
    }});
  });
  for (const effect of afterCommit) effect();
  return result;
}

function fmtQty(value: number): string {
  return Number(value.toPrecision(12)).toString();
}

/** The interactive-transaction client, as `prisma.$transaction` hands it over. */
type LedgerTx = Pick<typeof prisma, "smartTrade" | "manualOrder">;

/**
 * D1/I4: a BUY fill on an entry whose trade already closed.
 *
 * The closed trade is never reopened. The late quantity is real, though, and
 * the supported manual SELL route only sells a TRACKED position
 * (`assertSellAssociation` requires a `positionId` once anything is tracked on
 * the account and symbol). So the late quantity becomes its OWN position:
 * source `manual`, no TP/SL, `protectionState: late_fill_unprotected` — which
 * the protection poller never selects. It is linked to its entry by a
 * deterministic, unique `clientOrderId` (`<entry client id>:late:<n>`), never
 * by `manualOrderId`, which belongs to the closed trade.
 */
async function recordLateEntryFill(tx: LedgerTx, entry: ManualOrder, closed: SmartTrade,
  deltaBase: number, deltaQuote: number, snapshot: ManualOrderSnapshot, cumulativeBase: number,
  stillWorking: boolean): Promise<{ positionId: string; message: string }> {
  const prefix = `${entry.clientOrderId}:late:`;
  const open = await tx.smartTrade.findFirst({ where: { clientOrderId: { startsWith: prefix },
    status: "active" }, orderBy: { createdAt: "desc" } });
  let positionId: string;
  if (open) {
    await tx.smartTrade.update({ where: { id: open.id }, data: {
      quantity: open.quantity + deltaBase, quoteSpent: open.quoteSpent + deltaQuote } });
    positionId = open.id;
  } else {
    const earlier = await tx.smartTrade.count({ where: { clientOrderId: { startsWith: prefix } } });
    const price = snapshot.averagePrice ?? (deltaBase > 0 ? deltaQuote / deltaBase : null);
    const created = await tx.smartTrade.create({ data: {
      source: "manual", exchangeAccountId: entry.exchangeAccountId, botName: "Manual (late fill)",
      pair: entry.symbol, direction: "long", status: "active", entryPrice: price,
      currentPrice: price, buyPrice: price, quantity: deltaBase, quoteSpent: deltaQuote,
      exchangeOrderId: snapshot.exchangeOrderId || entry.exchangeOrderId,
      clientOrderId: `${prefix}${earlier + 1}`, manualTpPrice: null, manualSlPrice: null,
      protectionType: null, protectionState: LATE_FILL_UNPROTECTED,
    } });
    positionId = created.id;
  }
  const base = baseAssetOf(entry.symbol);
  const message = `LATE FILL: ${fmtQty(deltaBase)} ${base} of this BUY filled after its position ` +
    `${closed.id} was closed${closed.closedReason ? ` (${closed.closedReason})` : ""} ` +
    `(cumulative fill now ${fmtQty(cumulativeBase)} ${base}). This quantity is NOT protected by ` +
    `TP/SL. It was not added to the closed position: it is tracked as a separate, unprotected ` +
    `position ${positionId}. Sell it with a manual SELL of that position, or set TP/SL on it ` +
    "explicitly." + (stillWorking
    ? " The order is still working: cancel it through the cancel route to stop further unprotected fills."
    : "");
  return { positionId, message };
}

/** D1/I5: the trade closed while its entry is still working at the exchange. */
async function flagEntryStillWorking(tx: LedgerTx, tradeId: string, entryId: string,
  afterCommit: AfterCommit[]): Promise<void> {
  const entry = await tx.manualOrder.findUnique({ where: { id: entryId } });
  if (!entry || !PENDING_STATUSES.includes(entry.status) || durableFlag(entry.error)) return;
  // OWNER POLICY HOOK: a cancel-first policy would cancel the remainder here.
  const message = entryWorkingMessage(tradeId, entry.filledBaseQty, entry.symbol);
  await tx.manualOrder.update({ where: { id: entry.id }, data: {
    protectionState: ENTRY_WORKING_AFTER_EXIT, error: message } });
  afterCommit.push(() => console.error(`[manual] ${message}`));
}

/**
 * D1/I3: the most an exit of `position` may sell — never more than the
 * position's own remaining quantity, nor more than the FREE balance left after
 * every OTHER tracked position in the same base asset on this account (manual
 * trades of the account, strategy trades whose bot trades through it).
 *
 * Documented limit: a strategy bot on env credentials (`exchangeAccountId`
 * null) may be the same Binance account, but nothing here can know that, so it
 * is not counted.
 */
export async function manualExitCapacity(position: Pick<SmartTrade, "id" | "pair" | "quantity">,
  accountId: string, free: number): Promise<{ capacity: number; otherTracked: number }> {
  const base = baseAssetOf(position.pair);
  const others = await prisma.smartTrade.findMany({ where: { status: "active", id: { not: position.id },
    OR: [
      { source: "manual", exchangeAccountId: accountId },
      { source: "strategy", bot: { exchangeAccountId: accountId } },
    ] }, select: { pair: true, quantity: true } });
  const otherTracked = others.filter((other) => baseAssetOf(other.pair) === base)
    .reduce((sum, other) => sum + other.quantity, 0);
  return { capacity: Math.max(0, Math.min(position.quantity, free - otherTracked)), otherTracked };
}

/**
 * D1/I7: close a position whose remainder can never be sold — below the lot
 * minimum after flooring to the step, or below the minimum notional — with an
 * explicit dust note, instead of attempting an exit that must fail forever.
 * The dust stays in the wallet, untracked, as on the strategy side.
 */
export async function closeManualDust(positionId: string, rules: ManualLotRules,
  price: number | null, noteOrderId?: string): Promise<boolean> {
  if (!(rules.minQty > 0) && !(rules.minNotional > 0)) return false;
  const position = await prisma.smartTrade.findUnique({ where: { id: positionId } });
  if (!position || position.status !== "active") return false;
  const sellable = floorToStep(position.quantity, rules.stepSize);
  const belowLot = !(sellable > 0) || sellable < rules.minQty;
  const belowNotional = rules.minNotional > 0 && price != null && price > 0 &&
    sellable * price < rules.minNotional;
  if (!belowLot && !belowNotional) return false;
  const note = `DUST: ${fmtQty(position.quantity)} ${baseAssetOf(position.pair)} remained on position ` +
    `${position.id}, below the exchange minimum (${belowLot
      ? `lot minimum ${rules.minQty}, step ${rules.stepSize}`
      : `minimum notional ${rules.minNotional}`}). The position was closed; the remainder stays ` +
    "in the wallet, untracked, and no exit that must fail is attempted for it.";
  const closed = await prisma.smartTrade.updateMany({ where: { id: position.id, status: "active" },
    data: { status: "closed", closedAt: new Date(), closedReason: DUST_CLOSED_REASON,
      protectionState: "removed" } });
  if (closed.count !== 1) return false;
  if (noteOrderId) await prisma.manualOrder.update({ where: { id: noteOrderId }, data: { error: note } });
  console.error(`[manual] ${note}`);
  return true;
}

/**
 * D1/I8: before a TP/SL exit or a full manual exit, refresh a still-working
 * entry by its client order id and apply it, so the exit sells everything
 * acquired up to the exit decision. A failed read never blocks the exit: it
 * proceeds with the known quantity and the caller records the returned flag.
 */
export async function refreshWorkingEntry(position: SmartTrade, adapter: ManualExchangeAdapter):
  Promise<{ position: SmartTrade | null; entryWorking: boolean; flag?: string }> {
  if (!position.manualOrderId) return { position, entryWorking: false };
  const entry = await prisma.manualOrder.findUnique({ where: { id: position.manualOrderId } });
  if (!entry || !["open", "partially_filled"].includes(entry.status)) {
    return { position, entryWorking: false };
  }
  let failure: string | undefined;
  try {
    const snapshot = await adapter.query(entry.symbol, entry.clientOrderId);
    if (snapshot) await applyManualSnapshot(entry.id, snapshot);
    else failure = "the exchange found no order under its client order id";
  } catch (error) {
    failure = error instanceof Error ? error.message : "lookup failed";
  }
  const fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
  if (!failure) return { position: fresh, entryWorking: true };
  const flag = `ENTRY REFRESH FAILED: the working entry ${entry.clientOrderId} could not be ` +
    `refreshed before this exit (${failure}); the exit was sized from the last known quantity ` +
    `${fmtQty(position.quantity)}.`;
  console.error(`[manual] ${flag}`);
  return { position: fresh, entryWorking: true, flag };
}

/**
 * The account risk gate for a manual order.
 *
 * D-9: this used to refuse a manual SELL while halted, and the halt latches
 * itself on a daily-loss breach — so the loss that tripped it also took away
 * the operator's only way to close the position by hand, with a 409. A manual
 * order is an OPERATOR order, and an operator's exit is never gated by the
 * halt (see `evaluateBotRisk`). A BUY still is, and so is everything automated.
 *
 * "Exit" is decided from server-side facts only: the side is the validated
 * enum, compared exactly so anything that is not literally `SELL` is judged as
 * an entry; and the account is Binance Spot (`assertManualAccountGate`), where
 * a SELL can only dispose of a holding the account already has — the exchange
 * itself refuses to sell what is not there. `assertSellAssociation` has
 * already tied it to the tracked position and the real balance.
 */
async function enforceRisk(input: SubmitManualOrderInput, adapter: ManualExchangeAdapter): Promise<void> {
  const side = input.side === "SELL" ? "sell" : "buy";
  // An exit is exempt from every numeric limit, so its notional is never
  // needed — and a failed price read must not be what refuses a close.
  let quoteQty = input.quoteQuantity ?? 0;
  if (side === "buy" && quoteQty <= 0) quoteQty = (input.baseQuantity ?? 0) *
    (input.limitPrice ?? await adapter.ticker(input.symbol));
  const limits = await getBotRiskLimits();
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
  const decision = evaluateBotRisk(limits, snapshot, { side, quoteQty, origin: "operator" });
  if (!decision.allowed) {
    const latch = shouldLatchHalt(decision);
    if (latch) await setBotTradingHalted(true, { by: latch, reason: decision.reason });
    throw new ManualTradingError(decision.code === "trading_halted"
      ? `${decision.reason}. Closing an open position is still allowed.`
      : decision.reason, 409);
  }
}

async function assertSellAssociation(input: SubmitManualOrderInput, account: ExchangeAccount,
  adapter: ManualExchangeAdapter): Promise<void> {
  const [manualPositions, automatedPositions] = await Promise.all([
    prisma.smartTrade.findMany({ where: { source: "manual", exchangeAccountId: account.id,
      pair: input.symbol, status: "active" }, select: { id: true, quantity: true } }),
    prisma.smartTrade.findMany({ where: { source: "strategy", pair: input.symbol, status: "active",
      bot: { exchangeAccountId: account.id } }, select: { quantity: true } }),
  ]);
  const trackedQuantity = [...manualPositions, ...automatedPositions]
    .reduce((sum, item) => sum + item.quantity, 0);
  if (trackedQuantity > 0) {
    const actual = await adapter.baseTotal(input.symbol);
    if (actual + Math.max(1e-12, trackedQuantity * 1e-8) < trackedQuantity)
      throw new ManualTradingError(
        "account balance is below tracked positions; reconcile the external balance change before selling", 409);
  }
  if (input.positionId) {
    const position = manualPositions.find((item) => item.id === input.positionId);
    if (!position) throw new ManualTradingError("manual position not found for this account and symbol", 422);
    if ((input.baseQuantity ?? 0) > position.quantity * 1.000000001) {
      throw new ManualTradingError("sell quantity exceeds the selected manual position", 422);
    }
  } else if (manualPositions.length > 0 || automatedPositions.length > 0) {
    throw new ManualTradingError(
      automatedPositions.length > 0
        ? "manual wallet sell is blocked while an automated trade tracks this account and symbol"
        : "select the tracked manual position before selling, so its ledger and TP/SL stay authoritative",
      409);
  }
}

export async function submitManualOrder(
  raw: SubmitManualOrderInput, adapterFactory: AdapterFactory = defaultAdapter
): Promise<ManualOrder> {
  const input = { ...raw, symbol: normalizeSymbol(raw.symbol) };
  const account = await prisma.exchangeAccount.findUnique({ where: { id: input.accountId } });
  if (!account) throw new ManualTradingError("exchange account not found", 404);
  assertManualAccountGate(account, input.mainnetConfirmation);
  // The route's schema already restricts the side; this is the service's own
  // floor. An unreadable side is neither an entry nor an exit it can reason
  // about, and below it would otherwise be noted as a Shariah EXIT.
  if (input.side !== "BUY" && input.side !== "SELL")
    throw new ManualTradingError("side must be exactly BUY or SELL", 422);
  if (input.side === "BUY" && (!input.quoteQuantity || input.quoteQuantity <= 0))
    throw new ManualTradingError("BUY requires a positive quote quantity", 422);
  if (input.side === "SELL" && (!input.baseQuantity || input.baseQuantity <= 0))
    throw new ManualTradingError("SELL requires a positive base quantity", 422);
  if (input.orderType === "LIMIT" && (!input.limitPrice || input.limitPrice <= 0))
    throw new ManualTradingError("LIMIT requires a positive limit price", 422);
  if (input.side === "SELL" && (input.takeProfitPrice != null || input.stopLossPrice != null))
    throw new ManualTradingError("TP/SL can only be attached to a long BUY entry", 422);

  /*
   * The Shariah gate, at the earliest point where the symbol and side are both
   * known: after authentication and request validation, and before the exchange
   * adapter, the risk gate, the per-account lock and — critically — before
   * `manualOrder.create`, which is where the client order id is claimed. A
   * refusal throws out of a purely synchronous check, so nothing is reserved
   * and nothing needs unwinding.
   *
   * A SELL only records what it asserted. There is no path below on which a
   * Shariah status can refuse an exit.
   */
  const shariahScope = shariahScopeForManualAccount(account.id);
  const shariahContext = input.side === "BUY"
    ? (await admitSpotEntry({
      scope: shariahScope, symbol: input.symbol, context: readShariahContext(input.shariah),
      // The request HMAC already covers the whole body, so the block arrives
      // authenticated to exactly the same standard as `side` and `symbol`.
      auth: { kind: "request-signature" },
    })).persisted
    : await noteSpotExit(shariahScope, input.shariah, { symbol: input.symbol });

  const adapter = adapterFactory(account);
  /*
   * D1/I8 for an OPERATOR exit: a manual SELL of a position whose entry is
   * still working first refreshes that entry, so the ledger is current before
   * any exit. A manual order is NEVER raised (F1): it sells at most what the
   * operator asked for, capped by I3. Any refreshed remainder stays an active,
   * TP/SL-protected position, and a request beyond the (refreshed) position is
   * still refused by `assertSellAssociation`. Only the automated protection
   * exit sizes itself to everything acquired.
   */
  let refreshFlag: string | null = null;
  let fullExitPositionId: string | null = null;
  if (input.side === "SELL" && input.positionId) {
    const target = await prisma.smartTrade.findFirst({ where: { id: input.positionId, source: "manual",
      exchangeAccountId: account.id, pair: input.symbol, status: "active" } });
    if (target?.manualOrderId) {
      const refresh = await refreshWorkingEntry(target, adapter);
      refreshFlag = refresh.flag ?? null;
      const refreshed = refresh.position;
      const requested = input.baseQuantity ?? 0;
      if (refresh.entryWorking && refreshed?.status === "active" &&
          requested <= refreshed.quantity * 1.000000001) {
        const free = adapter.baseFree ? await adapter.baseFree(input.symbol) : Number.POSITIVE_INFINITY;
        const { capacity } = await manualExitCapacity(refreshed, account.id, free);
        if (!(capacity > 0)) {
          throw new ManualTradingError("the free balance attributable to this position is 0; " +
            "reconcile the account balance before selling", 409);
        }
        input.baseQuantity = Math.min(requested, capacity);
        fullExitPositionId = input.baseQuantity >= refreshed.quantity * (1 - 1e-9) ? target.id : null;
      }
    }
  }
  if (input.side === "SELL") await assertSellAssociation(input, account, adapter);
  let order: ManualOrder | null = null;
  if (accountSubmitLocks.has(account.id))
    throw new ManualTradingError("another manual order is being reserved for this account; retry shortly", 409);
  accountSubmitLocks.add(account.id);
  try {
    await enforceRisk(input, adapter);
    try {
      order = await prisma.manualOrder.create({ data: {
        requestId: input.requestId, exchangeAccountId: account.id,
        linkedPositionId: input.positionId, symbol: input.symbol, side: input.side,
        orderType: input.orderType, quantityType: input.side === "BUY" ? "quote" : "base",
        requestedQuoteQty: input.quoteQuantity, requestedBaseQty: input.baseQuantity,
        limitPrice: input.limitPrice, takeProfitPrice: input.takeProfitPrice,
        stopLossPrice: input.stopLossPrice,
        protectionType: input.side === "BUY" && (input.takeProfitPrice != null || input.stopLossPrice != null)
          ? "bot-managed" : null,
        protectionState: input.side === "BUY" && (input.takeProfitPrice != null || input.stopLossPrice != null)
          ? "pending_entry" : "none",
        shariahContext,
        clientOrderId: clientOrderId(`manual:${input.requestId}`),
        error: refreshFlag,
      }});
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existing = await prisma.manualOrder.findUnique({ where: { requestId: input.requestId } });
        if (existing) return existing;
      }
      throw error;
    }
  } finally {
    accountSubmitLocks.delete(account.id);
  }
  if (!order) throw new ManualTradingError("manual order reservation failed", 500);

  let applied: ManualOrder;
  try {
    order = await prisma.manualOrder.update({ where: { id: order.id },
      data: { status: "submitted", submittedAt: new Date() } });
    applied = await applyManualSnapshot(order.id, await adapter.submit(intentFromOrder(order)));
  } catch (error) {
    /*
     * D2: only a DEFINITE rejection is terminal — a local refusal raised
     * before the exchange call (Shariah, filters, notional) or a whitelisted
     * Binance code. Everything else (-1006/-1007, 5xx, transport failures,
     * unknown codes) may have executed: the row stays `submitted`, with the
     * reason recorded, and is reconciled by its client order id.
     */
    const failure = classifyExchangeFailure(error);
    const rejected = failure.outcome === "rejected";
    const failed = !rejected && config.dryRun;
    return prisma.manualOrder.update({ where: { id: order.id }, data: {
      status: rejected ? "rejected" : failed ? "failed" : "submitted",
      error: rejected || failed
        ? (error instanceof Error ? error.message : "exchange order failed")
        : describeUncertainFailure(failure),
      completedAt: rejected || failed ? new Date() : null }});
  }
  if (fullExitPositionId && adapter.lotRules) {
    // D1/I7: a full exit that leaves only an unsellable remainder closes it.
    try {
      if (await closeManualDust(fullExitPositionId, await adapter.lotRules(input.symbol),
        applied.averageFillPrice, applied.id)) {
        return prisma.manualOrder.findUniqueOrThrow({ where: { id: applied.id } });
      }
    } catch (error) {
      console.error(`[manual] dust check after exit ${applied.id} failed`, error);
    }
  }
  return applied;
}

export async function cancelManualOrder(
  orderId: string, confirmation?: string, adapterFactory: AdapterFactory = defaultAdapter
): Promise<ManualOrder> {
  const order = await prisma.manualOrder.findUnique({ where: { id: orderId },
    include: { exchangeAccount: true } });
  if (!order) throw new ManualTradingError("manual order not found", 404);
  if (order.orderType !== "LIMIT" || !PENDING_STATUSES.includes(order.status))
    throw new ManualTradingError("only a pending LIMIT order can be canceled", 409);
  assertManualAccountGate(order.exchangeAccount, confirmation);
  const adapter = adapterFactory(order.exchangeAccount);
  /*
   * A dry-run adapter can only SIMULATE a cancel. An order that was placed on
   * the exchange (a real, non-`dry-` exchange id — e.g. while DRY_RUN was off)
   * is still working there, so a simulated CANCELED would mark a live order
   * canceled and leave it untracked. Refuse instead.
   */
  const simulated = (adapter as { dryRun?: boolean }).dryRun ?? config.dryRun;
  if (simulated && isRealExchangeOrderId(order.exchangeOrderId)) {
    throw new ManualTradingError("This order was placed on the exchange; switch DRY_RUN off to " +
      "cancel it, or cancel it on the exchange. It is still working.", 409, "live_order_in_dry_run");
  }
  let snapshot: ManualOrderSnapshot;
  try {
    snapshot = await adapter.cancel(order.symbol, order.clientOrderId);
  } catch (error) {
    // D2: -2011 and then nothing found by the client id. A coded answer, not a
    // 500; the order stays as recorded and reconciliation resolves it.
    if (error instanceof ManualOrderNotFoundError) {
      throw new ManualTradingError(`${error.message}. The order stays as recorded; reconciliation ` +
        "resolves it by its client order id.", 409, "order_not_found_at_exchange");
    }
    throw error;
  }
  return applyManualSnapshot(order.id, snapshot);
}

export async function updateManualProtection(input: { positionId: string;
  takeProfitPrice?: number | null; stopLossPrice?: number | null;
  mainnetConfirmation?: string }): Promise<unknown> {
  const position = await prisma.smartTrade.findFirst({ where: { id: input.positionId,
    source: "manual", status: "active" }, include: { exchangeAccount: true, manualOrder: true } });
  if (!position?.exchangeAccount) throw new ManualTradingError("active manual position not found", 404);
  assertManualAccountGate(position.exchangeAccount, input.mainnetConfirmation);
  const { tp, sl, state } = resolveManualProtectionLevels(
    { tp: position.manualTpPrice, sl: position.manualSlPrice },
    { tp: input.takeProfitPrice, sl: input.stopLossPrice });
  const writes: Prisma.PrismaPromise<unknown>[] = [prisma.smartTrade.update({
    where: { id: position.id }, data: { manualTpPrice: tp, manualSlPrice: sl,
      protectionType: "bot-managed", protectionState: state } })];
  if (position.manualOrderId) writes.push(prisma.manualOrder.update({
    where: { id: position.manualOrderId }, data: { takeProfitPrice: tp,
      stopLossPrice: sl, protectionType: "bot-managed", protectionState: state } }));
  const [updated] = await prisma.$transaction(writes);
  return updated;
}

/**
 * Who asked for a stored manual order, for the halt.
 *
 * Every manual order is an operator's, except the SELL the bot-managed TP/SL
 * monitor creates when a level is hit. That one is automation, and the monitor
 * marks it `protectionState: "triggered"` — a value only this server writes,
 * never one a request can set. (A snapshot overwrites the field, but by then
 * the row has left `requested`, which is the only state this is asked about.)
 */
export function manualOrderOrigin(order: Pick<ManualOrder, "side" | "protectionState">): BotOrderOrigin {
  return order.side === "SELL" && order.protectionState === "triggered" ? "automation" : "operator";
}

/**
 * The halt, re-checked at the moment the reconciler would place a manual order
 * for the first time — with the same rule the submission used.
 *
 * Only the halt. The numeric limits were applied when the order was admitted,
 * and re-checking them here would count this order's own reserved exposure (a
 * `requested` BUY is already in the risk snapshot) a second time.
 */
export async function assertManualFirstSubmitNotHalted(
  order: ManualOrder, readLimits: () => Promise<Pick<BotRiskLimits, "tradingHalted" | "haltedReason">> =
  getBotRiskLimits
): Promise<void> {
  const limits = await readLimits();
  // Exact: a stored side that is not literally SELL is judged as an entry.
  const side = order.side === "SELL" ? "sell" : "buy";
  const decision = evaluateBotHalt(limits, { side, origin: manualOrderOrigin(order) });
  if (decision.allowed) return;
  throw new ManualHaltRefusal(decision.reason, side !== "sell");
}

/**
 * Consecutive failed exchange lookups before an unresolved order is called out.
 * Same idiom as the TP/SL monitor's `UNMONITORED_ALERT_CYCLES`: one miss is
 * ordinary, three in a row (90 s at the 30 s cadence) is an outcome nobody can
 * currently see. Repeats every 30 cycles, never every cycle.
 */
export const MANUAL_LOOKUP_ALERT_CYCLES = 3;
const manualLookupFailures = new Map<string, number>();

/** The exchange lookup itself failed: no evidence either way. */
class ManualLookupError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : "exchange lookup failed");
    this.name = "ManualLookupError";
  }
}

export async function reconcilePendingManualOrders(
  adapterFactory: AdapterFactory = defaultAdapter, limit = 100,
  /** `now` is the time seam for the absence rule; production passes nothing. */
  options: { now?: number } = {}
): Promise<void> {
  if (!config.manualTradingEnabled || config.dryRun) return;
  const now = options.now ?? Date.now();
  const orders = await prisma.manualOrder.findMany({ where: { status: { in: PENDING_STATUSES } },
    include: { exchangeAccount: true }, orderBy: { createdAt: "asc" }, take: Math.min(limit, 100) });
  for (const order of orders) {
    try {
      const adapter = adapterFactory(order.exchangeAccount);
      const step = await reconcileManualOrderStep(order, adapter, defaultFirstSubmitGate, true);
      manualLookupFailures.delete(order.id);
      if (step.kind === "snapshot") await applyManualSnapshot(order.id, step.snapshot);
      else if (step.kind === "absent") await closeOffAbsentManualOrder(order, now);
    } catch (error) {
      if (error instanceof ManualHaltRefusal && error.terminal) {
        // Compare-and-set on `requested`: that status is the proof nothing was
        // sent, and it is the only state this may finish. Same terminal state
        // a pre-exchange Shariah or validation refusal records.
        await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" }, data: {
          status: "rejected", completedAt: new Date(),
          error: `refused before submission: ${error.message}` }});
        continue;
      }
      if (error instanceof ManualLookupError) {
        await recordManualLookupFailure(order, error);
        continue;
      }
      await prisma.manualOrder.update({ where: { id: order.id }, data: {
        error: `reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}` }});
    }
  }
}

/**
 * D2: the repo's EXISTING absence rule, applied to an uncertain manual order.
 *
 * `strategyOrderIntent.ts` already closes a `submitted` strategy SELL off as
 * `rejected`/ABSENT once the exchange answers "no such order" more than
 * `SUBMITTED_ABSENCE_SETTLE_MS` (60 s) after submission
 * (`resolveOneUnresolvedSell`), and `exitSettlement.ts` abandons a submitted
 * exit attempt on the same rule. This is that rule, not a new one: only a
 * DEFINITIVE not-found answer (-2013) counts — a failed lookup never reaches
 * here — and only for a row still `submitted`, i.e. never acknowledged by the
 * exchange. An acknowledged (`open`/`partially_filled`) order is never closed
 * off by a miss.
 */
async function closeOffAbsentManualOrder(order: ManualOrder, now: number): Promise<void> {
  if (order.status !== "submitted") return;
  const submittedAt = (order.submittedAt ?? order.createdAt).getTime();
  if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) return;
  await prisma.manualOrder.updateMany({ where: { id: order.id, status: "submitted" }, data: {
    status: "rejected", completedAt: new Date(),
    error: `ABSENT: the exchange has no order under client order id ${order.clientOrderId} ` +
      `${SUBMITTED_ABSENCE_SETTLE_MS / 1000} s after an uncertain submission, so none was placed ` +
      "(the existing strategy-SELL absence rule, SUBMITTED_ABSENCE_SETTLE_MS)." } });
}

async function recordManualLookupFailure(order: ManualOrder, error: ManualLookupError): Promise<void> {
  const count = (manualLookupFailures.get(order.id) ?? 0) + 1;
  manualLookupFailures.set(order.id, count);
  if (!durableFlag(order.error)) {
    await prisma.manualOrder.update({ where: { id: order.id }, data: {
      error: `reconciliation pending: the exchange lookup by client order id failed ${count} ` +
        `consecutive time(s): ${error.message}` } });
  }
  if (count === MANUAL_LOOKUP_ALERT_CYCLES || count % (MANUAL_LOOKUP_ALERT_CYCLES * 10) === 0) {
    console.error(`[manual-reconcile] ALERT: ${order.side} ${order.symbol} order ${order.id} ` +
      `(${order.clientOrderId}) could not be looked up for ${count} consecutive cycles; its ` +
      "exchange outcome is unknown and it stays pending. A failed lookup never closes an order.");
  }
}

/** A submission the reconciler itself made failed: classify it exactly as a first submission. */
async function recordManualSubmitFailure(orderId: string, error: unknown): Promise<void> {
  const failure = classifyExchangeFailure(error);
  if (failure.outcome === "rejected") {
    await prisma.manualOrder.updateMany({ where: { id: orderId, status: "submitted" }, data: {
      status: "rejected", completedAt: new Date(), error: failure.message } });
    return;
  }
  await prisma.manualOrder.update({ where: { id: orderId }, data: {
    error: describeUncertainFailure(failure) } });
}

const defaultFirstSubmitGate = async (order: ManualOrder): Promise<unknown> => {
  // The halt first: an entry queued before a halt must not land after it
  // latched. An operator's exit passes; an automated exit waits.
  await assertManualFirstSubmitNotHalted(order);
  // Shariah: BUY only, and the asymmetry is the point: an exit interrupted
  // between its reservation and the exchange must always be able to finish,
  // whatever this installation has since decided about the asset.
  if (order.side !== "BUY") return undefined;
  return clearanceForFirstSubmission({
    scope: shariahScopeForManualAccount(order.exchangeAccountId),
    symbol: order.symbol,
    persisted: order.shariahContext,
  });
};

export async function reconcileOneManualOrder(
  order: ManualOrder, adapter: ManualExchangeAdapter,
  /**
   * The first-submission gate (halt, then Shariah), injectable so a pure lifecycle test
   * needs no database. It defaults to the real one — a caller that wants no
   * gate has to ask for it in writing, in this file, where it is visible.
   */
  assertMayFirstSubmit: (o: ManualOrder) => Promise<unknown> = defaultFirstSubmitGate
): Promise<ManualOrderSnapshot | null> {
  // The pure form: no compare-and-set and no recording, so a lifecycle check
  // needs no database. The reconciler loop uses the claiming form below.
  try {
    const step = await reconcileManualOrderStep(order, adapter, assertMayFirstSubmit, false);
    return step.kind === "snapshot" ? step.snapshot : null;
  } catch (error) {
    throw error instanceof ManualLookupError ? error.original : error;
  }
}

type ManualReconcileStep =
  | { kind: "snapshot"; snapshot: ManualOrderSnapshot }
  /** The exchange definitively answered "no such order" for an attempted row. */
  | { kind: "absent" }
  /** Nothing left to apply: another worker owns it, or a failed submit was recorded. */
  | { kind: "handled" };

async function reconcileManualOrderStep(
  order: ManualOrder, adapter: ManualExchangeAdapter,
  assertMayFirstSubmit: (o: ManualOrder) => Promise<unknown>,
  /** Claim the row (requested -> submitted) before submitting, and record a failed submit. */
  claim: boolean
): Promise<ManualReconcileStep> {
  let found: ManualOrderSnapshot | null;
  try {
    found = await adapter.query(order.symbol, order.clientOrderId);
  } catch (error) {
    throw new ManualLookupError(error);
  }
  /*
   * `submitted` means an exchange request was already attempted. A lookup can
   * temporarily miss an accepted order (or the process can have died between
   * the durable state change and the request), so absence is not evidence that
   * placing a replacement is safe. Keep reconciling the stable client order id
   * instead. Only `requested` proves this process has not crossed the shared
   * submission boundary yet.
   */
  if (found) return { kind: "snapshot", snapshot: found };
  if (order.status !== "requested") return { kind: "absent" };
  /*
   * Same rule as the strategy path: this order has not crossed the submission
   * boundary, so placing it now is creating exposure now. An order admitted
   * while nothing was enforcing carries no decision, and an installation that
   * has since begun enforcing must not have that order land anyway.
   */
  await assertMayFirstSubmit(order);
  if (!claim) return { kind: "snapshot", snapshot: await adapter.submit(intentFromOrder(order)) };
  /*
   * D1/I6: compare-and-set `requested` -> `submitted` BEFORE the wire call, as
   * `submitManualOrder` and the strategy path do. Two overlapping reconcilers
   * (or the protection poller) can no longer both submit the same row, and a
   * row that crossed the wire can never again read `requested`.
   */
  const claimed = await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" },
    data: { status: "submitted", submittedAt: new Date() } });
  if (claimed.count !== 1) return { kind: "handled" };
  try {
    return { kind: "snapshot", snapshot: await adapter.submit(intentFromOrder(order)) };
  } catch (error) {
    await recordManualSubmitFailure(order.id, error);
    return { kind: "handled" };
  }
}

export async function listManualState(symbol?: string): Promise<unknown> {
  const pair = symbol ? normalizeSymbol(symbol) : undefined;
  const [accounts, orders, positions] = await Promise.all([
    prisma.exchangeAccount.findMany({ where: { exchange: "binance", marketType: "spot" },
      select: { id: true, name: true, exchange: true, marketType: true, testnet: true },
      orderBy: { createdAt: "asc" } }),
    prisma.manualOrder.findMany({ where: pair ? { symbol: pair } : undefined,
      orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.smartTrade.findMany({ where: { source: "manual", ...(pair ? { pair } : {}) },
      // manualOrderId / exchangeOrderId let a client derive the position's
      // environment from its own entry evidence (a `dry-` id ⇒ DRY_RUN).
      select: { id: true, exchangeAccountId: true, manualOrderId: true, exchangeOrderId: true,
        pair: true, status: true, entryPrice: true,
        currentPrice: true, quantity: true, quoteSpent: true, pnlUsdt: true, pnlPct: true,
        manualTpPrice: true, manualSlPrice: true, protectionType: true, protectionState: true,
        createdAt: true, closedAt: true, closedReason: true },
      orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  /*
   * Say whether the TP/SL poller is actually running, so no client can show a
   * position as protected while it is not (checkManualProtection returns early
   * when manual trading is off or the Bot is halted, and skips mainnet-account
   * positions while mainnet manual trading is off). Additive fields only.
   */
  const halt = await readBotHaltState();
  const polling = config.manualTradingEnabled && !halt.halted;
  const note = !config.manualTradingEnabled
    ? "TP/SL is NOT being checked: manual trading is disabled on the Bot."
    : halt.halted
      ? "TP/SL is NOT being checked: the Bot is halted. Your own SELL still works; resume the Bot to restore protection."
      : "Checked by the bot poller about every 30 s; no exchange-resting protective order is claimed.";
  return { enabled: config.manualTradingEnabled,
    mainnetEnabled: config.mainnetManualTradingEnabled, dryRun: config.dryRun,
    tradingHalted: halt.halted,
    mixed: accounts.some((a) => a.testnet) && accounts.some((a) => !a.testnet),
    accounts: accounts.map((a) => ({ ...a, mode: a.testnet ? "testnet" : "mainnet" })),
    orders, positions, protection: { type: "bot-managed", exchangeResting: false, polling,
      haltedBy: halt.haltedBy, mainnetPositionsChecked: config.mainnetManualTradingEnabled, note } };
}

/** The stored identity of a command body: kind plus key-order-independent JSON. */
export function manualCommandBodyHash(kind: string, body: unknown): string {
  return createHash("sha256").update(canonicalJson({ kind, body })).digest("hex");
}

/**
 * How long a `processing` command is reported as still running. After it, the
 * first attempt is treated as an UNKNOWN outcome — never re-executed (D2).
 */
const COMMAND_IN_PROGRESS_MS = 30_000;

/**
 * Durable idempotency for submit, cancel, and protection-update commands.
 *
 * D2: a command whose first attempt may have reached the exchange is never run
 * a second time. A stale `processing` row used to be re-executed after 30 s;
 * it now answers a coded `command_outcome_unknown`, and the order it created
 * (if any) is resolved by reconciliation by its client order id. A reused
 * request id must also carry the same body: `body` is hashed and compared,
 * and a mismatch is `request_id_reused` (409).
 */
export async function runIdempotentManualCommand<T>(
  requestId: string, kind: string, action: () => Promise<T>, options: { body?: unknown } = {}
): Promise<T> {
  const bodyHash = options.body === undefined ? null : manualCommandBodyHash(kind, options.body);
  try {
    await prisma.manualCommand.create({ data: { requestId, kind, bodyHash } });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "P2002") throw error;
    const existing = await prisma.manualCommand.findUnique({ where: { requestId } });
    if (!existing) throw error;
    if (existing.kind !== kind) {
      throw new ManualTradingError("request id was already used for another command", 409,
        "request_id_reused");
    }
    // A row from before body hashing (null) cannot be compared, and is not.
    if (bodyHash && existing.bodyHash && existing.bodyHash !== bodyHash) {
      throw new ManualTradingError("request id was already used with a different request body", 409,
        "request_id_reused");
    }
    if (existing.status === "succeeded" && existing.result) return JSON.parse(existing.result) as T;
    if (existing.status === "failed") throw new ManualTradingError(existing.error ?? "command previously failed", 409);
    if (Date.now() - existing.updatedAt.getTime() < COMMAND_IN_PROGRESS_MS) {
      throw new ManualTradingError("the same command is already processing", 409, "command_in_progress");
    }
    /*
     * F6: a stale `processing` row. Nothing is re-executed that could reach
     * the exchange a second time:
     *   - submit_order: the reservation (unique `requestId`) precedes any wire
     *     call, so an existing ManualOrder IS this command's outcome — return
     *     its current state, exactly the idempotent replay a re-run used to
     *     reach through the P2002 path. With no ManualOrder, nothing was sent
     *     and nothing is known: a coded 409.
     *   - cancel_order: re-run. A cancel never creates exposure, and it is
     *     idempotent against the order's current state: a cancel already done
     *     at the exchange answers -2011 and is resolved by query; one already
     *     recorded locally is refused before any wire call.
     *   - update_protection: NOT re-run. It writes absolute levels, so a stale
     *     retry could overwrite a newer edit and loosen protection; coded 409.
     */
    if (kind === "submit_order") {
      const order = await prisma.manualOrder.findUnique({ where: { requestId } });
      if (order) return order as unknown as T;
    }
    if (kind !== "cancel_order") {
      throw new ManualTradingError(
        "an earlier attempt of this command did not finish and its outcome is unknown; it is not " +
        "run again. Read the current state from /state and retry with a new request id if needed",
        409, "command_outcome_unknown");
    }
    // Claim the stale row (compare-and-set on its timestamp), so two retries
    // arriving together cannot both re-run it.
    const claimed = await prisma.manualCommand.updateMany({ where: { requestId, status: "processing",
      updatedAt: existing.updatedAt }, data: { error: null } });
    if (claimed.count !== 1) {
      throw new ManualTradingError("the same command is already processing", 409, "command_in_progress");
    }
  }
  try {
    const result = await action();
    await prisma.manualCommand.update({ where: { requestId }, data: {
      status: "succeeded", result: JSON.stringify(result), error: null } });
    return result;
  } catch (error) {
    await prisma.manualCommand.update({ where: { requestId }, data: {
      status: "failed", error: error instanceof Error ? error.message : "command failed" } });
    throw error;
  }
}
