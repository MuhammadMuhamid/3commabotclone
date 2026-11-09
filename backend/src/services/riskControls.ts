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
  /**
   * OD-3: new entries are paused. Independent of `tradingHalted`: exits, the
   * TP/SL monitors, OD-1 cancels and sweeps, and reconciliation all continue.
   */
  entriesPaused: boolean;
  entriesPausedReason: string | null;
}

export const DEFAULT_BOT_RISK_LIMITS: BotRiskLimits = {
  tradingHalted: false,
  haltedReason: null,
  haltedBy: null,
  maxTotalExposureQuote: null,
  maxConcurrentTrades: null,
  maxDailyLossQuote: null,
  dailyLossWindowHours: 24,
  entriesPaused: false,
  entriesPausedReason: null,
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
  | "entries_paused"
  | "max_exposure"
  | "max_concurrent_trades"
  | "daily_loss_limit";

export type BotRiskDecision =
  | { allowed: true }
  | { allowed: false; code: BotRiskBlockCode; reason: string };

const block = (code: BotRiskBlockCode, reason: string): BotRiskDecision =>
  ({ allowed: false, code, reason });

/**
 * Who is asking for an order, as far as the halt is concerned.
 *
 * `operator` is a person managing what is open: the manual-trading routes and
 * the authenticated dashboard Close / scale-out. `automation` is everything the
 * bot does on its own or on a signal's say-so: TradingView webhooks, Platform
 * strategy emissions, the TP/SL monitors and the strategy-intent reconciler.
 *
 * It is a server-side fact, set by the CODE PATH a request arrived on — never
 * read from a request body. The default is `automation`, so a caller that does
 * not say who it is gets the stricter answer.
 */
export type BotOrderOrigin = "operator" | "automation";

/**
 * True only for an exit an operator asked for.
 *
 * Exact comparisons, deliberately: a side that is not literally `"sell"` —
 * missing, mis-cased, padded, anything a future caller fails to normalise — is
 * treated as an ENTRY, so it can never borrow the exit exemption.
 *
 * Every caller of this gate is Binance Spot (manual trading refuses any other
 * account in `assertManualAccountGate`; the webhook and strategy paths place
 * only spot MARKET orders). On spot a SELL can only dispose of an asset the
 * account already holds — the exchange refuses to sell what is not there, and
 * there is no margin on these paths — so a SELL here cannot open exposure. A
 * derivatives caller, where a SELL can open a short, must not reuse this gate
 * without passing reduce-only evidence of its own.
 */
export function isOperatorExit(order: { side: unknown; origin?: BotOrderOrigin }): boolean {
  return order.origin === "operator" && order.side === "sell";
}

/**
 * OD-3: the pause rule, once. Exact comparison, as for the halt: a side that
 * is not literally `"sell"` — missing, mis-cased, anything — is an ENTRY and is
 * refused while entries are paused, whoever asks (an operator's manual BUY
 * too). A SELL is never paused.
 */
export function entriesPausedDecision(
  limits: Partial<Pick<BotRiskLimits, "entriesPaused" | "entriesPausedReason">>,
  order: { side: unknown }
): BotRiskDecision | null {
  if (limits.entriesPaused === true && order.side !== "sell") {
    return block("entries_paused",
      limits.entriesPausedReason ? `entries paused: ${limits.entriesPausedReason}` : "entries paused");
  }
  return null;
}

/**
 * The halt half of the gate on its own, for a caller that must re-check ONLY
 * the halt — the manual reconciler re-proving an order it already admitted,
 * whose own pending exposure the snapshot would otherwise count twice.
 * `evaluateBotRisk` calls this first, so the rule exists exactly once.
 *
 * OD-3: the entries pause is part of this half (it gates WHETHER an entry may
 * be placed, not how big), checked after the halt, so while both are set the
 * halt is reported first. It reaches every gated path with no other edit: the
 * webhook preflight and entry guard, the manual BUY, and both reconcilers.
 */
export function evaluateBotHalt(
  limits: Pick<BotRiskLimits, "tradingHalted" | "haltedReason"> &
    Partial<Pick<BotRiskLimits, "entriesPaused" | "entriesPausedReason">>,
  order: { side: unknown; origin?: BotOrderOrigin }
): BotRiskDecision {
  if (limits.tradingHalted && !isOperatorExit(order)) {
    return block(
      "trading_halted",
      limits.haltedReason ? `trading is halted: ${limits.haltedReason}` : "trading is halted"
    );
  }
  return entriesPausedDecision(limits, order) ?? { allowed: true };
}

/**
 * The gate, called before any order is placed.
 *
 * Same three invariants as the platform's, for the same reasons:
 *
 *  * an EXIT is never refused by a numeric limit — refusing a sell because
 *    exposure is too high traps the position that caused the problem;
 *  * the halt stops the AUTOMATION in both directions ("touch nothing"), but
 *    never an operator's own exit. Halting is the moment an operator most
 *    needs to close by hand, and the halt latches itself on a daily-loss
 *    breach, so refusing that close would trap the very position that caused
 *    the loss (D-9). This is the platform's division exactly: its `evaluateRisk`
 *    halts every automated emission, and its manual routes refuse only BUY
 *    while halted (`assertNotHalted` in its `api/routes/manualTrading.ts`);
 *  * every limit is opt-in, so a fresh install behaves exactly as before.
 */
export function evaluateBotRisk(
  limits: BotRiskLimits,
  snapshot: BotRiskSnapshot,
  order: { side: "buy" | "sell"; quoteQty: number; origin?: BotOrderOrigin }
): BotRiskDecision {
  const halt = evaluateBotHalt(limits, order);
  if (!halt.allowed) return halt;

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
    entriesPaused: row.entriesPaused,
    entriesPausedReason: row.entriesPausedReason,
  };
}

