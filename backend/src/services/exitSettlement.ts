import type { ExchangeOrderAttempt, PartialClose, SmartTrade } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { BinanceClient, OrderProbe } from "./binance.js";
import { probeOrderByClientId } from "./binance.js";
import { calcFinalClosePnl, calcRealizedPnl } from "./smartTrade.js";
import {
  abandonOrderAttempt, recordOrderAttemptObservation, settleOrderAttempt,
  type ExitAttemptOrigin,
} from "./orderAttempt.js";
import { SUBMITTED_ABSENCE_SETTLE_MS } from "./strategyOrderIntent.js";

/**
 * The one place a non-intent exit fill becomes local position state.
 *
 * BOT-P1-5 and BOT-P1-6 are two halves of the same defect. The TP/SL monitor
 * and the dashboard partial close each carried their own copy of the exit
 * accounting, and both copies took the REQUESTED quantity as though it were the
 * executed one — a partial or zero fill therefore reduced the position, booked
 * P&L and, on the partial-close path, wrote a `PartialClose` row for base asset
 * that was never sold. Worse, a crash between the exchange fill and that local
 * write left the attempt row as the only surviving evidence of a live exit, and
 * close admission could not see it.
 *
 * So the accounting lives here, once, and both the synchronous path and the
 * restart recovery below go through it. The invariant that buys:
 *
 *     the same exchange fill evidence produces the same final local state,
 *     whether it is discovered synchronously or by a recovery,
 *
 * and it is applied exactly once, because the compare-and-set that settles the
 * attempt happens inside the same transaction as the ledger write.
 */

/** Executed truth from the exchange. Never a requested quantity. */
export interface ExitFillEvidence {
  orderId: string;
  /** ACTUAL executed base quantity — the accounting authority. */
  executedQty: number;
  /** ACTUAL fill revenue in quote asset. */
  cummulativeQuoteQty: number;
  avgPrice: number;
}

export interface AppliedExit {
  /** What was actually applied to the ledger, after clamping to the position. */
  executedQty: number;
  /** What this attempt asked the exchange for. Intent only; kept distinguishable. */
  requestedQty: number | null;
  /** True when this fill removed the position. */
  closed: boolean;
  /** Written only when a partial-close attempt actually executed something. */
  partial: PartialClose | null;
  /** Realized P&L for THIS leg. */
  pnlUsdt: number;
  pnlPct: number;
  trade: SmartTrade;
}

/** Trades whose exits this module books. `manual-protection` is not one of them. */
const OWNED_ORIGINS: ExitAttemptOrigin[] = ["tpsl", "partial"];

/**
 * A close that leaves this much or less behind has covered the position.
 *
 * Both historical thresholds, kept as a union so neither path's behaviour
 * changes: the TP/SL monitor treated a fill within 0.1 % of the holding as a
 * full close (BOT-006), and the partial-close route treated a residue of 1e-6
 * or less as one. A partial close is capped at 99 %, so the 0.1 % arm can never
 * fire on that path — the union is exactly each path's own rule.
 */
function covers(executedQty: number, heldQty: number): boolean {
  if (!(heldQty > 0)) return false;
  return executedQty >= heldQty * 0.999 || heldQty - executedQty <= 0.000001;
}

/**
 * Apply one exit fill to the owning position, exactly once.
 *
 * Returns `null` when another resolver already settled this attempt — the
 * compare-and-set lost, so this caller applies nothing at all. That is what
 * makes a fill recovered by two paths book one position change and one P&L.
 *
 * Throws when the fill cannot be booked (the position vanished, or is no longer
 * active). The transaction rolls back, the attempt stays `open`, and the caller
 * reports the conflict rather than inventing an outcome — a real fill must
 * never be silently discarded.
 */
