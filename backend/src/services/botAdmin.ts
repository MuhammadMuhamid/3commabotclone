/**
 * Bot configuration administration, shared by the Classic dashboard
 * (`routes/bots.ts`, JWT) and the Platform's signed control commands
 * (`routes/manualControlManage.ts`, C10–C14). One implementation, so a guard
 * added for one caller protects the other.
 *
 * Validation has two layers:
 *   - the STORAGE bounds (`botBaseSchema`), unchanged, which every stored bot
 *     already satisfies;
 *   - the TIGHTENED rules (parity inventory §5: name length, pair shape,
 *     per-unit investment bounds, market-only entries, an existing account),
 *     applied to every value a caller sets. On an edit a supplied value equal
 *     to the stored one is not re-judged, so a bot that was valid when it was
 *     created always stays editable (B-SLICE2 C12).
 *
 * Every refusal is a typed `ControlRefusal` (`{status, code, message}`).
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma, type SignalBot } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { formatInvestmentLabel } from "../lib/investment.js";
import { platformWebhookIdentity } from "../contract/realizationEventContract.js";
import { ControlRefusal } from "./controlCommands.js";

/**
 * The position-size fraction above which a stop loss stops being optional.
 *
 * BOT-003: the shipped defaults were `maxInvestmentPct: 100` with
 * `entryVolumePct: 100` and every exit control off, which turns the entire free
 * USDT balance into one spot position with no automated exit path. This is the
 * API-level refusal that stops the same configuration being rebuilt by hand.
 */
export const UNPROTECTED_SIZE_LIMIT_PCT = 50;

export const WEBHOOK_PATH = "/api/webhooks/signal_bots";

export const investmentUnitSchema = z.enum(["pct_bot", "pct_trade", "usdt_bot", "usdt_trade"]);

/** The storage bounds every stored bot satisfies (the pre-Slice-2 schema). */
export const botBaseSchema = z.object({
  name: z.string().min(1),
  alertType: z.enum(["custom", "tradingview"]).default("custom"),
  /*
   * BOT-012: only "long" is accepted until shorts actually exist. The
   * database column keeps any existing value readable.
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

export type BotCreateInput = z.infer<typeof botBaseSchema>;
export type BotPatchInput = Partial<z.infer<typeof botBaseSchema>>;

// ── Tightened rules (parity inventory §5 #5, #6, #7, #9) ────────────────────

export const BOT_NAME_MAX = 64;
export const PAIR_RE = /^[A-Z0-9]{2,20}(USDT|USDC)$/;
export const MAX_PAIRS = 50;
/** A percentage unit means "of the balance": more than 100 % is meaningless. */
export const MAX_PCT_INVESTMENT = 100;
export const MAX_USDT_INVESTMENT = 10_000_000;

const isPctUnit = (unit: string) => unit === "pct_bot" || unit === "pct_trade";

/** The stored spelling of a pair: upper case, no separator. */
export function normalizePair(pair: string): string {
  return pair.trim().toUpperCase().replace(/\//g, "");
}

function normalizePairs(pairs: string[]): string[] {
  return [...new Set(pairs.map(normalizePair))];
}

function invalid(message: string): ControlRefusal {
  return new ControlRefusal(400, "invalid_request", message);
}

/**
 * Review fix 6: SQLite reports a concurrent writer inside an interactive
 * transaction as a write conflict, a lock timeout or "database is locked".
 * Those are retryable and nothing was written, so they become one typed 409
 * instead of a masked 500.
 */
export function isTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2028", "P1008"].includes(error.code)) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError
      || error instanceof Prisma.PrismaClientUnknownRequestError) {
    return /database is locked|SQLITE_BUSY|write conflict|deadlock/i.test(error.message);
  }
  return false;
}

export const BOT_BUSY_MESSAGE =
  "This bot changed while the request ran (another write was in progress); nothing was changed. Retry.";

/** Rethrow a transaction conflict as the typed 409; anything else unchanged. */
function rethrowConflict(error: unknown): never {
  if (isTransactionConflict(error)) throw new ControlRefusal(409, "bot_busy_retry", BOT_BUSY_MESSAGE);
  throw error;
}

function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > BOT_NAME_MAX) {
    throw invalid(`name must be 1 to ${BOT_NAME_MAX} characters`);
  }
  return trimmed;
}

