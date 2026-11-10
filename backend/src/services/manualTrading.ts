import { createHash } from "node:crypto";
import { Prisma, type ExchangeAccount, type ManualOrder, type SmartTrade } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol, parsePair } from "../lib/symbols.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import { canonicalJson } from "../contract/realizationEventContract.js";
import {
  classifyCancelFailure, classifyExchangeFailure, clientOrderId, describeUncertainFailure, floorToStep,
} from "./binance.js";
import {
  BinanceManualExchange, type ManualExchangeAdapter, type ManualLotRules, type ManualOrderIntent,
  type ManualOrderSnapshot, ManualOrderNotFoundError,
} from "./manualExchange.js";
import { abandonOrderAttempt, settleOrderAttempt } from "./orderAttempt.js";
import { sendExecutionNotification } from "./push.js";
import { confirmedEnvironment, recordExecutionEvent } from "./executionEvents.js";
import { manualExecutionEnvironment } from "./executionEnvironment.js";
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
  /**
   * OD-7: sell ALL that remains of `positionId` (plus a race fill, per OD-1),
   * capped by the free balance attributable to it (I3) and the lot rules. Only
   * on a SELL with a `positionId`, and never beside a `baseQuantity`.
   */
  positionFull?: true;
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

/**
 * The adapter the route-level manual commands use: a submitted order (when the
 * caller passes none) and the control-plane cancels (OD-3
 * `cancelWorkingEntries`, from C9 and the dashboard). A seam in the
 * `tradeExchangeClient` idiom, so a route test can point it at a fake
 * exchange; production never changes it.
 */
export const manualAdapterSeam: { factory: AdapterFactory } = { factory: defaultAdapter };

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
 * OD-1 (owner-approved option C): a position holding fills of an entry that
 * landed after its trade closed, while the cancel-first policy was engaged.
 * Unlike `late_fill_unprotected`, the protection poller SELLS it ("sweep").
 */
export const RACE_FILL_SWEEP = "race_fill_sweep";
/** OD-1: the closedReason of a race-fill position the sweep sold. */
export const RACE_FILL_SWEPT_REASON = "entry_race_fill_swept";
/** OD-1: cancels per entry under the policy (pre-exit and finalizer together). */
export const EXIT_CANCEL_MAX_ATTEMPTS = 5;
/** OD-1: the attempt after which an unconfirmed cancel is called out (and again at the maximum). */
export const EXIT_CANCEL_ALERT_AT = 3;

/** Who decided an exit, for the OD-1 sweep's halt rule. */
export type ExitOrigin = "automation" | "operator";

/**
 * Operator-facing flags written to `ManualOrder.error`. A later snapshot clears
 * a transient note ("reconciliation pending ...") but must never erase one of
 * these: they record something the operator has to act on.
 */
const DURABLE_FLAG_PREFIXES = [
  "LATE FILL", "LATE SELL FILL", "ENTRY STILL WORKING", "ENTRY REFRESH FAILED", "DUST",
  // OD-1 / X7
  "RACE FILL", "ENTRY CANCEL PENDING", "ENTRY CANCEL FAILED", "ENTRY CANCELED AFTER EXIT",
  "SWEEP FAILED", "NETTING UNCONFIRMED",
];

function durableFlag(error: string | null): string | null {
  return error != null && DURABLE_FLAG_PREFIXES.some((prefix) => error.startsWith(prefix))
    ? error : null;
}

/**
 * F7 (review 2026-11-09): a new operator flag goes first, and a durable flag
 * already on the order is kept after it, never erased (a `RACE FILL` or
 * `NETTING UNCONFIRMED` the operator still has to see). A transient note is
 * dropped, exactly as a later snapshot drops it.
 */
function withDurableFlag(note: string, previous: string | null): string {
  const kept = durableFlag(previous);
  return kept && kept !== note ? `${note} ${kept}` : note;
}

/**
 * X7 / F3: the haircut of an exit whose entry fills could not be netted of
 * their base-asset commission — Binance's maximum spot fee, 0.1 %
 * [EXT-UNVERIFIED offline]. Selling that much less keeps a gross figure from
 * selling fee-sized untracked coins. The sweep (`SWEEP_UNNETTED_HAIRCUT`), the
 * TP/SL exits and the manual full SELL all use this one figure.
 */
export const UNNETTED_EXIT_HAIRCUT = 0.001;

function baseAssetOf(symbol: string): string {
  try { return parsePair(symbol).base; } catch { return normalizeSymbol(symbol); }
}

function entryWorkingMessage(tradeId: string, filledBase: number, symbol: string): string {
  return `ENTRY STILL WORKING: position ${tradeId} was closed while this LIMIT BUY is still ` +
    `working at the exchange (${filledBase} ${baseAssetOf(symbol)} filled so far). Further ` +
    "fills will NOT reopen that position and will NOT be protected by TP/SL. Cancel this order " +
    "through the cancel route if you do not want them.";
}

/** OD-1: the trade closed while its entry is still working; the Bot owes a cancel. */
function entryCancelPendingMessage(tradeId: string, filledBase: number, symbol: string): string {
  return `ENTRY CANCEL PENDING: position ${tradeId} was closed while this LIMIT BUY was still ` +
    `working at the exchange (${fmtQty(filledBase)} ${baseAssetOf(symbol)} filled so far). The Bot ` +
    "is cancelling the remainder. Until the exchange confirms the cancel, further fills can still " +
    "land: any that do are tracked as a separate race-fill position, which has no TP/SL and which " +
    "the Bot sells automatically.";
}

function entryCanceledAfterExitMessage(tradeId: string, filledBase: number, symbol: string): string {
  return `ENTRY CANCELED AFTER EXIT: the remainder of this LIMIT BUY was cancelled after its ` +
    `position ${tradeId} closed; ${fmtQty(filledBase)} ${baseAssetOf(symbol)} filled in total.`;
}

/** A note that only describes a still-working entry, and so ends with it. */
function isWorkingNote(error: string | null): boolean {
  return error != null &&
    (error.startsWith("ENTRY STILL WORKING") || error.startsWith("ENTRY CANCEL PENDING"));
}

/**
 * Effects that must not run inside the ledger transaction (logs, push, and the
 * OD-1 inline cancel attempt, which talks to the exchange). Run in order after
 * the commit; an async one is awaited.
 */
type AfterCommit = () => void | Promise<void>;

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
 *       kept sellable as its own position; a SELL fill that lands after its
 *       position closed is flagged instead of silently dropped;
 *   I5  an entry still working when its trade closes is flagged.
 *
 * OD-1 (owner-approved option C, cancel first then sweep): when the trade
 * closes while its entry still works, the entry is marked for a cancel
 * (`markEntryForExitCancel`), and a fill that still lands afterwards becomes a
 * `race_fill_sweep` position the protection poller sells. With `adapter`, one
 * cancel attempt runs right after the commit; without it, the reconciler owes it.
 *
 * X7: a terminal BUY whose fills were booked GROSS (the trades lookup failed)
 * still accepts the later NETTED figure for the same fills, and the downward
 * correction reduces whichever ledger holds them — never anything else.
 */
