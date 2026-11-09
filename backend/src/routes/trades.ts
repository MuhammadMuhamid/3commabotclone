import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ControlPending, ControlRefusal } from "../services/controlCommands.js";
import { closeStrategyTrade, partialCloseStrategyTrade } from "../services/tradeExit.js";

export const tradesRouter = Router();

/*
 * The exchange-client seam moved with the exit paths to `services/tradeExit.ts`.
 * Re-exported so existing callers and tests keep one shared object.
 */
export { tradeExchangeClient } from "../services/tradeExit.js";

/**
 * The dashboard's answer for a typed exit outcome. A refusal keeps its code;
 * its operator `detail` (exchange context) is shown here, on the Bot's own
 * authenticated dashboard, and never over the Platform control channel.
 * Anything untyped keeps this route's historical 500 with the message.
 */
function sendExitError(res: Response, e: unknown, fallback: string): void {
  if (e instanceof ControlRefusal) {
    res.status(e.status).json({
      error: e.detail ? `${e.message} (${e.detail})` : e.message, code: e.code,
    });
    return;
  }
  if (e instanceof ControlPending) {
    res.status(202).json({ status: "pending", ...e.ref, detail: e.message });
    return;
  }
  res.status(500).json({ error: e instanceof Error ? e.message : fallback });
}

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
    res.json(await closeStrategyTrade(req.params.id));
  } catch (e) {
    sendExitError(res, e, "Close failed");
  }
});

// F4: Sell a percentage of an active trade without closing it entirely
tradesRouter.post("/:id/partial-close", async (req, res) => {
  const parsed = z.object({
    pct: z.number().min(1).max(99, "Cannot exceed 99% — use full close for 100%"),
  }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
  }
  try {
    res.json(await partialCloseStrategyTrade(req.params.id, parsed.data.pct));
  } catch (e) {
    sendExitError(res, e, "Partial close failed");
  }
});
