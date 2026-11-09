import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import type { ExchangeAccount, ManualOrder } from "@prisma/client";
import { classifyExchangeFailure, describeUncertainFailure, floorToStep } from "./binance.js";
import { BinanceManualExchange, type ManualExchangeAdapter } from "./manualExchange.js";
import {
  applyManualSnapshot, closeManualDust, manualExitCapacity, PENDING_STATUSES,
  reconcilePendingManualOrders, refreshWorkingEntry,
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

function noteProtectionFailure(positionId: string, pair: string, reason: string): void {
  const count = (protectionFailures.get(positionId) ?? 0) + 1;
  protectionFailures.set(positionId, count);
  if (count === PROTECTION_FAILURE_ALERT_CYCLES ||
      count % (PROTECTION_FAILURE_ALERT_CYCLES * 10) === 0) {
    console.error(`[manual-tpsl] ALERT: ${pair} position ${positionId} has hit its TP/SL for ` +
      `${count} consecutive cycles without an exit fill (${reason}). It is NOT protected until ` +
      "this is resolved.");
  }
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
  if (risk.tradingHalted) return;
  const positions = await prisma.smartTrade.findMany({
    where: { source: "manual", status: "active", protectionState: "active",
      OR: [{ manualTpPrice: { not: null } }, { manualSlPrice: { not: null } }] },
    include: { exchangeAccount: true }, orderBy: { createdAt: "asc" }, take: 100,
  });
  for (const position of positions) {
    if (!position.exchangeAccount) continue;
    if (!position.exchangeAccount.testnet && !config.mainnetManualTradingEnabled) continue;
    if (!acquireTradeClose(position.id)) continue;
    try {
      let fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
      if (!fresh || fresh.status !== "active" || fresh.protectionState !== "active") continue;
      const exchange = adapterFactory(position.exchangeAccount);
      const price = await exchange.ticker(fresh.pair);
      const reason = fresh.manualTpPrice != null && price >= fresh.manualTpPrice ? "tp"
        : fresh.manualSlPrice != null && price <= fresh.manualSlPrice ? "sl" : null;
      await prisma.smartTrade.update({ where: { id: fresh.id }, data: { currentPrice: price } });
      if (!reason) { protectionFailures.delete(fresh.id); continue; }
      const closedReason = reason === "tp" ? "manual_take_profit" : "manual_stop_loss";

      /*
       * D1/I8: an entry still working at the exchange may already have filled
       * more than the stored snapshot says (a resting LIMIT BUY below the
       * market fills before the price can trade lower). Refresh it first, so
       * this exit sells everything acquired up to the decision. A failed read
       * never blocks protection: the exit proceeds on the known quantity, and
       * the flag is recorded on the exit order.
       */
      const refresh = await refreshWorkingEntry(fresh, exchange);
      fresh = refresh.position;
      if (!fresh || fresh.status !== "active") continue;

      // Spot balances are shared across manual and automated trades. If an
      // external sell made the wallet smaller than the canonical ledgers, do
      // not let this protection sell another trade's coins to make up for it.
      const tracked = await prisma.smartTrade.findMany({ where: { pair: fresh.pair, status: "active",
        OR: [
          { source: "manual", exchangeAccountId: position.exchangeAccount.id },
          { source: "strategy", bot: { exchangeAccountId: position.exchangeAccount.id } },
        ] }, select: { quantity: true } });
      const trackedQuantity = tracked.reduce((sum, item) => sum + item.quantity, 0);
      const actualQuantity = await exchange.baseTotal(fresh.pair);
      if (actualQuantity + Math.max(1e-12, trackedQuantity * 1e-8) < trackedQuantity) {
        console.error(`[manual-tpsl] ${fresh.id}: balance drift; refusing to consume another tracked position`);
        noteProtectionFailure(fresh.id, fresh.pair, "the wallet holds less than the tracked positions");
        continue;
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
      const level = reason === "tp" ? fresh.manualTpPrice : fresh.manualSlPrice;
      const attempt = await openOrderAttempt({
        intentKey: `manual-${reason}-${fresh.id}-${level}`, symbol: fresh.pair, side: "SELL",
        // BOT-P1-5: owner and domain, so an unresolved manual exit is visible to
        // anything reasoning about this position. `manual-protection` is not an
        // origin `exitSettlement` books — the `ManualOrder` lifecycle owns that
        // accounting — so a resolver finding one reports it, and applies nothing.
        smartTradeId: fresh.id, origin: "manual-protection",
        requestedBaseQty: fresh.quantity, closedReason,
      });
      const requestId = `manual-${reason}-${fresh.id}-${level}#${attempt.attempt}`;
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
            `exit ${exit.clientOrderId} could not be looked up: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        if (found) {
          exit = await applyManualSnapshot(exit.id, found);
        } else {
          // Not found: the existing absence rule for a submitted exit
          // (`exitSettlement.ts`, `SUBMITTED_ABSENCE_SETTLE_MS`). Inside the
          // window, wait; after it, it was never placed and the slot re-arms.
          const submittedAt = (exit.submittedAt ?? exit.createdAt).getTime();
          if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) continue;
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
        const { capacity, otherTracked } = await manualExitCapacity(fresh, position.exchangeAccount.id, free);
        const rules = exchange.lotRules ? await exchange.lotRules(fresh.pair) : null;
        // D1/I7: a remainder that can never be sold closes as dust instead of
        // being attempted forever.
        if (rules && await closeManualDust(fresh.id, rules, price, exit?.id)) {
          if (exit) {
            await prisma.manualOrder.updateMany({ where: { id: exit.id, status: "requested" }, data: {
              status: "canceled", completedAt: new Date() } });
          }
          // Nothing was sent or filled under this attempt: abandoned, not settled.
          await abandonOrderAttempt(attempt.id, "DUST");
          protectionFailures.delete(fresh.id);
          continue;
        }
        if (!(capacity > 0) || (rules && rules.minQty > 0 &&
            floorToStep(capacity, rules.stepSize) < rules.minQty)) {
          console.error(`[manual-tpsl] ${fresh.id}: only ${capacity} ${fresh.pair} of the free balance ` +
            `is attributable to this position (free ${free}, other tracked ${otherTracked}); ` +
            "refusing to sell another holding's coins");
          noteProtectionFailure(fresh.id, fresh.pair, "the free balance attributable to it is too small");
          continue;
        }
        if (capacity < fresh.quantity - 1e-12) {
          console.error(`[manual-tpsl] ${fresh.id}: exit capped at ${capacity} of ${fresh.quantity} ` +
            `${fresh.pair} by the free balance left after other tracked positions (${otherTracked})`);
        }
        if (!exit) {
          exit = await prisma.manualOrder.create({ data: {
            requestId, exchangeAccountId: position.exchangeAccount.id,
            linkedPositionId: fresh.id, symbol: fresh.pair, side: "SELL", orderType: "MARKET",
            quantityType: "base", requestedBaseQty: capacity,
            protectionType: "bot-managed", protectionState: "triggered",
            clientOrderId: attempt.clientOrderId, error: refresh.flag ?? null,
          }});
          if (attempt.attempt > 1) {
            // The signal the old behaviour never gave. Re-arming is correct — an
            // exit that did not cover the position must keep being attempted —
            // but an exit that keeps failing is an operator problem, and it must
            // not be possible to discover it only by reading the order table.
            console.error(
              `[manual-tpsl] ${fresh.id}: ${reason.toUpperCase()} exit re-armed ` +
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
        if (claimed.count !== 1) continue;
        await markOrderAttemptSubmitted(attempt.id, capacity);
        try {
          const snapshot = await exchange.submit({ symbol: fresh.pair, side: "SELL", orderType: "MARKET",
            baseQuantity: capacity, clientOrderId: exit.clientOrderId });
          exit = await applyManualSnapshot(exit.id, snapshot);
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
          noteProtectionFailure(fresh.id, fresh.pair, `${failure.outcome}: ${failure.message}`);
        }
      }
      if (!exit) continue;
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
        // D1/I7: an exit that left only an unsellable remainder closes it now.
        const rules = exchange.lotRules ? await exchange.lotRules(fresh.pair) : null;
        if (rules) await closeManualDust(fresh.id, rules, price, settledExit.id);
      }
      if ((await prisma.smartTrade.findUnique({ where: { id: fresh.id } }))?.status !== "active") {
        protectionFailures.delete(fresh.id);
      }
    } catch (error) {
      console.error(`[manual-tpsl] ${position.id} failed`, error);
      noteProtectionFailure(position.id, position.pair,
        error instanceof Error ? error.message : "unexpected failure");
    } finally {
      releaseTradeClose(position.id);
    }
  }
}