// ── OD-3: pause new entries ─────────────────────────────────────────────────

/** The entries pause as stored. */
export interface EntriesPauseState {
  paused: boolean;
  pausedAt: Date | null;
  pausedBy: string | null;
  reason: string | null;
}

export async function readEntriesPause(): Promise<EntriesPauseState> {
  const row = await prisma.riskControl.findUnique({ where: { id: SINGLETON_ID } });
  return {
    paused: row?.entriesPaused ?? false,
    pausedAt: row?.entriesPausedAt ?? null,
    pausedBy: row?.entriesPausedBy ?? null,
    reason: row?.entriesPausedReason ?? null,
  };
}

/**
 * Set the entries pause to a TARGET state — the one implementation behind the
 * Platform's signed C9 and the dashboard's `/api/ops/entries`.
 *
 * Idempotent: pausing a paused Bot keeps the pause that is in force (its time,
 * actor and reason are what an operator needs to see) and reports
 * `changed: false`; resuming an un-paused Bot is likewise a no-op. Each write
 * is one conditional statement on the current value, so two racing requests
 * cannot both "change" it. Never touches the halt, and the halt never touches
 * it.
 */
export async function setEntriesPaused(target:
  | { paused: true; reason: string; by: string }
  | { paused: false; by: string }
): Promise<{ changed: boolean; state: EntriesPauseState }> {
  await prisma.riskControl.upsert({
    where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID }, update: {},
  });
  const written = target.paused
    ? await prisma.riskControl.updateMany({
      where: { id: SINGLETON_ID, entriesPaused: false },
      data: { entriesPaused: true, entriesPausedAt: new Date(), entriesPausedBy: target.by,
        entriesPausedReason: target.reason },
    })
    : await prisma.riskControl.updateMany({
      where: { id: SINGLETON_ID, entriesPaused: true },
      data: { entriesPaused: false, entriesPausedAt: null, entriesPausedBy: null,
        entriesPausedReason: null },
    });
  return { changed: written.count === 1, state: await readEntriesPause() };
}

/**
 * OD-3: the entries pause as C0, C9 and the dashboard report it, with what a
 * pause cannot stop by itself: manual LIMIT BUYs resting at the exchange, and
 * strategy BUYs whose exchange outcome is still unresolved.
 */
export async function readEntriesStatus(): Promise<{
  paused: boolean; pausedAt: string | null; pausedBy: string | null; reason: string | null;
  workingEntryLimits: number; unresolvedBuyIntents: number;
}> {
  const [pause, workingEntryLimits, unresolvedBuyIntents] = await Promise.all([
    readEntriesPause(),
    prisma.manualOrder.count({ where: { side: "BUY", orderType: "LIMIT",
      status: { in: ["open", "partially_filled"] } } }),
    prisma.strategyOrderIntent.count({ where: { side: "BUY", status: { in: ["requested", "submitted"] } } }),
  ]);
  return {
    paused: pause.paused,
    pausedAt: pause.pausedAt?.toISOString() ?? null,
    pausedBy: pause.pausedBy,
    reason: pause.reason,
    workingEntryLimits,
    unresolvedBuyIntents,
  };
}

