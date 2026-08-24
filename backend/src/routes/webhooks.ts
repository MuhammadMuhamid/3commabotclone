import { Router } from "express";
import { processWebhook } from "../services/webhook.js";
import { z } from "zod";

export const webhooksRouter = Router();

const positionStatusSchema = z.object({
  secret: z.string().min(32).max(256),
  symbols: z.array(z.string().min(3).max(40)).min(1).max(100),
}).strict();

/**
 * Authenticated position-state endpoint for the local strategy runner.
 * Returns only whether each requested/allowed symbol has an active SmartTrade;
 * quantities, credentials and account balances are deliberately not exposed.
 */
webhooksRouter.post("/signal_bots/status", async (req, res) => {
  const parsed = positionStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status request" });
  const { prisma } = await import("../lib/prisma.js");
  const bot = await prisma.signalBot.findUnique({
    where: { webhookSecret: parsed.data.secret },
    select: { id: true, status: true, pairs: true },
  });
  if (!bot) return res.status(401).json({ error: "Invalid secret" });
  if (bot.status !== "active") return res.status(404).json({ error: "Bot is not active" });
  const allowed = new Set((JSON.parse(bot.pairs) as string[]).map((s) => s.toUpperCase().replace(/\//g, "")));
  const symbols = [...new Set(parsed.data.symbols.map((s) => s.toUpperCase().replace(/\//g, "")))]
    .filter((s) => allowed.has(s));
  const active = await prisma.smartTrade.findMany({
    where: { botId: bot.id, status: "active", pair: { in: symbols } },
    select: { pair: true },
  });
  const activeSet = new Set(active.map((t) => t.pair.toUpperCase().replace(/\//g, "")));
  res.json({
    status: "ok",
    positions: Object.fromEntries(symbols.map((symbol) => [symbol, activeSet.has(symbol) ? "long" : "flat"])),
  });
});

const webhookSchema = z.object({
  secret: z.string().min(32).max(256),
  action: z.string().min(1).max(40),
  symbol: z.string().min(3).max(40).optional(),
  tv_instrument: z.string().min(3).max(40).optional(),
  quote_order_qty: z.number().finite().positive().max(1_000_000).nullable().optional(),
  quantity: z.number().finite().positive().max(1_000_000_000).nullable().optional(),
  sell_percent: z.number().finite().positive().lt(100).nullable().optional(),
  exit_leg: z.enum(["tp1", "tp2", "runner", "stop", "signal"]).optional(),
  dedupe_key: z.string().min(1).max(256).optional(),
}).strict()
  .refine((b) => Boolean(b.symbol || b.tv_instrument), {
    message: "symbol or tv_instrument required",
  })
  .refine((b) => !(b.sell_percent != null && b.quantity != null), {
    message: "Use either sell_percent or quantity, not both",
  })
  .refine((b) => b.sell_percent == null || b.action.toLowerCase().includes("sell") || b.action.toLowerCase().includes("exit") || b.action.toLowerCase().includes("close"), {
    message: "sell_percent is valid only for sell/exit actions",
  });

webhooksRouter.post("/signal_bots", async (req, res) => {
  try {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid webhook payload" });
    }
    const result = await processWebhook(parsed.data);
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Webhook error";
    const code =
      msg.includes("secret") || msg.includes("Invalid secret")
        ? 401                                              // auth failure
        : msg.includes("not active") || msg.includes("not found")
          ? 404                                            // bot not found / inactive
          : msg.includes("disabled") || msg.includes("not allowed") || msg.includes("Max active") || msg.includes("Max entry")
            ? 422                                          // bot config prevents this action
            : msg.includes("Cannot decrypt") || msg.includes("Exchange account") || msg.includes("Binance")
              ? 503                                        // upstream exchange error
              : 400;                                       // bad request / validation
    // Do not expose exchange/provider internals to unauthenticated callers.
    res.status(code).json({ error: code === 503 ? "Exchange request failed" : msg });
  }
});
