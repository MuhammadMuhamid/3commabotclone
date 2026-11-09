/**
 * OD-3 — "Pause new entries" on the Bot, separate from the halt.
 *
 * One rule (`evaluateBotHalt`: entriesPaused && side !== "sell") reaches every
 * exposure-increasing path:
 *
 *   #1  webhook / Platform strategy BUY  -> 409 `risk_blocked` (no webhook-contract change),
 *       refused at the preflight, before Shariah admission (no nonce spent);
 *   #3  manual MARKET and LIMIT BUY      -> 409 `entries_paused`;
 *   #6a strategy reconciler              -> a `requested` BUY is closed off `rejected` at once;
 *   #6b manual reconciler                -> a `requested` BUY is `rejected` before submission.
 *
 * Exits are never paused: webhook / manual SELL, C6/C7, both TP/SL pollers and
 * the OD-1 cancel + sweep run. C9 (`POST /control/entries`) and the dashboard's
 * `/api/ops/entries` set a target state through one implementation, never
 * touch the halt, and `cancelWorkingEntries` reports every outcome.
 *
 * Signed loopback HTTP for the control routes (the Platform's scheme, written
 * out); real services, disposable SQLite and the in-memory fake exchange.
 */
import { after, before, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, SignalBot } from "@prisma/client";
import { binanceError, fakeBinance, type FakeBinance } from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".entries-pause-test.db");
process.env.DATABASE_URL = "file:./tests/.entries-pause-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { operationsRouter } = await import("../src/routes/operations.js");
const { createControlRateLimiters } = await import("../src/routes/manualControl.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { checkManualProtection } = await import("../src/services/manualProtection.js");
const { checkTakeProfitStopLoss } = await import("../src/services/smartTrade.js");
const strategy = await import("../src/services/strategyOrderIntent.js");
const { processWebhook } = await import("../src/services/webhook.js");
const { closeStrategyTrade, tradeExchangeClient } = await import("../src/services/tradeExit.js");
const risk = await import("../src/services/riskControls.js");

type Factory = (account: ExchangeAccount) => InstanceType<typeof BinanceManualExchange>;
const reconcileManual = manual.reconcilePendingManualOrders as unknown as
  (factory: Factory, limit?: number) => Promise<void>;
const reconcileStrategy = strategy.reconcilePendingStrategyIntents as unknown as
  (factory: unknown) => Promise<void>;

const CONTROL_SECRET = "9a2f" + "d".repeat(60);
const original = {
  dryRun: config.dryRun, manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret, factory: manual.manualControlAdapter.factory,
  resolve: tradeExchangeClient.resolve,
};
config.manualTradingHmacSecret = CONTROL_SECRET;

let server: Server;
let baseUrl = "";
before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  // `requireAuth` stands in: it sets `res.locals.userId` for an authenticated session.
  app.use("/api/ops", (_req, res, next) => { res.locals.userId = "dash-user-1"; next(); }, operationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config, { dryRun: original.dryRun, manualTradingEnabled: original.manualTradingEnabled,
    manualTradingHmacSecret: original.secret });
  manual.manualControlAdapter.factory = original.factory;
  tradeExchangeClient.resolve = original.resolve;
  tradeExchangeClient.closeFactory = null;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  mock.restoreAll();
  config.dryRun = false;
  config.manualTradingEnabled = true;
  manual.manualControlAdapter.factory = original.factory;
  tradeExchangeClient.resolve = original.resolve;
  tradeExchangeClient.closeFactory = null;
  await prisma.botControlCommand.deleteMany();
  await prisma.realizationEvent.deleteMany();
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.manualCommand.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.webhookReceipt.deleteMany();
  await prisma.pairCloseMark.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── the Platform's signing scheme, written out (as in botControl.test.ts) ────

let seq = 0;
const newRequestId = () => `req_${Date.now().toString(36)}_${(seq++).toString().padStart(6, "0")}`;
const ACTOR = {
  platformUserId: "00000000-0000-4000-8000-0000000000aa",
  stepUp: { method: "totp", at: "2026-11-09T00:00:00.000Z" },
};
const C = "/api/manual-trading/control";

async function signed(method: "GET" | "POST", p: string, body?: unknown, requestId = newRequestId()):
Promise<{ status: number; body: Record<string, unknown>; replayed: boolean }> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const canonical = [method, canonicalPath(p), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  const response = await fetch(`${baseUrl}${p}`, { method, headers: {
    "content-type": "application/json", "x-manual-timestamp": timestamp, "x-manual-nonce": nonce,
    "x-manual-request-id": requestId,
    "x-manual-signature": `v1=${createHmac("sha256", CONTROL_SECRET).update(canonical).digest("hex")}`,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {},
    replayed: response.headers.get("x-control-replayed") === "true" };
}

async function dashboard(method: "GET" | "POST", p: string, body?: unknown) {
  const response = await fetch(`${baseUrl}/api/ops${p}`, { method,
    headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const pause = (reason = "macro event", extra: Record<string, unknown> = {}, requestId?: string) =>
  signed("POST", `${C}/entries`, { paused: true, reason, ...extra, actor: ACTOR }, requestId);
const resumeEntries = (requestId?: string) =>
  signed("POST", `${C}/entries`, { paused: false, actor: ACTOR }, requestId);

// ── fixtures ────────────────────────────────────────────────────────────────

let n = 0;
async function createAccount(): Promise<ExchangeAccount> {
  n += 1;
  return prisma.exchangeAccount.create({ data: { name: `pause-${n}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}

async function createBot(account?: ExchangeAccount): Promise<SignalBot> {
  n += 1;
  return prisma.signalBot.create({ data: { name: `pause bot ${n}`,
    webhookSecret: `p${String(n).padStart(3, "0")}${"s".repeat(36)}`, pairs: JSON.stringify(["BTCUSDT"]),
    entryEnabled: true, exitEnabled: true, takeProfitEnabled: true, takeProfitPct: 5,
    stopLossEnabled: true, stopLossPct: 3, exchangeAccountId: account?.id ?? null } });
}

function factory(exchange: FakeBinance): Factory {
  return (account) => new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
}

const quiet = () => mock.method(console, "error", () => undefined);

// ════════════════════════════════════════════════════════════════════════════
// the rule
// ════════════════════════════════════════════════════════════════════════════

test("OD-3 rule: while paused every side that is not literally `sell` is refused, an operator BUY too; a SELL never; the halt is reported first",
  () => {
    const paused = { ...risk.DEFAULT_BOT_RISK_LIMITS, entriesPaused: true, entriesPausedReason: "news" };
    for (const side of ["buy", "BUY", "Sell", " sell", undefined, ""]) {
      for (const origin of ["operator", "automation"] as const) {
        const decision = risk.evaluateBotHalt(paused, { side, origin });
        assert.equal(decision.allowed, false, `side ${String(side)} / ${origin}`);
        assert.equal(!decision.allowed && decision.code, "entries_paused");
        assert.equal(!decision.allowed && decision.reason, "entries paused: news");
      }
    }
    assert.equal(risk.evaluateBotHalt(paused, { side: "sell", origin: "automation" }).allowed, true);
    assert.equal(risk.evaluateBotRisk(paused, { openExposureQuote: 0, openTrades: 0, realisedPnlInWindow: 0 },
      { side: "sell", quoteQty: 0 }).allowed, true);
    const both = risk.evaluateBotHalt({ ...paused, tradingHalted: true, haltedReason: "x" }, { side: "buy" });
    assert.equal(!both.allowed && both.code, "trading_halted");
    assert.equal(risk.shouldLatchHalt(risk.evaluateBotHalt(paused, { side: "buy" })), null,
      "a pause never latches the halt");
    assert.match(risk.describeBotRiskState(paused, { openExposureQuote: 0, openTrades: 0, realisedPnlInWindow: 0 }),
      /^ENTRIES PAUSED: news — /);
  });

// ════════════════════════════════════════════════════════════════════════════
// C9 and C0
// ════════════════════════════════════════════════════════════════════════════

test("C9: pause and resume are a target state; idempotent; the same request id replays; the actor is recorded; the halt is untouched",
  async () => {
    const requestId = newRequestId();
    const first = await pause("macro event", {}, requestId);
    assert.equal(first.status, 200);
    assert.equal(first.body.changed, true);
    const entries = first.body.entries as Record<string, unknown>;
    assert.equal(entries.paused, true);
    assert.equal(entries.reason, "macro event");
    assert.equal(entries.pausedBy, ACTOR.platformUserId);
    assert.equal(typeof entries.pausedAt, "string");
    assert.equal(first.body.canceledEntries, undefined, "no cancel without the opt-in");

    const replay = await pause("macro event", {}, requestId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, first.body);
    const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
    assert.equal(row.kind, "entries");
    assert.equal(row.actorUserId, ACTOR.platformUserId);
    assert.equal(row.status, "succeeded");

    const again = await pause("a different reason");
    assert.equal(again.body.changed, false, "already paused: the pause in force is kept");
    assert.equal((again.body.entries as Record<string, unknown>).reason, "macro event");
    assert.equal((await risk.getBotRiskLimits()).tradingHalted, false, "a pause never halts");

    const resumed = await resumeEntries();
    assert.equal(resumed.body.changed, true);
    assert.equal((resumed.body.entries as Record<string, unknown>).paused, false);
    assert.equal((resumed.body.entries as Record<string, unknown>).pausedBy, null);
    assert.equal((await resumeEntries()).body.changed, false);
  });

test("C9 schema: a pause needs a 3..200 reason; resume takes nothing else; unknown fields are 400; nothing is claimed",
  async () => {
    for (const body of [
      { paused: true, actor: ACTOR },
      { paused: true, reason: "no", actor: ACTOR },
      { paused: true, reason: "x".repeat(201), actor: ACTOR },
      { paused: false, reason: "resume with a reason", actor: ACTOR },
      { paused: false, cancelWorkingEntries: true, actor: ACTOR },
      { paused: true, reason: "macro", extra: 1, actor: ACTOR },
      { paused: "yes", reason: "macro", actor: ACTOR },
      { paused: true, reason: "macro" },
    ]) {
      const r = await signed("POST", `${C}/entries`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.code, "invalid_request");
    }
    assert.equal(await prisma.botControlCommand.count(), 0);
    assert.equal((await risk.readEntriesPause()).paused, false);
  });

test("C0: `entries` and `capabilities` are reported; the live daily-loss breach is visible while paused, with no latch",
  async () => {
    const account = await createAccount();
    const bot = await createBot();
    await prisma.manualOrder.create({ data: { requestId: "c0-working", exchangeAccountId: account.id,
      symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 50,
      limitPrice: 90, status: "open", clientOrderId: "c0-working-cid", exchangeOrderId: "1" } });
    await prisma.strategyOrderIntent.create({ data: { sourceKey: "c0-intent", botId: bot.id, botName: bot.name,
      clientOrderId: "c0-intent-cid", symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 50,
      status: "submitted" } });
    await risk.updateBotRiskLimits({ maxDailyLossQuote: 10 });
    await prisma.smartTrade.create({ data: { botName: "x", pair: "BTCUSDT", status: "closed",
      closedAt: new Date(), quantity: 1, quoteSpent: 100, pnlUsdt: -25 } });
    await pause("loss review");

    const status = await signed("GET", `${C}/status`);
    assert.equal(status.status, 200);
    const entries = status.body.entries as Record<string, unknown>;
    assert.deepEqual(Object.keys(entries).sort(),
      ["pausedAt", "pausedBy", "paused", "reason", "unresolvedBuyIntents", "workingEntryLimits"].sort());
    assert.equal(entries.paused, true);
    assert.equal(entries.workingEntryLimits, 1);
    assert.equal(entries.unresolvedBuyIntents, 1);
    assert.ok((status.body.capabilities as string[]).includes("entries.v1"));
    const riskState = status.body.risk as Record<string, unknown>;
    assert.equal(riskState.dailyLossBreached, true, "the live breach, shown while paused");
    assert.equal(riskState.latched, false, "nothing latched: no BUY was evaluated");
    assert.equal((status.body.halt as Record<string, unknown>).halted, false);
  });

// ════════════════════════════════════════════════════════════════════════════
// one refusal per entry path
// ════════════════════════════════════════════════════════════════════════════

test("#1 webhook BUY while paused: 409 risk_blocked (contract unchanged), no wire order, receipt released, no intent (no Shariah nonce spent)",
  async () => {
    quiet();
    const bot = await createBot();
    const exchange = fakeBinance();
    await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
    const outcome = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "pause-1" }, { clientFactory: async () => exchange.client });
    assert.equal(outcome.status, "risk_blocked");
    assert.match(String(outcome.detail), /^entries paused: news/);
    assert.equal(exchange.submissions.length, 0);
    assert.equal(await prisma.webhookReceipt.count(), 0, "the delivery receipt is released");
    // The single-use Shariah authorisation is spent only on the intent row.
    assert.equal(await prisma.strategyOrderIntent.count(), 0);
    const log = await prisma.webhookLog.findFirstOrThrow();
    assert.equal(log.status, "blocked");
  });

test("#1 webhook SELL while paused still exits the strategy trade", async () => {
  quiet();
  const bot = await createBot();
  const exchange = fakeBinance({ freeBase: "1" });
  await prisma.smartTrade.create({ data: { botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active",
    entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100,
    createdAt: new Date(Date.now() - 3_600_000) } });
  await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
  const outcome = await processWebhook({ secret: bot.webhookSecret, action: "sell", symbol: "BTCUSDT" },
    { clientFactory: async () => exchange.client });
  assert.equal(outcome.status, "ok");
  assert.equal(exchange.accepted("SELL").length, 1);
});

for (const orderType of ["MARKET", "LIMIT"] as const) {
  test(`#3 manual ${orderType} BUY while paused: 409 entries_paused, nothing reserved, nothing sent`, async () => {
    const account = await createAccount();
    const exchange = fakeBinance();
    await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
    const refusal = await manual.submitManualOrder({ requestId: `pause-manual-${orderType}`,
      accountId: account.id, symbol: "BTCUSDT", side: "BUY", orderType, quoteQuantity: 50,
      ...(orderType === "LIMIT" ? { limitPrice: 90 } : {}) }, factory(exchange))
      .then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof manual.ManualTradingError);
    assert.equal(refusal.httpStatus, 409);
    assert.equal(refusal.code, "entries_paused");
    assert.match(refusal.message, /Closing an open position is still allowed/);
    assert.equal(exchange.submissions.length, 0);
    assert.equal(await prisma.manualOrder.count(), 0);
  });
}

test("#3 manual SELL while paused still sells the position", async () => {
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "1" });
  const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
    botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100 } });
  await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
  const sell = await manual.submitManualOrder({ requestId: "pause-manual-sell", accountId: account.id,
    symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 1, positionId: position.id },
  factory(exchange));
  assert.equal(sell.status, "filled");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } })).status, "closed");
});

