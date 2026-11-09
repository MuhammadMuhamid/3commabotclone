import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import type { ExchangeAccount, ManualOrder, SmartTrade } from "@prisma/client";
import { classifyExchangeFailure, describeUncertainFailure, floorToStep } from "./binance.js";
import { BinanceManualExchange, type ManualExchangeAdapter } from "./manualExchange.js";
import {
  applyManualSnapshot, cancelWorkingEntryForExit, closeHaircutRemainder, closeManualDust,
  entryOfRaceFillPosition, haircutForUnnettedEntry, handOffRaceFillSweep, manualExitCapacity,
  PENDING_STATUSES, RACE_FILL_SWEEP, RACE_FILL_SWEPT_REASON, reconcilePendingManualOrders,
  resolveUnresolvedManualExits, UNNETTED_EXIT_HAIRCUT,
} from "./manualTrading.js";
import {
  abandonOrderAttempt, markOrderAttemptSubmitted, openOrderAttempt, settleOrderAttempt,
} from "./orderAttempt.js";
import { getBotRiskLimits } from "./riskControls.js";
import { SUBMITTED_ABSENCE_SETTLE_MS } from "./strategyOrderIntent.js";

/** Bounded startup/reconnect reconciliation entrypoint. */
export async function reconcileManualTrading(): Promise<void> {
  await reconcilePendingManualOrders(undefined, 100);
}

/**
 * Consecutive triggered cycles without an exit fill before the operator is
 * alerted that a position is not actually protected. Same bounded idiom as the
 * strategy monitor's `UNMONITORED_ALERT_CYCLES`: at the threshold, then every
 * 30 cycles — never a line every 30 seconds.
 */
export const PROTECTION_FAILURE_ALERT_CYCLES = 3;
const protectionFailures = new Map<string, number>();

/** OD-1: sweep attempts of one race-fill position before it is handed to the operator. */
export const SWEEP_MAX_ATTEMPTS = 3;
/** X7: cycles a sweep re-queries a gross (un-netted) entry before it sells with the haircut. */
export const SWEEP_NETTING_WAIT_CYCLES = 3;
/**
 * X7: the haircut of a sweep whose fee netting never confirmed — Binance's
 * maximum spot fee, 0.1 % [EXT-UNVERIFIED offline]. Selling that much less
 * keeps a gross figure from selling fee-sized untracked coins. The same
 * figure as the TP/SL and manual full-SELL haircut (review F3).
 */
export const SWEEP_UNNETTED_HAIRCUT = UNNETTED_EXIT_HAIRCUT;
const sweepNettingWaits = new Map<string, number>();

function noteProtectionFailure(positionId: string, pair: string, reason: string,
  what = "has hit its TP/SL"): void {
  const count = (protectionFailures.get(positionId) ?? 0) + 1;
  protectionFailures.set(positionId, count);
  if (count === PROTECTION_FAILURE_ALERT_CYCLES ||
      count % (PROTECTION_FAILURE_ALERT_CYCLES * 10) === 0) {
    console.error(`[manual-tpsl] ALERT: ${pair} position ${positionId} ${what} for ` +
      `${count} consecutive cycles without an exit fill (${reason}). It is NOT protected until ` +
      "this is resolved.");
  }
}

/** One exit the poller is about to size and place: a TP/SL exit or a race-fill sweep. */
interface ManualExitPlan {
  /** For logs: TP, SL or SWEEP. */
  label: string;
  /** The logical order slot (`manual-<tp|sl>-<id>-<level>` or `manual-sweep-<id>`). */
  intentKey: string;
  closedReason: string;
  attemptOrigin: "manual-protection" | "manual-sweep";
  /**
   * The exit row's `protectionState`, which `manualOrderOrigin` reads for the
   * halt: `triggered` is automation; an operator-origin sweep is `sweep`.
   */
  rowState: "triggered" | "sweep";
  /** The most this exit may sell before I3 (the X7 haircut of an unconfirmed sweep). */
  sizeCap: number;
  /** A durable note recorded on the exit order. */
  flag: string | null;
  /** The failure-alert wording. */
  failureWhat: string;
}

/**
 * Manual absolute-price TP/SL is deliberately bot-managed. No exchange-resting
 * protection is claimed: this poller closes only after an authoritative ticker
 * read and persists the exit as another ManualOrder.
 */