/** True when the rolling realised loss meets the daily-loss limit right now (live, not the latch). */
export function dailyLossBreached(limits: BotRiskLimits, snapshot: BotRiskSnapshot): boolean {
  if (limits.maxDailyLossQuote === null) return false;
  return -Math.min(0, snapshot.realisedPnlInWindow) >= limits.maxDailyLossQuote;
}

/** The halt as stored, including when it began. */
export interface BotHaltState {
  halted: boolean;
  haltedBy: HaltSource | null;
  haltedReason: string | null;
  haltedAt: Date | null;
}

export async function readBotHaltState(): Promise<BotHaltState> {
  const row = await prisma.riskControl.findUnique({ where: { id: SINGLETON_ID } });
  return {
    halted: row?.tradingHalted ?? false,
    haltedBy: (row?.haltedBy as HaltSource | null | undefined) ?? null,
    haltedReason: row?.haltedReason ?? null,
    haltedAt: row?.haltedAt ?? null,
  };
}

/**
 * Halt trading, but NEVER replace a halt that is already in force.
 *
 * Finding 0.3: this used to overwrite `haltedBy` and the reason. Resume
 * re-checks the rolling loss only for a `daily_loss` halt, so halting an
 * installation that the daily-loss limit had already latched, then resuming,
 * skipped that re-check entirely. The first halt's source, reason and time are
 * what an operator needs to see, and what resume must judge.
 *
 * The write is one conditional statement (`tradingHalted = false` in the
 * WHERE), so two halts racing each other cannot both win.
 */
export async function haltBotTrading(
  opts: { reason?: string; by?: HaltSource } = {}
): Promise<{ alreadyHalted: boolean; state: BotHaltState }> {
  // The singleton may not exist yet; create it un-halted so the conditional
  // write below is the only statement that can set the halt.
  await prisma.riskControl.upsert({
    where: { id: SINGLETON_ID }, create: { id: SINGLETON_ID }, update: {},
  });
  const claimed = await prisma.riskControl.updateMany({
    where: { id: SINGLETON_ID, tradingHalted: false },
    data: {
      tradingHalted: true,
      haltedReason: opts.reason ?? null,
      haltedBy: opts.by ?? null,
      haltedAt: new Date(),
    },
  });
  return { alreadyHalted: claimed.count === 0, state: await readBotHaltState() };
}

export async function setBotTradingHalted(
  halted: boolean,
  opts: { reason?: string; by?: HaltSource } = {}
): Promise<void> {
  if (halted) {
    // Every halt writer — operator and automatic latch alike — keeps an
    // existing halt rather than replacing it (finding 0.3).
    await haltBotTrading(opts);
    return;
  }
  const data = { tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null };
  await prisma.riskControl.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });
}

export type ResumeOutcome =
  | {
    ok: true;
    /** False when nothing was halted; nothing was changed. */
    wasHalted: boolean;
    previousHaltedBy: HaltSource | null;
    previousReason: string | null;
  }
  | { ok: false; code: "still_breached" | "halt_changed"; message: string };

/**
 * Lift the halt — the one implementation behind the dashboard's
 * `/api/ops/resume` and the Platform's signed control resume.
 *
 * A latched daily-loss halt is re-checked against live numbers first:
 * resuming straight back into a breached limit would trip again on the next
 * entry. (Lowering or disabling `maxDailyLossQuote` makes it resumable; that
 * is the existing, deliberate policy.)
 *
 * The clear is a compare-and-set on the halt that was inspected, so a halt
 * that changed in between — a new latch, a new reason — is never lifted on the
 * strength of a check made against the old one.
 */