function checkNewPairs(pairs: string[]): void {
  for (const pair of pairs) {
    if (!PAIR_RE.test(pair)) {
      throw invalid("each pair must be a Binance Spot symbol quoted in USDT or USDC, e.g. BTCUSDT");
    }
  }
}

function checkInvestment(amount: number, unit: string): void {
  const max = isPctUnit(unit) ? MAX_PCT_INVESTMENT : MAX_USDT_INVESTMENT;
  if (!(amount >= 0.01 && amount <= max)) {
    throw invalid(isPctUnit(unit)
      ? `maxInvestmentPct must be between 0.01 and ${MAX_PCT_INVESTMENT} for a percentage unit`
      : `maxInvestmentPct must be between 0.01 and ${MAX_USDT_INVESTMENT} USDT`);
  }
}

function checkEntryOrderType(type: string): void {
  if (type !== "market") {
    throw invalid("entryOrderType must be \"market\": limit entries are not implemented");
  }
}

async function checkAccountExists(id: string | null | undefined): Promise<void> {
  if (!id) return;
  const account = await prisma.exchangeAccount.findUnique({ where: { id }, select: { id: true } });
  if (!account) throw new ControlRefusal(404, "account_not_found", "That exchange account does not exist.");
}

/**
 * The cross-field safety rules, applied to a COMPLETE configuration.
 *
 * Split out from the object schema so a PATCH is checked against the merged
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
  if (isPctUnit(b.maxInvestmentUnit)) {
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

/** Parse a body against the storage schema (optionally strict), as a typed 400. */
export function parseBotCreate(raw: unknown, opts: { strict?: boolean } = {}): BotCreateInput {
  const schema = opts.strict ? botBaseSchema.strict() : botBaseSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.errors[0]?.message ?? "Invalid input");
  return parsed.data;
}

export function parseBotPatch(raw: unknown, opts: { strict?: boolean } = {}): BotPatchInput {
  const partial = botBaseSchema.partial();
  const schema = opts.strict ? partial.strict() : partial;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.errors[0]?.message ?? "Invalid input");
  return parsed.data;
}

/** 48 hex characters, as before: a uuid's hex plus 16 more random hex digits. */
export function generateWebhookSecret(): string {
  return randomBytes(24).toString("hex");
}

// ── Create ──────────────────────────────────────────────────────────────────

/**
 * Create a bot. Every field is judged by the tightened rules (nothing is
 * stored yet, so nothing is grandfathered). Returns the row, secret included:
 * the caller decides who may see it (the live create answer only).
 */
export async function createBot(input: BotCreateInput): Promise<SignalBot> {
  const name = checkName(input.name);
  const pairs = normalizePairs(input.pairs);
  if (pairs.length < 1) throw invalid("select at least one trading pair");
  if (pairs.length > MAX_PAIRS) throw invalid(`at most ${MAX_PAIRS} pairs per bot`);
  checkNewPairs(pairs);
  checkInvestment(input.maxInvestmentPct, input.maxInvestmentUnit);
  checkEntryOrderType(input.entryOrderType);
  const unsafe = assertSafeBotConfig(input);
  if (unsafe) throw invalid(unsafe);
  const exchangeAccountId = input.exchangeAccountId || null;
  await checkAccountExists(exchangeAccountId);

  return prisma.signalBot.create({ data: {
    name,
    alertType: input.alertType,
    direction: input.direction,
    pairs: JSON.stringify(pairs),
    maxInvestmentPct: input.maxInvestmentPct,
    maxInvestmentUnit: input.maxInvestmentUnit,
    exchangeAccountId,
    entryEnabled: input.entryEnabled,
    entryVolumePct: input.entryVolumePct,
    entryOrderType: input.entryOrderType,
    exitEnabled: input.exitEnabled,
    takeProfitEnabled: input.takeProfitEnabled,
    takeProfitPct: input.takeProfitPct,
    stopLossEnabled: input.stopLossEnabled,
    stopLossPct: input.stopLossPct,
    maxEntryOrders: input.maxEntryOrders,
    maxActiveSmartTradesEnabled: input.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: input.maxActiveSmartTradesEnabled ? input.maxActiveSmartTrades ?? 2 : null,
    webhookSecret: generateWebhookSecret(),
  } });
}

