/**
 * WS-BOTCMD — the Platform's signed operator controls, contract v1.2 C0–C8.
 *
 * Every request below goes over loopback HTTP through the real
 * `manualTradingRouter`, signed exactly as the Platform signs it (the scheme
 * is written out here, not imported, so this is a contract test). Manual
 * trading stays DISABLED for the whole file: `/control/*` is control plane.
 *
 * No network beyond 127.0.0.1, no Binance: order paths run against an
 * in-process fake exchange, and every assertion about "an order" counts what
 * reached that fake.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { SignalBot, SmartTrade } from "@prisma/client";
import type { BinanceClient } from "../src/services/binance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".bot-control-test.db");
process.env.DATABASE_URL = "file:./tests/.bot-control-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { tradesRouter } = await import("../src/routes/trades.js");
const { createControlRateLimiters, BOT_HALT_POLICY } = await import("../src/routes/manualControl.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const {
  canonicalJson, canonicalPath, signManualRequest, verifyManualRequest,
} = await import("../src/services/manualAuth.js");
const { tradeExchangeClient } = await import("../src/services/tradeExit.js");
const { controlCommandHash } = await import("../src/services/controlCommands.js");
const { processWebhook, tradeEventKey } = await import("../src/services/webhook.js");
const { getBotRiskLimits, setBotTradingHalted } = await import("../src/services/riskControls.js");
const { heldLockCount } = await import("../src/lib/tradeCloseLock.js");
const { __clearCloseMarkCache } = await import("../src/lib/tradeCloseTracker.js");

const CONTROL_SECRET = "7c1e" + "b".repeat(60);
const original = {
  dryRun: config.dryRun,
  manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret,
  binanceTestnet: config.binanceTestnet,
  apiKey: config.binanceApiKey,
  apiSecret: config.binanceApiSecret,
};
const originalResolve = tradeExchangeClient.resolve;

config.manualTradingEnabled = false; // the whole file: control plane only
config.manualTradingHmacSecret = CONTROL_SECRET;
config.binanceApiKey = "";
config.binanceApiSecret = "";

let server: Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  app.use("/api/trades", tradesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config, {
    dryRun: original.dryRun, manualTradingEnabled: original.manualTradingEnabled,
    manualTradingHmacSecret: original.secret, binanceTestnet: original.binanceTestnet,
    binanceApiKey: original.apiKey, binanceApiSecret: original.apiSecret,
  });
  tradeExchangeClient.resolve = originalResolve;
  tradeExchangeClient.closeFactory = null;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  config.dryRun = true;
  config.binanceTestnet = original.binanceTestnet;
  tradeExchangeClient.resolve = originalResolve;
  tradeExchangeClient.closeFactory = null;
  await prisma.botControlCommand.deleteMany();
  await prisma.realizationEvent.deleteMany();
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.webhookReceipt.deleteMany();
  await prisma.pairCloseMark.deleteMany();
  __clearCloseMarkCache();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── The Platform's signing scheme, written out ──────────────────────────────

let seq = 0;
const newRequestId = () => `req_${Date.now().toString(36)}_${(seq++).toString().padStart(6, "0")}`;
const ACTOR = {
  platformUserId: "00000000-0000-4000-8000-000000000001",
  stepUp: { method: "totp", at: "2026-11-09T00:00:00.000Z" },
};

interface Signed {
  method: "GET" | "POST" | "PATCH";
  path: string;
  /** Hashed and sent as JSON; `undefined` = no body at all. */
  body?: unknown;
  requestId?: string;
  nonce?: string;
  timestamp?: string;
  secret?: string;
  omitSignature?: boolean;
  /** Sign this value instead of `body` (to model a signer/receiver mismatch). */
  signBody?: unknown;
}