test("#6a a `requested` strategy BUY met by the reconciler while paused is closed off rejected at once, and never lands after resume",
  async () => {
    quiet();
    const bot = await createBot();
    const exchange = fakeBinance();
    const intent = await prisma.strategyOrderIntent.create({ data: { sourceKey: "pause-orphan", botId: bot.id,
      botName: bot.name, clientOrderId: "pause-orphan-cid", symbol: "BTCUSDT", side: "BUY",
      requestedQuoteQty: 50, status: "requested" } });
    await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
    await reconcileStrategy(async () => strategy.strategyMarketAdapter(exchange.client, false));
    const closed = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    assert.equal(closed.status, "rejected");
    assert.match(closed.error ?? "", /^Refused before submission: entries paused: news/);
    await risk.setEntriesPaused({ paused: false, by: "test" });
    await reconcileStrategy(async () => strategy.strategyMarketAdapter(exchange.client, false));
    assert.equal(exchange.submissions.length, 0, "it never lands after resume");
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
      "rejected");
  });

test("#6b a `requested` manual BUY met by the reconciler while paused is rejected before submission", async () => {
  const account = await createAccount();
  const exchange = fakeBinance();
  const order = await prisma.manualOrder.create({ data: { requestId: "pause-requested", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quantityType: "quote", requestedQuoteQty: 50,
    status: "requested", clientOrderId: "pause-requested-cid" } });
  await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
  await reconcileManual(factory(exchange));
  const rejected = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.error ?? "", /^refused before submission: entries paused: news/);
  assert.equal(exchange.submissions.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// exits are never paused
// ════════════════════════════════════════════════════════════════════════════

test("paused: the manual TP/SL poller still fires; the strategy TP/SL monitor still fires; C6 Close still sells",
  async () => {
    quiet();
    await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
    const account = await createAccount();
    const manualExchange = fakeBinance({ price: "111", freeBase: "1" });
    const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
      botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
      manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
    await checkManualProtection(factory(manualExchange));
    assert.equal(manualExchange.accepted("SELL").length, 1);
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } })).status, "closed");

    const bot = await createBot();
    const strategyExchange = fakeBinance({ price: "90", freeBase: "1" });
    const trade = await prisma.smartTrade.create({ data: { botId: bot.id, botName: bot.name, pair: "BTCUSDT",
      status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100,
      createdAt: new Date(Date.now() - 3_600_000) } });
    await checkTakeProfitStopLoss({ resolveClient: async () => strategyExchange.client });
    assert.equal(strategyExchange.accepted("SELL").length, 1, "the stop loss fired while paused");
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "closed");

    const closeBot = await createBot();
    const closeExchange = fakeBinance({ price: "100", freeBase: "1" });
    tradeExchangeClient.resolve = () => closeExchange.client;
    tradeExchangeClient.closeFactory = async () => closeExchange.client;
    const open = await prisma.smartTrade.create({ data: { botId: closeBot.id, botName: closeBot.name,
      pair: "BTCUSDT", status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1,
      quoteSpent: 100, createdAt: new Date(Date.now() - 3_600_000) } });
    await closeStrategyTrade(open.id);
    assert.equal(closeExchange.accepted("SELL").length, 1, "C6 / dashboard Close while paused");
  });