export async function checkManualProtection(
  /**
   * The exchange adapter, injectable in the same idiom as
   * `reconcilePendingManualOrders`. It defaults to the real one, so a caller
   * that wants a different exchange has to ask for it in writing.
   */
  adapterFactory: (account: ExchangeAccount) => ManualExchangeAdapter =
  (account) => new BinanceManualExchange(account),
  /** Time seam for the absence rule; production passes nothing. */
  options: { now?: number } = {}
): Promise<void> {
  if (!config.manualTradingEnabled) return;
  const now = options.now ?? Date.now();
  const risk = await getBotRiskLimits();
  /*
   * The halt stops automated exits (existing policy): no TP/SL is evaluated
   * while halted. OD-1: a race-fill sweep follows the halt rule of the exit
   * that caused it — one from an automated exit is HELD (and reported), one
   * from an operator's full SELL is that operator's own exit and still runs.
   * Pause (OD-3) never reaches here: it gates entries only.
   */
  const halted = risk.tradingHalted;
  const positions = await prisma.smartTrade.findMany({
    where: { source: "manual", status: "active", OR: [
      ...(halted ? [] : [{ protectionState: "active",
        OR: [{ manualTpPrice: { not: null } }, { manualSlPrice: { not: null } }] }]),
      { protectionState: RACE_FILL_SWEEP },
    ] },
    include: { exchangeAccount: true }, orderBy: { createdAt: "asc" }, take: 100,
  });
  for (const position of positions) {
    if (!position.exchangeAccount) continue;
    if (!position.exchangeAccount.testnet && !config.mainnetManualTradingEnabled) continue;
    if (!acquireTradeClose(position.id)) continue;
    try {
      let fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
      if (!fresh || fresh.status !== "active") continue;
      const exchange = adapterFactory(position.exchangeAccount);
      let plan: ManualExitPlan;
      let price: number;
      if (fresh.protectionState === RACE_FILL_SWEEP) {
        const sweep = await planRaceFillSweep(fresh, exchange, halted, now);
        if (!sweep) continue;
        ({ plan, position: fresh } = sweep);
        price = await exchange.ticker(fresh.pair);
        await prisma.smartTrade.update({ where: { id: fresh.id }, data: { currentPrice: price } });
      } else {
        if (halted || fresh.protectionState !== "active") continue;
        price = await exchange.ticker(fresh.pair);
        const reason = fresh.manualTpPrice != null && price >= fresh.manualTpPrice ? "tp"
          : fresh.manualSlPrice != null && price <= fresh.manualSlPrice ? "sl" : null;
        await prisma.smartTrade.update({ where: { id: fresh.id }, data: { currentPrice: price } });
        if (!reason) { protectionFailures.delete(fresh.id); continue; }
        const level = reason === "tp" ? fresh.manualTpPrice : fresh.manualSlPrice;
        const intentKey = `manual-${reason}-${fresh.id}-${level}`;

        // Review F1: another exit of this position left `submitted` (the
        // operator's SELL, or the TP exit when the SL now triggers) is
        // resolved first; still unresolved, no exit this cycle.
        const settled = await resolvePriorExits(fresh, exchange, intentKey, now, "has hit its TP/SL");
        if (!settled) continue;
        fresh = settled;

        /*
         * OD-1 (owner-approved option C) on top of D1/I8: an entry still
         * working at the exchange is CANCELLED before this exit is sized. The
         * cancel's cumulative answer carries every fill up to the decision,
         * including one that lands in the race, so this one exit sells it all.
         * A cancel that does not settle the entry falls back to the I8 refresh
         * by query, and never blocks protection: the exit proceeds on the
         * known quantity, and the flag is recorded on the exit order. Whatever
         * fills after the close is swept (see `planRaceFillSweep`).
         */
        const cancel = await cancelWorkingEntryForExit(fresh, exchange, "automation");
        fresh = cancel.position;
        if (!fresh || fresh.status !== "active") continue;
        const race = cancel.raceDelta > 1e-12 && (cancel.outcome === "canceled" ||
          cancel.outcome === "already_terminal")
          ? `RACE FILL: ${Number(cancel.raceDelta.toPrecision(12))} more of the entry had filled by the time it was ` +
            "cancelled for this exit; this exit includes it."
          : null;
        // Review F3 (X7 on the active trade): entry fills still booked gross
        // after one re-query are sold with the 0.1 % haircut, on THIS cycle —
        // a stop-loss never waits for a fee lookup.
        const netting = await haircutForUnnettedEntry(fresh, exchange);
        fresh = netting.position;
        if (!fresh || fresh.status !== "active") continue;
        plan = { label: reason.toUpperCase(), intentKey,
          closedReason: reason === "tp" ? "manual_take_profit" : "manual_stop_loss",
          attemptOrigin: "manual-protection", rowState: "triggered", sizeCap: netting.sizeCap ?? fresh.quantity,
          flag: [race, cancel.flag, netting.flag].filter((note) => note).join(" ") || null,
          failureWhat: "has hit its TP/SL" };
      }
      await runManualExit(fresh, plan, exchange, price, position.exchangeAccount.id, now);
    } catch (error) {
      console.error(`[manual-tpsl] ${position.id} failed`, error);
      noteProtectionFailure(position.id, position.pair,
        error instanceof Error ? error.message : "unexpected failure");
    } finally {
      releaseTradeClose(position.id);
    }
  }
}

