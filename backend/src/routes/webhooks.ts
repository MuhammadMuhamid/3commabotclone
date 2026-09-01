import { Router } from "express";
import { processWebhook } from "../services/webhook.js";
import {
  operationalStatusSchema, positionStatusSchema, strategyExecutionEvidenceSchema, webhookSchema,
} from "./webhookSchema.js";
import { httpStatusFor, isReceiverOutcome } from "../contract/webhookContract.js";
import { readBotOperationalStatusForSecret } from "../services/operationalStatus.js";
import { asyncHandler } from "../middleware/errors.js";
import { readStrategyExecutionEvidence } from "../services/executionEvidence.js";

export const webhooksRouter = Router();

/**
 * Small account-level operational contract for the platform. The existing
 * webhook secret is sufficient trust: its holder can already place real
 * orders, while this endpoint is read-only and returns no account identifiers,
 * key material, stored secret, token, or exchange response.
 */
export const operationalStatusHandler = asyncHandler(async (req, res) => {
  const parsed = operationalStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid operations status request" });
  const status = await readBotOperationalStatusForSecret(parsed.data.secret);
  if (!status) return res.status(401).json({ error: "Invalid secret" });
  return res.json(status);
});

/** Read one exact persisted strategy intent; this never invokes reconciliation or Binance. */
export const strategyExecutionEvidenceHandler = asyncHandler(async (req, res) => {
  const parsed = strategyExecutionEvidenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid strategy evidence lookup" });
  const result = await readStrategyExecutionEvidence({
    secret: parsed.data.secret,
    symbol: parsed.data.symbol,
    side: parsed.data.action,
    dedupeKey: parsed.data.dedupe_key,
  });
  if (!result.authenticated) return res.status(401).json({ error: "Invalid secret" });
  if (!result.evidence) return res.status(404).json({ error: "Strategy order intent not found" });
  return res.json(result.evidence);
});

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
    /*
     * X-12: three different meanings used to share HTTP 200, and the sender's
     * success test was `res.ok`. `ignored_stale_sell` in particular means NO
     * order was placed and the receiver is STILL LONG — so a sender that
     * ignores the body must fail safe, which means a non-2xx.
     *
     * `ok` and `ignored_duplicate` stay 200: a duplicate implies the original
     * order landed, so it is genuinely a success from the sender's view.
     */
    const status = isReceiverOutcome(result.status) ? httpStatusFor(result.status) : 200;
    res.status(status).json(result);
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
