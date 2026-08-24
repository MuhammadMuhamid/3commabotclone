/**
 * F2: Detects positions closed directly on Binance (outside the bot).
 *
 * Strategy: Group active trades by (exchange account, base asset). Compare the
 * sum of expected quantities against the actual free+locked Binance balance.
 * If the balance is < 90% of what we expect, the deficit was closed externally.
 * Trades are reconciled newest-first (LIFO) until the balance is accounted for.
 *
 * Runs every 60 seconds from index.ts.
 */

import { prisma } from "../lib/prisma.js";
import {
  clientFromAccount,
  clientFromEnv,
  type BinanceClient,
} from "./binance.js";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";
import { calcFinalClosePnl } from "./smartTrade.js";
import { recordPairClose } from "../lib/tradeCloseTracker.js";

const TOLERANCE = 0.90; // flag if actual balance < 90% of expected

export async function detectManualCloses(): Promise<void> {
  const activeTrades = await prisma.smartTrade.findMany({
    where: { status: "active" },
    include: {
      bot: { include: { exchangeAccount: true } },
      partialCloses: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (activeTrades.length === 0) return;

  // Build groups keyed by "accountKey|baseAsset"
  type GroupEntry = { client: BinanceClient; trades: typeof activeTrades };
  const groups = new Map<string, GroupEntry>();

  for (const trade of activeTrades) {
    if (!trade.bot) continue; // orphaned trade — no credentials to check with

    let client: BinanceClient | null = null;
    let accountKey = "env";

    if (trade.bot.exchangeAccountId && trade.bot.exchangeAccount) {
      client = clientFromAccount(trade.bot.exchangeAccount);
      accountKey = trade.bot.exchangeAccountId;
    } else {
      client = clientFromEnv();
    }

    if (!client) continue;

    const { base } = parsePair(toBinanceSymbol(trade.pair));
    const key = `${accountKey}|${base}`;

    if (!groups.has(key)) groups.set(key, { client, trades: [] });
    groups.get(key)!.trades.push(trade);
  }

  for (const { client, trades: groupTrades } of groups.values()) {
    try {
      const { base } = parsePair(toBinanceSymbol(groupTrades[0].pair));
      const accountInfo = await client.accountInfo();
      const bal = accountInfo.balances.find((b) => b.asset === base);
      const actualTotal =
        parseFloat(bal?.free ?? "0") + parseFloat(bal?.locked ?? "0");

      const expectedTotal = groupTrades.reduce((s, t) => s + t.quantity, 0);

      // Within tolerance — everything still open
      if (actualTotal >= expectedTotal * TOLERANCE) continue;

      console.log(
        `[sync] ${base}: expected=${expectedTotal.toFixed(6)}, actual=${actualTotal.toFixed(6)} — detecting manual closes`
      );

      // LIFO: newest trades closed first. Walk the list until balance is accounted for.
      let remaining = actualTotal;
      for (const trade of groupTrades) {
        if (remaining >= trade.quantity * TOLERANCE) {
          remaining = Math.max(0, remaining - trade.quantity);
          continue; // this trade is still funded — keep open
        }

        // Trade's assets are missing — mark as closed manually.
        // Best-effort revenue: current price × remaining qty (or quoteSpent as break-even fallback).
        // Include any prior partial close P&Ls in the total.
        const estimatedRevenue =
          trade.currentPrice != null
            ? trade.currentPrice * trade.quantity
            : trade.quoteSpent;
        const { pnlUsdt, pnlPct } = calcFinalClosePnl(
          estimatedRevenue,
          trade.quoteSpent,
          trade.partialCloses
        );

        await prisma.smartTrade.update({
          where: { id: trade.id },
          data: {
            status: "closed",
            closedAt: new Date(),
            closedReason: "closed_manually",
            pnlUsdt,
            pnlPct,
          },
        });

        // Record close so stale SELL webhooks don't close the next trade on this pair
        if (trade.botId) recordPairClose(trade.botId, trade.pair);

        console.log(
          `[sync] Trade ${trade.id} (${trade.pair}) marked closed_manually`
        );

        remaining = Math.max(0, remaining - trade.quantity);
      }
    } catch (e) {
      console.error("[sync] detectManualCloses group error:", e);
    }
  }
}