/**
 * OD-1 sweep of a race-fill position: when to sell it, and how much at most.
 *
 *  - The halt holds a sweep that an AUTOMATED exit caused; an operator's own
 *    full-SELL remainder still goes out (see `checkManualProtection`).
 *  - After `SWEEP_MAX_ATTEMPTS` settled or abandoned attempts the position is
 *    handed to the operator (`SWEEP FAILED`, ALERT) and no longer swept.
 *  - X7: while the entry's fills are booked gross (its trades lookup failed),
 *    the entry is re-queried each cycle and the sweep waits; after
 *    `SWEEP_NETTING_WAIT_CYCLES` it sells 0.1 % less, with a note.
 */
async function planRaceFillSweep(held: SmartTrade, exchange: ManualExchangeAdapter, halted: boolean,
  now: number): Promise<{ plan: ManualExitPlan; position: SmartTrade } | null> {
  const entry = await entryOfRaceFillPosition(held);
  const origin = entry?.exitOrigin === "operator" ? "operator" : "automation";
  if (halted && origin !== "operator") return null;
  const intentKey = `manual-sweep-${held.id}`;
  // Review F1: an operator SELL of this race-fill position left `submitted`
  // is resolved before the sweep sizes anything.
  const position = await resolvePriorExits(held, exchange, intentKey, now, "is a race fill awaiting its sweep");
  if (!position) return null;
  const last = await prisma.exchangeOrderAttempt.findFirst({ where: { intentKey },
    orderBy: { attempt: "desc" } });
  if (last && last.status !== "open" && last.attempt >= SWEEP_MAX_ATTEMPTS) {
    await handOffRaceFillSweep(position, entry, last.attempt);
    sweepNettingWaits.delete(position.id);
    return null;
  }
  let current = position;
  let sizeCap = position.quantity;
  let flag: string | null = null;
  if (entry && !entry.fillsNetted) {
    try {
      const snapshot = await exchange.query(entry.symbol, entry.clientOrderId);
      if (snapshot) await applyManualSnapshot(entry.id, snapshot, { adapter: exchange });
    } catch (error) {
      console.error(`[manual-tpsl] ${position.id}: the entry's netting lookup failed: ` +
        `${error instanceof Error ? error.message : error}`);
    }
    const reread = await prisma.smartTrade.findUnique({ where: { id: position.id } });
    if (!reread || reread.status !== "active") return null;
    current = reread;
    sizeCap = current.quantity;
    const netted = (await prisma.manualOrder.findUnique({ where: { id: entry.id } }))?.fillsNetted ?? true;
    if (!netted) {
      const waits = (sweepNettingWaits.get(position.id) ?? 0) + 1;
      sweepNettingWaits.set(position.id, waits);
      if (waits < SWEEP_NETTING_WAIT_CYCLES) return null;
      sizeCap = current.quantity * (1 - SWEEP_UNNETTED_HAIRCUT);
      flag = `NETTING UNCONFIRMED: the base-asset commission of these fills could not be confirmed ` +
        `after ${waits} lookups, so this sweep sells ${SWEEP_UNNETTED_HAIRCUT * 100}% less than the ` +
        "gross figure (the maximum spot fee) rather than risk selling untracked coins.";
    } else {
      sweepNettingWaits.delete(position.id);
    }
  }
  return { position: current, plan: { label: "SWEEP", intentKey, closedReason: RACE_FILL_SWEPT_REASON,
    attemptOrigin: "manual-sweep", rowState: origin === "operator" ? "sweep" : "triggered", sizeCap, flag,
    failureWhat: "is a race fill awaiting its sweep" } };
}

