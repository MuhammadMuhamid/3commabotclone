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
  describeBotRiskState, getBotRiskLimits, haltBotTrading, readBotRiskSnapshot, readEntriesStatus,
  resumeBotTrading, setEntriesPaused, updateBotRiskLimits,
} from "../services/riskControls.js";
import { cancelWorkingEntryLimits, manualAdapterSeam } from "../services/manualTrading.js";
import { EXCHANGE_STOPS_STATUS, exchangeStopsEnabled } from "../services/exchangeStops.js";
import { asyncHandler } from "../middleware/errors.js";
import { prisma } from "../lib/prisma.js";

export const operationsRouter = Router();

const HALT_CONFIRMATION = "HALT_TRADING";
const RESUME_CONFIRMATION = "RESUME_TRADING";

/**
 * The one screen an operator needs.
 *
 * `mode` is the three-state answer: DRY_RUN means nothing reaches the
 * exchange, HALTED means the automation is stopped in both directions (signals,
 * TradingView exits and the TP/SL monitors) while the operator's own exits —
 * Close, Partial, manual SELL — still pass, LIVE means a webhook will place a
 * real order. DRY_RUN outranks HALTED in `mode`, so the halt itself is read from
 * `risk.tradingHalted`, which a dry run does not mask (finding 0.4).
 */
operationsRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const limits = await getBotRiskLimits();
    const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
    const [activeBots, pausedBots, accounts, entries] = await Promise.all([
      prisma.signalBot.count({ where: { status: "active" } }),
      prisma.signalBot.count({ where: { status: { not: "active" } } }),
      // Names and the testnet flag only. No key material leaves this process.
      prisma.exchangeAccount.findMany({
        select: { id: true, name: true, testnet: true },
        orderBy: { createdAt: "asc" },
      }),
      readEntriesStatus(),
    ]);

    res.json({
      mode: config.dryRun ? "DRY_RUN" : limits.tradingHalted ? "HALTED" : "LIVE",
      dryRun: config.dryRun,
      risk: { ...limits, snapshot, summary: describeBotRiskState(limits, snapshot) },
      // OD-3: the entries pause, independent of the halt (and of `mode`).
      entries,
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
        /*
         * ── The flag does not place anything, and this said it did ─────────
         *
         * `placeProtection` and `cancelProtection` in `services/exchangeStops.ts`
         * have ZERO call sites in this service. Setting EXCHANGE_STOPS_ENABLED
         * therefore changes one status string and nothing else: protection
         * remains the 30-second in-process poll either way, which is exactly
         * the during-downtime gap the module's own header enumerates.
         *
         * An operator reading "ENABLED" under pressure concludes their open
         * positions are protected at the exchange and will survive this process
         * dying. They are not and will not. A false safety claim is worse than
         * an absent one, so the flag is now reported as ARMED BUT NOT WIRED and
         * the unprotected-while-down sentence is said in BOTH states — it is
         * true in both.
         */
        wired: false,
        note:
          exchangeStopsEnabled()
            ? "EXCHANGE_STOPS_ENABLED is set, but no code path in this service places or "
              + "cancels an exchange-side protective order — the flag arms a capability that "
              + "is not wired up. Protection is a 30-second in-process poll only, and open "
              + "positions are unprotected while this process is down."
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
    // Finding 0.3: an existing halt — above all a daily-loss latch — is kept
    // and reported, never replaced, so resume still judges the original halt.
    const { alreadyHalted, state } = await haltBotTrading({ reason: parsed.data.reason, by: "operator" });
    if (alreadyHalted) {
      console.warn(`[risk] halt requested while already halted (${state.haltedBy ?? "unknown"}); kept`);
    } else {
      console.error(`[risk] TRADING HALTED by operator: ${parsed.data.reason}`);
    }
    res.json({
      halted: true, alreadyHalted,
      haltedBy: state.haltedBy, reason: state.haltedReason,
      haltedAt: state.haltedAt?.toISOString() ?? null,
    });
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

    // The same implementation the Platform's signed resume uses, so the two
    // can never disagree about when a latched halt may be lifted.
    const outcome = await resumeBotTrading();
    if (!outcome.ok) {
      res.status(409).json({ error: outcome.message, code: outcome.code });
      return;
    }
    if (!outcome.wasHalted) {
      res.json({ halted: false, note: "trading was not halted" });
      return;
    }
    console.warn(`[risk] trading RESUMED by operator (was: ${outcome.previousReason ?? "no reason"})`);
    res.json({
      halted: false, previousHaltedBy: outcome.previousHaltedBy, previousReason: outcome.previousReason,
    });
  })
);

/**
 * OD-3 break-glass parity with the Platform's signed C9: pause or resume NEW
 * ENTRIES as a target state, never touching the halt. Pausing needs a reason;
 * `cancelWorkingEntries` (explicit opt-in) also cancels each manual LIMIT BUY
 * still working at the exchange and reports every outcome. The audit line is
 * a `console.warn`, as for reveal; the body is never logged.
 */
operationsRouter.post(
  "/entries",
  asyncHandler(async (req, res) => {
    const schema = z.discriminatedUnion("paused", [
      z.object({
        paused: z.literal(true),
        reason: z.string().trim().min(3, "a reason is required, so the pause is explicable later").max(200),
        cancelWorkingEntries: z.boolean().optional(),
      }).strict(),
      z.object({ paused: z.literal(false) }).strict(),
    ]);
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const by = `dashboard:${String(res.locals.userId ?? "unknown")}`;
    const body = parsed.data;
    const { changed, state } = body.paused
      ? await setEntriesPaused({ paused: true, reason: body.reason, by })
      : await setEntriesPaused({ paused: false, by });
    if (changed) console.warn(`[risk] new entries ${body.paused ? "PAUSED" : "RESUMED"} by ${by}`);
    const canceledEntries = body.paused && body.cancelWorkingEntries
      ? await cancelWorkingEntryLimits(manualAdapterSeam.factory) : undefined;
    res.json({
      entries: {
        paused: state.paused, pausedAt: state.pausedAt?.toISOString() ?? null,
        pausedBy: state.pausedBy, reason: state.reason,
      },
      changed,
      ...(canceledEntries ? { canceledEntries } : {}),
    });
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
