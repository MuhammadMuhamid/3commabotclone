/**
 * The Platform's signed operator controls — contract v1.2, C0–C8.
 *
 * Mounted at `/control` on `manualTradingRouter`, AFTER `requireManualAuth`,
 * so every request here carries the same HMAC over method, path, timestamp,
 * nonce, request id and body, the same ±60 s freshness window and the same
 * single-use nonce as a manual order. `/control/*` is control plane: it stays
 * available when MANUAL_TRADING_ENABLED is false (`isManualControlPlanePath`),
 * exactly like the Shariah floor.
 *
 * Rules every route here keeps:
 *   - request bodies are zod `.strict()`; every POST/PATCH carries `actor`,
 *     a claim signed by the Platform's key (who stepped up, how, when);
 *   - path ids are validated before any lookup;
 *   - every mutating command runs through `runControlCommand`: claimed once
 *     per request id, never re-run, replayed from its stored result;
 *   - business refusals are typed (`{error, code}`); anything else is a
 *     masked 500;
 *   - no request body is ever logged.
 *
 * Money paths are reused, never re-implemented: halt/resume are the shared
 * `riskControls` functions the dashboard uses, and Close/Partial are the
 * shared `tradeExit` functions the dashboard uses.
 */
import { Router, type Request, type Response } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  describeBotRiskState, getBotRiskLimits, haltBotTrading, readBotHaltState, readBotRiskSnapshot,
  resumeBotTrading, updateBotRiskLimits,
} from "../services/riskControls.js";
import { readBotOperationalStatus } from "../services/operationalStatus.js";
import { readInstallationShariahMode } from "../services/shariah.js";
import { exchangeStopsEnabled } from "../services/exchangeStops.js";
import { listBotViewBots } from "../services/botView.js";
import { closeStrategyTrade, partialCloseStrategyTrade } from "../services/tradeExit.js";
import {
  ControlRefusal, readControlCommand, runControlCommand,
  type ControlActor, type ControlContext, type ControlKind,
} from "../services/controlCommands.js";
import { countUnresolvedBotIntents, setBotStatus } from "./bots.js";

export const manualControlRouter = Router();

/** The halt policy, stated once, in the words the contract requires (F2). */
export const BOT_HALT_POLICY =
  "While the Bot is halted, TP/SL protection is not checked and TradingView exits are refused; " +
  "your own SELL / Close / Partial still work.";

/** `startInterval("tpsl", 30_000, …)` in index.ts. */
const TPSL_POLL_INTERVAL_SEC = 30;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const idSchema = z.string().uuid();

const actorSchema = z.object({
  platformUserId: z.string().uuid(),
  stepUp: z.object({
    method: z.enum(["totp", "password"]),
    at: z.string().datetime(),
  }).strict(),
}).strict();

const haltSchema = z.object({
  confirmation: z.literal("HALT_TRADING"),
  reason: z.string().trim().min(3).max(200),
  actor: actorSchema,
}).strict();

const resumeSchema = z.object({
  confirmation: z.literal("RESUME_TRADING"),
  actor: actorSchema,
}).strict();

// The same bounds as the dashboard's `PATCH /api/ops/risk-limits`.
const limitAmount = z.number().finite().nonnegative().nullable().optional();
const riskLimitsSchema = z.object({
  maxTotalExposureQuote: limitAmount,
  maxConcurrentTrades: z.number().int().nonnegative().nullable().optional(),
  maxDailyLossQuote: limitAmount,
  dailyLossWindowHours: z.number().int().min(1).max(720).optional(),
  actor: actorSchema,
}).strict().refine((v) =>
  v.maxTotalExposureQuote !== undefined || v.maxConcurrentTrades !== undefined ||
  v.maxDailyLossQuote !== undefined || v.dailyLossWindowHours !== undefined, {
  message: "provide at least one limit to change",
});

const botStatusSchema = z.object({
  status: z.enum(["active", "paused"]),
  actor: actorSchema,
}).strict();

const closeSchema = z.object({ actor: actorSchema }).strict();

const partialSchema = z.object({
  pct: z.number().int().min(1).max(99),
  actor: actorSchema,
}).strict();

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

/** Parse a body, or answer 400 with a code and return null. */
function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    refuse(res, 400, "invalid_request", parsed.error.errors[0]?.message ?? "invalid request body");
    return null;
  }
  return parsed.data as z.infer<T>;
}

function pathId(req: Request, res: Response): string | null {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) { refuse(res, 400, "invalid_id", "the id in the path is not a valid id"); return null; }
  return parsed.data;
}

async function runAndSend(
  req: Request, res: Response,
  command: { kind: ControlKind; target: string; params: unknown; actor: ControlActor },
  action: (ctx: ControlContext) => Promise<{ httpStatus?: number; body: unknown }>
): Promise<void> {
  const outcome = await runControlCommand(
    { requestId: String(res.locals.manualRequestId ?? ""), ...command }, action);
  if (outcome.replayed) res.setHeader("x-control-replayed", "true");
  res.status(outcome.httpStatus).json(outcome.body);
}