test("paused: the OD-1 pre-cancel, finalizer and race-fill sweep all run", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4", price: "111",
    cancelFailures: [{ error: binanceError("Execution status unknown.", -1007) }],
    lookupFailures: [new Error("socket hang up"), new Error("socket hang up")] });
  const entry = await prisma.manualOrder.create({ data: { requestId: "pause-od1", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100,
    limitPrice: 100, takeProfitPrice: 110, protectionType: "bot-managed", protectionState: "pending_entry",
    status: "open", clientOrderId: "pause-od1-cid", exchangeOrderId: "ex-pause-od1", submittedAt: new Date() } });
  exchange.seed({ clientOrderId: "pause-od1-cid", orderId: "ex-pause-od1", status: "PARTIALLY_FILLED",
    executedQty: "0.4", cummulativeQuoteQty: "40" });
  await manual.applyManualSnapshot(entry.id, { exchangeOrderId: "ex-pause-od1", clientOrderId: "pause-od1-cid",
    status: "PARTIALLY_FILLED", executedBaseQuantity: 0.4, executedQuoteQuantity: 40, averagePrice: 100,
    simulated: false });
  await risk.setEntriesPaused({ paused: true, reason: "news", by: "test" });
  await checkManualProtection(factory(exchange));
  assert.equal(exchange.cancels.length, 1, "the pre-cancel ran while paused");
  exchange.fill("pause-od1-cid", "0.7", "70", "PARTIALLY_FILLED");
  await reconcileManual(factory(exchange));
  assert.equal(exchange.cancels.length, 2, "the finalizer's cancel ran while paused");
  await checkManualProtection(factory(exchange));
  assert.equal(exchange.accepted("SELL").length, 2, "the race fill was swept while paused");
});

