import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import type { ExchangeAccount } from "@prisma/client";
import { BinanceManualExchange, type ManualExchangeAdapter } from "./manualExchange.js";
import {
  applyManualSnapshot, PENDING_STATUSES, reconcilePendingManualOrders,
} from "./manualTrading.js";
import { markOrderAttemptSubmitted, openOrderAttempt, settleOrderAttempt } from "./orderAttempt.js";
import { getBotRiskLimits } from "./riskControls.js";

/** Bounded startup/reconnect reconciliation entrypoint. */
export async function reconcileManualTrading(): Promise<void> {
  await reconcilePendingManualOrders(undefined, 100);
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
  (account) => new BinanceManualExchange(account)
): Promise<void> {
  if (!config.manualTradingEnabled) return;
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
      const fresh = await prisma.smartTrade.findUnique({ where: { id: position.id } });
      if (!fresh || fresh.status !== "active" || fresh.protectionState !== "active") continue;
      const exchange = adapterFactory(position.exchangeAccount);
      const price = await exchange.ticker(fresh.pair);
      const reason = fresh.manualTpPrice != null && price >= fresh.manualTpPrice ? "tp"
        : fresh.manualSlPrice != null && price <= fresh.manualSlPrice ? "sl" : null;
      await prisma.smartTrade.update({ where: { id: fresh.id }, data: { currentPrice: price } });
      if (!reason) continue;

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
        requestedBaseQty: fresh.quantity,
        closedReason: reason === "tp" ? "manual_take_profit" : "manual_stop_loss",
      });
      const requestId = `manual-${reason}-${fresh.id}-${level}#${attempt.attempt}`;
      let exit = await prisma.manualOrder.findUnique({ where: { requestId } });
      if (!exit) {
        exit = await prisma.manualOrder.create({ data: {
          requestId, exchangeAccountId: position.exchangeAccount.id,
          linkedPositionId: fresh.id, symbol: fresh.pair, side: "SELL", orderType: "MARKET",
          quantityType: "base", requestedBaseQty: fresh.quantity,
          protectionType: "bot-managed", protectionState: "triggered",
          clientOrderId: attempt.clientOrderId,
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
      if (["requested", "submitted"].includes(exit.status)) {
        // Before the wire call, never after.
        await markOrderAttemptSubmitted(attempt.id, fresh.quantity);
        const snapshot = await exchange.submit({ symbol: fresh.pair, side: "SELL", orderType: "MARKET",
          baseQuantity: fresh.quantity, clientOrderId: exit.clientOrderId });
        exit = await applyManualSnapshot(exit.id, snapshot);
        await prisma.smartTrade.updateMany({ where: { id: fresh.id, status: "closed" },
          data: { closedReason: reason === "tp" ? "manual_take_profit" : "manual_stop_loss" } });
      }
      // A still-pending exit (`open`, `partially_filled`) belongs to
      // `reconcilePendingManualOrders`; placing a second one would over-sell.
      // A terminal one ends this attempt, and freeing the slot is exactly what
      // lets the next cycle re-arm rather than skip forever.
      const settledExit = exit;
      if (!PENDING_STATUSES.includes(settledExit.status)) {
        await prisma.$transaction((tx) =>
          settleOrderAttempt(tx, attempt.id, settledExit.exchangeOrderId ?? undefined));
      }
    } catch (error) {
      console.error(`[manual-tpsl] ${position.id} failed`, error);
    } finally {
      releaseTradeClose(position.id);
    }
  }
}
