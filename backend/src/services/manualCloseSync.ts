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
import { config } from "../config.js";
import {
  clientFromAccount,
  clientFromEnv,
  type BinanceClient,
} from "./binance.js";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";
import { calcFinalClosePnl, calcRealizedPnl } from "./smartTrade.js";
import { recordPairClose } from "../lib/tradeCloseTracker.js";
import { sumMoney } from "../lib/money.js";

const TOLERANCE = 0.90; // flag if actual balance < 90% of expected

export async function detectManualCloses(): Promise<void> {
  /*
   * BOT-035: skip entirely in dry run.
   *
   * A simulated entry creates a trade row but buys no base asset, so this
   * detector saw a balance of zero against a non-zero expected quantity and
   * closed every simulated position within 60 seconds — with a fabricated P&L.
   * The mode the README recommends for pre-live validation could not hold a
   * position long enough to test an exit.
   */
  if (config.dryRun) return;

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

      const expectedTotal = sumMoney(groupTrades.map((t) => t.quantity));

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

        /*
         * BOT-008: derive the close from REAL fills, not from a polled ticker.
         *
         * This estimated revenue as `currentPrice * quantity` — a 60-second-old
         * ticker times the FULL position — and wrote that fabricated number
         * into the database, where `bots.ts` sums it into the account totals.
         * Nothing called `myTrades()`. It also closed trades that had only been
         * partially drained, because the LIFO walk compared against the whole
         * quantity.
         *
         * Now: read the actual SELL fills for this symbol since the trade
         * opened, and use them. If they cannot be read, the trade is left OPEN
         * and flagged — an unknown P&L recorded as fact is worse than an
         * unresolved position an operator can see.
         */
        const fills = await readSellFills(client, trade.pair, trade.createdAt);
        if (fills === null) {
          console.error(
            `[sync] ${trade.pair}: could not read fills for trade ${trade.id}; ` +
            "leaving it OPEN rather than recording an estimated P&L"
          );
          continue;
        }

        const soldQty = fills.reduce((sum, f) => sum + f.qty, 0);
        const revenue = fills.reduce((sum, f) => sum + f.quoteQty, 0);

        if (soldQty <= 0) {
          console.error(
            `[sync] ${trade.pair}: balance is short for trade ${trade.id} but no SELL fills ` +
            "were found. Leaving it OPEN — the asset may have moved for another reason " +
            "(withdrawal, transfer, or a different bot's sell)."
          );
          continue;
        }

        // A PARTIAL external sell reduces the position; it does not close it.
        if (soldQty < trade.quantity * 0.999) {
          const remainingQty = trade.quantity - soldQty;
          const proportionalCost = trade.quoteSpent * (soldQty / trade.quantity);
          const { pnlUsdt } = calcRealizedPnl(revenue, proportionalCost);
          await prisma.$transaction([
            prisma.partialClose.create({
              data: {
                tradeId: trade.id,
                pct: (soldQty / trade.quantity) * 100,
                quantity: soldQty,
                revenue,
                pnlUsdt,
                avgPrice: revenue / soldQty,
                exchangeOrderId: null,
              },
            }),
            prisma.smartTrade.update({
              where: { id: trade.id },
              data: {
                quantity: remainingQty,
                quoteSpent: Math.max(0, trade.quoteSpent - proportionalCost),
                currentPrice: revenue / soldQty,
              },
            }),
          ]);
          console.log(
            `[sync] Trade ${trade.id} (${trade.pair}) partially closed externally: ` +
            `${soldQty} of ${trade.quantity}`
          );
          remaining = Math.max(0, remaining - soldQty);
          continue;
        }

        const { pnlUsdt, pnlPct } = calcFinalClosePnl(
          revenue,
          trade.quoteSpent,
          trade.partialCloses
        );

        await prisma.smartTrade.update({
          where: { id: trade.id },
          data: {
            status: "closed",
            closedAt: new Date(),
            closedReason: "closed_manually",
            currentPrice: revenue / soldQty,
            pnlUsdt,
            pnlPct,
          },
        });

        // Record close so stale SELL webhooks don't close the next trade on this pair
        if (trade.botId) await recordPairClose(trade.botId, trade.pair);

        console.log(
          `[sync] Trade ${trade.id} (${trade.pair}) marked closed_manually from ` +
          `${fills.length} real fill(s), revenue ${revenue.toFixed(2)}`
        );

        remaining = Math.max(0, remaining - trade.quantity);
      }
    } catch (e) {
      console.error("[sync] detectManualCloses group error:", e);
    }
  }
}

export interface SellFill {
  qty: number;
  quoteQty: number;
  time: number;
}

/**
 * Real SELL fills for a symbol since `since`, from `myTrades`.
 *
 * Returns `null` when the call fails, which the caller treats as "leave the
 * trade open and say so" rather than as "no fills". The distinction matters:
 * `[]` means the exchange reports no sells, `null` means we do not know.
 */
export async function readSellFills(
  client: BinanceClient,
  symbol: string,
  since: Date
): Promise<SellFill[] | null> {
  try {
    const rows = (await client.myTrades({
      symbol: toBinanceSymbol(symbol),
      startTime: since.getTime(),
      limit: 500,
    } as Parameters<BinanceClient["myTrades"]>[0])) as unknown as {
      isBuyer: boolean;
      qty: string;
      quoteQty?: string;
      price: string;
      time: number;
    }[];
    return rows
      .filter((r) => !r.isBuyer)
      .map((r) => {
        const qty = parseFloat(r.qty);
        const quoteQty = r.quoteQty !== undefined
          ? parseFloat(r.quoteQty)
          : qty * parseFloat(r.price);
        return { qty, quoteQty, time: r.time };
      })
      .filter((f) => Number.isFinite(f.qty) && f.qty > 0 && Number.isFinite(f.quoteQty));
  } catch (e) {
    console.error("[sync] myTrades failed for", symbol, e);
    return null;
  }
}
