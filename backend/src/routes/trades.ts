import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { acquireTradeClose, isTradeClosing, releaseTradeClose } from "../lib/tradeCloseLock.js";
import {
  marketSellBase, resolveSellQuantity, clientFromAccount, clientFromEnv,
  type BinanceClient,
} from "../services/binance.js";
import type { ExchangeAccount } from "@prisma/client";
import { sendExecutionNotification } from "../services/push.js";
import { markOrderAttemptSubmitted, openOrderAttempt } from "../services/orderAttempt.js";
import { applyExitFill, exitAttemptProbe, resolveUnresolvedExitAttempts } from "../services/exitSettlement.js";
import { config } from "../config.js";

export const tradesRouter = Router();

/** The shape the dashboard expects a trade in, after a close changed it. */
function tradeWithDetail(tradeId: string) {
  return prisma.smartTrade.findUnique({
    where: { id: tradeId },
    include: {
      bot: { select: { id: true, name: true, exchangeAccount: { select: { name: true } } } },
      partialCloses: { orderBy: { createdAt: "asc" } },
    },
  });
}

/**
 * How this router obtains an exchange client.
 *
 * A mutable export in the same idiom as `checkTakeProfitStopLoss`'s
 * `resolveClient` option and `reconcilePendingManualOrders`'s `adapterFactory`:
 * an HTTP handler has nowhere to accept an injected dependency, and without a
 * seam the only way to exercise this path is against the real Binance client.
 * Production never reassigns it.
 */
export const tradeExchangeClient = {
  resolve(bot: { exchangeAccountId: string | null; exchangeAccount: ExchangeAccount | null }):
  BinanceClient | null {
    return bot.exchangeAccountId && bot.exchangeAccount
      ? clientFromAccount(bot.exchangeAccount)
      : clientFromEnv();
  },
};

// Delete a closed trade from history
tradesRouter.delete("/:id", async (req, res) => {
  const trade = await prisma.smartTrade.findUnique({ where: { id: req.params.id } });
  if (!trade) return res.status(404).json({ error: "Not found" });
  if (trade.status === "active") {
    return res.status(400).json({ error: "Cannot delete an active trade. Close it first." });
  }
  await prisma.smartTrade.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

tradesRouter.get("/", async (req, res) => {
  const raw = (req.query.status as string) || "active";
  const status = raw === "history" ? "closed" : raw;
  const botId = req.query.botId as string | undefined;
  const where: { status: string; botId?: string } = { status };
  if (botId) where.botId = botId;

  const trades = await prisma.smartTrade.findMany({
    where,
    orderBy: status === "closed" ? { closedAt: "desc" } : { createdAt: "desc" },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          exchangeAccount: { select: { name: true } },
        },
      },
      partialCloses: { orderBy: { createdAt: "asc" } },
    },
  });

  // F5: for orphaned trades (bot deleted) expose botName from the denormalised field
  const mapped = trades.map((t) => ({
    ...t,
    bot: t.bot ?? { id: null, name: t.botName || "Deleted Bot", exchangeAccount: null },
  }));

  res.json(mapped);
});

tradesRouter.post("/:id/close", async (req, res) => {
  try {
    const trade = await prisma.smartTrade.findUnique({
      where: { id: req.params.id },
      include: { bot: true },
    });
    if (!trade || trade.status !== "active") {
      return res.status(400).json({ error: "Trade not active" });
    }
    // F5: if the bot was deleted we cannot close via webhook — give clear instructions
    if (!trade.bot) {
      return res.status(422).json({
        error: "This trade's bot was deleted. Close the position directly on Binance.",
      });
    }
    /*
     * BOT-005: this checked `isTradeClosing` read-only, which reports whether
     * someone else holds the lock without preventing this path proceeding. A
     * dashboard close racing the TP/SL monitor issued two market sells.
     *
     * `processWebhook` acquires the lock itself for its sell branch, so the
     * check here is a fast, informative 409 rather than the guarantee — the
     * guarantee is inside `processWebhook`.
     */
    if (isTradeClosing(trade.id)) {
      return res
        .status(409)
        .json({ error: "Trade is already being closed. Please wait." });
    }
    const { processWebhook } = await import("../services/webhook.js");
    const result = await processWebhook(
      {
        secret: trade.bot.webhookSecret,
        action: "SELL",
        symbol: trade.pair,
        quantity: trade.quantity,
      },
      { skipExitCheck: true }
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "Close failed" });
  }
});