function headersFor(input: Signed): Record<string, string> {
  const timestamp = input.timestamp ?? String(Date.now());
  const nonce = input.nonce ?? randomBytes(24).toString("base64url");
  const requestId = input.requestId ?? newRequestId();
  const hashed = "signBody" in input ? input.signBody : input.body;
  const canonical = [
    input.method, canonicalPath(input.path), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(hashed)).digest("hex"),
  ].join("\n");
  const signature = `v1=${createHmac("sha256", input.secret ?? CONTROL_SECRET).update(canonical).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-manual-timestamp": timestamp,
    "x-manual-nonce": nonce,
    "x-manual-request-id": requestId,
    ...(input.omitSignature ? {} : { "x-manual-signature": signature }),
  };
}

async function send(input: Signed, headers = headersFor(input)):
Promise<{ status: number; body: Record<string, unknown>; replayed: boolean }> {
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    replayed: response.headers.get("x-control-replayed") === "true",
  };
}

const C = "/api/manual-trading/control";

/** The C0 shape these assertions read (the route's own return type, loosely). */
type ControlStatusBody = Awaited<ReturnType<typeof import("../src/routes/manualControl.js")["readControlStatus"]>>;
const get = (p: string) => send({ method: "GET", path: `${C}${p}` });
const post = (p: string, body: unknown, requestId?: string) =>
  send({ method: "POST", path: `${C}${p}`, body, requestId });

// ── Fixtures and a fake exchange ────────────────────────────────────────────

interface FakeExchange { client: BinanceClient; submissions: Record<string, unknown>[] }

function fakeExchange(opts: {
  price?: string;
  failOrders?: boolean;
  /** Integration: throw this Binance-shaped error from order() instead of filling. */
  orderError?: () => unknown;
  /** Free base balance the fake wallet reports (default 10). */
  baseFree?: string;
  seed?: { clientOrderId: string; status: string; side?: string }[];
} = {}): FakeExchange {
  const submissions: Record<string, unknown>[] = [];
  const book = new Map<string, Record<string, unknown>>();
  for (const s of opts.seed ?? []) {
    book.set(s.clientOrderId, { orderId: `seed-${s.clientOrderId}`, clientOrderId: s.clientOrderId,
      side: s.side ?? "SELL", status: s.status, executedQty: "0", cummulativeQuoteQty: "0" });
  }
  let n = 0;
  const client = {
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: opts.price ?? "100" }),
    accountInfo: async () => ({ balances: [
      { asset: "BTC", free: opts.baseFree ?? "10", locked: "0" }, { asset: "USDT", free: "100000", locked: "0" },
    ] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.0001", minQty: "0.0001" },
      { filterType: "NOTIONAL", minNotional: "1" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      submissions.push(payload);
      // A transport failure of unknown outcome: no Binance error code.
      if (opts.failOrders) throw new Error("socket hang up");
      if (opts.orderError) throw opts.orderError();
      n += 1;
      const cid = String(payload.newClientOrderId ?? "");
      const order = { orderId: `ex-${n}`, clientOrderId: cid, side: payload.side, status: "FILLED",
        executedQty: String(payload.quantity), cummulativeQuoteQty:
          String(Number(payload.quantity) * Number(opts.price ?? "100")) };
      if (cid) book.set(cid, order);
      return order;
    },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      const order = book.get(origClientOrderId);
      if (!order) throw Object.assign(new Error("Order does not exist."), { code: -2013 });
      return order;
    },
    myTrades: async () => [],
  } as unknown as BinanceClient;
  return { client, submissions };
}

function useExchange(exchange: FakeExchange): void {
  config.dryRun = false; // so "an order" means one that reached the fake
  tradeExchangeClient.resolve = () => exchange.client;
  tradeExchangeClient.closeFactory = async () => exchange.client;
}

let botSeq = 0;
async function createBot(overrides: Partial<SignalBot> = {}): Promise<SignalBot> {
  botSeq += 1;
  return prisma.signalBot.create({ data: {
    name: `control bot ${botSeq}`, webhookSecret: `w${String(botSeq).padStart(3, "0")}${"k".repeat(36)}`,
    pairs: JSON.stringify(["BTCUSDT"]), ...overrides,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function createTrade(bot: SignalBot | null, overrides: Partial<SmartTrade> = {}): Promise<SmartTrade> {
  return prisma.smartTrade.create({ data: {
    botId: bot?.id ?? null, botName: bot?.name ?? "gone", pair: "BTCUSDT", status: "active",
    entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100,
    createdAt: new Date(Date.now() - 3_600_000), ...overrides,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

// ════════════════════════════════════════════════════════════════════════════
// F10 — the signing vector shared with the Platform
// ════════════════════════════════════════════════════════════════════════════

test("F10 signing vector: the Bot's manualAuth signs the fixed inputs to the agreed value", () => {
  const input = {
    method: "POST",
    path: "/api/manual-trading/control/halt",
    timestamp: "1794200000000",
    nonce: "nonceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    requestId: "req_0123456789abcdef",
    body: JSON.parse('{"confirmation":"HALT_TRADING","reason":"vector test","actor":' +
      '{"platformUserId":"00000000-0000-4000-8000-000000000001","stepUp":' +
      '{"method":"totp","at":"2026-11-09T00:00:00.000Z"}}}') as unknown,
  };
  const expected = "v1=" + "35140d29de6a2b893ccb422e" + "964b2f1597d05e93db91" + "da1fa0f1da380cc5dcb0" /* split: CI hex scan */;
  assert.equal(signManualRequest("test-secret-0123456789abcdef0123456789abcdef", input), expected);
  const verified = verifyManualRequest({
    secret: "test-secret-0123456789abcdef0123456789abcdef", ...input, signature: expected,
    now: 1794200000000,
  });
  assert.equal(verified.ok, true);
});

// ════════════════════════════════════════════════════════════════════════════
// The channel: HMAC, freshness, nonce, schema, empty bodies, feature flag
// ════════════════════════════════════════════════════════════════════════════

test("auth: a missing signature is 401 code auth", async () => {
  const r = await send({ method: "GET", path: `${C}/status`, omitSignature: true });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "auth");
});

test("auth: a signature under the wrong key is 401 code auth, and nothing runs", async () => {
  const r = await send({ method: "POST", path: `${C}/halt`, secret: "f00d" + "c".repeat(60),
    body: { confirmation: "HALT_TRADING", reason: "wrong key", actor: ACTOR } });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "auth");
  assert.equal((await getBotRiskLimits()).tradingHalted, false);
  assert.equal(await prisma.botControlCommand.count(), 0);
});

test("auth: a stale timestamp is 401 code auth", async () => {
  const r = await send({ method: "GET", path: `${C}/status`, timestamp: String(Date.now() - 61_000) });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "auth");
});

test("auth: a replayed nonce is 409 code nonce_replay, and the command does not run twice", async () => {
  const input: Signed = { method: "POST", path: `${C}/halt`,
    body: { confirmation: "HALT_TRADING", reason: "replay check", actor: ACTOR } };
  const headers = headersFor(input);
  const first = await send(input, headers);
  assert.equal(first.status, 200);
  const replay = await send(input, headers);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "nonce_replay");
  assert.equal(await prisma.botControlCommand.count(), 1);
});

test("schema: unknown fields, bad values and bad ids are 400 with a code, and claim nothing", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["/halt", { confirmation: "HALT_TRADING", reason: "ok reason", actor: ACTOR, extra: 1 }, "invalid_request"],
    ["/halt", { confirmation: "HALT", reason: "ok reason", actor: ACTOR }, "invalid_request"],
    ["/halt", { confirmation: "HALT_TRADING", reason: "x", actor: ACTOR }, "invalid_request"],
    ["/halt", { confirmation: "HALT_TRADING", reason: "ok reason" }, "invalid_request"],
    ["/halt", { confirmation: "HALT_TRADING", reason: "ok reason",
      actor: { ...ACTOR, platformUserId: "admin" } }, "invalid_request"],
    ["/halt", { confirmation: "HALT_TRADING", reason: "ok reason",
      actor: { ...ACTOR, stepUp: { method: "sms", at: ACTOR.stepUp.at } } }, "invalid_request"],
    ["/resume", { confirmation: "RESUME_TRADING", actor: { ...ACTOR, role: "admin" } }, "invalid_request"],
    ["/trades/not-a-uuid/close", { actor: ACTOR }, "invalid_id"],
    ["/bots/1/status", { status: "active", actor: ACTOR }, "invalid_id"],
    ["/trades/00000000-0000-4000-8000-0000000000aa/partial-close", { pct: 100, actor: ACTOR }, "invalid_request"],
    ["/trades/00000000-0000-4000-8000-0000000000aa/partial-close", { pct: 2.5, actor: ACTOR }, "invalid_request"],
  ];
  for (const [p, body, code] of cases) {
    const r = await post(p, body);
    assert.equal(r.status, 400, `${p} ${JSON.stringify(body)}`);
    assert.equal(r.body.code, code, `${p} ${JSON.stringify(body)}`);
  }
  const badId = await get("/commands/short");
  assert.equal(badId.status, 400);
  assert.equal(badId.body.code, "invalid_request_id");
  assert.equal(await prisma.botControlCommand.count(), 0);
  assert.equal((await getBotRiskLimits()).tradingHalted, false);
});

test("empty body: a POST signed over an absent body fails auth (the Bot hashes {}), and one signed over {} is a clean 400", async () => {
  // Finding 0.10: the Platform would hash an absent body as "", body-parser
  // gives the Bot `{}`. Bodies must therefore always be JSON objects.
  const absent = await send({ method: "POST", path: `${C}/resume` });
  assert.equal(absent.status, 401);
  assert.equal(absent.body.code, "auth");
  const empty = await send({ method: "POST", path: `${C}/resume`, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "invalid_request");
  assert.equal(await prisma.botControlCommand.count(), 0);
});

test("control plane: works with manual trading disabled, while manual-order routes stay 404", async () => {
  assert.equal(config.manualTradingEnabled, false);
  assert.equal((await get("/status")).status, 200);
  const manual = await send({ method: "GET", path: "/api/manual-trading/state" });
  assert.equal(manual.status, 404, "the manual ORDER feature flag still applies elsewhere");
  // Only the anchored prefix is control plane.
  const lookalike = await send({ method: "GET", path: "/api/manual-trading/controlx/status" });
  assert.equal(lookalike.status, 404);
});

// ════════════════════════════════════════════════════════════════════════════
// C0 / C3 — status
// ════════════════════════════════════════════════════════════════════════════

test("C0: dryRun and halt are independent; routing, latched and the halt policy are reported", async () => {
  config.dryRun = true;
  config.binanceTestnet = true;
  await prisma.riskControl.create({ data: { id: "global", maxDailyLossQuote: 10 } });
  await setBotTradingHalted(true, { by: "daily_loss", reason: "loss 12 reached 10" });
  await prisma.exchangeAccount.create({ data: { name: "t", apiKeyEnc: "x", apiSecretEnc: "x", testnet: true } });
  await createBot();
  await createBot({ status: "paused" } as Partial<SignalBot>);

  const r = await get("/status");
  assert.equal(r.status, 200);
  const body = r.body as unknown as ControlStatusBody;
  assert.equal(body.dryRun, true);
  assert.equal(body.halt.halted, true, "a dry-run Bot can be halted, and C0 says so");
  assert.equal(body.halt.haltedBy, "daily_loss");
  assert.equal(body.halt.haltedReason, "loss 12 reached 10");
  assert.match(String(body.halt.haltedAt), /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.operational.execution.mode, "DRY_RUN", "the mode hides the halt; the field does not");
  assert.equal(body.risk.latched, true);
  assert.equal(body.risk.limits.maxDailyLossQuote, 10);
  assert.equal(typeof body.risk.summary, "string");
  assert.deepEqual(body.exchange, { defaultTestnet: true, accounts: { testnet: 1, mainnet: 0 }, routing: "TESTNET" });
  assert.deepEqual(body.bots, { active: 1, paused: 1 });
  assert.equal(body.protection.mode, "in_process_poll");
  assert.equal(body.protection.exchangeResting, false);
  assert.ok(String(body.protection.note).includes(BOT_HALT_POLICY));
  assert.deepEqual(body.manual, { enabled: false, mainnetEnabled: config.mainnetManualTradingEnabled });
  assert.equal(body.shariahFloor.mode, "off");
  assert.equal(JSON.stringify(body).includes(CONTROL_SECRET), false);
});

test("C0: routing is NONE with no account and no process credentials, MIXED across networks", async () => {
  assert.equal(((await get("/status")).body as unknown as ControlStatusBody).exchange.routing, "NONE");
  await prisma.exchangeAccount.create({ data: { name: "t", apiKeyEnc: "x", apiSecretEnc: "x", testnet: true } });
  await prisma.exchangeAccount.create({ data: { name: "m", apiKeyEnc: "x", apiSecretEnc: "x", testnet: false } });
  const mixed = (await get("/status")).body as unknown as ControlStatusBody;
  assert.equal(mixed.exchange.routing, "MIXED");
  assert.deepEqual(mixed.exchange.accounts, { testnet: 1, mainnet: 1 });
  assert.equal(mixed.halt.halted, false);
  assert.equal(mixed.risk.latched, false);
});

test("C3: risk limits read", async () => {
  const r = await get("/risk-limits");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["latched", "limits", "snapshot", "summary"]);
});

// ════════════════════════════════════════════════════════════════════════════
// C1 / C2 / C4 — halt, resume, limits
// ════════════════════════════════════════════════════════════════════════════

test("C1 never overwrites a daily-loss latch; C2 still refuses while breached; lifting the limit makes it resumable", async () => {
  await prisma.riskControl.create({ data: { id: "global", maxDailyLossQuote: 10 } });
  await createTrade(null, { status: "closed", pnlUsdt: -25, closedAt: new Date() });
  await setBotTradingHalted(true, { by: "daily_loss", reason: "loss 25 reached 10" });

  const halt = await post("/halt", { confirmation: "HALT_TRADING", reason: "from Trading Scene", actor: ACTOR });
  assert.equal(halt.status, 200);
  assert.equal(halt.body.halted, true);
  assert.equal(halt.body.alreadyHalted, true);
  assert.equal(halt.body.haltedBy, "daily_loss");
  assert.equal(halt.body.haltedReason, "loss 25 reached 10");

  const resume = await post("/resume", { confirmation: "RESUME_TRADING", actor: ACTOR });
  assert.equal(resume.status, 409);
  assert.equal(resume.body.code, "still_breached");
  assert.equal((await getBotRiskLimits()).tradingHalted, true);

  const limits = await send({ method: "PATCH", path: `${C}/risk-limits`,
    body: { maxDailyLossQuote: null, actor: ACTOR } });
  assert.equal(limits.status, 200);
  assert.equal(limits.body.latched, true, "a limit change never lifts the latch");
  assert.equal(limits.body.latchCleared, false);
  assert.match(String(limits.body.note), /never lifts/);
  assert.equal((await getBotRiskLimits()).tradingHalted, true);

  const resumed = await post("/resume", { confirmation: "RESUME_TRADING", actor: ACTOR });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.halted, false);
  assert.equal(resumed.body.previousHaltedBy, "daily_loss");
  assert.equal((await getBotRiskLimits()).tradingHalted, false);
});

test("C1 halts an un-halted Bot as an operator halt; the command row records the actor, not the body", async () => {
  const requestId = newRequestId();
  const r = await post("/halt", { confirmation: "HALT_TRADING", reason: "maintenance", actor: ACTOR }, requestId);
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyHalted, false);
  assert.equal((await getBotRiskLimits()).haltedBy, "operator");
  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(row.kind, "halt");
  assert.equal(row.target, "bot");
  assert.equal(row.status, "succeeded");
  assert.equal(row.actorUserId, ACTOR.platformUserId);
  assert.equal(row.stepUpMethod, "totp");
});

test("C4: bounds are the dashboard's; an empty patch is refused", async () => {
  const bad = [
    { dailyLossWindowHours: 0 }, { dailyLossWindowHours: 721 }, { dailyLossWindowHours: 2.5 },
    { maxTotalExposureQuote: -1 }, { maxConcurrentTrades: 1.5 }, { maxDailyLossQuote: "10" }, {},
  ];
  for (const fields of bad) {
    const r = await send({ method: "PATCH", path: `${C}/risk-limits`, body: { ...fields, actor: ACTOR } });
    assert.equal(r.status, 400, JSON.stringify(fields));
    assert.equal(r.body.code, "invalid_request");
  }
  const ok = await send({ method: "PATCH", path: `${C}/risk-limits`, body: {
    maxTotalExposureQuote: 500, maxConcurrentTrades: 3, maxDailyLossQuote: 50, dailyLossWindowHours: 720,
    actor: ACTOR,
  } });
  assert.equal(ok.status, 200);
  const limits = (ok.body as unknown as { limits: Record<string, unknown> }).limits;
  assert.equal(limits.maxTotalExposureQuote, 500);
  assert.equal(limits.maxConcurrentTrades, 3);
  assert.equal(limits.maxDailyLossQuote, 50);
  assert.equal(limits.dailyLossWindowHours, 720);
});

// ════════════════════════════════════════════════════════════════════════════
// C5 — bot status, target state
// ════════════════════════════════════════════════════════════════════════════

test("C5: target state, idempotent across requests, with the unresolved-intent count and no secret", async () => {
  const bot = await createBot();
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: `c5:${bot.id}`, clientOrderId: `c5-${bot.id}`.slice(0, 36), botId: bot.id, botName: bot.name,
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 10, status: "requested",
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });

  const pause = await post(`/bots/${bot.id}/status`, { status: "paused", actor: ACTOR });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.status, "paused");
  assert.equal(pause.body.changed, true);
  assert.equal(pause.body.unresolvedIntents, 1);
  assert.equal(JSON.stringify(pause.body).includes(bot.webhookSecret), false, "never the webhook secret");
  assert.equal("webhookSecret" in pause.body, false);

  const again = await post(`/bots/${bot.id}/status`, { status: "paused", actor: ACTOR });
  assert.equal(again.status, 200);
  assert.equal(again.body.changed, false, "a second stop converges; it does not toggle");
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).status, "paused");

  const start = await post(`/bots/${bot.id}/status`, { status: "active", actor: ACTOR });
  assert.equal(start.body.changed, true);
  assert.equal(start.body.status, "active");

  const missing = await post("/bots/00000000-0000-4000-8000-0000000000ff/status", { status: "active", actor: ACTOR });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "bot_not_found");
});

// ════════════════════════════════════════════════════════════════════════════
// C6 — Close
// ════════════════════════════════════════════════════════════════════════════

test("C6: every refusal is typed, and none of them reaches the exchange", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const paused = await createBot({ status: "paused" } as Partial<SignalBot>);
  const delisted = await createBot({ pairs: JSON.stringify(["ETHUSDT"]) } as Partial<SignalBot>);
  const multi = await createBot({ maxEntryOrders: 2 } as Partial<SignalBot>);

  const manual = await createTrade(null, { source: "manual", botName: "Manual" });
  const orphan = await createTrade(null);
  const ofPaused = await createTrade(paused);
  const ofDelisted = await createTrade(delisted);
  const twinA = await createTrade(multi);
  await createTrade(multi, { createdAt: new Date() });
  const closed = await createTrade(bot, { status: "closed", closedAt: new Date() });

  const expectations: Array<[string, number, string]> = [
    [manual.id, 409, "trade_manual"],
    [orphan.id, 422, "bot_deleted"],
    [ofPaused.id, 422, "bot_paused"],
    [ofDelisted.id, 422, "pair_not_listed"],
    [twinA.id, 422, "ambiguous_trade"],
    [closed.id, 409, "trade_not_active"],
    ["00000000-0000-4000-8000-0000000000ee", 404, "trade_not_found"],
  ];
  for (const [id, status, code] of expectations) {
    const r = await post(`/trades/${id}/close`, { actor: ACTOR });
    assert.equal(r.status, status, code);
    assert.equal(r.body.code, code);
    assert.equal(typeof r.body.error, "string");
  }
  const manualMessage = String((await post(`/trades/${manual.id}/close`, { actor: ACTOR })).body.error);
  assert.match(manualMessage, /Trading Scene Trade panel/);
  assert.doesNotMatch(manualMessage, /Binance/);
  assert.equal(exchange.submissions.length, 0);
  assert.equal(await prisma.strategyOrderIntent.count(), 0);
  assert.equal(heldLockCount(), 0);
});

test("C6 / F3: a sibling trade appearing after the guard is refused as ambiguous_trade, with zero orders", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot({ maxEntryOrders: 2 } as Partial<SignalBot>);
  const clicked = await createTrade(bot);
  let sibling: SmartTrade | null = null;
  // The client factory runs inside processWebhook, after closeStrategyTrade's
  // guard and immediately before the newest-active-trade selection: exactly
  // the race window F3 describes.
  tradeExchangeClient.closeFactory = async () => {
    sibling = await createTrade(bot, { createdAt: new Date() });
    return exchange.client;
  };
  const r = await post(`/trades/${clicked.id}/close`, { actor: ACTOR });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "ambiguous_trade");
  assert.equal(exchange.submissions.length, 0, "nothing was sold");
  assert.equal(await prisma.strategyOrderIntent.count(), 0, "no intent was reserved");
  assert.ok(sibling);
  for (const id of [clicked.id, (sibling as SmartTrade).id]) {
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id } })).status, "active");
  }
  assert.equal(heldLockCount(), 0);
  // The receipt was released: the 45 s exit dedupe does not swallow a retry.
  assert.equal(await prisma.webhookReceipt.count(), 0);
});

test("F3 at the source: processWebhook refuses a mismatched expectSmartTradeId before any lock or order", async () => {
  const exchange = fakeExchange();
  config.dryRun = false;
  const bot = await createBot();
  const trade = await createTrade(bot);
  await assert.rejects(
    processWebhook({ secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: 1 },
      { skipExitCheck: true, expectSmartTradeId: "00000000-0000-4000-8000-000000000999",
        clientFactory: async () => exchange.client }),
    (e: unknown) => (e as { code?: string }).code === "ambiguous_trade");
  assert.equal(exchange.submissions.length, 0);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "active");
  assert.equal(heldLockCount(), 0);
});

test("C6: closes exactly the clicked trade; the same request id twice places one order and replays", async () => {
  const exchange = fakeExchange({ price: "110" });
  useExchange(exchange);
  const bot = await createBot();
  const other = await createBot({ pairs: JSON.stringify(["BTCUSDT"]) } as Partial<SignalBot>);
  const clicked = await createTrade(bot, { quantity: 0.5 });
  const untouched = await createTrade(other, { quantity: 0.7 });

  const requestId = newRequestId();
  const first = await post(`/trades/${clicked.id}/close`, { actor: ACTOR }, requestId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "ok");
  assert.equal(first.replayed, false);
  assert.equal(exchange.submissions.length, 1);
  assert.equal(exchange.submissions[0]!.side, "SELL");
  assert.equal(exchange.submissions[0]!.quantity, "0.5");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: clicked.id } })).status, "closed");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: untouched.id } })).status, "active");

  // A Platform retry: same request id, fresh nonce, fresh step-up time.
  const retry = await post(`/trades/${clicked.id}/close`,
    { actor: { ...ACTOR, stepUp: { method: "totp", at: "2026-11-09T00:05:00.000Z" } } }, requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.replayed, true);
  const { live: replayLive, ...replayBody } = retry.body;
  assert.deepEqual(replayBody, first.body, "the stored result, replayed");
  // R1: the reserved intent was recorded on the row, so a replay also says
  // what became of the order.
  assert.equal((replayLive as Record<string, unknown>).kind, "strategy_intent");
  assert.equal((replayLive as Record<string, unknown>).outcome, "executed");
  assert.equal(exchange.submissions.length, 1, "never a second order");

  const c8 = await get(`/commands/${requestId}`);
  assert.equal(c8.status, 200);
  assert.equal(c8.body.status, "succeeded");
  assert.equal(c8.body.kind, "trade_close");
  assert.equal(c8.body.target, `trade:${clicked.id}`);
  assert.equal(c8.body.actorUserId, ACTOR.platformUserId);
});

test("C6: the same request id for a different command is 409 request_id_reused, and nothing runs", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const other = await createBot({ pairs: JSON.stringify(["BTCUSDT"]) } as Partial<SignalBot>);
  const a = await createTrade(bot);
  const b = await createTrade(other);
  const requestId = newRequestId();
  assert.equal((await post(`/trades/${a.id}/close`, { actor: ACTOR }, requestId)).status, 200);
  const reused = await post(`/trades/${b.id}/close`, { actor: ACTOR }, requestId);
  assert.equal(reused.status, 409);
  assert.equal(reused.body.code, "request_id_reused");
  const reusedKind = await post("/halt", { confirmation: "HALT_TRADING", reason: "other kind", actor: ACTOR }, requestId);
  assert.equal(reusedKind.status, 409);
  assert.equal(reusedKind.body.code, "request_id_reused");
  assert.equal(exchange.submissions.length, 1);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: b.id } })).status, "active");
  assert.equal((await getBotRiskLimits()).tradingHalted, false);
});

for (const age of [{ label: "in progress", ms: 0 }, { label: "stranded by a crash hours ago", ms: 6 * 3_600_000 }]) {
  test(`C6: a command row left processing (${age.label}) is 409 command_in_progress and never re-run`, async () => {
    const exchange = fakeExchange();
    useExchange(exchange);
    const bot = await createBot();
    const trade = await createTrade(bot);
    const requestId = newRequestId();
    await prisma.botControlCommand.create({ data: {
      requestId, kind: "trade_close", target: `trade:${trade.id}`,
      commandHash: controlCommandHash("trade_close", `trade:${trade.id}`, {}),
      actorUserId: ACTOR.platformUserId, stepUpMethod: "totp", status: "processing",
      createdAt: new Date(Date.now() - age.ms), updatedAt: new Date(Date.now() - age.ms),
    } });
    const r = await post(`/trades/${trade.id}/close`, { actor: ACTOR }, requestId);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "command_in_progress");
    assert.equal(exchange.submissions.length, 0);
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "active");
    assert.equal((await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } })).status, "processing");
  });
}

test("C6: an order of unknown outcome is 202 pending with the intent id; C8 reports the live intent", async () => {
  const exchange = fakeExchange({ failOrders: true });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const requestId = newRequestId();
  const r = await post(`/trades/${trade.id}/close`, { actor: ACTOR }, requestId);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.status, "pending");
  const intentId = String(r.body.intentId);
  const intent = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intentId } });
  assert.equal(intent.status, "submitted");
  assert.equal(intent.smartTradeId, trade.id);
  assert.equal(exchange.submissions.length, 1);

  const c8 = await get(`/commands/${requestId}`);
  assert.equal(c8.body.status, "pending");
  const live = c8.body.live as Record<string, unknown>;
  assert.equal(live.kind, "strategy_intent");
  assert.equal(live.id, intentId);
  assert.equal(live.status, "submitted");
  assert.equal(live.outcome, "pending");

  // The reconciler later learns the fill: C8 follows the live record.
  await prisma.strategyOrderIntent.update({ where: { id: intentId }, data: { status: "reconciled" } });
  const later = await get(`/commands/${requestId}`);
  assert.equal((later.body.live as Record<string, unknown>).outcome, "executed");

  // A retry of the same request id is answered from the record, not re-run.
  const retry = await post(`/trades/${trade.id}/close`, { actor: ACTOR }, requestId);
  assert.equal(retry.status, 202);
  assert.equal(exchange.submissions.length, 1);
});

test("C6: a prior unresolved strategy SELL blocks the close as exit_unresolved, with no new order", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  const exchange = fakeExchange({ seed: [{ clientOrderId: "prior-sell-1", status: "NEW" }] });
  useExchange(exchange);
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: `prior:${trade.id}`, clientOrderId: "prior-sell-1", botId: bot.id, botName: bot.name,
    symbol: "BTCUSDT", side: "SELL", requestedBaseQty: 1, status: "submitted", smartTradeId: trade.id,
    skipExitCheck: true, submittedAt: new Date(Date.now() - 3_600_000),
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
  const r = await post(`/trades/${trade.id}/close`, { actor: ACTOR });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "exit_unresolved");
  assert.equal(exchange.submissions.length, 0);
});

test("dashboard Close runs the same shared function: success closes the trade", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const response = await fetch(`${baseUrl}/api/trades/${trade.id}/close`, {
    method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, "ok");
  assert.equal(exchange.submissions.length, 1);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "closed");
});

// ════════════════════════════════════════════════════════════════════════════
// C7 — Partial
// ════════════════════════════════════════════════════════════════════════════

test("C7: sells the requested slice of exactly this trade; replay places no second order", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot, { quantity: 1 });
  const requestId = newRequestId();
  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 25, actor: ACTOR }, requestId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.executedQty, 0.25);
  assert.equal(r.body.requestedQty, 0.25);
  assert.equal(exchange.submissions.length, 1);
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.quantity, 0.75);
  assert.equal(after.status, "active");

  const retry = await post(`/trades/${trade.id}/partial-close`, { pct: 25, actor: ACTOR }, requestId);
  assert.equal(retry.status, 200);
  assert.equal(retry.replayed, true);
  assert.equal(exchange.submissions.length, 1);

  const changedPct = await post(`/trades/${trade.id}/partial-close`, { pct: 50, actor: ACTOR }, requestId);
  assert.equal(changedPct.status, 409);
  assert.equal(changedPct.body.code, "request_id_reused");
  assert.equal(exchange.submissions.length, 1);
});

test("C7 / F4: an unresolved strategy SELL intent refuses the partial as exit_unresolved, with no order", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  // Still live at the exchange: the prior SELL may yet sell this position.
  const exchange = fakeExchange({ seed: [{ clientOrderId: "prior-sell-2", status: "NEW" }] });
  useExchange(exchange);
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: `prior2:${trade.id}`, clientOrderId: "prior-sell-2", botId: bot.id, botName: bot.name,
    symbol: "BTCUSDT", side: "SELL", requestedBaseQty: 1, status: "submitted", smartTradeId: trade.id,
    submittedAt: new Date(Date.now() - 3_600_000),
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });

  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 25, actor: ACTOR });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "exit_unresolved");
  assert.doesNotMatch(String(r.body.error), /prior-sell-2/, "exchange detail stays off the control channel");
  assert.equal(exchange.submissions.length, 0);
  assert.equal(await prisma.exchangeOrderAttempt.count(), 0);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).quantity, 1);
  assert.equal(heldLockCount(), 0);

  // The dashboard Partial shares the function, so it is protected too.
  const response = await fetch(`${baseUrl}/api/trades/${trade.id}/partial-close`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pct: 25 }) });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "exit_unresolved");
  assert.equal(exchange.submissions.length, 0);
});

test("C7: refusals for manual and bot-less trades", async () => {
  const manual = await createTrade(null, { source: "manual", botName: "Manual" });
  const orphan = await createTrade(null);
  const m = await post(`/trades/${manual.id}/partial-close`, { pct: 10, actor: ACTOR });
  assert.equal(m.status, 409);
  assert.equal(m.body.code, "trade_manual");
  const o = await post(`/trades/${orphan.id}/partial-close`, { pct: 10, actor: ACTOR });
  assert.equal(o.status, 422);
  assert.equal(o.body.code, "bot_deleted");
});

test("C7: an order of unknown outcome is 202 pending with the attempt id; C8 reports the live attempt", async () => {
  const exchange = fakeExchange({ failOrders: true });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const requestId = newRequestId();
  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 50, actor: ACTOR }, requestId);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.status, "pending");
  const attempt = await prisma.exchangeOrderAttempt.findUniqueOrThrow({ where: { id: String(r.body.attemptId) } });
  assert.equal(attempt.status, "open");
  assert.ok(attempt.submittedAt);
  const c8 = await get(`/commands/${requestId}`);
  assert.equal(c8.body.status, "pending");
  assert.equal((c8.body.live as Record<string, unknown>).kind, "exit_attempt");
  assert.equal((c8.body.live as Record<string, unknown>).outcome, "pending");
  assert.equal(heldLockCount(), 0);
});

// Integration (exec × cmd): C7 must use the shared D2 classifier. A CODED but
// uncertain answer (-1007 "execution status unknown") is pending, never
// "exchange rejected; no order was executed". A definite code stays a refusal.
test("C7 × D2: a coded uncertain answer (-1007) is 202 pending, not exchange_rejected", async () => {
  const exchange = fakeExchange({ orderError: () => Object.assign(
    new Error("Timeout waiting for response from backend server. Send status unknown; execution status unknown."),
    { code: -1007 }) });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const requestId = newRequestId();
  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 50, actor: ACTOR }, requestId);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.status, "pending");
  assert.notEqual(r.body.code, "exchange_rejected");
  const c8 = await get(`/commands/${requestId}`);
  assert.equal((c8.body.live as Record<string, unknown>).outcome, "pending");
  assert.equal(heldLockCount(), 0);
});

test("C7 × D2: a definite rejection (-2010 insufficient balance) stays 422 exchange_rejected", async () => {
  const exchange = fakeExchange({ orderError: () => Object.assign(
    new Error("Account has insufficient balance for requested action."), { code: -2010 }) });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 50, actor: ACTOR });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, "exchange_rejected");
});

test("C7: a pre-wire refusal (wallet below the lot minimum) is a typed 422 not_executed, with no order", async () => {
  const exchange = fakeExchange({ baseFree: "0" });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  const r = await post(`/trades/${trade.id}/partial-close`, { pct: 25, actor: ACTOR });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.code, "not_executed");
  assert.match(String(r.body.error), /No order was sent/);
  assert.equal(exchange.submissions.length, 0);
  assert.equal(heldLockCount(), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Review R1 — a crash before the terminal write still leaves C8 the order
// ════════════════════════════════════════════════════════════════════════════

for (const kind of ["close", "partial-close"] as const) {
  test(`R1: ${kind} — a crash after the order reference is recorded leaves C8 'processing' with the live order, and is never re-run`, async () => {
    // The order call fails with no exchange code (in flight, outcome unknown),
    // right after the observation hook recorded the order on the command row;
    // then the terminal write fails, which is what a process death at that
    // moment leaves behind: a `processing` row and an order of unknown fate.
    const exchange = fakeExchange({ failOrders: true });
    useExchange(exchange);
    const bot = await createBot();
    const trade = await createTrade(bot);
    const requestId = newRequestId();
    const delegate = prisma.botControlCommand;
    const realUpdate = delegate.update;
    let crashed = false;
    (delegate as { update: unknown }).update = async () => {
      crashed = true;
      throw new Error("simulated crash before the terminal write");
    };
    let first;
    try {
      first = await post(`/trades/${trade.id}/${kind}`,
        kind === "close" ? { actor: ACTOR } : { pct: 50, actor: ACTOR }, requestId);
    } finally {
      (delegate as { update: unknown }).update = realUpdate;
    }
    assert.ok(crashed, "the terminal write was reached and failed");
    assert.equal(first.status, 500, "masked: the Platform treats this as uncertain");
    assert.equal(exchange.submissions.length, 1, "the order was sent once");

    const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
    assert.equal(row.status, "processing");
    assert.ok(kind === "close" ? row.intentId : row.attemptId, "recorded before the wire call");

    const c8 = await get(`/commands/${requestId}`);
    assert.equal(c8.status, 200);
    assert.equal(c8.body.status, "processing");
    const live = c8.body.live as Record<string, unknown>;
    assert.equal(live.kind, kind === "close" ? "strategy_intent" : "exit_attempt");
    assert.equal(live.status, kind === "close" ? "submitted" : "open");
    assert.equal(live.outcome, "pending");

    const retry = await post(`/trades/${trade.id}/${kind}`,
      kind === "close" ? { actor: ACTOR } : { pct: 50, actor: ACTOR }, requestId);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.code, "command_in_progress");
    assert.equal((retry.body.live as Record<string, unknown>).kind, live.kind);
    assert.equal(exchange.submissions.length, 1, "never re-run");
    assert.equal(heldLockCount(), 0);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Review A2 — a close swallowed by the 45 s exit receipt is not a success
// ════════════════════════════════════════════════════════════════════════════

const EXIT_RECENT =
  "A close for this trade was already sent in the last 45 seconds; no new order was placed. " +
  "Check the trade's current state.";

async function recentExitReceipt(bot: SignalBot): Promise<void> {
  // Exactly the receipt a SELL for this bot and pair reserves in processWebhook.
  await prisma.webhookReceipt.create({ data: {
    keyHash: createHash("sha256").update(tradeEventKey(bot.id, "BTCUSDT", "sell")).digest("hex"),
    expiresAt: new Date(Date.now() + 45_000),
  } });
}

test("A2: C6 inside the 45 s exit window is 409 exit_recent while the trade is still open, with no order", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  await recentExitReceipt(bot);
  const r = await post(`/trades/${trade.id}/close`, { actor: ACTOR });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "exit_recent");
  assert.equal(r.body.error, EXIT_RECENT);
  assert.equal(exchange.submissions.length, 0);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "active");
});

test("A2: the dashboard Close shows the same refusal, not a success", async () => {
  const exchange = fakeExchange();
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  await recentExitReceipt(bot);
  const response = await fetch(`${baseUrl}/api/trades/${trade.id}/close`, {
    method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(response.status, 409, "a non-2xx: the dashboard raises it as an error toast");
  const body = await response.json() as { error: string; code: string };
  assert.equal(body.code, "exit_recent");
  assert.equal(body.error, EXIT_RECENT);
  assert.equal(exchange.submissions.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// C8 and F9
// ════════════════════════════════════════════════════════════════════════════

test("C8: an unknown request id is 404 command_not_found", async () => {
  const r = await get(`/commands/${newRequestId()}`);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, "command_not_found");
});

test("F9: the control limiter answers 429 code bot_rate_limited, and reads cannot starve writes", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/manual-trading/control", ...createControlRateLimiters({ readMax: 1, writeMax: 1 }));
  app.all("/api/manual-trading/control/*", (_req, res) => { res.json({ reached: true }); });
  const limited: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/api/manual-trading/control`;
  try {
    assert.equal((await fetch(`${url}/status`)).status, 200);
    const throttled = await fetch(`${url}/commands/x`);
    assert.equal(throttled.status, 429);
    assert.equal(((await throttled.json()) as { code: string }).code, "bot_rate_limited");
    const write = await fetch(`${url}/halt`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(write.status, 200, "a halt has its own budget");
    assert.equal((await fetch(`${url}/halt`, { method: "POST", body: "{}" })).status, 429);
  } finally {
    await new Promise<void>((resolve) => limited.close(() => resolve()));
  }
});

test("F9: the app mounts the control limiters and keeps /control/* off the shared apiLimiter", () => {
  // The composition moved from index.ts to app.ts (createApp) so tests can drive it.
  const index = fs.readFileSync(path.join(backendRoot, "src", "app.ts"), "utf8");
  const limiters = index.indexOf('app.use("/api/manual-trading/control", ...createControlRateLimiters())');
  const manual = index.indexOf('"/api/manual-trading",\n');
  assert.ok(limiters > 0 && manual > limiters, "the control limiters are registered first");
  assert.match(index, /req\.path\.startsWith\("\/control\/"\) \? next\(\) : apiLimiter\(req, res, next\)/);
});