async function readRiskState() {
  const limits = await getBotRiskLimits();
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
  return {
    limits,
    snapshot,
    summary: describeBotRiskState(limits, snapshot),
    // Only a daily-loss halt latches; Resume re-checks it against live numbers.
    latched: limits.tradingHalted && limits.haltedBy === "daily_loss",
  };
}

// ── C0 GET /status ──────────────────────────────────────────────────────────

/**
 * Everything the Platform's Operations page needs, read from durable state.
 * Contacts no exchange and returns no credential. `dryRun` and `halt` are
 * independent fields: a dry-run Bot can be halted, and `operational.execution.
 * mode` (DRY_RUN outranks HALTED) must not be read as the halt.
 */
export async function readControlStatus() {
  const [operational, halt, risk, accounts, activeBots, pausedBots, shariah] = await Promise.all([
    readBotOperationalStatus(),
    readBotHaltState(),
    readRiskState(),
    prisma.exchangeAccount.findMany({ select: { testnet: true } }),
    prisma.signalBot.count({ where: { status: "active" } }),
    prisma.signalBot.count({ where: { status: { not: "active" } } }),
    readInstallationShariahMode(),
  ]);
  const testnet = accounts.filter((a) => a.testnet).length;
  const mainnet = accounts.length - testnet;
  // Where an order could actually go: every stored account's own network,
  // plus the process default — but only when process-default credentials
  // exist, since a bot without an account cannot trade otherwise.
  const routes = new Set<"TESTNET" | "MAINNET">();
  if (testnet > 0) routes.add("TESTNET");
  if (mainnet > 0) routes.add("MAINNET");
  if (config.binanceApiKey && config.binanceApiSecret) {
    routes.add(config.binanceTestnet ? "TESTNET" : "MAINNET");
  }
  const routing = routes.size === 0 ? "NONE" : routes.size > 1 ? "MIXED" : [...routes][0]!;

  return {
    operational,
    dryRun: config.dryRun,
    halt: {
      halted: halt.halted,
      haltedBy: halt.haltedBy,
      haltedReason: halt.haltedReason,
      haltedAt: halt.haltedAt?.toISOString() ?? null,
    },
    exchange: {
      defaultTestnet: config.binanceTestnet,
      accounts: { testnet, mainnet },
      routing,
    },
    risk,
    bots: { active: activeBots, paused: pausedBots },
    protection: {
      mode: "in_process_poll",
      intervalSec: TPSL_POLL_INTERVAL_SEC,
      exchangeResting: false,
      note:
        `Take-profit and stop-loss are checked by a ${TPSL_POLL_INTERVAL_SEC}-second poll inside the ` +
        "Bot process; no protective order rests at the exchange, so open positions are " +
        "unprotected while the Bot is down." +
        (exchangeStopsEnabled()
          ? " EXCHANGE_STOPS_ENABLED is set, but no code path places an exchange-side stop."
          : "") +
        (halt.halted ? ` ${BOT_HALT_POLICY}` : ""),
    },
    shariahFloor: { mode: shariah.mode, policyVersion: shariah.policyVersion },
    manual: { enabled: config.manualTradingEnabled, mainnetEnabled: config.mainnetManualTradingEnabled },
    version: operational.service.version,
    time: new Date().toISOString(),
  };
}

manualControlRouter.get("/status", asyncHandler(async (_req, res) => {
  res.json(await readControlStatus());
}));

// ── C1 POST /halt ───────────────────────────────────────────────────────────

manualControlRouter.post("/halt", asyncHandler(async (req, res) => {
  const body = parseBody(haltSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "halt", target: "bot",
    params: { confirmation: body.confirmation, reason: body.reason }, actor: body.actor,
  }, async () => {
    // Never replaces an existing halt (finding 0.3): a daily-loss latch keeps
    // its source, so Resume still re-checks it.
    const { alreadyHalted, state } = await haltBotTrading({ reason: body.reason, by: "operator" });
    if (!alreadyHalted) console.error("[risk] TRADING HALTED by the Platform control channel");
    return { body: {
      halted: true,
      haltedBy: state.haltedBy,
      haltedReason: state.haltedReason,
      haltedAt: state.haltedAt?.toISOString() ?? null,
      alreadyHalted,
    } };
  });
}));

// ── C2 POST /resume ─────────────────────────────────────────────────────────

manualControlRouter.post("/resume", asyncHandler(async (req, res) => {
  const body = parseBody(resumeSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "resume", target: "bot", params: { confirmation: body.confirmation }, actor: body.actor,
  }, async () => {
    const outcome = await resumeBotTrading();
    if (!outcome.ok) throw new ControlRefusal(409, outcome.code, outcome.message);
    if (outcome.wasHalted) console.warn("[risk] trading RESUMED by the Platform control channel");
    return { body: {
      halted: false,
      wasHalted: outcome.wasHalted,
      previousHaltedBy: outcome.previousHaltedBy,
      previousReason: outcome.previousReason,
    } };
  });
}));

// ── C3 GET / C4 PATCH /risk-limits ──────────────────────────────────────────

