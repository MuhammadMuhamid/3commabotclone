/**
 * Account-level risk controls for the execution bot.
 *
 * `BOT-011` (merged into `BE-11`): the only controls were `assertCanOpenTrade`'s
 * per-bot `maxActiveSmartTrades` and `maxEntryOrders`, both defaulting to
 * disabled or null. There was no kill switch, no account-level exposure cap, no
 * concurrency cap across bots and no daily-loss limit — so thirteen bots on
 * correlated coins could all open on the same signal with nothing to stop them,
 * and no way to halt trading short of pausing each bot by hand.
 *
 * This is the RECEIVING half. The platform has its own gate before it emits
 * (`engine/riskControls.ts` there), and both are necessary: TradingView may
 * post exposure-reducing exits to the same endpoint directly, so the receiver
 * retains its own exit-safe gate too.
 *
 * The decision logic is pure and mirrors the platform's, deliberately: an
 * operator who halts one and not the other should get the same answer to "will
 * this order be placed" from either side.
 */
import { prisma } from "../lib/prisma.js";
import { sumMoney } from "../lib/money.js";

export type HaltSource = "operator" | "daily_loss" | "exposure" | "concurrency";

export interface BotRiskLimits {
  tradingHalted: boolean;
  haltedReason: string | null;
  haltedBy: HaltSource | null;
  /** Total quote currency allowed across every open position. Null disables. */
  maxTotalExposureQuote: number | null;
  /** Maximum simultaneously-open trades across ALL bots. Null disables. */
  maxConcurrentTrades: number | null;
  /** Rolling realised loss that trips the switch, as a positive number. Null disables. */
  maxDailyLossQuote: number | null;
  dailyLossWindowHours: number;
}

export const DEFAULT_BOT_RISK_LIMITS: BotRiskLimits = {
  tradingHalted: false,
  haltedReason: null,
  haltedBy: null,
  maxTotalExposureQuote: null,
  maxConcurrentTrades: null,
  maxDailyLossQuote: null,
  dailyLossWindowHours: 24,
};

export interface BotRiskSnapshot {
  /** Quote currency committed across every open trade. */
  openExposureQuote: number;
  openTrades: number;
  /** Signed realised P&L over the rolling window; negative is a loss. */
  realisedPnlInWindow: number;
}

export interface ClosedTradePnl {
  pnlUsdt: number;
  partialCloses: Array<{ pnlUsdt: number }>;
}

/**
 * Realised P&L is event-based. A closed trade's `pnlUsdt` already includes all
 * of its partial closes, possibly from earlier days, so its final-close event
 * is the total minus those partials. Partials inside the requested window are
 * then added at their own timestamps. This avoids both omission and double
 * counting around a UTC-day or rolling-window boundary.
 */
export function realisedPnlFromTradeEvents(
  closedInWindow: ClosedTradePnl[],
  partialsInWindow: Array<{ pnlUsdt: number }>
): number {
  const finalLegs = closedInWindow.map((trade) =>
    trade.pnlUsdt - sumMoney(trade.partialCloses.map((partial) => partial.pnlUsdt))
  );
  return sumMoney([...finalLegs, ...partialsInWindow.map((partial) => partial.pnlUsdt)]);
}

export type BotRiskBlockCode =
  | "trading_halted"
  | "max_exposure"
  | "max_concurrent_trades"
  | "daily_loss_limit";

export type BotRiskDecision =
  | { allowed: true }
  | { allowed: false; code: BotRiskBlockCode; reason: string };

const block = (code: BotRiskBlockCode, reason: string): BotRiskDecision =>
  ({ allowed: false, code, reason });

/**
 * The gate, called before any order is placed.
 *
 * Same two invariants as the platform's, for the same reasons:
 *
 *  * an EXIT is never refused by a numeric limit — refusing a sell because
 *    exposure is too high traps the position that caused the problem;
 *  * every limit is opt-in, so a fresh install behaves exactly as before.
 */
export function evaluateBotRisk(
  limits: BotRiskLimits,
  snapshot: BotRiskSnapshot,
  order: { side: "buy" | "sell"; quoteQty: number }
): BotRiskDecision {
  if (limits.tradingHalted) {
    return block(
      "trading_halted",
      limits.haltedReason ? `trading is halted: ${limits.haltedReason}` : "trading is halted"
    );
  }

  if (order.side === "sell") return { allowed: true };

  if (limits.maxDailyLossQuote !== null) {
    const loss = -Math.min(0, snapshot.realisedPnlInWindow);
    if (loss >= limits.maxDailyLossQuote) {
      return block(
        "daily_loss_limit",
        `rolling ${limits.dailyLossWindowHours}h realised loss ${loss.toFixed(2)} ` +
          `has reached the limit ${limits.maxDailyLossQuote.toFixed(2)}`
      );
    }
  }

  if (limits.maxConcurrentTrades !== null && snapshot.openTrades >= limits.maxConcurrentTrades) {
    return block(
      "max_concurrent_trades",
      `${snapshot.openTrades} trades are already open, limit is ${limits.maxConcurrentTrades}`
    );
  }

  if (limits.maxTotalExposureQuote !== null) {
    const after = snapshot.openExposureQuote + order.quoteQty;
    if (after > limits.maxTotalExposureQuote) {
      return block(
        "max_exposure",
        `this order would take exposure to ${after.toFixed(2)}, limit is ` +
          `${limits.maxTotalExposureQuote.toFixed(2)}`
      );
    }
  }

  return { allowed: true };
}