// ════════════════════════════════════════════════════════════════════════════
// cancelWorkingEntries, restart, the dashboard, interplay, the limiter
// ════════════════════════════════════════════════════════════════════════════

test("C9 cancelWorkingEntries (opt-in): each working manual LIMIT BUY is cancelled with the OD-1 classification; an unknown one stays visible",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ cancelFailures: [undefined,
      { error: binanceError("Execution status unknown.", -1007) }] });
    manual.manualControlAdapter.factory = factory(exchange);
    const working = [];
    for (const name of ["first", "second"]) {
      working.push(await prisma.manualOrder.create({ data: { requestId: `pause-cancel-${name}`,
        exchangeAccountId: account.id, symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote",
        requestedQuoteQty: 50, limitPrice: 90, status: "open", clientOrderId: `pause-cancel-${name}`,
        exchangeOrderId: `ex-${name}`, submittedAt: new Date() } }));
      exchange.seed({ clientOrderId: `pause-cancel-${name}`, orderId: `ex-${name}`, status: "NEW" });
    }
    const r = await pause("cancel test", { cancelWorkingEntries: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.canceledEntries, [
      { orderId: working[0]!.id, symbol: "BTCUSDT", outcome: "canceled" },
      { orderId: working[1]!.id, symbol: "BTCUSDT", outcome: "unknown" },
    ]);
    assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: working[0]!.id } })).status, "canceled");
    const unknown = await prisma.manualOrder.findUniqueOrThrow({ where: { id: working[1]!.id } });
    assert.equal(unknown.status, "open", "nothing assumed: still tracked by the reconciler");
    assert.match(unknown.exitCancelLastError ?? "", /pause cancel unknown/);
    assert.equal(exchange.submissions.length, 0, "a cancel never places an order");
  });

