import { Router } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { formatInvestmentLabel, INVESTMENT_UNITS } from "../lib/investment.js";
import { sumMoney } from "../lib/money.js";

export const botsRouter = Router();

const investmentUnitSchema = z.enum([
  "pct_bot",
  "pct_trade",
  "usdt_bot",
  "usdt_trade",
]);

/**
 * The position-size fraction above which a stop loss stops being optional.
 *
 * BOT-003: the shipped defaults were `maxInvestmentPct: 100` with
 * `entryVolumePct: 100` and every exit control off, which turns the entire free
 * USDT balance into one spot position with no automated exit path. Defaults are
 * fixed below; this constant is the API-level refusal that stops the same
 * configuration being rebuilt by hand.
 */
export const UNPROTECTED_SIZE_LIMIT_PCT = 50;

const botBaseSchema = z.object({
  name: z.string().min(1),
  alertType: z.enum(["custom", "tradingview"]).default("custom"),
  /*
   * BOT-012: "short" and "reversal" were accepted, stored, and offered in the
   * UI with no caveat, while `binance.ts` hardcodes BUY and SELL and the
   * value's only backend consumer is a cosmetic label. A user could configure
   * a short bot, watch it accept signals, and get long positions. Contrast
   * `entryOrderType`, whose unimplemented "limit" state IS warned about in the
   * form.
   *
   * Only "long" is accepted until shorts actually exist. The database column
   * keeps any existing value readable.
   */
  direction: z.literal("long").default("long"),
  pairs: z.array(z.string()).min(1),
  maxInvestmentPct: z.number().min(0.01).max(10000),
  maxInvestmentUnit: investmentUnitSchema.default("pct_bot"),
  exchangeAccountId: z.string().optional().nullable(),
  entryEnabled: z.boolean().default(true),
  entryVolumePct: z.number().min(1).max(100).default(100),
  entryOrderType: z.enum(["market", "limit"]).default("market"),
  // BOT-015: defaulted false, so a default bot rejected every exit webhook.
  exitEnabled: z.boolean().default(true),
  takeProfitEnabled: z.boolean().default(false),
  takeProfitPct: z.number().positive().max(1000).optional().nullable(),
  // BOT-003: defaulted false, leaving the position unbounded.
  stopLossEnabled: z.boolean().default(true),
  stopLossPct: z.number().positive().max(100).optional().nullable(),
  maxEntryOrders: z.number().int().min(1).optional().nullable(),
  maxActiveSmartTradesEnabled: z.boolean().default(false),
  maxActiveSmartTrades: z.number().int().min(1).optional().nullable(),
});

/**
 * The cross-field safety rules, applied to a COMPLETE configuration.
 *
 * Split out from the object schema so a PATCH can be checked against the merged
 * result rather than against the patch alone — otherwise a request that only
 * turns `stopLossEnabled` off would pass, and BOT-003's configuration could be
 * rebuilt one field at a time.
 */
export function assertSafeBotConfig(b: {
  maxInvestmentPct: number;
  maxInvestmentUnit: string;
  entryVolumePct: number;
  stopLossEnabled: boolean;
  stopLossPct?: number | null;
  takeProfitEnabled: boolean;
  takeProfitPct?: number | null;
}): string | null {
  const isPct = b.maxInvestmentUnit === "pct_bot" || b.maxInvestmentUnit === "pct_trade";
  if (isPct) {
    const effective = (b.maxInvestmentPct * b.entryVolumePct) / 100;
    if (effective >= UNPROTECTED_SIZE_LIMIT_PCT && !b.stopLossEnabled) {
      return (
        `A position of ${UNPROTECTED_SIZE_LIMIT_PCT}% of the balance or more requires a ` +
        "stop loss. Either enable stopLossEnabled or reduce maxInvestmentPct / entryVolumePct."
      );
    }
  }
  if (b.stopLossEnabled && (b.stopLossPct ?? 0) <= 0) {
    return "stopLossPct must be greater than 0 when a stop loss is enabled";
  }
  if (b.takeProfitEnabled && (b.takeProfitPct ?? 0) <= 0) {
    return "takeProfitPct must be greater than 0 when a take profit is enabled";
  }
  return null;
}

const botSchema = botBaseSchema
  .refine((b) => assertSafeBotConfig(b) === null, (b) => ({
    message: assertSafeBotConfig(b) ?? "invalid configuration",
    path: ["stopLossEnabled"],
  }));

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
  const active = await prisma.smartTrade.findMany({ where: { status: "active" } });
  const upnl = sumMoney(active.map((t) => t.pnlUsdt));
  const locked = sumMoney(active.map((t) => t.quoteSpent));
  const activeCount = active.length;
  const closedCount = await prisma.smartTrade.count({ where: { status: "closed" } });
  const botCount = await prisma.signalBot.count();
  const activeBotCount = await prisma.signalBot.count({ where: { status: "active" } });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayClosed = await prisma.smartTrade.findMany({
    where: { status: "closed", closedAt: { gte: todayStart } },
  });
  const todayPnl = sumMoney(todayClosed.map((t) => t.pnlUsdt));
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
  let body: Partial<z.infer<typeof botBaseSchema>>;
  try {
    body = botBaseSchema.partial().parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
    }
    return res.status(400).json({ error: "Invalid request body" });
  }
  /*
   * The cross-field rules are checked against the MERGED configuration, not the
   * patch. A request that only turns `stopLossEnabled` off would otherwise
   * pass, and BOT-003's unprotected-full-balance configuration could be rebuilt
   * one field at a time.
   */
  const merged = {
    maxInvestmentPct: body.maxInvestmentPct ?? existing.maxInvestmentPct,
    maxInvestmentUnit: body.maxInvestmentUnit ?? existing.maxInvestmentUnit,
    entryVolumePct: body.entryVolumePct ?? existing.entryVolumePct,
    stopLossEnabled: body.stopLossEnabled ?? existing.stopLossEnabled,
    stopLossPct: body.stopLossPct ?? existing.stopLossPct,
    takeProfitEnabled: body.takeProfitEnabled ?? existing.takeProfitEnabled,
    takeProfitPct: body.takeProfitPct ?? existing.takeProfitPct,
  };
  const unsafe = assertSafeBotConfig(merged);
  if (unsafe) return res.status(400).json({ error: unsafe });

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
