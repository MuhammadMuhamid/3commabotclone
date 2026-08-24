import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { formatInvestmentLabel, INVESTMENT_UNITS } from "../lib/investment.js";

export const botsRouter = Router();

const investmentUnitSchema = z.enum([
  "pct_bot",
  "pct_trade",
  "usdt_bot",
  "usdt_trade",
]);

const botSchema = z.object({
  name: z.string().min(1),
  alertType: z.enum(["custom", "tradingview"]).default("custom"),
  direction: z.enum(["long", "short", "reversal"]).default("long"),
  pairs: z.array(z.string()).min(1),
  maxInvestmentPct: z.number().min(0.01).max(10000),
  maxInvestmentUnit: investmentUnitSchema.default("pct_bot"),
  exchangeAccountId: z.string().optional().nullable(),
  entryEnabled: z.boolean().default(true),
  entryVolumePct: z.number().min(1).max(100).default(100),
  entryOrderType: z.enum(["market", "limit"]).default("market"),
  exitEnabled: z.boolean().default(false),
  takeProfitEnabled: z.boolean().default(false),
  takeProfitPct: z.number().optional().nullable(),
  stopLossEnabled: z.boolean().default(false),
  stopLossPct: z.number().optional().nullable(),
  maxEntryOrders: z.number().optional().nullable(),
  maxActiveSmartTradesEnabled: z.boolean().default(false),
  maxActiveSmartTrades: z.number().int().min(1).optional().nullable(),
});

function webhookUrl(): string {
  return `${config.publicUrl}/api/webhooks/signal_bots`;
}

function entryJson(secret: string): object {
  return {
    secret,
    action: "{{strategy.order.action}}",
    symbol: "{{ticker}}",
    quote_order_qty: null,
    dedupe_key: "{{timenow}}",
  };
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
    alertCondition: "SR+Trend v5 → alert() function calls only",
    message: "{{alert_message}}",
    note:
      "Do not use Order fills and alert() — duplicates every signal. Exits use Pine longJustClosed + alert(). See deploy/TRADINGVIEW-ALERT-FIX-DOUBLE.md",
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
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
}

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
          entryWebhookJson: entryJson(webhookSecret),
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

      const totalProfit = closedTrades.reduce((s, t) => s + t.pnlUsdt, 0);
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
  const active = await prisma.smartTrade.findMany({ where: { status: "active" } });
  const upnl = active.reduce((s, t) => s + t.pnlUsdt, 0);
  const locked = active.reduce((s, t) => s + t.quoteSpent, 0);
  const activeCount = active.length;
  const closedCount = await prisma.smartTrade.count({ where: { status: "closed" } });
  const botCount = await prisma.signalBot.count();
  const activeBotCount = await prisma.signalBot.count({ where: { status: "active" } });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayClosed = await prisma.smartTrade.findMany({
    where: { status: "closed", closedAt: { gte: todayStart } },
  });
  const todayPnl = todayClosed.reduce((s, t) => s + t.pnlUsdt, 0);
  res.json({
    upnl,
    locked,
    activeCount,
    closedCount,
    todayPnl,
    botCount,
    activeBotCount,
    stoppedBotCount: botCount - activeBotCount,
  });
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

botsRouter.post("/", async (req, res) => {
  // BUG-10: Catch ZodError (validation) and Prisma errors with a structured JSON response
  let body: ReturnType<typeof botSchema.parse>;
  try {
    body = botSchema.parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    return res.status(400).json({ error: "Invalid request body" });
  }
  const secret = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "").slice(0, 16);
  const bot = await prisma.signalBot.create({
    data: {
      name: body.name,
      alertType: body.alertType,
      direction: body.direction,
      pairs: JSON.stringify(body.pairs.map((p) => p.toUpperCase().replace(/\//g, ""))),
      maxInvestmentPct: body.maxInvestmentPct,
      maxInvestmentUnit: body.maxInvestmentUnit,
      exchangeAccountId: body.exchangeAccountId ?? null,
      entryEnabled: body.entryEnabled,
      entryVolumePct: body.entryVolumePct,
      entryOrderType: body.entryOrderType,
      exitEnabled: body.exitEnabled,
      takeProfitEnabled: body.takeProfitEnabled,
      takeProfitPct: body.takeProfitPct,
      stopLossEnabled: body.stopLossEnabled,
      stopLossPct: body.stopLossPct,
      maxEntryOrders: body.maxEntryOrders,
      maxActiveSmartTradesEnabled: body.maxActiveSmartTradesEnabled,
      maxActiveSmartTrades: body.maxActiveSmartTradesEnabled
        ? body.maxActiveSmartTrades ?? 2
        : null,
      webhookSecret: secret,
    },
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  // The creation response is the one place the secret is genuinely needed
  // unprompted: it is the only moment the operator has to copy it out.
  res.status(201).json(
    mapBot(
      bot,
      {
        totalProfit: 0,
        activeSmartTrades: 0,
        signalCount: 0,
        tradingSince: bot.createdAt,
      },
      { reveal: true }
    )
  );
});

botsRouter.patch("/:id", async (req, res) => {
  const existing = await prisma.signalBot.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });

  // BUG-10: Catch ZodError with a structured 400 response
  let body: Partial<z.infer<typeof botSchema>>;
  try {
    body = botSchema.partial().parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { pairs, maxActiveSmartTradesEnabled, maxActiveSmartTrades, ...rest } = body;
  const data: Record<string, unknown> = { ...rest };

  // BUG-13: Coerce empty string exchangeAccountId to null — prevents storing "" as a FK
  if ("exchangeAccountId" in data && data.exchangeAccountId === "") {
    data.exchangeAccountId = null;
  }

  if (pairs) {
    data.pairs = JSON.stringify(pairs.map((p) => p.toUpperCase().replace(/\//g, "")));
  }
  if (maxActiveSmartTradesEnabled !== undefined) {
    data.maxActiveSmartTradesEnabled = maxActiveSmartTradesEnabled;
    data.maxActiveSmartTrades = maxActiveSmartTradesEnabled
      ? (maxActiveSmartTrades ?? existing.maxActiveSmartTrades ?? 2)
      : null;
  } else if (maxActiveSmartTrades !== undefined) {
    data.maxActiveSmartTrades = maxActiveSmartTrades;
  }

  const bot = await prisma.signalBot.update({
    where: { id: req.params.id },
    data,
    include: { exchangeAccount: { select: { id: true, name: true } } },
  });
  res.json(mapBot(bot));
});

botsRouter.delete("/:id", async (req, res) => {
  // F5: Deleting a bot now nullifies SmartTrade.botId (onDelete: SetNull) so
  // historical trade data is preserved. botName on each trade retains the name.
  await prisma.signalBot.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

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