test("C9 cancelWorkingEntries under DRY_RUN never 'cancels' a live order by simulation (A1)", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance();
  manual.manualControlAdapter.factory = (acc) =>
    new BinanceManualExchange(acc, { client: exchange.client, dryRun: true });
  const live = await prisma.manualOrder.create({ data: { requestId: "pause-a1", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 50,
    limitPrice: 90, status: "open", clientOrderId: "pause-a1-cid", exchangeOrderId: "55555" } });
  const r = await pause("a1 test", { cancelWorkingEntries: true });
  assert.deepEqual(r.body.canceledEntries, [{ orderId: live.id, symbol: "BTCUSDT", outcome: "failed" }]);
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: live.id } })).status, "open");
  assert.equal(exchange.cancels.length, 0);
});

test("restart keeps the pause: a fresh process refuses a queued manual BUY and submits nothing", async () => {
  const account = await createAccount();
  await prisma.manualOrder.create({ data: { requestId: "pause-restart", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quantityType: "quote", requestedQuoteQty: 50,
    status: "requested", clientOrderId: "pause-restart-cid" } });
  await risk.setEntriesPaused({ paused: true, reason: "restart test", by: "test" });
  await prisma.$disconnect();
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/restartBoot.ts",
    JSON.stringify({ book: [] })], { cwd: backendRoot, env: process.env, encoding: "utf8" });
  assert.equal((JSON.parse(output.trim().split("\n").at(-1)!) as { submissions: number }).submissions, 0);
  assert.equal((await risk.readEntriesPause()).paused, true);
  assert.equal((await prisma.manualOrder.findFirstOrThrow({ where: { requestId: "pause-restart" } })).status,
    "rejected");
});