export async function applyManualSnapshot(orderId: string, snapshot: ManualOrderSnapshot,
  options: { adapter?: ManualExchangeAdapter } = {}): Promise<ManualOrder> {
  const afterCommit: AfterCommit[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.manualOrder.findUnique({ where: { id: orderId } });
    if (!before) throw new ManualTradingError("manual order not found", 404);
    const nettingCorrection = isNettingCorrection(before, snapshot);
    // Cancel/reconcile requests can overlap after obtaining their exchange
    // snapshots. Do not let the slower, older response regress terminal truth
    // or cumulative fills. Equal quote fill is intentionally accepted because
    // a later trades lookup can correct BUY net base commission downward.
    if ((isComplete(before.status) && !nettingCorrection) ||
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
    // A netting correction changes the base figure only; the order's terminal
    // status and completion time are already the exchange's truth.
    const status = nettingCorrection ? before.status : manualLifecycleStatus(snapshot.status);
    // X7: netted unless this snapshot is gross AND brings fills not yet netted.
    const fillsNetted = snapshot.netted !== false || !(executedBase > 0) ||
      (sameQuote && before.fillsNetted);
    // OD-1: once the entry is terminal at the exchange, nothing is left to cancel.
    const exitCancelState = isComplete(status) && before.exitCancelState != null
      ? "done" : before.exitCancelState;
    // A simulated (`dry-`) id never replaces an id the exchange really assigned.
    const exchangeOrderId = isRealExchangeOrderId(before.exchangeOrderId) &&
      !isRealExchangeOrderId(snapshot.exchangeOrderId)
      ? before.exchangeOrderId : (snapshot.exchangeOrderId || before.exchangeOrderId);
    let protectionState = manualProtectionState(
      before.takeProfitPrice, before.stopLossPrice, executedBase);
    let error: string | null = durableFlag(before.error);
    // P-81: the position this fill belongs to, for the execution event.
    let eventTradeId: string | null = before.side === "SELL" ? before.linkedPositionId : null;

    if (before.side === "BUY") {
      const existing = await tx.smartTrade.findUnique({ where: { manualOrderId: before.id } });
      eventTradeId = existing?.id ?? null;
      const pricing = { entryPrice: snapshot.averagePrice, currentPrice: snapshot.averagePrice,
        buyPrice: snapshot.averagePrice, exchangeOrderId };
      if (!existing) {
        if (executedBase > 0) {
          eventTradeId = (await tx.smartTrade.create({ data: { source: "manual", exchangeAccountId: before.exchangeAccountId,
            botName: "Manual", pair: before.symbol, direction: "long", status: "active", ...pricing,
            quantity: executedBase, quoteSpent: snapshot.executedQuoteQuantity,
            clientOrderId: before.clientOrderId, manualTpPrice: before.takeProfitPrice,
            manualSlPrice: before.stopLossPrice, protectionType: "bot-managed", protectionState,
            manualOrderId: before.id } })).id;
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
        const engaged = before.exitCancelState != null;
        // An entry that has stopped working is no longer "still working" or
        // "cancel pending": say how it ended instead.
        if (isComplete(status) && !isComplete(before.status) && isWorkingNote(error)) {
          error = engaged && status === "canceled"
            ? entryCanceledAfterExitMessage(existing.id, executedBase, before.symbol) : null;
        }
        /*
         * OD-1 (owner-approved option C): the exit path pre-cancels a working
         * entry, so a fill during that race is already in the exit. What lands
         * here is what became known only after the close (an unknown cancel,
         * a close by a path that did not pre-cancel): it is booked as its own
         * position, `race_fill_sweep` when the policy is engaged, which the
         * protection poller sells. A legacy entry (policy not engaged) keeps
         * the interim rule: an unprotected late-fill position.
         */
        if (deltaBase > QTY_EPSILON) {
          const late = await recordLateEntryFill(tx, before, existing, deltaBase, deltaQuote,
            snapshot, executedBase, !isComplete(status), engaged);
          error = late.message;
          eventTradeId = late.positionId;
          afterCommit.push(() => {
            console.error(`[manual] ${late.message}`);
            void sendExecutionNotification({ side: "buy", symbol: before.symbol, quantity: deltaBase,
              quoteAmount: deltaQuote, price: snapshot.averagePrice ?? 0,
              orderId: `${snapshot.exchangeOrderId || before.clientOrderId}-late-${late.positionId}` })
              .catch((e) => console.error("late-fill notification failed", e));
          });
        } else if (deltaBase < -QTY_EPSILON) {
          // X7: the netted figure for fills already booked after the close.
          const netted = await reduceLatePosition(tx, before, -deltaBase);
          if (netted) {
            afterCommit.push(() => console.error(`[manual] X7: position ${netted.id} reduced from ` +
              `${fmtQty(netted.from)} to ${fmtQty(netted.to)} by the netted base-asset commission of ` +
              `entry ${before.clientOrderId}`));
          }
        } else if (!error && !isComplete(status)) {
          // I5, for a trade closed by a path that did not stamp it.
          error = engaged ? entryCancelPendingMessage(existing.id, executedBase, before.symbol)
            : entryWorkingMessage(existing.id, executedBase, before.symbol);
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
          // OD-1: the entry may still be working; the policy owes it a cancel.
          await markEntryForExitCancel(tx, position.id, position.manualOrderId,
            manualOrderOrigin(before), afterCommit, options.adapter);
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

    /*
     * P-81: one event per newly booked fill increment (I2 makes every snapshot
     * a delta, so a duplicate, older or unchanged snapshot books nothing and
     * records nothing). A netting correction only lowers the base figure of
     * fills already announced: it is not an execution.
     */
    if (!nettingCorrection && deltaBase > QTY_EPSILON && deltaQuote > QTY_EPSILON) {
      await recordExecutionEvent(tx, {
        eventId: `manual:${before.id}:${snapshot.executedQuoteQuantity.toFixed(8)}`,
        side: before.side === "BUY" ? "BUY" : "SELL",
        symbol: before.symbol,
        executedBaseQty: deltaBase,
        executedQuoteQty: deltaQuote,
        averagePrice: deltaQuote / deltaBase,
        environment: confirmedEnvironment(before.executionEnvironment, { exchangeOrderId }),
        source: before.side === "SELL" && before.protectionType === "bot-managed" ? "manual-protection" : "manual",
        orderComplete: isComplete(status),
        cumulativeBaseQty: executedBase,
        botId: null,
        botName: "Manual",
        smartTradeId: eventTradeId,
        exchangeOrderId: exchangeOrderId || null,
      });
    }

    return tx.manualOrder.update({ where: { id: orderId }, data: {
      status, exchangeOrderId,
      filledBaseQty: executedBase,
      filledQuoteQty: snapshot.executedQuoteQuantity,
      averageFillPrice: nettingCorrection ? before.averageFillPrice : snapshot.averagePrice,
      submittedAt: before.submittedAt ?? new Date(),
      completedAt: nettingCorrection ? before.completedAt : isComplete(status) ? new Date() : null,
      protectionState: nettingCorrection ? before.protectionState : protectionState,
      error, fillsNetted, exitCancelState,
    }});
  });
  for (const effect of afterCommit) await effect();
  return result;
}

/**
 * X7: the one snapshot a terminal order still accepts — a BUY whose fills were
 * booked gross (the trades lookup failed) now answered netted: the same
 * cumulative quote, a base figure no higher than the gross one.
 */
function isNettingCorrection(before: ManualOrder, snapshot: ManualOrderSnapshot): boolean {
  return isComplete(before.status) && before.side === "BUY" && !before.fillsNetted &&
    snapshot.netted !== false && before.filledQuoteQty > 0 &&
    Math.abs(snapshot.executedQuoteQuantity - before.filledQuoteQty) <= 1e-9 &&
    snapshot.executedBaseQuantity <= before.filledBaseQty + QTY_EPSILON;
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
 *
 * OD-1: when the cancel-first policy is engaged for the entry (`engaged`), a
 * NEW such position is a `race_fill_sweep` position, which the protection
 * poller sells. An existing open one keeps its state: one already handed to
 * the operator (`SWEEP FAILED`) is not taken back.
 */
async function recordLateEntryFill(tx: LedgerTx, entry: ManualOrder, closed: SmartTrade,
  deltaBase: number, deltaQuote: number, snapshot: ManualOrderSnapshot, cumulativeBase: number,
  stillWorking: boolean, engaged: boolean): Promise<{ positionId: string; message: string }> {
  const prefix = `${entry.clientOrderId}:late:`;
  const open = await tx.smartTrade.findFirst({ where: { clientOrderId: { startsWith: prefix },
    status: "active" }, orderBy: { createdAt: "desc" } });
  let positionId: string;
  let sweep: boolean;
  if (open) {
    await tx.smartTrade.update({ where: { id: open.id }, data: {
      quantity: open.quantity + deltaBase, quoteSpent: open.quoteSpent + deltaQuote } });
    positionId = open.id;
    sweep = open.protectionState === RACE_FILL_SWEEP;
  } else {
    const earlier = await tx.smartTrade.count({ where: { clientOrderId: { startsWith: prefix } } });
    const price = snapshot.averagePrice ?? (deltaBase > 0 ? deltaQuote / deltaBase : null);
    const created = await tx.smartTrade.create({ data: {
      source: "manual", exchangeAccountId: entry.exchangeAccountId,
      botName: engaged ? "Manual (race fill)" : "Manual (late fill)",
      pair: entry.symbol, direction: "long", status: "active", entryPrice: price,
      currentPrice: price, buyPrice: price, quantity: deltaBase, quoteSpent: deltaQuote,
      exchangeOrderId: snapshot.exchangeOrderId || entry.exchangeOrderId,
      clientOrderId: `${prefix}${earlier + 1}`, manualTpPrice: null, manualSlPrice: null,
      protectionType: null, protectionState: engaged ? RACE_FILL_SWEEP : LATE_FILL_UNPROTECTED,
    } });
    positionId = created.id;
    sweep = engaged;
  }
  const base = baseAssetOf(entry.symbol);
  if (sweep) {
    return { positionId, message: `RACE FILL: ${fmtQty(deltaBase)} ${base} of this BUY filled ` +
      `after its position ${closed.id} was closed${closed.closedReason ? ` (${closed.closedReason})` : ""} ` +
      `(cumulative fill now ${fmtQty(cumulativeBase)} ${base}). It was not added to the closed ` +
      `position: it is tracked as race-fill position ${positionId}, which has no TP/SL and which ` +
      "the Bot sells automatically (sweep)." + (stillWorking
      ? " The order is still working: the Bot keeps cancelling it, and further fills can land until a cancel is confirmed."
      : "") };
  }
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

/**
 * X7: a downward (netting) correction of fills already booked to the open
 * late / race-fill position of `entry` reduces that position, floored at 0.
 * Nothing else is touched: if the correction belongs partly to fills the
 * closed trade already sold, the position is reduced by more than its share,
 * which only ever sells less.
 */
async function reduceLatePosition(tx: LedgerTx, entry: ManualOrder, amount: number):
  Promise<{ id: string; from: number; to: number } | null> {
  const open = await tx.smartTrade.findFirst({ where: {
    clientOrderId: { startsWith: `${entry.clientOrderId}:late:` }, status: "active" },
  orderBy: { createdAt: "desc" } });
  if (!open) return null;
  const to = Math.max(0, open.quantity - amount);
  await tx.smartTrade.update({ where: { id: open.id }, data: { quantity: to } });
  return { id: open.id, from: open.quantity, to };
}

/**
 * D1/I5 + OD-1: the trade closed while its entry is still working at the
 * exchange (replaces `flagEntryStillWorking`). The policy engages: the entry
 * owes a cancel (`exitCancelState: pending`, unless an earlier cancel already
 * left it `unknown` or `failed`), and the exit's origin is recorded for the
 * sweep's halt rule. With an adapter, one cancel attempt runs right after the
 * commit; the reconciler's finalizer owns every later one.
 */
async function markEntryForExitCancel(tx: LedgerTx, tradeId: string, entryId: string,
  origin: ExitOrigin, afterCommit: AfterCommit[], adapter?: ManualExchangeAdapter): Promise<void> {
  const entry = await tx.manualOrder.findUnique({ where: { id: entryId } });
  if (!entry || entry.side !== "BUY" || !PENDING_STATUSES.includes(entry.status)) return;
  const kept = durableFlag(entry.error);
  const note = kept && !isWorkingNote(kept) ? kept
    : entryCancelPendingMessage(tradeId, entry.filledBaseQty, entry.symbol);
  const state = entry.exitCancelState ?? "pending";
  await tx.manualOrder.update({ where: { id: entry.id }, data: {
    protectionState: ENTRY_WORKING_AFTER_EXIT, exitCancelState: state,
    exitOrigin: entry.exitOrigin ?? origin,
    exitCancelRequestedAt: entry.exitCancelRequestedAt ?? new Date(), error: note } });
  afterCommit.push(async () => {
    console.error(`[manual] ${note}`);
    if (adapter && (state === "pending" || state === "unknown")) {
      try {
        await finalizeEntryAfterExit(entry.id, adapter);
      } catch (error) {
        console.error(`[manual] inline cancel of entry ${entry.id} after its exit failed; ` +
          "the reconciler retries it", error);
      }
    }
  });
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
  price: number | null, noteOrderId?: string,
  /** OD-1: who closed it, and the adapter for the entry's inline cancel attempt. */
  opts: { adapter?: ManualExchangeAdapter; origin?: ExitOrigin } = {}): Promise<boolean> {
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
  if (noteOrderId) {
    // F7: the dust note never erases a durable flag already on the exit.
    const noted = await prisma.manualOrder.findUnique({ where: { id: noteOrderId }, select: { error: true } });
    await prisma.manualOrder.update({ where: { id: noteOrderId }, data: {
      error: withDurableFlag(note, noted?.error ?? null) } });
  }
  console.error(`[manual] ${note}`);
  if (position.manualOrderId) {
    // OD-1: a dust close is a close; a still-working entry owes a cancel too.
    const effects: AfterCommit[] = [];
    await markEntryForExitCancel(prisma, position.id, position.manualOrderId,
      opts.origin ?? "automation", effects, opts.adapter);
    for (const effect of effects) await effect();
  }
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
 * OD-1: what one cancel of a working entry achieved.
 *
 *   canceled          the exchange confirmed the cancel (its cumulative fill applied)
 *   already_terminal  -2011, and the lookup found it had already ended (FILLED)
 *   not_found         -2011, and the lookup found no such order: nothing to cancel
 *   not_canceled      a definite rejection of the cancel request, or the order
 *                     is still working after it; retry later
 *   unknown           the cancel's outcome is unknown (-1006/-1007, 5xx,
 *                     transport): it may or may not have been applied
 *   refused_dry_run   A1: DRY_RUN cannot cancel an order placed on the exchange
 *   skipped           nothing done (not working, claimed elsewhere, given up)
 */
export type ExitCancelOutcome = "canceled" | "already_terminal" | "not_found" | "not_canceled" |
  "unknown" | "refused_dry_run" | "skipped";

/** True when the adapter can only SIMULATE (the A1 guard's question). */
function simulatesCancels(adapter: ManualExchangeAdapter): boolean {
  return (adapter as { dryRun?: boolean }).dryRun ?? config.dryRun;
}

const LIVE_ENTRY_IN_DRY_RUN = "DRY_RUN is on and this entry was placed on the exchange, so the Bot " +
  "cannot cancel it (a simulated cancel would leave a live order untracked)";

function entryCancelFailedMessage(entry: ManualOrder, detail: string): string {
  return `ENTRY CANCEL FAILED: ${detail}. This LIMIT BUY (${entry.clientOrderId}) may still be ` +
    "working at the exchange, and any further fill is NOT protected by TP/SL: cancel it on " +
    "Binance manually. The Bot does not retry it.";
}

/**
 * The exchange's answer to a system cancel (OD-1, OD-3). A1: a simulated entry
 * is cancelled locally, keeping its recorded fills (the dry-run adapter cannot
 * know them); a live order is never cancelled by simulation — every caller
 * refuses it first, and so does this guard.
 */
async function cancelForPolicy(order: ManualOrder, adapter: ManualExchangeAdapter): Promise<ManualOrderSnapshot> {
  if (!simulatesCancels(adapter)) return adapter.cancel(order.symbol, order.clientOrderId);
  if (isRealExchangeOrderId(order.exchangeOrderId)) {
    throw new ManualTradingError(LIVE_ENTRY_IN_DRY_RUN, 409, "live_order_in_dry_run");
  }
  return { exchangeOrderId: order.exchangeOrderId ?? `dry-${order.clientOrderId}`,
    clientOrderId: order.clientOrderId, status: "CANCELED",
    executedBaseQuantity: order.filledBaseQty, executedQuoteQuantity: order.filledQuoteQty,
    averagePrice: order.averageFillPrice, simulated: true };
}

/** OD-3: what `cancelWorkingEntries` did to one working manual LIMIT BUY. */
export interface WorkingEntryCancel {
  orderId: string;
  symbol: string;
  outcome: "canceled" | "already_terminal" | "unknown" | "failed";
}

/**
 * OD-3 `cancelWorkingEntries` (explicit operator opt-in on pause): cancel each
 * manual LIMIT BUY still working at the exchange — `open` or
 * `partially_filled` — with the OD-1 cancel classification, and report each
 * outcome. Never blind and never retried here: `unknown` means the cancel may
 * or may not have been applied, the order stays tracked by the reconciler,
 * and the operator sees it. A system action that only reduces exposure (no
 * mainnet confirmation); the A1 dry-run guard still applies. Whatever filled
 * before the cancel stays booked (I2); nothing is sold.
 */
export async function cancelWorkingEntryLimits(adapterFactory: AdapterFactory = defaultAdapter):
  Promise<WorkingEntryCancel[]> {
  const orders = await prisma.manualOrder.findMany({ where: { side: "BUY", orderType: "LIMIT",
    status: { in: ["open", "partially_filled"] } }, include: { exchangeAccount: true },
  orderBy: { createdAt: "asc" }, take: 100 });
  const results: WorkingEntryCancel[] = [];
  for (const order of orders) {
    let outcome: WorkingEntryCancel["outcome"];
    try {
      const adapter = adapterFactory(order.exchangeAccount);
      if (simulatesCancels(adapter) && isRealExchangeOrderId(order.exchangeOrderId)) {
        outcome = "failed"; // A1: still working; never "cancelled" by simulation
      } else {
        const applied = await applyManualSnapshot(order.id, await cancelForPolicy(order, adapter), { adapter });
        outcome = !isComplete(applied.status) ? "unknown"
          : applied.status === "canceled" ? "canceled" : "already_terminal";
      }
    } catch (error) {
      outcome = error instanceof ManualOrderNotFoundError ? "failed"
        : classifyCancelFailure(error).outcome === "not_canceled" ? "failed" : "unknown";
      await prisma.manualOrder.update({ where: { id: order.id }, data: { exitCancelLastError:
        `pause cancel ${outcome}: ${error instanceof Error ? error.message : String(error)}` } });
    }
    if (outcome !== "canceled" && outcome !== "already_terminal") {
      console.error(`[manual] entries pause: LIMIT BUY ${order.clientOrderId} (${order.symbol}) was ` +
        `NOT confirmed cancelled (${outcome}); it may still be working at the exchange.`);
    }
    results.push({ orderId: order.id, symbol: order.symbol, outcome });
  }
  return results;
}

/**
 * One cancel of a working entry, issued by whichever OD-1 path claimed the
 * attempt (`attemptNo`). Never blind: a -2011 is resolved by a lookup in the
 * adapter, a definite rejection leaves the cancel owed (`pending`), anything
 * else is `unknown` and is queried before any later decision. The cancel's own
 * cumulative fill is applied through `applyManualSnapshot` (I2), so a fill in
 * the race lands in whichever ledger is current. At the maximum attempts the
 * policy gives up loudly: `failed`, a durable flag and an ALERT.
 */
async function performExitCancel(entry: ManualOrder, adapter: ManualExchangeAdapter,
  attemptNo: number): Promise<ExitCancelOutcome> {
  let outcome: "not_canceled" | "unknown";
  let lastError: string;
  try {
    const snapshot = await cancelForPolicy(entry, adapter);
    const applied = await applyManualSnapshot(entry.id, snapshot, { adapter });
    if (isComplete(applied.status)) return applied.status === "canceled" ? "canceled" : "already_terminal";
    outcome = "not_canceled";
    lastError = `the exchange still reports the order ${snapshot.status} after the cancel`;
  } catch (error) {
    if (error instanceof ManualOrderNotFoundError) {
      const flag = entryCancelFailedMessage(entry, error.message);
      await prisma.manualOrder.updateMany({ where: { id: entry.id, status: { in: PENDING_STATUSES } },
        data: { exitCancelState: "failed", exitCancelLastError: error.message, error: flag } });
      console.error(`[manual] ${flag}`);
      return "not_found";
    }
    const failure = classifyCancelFailure(error);
    outcome = failure.outcome === "not_canceled" ? "not_canceled" : "unknown";
    lastError = failure.message;
  }
  const giveUp = attemptNo >= EXIT_CANCEL_MAX_ATTEMPTS;
  const flag = giveUp ? entryCancelFailedMessage(entry,
    `${attemptNo} cancels could not be confirmed (last: ${lastError})`) : null;
  await prisma.manualOrder.updateMany({ where: { id: entry.id, status: { in: PENDING_STATUSES } },
    data: { exitCancelState: giveUp ? "failed" : outcome === "unknown" ? "unknown" : "pending",
      exitCancelLastError: lastError, ...(flag ? { error: flag } : {}) } });
  if (flag) {
    console.error(`[manual] ALERT: ${flag}`);
  } else if (attemptNo === EXIT_CANCEL_ALERT_AT) {
    console.error(`[manual] ALERT: ${attemptNo} cancels of LIMIT BUY ${entry.clientOrderId} ` +
      `(${entry.symbol}) are unconfirmed (last: ${lastError}). It may still be working and fill ` +
      "unprotected until a cancel is confirmed; the Bot retries up to " +
      `${EXIT_CANCEL_MAX_ATTEMPTS} times. Consider cancelling it on Binance.`);
  }
  return outcome;
}

/**
 * OD-1 pre-exit cancel (trace §1.2 item 1): the sibling of `refreshWorkingEntry`
 * that CANCELS a still-working entry before an exit is sized, instead of only
 * reading it. A fill that lands during the race is in the cancel's cumulative
 * answer, is added to the still-active position (I2) and is sold by the same
 * exit — option C, "sold as part of the same exit".
 *
 * A system action that only reduces exposure: no mainnet confirmation, never
 * refused by halt or pause. The A1 dry-run guard still applies: a live order
 * under DRY_RUN is never "simulated" away. Whatever the cancel's outcome, the
 * exit is never blocked: a cancel that did not settle the entry falls back to
 * the I8 refresh by query, so the exit is still sized from current fills.
 *
 * `raceDelta` is what the cancel (or the fallback refresh) added to the
 * position over the quantity passed in.
 */
export async function cancelWorkingEntryForExit(position: SmartTrade, adapter: ManualExchangeAdapter,
  origin: ExitOrigin): Promise<{ position: SmartTrade | null; entryWorking: boolean;
    outcome: ExitCancelOutcome; raceDelta: number; flag?: string }> {
  const untouched = { position, entryWorking: false, outcome: "skipped" as const, raceDelta: 0 };
  if (!position.manualOrderId) return untouched;
  const entry = await prisma.manualOrder.findUnique({ where: { id: position.manualOrderId } });
  if (!entry || !["open", "partially_filled"].includes(entry.status)) return untouched;

  let outcome: ExitCancelOutcome;
  let flag: string | undefined;
  if (simulatesCancels(adapter) && isRealExchangeOrderId(entry.exchangeOrderId)) {
    // A1: owed, not faked. The reconciler cancels it once DRY_RUN is off.
    await prisma.manualOrder.update({ where: { id: entry.id }, data: {
      exitCancelState: entry.exitCancelState === "failed" ? "failed" : "pending",
      exitOrigin: entry.exitOrigin ?? origin, exitCancelRequestedAt: new Date(),
      exitCancelLastError: LIVE_ENTRY_IN_DRY_RUN } });
    outcome = "refused_dry_run";
    flag = `ENTRY CANCEL PENDING: ${LIVE_ENTRY_IN_DRY_RUN}. It may still fill: cancel it on the ` +
      `exchange, or switch DRY_RUN off. This exit was sized from the last known quantity ` +
      `${fmtQty(position.quantity)}.`;
    console.error(`[manual] ${flag}`);
  } else if (entry.exitCancelState === "failed" || entry.exitCancelAttempts >= EXIT_CANCEL_MAX_ATTEMPTS) {
    outcome = "skipped"; // given up loudly earlier; refresh only
  } else {
    // Compare-and-set on the attempt counter: one owner per cancel attempt.
    const claimed = await prisma.manualOrder.updateMany({ where: { id: entry.id,
      exitCancelAttempts: entry.exitCancelAttempts, status: { in: ["open", "partially_filled"] } },
    data: { exitCancelAttempts: { increment: 1 }, exitCancelState: "pending",
      exitOrigin: entry.exitOrigin ?? origin, exitCancelRequestedAt: new Date() } });
    outcome = claimed.count === 1
      ? await performExitCancel(entry, adapter, entry.exitCancelAttempts + 1) : "skipped";
  }
  if (outcome !== "canceled" && outcome !== "already_terminal" && outcome !== "refused_dry_run") {
    const refresh = await refreshWorkingEntry(position, adapter);
    flag = refresh.flag;
  }
  const fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
  const raceDelta = fresh?.status === "active" ? Math.max(0, fresh.quantity - position.quantity) : 0;
  if (raceDelta > QTY_EPSILON && (outcome === "canceled" || outcome === "already_terminal")) {
    const note = `RACE FILL: ${fmtQty(raceDelta)} ${baseAssetOf(entry.symbol)} more of this BUY had ` +
      `filled by the time the Bot cancelled it before the exit of position ${position.id}; it was ` +
      "added to that position and is included in its exit.";
    await prisma.manualOrder.updateMany({ where: { id: entry.id, error: null }, data: { error: note } });
  }
  return { position: fresh, entryWorking: true, outcome, raceDelta, flag };
}

/**
 * OD-1 finalizer (trace §1.2 item 6): an entry still owed a cancel after its
 * trade closed. Query first (unless the caller just applied a fresh
 * snapshot): a terminal answer ends it, and any post-close fill becomes the
 * race-fill position through `applyManualSnapshot`. Only a still-working
 * entry is cancelled again, under a compare-and-set on the attempt counter, so
 * two finalizers (boot and interval) issue at most one cancel per attempt. A
 * failed lookup changes nothing.
 */
export async function finalizeEntryAfterExit(entryId: string, adapter: ManualExchangeAdapter,
  opts: { snapshotApplied?: boolean } = {}): Promise<ExitCancelOutcome | "lookup_failed"> {
  // One finalizer per entry at a time in this process. The attempt CAS alone
  // stops two finalizers claiming the SAME attempt, but a second finalizer that
  // reads the entry after the first one's claim and before its cancel is applied
  // would claim the NEXT attempt and cancel again (CI flake of OD-1 case 13).
  // That second cancel moves no money (-2011, then a query), but it spends an
  // attempt and can raise ENTRY CANCEL FAILED early. Boot and interval
  // reconcilers share this process, so an in-process guard is sufficient.
  if (finalizingEntries.has(entryId)) return "skipped";
  finalizingEntries.add(entryId);
  try {
    return await finalizeEntryAfterExitOnce(entryId, adapter, opts);
  } finally {
    finalizingEntries.delete(entryId);
  }
}

const finalizingEntries = new Set<string>();

async function finalizeEntryAfterExitOnce(entryId: string, adapter: ManualExchangeAdapter,
  opts: { snapshotApplied?: boolean }): Promise<ExitCancelOutcome | "lookup_failed"> {
  const entry = await prisma.manualOrder.findUnique({ where: { id: entryId } });
  if (!entry || entry.side !== "BUY" || !["pending", "unknown"].includes(entry.exitCancelState ?? "")) {
    return "skipped";
  }
  const trade = await prisma.smartTrade.findUnique({ where: { manualOrderId: entry.id } });
  // While the trade is active, the exit path that pre-cancels owns the entry.
  if (!trade || trade.status === "active") return "skipped";
  if (isComplete(entry.status)) {
    await prisma.manualOrder.updateMany({ where: { id: entry.id, exitCancelState: { in: ["pending", "unknown"] } },
      data: { exitCancelState: "done" } });
    return "already_terminal";
  }
  if (simulatesCancels(adapter) && isRealExchangeOrderId(entry.exchangeOrderId)) {
    await prisma.manualOrder.update({ where: { id: entry.id }, data: { exitCancelLastError: LIVE_ENTRY_IN_DRY_RUN } });
    return "refused_dry_run";
  }
  let current = entry;
  if (!opts.snapshotApplied) {
    let snapshot: ManualOrderSnapshot | null;
    try {
      snapshot = await adapter.query(entry.symbol, entry.clientOrderId);
    } catch (error) {
      await prisma.manualOrder.update({ where: { id: entry.id }, data: {
        exitCancelLastError: `lookup before cancel failed: ${error instanceof Error ? error.message : error}` } });
      return "lookup_failed";
    }
    if (snapshot) current = await applyManualSnapshot(entry.id, snapshot, { adapter });
    if (isComplete(current.status)) return "already_terminal";
  }
  if (current.exitCancelAttempts >= EXIT_CANCEL_MAX_ATTEMPTS) return "skipped";
  const claimed = await prisma.manualOrder.updateMany({ where: { id: current.id,
    exitCancelAttempts: current.exitCancelAttempts, exitCancelState: { in: ["pending", "unknown"] },
    status: { in: PENDING_STATUSES } },
  data: { exitCancelAttempts: { increment: 1 }, exitCancelRequestedAt: new Date() } });
  if (claimed.count !== 1) return "skipped";
  return performExitCancel(current, adapter, current.exitCancelAttempts + 1);
}

/** OD-1: the entry a late / race-fill position belongs to (`<entry client id>:late:<n>`). */
export async function entryOfRaceFillPosition(position: Pick<SmartTrade, "clientOrderId">):
  Promise<ManualOrder | null> {
  const cid = position.clientOrderId;
  const at = cid ? cid.lastIndexOf(":late:") : -1;
  if (!cid || at <= 0) return null;
  return prisma.manualOrder.findUnique({ where: { clientOrderId: cid.slice(0, at) } });
}

/**
 * OD-1 operator hand-off: a race-fill position the sweep could not sell within
 * its bounded attempts stops being swept. It becomes an ordinary unprotected
 * late-fill position, the entry carries a durable `SWEEP FAILED` flag naming
 * the quantity to sell, and an ALERT is logged once.
 */
export async function handOffRaceFillSweep(position: SmartTrade, entry: ManualOrder | null,
  attempts: number): Promise<boolean> {
  const moved = await prisma.smartTrade.updateMany({ where: { id: position.id, status: "active",
    protectionState: RACE_FILL_SWEEP }, data: { protectionState: LATE_FILL_UNPROTECTED } });
  if (moved.count !== 1) return false;
  const base = baseAssetOf(position.pair);
  const flag = `SWEEP FAILED: the Bot could not sell race-fill position ${position.id} ` +
    `(${fmtQty(position.quantity)} ${base}) after ${attempts} attempts. It is no longer sold ` +
    `automatically and has no TP/SL: sell ${fmtQty(position.quantity)} ${base} from the Trade panel ` +
    "(a manual SELL of that position).";
  if (entry) {
    // F7: read the entry's current flag (a RACE FILL or NETTING UNCONFIRMED
    // recorded since the caller's read) and keep it after this one.
    const current = await prisma.manualOrder.findUnique({ where: { id: entry.id }, select: { error: true } });
    await prisma.manualOrder.update({ where: { id: entry.id }, data: {
      error: withDurableFlag(flag, current?.error ?? null) } });
  }
  console.error(`[manual] ALERT: ${flag}`);
  return true;
}

/** F1: what resolving the other uncertain exits of one manual position found. */
export interface ManualExitResolution {
  /** True while any of them is still live or unknowable: no new exit may be sized. */
  blocked: boolean;
  /** Resolved to a terminal exchange state and applied; any fill was booked once. */
  reconciled: number;
  /** Proved never placed (ABSENT after the settle window) and closed off. */
  discarded: number;
  reason?: string;
}

/**
 * F1 (review 2026-11-09): before ANY exit of a manual position is sized — the
 * operator's SELL, or a TP/SL exit or sweep of the poller — every OTHER SELL of
 * that position still `submitted` (sent, outcome unknown: -1006/-1007, 5xx,
 * transport) is resolved first, query-first by its client order id. The
 * manual mirror of `resolveUnresolvedStrategySells`, with the D2 rules the
 * reconciler already applies:
 *
 *   found, terminal  applied through `applyManualSnapshot` (its fill closes or
 *                    reduces the position exactly once, never as a late fill),
 *                    its attempt settled and its exit reason stamped;
 *   found, working   still live at the exchange: blocked;
 *   not found        within `SUBMITTED_ABSENCE_SETTLE_MS` of submission:
 *                    blocked (a lookup can miss a just-accepted order); after
 *                    it, closed off ABSENT — none was placed;
 *   lookup failed    no evidence: blocked.
 *
 * Never a blind second SELL. X4's lock covers one owner's cycle only, so before
 * this a TP exit left `submitted` and an operator's full SELL (or the reverse)
 * both sold, the second out of the owner's untracked coins. A `requested` row
 * has not crossed the wire and is not resolved here. `skip` excludes the
 * caller's own order slot, which its own path already queries first.
 */
export async function resolveUnresolvedManualExits(positionId: string, adapter: ManualExchangeAdapter,
  opts: { now?: number; skip?: (order: ManualOrder) => boolean } = {}): Promise<ManualExitResolution> {
  const now = opts.now ?? Date.now();
  const rows = await prisma.manualOrder.findMany({ where: { linkedPositionId: positionId, side: "SELL",
    status: "submitted" }, orderBy: { createdAt: "asc" } });
  const outcome: ManualExitResolution = { blocked: false, reconciled: 0, discarded: 0 };
  const reasons: string[] = [];
  for (const row of rows) {
    if (opts.skip?.(row)) continue;
    const label = `a prior SELL of this position (${row.clientOrderId})`;
    if (simulatesCancels(adapter)) {
      // A1: a dry-run adapter answers every lookup "not found" without asking
      // the exchange; that is no evidence, and never a reason to close off a
      // SELL that crossed the wire while DRY_RUN was off.
      reasons.push(`${label} was sent to the exchange and cannot be looked up while DRY_RUN is on`);
      continue;
    }
    let found: ManualOrderSnapshot | null;
    try {
      found = await adapter.query(row.symbol, row.clientOrderId);
    } catch (error) {
      reasons.push(`${label} could not be looked up at the exchange (${
        error instanceof Error ? error.message : "lookup failed"})`);
      continue;
    }
    if (found) {
      const applied = await applyManualSnapshot(row.id, found, { adapter });
      if (PENDING_STATUSES.includes(applied.status)) {
        reasons.push(`${label} is still ${applied.status} at the exchange; it must settle before another exit`);
        continue;
      }
      const attempt = await prisma.exchangeOrderAttempt.findUnique({ where: { clientOrderId: row.clientOrderId } });
      if (attempt) {
        // The poller's exit: free its slot and stamp its own exit reason, as
        // `runManualExit` would have. An operator SELL has no attempt and
        // keeps `manual_sell`.
        await prisma.$transaction((tx) => settleOrderAttempt(tx, attempt.id, applied.exchangeOrderId ?? undefined));
        if (attempt.closedReason) {
          await prisma.smartTrade.updateMany({ where: { id: positionId, status: "closed",
            closedReason: "manual_sell" }, data: { closedReason: attempt.closedReason } });
        }
      }
      // F3: a resolved haircut exit closes what it deliberately left.
      await closeHaircutRemainder(applied, adapter,
        { closedReason: attempt?.closedReason, origin: manualOrderOrigin(row) });
      outcome.reconciled += 1;
      continue;
    }
    const submittedAt = (row.submittedAt ?? row.createdAt).getTime();
    if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) {
      reasons.push(`${label} was submitted moments ago and the exchange has no record of it yet; ` +
        "retry once it settles");
      continue;
    }
    const closed = await prisma.manualOrder.updateMany({ where: { id: row.id, status: "submitted" }, data: {
      status: "rejected", completedAt: new Date(),
      error: `ABSENT: the exchange has no order under client order id ${row.clientOrderId} ` +
        `${SUBMITTED_ABSENCE_SETTLE_MS / 1000} s after submission, so none was placed (resolved before ` +
        "another exit of this position)." } });
    if (closed.count !== 1) {
      reasons.push(`${label} changed state while it was being resolved; retry`);
      continue;
    }
    const attempt = await prisma.exchangeOrderAttempt.findUnique({ where: { clientOrderId: row.clientOrderId } });
    if (attempt) await abandonOrderAttempt(attempt.id, "ABSENT");
    outcome.discarded += 1;
  }
  if (reasons.length > 0) {
    outcome.blocked = true;
    outcome.reason = reasons.join("; ");
  }
  return outcome;
}

/**
 * Re-review F3 nit: a full exit whose haircut floors to 0 at the lot (a gross
 * position under one lot step plus its fee) is refused plainly, not as a 422
 * "manual position not found". Nothing is placed and nothing untracked is
 * sold; the netting re-query runs again on the next attempt.
 */
function assertHaircutSellable(netting: NettingHaircut | null, position: SmartTrade): void {
  const sizeCap = netting?.sizeCap;
  if (sizeCap == null || sizeCap > 0) return;
  throw new ManualTradingError(`The entry fills of this position are booked gross (their commission could ` +
    `not be confirmed), and its ${fmtQty(position.quantity)} ${baseAssetOf(position.pair)} less the ` +
    `${UNNETTED_EXIT_HAIRCUT * 100}% maximum fee floors to 0 at the exchange lot step. Nothing was placed, so ` +
    "no untracked coin is sold; retry once the entry's fills are confirmed.", 409, "haircut_below_lot");
}

/** F1: the operator-facing refusal while another exit of the position is unresolved. */
function exitUnresolvedError(reason: string | undefined): ManualTradingError {
  return new ManualTradingError("Another exit of this position may already be live at the exchange and " +
    `is not resolved yet${reason ? ` (${reason})` : ""}. Nothing was placed: read the position again and ` +
    "retry once it is resolved.", 409, "exit_unresolved");
}

/** F3: the most a full exit may sell while its position's entry fills are booked gross. */
export interface NettingHaircut {
  /** The position re-read after the one re-query (null if it is gone). */
  position: SmartTrade | null;
  /** The haircut quantity, floored to the lot; null when the fills are netted (no haircut). */
  sizeCap: number | null;
  /** The durable `NETTING UNCONFIRMED` note for the exit order, with the haircut. */
  flag: string | null;
}

/**
 * F3 (review 2026-11-09, X7 on the active trade): a FULL exit — TP, SL, or the
 * operator's full SELL — of a position whose entry fills are booked GROSS
 * (`fillsNetted: false`: the trades lookup failed) would sell the gross
 * figure, i.e. the base-asset commission too, out of the owner's untracked
 * coins. The entry is re-queried ONCE; a netted answer corrects the position
 * and no haircut applies. Still gross, the exit sells the
 * `UNNETTED_EXIT_HAIRCUT` less, floored to the lot, with a note. It never
 * waits: a stop-loss is never delayed for a fee lookup.
 */
export async function haircutForUnnettedEntry(position: SmartTrade, adapter: ManualExchangeAdapter):
  Promise<NettingHaircut> {
  const none: NettingHaircut = { position, sizeCap: null, flag: null };
  if (!position.manualOrderId) return none;
  const entry = await prisma.manualOrder.findUnique({ where: { id: position.manualOrderId } });
  if (!entry || entry.side !== "BUY" || entry.fillsNetted) return none;
  try {
    const snapshot = await adapter.query(entry.symbol, entry.clientOrderId);
    if (snapshot) await applyManualSnapshot(entry.id, snapshot, { adapter });
  } catch (error) {
    console.error(`[manual] ${position.id}: the netting re-query of entry ${entry.clientOrderId} failed: ` +
      `${error instanceof Error ? error.message : error}`);
  }
  const [fresh, reread] = await Promise.all([
    prisma.smartTrade.findUnique({ where: { id: position.id } }),
    prisma.manualOrder.findUnique({ where: { id: entry.id }, select: { fillsNetted: true } }),
  ]);
  if (!fresh || fresh.status !== "active" || reread?.fillsNetted !== false) {
    return { position: fresh, sizeCap: null, flag: null };
  }
  let stepSize = 0;
  try {
    stepSize = adapter.lotRules ? (await adapter.lotRules(fresh.pair)).stepSize : 0;
  } catch {
    // The exchange floors the order to its lot anyway; the haircut must not wait.
  }
  const sizeCap = floorToStep(fresh.quantity * (1 - UNNETTED_EXIT_HAIRCUT), stepSize);
  const base = baseAssetOf(fresh.pair);
  const flag = `NETTING UNCONFIRMED: the base-asset commission of the entry fills of position ${fresh.id} ` +
    `could not be confirmed (its trades lookup failed again), so this exit sells ${fmtQty(sizeCap)} ${base}: ` +
    `${UNNETTED_EXIT_HAIRCUT * 100}% less than the gross ${fmtQty(fresh.quantity)} (the maximum spot fee), ` +
    "floored to the lot, rather than risk selling untracked coins. What it leaves is the presumed " +
    "commission and closes with the position.";
  console.error(`[manual] ${flag}`);
  return { position: fresh, sizeCap, flag };
}

/**
 * F3: after a haircut exit FILLED, what it deliberately left — the presumed
 * commission of gross entry fills — closes with the position, under the
 * exit's own reason, so it is never sold later out of the owner's untracked
 * coins. Only when the exit sold exactly the haircut of the position as it
 * stood: a smaller sale (I3 capped it, or the position grew meanwhile) leaves
 * a real remainder, which stays tracked.
 */
export async function closeHaircutRemainder(exit: ManualOrder, adapter: ManualExchangeAdapter,
  opts: { closedReason?: string | null; origin: ExitOrigin }): Promise<boolean> {
  if (exit.side !== "SELL" || exit.status !== "filled" || !exit.linkedPositionId || !(exit.filledBaseQty > 0)) {
    return false;
  }
  const position = await prisma.smartTrade.findUnique({ where: { id: exit.linkedPositionId } });
  if (!position || position.status !== "active" || !position.manualOrderId || !(position.quantity > 0)) {
    return false;
  }
  const entry = await prisma.manualOrder.findUnique({ where: { id: position.manualOrderId },
    select: { fillsNetted: true } });
  if (!entry || entry.fillsNetted) return false;
  let stepSize = 0;
  try {
    stepSize = adapter.lotRules ? (await adapter.lotRules(position.pair)).stepSize : 0;
  } catch {
    return false; // no rules, no proof the remainder is the haircut: it stays tracked
  }
  const before = position.quantity + exit.filledBaseQty;
  const haircut = floorToStep(before * (1 - UNNETTED_EXIT_HAIRCUT), stepSize);
  if (Math.abs(exit.filledBaseQty - haircut) > Math.max(QTY_EPSILON, haircut * 1e-9)) return false;
  // The whole trade's P&L: this exit's proceeds against everything it cost.
  const realised = calcRealizedPnl(exit.filledQuoteQty, position.quoteSpent * before / position.quantity);
  const closed = await prisma.smartTrade.updateMany({ where: { id: position.id, status: "active" }, data: {
    status: "closed", closedAt: new Date(), closedReason: opts.closedReason ?? "manual_sell",
    protectionState: "removed", currentPrice: exit.averageFillPrice ?? undefined,
    pnlUsdt: realised.pnlUsdt, pnlPct: realised.pnlPct } });
  if (closed.count !== 1) return false;
  console.error(`[manual] position ${position.id} closed after its haircut exit ${exit.clientOrderId}: the ` +
    `remaining ${fmtQty(position.quantity)} ${baseAssetOf(position.pair)} is the presumed commission of its ` +
    "gross entry fills and stays in the wallet, untracked.");
  // OD-1: a close is a close; an entry still working owes a cancel.
  const effects: AfterCommit[] = [];
  await markEntryForExitCancel(prisma, position.id, position.manualOrderId, opts.origin, effects, adapter);
  for (const effect of effects) await effect();
  return true;
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
    // OD-3: a paused entry is a typed refusal the Platform can tell apart.
    if (decision.code === "entries_paused") {
      throw new ManualTradingError(`New entries are paused on the Bot (${decision.reason}). ` +
        "Closing an open position is still allowed.", 409, "entries_paused");
    }
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
    if (input.positionFull && !((input.baseQuantity ?? 0) > 0)) {
      throw new ManualTradingError("manual position not found for this account and symbol", 422);
    }
    // OD-7: never sell more than the selected position — a typed refusal, so
    // the Platform can show it (and offer the whole position) instead of a 422.
    if ((input.baseQuantity ?? 0) > position.quantity * 1.000000001) {
      throw new ManualTradingError(`sell quantity exceeds the selected manual position (remaining ` +
        `${fmtQty(position.quantity)}); sell the whole position instead`, 409, "sell_exceeds_position");
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
  raw: SubmitManualOrderInput, adapterFactory: AdapterFactory = (account) => manualAdapterSeam.factory(account)
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
  if (input.positionFull !== undefined && (input.positionFull !== true || input.side !== "SELL" ||
      !input.positionId || input.baseQuantity !== undefined || input.quoteQuantity !== undefined)) {
    throw new ManualTradingError(
      "positionFull must be true, on a SELL with a positionId and no quantity", 422, "invalid_position_full");
  }
  if (input.side === "SELL" && !input.positionFull && (!input.baseQuantity || input.baseQuantity <= 0))
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
   * X4: a FULL manual SELL of a tracked position takes the per-trade close lock
   * the protection poller holds, so an operator close and a TP/SL exit can no
   * longer run on one position at the same time. Released however this ends.
   */
  const lock: { positionId: string | null } = { positionId: null };
  try {
    return await submitManualOrderLocked(input, account, adapter, shariahContext, lock);
  } finally {
    if (lock.positionId) releaseTradeClose(lock.positionId);
  }
}

async function submitManualOrderLocked(input: SubmitManualOrderInput, account: ExchangeAccount,
  adapter: ManualExchangeAdapter, shariahContext: string | null, lock: { positionId: string | null }):
  Promise<ManualOrder> {
  /*
   * D1/I8 for an OPERATOR exit: a manual SELL of a position whose entry is
   * still working first refreshes that entry, so the ledger is current before
   * any exit, and a request beyond the (refreshed) position is refused by
   * `assertSellAssociation` before anything is cancelled.
   *
   * OD-1 (owner-approved option C): a FULL exit — the operator asks for the
   * whole refreshed position — then cancels the working entry first, and the
   * fill of the race (`raceDelta`) is sold by this same order, flagged
   * `RACE FILL`: the order is raised by the race delta only, capped by I3. A
   * PARTIAL exit never cancels and is never raised (F1): it sells at most what
   * was asked, the entry keeps working, and its later fills add to the still
   * active, still protected position.
   *
   * Review F1 (2026-11-09): before any of that, every OTHER SELL of the
   * position still `submitted` (a TP/SL exit or an earlier SELL whose outcome
   * is unknown) is resolved query-first. Still unresolved, this SELL — full or
   * partial — is refused 409 `exit_unresolved` with nothing placed; resolved
   * to a fill that closed the position, 409 `already_closed`.
   *
   * Review F3: a full exit of a position whose entry fills are booked gross
   * sells the 0.1 % haircut, and what it leaves closes with the position.
   */
  let refreshFlag: string | null = null;
  let exitNote: string | null = null;
  let fullExitPositionId: string | null = null;
  if (input.side === "SELL" && input.positionId) {
    const targetWhere = { id: input.positionId, source: "manual", exchangeAccountId: account.id,
      pair: input.symbol, status: "active" };
    let target = await prisma.smartTrade.findFirst({ where: targetWhere });
    if (target) {
      // A replay of this very request is the P2002 path's to answer, not a prior exit.
      const prior = await resolveUnresolvedManualExits(target.id, adapter,
        { skip: (order) => order.requestId === input.requestId });
      if (prior.blocked) throw exitUnresolvedError(prior.reason);
      if (prior.reconciled + prior.discarded > 0) {
        target = await prisma.smartTrade.findFirst({ where: targetWhere });
        if (!target) {
          throw new ManualTradingError("A prior exit of this position was resolved at the exchange and has " +
            "closed it. No second order was placed.", 409, "already_closed");
        }
      }
    }
    if (target) {
      let current: SmartTrade | null = target;
      let entryWorking = false;
      let refreshFailed = false;
      if (target.manualOrderId) {
        const refresh = await refreshWorkingEntry(target, adapter);
        refreshFlag = refresh.flag ?? null;
        refreshFailed = refresh.flag != null;
        current = refresh.position;
        entryWorking = refresh.entryWorking;
      }
      // OD-7: `positionFull` asks for exactly the refreshed remaining quantity.
      const requested = input.positionFull ? (current?.quantity ?? 0) : (input.baseQuantity ?? 0);
      if (current?.status === "active" && requested <= current.quantity * 1.000000001) {
        const full = input.positionFull === true || requested >= current.quantity * (1 - 1e-9);
        if (full) {
          if (!acquireTradeClose(target.id)) {
            throw new ManualTradingError("this position is being closed by another exit right now; " +
              "read the position again before selling", 409, "trade_closing");
          }
          lock.positionId = target.id;
          // F1, under the lock: an exit the poller placed between the
          // resolution above and this lock is refused, never doubled.
          if (await prisma.manualOrder.count({ where: { linkedPositionId: target.id, side: "SELL",
            status: "submitted", requestId: { not: input.requestId } } }) > 0) {
            throw exitUnresolvedError("an exit of it was submitted a moment ago");
          }
        }
        if (entryWorking) {
          let raceDelta = 0;
          let netting: NettingHaircut | null = null;
          if (full) {
            const cancel = await cancelWorkingEntryForExit(current, adapter, "operator");
            refreshFlag = cancel.flag ?? refreshFlag;
            raceDelta = cancel.raceDelta;
            current = cancel.position;
            if (current?.status === "active") {
              netting = await haircutForUnnettedEntry(current, adapter);
              current = netting.position;
            }
            if (current?.status !== "active") {
              throw new ManualTradingError("the position closed while its entry was being cancelled; " +
                "read the position again before selling", 409, "trade_closing");
            }
            assertHaircutSellable(netting, current);
          }
          const free = adapter.baseFree ? await adapter.baseFree(input.symbol) : Number.POSITIVE_INFINITY;
          const { capacity } = await manualExitCapacity(current, account.id, free);
          if (!(capacity > 0)) {
            throw new ManualTradingError("the free balance attributable to this position is 0; " +
              "reconcile the account balance before selling", 409);
          }
          const haircut = netting?.sizeCap ?? null;
          input.baseQuantity = Math.min(requested + raceDelta, capacity, haircut ?? Number.POSITIVE_INFINITY);
          fullExitPositionId = input.baseQuantity >= current.quantity * (1 - 1e-9) ||
            (haircut != null && input.baseQuantity >= haircut - QTY_EPSILON) ? target.id : null;
          const base = baseAssetOf(input.symbol);
          if (!full) {
            exitNote = "ENTRY STILL WORKING (partial exit): the entry of this position is still working " +
              `at the exchange and was not cancelled. Its further fills add to position ${target.id}, ` +
              "which stays active with its TP/SL.";
          } else if (raceDelta > QTY_EPSILON) {
            // F4: after a FAILED refresh the cancel's reply also carries fills
            // from before the cancel that the Bot had not booked yet.
            exitNote = refreshFailed
              ? `RACE FILL: ${fmtQty(raceDelta)} ${base} of the entry filled before and during the cancel ` +
                "(the refresh before this exit had failed, so the Bot had not booked them); this SELL was " +
                `raised by that amount only (${fmtQty(requested)} asked, ${fmtQty(input.baseQuantity)} sold).`
              : `RACE FILL: ${fmtQty(raceDelta)} ${base} of the entry filled while the Bot ` +
                `cancelled it for this full exit; this SELL was raised by that amount only ` +
                `(${fmtQty(requested)} asked, ${fmtQty(input.baseQuantity)} sold).`;
          }
          if (netting?.flag) exitNote = [exitNote, netting.flag].filter((note) => note).join(" ");
        } else if (full) {
          // F3: the entry is terminal; its fills may still be booked gross.
          const netting = await haircutForUnnettedEntry(current, adapter);
          current = netting.position;
          if (current?.status !== "active") {
            throw new ManualTradingError("the position changed while its entry was being re-read; " +
              "read the position again before selling", 409, "trade_closing");
          }
          assertHaircutSellable(netting, current);
          if (input.positionFull) {
            // OD-7 with no working entry: everything that remains, capped by I3.
            const free = adapter.baseFree ? await adapter.baseFree(input.symbol) : Number.POSITIVE_INFINITY;
            const { capacity } = await manualExitCapacity(current, account.id, free);
            if (!(capacity > 0)) {
              throw new ManualTradingError("the free balance attributable to this position is 0; " +
                "reconcile the account balance before selling", 409);
            }
            input.baseQuantity = Math.min(current.quantity, capacity, netting.sizeCap ?? Number.POSITIVE_INFINITY);
            fullExitPositionId = target.id;
          } else if (netting.sizeCap != null) {
            // A numeric full SELL: only the haircut changes what was asked.
            input.baseQuantity = Math.min(requested, netting.sizeCap);
            fullExitPositionId = target.id;
          }
          exitNote = netting.flag;
        }
      }
    }
  }
  // A `positionFull` whose position is not active here is refused just below
  // (`manual position not found`); it never reaches the exchange unsized.
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
        error: [exitNote, refreshFlag].filter((note) => note).join(" ") || null,
        executionEnvironment: manualExecutionEnvironment(account, adapter),
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
    /*
     * Re-review: a compare-and-set on `requested`, as the reconciler and the
     * poller claim. A reconcile tick between the reservation above and here
     * may already own this row and its one wire call; then nothing is sent
     * again under the same client order id, and the row is answered as it is.
     */
    const claimed = await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" },
      data: { status: "submitted", submittedAt: new Date() } });
    if (claimed.count !== 1) return prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
    applied = await applyManualSnapshot(order.id, await adapter.submit(intentFromOrder(order)), { adapter });
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
  if (fullExitPositionId) {
    try {
      // F3: what a haircut exit deliberately left closes with the position.
      if (await closeHaircutRemainder(applied, adapter, { origin: "operator" })) {
        return prisma.manualOrder.findUniqueOrThrow({ where: { id: applied.id } });
      }
      // D1/I7: a full exit that leaves only an unsellable remainder closes it.
      if (adapter.lotRules && await closeManualDust(fullExitPositionId, await adapter.lotRules(input.symbol),
        applied.averageFillPrice, applied.id, { adapter, origin: "operator" })) {
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
  order: ManualOrder, readLimits: () => Promise<Pick<BotRiskLimits, "tradingHalted" | "haltedReason"> &
    Partial<Pick<BotRiskLimits, "entriesPaused" | "entriesPausedReason">>> = getBotRiskLimits
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
    // R1: the close lock a first submission of a SELL takes, held until its snapshot is applied.
    const claim: ManualReconcileClaim = { now, lock: { positionId: null } };
    try {
      const adapter = adapterFactory(order.exchangeAccount);
      const step = await reconcileManualOrderStep(order, adapter, defaultFirstSubmitGate, claim);
      manualLookupFailures.delete(order.id);
      if (step.kind === "snapshot") {
        const applied = await applyManualSnapshot(order.id, step.snapshot, { adapter });
        await finalizeOnReconcile(applied, adapter);
        await closeReconciledHaircutRemainder(order, applied, adapter, claim.lock);
      } else if (step.kind === "absent") await closeOffAbsentManualOrder(order, now);
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
    } finally {
      if (claim.lock.positionId) releaseTradeClose(claim.lock.positionId);
    }
  }
}

/**
 * Re-review F3 (2026-11-09): a haircut exit whose outcome was uncertain and is
 * booked here closes what it deliberately left (the presumed commission of
 * gross entry fills), exactly as `resolveUnresolvedManualExits` does when the
 * other exit owner books it. Otherwise a later exit of that remainder takes a
 * second haircut out of the owner's untracked coins. Under the position's
 * close lock; held by another exit right now, the remainder stays tracked.
 */
async function closeReconciledHaircutRemainder(order: ManualOrder, applied: ManualOrder,
  adapter: ManualExchangeAdapter, lock: { positionId: string | null }): Promise<void> {
  const positionId = applied.linkedPositionId;
  if (applied.side !== "SELL" || applied.status !== "filled" || !positionId) return;
  const own = lock.positionId === positionId;
  if (!own && !acquireTradeClose(positionId)) return;
  try {
    const attempt = await prisma.exchangeOrderAttempt.findUnique({ where: { clientOrderId: applied.clientOrderId } });
    // The origin from the row as it was: a snapshot overwrites `protectionState`.
    await closeHaircutRemainder(applied, adapter,
      { closedReason: attempt?.closedReason, origin: manualOrderOrigin(order) });
  } finally {
    if (!own) releaseTradeClose(positionId);
  }
}

/**
 * OD-1 (trace §1.2 item 6): after the reconciler applied a fresh snapshot of a
 * BUY entry whose trade is closed and which still works, the cancel owed by
 * the policy is attempted — the snapshot just applied IS the query-first read.
 * Cancels run under halt and pause alike.
 *
 * Review F2 (2026-11-09): only for an entry the policy already marked
 * (`exitCancelState` non-null). Every path that closes a manual trade marks
 * it (`markEntryForExitCancel`), so what is left unmarked is a LEGACY entry
 * whose trade closed before this version. It keeps its
 * `entry_working_after_exit` flag and is NOT cancelled at boot: changing a
 * resting order needs an operator action (the cancel route, or C9
 * `cancelWorkingEntries`). Its later fills stay `late_fill_unprotected`.
 */
async function finalizeOnReconcile(entry: ManualOrder, adapter: ManualExchangeAdapter): Promise<void> {
  if (entry.side !== "BUY" || !PENDING_STATUSES.includes(entry.status) ||
      (entry.exitCancelState !== "pending" && entry.exitCancelState !== "unknown")) return;
  // `finalizeEntryAfterExit` leaves an entry of a still-active trade to the exit path.
  await finalizeEntryAfterExit(entry.id, adapter, { snapshotApplied: true });
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
    const step = await reconcileManualOrderStep(order, adapter, assertMayFirstSubmit, null);
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

/** The reconciler loop's claiming form of a step: its clock, and the close lock a SELL may take (R1). */
interface ManualReconcileClaim {
  now: number;
  /** Set when the step took a position's close lock; the loop releases it after applying the snapshot. */
  lock: { positionId: string | null };
}

/**
 * Re-review R1 (2026-11-09): a `requested` SELL of a tracked position has not
 * crossed the wire, but its stored quantity is no evidence any more. Another
 * exit may have closed or reduced the position since it was reserved: the
 * TP/SL poller (F1 does not see `requested` rows), or the operator under a new
 * request id. Sent as stored, it is a second wire SELL out of untracked coins.
 * So before the first submission:
 *   - position no longer active: compare-and-set `requested` -> `rejected`
 *     (NEVER SENT) and abandon its exit attempt, if any. The poller re-arms
 *     its own slot and the operator can re-issue, so no exit is lost;
 *   - otherwise, under the position's close lock (held elsewhere: not this
 *     cycle), every other `submitted` SELL of it is resolved query-first
 *     (still unresolved: not this cycle), and the quantity is capped at what
 *     the position holds now (the F3 haircut when that is all of a gross
 *     position) and at what I3 attributes to it.
 * Returns what to send, or null when nothing may be sent this cycle.
 */
async function sizeRequestedManualExit(order: ManualOrder & { linkedPositionId: string },
  adapter: ManualExchangeAdapter, claim: ManualReconcileClaim):
  Promise<{ quantity: number; note: string | null } | null> {
  const positionId = order.linkedPositionId;
  const neverSent = async (why: string): Promise<null> => {
    const rejected = await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" }, data: {
      status: "rejected", completedAt: new Date(),
      error: withDurableFlag(`NEVER SENT: ${why}, so this SELL was not placed (it would have sold coins no ` +
        "position holds). Re-issue a SELL if one is still wanted.", order.error) } });
    if (rejected.count === 1) {
      const attempt = await prisma.exchangeOrderAttempt.findUnique({ where: { clientOrderId: order.clientOrderId } });
      if (attempt) await abandonOrderAttempt(attempt.id, "NEVER_SENT");
    }
    return null;
  };
  const closedBy = `position ${positionId} was closed by another exit before this SELL reached the exchange`;
  let position = await prisma.smartTrade.findUnique({ where: { id: positionId } });
  if (position?.status !== "active") return neverSent(closedBy);
  if (!acquireTradeClose(positionId)) return null;
  claim.lock.positionId = positionId;
  const prior = await resolveUnresolvedManualExits(positionId, adapter,
    { now: claim.now, skip: (row) => row.id === order.id });
  if (prior.blocked) {
    if (!durableFlag(order.error)) {
      await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" }, data: {
        error: `reconciliation pending: not sent while another exit of position ${positionId} is ` +
          `unresolved (${prior.reason})` } });
    }
    return null;
  }
  position = await prisma.smartTrade.findUnique({ where: { id: positionId } });
  if (position?.status !== "active") return neverSent(closedBy);
  const stored = order.requestedBaseQty ?? 0;
  let cap = position.quantity;
  let note: string | null = null;
  if (stored >= position.quantity * (1 - 1e-9)) {
    // All of what remains: F3 applies to a gross position as on every full exit.
    const netting = await haircutForUnnettedEntry(position, adapter);
    const fresh = netting.position;
    if (fresh?.status !== "active") return neverSent(closedBy);
    position = fresh;
    cap = netting.sizeCap ?? fresh.quantity;
    note = netting.flag;
  }
  const free = adapter.baseFree ? await adapter.baseFree(order.symbol) : Number.POSITIVE_INFINITY;
  const { capacity } = await manualExitCapacity(position, order.exchangeAccountId, free);
  const quantity = Math.min(stored, cap, capacity);
  if (!(quantity > 0)) {
    return neverSent(`nothing of position ${positionId} is attributable to it now (free balance ${free}, ` +
      `position ${fmtQty(position.quantity)})`);
  }
  if (quantity < stored - QTY_EPSILON) {
    console.error(`[manual-reconcile] ${order.clientOrderId}: the requested SELL of ${fmtQty(stored)} is sent ` +
      `capped at ${fmtQty(quantity)}: what position ${positionId} holds now and the free balance attributable ` +
      "to it (I3)");
  }
  return { quantity, note };
}

async function reconcileManualOrderStep(
  order: ManualOrder, adapter: ManualExchangeAdapter,
  assertMayFirstSubmit: (o: ManualOrder) => Promise<unknown>,
  /**
   * The loop's form: claim the row (requested -> submitted) before submitting,
   * size a SELL by its position first (R1), and record a failed submit. Null
   * is the pure form (no database), which only tests use.
   */
  claim: ManualReconcileClaim | null
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
  let intent = intentFromOrder(order);
  let sized: { quantity: number; note: string | null } | null = null;
  if (order.side === "SELL" && order.linkedPositionId) {
    sized = await sizeRequestedManualExit({ ...order, linkedPositionId: order.linkedPositionId }, adapter, claim);
    if (!sized) return { kind: "handled" };
    intent = { ...intent, baseQuantity: sized.quantity };
  }
  /*
   * D1/I6: compare-and-set `requested` -> `submitted` BEFORE the wire call, as
   * `submitManualOrder` and the strategy path do. Two overlapping reconcilers
   * (or the protection poller) can no longer both submit the same row, and a
   * row that crossed the wire can never again read `requested`. R1: it
   * records the quantity actually sent.
   */
  const claimed = await prisma.manualOrder.updateMany({ where: { id: order.id, status: "requested" },
    data: { status: "submitted", submittedAt: new Date(),
      ...(sized ? { requestedBaseQty: sized.quantity } : {}),
      ...(sized?.note ? { error: withDurableFlag(sized.note, order.error) } : {}) } });
  if (claimed.count !== 1) return { kind: "handled" };
  try {
    return { kind: "snapshot", snapshot: await adapter.submit(intent) };
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
  /*
   * OD-1: a race-fill position from an automated exit is held while halted
   * (the halt stops automated exits). Say so, so it is never read as handled.
   * Review F1: only those. One from an operator's own full SELL is still
   * swept while halted, and telling the operator to sell it by hand would
   * steer them into a second SELL of it.
   */
  let sweepsWaiting = 0;
  if (halt.halted) {
    const waiting = await prisma.smartTrade.findMany({ where: { source: "manual", status: "active",
      protectionState: RACE_FILL_SWEEP, ...(pair ? { pair } : {}) }, select: { clientOrderId: true } });
    for (const position of waiting) {
      // The poller's own rule (`planRaceFillSweep`): anything not operator-origin is held.
      if ((await entryOfRaceFillPosition(position))?.exitOrigin !== "operator") sweepsWaiting += 1;
    }
  }
  const sweepNote = sweepsWaiting > 0
    ? "race fill awaiting sweep — Bot halted; sell it from the Trade panel (a race fill from an " +
      "automated exit is not sold while the Bot is halted)." : undefined;
  return { enabled: config.manualTradingEnabled,
    mainnetEnabled: config.mainnetManualTradingEnabled, dryRun: config.dryRun,
    tradingHalted: halt.halted,
    mixed: accounts.some((a) => a.testnet) && accounts.some((a) => !a.testnet),
    accounts: accounts.map((a) => ({ ...a, mode: a.testnet ? "testnet" : "mainnet" })),
    orders, positions, protection: { type: "bot-managed", exchangeResting: false, polling,
      haltedBy: halt.haltedBy, mainnetPositionsChecked: config.mainnetManualTradingEnabled, note,
      ...(sweepNote ? { sweepNote } : {}) } };
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
