import { prisma } from "../lib/prisma.js";
import type { BinanceClient } from "./binance.js";
import { getTickerPrice, marketSellBase, clientFromAccount, clientFromEnv } from "./binance.js";
import { recordPairClose } from "../lib/tradeCloseTracker.js";
import {
  acquireTradeClose,
  isTradeClosing as isTradeClosingNow,
  releaseTradeClose,
} from "../lib/tradeCloseLock.js";
import { sendExecutionNotification } from "./push.js";
import { sumMoney } from "../lib/money.js";

// F3: Binance charges 0.1% on each side. Factor both into every P&L calculation.
const BUY_FEE  = 1.001; // effective buy cost multiplier
const SELL_FEE = 0.999; // effective sell revenue multiplier

/*
 * BOT-005: the lock moved to `lib/tradeCloseLock.ts`.
 *
 * It used to live here, and this file was the ONLY one that acquired it — the
 * webhook sell path and both dashboard close paths merely read
 * `isTradeClosing`, which reports whether someone else holds it without
 * preventing you from proceeding. Moving it out means no caller has to import
 * the TP/SL monitor to take it, which is why three of the four never did.
 */
export { isTradeClosing } from "../lib/tradeCloseLock.js";

/** Net unrealized P&L after accounting for both buy and sell fees. */
export function calcUnrealizedPnl(
  quantity: number,
  currentPrice: number,
  quoteSpent: number
): { pnlUsdt: number; pnlPct: number } {
  const netRevenue  = quantity * currentPrice * SELL_FEE;
  const effectiveCost = quoteSpent * BUY_FEE;
  const pnlUsdt = netRevenue - effectiveCost;
  const pnlPct  = effectiveCost > 0 ? (pnlUsdt / effectiveCost) * 100 : 0;
  return { pnlUsdt, pnlPct };
}

/** Net realized P&L after accounting for both buy and sell fees. */
export function calcRealizedPnl(
  sellRevenue: number,
  quoteSpent: number
): { pnlUsdt: number; pnlPct: number } {
  const netRevenue    = sellRevenue * SELL_FEE;
  const effectiveCost = quoteSpent  * BUY_FEE;
  const pnlUsdt = netRevenue - effectiveCost;
  const pnlPct  = effectiveCost > 0 ? (pnlUsdt / effectiveCost) * 100 : 0;
  return { pnlUsdt, pnlPct };
}

/**
 * Calculate total realized P&L for a trade's **final** close,
 * accumulating all prior partial close P&Ls into the result.
 *
 * @param finalRevenue        - cummulativeQuoteQty from the closing sell order
 * @param remainingQuoteSpent - trade.quoteSpent at close time (already reduced by prior partials)
 * @param partials            - all PartialClose records recorded before this final close
 */
export function calcFinalClosePnl(
  finalRevenue: number,
  remainingQuoteSpent: number,
  partials: { pnlUsdt: number; revenue: number }[]
): { pnlUsdt: number; pnlPct: number } {
  // P&L for the remaining position being closed now
  const { pnlUsdt: finalLegPnl } = calcRealizedPnl(finalRevenue, remainingQuoteSpent);

  // Sum in all prior partial close P&Ls
  const partialsPnl = sumMoney(partials.map((p) => p.pnlUsdt));
  const totalPnlUsdt = finalLegPnl + partialsPnl;

  // Reconstruct the original total effective cost for an accurate percentage.
  // From calcRealizedPnl: pnlUsdt = revenue * SELL_FEE - proportionalCost * BUY_FEE
  // => proportionalCost * BUY_FEE = revenue * SELL_FEE - pnlUsdt
  const partialEffectiveCost = sumMoney(
    partials.map((p) => p.revenue * SELL_FEE - p.pnlUsdt)
  );
  const totalEffectiveCost = remainingQuoteSpent * BUY_FEE + partialEffectiveCost;
  const pnlPct = totalEffectiveCost > 0 ? (totalPnlUsdt / totalEffectiveCost) * 100 : 0;

  return { pnlUsdt: totalPnlUsdt, pnlPct };
}

export async function updateSmartTradePnl(
  tradeId: string,
  client?: BinanceClient
): Promise<void> {
  const trade = await prisma.smartTrade.findUnique({
    where: { id: tradeId },
    include: { bot: true },
  });
  if (!trade || trade.status !== "active") return;

  let c = client;
  if (!c) {
    if (trade.bot?.exchangeAccountId) {
      const acc = await prisma.exchangeAccount.findUnique({
        where: { id: trade.bot.exchangeAccountId },
      });
      if (acc) c = clientFromAccount(acc);
    }
    if (!c) c = clientFromEnv() ?? undefined;
  }
  if (!c) return;

  const price = await getTickerPrice(c, trade.pair);
  const { pnlUsdt, pnlPct } = calcUnrealizedPnl(trade.quantity, price, trade.quoteSpent);

  await prisma.smartTrade.update({
    where: { id: tradeId },
    data: { currentPrice: price, pnlUsdt, pnlPct },
  });
}