export async function resumeBotTrading(): Promise<ResumeOutcome> {
  const before = await readBotHaltState();
  if (!before.halted) {
    return { ok: true, wasHalted: false, previousHaltedBy: null, previousReason: null };
  }
  const limits = await getBotRiskLimits();
  if (before.haltedBy === "daily_loss" && limits.maxDailyLossQuote !== null) {
    const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
    const loss = -Math.min(0, snapshot.realisedPnlInWindow);
    if (loss >= limits.maxDailyLossQuote) {
      return {
        ok: false,
        code: "still_breached",
        message:
          `refusing to resume: the rolling ${limits.dailyLossWindowHours}h loss ` +
          `${loss.toFixed(2)} still meets the limit ${limits.maxDailyLossQuote.toFixed(2)}. ` +
          "Raise the limit deliberately, or wait for the window to roll.",
      };
    }
  }
  // Matched on the source and reason (plain strings, robust to how a restored
  // row encodes its timestamp). A halt cannot be replaced while it stands, so
  // these only change if the halt was lifted and a new one set in between.
  const cleared = await prisma.riskControl.updateMany({
    where: {
      id: SINGLETON_ID, tradingHalted: true,
      haltedBy: before.haltedBy, haltedReason: before.haltedReason,
    },
    data: { tradingHalted: false, haltedReason: null, haltedBy: null, haltedAt: null },
  });
  if (cleared.count !== 1) {
    return {
      ok: false,
      code: "halt_changed",
      message: "The halt changed while it was being lifted; read the status again before resuming.",
    };
  }
  return {
    ok: true, wasHalted: true,
    previousHaltedBy: before.haltedBy, previousReason: before.haltedReason,
  };
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
export interface BotRiskSnapshotOptions {
  /**
   * An unresolved strategy BUY being re-checked at its own first submission:
   * its reserved exposure is the order being judged, so it is not counted twice.
   */
  excludeStrategyIntentId?: string;
}

export async function readBotRiskSnapshotSince(
  since: Date, options: BotRiskSnapshotOptions = {}
): Promise<BotRiskSnapshot> {
  const [open, closed, partials, pendingManualBuys, unresolvedStrategyBuys] = await Promise.all([
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
    // D2: a strategy BUY whose exchange outcome is unresolved (reserved, or
    // attempted with an uncertain answer) may already be a position. It has no
    // SmartTrade until it reconciles — at which point it leaves this set — so
    // it is counted here once, as its requested quote.
    prisma.strategyOrderIntent.findMany({
      where: { side: "BUY", status: { in: ["requested", "submitted"] },
        ...(options.excludeStrategyIntentId ? { id: { not: options.excludeStrategyIntentId } } : {}) },
      select: { requestedQuoteQty: true },
    }),
  ]);
  const pendingExposure = sumMoney(pendingManualBuys.map((order) =>
    Math.max(0, (order.requestedQuoteQty ?? 0) - order.filledQuoteQty)));
  const unresolvedStrategyExposure = sumMoney(unresolvedStrategyBuys.map((intent) =>
    intent.requestedQuoteQty ?? 0));
  return {
    openExposureQuote: sumMoney([...open.map((t) => t.quoteSpent), pendingExposure,
      unresolvedStrategyExposure]),
    openTrades: open.length + pendingManualBuys.filter((order) => order.filledBaseQty <= 0).length +
      unresolvedStrategyBuys.length,
    realisedPnlInWindow: realisedPnlFromTradeEvents(closed, partials),
  };
}

export async function readBotRiskSnapshot(
  windowHours: number, options: BotRiskSnapshotOptions = {}
): Promise<BotRiskSnapshot> {
  return readBotRiskSnapshotSince(new Date(Date.now() - windowHours * 3_600_000), options);
}

/** One-line operator summary. */
export function describeBotRiskState(limits: BotRiskLimits, snapshot: BotRiskSnapshot): string {
  if (limits.tradingHalted) {
    return `HALTED${limits.haltedBy ? ` (${limits.haltedBy})` : ""}${
      limits.haltedReason ? `: ${limits.haltedReason}` : ""
    }${limits.entriesPaused ? "; new entries also paused" : ""}`;
  }
  const loss = -Math.min(0, snapshot.realisedPnlInWindow);
  return (
    (limits.entriesPaused
      ? `ENTRIES PAUSED${limits.entriesPausedReason ? `: ${limits.entriesPausedReason}` : ""} — `
      : "ACTIVE — ") +
    `exposure ${snapshot.openExposureQuote.toFixed(2)}` +
    (limits.maxTotalExposureQuote !== null ? `/${limits.maxTotalExposureQuote.toFixed(2)}` : "") +
    `, trades ${snapshot.openTrades}` +
    (limits.maxConcurrentTrades !== null ? `/${limits.maxConcurrentTrades}` : "") +
    `, ${limits.dailyLossWindowHours}h loss ${loss.toFixed(2)}` +
    (limits.maxDailyLossQuote !== null ? `/${limits.maxDailyLossQuote.toFixed(2)}` : "")
  );
}
