import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ControlPending, ControlRefusal } from "../services/controlCommands.js";
import { closeStrategyTrade, partialCloseStrategyTrade } from "../services/tradeExit.js";
import {
  TradeArchiveRefusal, archivedFilterSchema, archivedWhere, findArchiveBlockers, setTradeArchived,
  type ArchiveBlock,
} from "../services/tradeArchive.js";

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

/**
 * Feature B: deleting a trade is gone. A delete erased realised P&L from the
 * totals and the daily-loss window (and could lift a latched daily-loss halt).
 * Nothing is deleted here any more; Archive hides a trade from History and
 * keeps its accounting.
 */
export const TRADE_DELETE_REMOVED = {
  error: "Deleting trades was replaced by Archive. Archived trades keep their P&L and daily-loss history.",
  code: "trade_delete_removed",
} as const;

tradesRouter.delete("/:id", (_req, res) => {
  res.status(410).json(TRADE_DELETE_REMOVED);
});

for (const [route, archived] of [["archive", true], ["restore", false]] as const) {
  tradesRouter.post(`/:id/${route}`, async (req, res, next) => {
    try {
      res.json(await setTradeArchived(req.params.id, archived, `classic:${String(res.locals.userId ?? "unknown")}`));
    } catch (e) {
      if (e instanceof TradeArchiveRefusal) {
        res.status(e.status).json({ error: e.message, code: e.code });
        return;
      }
      next(e);
    }
  });
}

tradesRouter.get("/", async (req, res) => {
  const raw = (req.query.status as string) || "active";
  const status = raw === "history" ? "closed" : raw;
  const botId = req.query.botId as string | undefined;
  const archivedFilter = archivedFilterSchema.safeParse(req.query.archived ?? "exclude");
  if (!archivedFilter.success) {
    return res.status(400).json({ error: "archived must be one of exclude, include, only", code: "invalid_request" });
  }
  // The archive filter applies to History only; an active trade is never archived.
  const where: { status: string; botId?: string; archivedAt?: null | { not: null } } = {
    status, ...(status === "closed" ? archivedWhere(archivedFilter.data) : {}),
  };
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
  // Feature B: History rows say whether Archive would be refused, and why —
  // the same rule `setTradeArchived` enforces.
  const blockers = status === "closed" ? await findArchiveBlockers(trades) : new Map<string, ArchiveBlock>();
  const mapped = trades.map((t) => ({
    ...t,
    archiveBlocked: blockers.get(t.id) ?? null,
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