manualControlRouter.get("/risk-limits", asyncHandler(async (_req, res) => {
  res.json(await readRiskState());
}));

manualControlRouter.patch("/risk-limits", asyncHandler(async (req, res) => {
  const body = parseBody(riskLimitsSchema, req, res);
  if (!body) return;
  // Only the fields actually sent, so the stored parameters are exactly what
  // was signed (F10) and an omitted limit is left alone.
  const patch: {
    maxTotalExposureQuote?: number | null; maxConcurrentTrades?: number | null;
    maxDailyLossQuote?: number | null; dailyLossWindowHours?: number;
  } = {};
  if (body.maxTotalExposureQuote !== undefined) patch.maxTotalExposureQuote = body.maxTotalExposureQuote;
  if (body.maxConcurrentTrades !== undefined) patch.maxConcurrentTrades = body.maxConcurrentTrades;
  if (body.maxDailyLossQuote !== undefined) patch.maxDailyLossQuote = body.maxDailyLossQuote;
  if (body.dailyLossWindowHours !== undefined) patch.dailyLossWindowHours = body.dailyLossWindowHours;
  await runAndSend(req, res, { kind: "risk_limits", target: "risk", params: patch, actor: body.actor },
    async () => {
      await updateBotRiskLimits(patch);
      const state = await readRiskState();
      return { body: {
        ...state,
        latchCleared: false,
        note: state.latched
          ? "Limits updated. The daily-loss halt is still in force: changing a limit never lifts a " +
            "halt. Raising or disabling the daily-loss limit makes it resumable with Resume."
          : "Limits updated. Changing a limit never lifts an existing halt.",
      } };
    });
}));

// ── C5 POST /bots/:id/status ────────────────────────────────────────────────

manualControlRouter.post("/bots/:id/status", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(botStatusSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "bot_status", target: `bot:${id}`, params: { status: body.status }, actor: body.actor,
  }, async () => {
    const changed = await setBotStatus(id, body.status);
    if (!changed) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
    // The masked projection the Platform already reads (no webhook secret).
    const bot = (await listBotViewBots()).find((b) => b.id === id);
    if (!bot) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
    return { body: {
      ...bot,
      changed: changed.changed,
      // Starting a bot lets the intent reconciler act on these (contract Adv).
      unresolvedIntents: await countUnresolvedBotIntents(id),
    } };
  });
}));

// ── C6 POST /trades/:id/close ───────────────────────────────────────────────

manualControlRouter.post("/trades/:id/close", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(closeSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, { kind: "trade_close", target: `trade:${id}`, params: {}, actor: body.actor },
    // R1: the reserved intent is written onto the command row before the
    // order is sent, so a crash still leaves C8 a pointer to the live order.
    async (ctx) => ({ body: await closeStrategyTrade(id, {
      onIntentReserved: (intentId) => ctx.recordOrderRef({ intentId }),
    }) }));
}));

// ── C7 POST /trades/:id/partial-close ───────────────────────────────────────

manualControlRouter.post("/trades/:id/partial-close", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(partialSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "trade_partial_close", target: `trade:${id}`, params: { pct: body.pct }, actor: body.actor,
  }, async (ctx) => ({ body: await partialCloseStrategyTrade(id, body.pct, {
    onAttemptOpened: (attemptId) => ctx.recordOrderRef({ attemptId }),
  }) }));
}));

// ── C8 GET /commands/:requestId ─────────────────────────────────────────────

manualControlRouter.get("/commands/:requestId", asyncHandler(async (req, res) => {
  const requestId = String(req.params.requestId ?? "");
  if (!REQUEST_ID_RE.test(requestId)) {
    refuse(res, 400, "invalid_request_id", "the request id must match ^[A-Za-z0-9_-]{16,128}$");
    return;
  }
  const command = await readControlCommand(requestId);
  if (!command) { refuse(res, 404, "command_not_found", "No command with this request id."); return; }
  res.json(command);
}));

// ── F9: its own rate limits ─────────────────────────────────────────────────

/**
 * The control channel's limiters, separate from the 120/min `apiLimiter` that
 * manual trading and the Platform's read views share, so that traffic cannot
 * starve a halt. Reads (status, command polling) and writes have separate
 * budgets for the same reason: polling must not starve a halt either.
 *
 * A 429 here is answered BEFORE the router runs, so it is definitive — the
 * command was not executed — and carries `code: "bot_rate_limited"`.
 */
export function createControlRateLimiters(
  opts: { windowMs?: number; readMax?: number; writeMax?: number } = {}
): RateLimitRequestHandler[] {
  const base = {
    windowMs: opts.windowMs ?? 60_000,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many Bot control requests; nothing was executed. Retry shortly.",
      code: "bot_rate_limited",
    },
  } as const;
  const isRead = (req: Request) => req.method === "GET" || req.method === "HEAD";
  return [
    rateLimit({ ...base, max: opts.readMax ?? 120, skip: (req) => !isRead(req) }),
    rateLimit({ ...base, max: opts.writeMax ?? 60, skip: (req) => isRead(req) }),
  ];
}