export async function refreshAllActivePnL(): Promise<void> {
  const trades = await prisma.smartTrade.findMany({
    where: { status: "active" },
    include: { bot: true },
  });
  for (const t of trades) {
    try {
      await updateSmartTradePnl(t.id);
    } catch {
      /* skip individual failures */
    }
  }
}

export async function checkTakeProfitStopLoss(): Promise<void> {
  const trades = await prisma.smartTrade.findMany({
    where: { status: "active" },
    include: { bot: true },
  });

  for (const trade of trades) {
    const bot = trade.bot;
    // F5: bot is null when the parent bot was deleted — skip TP/SL but still refresh PnL if possible
    if (!bot) continue;

    // Cheap pre-check so a trade another path is already closing is skipped
    // before any Binance call. The authoritative acquire happens below.
    if (isTradeClosingNow(trade.id)) continue;

    let client: BinanceClient | undefined;
    if (bot.exchangeAccountId) {
      const acc = await prisma.exchangeAccount.findUnique({
        where: { id: bot.exchangeAccountId },
      });
      if (acc) client = clientFromAccount(acc);
    }
    if (!client) client = clientFromEnv() ?? undefined;
    if (!client) continue;

    try {
      await updateSmartTradePnl(trade.id, client);
    } catch {
      continue;
    }

    if (!bot.takeProfitEnabled && !bot.stopLossEnabled) continue;

    const updated = await prisma.smartTrade.findUnique({ where: { id: trade.id } });
    if (!updated || updated.status !== "active") continue;

    const hitTp =
      bot.takeProfitEnabled &&
      bot.takeProfitPct != null &&
      updated.pnlPct >= bot.takeProfitPct;
    const hitSl =
      bot.stopLossEnabled &&
      bot.stopLossPct != null &&
      updated.pnlPct <= -Math.abs(bot.stopLossPct);

    if (!hitTp && !hitSl) continue;

    if (!acquireTradeClose(trade.id)) continue;

    try {
      const fresh = await prisma.smartTrade.findUnique({ where: { id: trade.id } });
      if (!fresh || fresh.status !== "active") continue;

      // Fetch prior partial closes so their P&L is included in the final total
      const partials = await prisma.partialClose.findMany({ where: { tradeId: trade.id } });

      /*
       * BOT-018: sell what the trade holds NOW.
       *
       * This re-fetched `fresh` and then used `trade.quantity` and
       * `trade.quoteSpent` from the snapshot taken at the top of the loop. A
       * partial close landing in between made both figures stale, so the sell
       * asked for more base asset than remained (silently capped, leaving the
       * trade marked closed with dust behind) and the P&L was computed against
       * the wrong cost basis. The re-fetch was already there; it just was not
       * used.
       */
      const sellResult = await marketSellBase(client, trade.pair, fresh.quantity, {
        idempotencyScope: `tpsl:${trade.id}:${hitTp ? "tp" : "sl"}`,
      });
      const { pnlUsdt, pnlPct } = calcFinalClosePnl(
        sellResult.cummulativeQuoteQty,
        fresh.quoteSpent,
        partials
      );

      // BOT-006: a close that did not cover the position leaves the trade OPEN
      // rather than marking it closed with the remainder stranded.
      if (sellResult.executedQty < fresh.quantity * 0.999) {
        const remaining = fresh.quantity - sellResult.executedQty;
        await prisma.smartTrade.update({
          where: { id: trade.id },
          data: {
            quantity: Math.max(0, remaining),
            quoteSpent: Math.max(0, fresh.quoteSpent * (remaining / fresh.quantity)),
            currentPrice: sellResult.avgPrice,
          },
        });
        console.error(
          `[tpsl] ${trade.pair}: close filled ${sellResult.executedQty} of ${fresh.quantity}; ` +
          `trade ${trade.id} remains OPEN with ${remaining} outstanding`
        );
        continue;
      }

      await prisma.smartTrade.update({
        where: { id: trade.id },
        data: {
          status: "closed",
          closedAt: new Date(),
          closedReason: hitTp ? "take_profit" : "stop_loss",
          currentPrice: sellResult.avgPrice,
          pnlUsdt,
          pnlPct,
        },
      });
      // Record close so stale SELL webhooks don't close the next trade on this pair
      if (trade.botId) await recordPairClose(trade.botId, trade.pair);
      void sendExecutionNotification({
        side: "sell", symbol: trade.pair, quantity: sellResult.executedQty,
        quoteAmount: sellResult.cummulativeQuoteQty, price: sellResult.avgPrice,
        orderId: sellResult.orderId, pnlPct,
      }).catch((e) => console.error("TP/SL notification failed", e));
    } catch (e) {
      console.error("TP/SL close failed", trade.id, e);
    } finally {
      releaseTradeClose(trade.id);
    }
  }
}