/**
 * Review F1 (2026-11-09): before this cycle sizes an exit of `position`, every
 * OTHER SELL of it still `submitted` — the operator's, or another slot's (the
 * TP exit when the SL now triggers) — is resolved query-first
 * (`resolveUnresolvedManualExits`). Still unresolved: no exit this cycle, and
 * the bounded protection alert; never a blind second SELL. Resolved to a fill
 * that closed the position: nothing to do. The cycle's own slot (`ownSlot`)
 * is excluded: `runManualExit` already queries it first (D1/I6).
 *
 * Returns the position to size from, or null when no exit may be placed now.
 */
async function resolvePriorExits(position: SmartTrade, exchange: ManualExchangeAdapter, ownSlot: string,
  now: number, failureWhat: string): Promise<SmartTrade | null> {
  const prior = await resolveUnresolvedManualExits(position.id, exchange,
    { now, skip: (order) => order.requestId.startsWith(`${ownSlot}#`) });
  if (prior.blocked) {
    noteProtectionFailure(position.id, position.pair,
      `a prior exit of this position is unresolved: ${prior.reason}`, failureWhat);
    return null;
  }
  if (prior.reconciled + prior.discarded === 0) return position;
  const fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
  if (fresh?.status === "active") return fresh;
  protectionFailures.delete(position.id);
  sweepNettingWaits.delete(position.id);
  return null;
}

/**
 * Size and place one exit of `fresh` under `plan`, the shared path of a TP/SL
 * exit and a race-fill sweep: drift guard, durable attempt (I6), I3 capacity,
 * I7 dust, compare-and-set before the wire, D2 classification, settlement.
 */
