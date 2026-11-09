import { Router, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { formatInvestmentLabel, INVESTMENT_UNITS } from "../lib/investment.js";
import { sumMoney } from "../lib/money.js";
import { readBotStats } from "../services/botView.js";
import { asyncHandler } from "../middleware/errors.js";
import { ControlRefusal } from "../services/controlCommands.js";
import {
  createBot, deleteBotGuarded, maskSecret, parseBotCreate, parseBotPatch, updateBot,
} from "../services/botAdmin.js";

/*
 * The validation, the guards and the writes live in `services/botAdmin.ts`,
 * shared with the Platform's signed commands (C10–C14), so the dashboard and
 * Trading Scene can never disagree about what a valid bot is. Re-exported for
 * existing importers.
 */
export {
  assertSafeBotConfig, countUnresolvedBotIntents, maskSecret, UNPROTECTED_SIZE_LIMIT_PCT,
} from "../services/botAdmin.js";

export const botsRouter = Router();

/** A typed refusal from the shared service, as the dashboard has always shaped it. */
function sendRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof ControlRefusal)) return false;
  res.status(error.status).json({ error: error.message, code: error.code });
  return true;
}

function webhookUrl(): string {
  return `${config.publicUrl}/api/webhooks/signal_bots`;
}

function exitJson(secret: string): object {
  return {
    secret,
    action: "sell",
    symbol: "{{ticker}}",
    dedupe_key: "{{timenow}}",
  };
}

function tradingViewSetup(): object {
  return {
    webhookUrl: webhookUrl(),
    alertCondition: "Exit alerts only — Platform is the sole BUY authority",
    message: "{{alert_message}}",
    note:
      "Direct TradingView BUY alerts are disabled. Exposure-reducing SELL alerts remain available.",
  };
}

/**
 * A webhook secret is the ONLY authentication on the order-placing endpoint:
 * anyone holding it can cause real Binance Spot orders on this account. It must
 * not be handed out casually.
 *
 * `mapBot` used to attach `entryWebhookJson` and `exitWebhookJson` — both
 * containing the plaintext secret — to every bot in the list response, which
 * the dashboard polls every 15 seconds. The frontend never read those fields
 * from the list. So the secret was broadcast hundreds of times an hour, into
 * every proxy log and browser cache along the way, for nothing.
 *
 * Now: the list masks it. The single-bot endpoint serves it only when the
 * caller explicitly asks (`GET /api/bots/:id?reveal=1`), which is what the
 * Reveal control in the UI does.
 */
function mapBot(
  b: Awaited<ReturnType<typeof prisma.signalBot.findMany>>[0],
  extra?: Record<string, unknown>,
  opts: { reveal?: boolean } = {}
) {
  const reveal = opts.reveal === true;
  const { webhookSecret, ...rest } = b;
  return {
    ...rest,
    pairs: JSON.parse(b.pairs) as string[],
    maxInvestmentLabel: formatInvestmentLabel(b.maxInvestmentPct, b.maxInvestmentUnit),
    webhookUrl: webhookUrl(),
    webhookSecret: reveal ? webhookSecret : maskSecret(webhookSecret),
    secretRevealed: reveal,
    // The ready-to-paste TradingView payloads embed the secret, so they exist
    // only in a revealed response.
    ...(reveal
      ? {
          exitWebhookJson: exitJson(webhookSecret),
        }
      : {}),
    tradingViewSetup: tradingViewSetup(),
    ...extra,
  };
}

botsRouter.get("/", async (_req, res) => {
  const bots = await prisma.signalBot.findMany({
    orderBy: { createdAt: "desc" },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });

  const enriched = await Promise.all(
    bots.map(async (b) => {
      // BUG-08: firstTrade moved inside Promise.all — was sequential, causing N+1 latency
      const [activeTrades, closedTrades, signalCount, firstTrade] = await Promise.all([
        prisma.smartTrade.count({ where: { botId: b.id, status: "active" } }),
        prisma.smartTrade.findMany({
          where: { botId: b.id, status: "closed" },
          select: { pnlUsdt: true, quoteSpent: true, createdAt: true, closedAt: true },
        }),
        prisma.webhookLog.count({ where: { botId: b.id } }),
        prisma.smartTrade.findFirst({
          where: { botId: b.id },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        }),
      ]);

      const totalProfit = sumMoney(closedTrades.map((t) => t.pnlUsdt));
      const activeSmartTrades = activeTrades;

      return mapBot(b, {
        totalProfit,
        activeSmartTrades,
        signalCount,
        tradingSince: firstTrade?.createdAt ?? b.createdAt,
      });
    })
  );

  res.json(enriched);
});

