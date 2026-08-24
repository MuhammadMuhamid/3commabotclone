/**
 * Operator control surface for the execution bot: the kill switch, the
 * account-level risk limits, and an honest status read.
 *
 * `BOT-011`: there was no way to halt trading short of pausing each bot
 * individually, and no account-level view of exposure or realised loss at all.
 * `BOT-034`: starting a bot had no confirmation while every other
 * money-touching action did, and live-versus-dry-run was invisible outside the
 * dashboard.
 *
 * Mounted behind `requireAuth`, like every other non-webhook route.
 *
 * The two write routes require an explicit confirmation string. Halting is the
 * safe direction and needs a reason; resuming re-arms real order flow and is
 * deliberately harder.
 */
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import {
  describeBotRiskState, getBotRiskLimits, readBotRiskSnapshot,
  setBotTradingHalted, updateBotRiskLimits,
} from "../services/riskControls.js";
import { EXCHANGE_STOPS_STATUS, exchangeStopsEnabled } from "../services/exchangeStops.js";
import { asyncHandler } from "../middleware/errors.js";
import { prisma } from "../lib/prisma.js";

export const operationsRouter = Router();

const HALT_CONFIRMATION = "HALT_TRADING";
const RESUME_CONFIRMATION = "RESUME_TRADING";

/**
 * The one screen an operator needs.
 *
 * `mode` is the honest three-state answer: DRY_RUN means nothing reaches the
 * exchange, HALTED means orders are refused, LIVE means a webhook will place a
 * real order. It was previously only inferable from `/api/config`.
 */
operationsRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const limits = await getBotRiskLimits();
    const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
    const [activeBots, pausedBots, accounts] = await Promise.all([
      prisma.signalBot.count({ where: { status: "active" } }),
      prisma.signalBot.count({ where: { status: { not: "active" } } }),
      // Names and the testnet flag only. No key material leaves this process.
      prisma.exchangeAccount.findMany({
        select: { id: true, name: true, testnet: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    res.json({
      mode: config.dryRun ? "DRY_RUN" : limits.tradingHalted ? "HALTED" : "LIVE",
      dryRun: config.dryRun,
      risk: { ...limits, snapshot, summary: describeBotRiskState(limits, snapshot) },
      bots: { active: activeBots, paused: pausedBots },
      protectiveOrders: {
        enabled: exchangeStopsEnabled(),
        status: EXCHANGE_STOPS_STATUS,
        /*
         * Stated plainly rather than implied. Until an exchange-side stop
         * exists, protection is a 30-second in-process poll: a position is
         * COMPLETELY unprotected during any downtime, and a gap through the
         * stop is filled at the next tick rather than at the stop (BOT-017).
         */
        note:
          exchangeStopsEnabled()
            ? "Exchange-side protective orders are ENABLED. Verify the testnet checks in services/exchangeStops.ts were completed."
            : "Protection is a 30-second in-process poll only. Open positions are unprotected while this process is down.",
      },
      /*
       * WHICH BINANCE will an order actually reach?
       *
       * There are two answers and they are not the same one: `BINANCE_TESTNET`
       * is the process-wide default used when a bot has no exchange account of
       * its own, and each stored account carries its OWN flag. An operator
       * reading only the first could believe every order is on testnet while an
       * account overrides it to mainnet.
       *
       * Nothing here contacts Binance. This is configuration, reported.
       */
      exchange: {
        envTestnet: config.binanceTestnet,
        accounts: accounts.map((a) => ({ id: a.id, name: a.name, testnet: a.testnet })),
        mixed: accounts.some((a) => a.testnet !== config.binanceTestnet),
        note: accounts.length === 0
          ? `No exchange account is stored. Orders would use the process default: ${
              config.binanceTestnet ? "TESTNET" : "MAINNET"}.`
          : accounts.some((a) => a.testnet !== config.binanceTestnet)
            ? "An account's testnet setting DISAGREES with the process default. A bot uses "
              + "its own account's setting, so some orders go to a different Binance from others."
            : `Every account matches the process default: ${
                config.binanceTestnet ? "TESTNET" : "MAINNET"}.`,
      },
      time: new Date().toISOString(),
    });
  })
);

operationsRouter.post(
  "/halt",
  asyncHandler(async (req, res) => {
    const schema = z.object({
      confirmation: z.literal(HALT_CONFIRMATION, {
        errorMap: () => ({ message: `confirmation must be exactly "${HALT_CONFIRMATION}"` }),
      }),
      reason: z.string().trim().min(3, "a reason is required, so the halt is explicable later"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    await setBotTradingHalted(true, { reason: parsed.data.reason, by: "operator" });
    console.error(`[risk] TRADING HALTED by operator: ${parsed.data.reason}`);
    res.json({ halted: true, reason: parsed.data.reason });
  })
);

operationsRouter.post(
  "/resume",
  asyncHandler(async (req, res) => {
    const schema = z.object({
      confirmation: z.literal(RESUME_CONFIRMATION, {
        errorMap: () => ({ message: `confirmation must be exactly "${RESUME_CONFIRMATION}"` }),
      }),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }

    const before = await getBotRiskLimits();
    if (!before.tradingHalted) {
      res.json({ halted: false, note: "trading was not halted" });
      return;
    }

    // A latched daily-loss halt is re-checked against live numbers: resuming
    // straight back into a breached limit would trip again on the next entry.
    if (before.haltedBy === "daily_loss" && before.maxDailyLossQuote !== null) {
      const snapshot = await readBotRiskSnapshot(before.dailyLossWindowHours);
      const loss = -Math.min(0, snapshot.realisedPnlInWindow);
      if (loss >= before.maxDailyLossQuote) {
        res.status(409).json({
          error:
            `refusing to resume: the rolling ${before.dailyLossWindowHours}h loss ` +
            `${loss.toFixed(2)} still meets the limit ${before.maxDailyLossQuote.toFixed(2)}. ` +
            "Raise the limit deliberately, or wait for the window to roll.",
        });
        return;
      }
    }

    await setBotTradingHalted(false);
    console.warn(`[risk] trading RESUMED by operator (was: ${before.haltedReason ?? "no reason"})`);
    res.json({ halted: false, previousReason: before.haltedReason });
  })
);

operationsRouter.patch(
  "/risk-limits",
  asyncHandler(async (req, res) => {
    const optional = z.number().nonnegative().nullable().optional();
    const schema = z.object({
      maxTotalExposureQuote: optional,
      maxConcurrentTrades: z.number().int().nonnegative().nullable().optional(),
      maxDailyLossQuote: optional,
      dailyLossWindowHours: z.number().int().min(1).max(720).optional(),
    }).strict();
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    await updateBotRiskLimits(parsed.data);
    res.json(await getBotRiskLimits());
  })
);