// F4: Sell a percentage of an active trade without closing it entirely
tradesRouter.post("/:id/partial-close", async (req, res) => {
  try {
    const schema = z.object({
      pct: z.number().min(1).max(99, "Cannot exceed 99% — use full close for 100%"),
    });
    const { pct } = schema.parse(req.body);

    const trade = await prisma.smartTrade.findUnique({
      where: { id: req.params.id },
      include: { bot: { include: { exchangeAccount: true } } },
    });
    if (!trade || trade.status !== "active") {
      return res.status(400).json({ error: "Trade not active" });
    }
    if (!trade.bot) {
      return res.status(422).json({
        error: "This trade's bot was deleted. Close the position directly on Binance.",
      });
    }
    /*
     * BOT-005: hold the lock across the whole read-sell-write sequence, not
     * just check it. This path reads the quantity, sells, then writes the
     * reduced quantity back — a TP/SL close landing in between would sell the
     * same base asset twice and, because a sell is capped against the shared
     * WALLET balance, could eat another bot's position in the same asset.
     */
    if (!acquireTradeClose(trade.id)) {
      return res.status(409).json({ error: "Trade is being closed. Please wait." });
    }
    try {
    // Resolve client
    const client = tradeExchangeClient.resolve(trade.bot);
    if (!client) {
      return res.status(503).json({ error: "No Binance credentials configured." });
    }

    /*
     * BOT-P1-5: a durable exit attempt left unresolved by a crash is the only
     * surviving evidence that a SELL may already be live at Binance — the
     * in-process close lock does not survive a restart. Resolving it here, from
     * current exchange evidence, is what stops this scale-out landing on top of
     * a TP, SL or earlier partial that was never settled locally.
     */
    const resolution = await resolveUnresolvedExitAttempts(
      trade.id, exitAttemptProbe(client, config.dryRun));
    if (resolution.blocked) {
      return res.status(409).json({
        error: `${trade.pair}: a prior exit has unresolved exchange state — ${resolution.reason}`,
      });
    }
    // A recovered fill has already moved the ledger, so this exit has to be
    // sized off the position as it stands NOW, never off the stale read above.
    const current = resolution.reconciled > 0
      ? await prisma.smartTrade.findUnique({ where: { id: trade.id } })
      : trade;
    if (!current || current.status !== "active") {
      return res.status(409).json({
        error: "A prior exit was already filled at the exchange and has now been reconciled; " +
          "it closed this position. No second order was placed.",
      });
    }

    // Calculate the precise quantity for this percentage
    const requestedQty = current.quantity * (pct / 100);
    const sellQty = await resolveSellQuantity(client, trade.pair, requestedQty);

    /*
     * BOT-P1-1: the scope used to be `partial:${trade.id}:${pct}` — a pure
     * function of the position and the percentage, with nothing that
     * distinguishes one 25% exit from the next one. Two legitimate scale-outs
     * at the same percentage therefore presented the SAME client order id, and
     * `marketSellBase`'s duplicate-rejection branch resolved the second order
     * to the FIRST order's fill: a second PartialClose row carrying the first
     * sale's revenue, the position reduced twice on paper with nothing sold,
     * and that fabricated P&L feeding the daily-loss kill switch.
     *
     * The durable attempt is the missing identity. A retry or crash recovery of
     * THIS exit finds the same open attempt and keeps its id, so query-first
     * recovery still works; a genuinely new exit can only be opened once this
     * one has settled, and therefore carries a different id.
     *
     * BOT-P1-5: it now also carries WHOSE exit it is, so close admission and
     * restart recovery can find it at all.
     */
    const attempt = await openOrderAttempt({
      intentKey: `partial:${trade.id}:${pct}`, symbol: trade.pair, side: "SELL",
      smartTradeId: trade.id, origin: "partial", sellPercent: pct,
      requestedBaseQty: sellQty, closedReason: "partial_close",
    });
    // Before the wire call, never after: a null `submittedAt` is what proves to
    // a later recovery that no order was ever sent under this id.
    await markOrderAttemptSubmitted(attempt.id, sellQty);

    const orderResult = await marketSellBase(client, trade.pair, sellQty, {
      explicitClientOrderId: attempt.clientOrderId,
    });

    /*
     * BOT-P1-6: the ACTUAL executed quantity is the accounting authority.
     *
     * This used to spend `sellQty` — the REQUESTED slice — on the proportional
     * cost basis, on the reduced position quantity and on `PartialClose.quantity`,
     * while taking revenue from the real fill. A partial fill therefore removed
     * base asset from the local position that was never sold, and a zero fill
     * wrote a `PartialClose` row for a sale that did not happen. The remaining
     * exposure was wrong from that moment on.
     *
     * `applyExitFill` is the single settlement authority shared with the TP/SL
     * monitor and with restart recovery, so the same fill produces the same
     * final state whichever path discovers it — and the compare-and-set that
     * settles the attempt inside its transaction is what makes it exactly once.
     */
    const applied = await applyExitFill(attempt, orderResult);
    if (!applied) {
      return res.status(409).json({
        error: "This partial exit has already been recorded; no second sale was made.",
      });
    }
    if (applied.executedQty <= 0) {
      // Nothing was sold, so nothing was booked. Truthful beats tidy.
      return res.status(200).json({
        partial: null,
        trade: await tradeWithDetail(trade.id),
        requestedQty: sellQty,
        executedQty: 0,
        detail: `${trade.pair}: the exchange filled none of the requested ${sellQty}; ` +
          `the position is unchanged (${orderResult.exchangeStatus ?? "no fill"}).`,
      });
    }
    const partial = applied.partial;
    const updatedTrade = await tradeWithDetail(trade.id);

    void sendExecutionNotification({
      side: "sell", symbol: trade.pair, quantity: orderResult.executedQty,
      quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
      orderId: orderResult.orderId, pnlPct: applied.pnlPct,
    }).catch((e) => console.error("Partial-close notification failed", e));

    // Requested and executed stay distinguishable on the wire: `partial.quantity`
    // is what actually sold, `requestedQty` is what was asked for.
    res.json({
      partial, trade: updatedTrade,
      requestedQty: sellQty, executedQty: applied.executedQty,
    });
    } finally {
      // A leaked lock makes the trade permanently uncloseable, which is worse
      // than the double sell it prevents.
      releaseTradeClose(trade.id);
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    res.status(500).json({ error: e instanceof Error ? e.message : "Partial close failed" });
  }
});
