import { prisma } from "../lib/prisma.js";
import type { BinanceClient } from "./binance.js";
import { getTickerPrice, marketSellBase, clientFromAccount, clientFromEnv } from "./binance.js";
import { getBotRiskLimits } from "./riskControls.js";
import { recordPairClose } from "../lib/tradeCloseTracker.js";
import {
  acquireTradeClose,
  isTradeClosing as isTradeClosingNow,
  releaseTradeClose,
} from "../lib/tradeCloseLock.js";
import { sendExecutionNotification } from "./push.js";
import { mapWithConcurrency } from "../lib/scheduler.js";

/**
 * BOT-033 tuning. Deliberately small: Binance rate-limits by weight, and this
 * runs beside webhook-driven order placement that must not be crowded out.
 */
const PRICE_CONCURRENCY = 4;
const PNL_CONCURRENCY = 4;
import { quantize, sumMoney } from "../lib/money.js";

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
): { pnlUsdt: number; pnlPct: number; finalLegPnlUsdt: number } {
  // P&L for the remaining position being closed now
  const { pnlUsdt: finalLegPnl } = calcRealizedPnl(finalRevenue, remainingQuoteSpent);

  // Sum in all prior partial close P&Ls
  const partialsPnl = sumMoney(partials.map((p) => p.pnlUsdt));
  const totalPnlUsdt = finalLegPnl + partialsPnl;
  // This is the exact stored-accounting delta, not a second formula: subtract
  // already-persisted partial economics from the same cumulative result after
  // applying the existing SQLite storage quantization.
  const finalLegPnlUsdt = sumMoney([quantize(totalPnlUsdt), -partialsPnl]);

  // Reconstruct the original total effective cost for an accurate percentage.
  // From calcRealizedPnl: pnlUsdt = revenue * SELL_FEE - proportionalCost * BUY_FEE
  // => proportionalCost * BUY_FEE = revenue * SELL_FEE - pnlUsdt
  const partialEffectiveCost = sumMoney(
    partials.map((p) => p.revenue * SELL_FEE - p.pnlUsdt)
  );
  const totalEffectiveCost = remainingQuoteSpent * BUY_FEE + partialEffectiveCost;
  const pnlPct = totalEffectiveCost > 0 ? (totalPnlUsdt / totalEffectiveCost) * 100 : 0;

  return { pnlUsdt: totalPnlUsdt, pnlPct, finalLegPnlUsdt };
}

export async function updateSmartTradePnl(
  tradeId: string,
  client?: BinanceClient,
  /**
   * Price already fetched for this pair in this cycle. BOT-033: several trades
   * commonly share a pair, and the monitor used to make one ticker call per
   * TRADE. Passing the price in also means every trade in a cycle is valued at
   * the same tick, which is what an operator reading the dashboard expects.
   */
  knownPrice?: number
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

  const price = knownPrice ?? await getTickerPrice(c, trade.pair);
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

/** Trades that share an exchange account share a client and a price lookup. */
const CLIENT_CACHE_KEY = (accountId: string | null | undefined) => accountId ?? "__env__";

/**
 * One monitor cycle, in two phases (`BOT-033`).
 *
 * Phase 1 — READS — runs with bounded concurrency and one ticker call per
 * distinct (account, pair) instead of one per trade, so the cycle's duration
 * stops scaling linearly with the number of open positions.
 *
 * Phase 2 — ORDERS — stays strictly sequential. Placing sells concurrently is
 * not a latency problem worth solving: it is how two closes on one account
 * interleave.
 */
export async function checkTakeProfitStopLoss(
  /** Test-only override; production always resolves via the account/env clients below. */
  options: { resolveClient?: (accountId: string | null | undefined) => Promise<BinanceClient | undefined> } = {}
): Promise<void> {
  const trades = await prisma.smartTrade.findMany({
    where: { status: "active" },
    include: { bot: true },
  });

  // ── Phase 0: resolve one client per exchange account ──────────────────────
  const clients = new Map<string, BinanceClient | undefined>();
  const clientFor = async (accountId: string | null | undefined): Promise<BinanceClient | undefined> => {
    const key = CLIENT_CACHE_KEY(accountId);
    if (clients.has(key)) return clients.get(key);
    let client: BinanceClient | undefined;
    if (options.resolveClient) {
      client = await options.resolveClient(accountId);
    } else {
      if (accountId) {
        const acc = await prisma.exchangeAccount.findUnique({ where: { id: accountId } });
        if (acc) client = clientFromAccount(acc);
      }
      if (!client) client = clientFromEnv() ?? undefined;
    }
    clients.set(key, client);
    return client;
  };

  const candidates: { trade: (typeof trades)[number]; client: BinanceClient }[] = [];
  for (const trade of trades) {
    // F5: bot is null when the parent bot was deleted — skip TP/SL but still refresh PnL if possible
    if (!trade.bot) continue;
    // Cheap pre-check so a trade another path is already closing is skipped
    // before any Binance call. The authoritative acquire happens below.
    if (isTradeClosingNow(trade.id)) continue;
    const client = await clientFor(trade.bot.exchangeAccountId);
    if (!client) continue;
    candidates.push({ trade, client });
  }

  // ── Phase 1: one price per (account, pair), then refresh P&L concurrently ──
  const priceKeys = [...new Set(candidates.map(
    (c) => `${CLIENT_CACHE_KEY(c.trade.bot!.exchangeAccountId)}\u0000${c.trade.pair}`
  ))];
  const prices = new Map<string, number>();
  await mapWithConcurrency(priceKeys, PRICE_CONCURRENCY, async (key) => {
    const [accountKey, pair] = key.split("\u0000") as [string, string];
    const client = clients.get(accountKey);
    if (!client) return;
    try {
      prices.set(key, await getTickerPrice(client, pair));
    } catch {
      // A pair whose price could not be read is simply not refreshed this
      // cycle; it must not stop the other positions being monitored.
    }
  });

  const refreshed = new Set<string>();
  await mapWithConcurrency(candidates, PNL_CONCURRENCY, async ({ trade, client }) => {
    const key = `${CLIENT_CACHE_KEY(trade.bot!.exchangeAccountId)}\u0000${trade.pair}`;
    try {
      await updateSmartTradePnl(trade.id, client, prices.get(key));
      refreshed.add(trade.id);
    } catch {
      // Leave it out of phase 2: a TP/SL decision on a stale P&L is worse than
      // no decision, and the next cycle is 30 seconds away.
    }
  });

  // ── Phase 2: evaluate and close, one at a time ────────────────────────────
  for (const { trade, client } of candidates) {
    const bot = trade.bot!;
    if (!refreshed.has(trade.id)) continue;

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

      /*
       * F-AUTO-01: the global halt is a hard stop on every real submission —
       * webhook execution and manual protective TP/SL both check it immediately
       * before their exchange call, and this monitor must not be the one path
       * that doesn't. Read fresh (not once per cycle) so a halt engaged mid-cycle
       * still takes effect before THIS trade's sell, and leave the trade active
       * — it is re-evaluated next cycle, not closed or faked.
       */
      if ((await getBotRiskLimits()).tradingHalted) continue;

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