async function runManualExit(fresh: SmartTrade, plan: ManualExitPlan, exchange: ManualExchangeAdapter,
  price: number, accountId: string, now: number): Promise<void> {
  // Spot balances are shared across manual and automated trades. If an
  // external sell made the wallet smaller than the canonical ledgers, do
  // not let this protection sell another trade's coins to make up for it.
  const tracked = await prisma.smartTrade.findMany({ where: { pair: fresh.pair, status: "active",
    OR: [
      { source: "manual", exchangeAccountId: accountId },
      { source: "strategy", bot: { exchangeAccountId: accountId } },
    ] }, select: { quantity: true } });
  const trackedQuantity = tracked.reduce((sum, item) => sum + item.quantity, 0);
  const actualQuantity = await exchange.baseTotal(fresh.pair);
  if (actualQuantity + Math.max(1e-12, trackedQuantity * 1e-8) < trackedQuantity) {
    console.error(`[manual-tpsl] ${fresh.id}: balance drift; refusing to consume another tracked position`);
    noteProtectionFailure(fresh.id, fresh.pair, "the wallet holds less than the tracked positions",
      plan.failureWhat);
    return;
  }

  /*
   * BOT-P1-3: the exit used to be ONE row under a fully deterministic
   * `requestId`, and this loop only ever re-attempted it while it was
   * `requested` or `submitted`. Combined with `manualExchange` recording
   * every MARKET order as FILLED, a stop that returned a zero fill became
   * terminal on its first cycle and was skipped on every cycle after —
   * permanently disarmed, while the position stayed active and the operator
   * surface still reported `protection: active`.
   *
   * The durable attempt is what makes the exit re-armable. The attempt (and
   * with it the client order id) is held while the order is still in
   * flight, so recovery keeps binding to the one exchange order that
   * belongs to it; it is released once that order reaches a terminal
   * exchange state, and only then may the next cycle open a fresh attempt
   * for whatever exposure the fill did not remove.
   */
  const closedReason = plan.closedReason;
  const attempt = await openOrderAttempt({
    intentKey: plan.intentKey, symbol: fresh.pair, side: "SELL",
    // BOT-P1-5: owner and domain, so an unresolved manual exit is visible to
    // anything reasoning about this position. `manual-protection` and
    // `manual-sweep` are not origins `exitSettlement` books — the
    // `ManualOrder` lifecycle owns that accounting — so a resolver finding
    // one reports it, and applies nothing.
    smartTradeId: fresh.id, origin: plan.attemptOrigin,
    requestedBaseQty: Math.min(fresh.quantity, plan.sizeCap), closedReason,
  });
  const requestId = `${plan.intentKey}#${attempt.attempt}`;
  let exit: ManualOrder | null = await prisma.manualOrder.findUnique({ where: { requestId } });

  if (exit?.status === "submitted") {
    /*
     * D1/I6 (R1): this exit already crossed the wire. Query by its client
     * order id; NEVER submit it again — Binance may even accept the reused
     * id once the earlier order FILLED, which would sell twice.
     */
    let found;
    try {
      found = await exchange.query(exit.symbol, exit.clientOrderId);
    } catch (error) {
      noteProtectionFailure(fresh.id, fresh.pair,
        `exit ${exit.clientOrderId} could not be looked up: ${error instanceof Error ? error.message : error}`,
        plan.failureWhat);
      return;
    }
    if (found) {
      exit = await applyManualSnapshot(exit.id, found, { adapter: exchange });
    } else {
      // Not found: the existing absence rule for a submitted exit
      // (`exitSettlement.ts`, `SUBMITTED_ABSENCE_SETTLE_MS`). Inside the
      // window, wait; after it, it was never placed and the slot re-arms.
      const submittedAt = (exit.submittedAt ?? exit.createdAt).getTime();
      if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) return;
      await prisma.manualOrder.updateMany({ where: { id: exit.id, status: "submitted" }, data: {
        status: "rejected", completedAt: new Date(),
        error: `ABSENT: the exchange has no order under client order id ${exit.clientOrderId} ` +
          `${SUBMITTED_ABSENCE_SETTLE_MS / 1000} s after submission; the exit re-arms.` } });
      exit = await prisma.manualOrder.findUniqueOrThrow({ where: { id: exit.id } });
    }
  } else if (!exit || exit.status === "requested") {
    // D1/I3: never more than this position's own remaining quantity, nor
    // more than the free balance left after every other tracked position.
    const free = exchange.baseFree ? await exchange.baseFree(fresh.pair) : Number.POSITIVE_INFINITY;
    const bounded = await manualExitCapacity(fresh, accountId, free);
    const { otherTracked } = bounded;
    const capacity = Math.min(bounded.capacity, plan.sizeCap);
    const rules = exchange.lotRules ? await exchange.lotRules(fresh.pair) : null;
    // D1/I7: a remainder that can never be sold closes as dust instead of
    // being attempted forever.
    if (rules && await closeManualDust(fresh.id, rules, price, exit?.id,
      { adapter: exchange, origin: "automation" })) {
      if (exit) {
        await prisma.manualOrder.updateMany({ where: { id: exit.id, status: "requested" }, data: {
          status: "canceled", completedAt: new Date() } });
      }
      // Nothing was sent or filled under this attempt: abandoned, not settled.
      await abandonOrderAttempt(attempt.id, "DUST");
      protectionFailures.delete(fresh.id);
      sweepNettingWaits.delete(fresh.id);
      return;
    }
    if (!(capacity > 0) || (rules && rules.minQty > 0 &&
        floorToStep(capacity, rules.stepSize) < rules.minQty)) {
      console.error(`[manual-tpsl] ${fresh.id}: only ${capacity} ${fresh.pair} of the free balance ` +
        `is attributable to this position (free ${free}, other tracked ${otherTracked}); ` +
        "refusing to sell another holding's coins");
      noteProtectionFailure(fresh.id, fresh.pair, "the free balance attributable to it is too small",
        plan.failureWhat);
      return;
    }
    if (capacity < fresh.quantity - 1e-12) {
      console.error(`[manual-tpsl] ${fresh.id}: exit capped at ${capacity} of ${fresh.quantity} ` +
        `${fresh.pair} by the free balance left after other tracked positions (${otherTracked})`);
    }
    if (!exit) {
      exit = await prisma.manualOrder.create({ data: {
        requestId, exchangeAccountId: accountId,
        linkedPositionId: fresh.id, symbol: fresh.pair, side: "SELL", orderType: "MARKET",
        quantityType: "base", requestedBaseQty: capacity,
        protectionType: "bot-managed", protectionState: plan.rowState,
        clientOrderId: attempt.clientOrderId, error: plan.flag,
      }});
      if (attempt.attempt > 1) {
        // The signal the old behaviour never gave. Re-arming is correct — an
        // exit that did not cover the position must keep being attempted —
        // but an exit that keeps failing is an operator problem, and it must
        // not be possible to discover it only by reading the order table.
        console.error(
          `[manual-tpsl] ${fresh.id}: ${plan.label} exit re-armed ` +
          `(attempt ${attempt.attempt}); the previous attempt did not cover ` +
          `${fresh.quantity} ${fresh.pair}`
        );
      }
    }
    /*
     * D1/I6: mark the exit `submitted` BEFORE the wire call — a
     * compare-and-set, so neither a concurrent cycle nor the reconciler can
     * also submit it, and a row that crossed the wire never reads
     * `requested` again.
     */
    const claimed = await prisma.manualOrder.updateMany({ where: { id: exit.id, status: "requested" },
      data: { status: "submitted", submittedAt: new Date(), requestedBaseQty: capacity } });
    if (claimed.count !== 1) return;
    await markOrderAttemptSubmitted(attempt.id, capacity);
    try {
      const snapshot = await exchange.submit({ symbol: fresh.pair, side: "SELL", orderType: "MARKET",
        baseQuantity: capacity, clientOrderId: exit.clientOrderId });
      exit = await applyManualSnapshot(exit.id, snapshot, { adapter: exchange });
    } catch (error) {
      // D2: the same classification as every other submit path. Only a
      // definite rejection ends the attempt (and so re-arms the exit); an
      // uncertain answer leaves it `submitted`, to be queried.
      const failure = classifyExchangeFailure(error);
      if (failure.outcome === "rejected") {
        await prisma.manualOrder.updateMany({ where: { id: exit.id, status: "submitted" }, data: {
          status: "rejected", completedAt: new Date(), error: failure.message } });
      } else {
        await prisma.manualOrder.update({ where: { id: exit.id }, data: {
          error: describeUncertainFailure(failure) } });
      }
      exit = await prisma.manualOrder.findUniqueOrThrow({ where: { id: exit.id } });
      noteProtectionFailure(fresh.id, fresh.pair, `${failure.outcome}: ${failure.message}`,
        plan.failureWhat);
    }
  }
  if (!exit) return;
  await prisma.smartTrade.updateMany({ where: { id: fresh.id, status: "closed",
    closedReason: "manual_sell" }, data: { closedReason } });
  // A still-pending exit (`open`, `partially_filled`) belongs to
  // `reconcilePendingManualOrders`; placing a second one would over-sell.
  // A terminal one ends this attempt, and freeing the slot is exactly what
  // lets the next cycle re-arm rather than skip forever.
  const settledExit = exit;
  if (!PENDING_STATUSES.includes(settledExit.status)) {
    await prisma.$transaction((tx) =>
      settleOrderAttempt(tx, attempt.id, settledExit.exchangeOrderId ?? undefined));
  }
  const after = await prisma.smartTrade.findUnique({ where: { id: fresh.id } });
  if (after?.status === "active" && settledExit.filledBaseQty > 0) {
    // Review F3: what a haircut exit deliberately left (the presumed
    // commission of gross entry fills) closes with the position, under this
    // exit's reason — it is never sold later out of untracked coins.
    const closedHaircut = await closeHaircutRemainder(settledExit, exchange,
      { closedReason, origin: plan.rowState === "sweep" ? "operator" : "automation" });
    // D1/I7: an exit that left only an unsellable remainder closes it now.
    const rules = !closedHaircut && exchange.lotRules ? await exchange.lotRules(fresh.pair) : null;
    if (rules) {
      await closeManualDust(fresh.id, rules, price, settledExit.id, { adapter: exchange, origin: "automation" });
    }
  }
  if ((await prisma.smartTrade.findUnique({ where: { id: fresh.id } }))?.status !== "active") {
    protectionFailures.delete(fresh.id);
    sweepNettingWaits.delete(fresh.id);
  }
}
