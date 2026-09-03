import { Prisma, type ExchangeAccount, type ManualOrder } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol } from "../lib/symbols.js";
import { clientOrderId, ExchangeError, MinNotionalError } from "./binance.js";
import {
  BinanceManualExchange, type ManualExchangeAdapter, type ManualOrderIntent,
  type ManualOrderSnapshot, ManualOrderValidationError,
} from "./manualExchange.js";
import {
  evaluateBotRisk, getBotRiskLimits, readBotRiskSnapshot,
  setBotTradingHalted, shouldLatchHalt,
} from "./riskControls.js";
import { calcRealizedPnl } from "./smartTrade.js";
import {
  admitSpotEntry, clearanceForFirstSubmission, noteSpotExit, readShariahContext,
  ShariahEnforcementError,
  shariahScopeForManualAccount,
} from "./shariah.js";

/** Every manual-order lifecycle status that is NOT terminal. */
export const PENDING_STATUSES = ["requested", "submitted", "open", "partially_filled"];
export const MAINNET_MANUAL_CONFIRMATION = "PLACE_MAINNET_ORDER";
const accountSubmitLocks = new Set<string>();

export class ManualTradingError extends Error {
  constructor(message: string, readonly httpStatus: number = 400) {
    super(message);
    this.name = "ManualTradingError";
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

/** Apply one authoritative exchange snapshot and update the canonical SmartTrade ledger. */
export async function applyManualSnapshot(orderId: string, snapshot: ManualOrderSnapshot): Promise<ManualOrder> {
  return prisma.$transaction(async (tx) => {
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
    const status = manualLifecycleStatus(snapshot.status);
    const protectionState = manualProtectionState(
      before.takeProfitPrice, before.stopLossPrice, snapshot.executedBaseQuantity);
    const updated = await tx.manualOrder.update({ where: { id: orderId }, data: {
      status, exchangeOrderId: snapshot.exchangeOrderId || before.exchangeOrderId,
      filledBaseQty: snapshot.executedBaseQuantity,
      filledQuoteQty: snapshot.executedQuoteQuantity,
      averageFillPrice: snapshot.averagePrice, submittedAt: before.submittedAt ?? new Date(),
      completedAt: isComplete(status) ? new Date() : null, protectionState, error: null,
    }});

    if (before.side === "BUY" && snapshot.executedBaseQuantity > 0) {
      const existing = await tx.smartTrade.findUnique({ where: { manualOrderId: before.id } });
      const data = { source: "manual", exchangeAccountId: before.exchangeAccountId,
        botName: "Manual", pair: before.symbol, direction: "long", status: "active",
        entryPrice: snapshot.averagePrice, currentPrice: snapshot.averagePrice,
        buyPrice: snapshot.averagePrice, quantity: snapshot.executedBaseQuantity,
        quoteSpent: snapshot.executedQuoteQuantity, exchangeOrderId: snapshot.exchangeOrderId,
        clientOrderId: before.clientOrderId, manualTpPrice: before.takeProfitPrice,
        manualSlPrice: before.stopLossPrice, protectionType: "bot-managed", protectionState };
      if (existing) await tx.smartTrade.update({ where: { id: existing.id }, data });
      else await tx.smartTrade.create({ data: { ...data, manualOrderId: before.id } });
    }

    if (before.side === "SELL" && before.linkedPositionId &&
        snapshot.executedBaseQuantity > before.filledBaseQty) {
      const position = await tx.smartTrade.findUnique({ where: { id: before.linkedPositionId } });
      if (position?.status === "active") {
        const delta = snapshot.executedBaseQuantity - before.filledBaseQty;
        const deltaQuote = Math.max(0, snapshot.executedQuoteQuantity - before.filledQuoteQty);
        const remaining = Math.max(0, position.quantity - delta);
        const ratio = position.quantity > 0 ? remaining / position.quantity : 0;
        const realised = calcRealizedPnl(deltaQuote, position.quoteSpent);
        await tx.smartTrade.update({ where: { id: position.id }, data:
          remaining <= position.quantity * 0.001
            ? { status: "closed", closedAt: new Date(), closedReason: "manual_sell",
                protectionState: "removed", currentPrice: snapshot.averagePrice,
                pnlUsdt: realised.pnlUsdt, pnlPct: realised.pnlPct }
            : { quantity: remaining, quoteSpent: position.quoteSpent * ratio } });
      }
    }
    return updated;
  });
}

async function enforceRisk(input: SubmitManualOrderInput, adapter: ManualExchangeAdapter): Promise<void> {
  let quoteQty = input.quoteQuantity ?? 0;
  if (quoteQty <= 0) quoteQty = (input.baseQuantity ?? 0) *
    (input.limitPrice ?? await adapter.ticker(input.symbol));
  const limits = await getBotRiskLimits();
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
  const decision = evaluateBotRisk(limits, snapshot, {
    side: input.side === "BUY" ? "buy" : "sell", quoteQty });
  if (!decision.allowed) {
    const latch = shouldLatchHalt(decision);
    if (latch) await setBotTradingHalted(true, { by: latch, reason: decision.reason });
    throw new ManualTradingError(decision.reason, 409);
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

  try {
    order = await prisma.manualOrder.update({ where: { id: order.id },
      data: { status: "submitted", submittedAt: new Date() } });
    return await applyManualSnapshot(order.id, await adapter.submit(intentFromOrder(order)));
  } catch (error) {
    // A Shariah refusal is raised before the exchange call, so no order exists
    // to reconcile: record it as the rejection it is rather than leaving the
    // row `submitted` and pending forever.
    const rejected = error instanceof MinNotionalError ||
      error instanceof ManualOrderValidationError ||
      error instanceof ShariahEnforcementError ||
      (error instanceof ExchangeError && error.code !== undefined);
    const failed = !rejected && config.dryRun;
    return prisma.manualOrder.update({ where: { id: order.id }, data: {
      status: rejected ? "rejected" : failed ? "failed" : "submitted",
      error: error instanceof Error ? error.message : "exchange result unknown; reconciliation pending",
      completedAt: rejected || failed ? new Date() : null }});
  }
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
  const snapshot = await adapterFactory(order.exchangeAccount).cancel(order.symbol, order.clientOrderId);
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

export async function reconcilePendingManualOrders(
  adapterFactory: AdapterFactory = defaultAdapter, limit = 100
): Promise<void> {
  if (!config.manualTradingEnabled || config.dryRun) return;
  const orders = await prisma.manualOrder.findMany({ where: { status: { in: PENDING_STATUSES } },
    include: { exchangeAccount: true }, orderBy: { createdAt: "asc" }, take: Math.min(limit, 100) });
  for (const order of orders) {
    try {
      const adapter = adapterFactory(order.exchangeAccount);
      const snapshot = await reconcileOneManualOrder(order, adapter);
      if (snapshot) await applyManualSnapshot(order.id, snapshot);
    } catch (error) {
      await prisma.manualOrder.update({ where: { id: order.id }, data: {
        error: `reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}` }});
    }
  }
}

const defaultFirstSubmitGate = async (order: ManualOrder): Promise<unknown> => {
  // BUY only, and the asymmetry is the point: an exit interrupted between its
  // reservation and the exchange must always be able to finish, whatever this
  // installation has since decided about the asset.
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
   * The first-submission Shariah check, injectable so a pure lifecycle test
   * needs no database. It defaults to the real one — a caller that wants no
   * gate has to ask for it in writing, in this file, where it is visible.
   */
  assertMayFirstSubmit: (o: ManualOrder) => Promise<unknown> = defaultFirstSubmitGate
): Promise<ManualOrderSnapshot | null> {
  const found = await adapter.query(order.symbol, order.clientOrderId);
  /*
   * `submitted` means an exchange request was already attempted. A lookup can
   * temporarily miss an accepted order (or the process can have died between
   * the durable state change and the request), so absence is not evidence that
   * placing a replacement is safe. Keep reconciling the stable client order id
   * instead. Only `requested` proves this process has not crossed the shared
   * submission boundary yet.
   */
  if (found) return found;
  if (order.status !== "requested") return null;
  /*
   * Same rule as the strategy path: this order has not crossed the submission
   * boundary, so placing it now is creating exposure now. An order admitted
   * while nothing was enforcing carries no decision, and an installation that
   * has since begun enforcing must not have that order land anyway.
   */
  await assertMayFirstSubmit(order);
  return adapter.submit(intentFromOrder(order));
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
      select: { id: true, exchangeAccountId: true, pair: true, status: true, entryPrice: true,
        currentPrice: true, quantity: true, quoteSpent: true, pnlUsdt: true, pnlPct: true,
        manualTpPrice: true, manualSlPrice: true, protectionType: true, protectionState: true,
        createdAt: true, closedAt: true, closedReason: true },
      orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return { enabled: config.manualTradingEnabled,
    mainnetEnabled: config.mainnetManualTradingEnabled, dryRun: config.dryRun,
    mixed: accounts.some((a) => a.testnet) && accounts.some((a) => !a.testnet),
    accounts: accounts.map((a) => ({ ...a, mode: a.testnet ? "testnet" : "mainnet" })),
    orders, positions, protection: { type: "bot-managed", exchangeResting: false,
      note: "Checked by the bot poller; no exchange-resting protective order is claimed." } };
}

/** Durable idempotency for submit, cancel, and protection-update commands. */
export async function runIdempotentManualCommand<T>(
  requestId: string, kind: string, action: () => Promise<T>
): Promise<T> {
  try {
    await prisma.manualCommand.create({ data: { requestId, kind } });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "P2002") throw error;
    const existing = await prisma.manualCommand.findUnique({ where: { requestId } });
    if (!existing) throw error;
    if (existing.kind !== kind) throw new ManualTradingError("request id was already used for another command", 409);
    if (existing.status === "succeeded" && existing.result) return JSON.parse(existing.result) as T;
    if (existing.status === "failed") throw new ManualTradingError(existing.error ?? "command previously failed", 409);
    if (Date.now() - existing.updatedAt.getTime() < 30_000)
      throw new ManualTradingError("the same command is already processing", 409);
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
