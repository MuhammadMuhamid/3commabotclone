import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isTradeClosing, calcRealizedPnl, calcFinalClosePnl } from "../services/smartTrade.js";
import { marketSellBase, resolveSellQuantity, clientFromAccount, clientFromEnv } from "../services/binance.js";
import { sendExecutionNotification } from "../services/push.js";

export const tradesRouter = Router();

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
    if (isTradeClosing(trade.id)) {
      return res
        .status(409)
        .json({ error: "Trade is already being closed by TP/SL monitor. Please wait." });
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
    if (isTradeClosing(trade.id)) {
      return res.status(409).json({ error: "Trade is being closed. Please wait." });
    }

    // Resolve client
    const client = trade.bot.exchangeAccountId && trade.bot.exchangeAccount
      ? clientFromAccount(trade.bot.exchangeAccount)
      : clientFromEnv();
    if (!client) {
      return res.status(503).json({ error: "No Binance credentials configured." });
    }

    // Calculate the precise quantity for this percentage
    const requestedQty = trade.quantity * (pct / 100);
    const sellQty = await resolveSellQuantity(client, trade.pair, requestedQty);

    const orderResult = await marketSellBase(client, trade.pair, sellQty);

    // Proportional cost of the slice being sold
    const proportionalCost = trade.quoteSpent * (sellQty / trade.quantity);
    const { pnlUsdt, pnlPct } = calcRealizedPnl(
      orderResult.cummulativeQuoteQty,
      proportionalCost
    );

    const newQuantity   = trade.quantity   - sellQty;
    const newQuoteSpent = trade.quoteSpent - proportionalCost;

    // If this partial wipes out the position, compute the true total P&L
    // by summing all prior partial close P&Ls with this final leg.
    let closePnl = { pnlUsdt, pnlPct };
    if (newQuantity <= 0.000001) {
      const prevPartials = await prisma.partialClose.findMany({ where: { tradeId: trade.id } });
      closePnl = calcFinalClosePnl(
        orderResult.cummulativeQuoteQty,
        trade.quoteSpent,   // quoteSpent before this partial (proportional remaining cost)
        prevPartials
      );
    }

    // Record the partial close and update the parent trade atomically
    const [partial, updatedTrade] = await prisma.$transaction([
      prisma.partialClose.create({
        data: {
          tradeId: trade.id,
          pct,
          quantity: sellQty,
          revenue: orderResult.cummulativeQuoteQty,
          pnlUsdt,
          avgPrice: orderResult.avgPrice,
          exchangeOrderId: String(orderResult.orderId),
        },
      }),
      prisma.smartTrade.update({
        where: { id: trade.id },
        data: {
          quantity:   newQuantity,
          quoteSpent: newQuoteSpent,
          // If the remaining quantity is negligible, mark the trade as closed
          ...(newQuantity <= 0.000001
            ? {
                status: "closed",
                closedAt: new Date(),
                closedReason: "partial_close",
                pnlUsdt: closePnl.pnlUsdt,
                pnlPct:  closePnl.pnlPct,
              }
            : {}),
        },
        include: {
          bot: { select: { id: true, name: true, exchangeAccount: { select: { name: true } } } },
          partialCloses: { orderBy: { createdAt: "asc" } },
        },
      }),
    ]);

    void sendExecutionNotification({
      side: "sell", symbol: trade.pair, quantity: orderResult.executedQty,
      quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
      orderId: orderResult.orderId, pnlPct,
    }).catch((e) => console.error("Partial-close notification failed", e));

    res.json({ partial, trade: updatedTrade });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    res.status(500).json({ error: e instanceof Error ? e.message : "Partial close failed" });
  }
});
