/**
 * P-81 `executions.v1`: the confirmed-execution feed.
 *
 * What matters here:
 *   - an event exists only for a fill the ledger booked (strategy, exit, manual);
 *   - a replayed booking (reconcile again, a second resolver, a duplicate
 *     snapshot) never appends a second event;
 *   - manual LIMIT orders produce one event per fill increment, and a netting
 *     correction is not an execution;
 *   - a rejected, unknown or zero-fill order produces nothing;
 *   - the environment comes from the order-level record: REAL (MAINNET) only
 *     with a recorded MAINNET route and an exchange-assigned id;
 *   - the feed read is signed, paginated, and starts from "now" for a new reader.
 *
 * No network. No Binance.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".execution-events-test.db");
process.env.DATABASE_URL = "file:./tests/.execution-events-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes, randomUUID } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const events = await import("../src/services/executionEvents.js");
const { reserveStrategyIntent, reconcileStrategyIntent } = await import("../src/services/strategyOrderIntent.js");
const { applyManualSnapshot } = await import("../src/services/manualTrading.js");
const { openOrderAttempt } = await import("../src/services/orderAttempt.js");
const { applyExitFill } = await import("../src/services/exitSettlement.js");
const { manualExecutionEnvironment } = await import("../src/services/executionEnvironment.js");
const { buildControlCapabilities } = await import("../src/services/controlCapabilities.js");

const SECRET = "5c1a" + "d".repeat(60);
const original = {
  manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret,
  dryRun: config.dryRun,
};
config.manualTradingEnabled = true;
config.manualTradingHmacSecret = SECRET;

let server: Server;
let baseUrl = "";
let testnetAccountId = "";
let mainnetAccountId = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  testnetAccountId = (await prisma.exchangeAccount.create({ data: {
    name: "Testnet", exchange: "binance", marketType: "spot", apiKeyEnc: "k", apiSecretEnc: "s", testnet: true,
  } })).id;
  mainnetAccountId = (await prisma.exchangeAccount.create({ data: {
    name: "Mainnet", exchange: "binance", marketType: "spot", apiKeyEnc: "k2", apiSecretEnc: "s2", testnet: false,
  } })).id;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.manualTradingEnabled = original.manualTradingEnabled;
  config.manualTradingHmacSecret = original.secret;
  config.dryRun = original.dryRun;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

function signedHeaders(method: string, urlPath: string, body?: unknown) {
  const nonce = randomBytes(24).toString("base64url");
  const timestamp = String(Date.now());
  const requestId = randomUUID();
  const canonical = [method, canonicalPath(urlPath), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  return {
    "x-manual-timestamp": timestamp, "x-manual-nonce": nonce, "x-manual-request-id": requestId,
    "x-manual-signature": `v1=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`,
  };
}

async function eventsFor(prefix: string) {
  const rows = await prisma.executionEvent.findMany({ where: { id: { startsWith: prefix } }, orderBy: { seq: "asc" } });
  return rows.map((row) => JSON.parse(row.payload) as import("../src/services/executionEvents.js").ExecutionEventV1);
}

async function makeBot(accountId: string, name: string) {
  return prisma.signalBot.create({ data: {
    name, pairs: JSON.stringify(["BTCUSDT"]), webhookSecret: `secret-${randomUUID()}`, exchangeAccountId: accountId,
  } });
}

// ── environment rule ───────────────────────────────────────────────────────

test("environment: REAL needs a recorded MAINNET and an exchange id; anything inconsistent is UNKNOWN", () => {
  const env = events.confirmedEnvironment;
  assert.equal(env("MAINNET", { exchangeOrderId: "123" }), "MAINNET");
  assert.equal(env("TESTNET", { exchangeOrderId: "123" }), "TESTNET");
  assert.equal(env("DRY_RUN", { exchangeOrderId: "dry-abc" }), "DRY_RUN");
  assert.equal(env("DRY_RUN", { simulated: true, exchangeOrderId: "x" }), "DRY_RUN");
  assert.equal(env(null, { exchangeOrderId: "123" }), "UNKNOWN", "older rows have no record");
  assert.equal(env(undefined, { exchangeOrderId: "123" }), "UNKNOWN");
  assert.equal(env("MAINNET", { exchangeOrderId: "dry-abc" }), "UNKNOWN", "simulated id on a REAL record");
  assert.equal(env("MAINNET", { simulated: true }), "UNKNOWN");
  assert.equal(env("DRY_RUN", { exchangeOrderId: "123" }), "UNKNOWN", "exchange id on a DRY_RUN record");
  assert.equal(env("SOMETHING", { exchangeOrderId: "123" }), "UNKNOWN");
  assert.equal(env("UNKNOWN", { exchangeOrderId: "123" }), "UNKNOWN");
});

test("manual environment is decided from the adapter's dry-run switch, then the account network", () => {
  assert.equal(manualExecutionEnvironment({ testnet: true }, { dryRun: true }), "DRY_RUN");
  assert.equal(manualExecutionEnvironment({ testnet: true }, { dryRun: false }), "TESTNET");
  assert.equal(manualExecutionEnvironment({ testnet: false }, { dryRun: false }), "MAINNET");
  assert.equal(manualExecutionEnvironment(null, { dryRun: false }), "UNKNOWN");
});

// ── strategy path ──────────────────────────────────────────────────────────

test("strategy BUY: one event when the fill is booked, none on any replay", async () => {
  const bot = await makeBot(testnetAccountId, "Strategy testnet");
  config.dryRun = false; // the intent records TESTNET from the bot's account
  try {
    const intent = await reserveStrategyIntent({
      sourceKey: `src-${randomUUID()}`, bot, clientOrderId: `cid-${randomUUID()}`,
      symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 50,
    });
    assert.equal(intent.executionEnvironment, "TESTNET");
    const result = { orderId: "778899", executedQty: 0.001, cummulativeQuoteQty: 50, avgPrice: 50_000, simulated: false,
      status: "FILLED" };
    const adapter = { submit: async () => result, query: async () => result };
    const first = await reconcileStrategyIntent(intent.id, adapter, { allowNeverAttempted: true });
    assert.equal(first.appliedNow, true);
    const again = await reconcileStrategyIntent(intent.id, adapter, { allowNeverAttempted: true });
    assert.equal(again.appliedNow, false);
    const recorded = await eventsFor(`strategy:${intent.id}`);
    assert.equal(recorded.length, 1);
    const [event] = recorded;
    assert.equal(event!.side, "BUY");
    assert.equal(event!.symbol, "BTCUSDT");
    assert.equal(event!.executedBaseQty, 0.001);
    assert.equal(event!.executedQuoteQty, 50);
    assert.equal(event!.averagePrice, 50_000);
    assert.equal(event!.environment, "TESTNET");
    assert.equal(event!.source, "strategy");
    assert.equal(event!.botId, bot.id);
    assert.ok(event!.smartTradeId, "linked to the booked trade");
    assert.equal(event!.exchangeOrderId, "778899");
  } finally {
    config.dryRun = original.dryRun;
  }
});

test("strategy: a rejected order and an unknown outcome record nothing", async () => {
  const bot = await makeBot(testnetAccountId, "Strategy rejects");
  const rejected = await reserveStrategyIntent({
    sourceKey: `src-${randomUUID()}`, bot, clientOrderId: `cid-${randomUUID()}`,
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 50,
  });
  const refusing = {
    submit: async () => { throw Object.assign(new Error("Account has insufficient balance"), { code: -2010 }); },
    query: async () => null,
  };
  await reconcileStrategyIntent(rejected.id, refusing, { allowNeverAttempted: true }).catch(() => undefined);
  assert.equal((await eventsFor(`strategy:${rejected.id}`)).length, 0);

  const unknown = await reserveStrategyIntent({
    sourceKey: `src-${randomUUID()}`, bot, clientOrderId: `cid-${randomUUID()}`,
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 50,
  });
  const timingOut = {
    submit: async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); },
    query: async () => null,
  };
  await reconcileStrategyIntent(unknown.id, timingOut, { allowNeverAttempted: true }).catch(() => undefined);
  assert.equal((await eventsFor(`strategy:${unknown.id}`)).length, 0);
  const state = await prisma.strategyOrderIntent.findUnique({ where: { id: unknown.id } });
  assert.notEqual(state?.status, "reconciled");
});

test("strategy in DRY_RUN: the simulated fill is labelled DRY_RUN", async () => {
  const bot = await makeBot(testnetAccountId, "Strategy dry");
  config.dryRun = true;
  const intent = await reserveStrategyIntent({
    sourceKey: `src-${randomUUID()}`, bot, clientOrderId: `cid-${randomUUID()}`,
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 20,
  });
  const result = { orderId: `dry-${intent.clientOrderId}`, executedQty: 0.0004, cummulativeQuoteQty: 20,
    avgPrice: 50_000, simulated: true, status: "FILLED" };
  await reconcileStrategyIntent(intent.id, { submit: async () => result, query: async () => result },
    { allowNeverAttempted: true });
  const [event] = await eventsFor(`strategy:${intent.id}`);
  assert.equal(event!.environment, "DRY_RUN");
});

// ── exit path (TP/SL, partial) ─────────────────────────────────────────────

test("exit fill: one event, a second resolver of the same fill appends nothing, zero fill records nothing", async () => {
  const bot = await makeBot(mainnetAccountId, "Exits");
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", entryPrice: 100, quantity: 2, quoteSpent: 200,
  } });
  const attempt = await openOrderAttempt({
    intentKey: `tpsl:${trade.id}:tp`, symbol: "BTCUSDT", side: "SELL", smartTradeId: trade.id, origin: "tpsl",
    requestedBaseQty: 2, closedReason: "take_profit", executionEnvironment: "MAINNET",
  });
  const fill = { orderId: "555001", executedQty: 2, cummulativeQuoteQty: 240, avgPrice: 120 };
  assert.ok(await applyExitFill(attempt, fill));
  assert.equal(await applyExitFill(attempt, fill), null, "the compare-and-set lost: applies nothing");
  const recorded = await eventsFor(`exit:${attempt.id}`);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.side, "SELL");
  assert.equal(recorded[0]!.source, "tpsl");
  assert.equal(recorded[0]!.environment, "MAINNET");
  assert.equal(recorded[0]!.smartTradeId, trade.id);

  const trade2 = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", entryPrice: 100, quantity: 1, quoteSpent: 100,
  } });
  const zero = await openOrderAttempt({
    intentKey: `partial:${trade2.id}:50`, symbol: "BTCUSDT", side: "SELL", smartTradeId: trade2.id, origin: "partial",
    sellPercent: 50, requestedBaseQty: 0.5, closedReason: "partial_close", executionEnvironment: "MAINNET",
  });
  await applyExitFill(zero, { orderId: "555002", executedQty: 0, cummulativeQuoteQty: 0, avgPrice: 0 });
  assert.equal((await eventsFor(`exit:${zero.id}`)).length, 0);
});

test("exit attempt opened without a recorded environment (older row) reads UNKNOWN, never REAL", async () => {
  const bot = await makeBot(mainnetAccountId, "Legacy exits");
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", entryPrice: 100, quantity: 1, quoteSpent: 100,
  } });
  const attempt = await openOrderAttempt({
    intentKey: `tpsl:${trade.id}:sl`, symbol: "BTCUSDT", side: "SELL", smartTradeId: trade.id, origin: "tpsl",
    requestedBaseQty: 1, closedReason: "stop_loss",
  });
  await applyExitFill(attempt, { orderId: "555003", executedQty: 1, cummulativeQuoteQty: 90, avgPrice: 90 });
  const [event] = await eventsFor(`exit:${attempt.id}`);
  assert.equal(event!.environment, "UNKNOWN");
});

// ── manual path ────────────────────────────────────────────────────────────

async function manualOrder(side: "BUY" | "SELL", extra: Record<string, unknown> = {}) {
  const requestId = `req-${randomUUID()}`;
  return prisma.manualOrder.create({ data: {
    requestId, exchangeAccountId: testnetAccountId, symbol: "BTCUSDT", side, orderType: "LIMIT",
    quantityType: side === "BUY" ? "quote" : "base", requestedQuoteQty: 100, limitPrice: 50_000,
    clientOrderId: `m-${randomUUID()}`, status: "open", executionEnvironment: "TESTNET", ...extra,
  } });
}

const snap = (o: { clientOrderId: string }, status: string, base: number, quote: number, id = "990011") => ({
  exchangeOrderId: id, clientOrderId: o.clientOrderId, status: status as never,
  executedBaseQuantity: base, executedQuoteQuantity: quote, averagePrice: base > 0 ? quote / base : null,
  simulated: false,
});

test("manual LIMIT BUY: one event per fill increment; duplicates and netting corrections record nothing", async () => {
  const order = await manualOrder("BUY");
  await applyManualSnapshot(order.id, snap(order, "PARTIALLY_FILLED", 0.0008, 40));
  await applyManualSnapshot(order.id, snap(order, "PARTIALLY_FILLED", 0.0008, 40)); // duplicate
  await applyManualSnapshot(order.id, snap(order, "FILLED", 0.002, 100));
  await applyManualSnapshot(order.id, snap(order, "FILLED", 0.002, 100)); // re-read after completion
  // X7 netting: same quote, lower base — not a new execution.
  await applyManualSnapshot(order.id, snap(order, "FILLED", 0.001998, 100));
  const recorded = await eventsFor(`manual:${order.id}:`);
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((e) => [e.executedBaseQty, e.executedQuoteQty, e.orderComplete, e.cumulativeBaseQty]),
    [[0.0008, 40, false, 0.0008], [0.0012, 60, true, 0.002]]);
  assert.ok(recorded.every((e) => e.side === "BUY" && e.environment === "TESTNET" && e.source === "manual"));
  const trade = await prisma.smartTrade.findUnique({ where: { manualOrderId: order.id } });
  assert.ok(recorded.every((e) => e.smartTradeId === trade?.id));
});

test("manual: rejected, canceled-without-fill and an older snapshot record nothing", async () => {
  const rejected = await manualOrder("BUY");
  await applyManualSnapshot(rejected.id, snap(rejected, "REJECTED", 0, 0));
  const canceled = await manualOrder("BUY");
  await applyManualSnapshot(canceled.id, snap(canceled, "CANCELED", 0, 0));
  assert.equal((await eventsFor(`manual:${rejected.id}:`)).length, 0);
  assert.equal((await eventsFor(`manual:${canceled.id}:`)).length, 0);

  const partlyThenCanceled = await manualOrder("BUY");
  await applyManualSnapshot(partlyThenCanceled.id, snap(partlyThenCanceled, "PARTIALLY_FILLED", 0.001, 50));
  await applyManualSnapshot(partlyThenCanceled.id, snap(partlyThenCanceled, "NEW", 0, 0)); // older, slower response
  await applyManualSnapshot(partlyThenCanceled.id, snap(partlyThenCanceled, "CANCELED", 0.001, 50));
  const recorded = await eventsFor(`manual:${partlyThenCanceled.id}:`);
  assert.equal(recorded.length, 1, "the real partial fill is announced once; the cancel is not an execution");
  assert.equal(recorded[0]!.orderComplete, false);
});

test("manual SELL of a position: SELL event linked to that position", async () => {
  const position = await prisma.smartTrade.create({ data: {
    source: "manual", exchangeAccountId: testnetAccountId, botName: "Manual", pair: "BTCUSDT",
    status: "active", entryPrice: 50_000, quantity: 0.002, quoteSpent: 100,
  } });
  const order = await manualOrder("SELL", { orderType: "MARKET", linkedPositionId: position.id,
    requestedBaseQty: 0.002, requestedQuoteQty: null, limitPrice: null, status: "submitted" });
  await applyManualSnapshot(order.id, snap(order, "FILLED", 0.002, 110, "990077"));
  const [event] = await eventsFor(`manual:${order.id}:`);
  assert.equal(event!.side, "SELL");
  assert.equal(event!.smartTradeId, position.id);
  assert.equal(event!.orderComplete, true);
});

test("manual order created before this release (no recorded environment) reads UNKNOWN", async () => {
  const order = await manualOrder("BUY", { executionEnvironment: null });
  await applyManualSnapshot(order.id, snap(order, "FILLED", 0.001, 50));
  const [event] = await eventsFor(`manual:${order.id}:`);
  assert.equal(event!.environment, "UNKNOWN");
});

// ── the feed ───────────────────────────────────────────────────────────────

test("feed (control plane, works with manual orders off): unsigned refused; a new reader gets only the cursor; pages are ordered and bounded", async () => {
  const base = "/api/manual-trading/control/executions";
  config.manualTradingEnabled = false; // control plane: strategy executions still need announcing
  assert.equal((await fetch(`${baseUrl}${base}`)).status, 401);

  const start = await (await fetch(`${baseUrl}${base}`, { headers: signedHeaders("GET", base) })).json() as
    { latestSeq: number; nextAfter: number; events: unknown[] };
  assert.equal(start.events.length, 0, "no history replay for a new reader");
  assert.ok(start.latestSeq > 0);
  assert.equal(start.nextAfter, start.latestSeq);

  const pagePath = `${base}?after=0&limit=2`;
  const page = await (await fetch(`${baseUrl}${pagePath}`, { headers: signedHeaders("GET", pagePath) })).json() as
    { nextAfter: number; events: Array<{ seq: number; eventId: string }> };
  assert.equal(page.events.length, 2);
  assert.ok(page.events[0]!.seq < page.events[1]!.seq);
  assert.equal(page.nextAfter, page.events[1]!.seq);

  const tailPath = `${base}?after=${start.latestSeq}`;
  const tail = await (await fetch(`${baseUrl}${tailPath}`, { headers: signedHeaders("GET", tailPath) })).json() as
    { nextAfter: number; events: unknown[] };
  assert.equal(tail.events.length, 0);
  assert.equal(tail.nextAfter, start.latestSeq);

  for (const bad of [`${base}?after=-1`, `${base}?limit=1000`, `${base}?after=abc`, `${base}?other=1`]) {
    const response = await fetch(`${baseUrl}${bad}`, { headers: signedHeaders("GET", bad) });
    assert.equal(response.status, 400, bad);
  }
  config.manualTradingEnabled = true;
});

test("feed payloads carry no secrets or credentials", async () => {
  const rows = await prisma.executionEvent.findMany();
  for (const row of rows) {
    assert.doesNotMatch(row.payload, /secret|apiKey|apiSecret|webhook|password|token/i);
  }
});

test("capability executions.v1 is advertised", () => {
  assert.ok(buildControlCapabilities().includes("executions.v1"));
});

test("pruning keeps the newest row so the cursor never moves backwards", async () => {
  const latest = await prisma.executionEvent.findFirst({ orderBy: { seq: "desc" } });
  const far = new Date(Date.now() + 365 * 86_400_000);
  await events.pruneExecutionEvents(far);
  const left = await prisma.executionEvent.findMany();
  assert.equal(left.length, 1);
  assert.equal(left[0]!.seq, latest!.seq);
  const feed = await events.readExecutionFeed(null, 10);
  assert.equal(feed.latestSeq, latest!.seq);
});