export async function applyExitFill(
  attempt: ExchangeOrderAttempt,
  fill: ExitFillEvidence
): Promise<AppliedExit | null> {
  return prisma.$transaction(async (tx) => {
    /*
     * The compare-and-set comes FIRST, in the same transaction as everything
     * below. A second recovery of this same fill loses it and returns null, so
     * the position is reduced once and the P&L booked once no matter how many
     * resolvers find the order.
     */
    if (!(await settleOrderAttempt(tx, attempt.id, fill.orderId || undefined))) return null;

    const tradeId = attempt.smartTradeId;
    if (!tradeId) throw new Error("Exit attempt has no owning position to settle against");
    const trade = await tx.smartTrade.findUnique({ where: { id: tradeId } });
    if (!trade) throw new Error("Exit attempt references a missing SmartTrade");
    if (trade.status !== "active") {
      throw new Error("Exit fill conflicts with a SmartTrade that is no longer active");
    }

    /*
     * BOT-P1-6: THE EXECUTED QUANTITY IS THE AUTHORITY.
     *
     * The requested quantity says only what was asked for. Clamping to the
     * holding keeps a fill that reports more base asset than the position
     * tracks from driving the quantity negative; it never invents quantity,
     * because the clamp can only ever reduce.
     */
    const executedQty = Math.max(0, Math.min(fill.executedQty, trade.quantity));

    if (!(executedQty > 0)) {
      /*
       * A zero fill sold nothing, so it changes nothing: no `PartialClose`, no
       * reduced position, no P&L, no close. The attempt is settled — this fill
       * is resolved and it moved no asset — which frees the slot for a later
       * legitimate exit of the exposure that is still there.
       */
      return {
        executedQty: 0, requestedQty: attempt.requestedBaseQty, closed: false,
        partial: null, pnlUsdt: 0, pnlPct: 0, trade,
      };
    }

    const proportionalCost = trade.quantity > 0
      ? trade.quoteSpent * (executedQty / trade.quantity)
      : 0;
    const { pnlUsdt, pnlPct } = calcRealizedPnl(fill.cummulativeQuoteQty, proportionalCost);
    const remaining = Math.max(0, trade.quantity - executedQty);
    const closed = covers(executedQty, trade.quantity);

    // Read before writing this leg's row, so a final close accumulates the
    // partials that came BEFORE it and never counts itself twice.
    const priorPartials = closed
      ? await tx.partialClose.findMany({ where: { tradeId: trade.id } })
      : [];
    const closePnl = closed
      ? calcFinalClosePnl(fill.cummulativeQuoteQty, trade.quoteSpent, priorPartials)
      : null;

    let partial: PartialClose | null = null;
    if (attempt.origin === "partial") {
      partial = await tx.partialClose.create({ data: {
        tradeId: trade.id,
        pct: attempt.sellPercent ?? 0,
        // Executed, not requested. This row is the durable record of how much
        // base asset actually left the wallet.
        quantity: executedQty,
        revenue: fill.cummulativeQuoteQty,
        pnlUsdt,
        avgPrice: fill.avgPrice,
        exchangeOrderId: fill.orderId,
      }});
    }

    const updated = await tx.smartTrade.update({
      where: { id: trade.id },
      data: {
        quantity: remaining,
        quoteSpent: Math.max(0, trade.quoteSpent - proportionalCost),
        currentPrice: fill.avgPrice,
        ...(closed && closePnl
          ? {
            status: "closed",
            closedAt: new Date(),
            closedReason: attempt.closedReason ?? "signal_exit",
            pnlUsdt: closePnl.pnlUsdt,
            pnlPct: closePnl.pnlPct,
          }
          : {}),
      },
    });

    /*
     * Recorded inside the same transaction so a recovery-discovered TP/SL close
     * marks the pair exactly as the synchronous path does — the stale-SELL guard
     * must not depend on which resolver got there first.
     */
    if (closed && attempt.origin === "tpsl" && trade.botId) {
      await tx.pairCloseMark.upsert({
        where: { botId_pair: { botId: trade.botId, pair: trade.pair } },
        create: { botId: trade.botId, pair: trade.pair, closedAt: new Date() },
        update: { closedAt: new Date() },
      });
    }

    return {
      executedQty,
      requestedQty: attempt.requestedBaseQty,
      closed,
      partial,
      pnlUsdt: closed && closePnl ? closePnl.pnlUsdt : pnlUsdt,
      pnlPct: closed && closePnl ? closePnl.pnlPct : pnlPct,
      trade: updated,
    };
  });
}

export interface ExitAttemptResolution {
  /** True when a durable exit attempt still holds unknown or live exchange state. */
  blocked: boolean;
  reason?: string;
  /** Attempts this call reconciled from an authoritative exchange fill. */
  reconciled: number;
  /** Attempts the exchange proved moved nothing, now released. */
  discarded: number;
}

export type ExitAttemptProbe = (attempt: ExchangeOrderAttempt) => Promise<OrderProbe>;

/**
 * The probe close admission uses, dry-run aware in the same idiom as
 * `strategyMarketAdapter`: a simulated run consulted no exchange, so it has no
 * evidence — and no evidence must never be read as evidence of absence.
 */
export function exitAttemptProbe(client: BinanceClient, dryRun: boolean): ExitAttemptProbe {
  return (attempt) => dryRun
    ? Promise.resolve<OrderProbe>({ state: "unknown", reason: "dry run: no exchange to consult" })
    : probeOrderByClientId(client, attempt.symbol, "SELL", attempt.clientOrderId);
}

