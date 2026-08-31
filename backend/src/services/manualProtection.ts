import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import { clientOrderId } from "./binance.js";
import { BinanceManualExchange } from "./manualExchange.js";
import { applyManualSnapshot, reconcilePendingManualOrders } from "./manualTrading.js";
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
export async function checkManualProtection(): Promise<void> {
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
      const exchange = new BinanceManualExchange(position.exchangeAccount);
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

      const requestId = `manual-${reason}-${fresh.id}-${reason === "tp" ? fresh.manualTpPrice : fresh.manualSlPrice}`;
      let exit = await prisma.manualOrder.findUnique({ where: { requestId } });
      if (!exit) {
        exit = await prisma.manualOrder.create({ data: {
          requestId, exchangeAccountId: position.exchangeAccount.id,
          linkedPositionId: fresh.id, symbol: fresh.pair, side: "SELL", orderType: "MARKET",
          quantityType: "base", requestedBaseQty: fresh.quantity,
          protectionType: "bot-managed", protectionState: "triggered",
          clientOrderId: clientOrderId(requestId),
        }});
      }
      if (!["requested", "submitted"].includes(exit.status)) continue;
      const snapshot = await exchange.submit({ symbol: fresh.pair, side: "SELL", orderType: "MARKET",
        baseQuantity: fresh.quantity, clientOrderId: exit.clientOrderId });
      await applyManualSnapshot(exit.id, snapshot);
      await prisma.smartTrade.updateMany({ where: { id: fresh.id, status: "closed" },
        data: { closedReason: reason === "tp" ? "manual_take_profit" : "manual_stop_loss" } });
    } catch (error) {
      console.error(`[manual-tpsl] ${position.id} failed`, error);
    } finally {
      releaseTradeClose(position.id);
    }
  }
}