/** A daily-loss breach latches the switch; the other limits self-clear. */
export function shouldLatchHalt(decision: BotRiskDecision): HaltSource | null {
  if (decision.allowed) return null;
  return decision.code === "daily_loss_limit" ? "daily_loss" : null;
}

// ── Persistence ─────────────────────────────────────────────────────────────

const SINGLETON_ID = "global";

/** Read the limits, creating the singleton row on first use. */
export async function getBotRiskLimits(): Promise<BotRiskLimits> {
  const row = await prisma.riskControl.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return { ...DEFAULT_BOT_RISK_LIMITS };
  return {
    tradingHalted: row.tradingHalted,
    haltedReason: row.haltedReason,
    haltedBy: (row.haltedBy as HaltSource | null) ?? null,
    maxTotalExposureQuote: row.maxTotalExposureQuote,
    maxConcurrentTrades: row.maxConcurrentTrades,
    maxDailyLossQuote: row.maxDailyLossQuote,
    dailyLossWindowHours: row.dailyLossWindowHours,
  };
}

export async function setBotTradingHalted(
  halted: boolean,
  opts: { reason?: string; by?: HaltSource } = {}
): Promise<void> {
  const data = {
    tradingHalted: halted,
    haltedReason: halted ? (opts.reason ?? null) : null,
    haltedBy: halted ? (opts.by ?? null) : null,
    haltedAt: halted ? new Date() : null,
  };
  await prisma.riskControl.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
}

export async function updateBotRiskLimits(patch: {
  maxTotalExposureQuote?: number | null;
  maxConcurrentTrades?: number | null;
  maxDailyLossQuote?: number | null;
  dailyLossWindowHours?: number;
}): Promise<void> {
  await prisma.riskControl.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...patch },
    update: patch,
  });
}

/**
 * The current risk picture, read from the trades themselves.
 *
 * `quoteSpent` on an open trade is what was actually committed, so exposure
 * here is an observation rather than the platform's intent-based estimate.
 */
export async function readBotRiskSnapshotSince(since: Date): Promise<BotRiskSnapshot> {
  const [open, closed, partials, pendingManualBuys] = await Promise.all([
    prisma.smartTrade.findMany({
      where: { status: "active" },
      select: { quoteSpent: true },
    }),
    prisma.smartTrade.findMany({
      where: {
        status: "closed",
        closedAt: { gte: since },
      },
      select: {
        pnlUsdt: true,
        partialCloses: { select: { pnlUsdt: true } },
      },
    }),
    prisma.partialClose.findMany({
      where: { createdAt: { gte: since } },
      select: { pnlUsdt: true },
    }),
    // A resting manual BUY LIMIT has reserved risk even before it becomes a
    // SmartTrade. Count only its unfilled quote remainder, so a partial fill is
    // represented once here and once by the canonical open trade.
    prisma.manualOrder.findMany({
      where: { side: "BUY", status: { in: ["requested", "submitted", "open", "partially_filled"] } },
      select: { requestedQuoteQty: true, filledQuoteQty: true, filledBaseQty: true },
    }),
  ]);
  const pendingExposure = sumMoney(pendingManualBuys.map((order) =>
    Math.max(0, (order.requestedQuoteQty ?? 0) - order.filledQuoteQty)));
  return {
    openExposureQuote: sumMoney([...open.map((t) => t.quoteSpent), pendingExposure]),
    openTrades: open.length + pendingManualBuys.filter((order) => order.filledBaseQty <= 0).length,
    realisedPnlInWindow: realisedPnlFromTradeEvents(closed, partials),
  };
}

export async function readBotRiskSnapshot(windowHours: number): Promise<BotRiskSnapshot> {
  return readBotRiskSnapshotSince(new Date(Date.now() - windowHours * 3_600_000));
}

/** One-line operator summary. */
export function describeBotRiskState(limits: BotRiskLimits, snapshot: BotRiskSnapshot): string {
  if (limits.tradingHalted) {
    return `HALTED${limits.haltedBy ? ` (${limits.haltedBy})` : ""}${
      limits.haltedReason ? `: ${limits.haltedReason}` : ""
    }`;
  }
  const loss = -Math.min(0, snapshot.realisedPnlInWindow);
  return (
    "ACTIVE — " +
    `exposure ${snapshot.openExposureQuote.toFixed(2)}` +
    (limits.maxTotalExposureQuote !== null ? `/${limits.maxTotalExposureQuote.toFixed(2)}` : "") +
    `, trades ${snapshot.openTrades}` +
    (limits.maxConcurrentTrades !== null ? `/${limits.maxConcurrentTrades}` : "") +
    `, ${limits.dailyLossWindowHours}h loss ${loss.toFixed(2)}` +
    (limits.maxDailyLossQuote !== null ? `/${limits.maxDailyLossQuote.toFixed(2)}` : "")
  );
}