botsRouter.get("/stats", async (_req, res) => {
  res.json(await readBotStats());
});

botsRouter.get("/meta/units", (_req, res) => {
  res.json(INVESTMENT_UNITS);
});

botsRouter.get("/:id", async (req, res) => {
  const bot = await prisma.signalBot.findUnique({
    where: { id: req.params.id },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  if (!bot) return res.status(404).json({ error: "Not found" });
  // The secret is served only on an explicit request, which is what the
  // dashboard's Reveal control sends. Routine reads get the masked form.
  const reveal = req.query.reveal === "1" || req.query.reveal === "true";
  if (reveal) {
    console.warn(`[audit] webhook secret revealed for bot ${bot.id}`);
  }
  res.json(mapBot(bot, undefined, { reveal }));
});

botsRouter.post("/", asyncHandler(async (req, res) => {
  let bot;
  try {
    bot = await createBot(parseBotCreate(req.body));
  } catch (error) {
    if (sendRefusal(res, error)) return;
    throw error;
  }
  const withAccount = await prisma.signalBot.findUniqueOrThrow({
    where: { id: bot.id },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  // The creation response is the one place the secret is genuinely needed
  // unprompted: it is the only moment the operator has to copy it out.
  res.status(201).json(
    mapBot(
      withAccount,
      {
        totalProfit: 0,
        activeSmartTrades: 0,
        signalCount: 0,
        tradingSince: withAccount.createdAt,
      },
      { reveal: true }
    )
  );
}));

botsRouter.patch("/:id", asyncHandler(async (req, res) => {
  /*
   * Shared with C12: X5 guards (no account change or pair removal under an
   * open trade), tightened validation for every changed value, and the
   * cross-field rules against the MERGED configuration — a request that only
   * turns `stopLossEnabled` off cannot rebuild BOT-003 one field at a time.
   */
  try {
    await updateBot(String(req.params.id), parseBotPatch(req.body));
  } catch (error) {
    if (sendRefusal(res, error)) return;
    throw error;
  }
  const bot = await prisma.signalBot.findUniqueOrThrow({
    where: { id: String(req.params.id) },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  res.json(mapBot(bot));
}));

/**
 * Put a bot in a TARGET state — not a toggle, so a retried or doubled request
 * converges instead of cancelling itself out (contract C5).
 *
 * One conditional write: it changes the row only when the status differs, and
 * reports whether it did. `null` means no such bot.
 */
export async function setBotStatus(
  id: string, status: "active" | "paused"
): Promise<{ changed: boolean } | null> {
  const updated = await prisma.signalBot.updateMany({
    where: { id, status: { not: status } },
    data: { status },
  });
  if (updated.count === 1) return { changed: true };
  const exists = await prisma.signalBot.findUnique({ where: { id }, select: { id: true } });
  return exists ? { changed: false } : null;
}

botsRouter.delete("/:id", asyncHandler(async (req, res) => {
  // Finding 0.7 / review A1: shared with C13 (`deleteBotGuarded`).
  const outcome = await deleteBotGuarded(String(req.params.id));
  if (!outcome.deleted) {
    res.status(outcome.status).json({ error: outcome.error, code: outcome.code });
    return;
  }
  res.status(204).send();
}));

botsRouter.post("/:id/toggle", async (req, res) => {
  const bot = await prisma.signalBot.findUnique({ where: { id: req.params.id } });
  if (!bot) return res.status(404).json({ error: "Not found" });
  const next = bot.status === "active" ? "paused" : "active";
  const updated = await prisma.signalBot.update({
    where: { id: bot.id },
    data: { status: next },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  res.json(mapBot(updated));
});