test("dashboard /api/ops/entries: the same target state, actor dashboard:<userId>; status reports it; bad bodies are 400",
  async () => {
    const paused = await dashboard("POST", "/entries", { paused: true, reason: "dashboard pause" });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.changed, true);
    assert.equal((paused.body.entries as Record<string, unknown>).pausedBy, "dashboard:dash-user-1");
    const status = await dashboard("GET", "/status");
    assert.equal((status.body.entries as Record<string, unknown>).paused, true);
    assert.equal((status.body.risk as Record<string, unknown>).entriesPaused, true);
    assert.equal(status.body.mode, "LIVE", "the pause is not a mode: the halt is not touched");
    for (const body of [{ paused: true }, { paused: true, reason: "x" }, { paused: false, reason: "no" }, {}]) {
      assert.equal((await dashboard("POST", "/entries", body)).status, 400, JSON.stringify(body));
    }
    const resumed = await dashboard("POST", "/entries", { paused: false });
    assert.equal(resumed.body.changed, true);
    assert.equal((await risk.readEntriesPause()).paused, false);
  });

test("interplay: pause, then halt, then resume trading keeps the pause; resuming entries keeps the halt", async () => {
  await dashboard("POST", "/entries", { paused: true, reason: "pause first" });
  assert.equal((await dashboard("POST", "/halt", { confirmation: "HALT_TRADING", reason: "then halt" })).status, 200);
  assert.equal((await dashboard("POST", "/resume", { confirmation: "RESUME_TRADING" })).status, 200);
  let limits = await risk.getBotRiskLimits();
  assert.equal(limits.tradingHalted, false);
  assert.equal(limits.entriesPaused, true, "resuming trading never lifts the pause");
  await dashboard("POST", "/halt", { confirmation: "HALT_TRADING", reason: "halt again" });
  await dashboard("POST", "/entries", { paused: false });
  limits = await risk.getBotRiskLimits();
  assert.equal(limits.entriesPaused, false);
  assert.equal(limits.tradingHalted, true, "resuming entries never lifts the halt");
  assert.equal(limits.haltedReason, "halt again");
});

test("C9 has the control channel's own write limiter: a throttled command is 429 bot_rate_limited and not executed",
  async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/manual-trading/control", ...createControlRateLimiters({ writeMax: 1 }));
    app.use("/api/manual-trading", manualTradingRouter);
    const limited: Server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const previous = baseUrl;
    baseUrl = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      assert.equal((await pause("limited")).status, 200);
      const throttled = await resumeEntries();
      assert.equal(throttled.status, 429);
      assert.equal(throttled.body.code, "bot_rate_limited");
      assert.equal((await risk.readEntriesPause()).paused, true, "the throttled resume did not run");
    } finally {
      baseUrl = previous;
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