/**
 * Resolve every unresolved durable SELL attempt on one position — BOT-P1-5.
 *
 * This is the close-admission half of the repair. TP, SL and partial-close
 * SELLs reserve an `ExchangeOrderAttempt` but no `StrategyOrderIntent`, and
 * close admission reasons about intents. After a crash between the exchange
 * submission and the local settlement the in-process close lock is gone, so a
 * webhook or dashboard close saw a clean position and could send a second SELL
 * on top of a first one that may already be live at Binance.
 *
 * It is the same query-first authority `resolveUnresolvedStrategySells` uses,
 * pointed at the attempt's exact durable client order id:
 *
 *   filled  → applied through the shared settlement authority above, exactly
 *             once. No second SELL for quantity that already executed.
 *   open    → still live, possibly partially filled. Nothing is applied, the
 *             remainder stays unresolved, and the close stays blocked — a
 *             replacement here is how a position gets sold twice.
 *   dead    → terminal and moved no base asset. Released, so a later legitimate
 *             exit can be placed for whatever exposure remains.
 *   absent  → a null `submittedAt` proves the order never crossed the
 *             submission boundary and it is released at once; otherwise the
 *             existing 60-second uncertainty floor must pass first.
 *   unknown → no usable evidence, including a terminal order carrying a partial
 *             fill. Stay blocked, and say why.
 */
export async function resolveUnresolvedExitAttempts(
  smartTradeId: string,
  probe: ExitAttemptProbe,
  now: number = Date.now()
): Promise<ExitAttemptResolution> {
  const attempts = await prisma.exchangeOrderAttempt.findMany({
    where: { smartTradeId, side: "SELL", status: "open" },
    orderBy: { createdAt: "asc" },
  });
  const outcome: ExitAttemptResolution = { blocked: false, reconciled: 0, discarded: 0 };
  const reasons: string[] = [];
  for (const attempt of attempts) {
    const reason = await resolveOneExitAttempt(attempt, probe, now, outcome);
    if (reason) reasons.push(reason);
  }
  if (reasons.length > 0) {
    outcome.blocked = true;
    outcome.reason = reasons.join("; ");
  }
  return outcome;
}

async function resolveOneExitAttempt(
  attempt: ExchangeOrderAttempt,
  probe: ExitAttemptProbe,
  now: number,
  outcome: ExitAttemptResolution
): Promise<string | null> {
  const label = `a prior ${attempt.origin ?? "exit"} SELL (${attempt.clientOrderId})`;

  // An attempt booked by a different authority — the manual `ManualOrder`
  // lifecycle — must not be applied here, or the fill lands twice. It is still
  // unresolved exposure, so it still blocks; it is simply not this module's to
  // settle.
  if (!OWNED_ORIGINS.includes(attempt.origin as ExitAttemptOrigin)) {
    return `${label} is still unresolved and is owned by another exit authority`;
  }

  let state: OrderProbe;
  try {
    state = await probe(attempt);
  } catch (error) {
    return `${label} could not be checked at the exchange (${
      error instanceof Error ? error.message : "lookup failed"})`;
  }

  if (state.state === "filled") {
    try {
      const applied = await applyExitFill(attempt, state.result);
      // `null` means a concurrent resolver won the settle and already booked
      // this fill. Nothing to do, and nothing to block: it is resolved.
      if (applied) outcome.reconciled += 1;
    } catch (error) {
      return `${label} filled at the exchange but could not be reconciled (${
        error instanceof Error ? error.message : "reconciliation failed"})`;
    }
    return null;
  }

  if (state.state === "open") {
    // Includes PARTIALLY_FILLED. The attempt is deliberately NOT settled: the
    // remainder may still execute, and settling now would make it invisible.
    await recordOrderAttemptObservation(attempt.id, state.exchangeStatus);
    return `${label} is still live at the exchange (${state.exchangeStatus}); ` +
      "it must settle before another close";
  }

  if (state.state === "unknown") {
    return `${label} has unknown exchange state (${state.reason})`;
  }

  if (state.state === "absent" && attempt.submittedAt) {
    const submittedAt = attempt.submittedAt.getTime();
    if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) {
      await recordOrderAttemptObservation(attempt.id, "ABSENT");
      return `${label} was submitted moments ago and the exchange has no record of it yet; ` +
        "retry once it settles";
    }
  }

  const released = await abandonOrderAttempt(
    attempt.id, state.state === "absent" ? "ABSENT" : state.exchangeStatus);
  if (!released) return `${label} changed state while it was being resolved; retry`;
  outcome.discarded += 1;
  return null;
}
