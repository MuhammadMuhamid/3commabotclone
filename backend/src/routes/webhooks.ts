import { Router } from "express";
import { processWebhook } from "../services/webhook.js";
import { positionStatusSchema, webhookSchema } from "./webhookSchema.js";

export const webhooksRouter = Router();

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