// ── Update (X5) ─────────────────────────────────────────────────────────────

/** The strategy-intent states that may still reach, or already be at, the exchange. */
export const UNRESOLVED_INTENT_STATUSES = ["requested", "submitted"];

/** Unresolved strategy order intents for one bot (requested or submitted). */
export function countUnresolvedBotIntents(botId: string): Promise<number> {
  return prisma.strategyOrderIntent.count({
    where: { botId, status: { in: UNRESOLVED_INTENT_STATUSES } },
  });
}

function storedPairs(bot: Pick<SignalBot, "pairs">): string[] {
  try {
    const parsed = JSON.parse(bot.pairs) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const has = <K extends string>(o: object, k: K): boolean => Object.prototype.hasOwnProperty.call(o, k)
  && (o as Record<string, unknown>)[k] !== undefined;

/**
 * Edit a bot (Classic PATCH and C12).
 *
 * X5 (trace §0): the strategy TP/SL poller and webhook SELLs resolve the
 * exchange account from the bot's CURRENT row, so moving a bot to another
 * account while it holds a position would send its exit to another wallet;
 * and removing a pair makes Close refuse `pair_not_listed`. So:
 *   - changing `exchangeAccountId` while the bot has an active trade or an
 *     unresolved intent → 409 `bot_has_open_trades`;
 *   - removing a pair that has an active trade (or an unresolved intent) →
 *     409 `pair_has_open_trades`.
 * The write is conditional on the same facts inside one transaction, so a
 * trade opened after the checks cannot slip through.
 */
export async function updateBot(id: string, body: BotPatchInput): Promise<SignalBot> {
  const existing = await prisma.signalBot.findUnique({ where: { id } });
  if (!existing) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");

  const data: Record<string, unknown> = {};

  // name: trimmed and bounded when it changes.
  if (has(body, "name") && body.name !== existing.name) data.name = checkName(body.name!);

  // pairs: new symbols must have the tightened shape; kept symbols are grandfathered.
  const beforePairs = storedPairs(existing);
  let removedPairs: string[] = [];
  if (has(body, "pairs")) {
    const next = normalizePairs(body.pairs!);
    if (next.length < 1) throw invalid("select at least one trading pair");
    if (next.length > Math.max(MAX_PAIRS, beforePairs.length)) {
      throw invalid(`at most ${MAX_PAIRS} pairs per bot`);
    }
    checkNewPairs(next.filter((p) => !beforePairs.includes(p)));
    removedPairs = beforePairs.filter((p) => !next.includes(p));
    data.pairs = JSON.stringify(next);
  }

  // investment: re-judged when the amount or its unit changes.
  const amount = has(body, "maxInvestmentPct") ? body.maxInvestmentPct! : existing.maxInvestmentPct;
  const unit = has(body, "maxInvestmentUnit") ? body.maxInvestmentUnit! : existing.maxInvestmentUnit;
  if (amount !== existing.maxInvestmentPct || unit !== existing.maxInvestmentUnit) {
    checkInvestment(amount, unit);
  }

  if (has(body, "entryOrderType") && body.entryOrderType !== existing.entryOrderType) {
    checkEntryOrderType(body.entryOrderType!);
  }

  // exchange account: "" means none (BUG-13); a new one must exist.
  let accountChanged = false;
  if (has(body, "exchangeAccountId")) {
    const next = body.exchangeAccountId || null;
    accountChanged = next !== (existing.exchangeAccountId ?? null);
    if (accountChanged) await checkAccountExists(next);
    data.exchangeAccountId = next;
  }

  /*
   * The cross-field rules, against the MERGED configuration. `null` is a
   * value here, not an absence: a patch that sets `stopLossPct: null` while
   * the stop stays enabled must be judged with the null (it used to fall back
   * to the stored distance, pass, and store an enabled stop with no distance).
   */
  const pick = <K extends keyof BotPatchInput & keyof SignalBot>(k: K) =>
    (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined ? body[k] : existing[k]);
  const unsafe = assertSafeBotConfig({
    maxInvestmentPct: amount,
    maxInvestmentUnit: unit,
    entryVolumePct: pick("entryVolumePct") as number,
    stopLossEnabled: pick("stopLossEnabled") as boolean,
    stopLossPct: pick("stopLossPct") as number | null,
    takeProfitEnabled: pick("takeProfitEnabled") as boolean,
    takeProfitPct: pick("takeProfitPct") as number | null,
  });
  if (unsafe) throw invalid(unsafe);

  for (const key of ["alertType", "direction", "maxInvestmentPct", "maxInvestmentUnit", "entryEnabled",
    "entryVolumePct", "entryOrderType", "exitEnabled", "takeProfitEnabled", "takeProfitPct",
    "stopLossEnabled", "stopLossPct", "maxEntryOrders"] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) data[key] = body[key];
  }
  if (body.maxActiveSmartTradesEnabled !== undefined) {
    data.maxActiveSmartTradesEnabled = body.maxActiveSmartTradesEnabled;
    data.maxActiveSmartTrades = body.maxActiveSmartTradesEnabled
      ? (body.maxActiveSmartTrades ?? existing.maxActiveSmartTrades ?? 2)
      : null;
  } else if (body.maxActiveSmartTrades !== undefined) {
    data.maxActiveSmartTrades = body.maxActiveSmartTrades;
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (accountChanged) {
        const [active, unresolved] = await Promise.all([
          tx.smartTrade.count({ where: { botId: id, status: "active" } }),
          tx.strategyOrderIntent.count({ where: { botId: id, status: { in: UNRESOLVED_INTENT_STATUSES } } }),
        ]);
        if (active > 0 || unresolved > 0) {
          throw new ControlRefusal(409, "bot_has_open_trades",
            `Cannot change the exchange account: this bot has ${active} active trade(s) and ` +
            `${unresolved} order(s) still being reconciled. Their exits must go to the account ` +
            "that holds them. Close them (or let them settle) first.");
        }
      }
      if (removedPairs.length > 0) {
        const [active, unresolved] = await Promise.all([
          tx.smartTrade.count({ where: { botId: id, status: "active", pair: { in: removedPairs } } }),
          tx.strategyOrderIntent.count({ where: {
            botId: id, symbol: { in: removedPairs }, status: { in: UNRESOLVED_INTENT_STATUSES },
          } }),
        ]);
        if (active > 0 || unresolved > 0) {
          throw new ControlRefusal(409, "pair_has_open_trades",
            `Cannot remove ${removedPairs.join(", ")}: this bot has ${active} active trade(s) or ` +
            `${unresolved} unresolved order(s) on it. Close them first; removing the pair would ` +
            "make them unclosable from here.");
        }
      }
      // Conditional on the same facts, so a trade opened since the counts loses.
      const guard = accountChanged
        ? { smartTrades: { none: { status: "active" } } }
        : removedPairs.length > 0
          ? { smartTrades: { none: { status: "active", pair: { in: removedPairs } } } }
          : {};
      const updated = await tx.signalBot.updateMany({ where: { id, ...guard }, data });
      if (updated.count !== 1) {
        const still = await tx.signalBot.findUnique({ where: { id }, select: { id: true } });
        if (!still) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
        throw new ControlRefusal(409, accountChanged ? "bot_has_open_trades" : "pair_has_open_trades",
          "A trade was opened while this edit was being applied; nothing was changed. Retry after it closes.");
      }
      return tx.signalBot.findUniqueOrThrow({ where: { id } });
    });
  } catch (error) {
    rethrowConflict(error);
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

export type DeleteBotOutcome =
  | { deleted: true }
  | { deleted: false; status: 404 | 409; code: string; error: string };

const openTradesRefusal = (n: number): DeleteBotOutcome => ({
  deleted: false, status: 409, code: "bot_has_open_trades",
  error: `Cannot delete: this bot has ${n} active trade(s). Close them first, ` +
    "or they would lose take-profit/stop-loss protection and could no longer be closed here.",
});

/**
 * Delete a bot only when nothing is left in flight (finding 0.7, review A1).
 *
 * Deleting sets `SmartTrade.botId` to null; a bot-less trade is skipped by the
 * TP/SL monitor and cannot be closed from here. One conditional statement
 * matches only while the bot has NO active trade, and the intent check runs in
 * the same transaction (intents carry a bare `botId`, not a relation).
 */
export async function deleteBotGuarded(id: string): Promise<DeleteBotOutcome> {
  try {
    return await prisma.$transaction(async (tx): Promise<DeleteBotOutcome> => {
      const activeTrades = await tx.smartTrade.count({ where: { botId: id, status: "active" } });
      if (activeTrades > 0) return openTradesRefusal(activeTrades);
      const unresolvedIntents = await tx.strategyOrderIntent.count({
        where: { botId: id, status: { in: UNRESOLVED_INTENT_STATUSES } },
      });
      if (unresolvedIntents > 0) {
        return {
          deleted: false, status: 409, code: "bot_has_unresolved_intents",
          error: `Cannot delete: this bot has ${unresolvedIntents} order(s) whose exchange outcome ` +
            "is still being reconciled. Wait for them to settle, then delete.",
        };
      }
      const removed = await tx.signalBot.deleteMany({
        where: { id, smartTrades: { none: { status: "active" } } },
      });
      if (removed.count === 1) return { deleted: true };
      const exists = await tx.signalBot.findUnique({ where: { id }, select: { id: true } });
      if (!exists) return { deleted: false, status: 404, code: "bot_not_found", error: "Not found" };
      return openTradesRefusal(await tx.smartTrade.count({ where: { botId: id, status: "active" } }));
    });
  } catch (error) {
    if (isTransactionConflict(error)) return { deleted: false, status: 409, code: "bot_busy_retry", error: BOT_BUSY_MESSAGE };
    throw error;
  }
}

// ── Rotate the webhook secret (X6) ──────────────────────────────────────────

/**
 * Replace a bot's webhook secret.
 *
 * X6 (trace §0): the Platform resolves realization provenance by hashing the
 * deployment's CURRENT secret. A SELL intent created under the old secret, or
 * a realization event still waiting to be delivered under it, would then fail
 * ingestion and stall the whole outbox. So rotation is refused (409
 * `realizations_pending`) while the bot has an unresolved SELL intent, or a
 * pending realization event carries the current secret's identity.
 */
export async function rotateWebhookSecret(id: string): Promise<SignalBot> {
  // Review fix 2: the counts and the compare-and-set are ONE transaction, so
  // a SELL reserved under the old secret cannot slip in between them (on
  // SQLite the concurrent writer waits or fails rather than interleaving).
  try {
    return await prisma.$transaction(async (tx) => {
      const bot = await tx.signalBot.findUnique({ where: { id } });
      if (!bot) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
      const unresolvedSells = await tx.strategyOrderIntent.count({ where: {
        botId: id, side: "SELL", status: { in: UNRESOLVED_INTENT_STATUSES },
      } });
      const pendingEvents = await tx.realizationEvent.count({ where: {
        deliveryStatus: "pending", payload: { contains: platformWebhookIdentity(bot.webhookSecret) },
      } });
      if (unresolvedSells > 0 || pendingEvents > 0) {
        throw new ControlRefusal(409, "realizations_pending",
          `Cannot rotate yet: ${unresolvedSells} exit order(s) are still being reconciled and ` +
          `${pendingEvents} realization(s) are waiting to reach Trading Scene under the current ` +
          "secret. Rotating now would break their provenance. Retry once they settle.");
      }
      // Compare-and-set on the old secret: a concurrent rotation cannot be lost silently.
      const updated = await tx.signalBot.updateMany({
        where: { id, webhookSecret: bot.webhookSecret },
        data: { webhookSecret: generateWebhookSecret() },
      });
      if (updated.count !== 1) {
        throw new ControlRefusal(409, "rotation_conflict",
          "The secret changed while this rotation ran; nothing further was changed. Read the bot again.");
      }
      return tx.signalBot.findUniqueOrThrow({ where: { id } });
    });
  } catch (error) {
    rethrowConflict(error);
  }
}

// ── The control-plane projection ───────────────────────────────────────────

/**
 * Review fix 7: the control-plane view (stored in command results for replay
 * and C8) carries only the last four characters — enough to recognise a
 * secret, nothing of the rest. The Classic dashboard keeps `maskSecret`.
 */
export function maskSecretLast4(secret: string): string {
  return secret.length > 4 ? `••••${secret.slice(-4)}` : "••••";
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "*".repeat(secret.length);
  return `${secret.slice(0, 4)}${"*".repeat(secret.length - 8)}${secret.slice(-4)}`;
}

export interface BotConfigView {
  id: string;
  name: string;
  status: string;
  alertType: string;
  direction: string;
  pairs: string[];
  maxInvestmentPct: number;
  maxInvestmentUnit: string;
  maxInvestmentLabel: string;
  entryEnabled: boolean;
  entryVolumePct: number;
  entryOrderType: string;
  exitEnabled: boolean;
  /** null = take profit disabled. */
  takeProfitPct: number | null;
  /** null = stop loss disabled. */
  stopLossPct: number | null;
  maxEntryOrders: number | null;
  maxActiveSmartTradesEnabled: boolean;
  maxActiveSmartTrades: number | null;
  exchangeAccountId: string | null;
  exchangeAccount: { id: string; name: string; testnet: boolean } | null;
  webhookSecretMasked: string;
  webhookPath: string;
  activeTrades: number;
  unresolvedIntents: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The bot as the Platform sees it (B-SLICE2 `BotConfigView`). Built field by
 * field, so the webhook secret can only ever appear masked.
 */
export async function getBotConfigView(id: string): Promise<BotConfigView | null> {
  const bot = await prisma.signalBot.findUnique({
    where: { id },
    include: { exchangeAccount: { select: { id: true, name: true, testnet: true } } },
  });
  if (!bot) return null;
  const [activeTrades, unresolvedIntents] = await Promise.all([
    prisma.smartTrade.count({ where: { botId: id, status: "active" } }),
    countUnresolvedBotIntents(id),
  ]);
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    alertType: bot.alertType,
    direction: bot.direction,
    pairs: storedPairs(bot),
    maxInvestmentPct: bot.maxInvestmentPct,
    maxInvestmentUnit: bot.maxInvestmentUnit,
    maxInvestmentLabel: formatInvestmentLabel(bot.maxInvestmentPct, bot.maxInvestmentUnit),
    entryEnabled: bot.entryEnabled,
    entryVolumePct: bot.entryVolumePct,
    entryOrderType: bot.entryOrderType,
    exitEnabled: bot.exitEnabled,
    takeProfitPct: bot.takeProfitEnabled ? bot.takeProfitPct ?? null : null,
    stopLossPct: bot.stopLossEnabled ? bot.stopLossPct ?? null : null,
    maxEntryOrders: bot.maxEntryOrders ?? null,
    maxActiveSmartTradesEnabled: bot.maxActiveSmartTradesEnabled,
    maxActiveSmartTrades: bot.maxActiveSmartTradesEnabled ? bot.maxActiveSmartTrades ?? null : null,
    exchangeAccountId: bot.exchangeAccountId ?? null,
    exchangeAccount: bot.exchangeAccount
      ? { id: bot.exchangeAccount.id, name: bot.exchangeAccount.name, testnet: bot.exchangeAccount.testnet }
      : null,
    webhookSecretMasked: maskSecretLast4(bot.webhookSecret),
    webhookPath: WEBHOOK_PATH,
    activeTrades,
    unresolvedIntents,
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}
