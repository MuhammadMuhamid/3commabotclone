/**
 * D2 — uncertain exchange outcomes.
 *
 * A Binance answer that does not prove "not executed" (-1006, -1007, any 5xx,
 * a code-less transport failure, a timeout, an unknown code) must leave the
 * order pending and reconcilable by its ORIGINAL deterministic client order id.
 * Only a whitelist of definite rejections may be booked `rejected`. While a BUY
 * is unresolved, no second exposure may be opened for the same bot and pair.
 *
 * Real services + a disposable migrated SQLite file + an in-memory fake
 * exchange (`helpers/fakeBinance.ts`). No network: `config.dryRun` is flipped
 * off in-process only so the non-dry code paths run against the fake.
 */
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, SignalBot, SmartTrade } from "@prisma/client";
import {
  binanceError, fakeBinance, fetchFailed, htmlStatusError, timeoutError, type FakeBinance,
} from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".d2-uncertain-test.db");
process.env.DATABASE_URL = "file:./tests/.d2-uncertain-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const binance = await import("../src/services/binance.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { checkManualProtection } = await import("../src/services/manualProtection.js");
const strategy = await import("../src/services/strategyOrderIntent.js");
const { processWebhook } = await import("../src/services/webhook.js");
const risk = await import("../src/services/riskControls.js");

const { submitManualOrder, cancelManualOrder, ManualTradingError } = manual;
const { strategyMarketAdapter } = strategy;

// Reached dynamically so that, against the unfixed code, each test fails on its
// own assertion instead of the whole file failing to load.
type Reconcile = (factory: unknown, limit?: number, options?: { now?: number }) => Promise<void>;
const reconcileManual = manual.reconcilePendingManualOrders as unknown as Reconcile;
const reconcileStrategy = strategy.reconcilePendingStrategyIntents as unknown as
  (factory: unknown, limit?: number, now?: number) => Promise<void>;
const runCommand = manual.runIdempotentManualCommand as unknown as <T>(
  requestId: string, kind: string, action: () => Promise<T>, options?: { body?: unknown }) => Promise<T>;
const readSnapshot = risk.readBotRiskSnapshot as unknown as (hours: number) =>
  Promise<{ openExposureQuote: number; openTrades: number }>;

const originalDryRun = config.dryRun;
const originalManual = config.manualTradingEnabled;
config.dryRun = false;
config.manualTradingEnabled = true;

after(async () => {
  config.dryRun = originalDryRun;
  config.manualTradingEnabled = originalManual;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
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

// ── fixtures ────────────────────────────────────────────────────────────────

const UNCERTAIN = [
  { name: "-1006", make: () => binanceError(
    "An unexpected response was received from the message bus. Execution status unknown.", -1006) },
  { name: "-1007", make: () => binanceError(
    "Timeout waiting for response from backend server. Send status unknown; execution status unknown.",
    -1007) },
  { name: "HTTP 503 (non-JSON body)", make: () => htmlStatusError(503) },
  { name: "TypeError: fetch failed", make: fetchFailed },
  { name: "timeout", make: timeoutError },
];

let accountSeq = 0;
async function createAccount(): Promise<ExchangeAccount> {
  accountSeq += 1;
  return prisma.exchangeAccount.create({ data: {
    name: `d2-${accountSeq}`, exchange: "binance", marketType: "spot",
    apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true,
  } });
}

let botSeq = 0;
async function createBot(overrides: Record<string, unknown> = {}): Promise<SignalBot> {
  botSeq += 1;
  return prisma.signalBot.create({ data: {
    name: `d2 bot ${botSeq}`, webhookSecret: `d2-strategy-secret-${botSeq}-${"x".repeat(24)}`,
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, exitEnabled: true, ...overrides,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function manualPosition(account: ExchangeAccount, quantity = 1,
  extra: Record<string, unknown> = {}): Promise<SmartTrade> {
  return prisma.smartTrade.create({ data: {
    source: "manual", exchangeAccountId: account.id, botName: "Manual", pair: "BTCUSDT",
    status: "active", direction: "long", entryPrice: 100, buyPrice: 100, currentPrice: 100,
    quantity, quoteSpent: quantity * 100, ...extra,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

function manualFactory(exchange: FakeBinance) {
  return (account: ExchangeAccount) =>
    new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
}

function strategyFactory(exchange: FakeBinance) {
  return async () => strategyMarketAdapter(exchange.client, false);
}

const minutes = (n: number) => n * 60_000;

// ── 1. the classifier ───────────────────────────────────────────────────────

test("D2 classifier: one whitelist of definite rejections; everything else is uncertain", () => {
  const classify = (binance as unknown as {
    classifyExchangeFailure?: (error: unknown) => { outcome: string };
  }).classifyExchangeFailure;
  assert.equal(typeof classify, "function", "binance.ts exports classifyExchangeFailure");
  const outcome = (error: unknown) => classify!(error).outcome;
  const coded = (code: unknown, message = "Binance said no") => binanceError(message, code);

  for (const code of [-1013, -1100, -1111, -1121, -1131, -1021, -1022, -1002, -2014, -2015,
    -1003, -1015]) {
    assert.equal(outcome(coded(code)), "rejected", `${code} is a definite rejection`);
  }
  assert.equal(outcome(coded(-2010, "Account has insufficient balance for requested action.")),
    "rejected");
  assert.equal(outcome(coded(-2010, "Duplicate order sent.")), "duplicate");
  assert.equal(outcome(htmlStatusError(429)), "rejected", "HTTP 429 is the rate limiter refusing");
  assert.equal(outcome(htmlStatusError(418)), "rejected", "HTTP 418 is an IP ban refusing");

  for (const code of [-1006, -1007, -1000, -1001, -1008, -1099, -9999, -2013, -1099]) {
    assert.equal(outcome(coded(code)), "uncertain", `${code} does not prove "not executed"`);
  }
  assert.equal(outcome(coded("ECONNRESET")), "uncertain", "a non-numeric code is not a Binance code");
  assert.equal(outcome(new Error("socket hang up")), "uncertain");
  assert.equal(outcome(fetchFailed()), "uncertain");
  assert.equal(outcome(timeoutError()), "uncertain", "a DOMException code is not a Binance code");
  assert.equal(outcome(htmlStatusError(502)), "uncertain");
  assert.equal(outcome(htmlStatusError(503)), "uncertain");
  // Local refusals raised before any wire call are definite.
  assert.equal(outcome(new binance.MinNotionalError(5, 1, "BTCUSDT")), "rejected");
  // The wrapped form keeps the classification of the raw answer.
  assert.equal(outcome(new binance.ExchangeError("x", -1007, "BTCUSDT")), "uncertain");
  assert.equal(outcome(new binance.ExchangeError("x", -1013, "BTCUSDT")), "rejected");
  assert.equal(outcome(new binance.ExchangeError("Duplicate order sent.", -2010, "BTCUSDT")),
    "duplicate");
});

test("D2/OD-1 cancel classifier: -2011 -> query; the definite whitelist -> not cancelled; everything else -> unknown",
  () => {
    const classify = (binance as unknown as {
      classifyCancelFailure?: (error: unknown) => { outcome: string };
    }).classifyCancelFailure;
    assert.equal(typeof classify, "function", "binance.ts exports classifyCancelFailure");
    const outcome = (error: unknown) => classify!(error).outcome;
    assert.equal(outcome(binanceError("Unknown order sent.", -2011)), "query");
    for (const code of [-1002, -1003, -1015, -1021, -1022, -1100, -1131, -2014, -2015]) {
      assert.equal(outcome(binanceError("refused", code)), "not_canceled", `${code}: not processed`);
    }
    assert.equal(outcome(htmlStatusError(429)), "not_canceled");
    for (const error of [binanceError("x", -1006), binanceError("x", -1007), binanceError("x", -1000),
      binanceError("x", -2013), htmlStatusError(502), fetchFailed(), timeoutError(), new Error("?"),
      binanceError("Duplicate order sent.", -2010)]) {
      assert.equal(outcome(error), "unknown", "a cancel that may have been applied is never assumed either way");
    }
  });

// ── 2. every manual submit path, for every uncertain answer ──────────────────

const MANUAL_PATHS = [
  { name: "LIMIT BUY", side: "BUY" as const, orderType: "LIMIT" as const },
  { name: "MARKET BUY", side: "BUY" as const, orderType: "MARKET" as const },
  { name: "MARKET SELL", side: "SELL" as const, orderType: "MARKET" as const },
  { name: "LIMIT SELL", side: "SELL" as const, orderType: "LIMIT" as const },
];

for (const pathCase of MANUAL_PATHS) {
  for (const failure of UNCERTAIN) {
    test(`D2 manual ${pathCase.name} + ${failure.name}: stays submitted, is looked up, never re-sent`,
      async () => {
        const account = await createAccount();
        const exchange = fakeBinance({ freeBase: "1", orderFailures: [{ error: failure.make() }] });
        const position = pathCase.side === "SELL" ? await manualPosition(account, 1) : null;
        const order = await submitManualOrder({
          requestId: `d2-${pathCase.name.replace(" ", "-")}-${failure.name.length}-${accountSeq}`,
          accountId: account.id, symbol: "BTCUSDT", side: pathCase.side, orderType: pathCase.orderType,
          ...(pathCase.side === "BUY" ? { quoteQuantity: 100 } : { baseQuantity: 1, positionId: position!.id }),
          ...(pathCase.orderType === "LIMIT" ? { limitPrice: 100 } : {}),
        }, manualFactory(exchange));
        assert.equal(exchange.submissions.length, 1);
        assert.equal(order.status, "submitted", "an uncertain answer is not a rejection");
        assert.equal(order.completedAt, null);
        assert.ok(order.error, "the error text is recorded");

        const lookupsBefore = exchange.lookups.length;
        await reconcileManual(manualFactory(exchange));
        const row = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
        assert.equal(row.status, "submitted", "a miss inside the settle window keeps it pending");
        assert.ok(exchange.lookups.length > lookupsBefore, "reconciliation looks it up");
        assert.ok(exchange.lookups.every((id) => id === order.clientOrderId),
          "by the ORIGINAL deterministic client order id");
        assert.equal(exchange.submissions.length, 1, "and never resubmits it");
        if (position) {
          const held = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
          assert.equal(held.status, "active");
          assert.equal(held.quantity, 1);
        }
      });
  }
}

// ── 3. strategy webhook BUY and SELL (the dashboard Close uses the SELL) ─────

for (const failure of UNCERTAIN) {
  test(`D2 strategy webhook BUY + ${failure.name}: intent stays submitted, receipt kept, looked up`,
    async () => {
      const bot = await createBot();
      const exchange = fakeBinance({ orderFailures: [{ error: failure.make() }] });
      await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "buy",
        symbol: "BTCUSDT", quote_order_qty: 50, dedupe_key: "L-1" },
      { clientFactory: async () => exchange.client }));
      const intent = await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } });
      assert.equal(intent.status, "submitted");
      assert.equal(intent.reconciledAt, null);
      assert.ok(intent.error);
      assert.equal(await prisma.webhookReceipt.count(), 1, "the delivery receipt is retained");

      const lookupsBefore = exchange.lookups.length;
      await reconcileStrategy(strategyFactory(exchange));
      assert.ok(exchange.lookups.length > lookupsBefore);
      assert.equal(exchange.submissions.length, 1);
      assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } }))
        .status, "submitted");
    });

  test(`D2 strategy SELL / dashboard Close + ${failure.name}: stays submitted, trade untouched`,
    async () => {
      const bot = await createBot();
      const trade = await prisma.smartTrade.create({ data: { botId: bot.id, botName: bot.name,
        pair: "BTCUSDT", status: "active", direction: "long", quantity: 1, quoteSpent: 100,
        entryPrice: 100, buyPrice: 100, currentPrice: 100 } });
      const exchange = fakeBinance({ freeBase: "1", orderFailures: [{ error: failure.make() }] });
      await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "sell",
        symbol: "BTCUSDT", quantity: 1 }, { skipExitCheck: true,
        clientFactory: async () => exchange.client }));
      const intent = await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } });
      assert.equal(intent.status, "submitted", "not rejected: the SELL may have executed");
      await reconcileStrategy(strategyFactory(exchange));
      assert.equal(exchange.submissions.length, 1, "no second SELL");
      const still = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
      assert.equal(still.status, "active");
      assert.equal(still.quantity, 1);
    });
}

// ── 4. the manual TP/SL protection SELL ──────────────────────────────────────

for (const failure of UNCERTAIN) {
  test(`D2 protection SELL + ${failure.name}: exit marked submitted before the wire, queried, never re-sent`,
    async () => {
      const account = await createAccount();
      const position = await manualPosition(account, 1, { manualTpPrice: 110,
        protectionType: "bot-managed", protectionState: "active" });
      const exchange = fakeBinance({ price: "111", freeBase: "1",
        orderFailures: [{ error: failure.make() }] });
      await checkManualProtection(manualFactory(exchange));
      const exit = await prisma.manualOrder.findFirstOrThrow({
        where: { linkedPositionId: position.id } });
      assert.equal(exit.status, "submitted", "the wire was crossed, so the row must say so");
      assert.ok(exit.submittedAt);
      const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
        where: { clientOrderId: exit.clientOrderId } });
      assert.equal(attempt.status, "open");

      await checkManualProtection(manualFactory(exchange));
      await reconcileManual(manualFactory(exchange));
      assert.equal(exchange.submissions.length, 1, "no second SELL under any client order id");
      assert.ok(exchange.lookups.includes(exit.clientOrderId), "the exit was queried instead");
      assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } })).status,
        "active");
    });
}

// ── 5. eventual outcomes of an uncertain manual LIMIT BUY ────────────────────

async function uncertainLimitBuy(requestId: string, exchange: FakeBinance) {
  const account = await createAccount();
  const order = await submitManualOrder({ requestId, accountId: account.id, symbol: "BTCUSDT",
    side: "BUY", orderType: "LIMIT", quoteQuantity: 100, limitPrice: 100 }, manualFactory(exchange));
  assert.equal(order.status, "submitted");
  return order;
}

const minus1007 = () => binanceError("Send status unknown; execution status unknown.", -1007);

for (const outcome of [
  { name: "FILLED", status: "FILLED", qty: "1", quote: "100", expect: "filled", trade: 1 },
  { name: "PARTIALLY_FILLED", status: "PARTIALLY_FILLED", qty: "0.4", quote: "40",
    expect: "partially_filled", trade: 0.4 },
  { name: "CANCELED with no fill", status: "CANCELED", qty: "0", quote: "0", expect: "canceled",
    trade: 0 },
  { name: "EXPIRED with no fill", status: "EXPIRED", qty: "0", quote: "0", expect: "canceled",
    trade: 0 },
]) {
  test(`D2 manual eventual ${outcome.name}: reconciliation applies what the exchange reports`,
    async () => {
      const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
      const order = await uncertainLimitBuy(`d2-eventual-${outcome.status}`, exchange);
      exchange.seed({ clientOrderId: order.clientOrderId, side: "BUY", type: "LIMIT",
        status: outcome.status, executedQty: outcome.qty, cummulativeQuoteQty: outcome.quote });
      await reconcileManual(manualFactory(exchange));
      const row = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, outcome.expect);
      const trades = await prisma.smartTrade.findMany({ where: { manualOrderId: order.id } });
      assert.equal(trades.length, outcome.trade > 0 ? 1 : 0);
      if (outcome.trade > 0) assert.ok(Math.abs(trades[0]!.quantity - outcome.trade) < 1e-9);
      assert.equal(exchange.submissions.length, 1);
    });
}

test("D2 manual not-found: pending inside 60 s, rejected/ABSENT after — the existing SELL rule",
  async () => {
    const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
    const order = await uncertainLimitBuy("d2-absent", exchange);
    const submittedAt = order.submittedAt!.getTime();
    await reconcileManual(manualFactory(exchange), 100, { now: submittedAt + 30_000 });
    assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      "submitted");
    await reconcileManual(manualFactory(exchange), 100, { now: submittedAt + 61_000 });
    const closed = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(closed.status, "rejected");
    assert.ok(closed.completedAt);
    assert.match(closed.error ?? "", /ABSENT/);
    assert.match(closed.error ?? "", /60/);
    assert.equal(exchange.submissions.length, 1, "absence licensed no resubmission");
  });

test("D2 manual lookup failures never close an order and alert after N consecutive cycles",
  async (t) => {
    const lookupDown = () => fetchFailed();
    const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }],
      lookupFailures: [lookupDown(), lookupDown(), lookupDown(), lookupDown()] });
    const order = await uncertainLimitBuy("d2-lookup-down", exchange);
    const errors = t.mock.method(console, "error", () => undefined);
    const far = order.submittedAt!.getTime() + minutes(10);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await reconcileManual(manualFactory(exchange), 100, { now: far });
    }
    const row = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, "submitted", "a failed lookup is not evidence of absence");
    assert.match(row.error ?? "", /4 consecutive/);
    const alerts = errors.mock.calls.filter((call) => /ALERT/.test(String(call.arguments[0])));
    assert.equal(alerts.length, 1, "one bounded alert, at the threshold");
    mock.restoreAll();
  });

// ── 6. eventual outcomes of an uncertain strategy BUY ─────────────────────────

async function uncertainStrategyBuy(exchange: FakeBinance, dedupe = "L-1") {
  const bot = await createBot();
  await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: dedupe }, { clientFactory: async () => exchange.client }));
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } });
  assert.equal(intent.status, "submitted");
  return { bot, intent };
}

test("D2 strategy BUY eventually FILLED: reconciled once into one SmartTrade", async () => {
  const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  const { bot, intent } = await uncertainStrategyBuy(exchange);
  exchange.seed({ clientOrderId: intent.clientOrderId, side: "BUY", type: "MARKET",
    status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "50" });
  await reconcileStrategy(strategyFactory(exchange));
  await reconcileStrategy(strategyFactory(exchange));
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } }))
    .status, "reconciled");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
  assert.equal(exchange.submissions.length, 1);
});

test("D2 strategy BUY absent after 60 s is closed off rejected/ABSENT, and only then may a fresh BUY go",
  async () => {
    const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
    const { bot, intent } = await uncertainStrategyBuy(exchange);
    const submittedAt = intent.submittedAt!.getTime();
    await reconcileStrategy(strategyFactory(exchange), 100, submittedAt + 30_000);
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } }))
      .status, "submitted");
    await reconcileStrategy(strategyFactory(exchange), 100, submittedAt + 61_000);
    const closed = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    assert.equal(closed.status, "rejected");
    assert.equal(closed.exchangeStatus, "ABSENT");
    const fresh = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "L-2" }, { clientFactory: async () => exchange.client });
    assert.equal(fresh.status, "ok");
    assert.equal(exchange.submissions.length, 2);
  });

test("D2 strategy BUY that ended EXPIRED with no fill is closed off as that terminal status", async () => {
  const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  const { intent } = await uncertainStrategyBuy(exchange);
  exchange.seed({ clientOrderId: intent.clientOrderId, side: "BUY", type: "MARKET",
    status: "EXPIRED", executedQty: "0", cummulativeQuoteQty: "0" });
  await reconcileStrategy(strategyFactory(exchange));
  const closed = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
  assert.equal(closed.status, "rejected");
  assert.equal(closed.exchangeStatus, "EXPIRED");
});

test("D2 strategy BUY that ended EXPIRED with a partial fill books exactly what filled", async () => {
  const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  const { bot, intent } = await uncertainStrategyBuy(exchange);
  exchange.seed({ clientOrderId: intent.clientOrderId, side: "BUY", type: "MARKET",
    status: "EXPIRED", executedQty: "0.2", cummulativeQuoteQty: "20" });
  await reconcileStrategy(strategyFactory(exchange));
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } }))
    .status, "reconciled");
  const trade = await prisma.smartTrade.findFirstOrThrow({ where: { botId: bot.id } });
  assert.ok(Math.abs(trade.quantity - 0.2) < 1e-9);
  assert.equal(trade.quoteSpent, 20);
});

test("D2 strategy BUY lookup failures stay pending and alert after N consecutive cycles", async (t) => {
  const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }],
    lookupFailures: [fetchFailed(), fetchFailed(), fetchFailed(), fetchFailed(), fetchFailed()] });
  const { intent } = await uncertainStrategyBuy(exchange);
  const errors = t.mock.method(console, "error", () => undefined);
  const far = intent.submittedAt!.getTime() + minutes(10);
  for (let cycle = 0; cycle < 4; cycle += 1) await reconcileStrategy(strategyFactory(exchange), 100, far);
  const row = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
  assert.equal(row.status, "submitted");
  assert.equal(errors.mock.calls.filter((c) => /ALERT/.test(String(c.arguments[0]))).length, 1);
  mock.restoreAll();
});

// ── 7. definite rejections stay rejected ─────────────────────────────────────

for (const definite of [
  { name: "-2010 insufficient balance",
    make: () => binanceError("Account has insufficient balance for requested action.", -2010) },
  { name: "-1013 filter failure", make: () => binanceError("Filter failure: NOTIONAL", -1013) },
  { name: "-1121 invalid symbol", make: () => binanceError("Invalid symbol.", -1121) },
  { name: "-2015 invalid key/permissions",
    make: () => binanceError("Invalid API-key, IP, or permissions for action.", -2015) },
  { name: "-1003 rate limit", make: () => binanceError("Too much request weight used.", -1003) },
  { name: "-1021 timestamp", make: () => binanceError("Timestamp outside recvWindow.", -1021) },
]) {
  test(`D2 definite ${definite.name}: manual LIMIT BUY rejected, never looked up`, async () => {
    const exchange = fakeBinance({ orderFailures: [{ error: definite.make() }] });
    const account = await createAccount();
    const order = await submitManualOrder({ requestId: `d2-definite-${definite.name.slice(0, 5)}`,
      accountId: account.id, symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT",
      quoteQuantity: 100, limitPrice: 100 }, manualFactory(exchange));
    assert.equal(order.status, "rejected");
    assert.ok(order.completedAt);
    await reconcileManual(manualFactory(exchange));
    assert.equal(exchange.lookups.length, 0);
  });

  test(`D2 definite ${definite.name}: strategy BUY rejected, receipt released`, async () => {
    const bot = await createBot();
    const exchange = fakeBinance({ orderFailures: [{ error: definite.make() }] });
    await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "buy",
      symbol: "BTCUSDT", quote_order_qty: 50, dedupe_key: "L-def" },
    { clientFactory: async () => exchange.client }));
    assert.equal((await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } }))
      .status, "rejected");
    assert.equal(await prisma.webhookReceipt.count(), 0);
  });
}

// ── 8. "Duplicate order sent." and cancel -2011 ──────────────────────────────

test("D2 duplicate: a manual LIMIT BUY answered \"Duplicate order sent.\" is resolved by client id",
  async () => {
    const account = await createAccount();
    const requestId = "d2-duplicate-limit";
    const cid = binance.clientOrderId(`manual:${requestId}`);
    const exchange = fakeBinance();
    exchange.seed({ clientOrderId: cid, side: "BUY", type: "LIMIT", status: "NEW" });
    const order = await submitManualOrder({ requestId, accountId: account.id, symbol: "BTCUSDT",
      side: "BUY", orderType: "LIMIT", quoteQuantity: 100, limitPrice: 100 }, manualFactory(exchange));
    assert.equal(order.status, "open", "the existing order was found and applied");
    assert.ok(exchange.lookups.includes(cid));
  });

test("D2 duplicate: a manual MARKET BUY answered \"Duplicate order sent.\" recovers the earlier fill",
  async () => {
    const account = await createAccount();
    const requestId = "d2-duplicate-market";
    const cid = binance.clientOrderId(`manual:${requestId}`);
    const exchange = fakeBinance();
    exchange.seed({ clientOrderId: cid, side: "BUY", type: "MARKET", status: "FILLED",
      executedQty: "1", cummulativeQuoteQty: "100" });
    const order = await submitManualOrder({ requestId, accountId: account.id, symbol: "BTCUSDT",
      side: "BUY", orderType: "MARKET", quoteQuantity: 100 }, manualFactory(exchange));
    assert.equal(order.status, "filled");
    assert.equal(await prisma.smartTrade.count({ where: { manualOrderId: order.id } }), 1);
  });

test("D2 cancel -2011 with nothing found: a coded refusal, never a 500, and nothing regresses",
  async () => {
    const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
    const order = await uncertainLimitBuy("d2-cancel-absent", exchange);
    const refusal = await cancelManualOrder(order.id, undefined, manualFactory(exchange))
      .then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof ManualTradingError, "a typed, coded refusal");
    assert.equal(refusal.httpStatus, 409);
    assert.equal((refusal as unknown as { code?: string }).code, "order_not_found_at_exchange");
    assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).status,
      "submitted");
  });

// ── 9. no second exposure while a BUY is unresolved ──────────────────────────

for (const first of [
  { name: "coded -1007", make: minus1007 },
  { name: "code-less socket hang up", make: () => new Error("socket hang up") },
]) {
  test(`D2 a fresh BUY signal while a ${first.name} BUY is unresolved is risk_blocked, no wire order`,
    async () => {
      const exchange = fakeBinance({ orderFailures: [{ error: first.make() }] });
      const { bot } = await uncertainStrategyBuy(exchange);
      const second = await processWebhook({ secret: bot.webhookSecret, action: "buy",
        symbol: "BTCUSDT", quote_order_qty: 50, dedupe_key: "L-2" },
      { clientFactory: async () => exchange.client }).catch((error: Error) => ({ status: error.message }));
      assert.equal(second.status, "risk_blocked");
      assert.equal(exchange.submissions.length, 1, "no second wire BUY");
      assert.equal(await prisma.strategyOrderIntent.count({ where: { botId: bot.id } }), 1);
    });
}

test("D2 the account risk snapshot counts an unresolved strategy BUY's exposure", async () => {
  const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  await uncertainStrategyBuy(exchange);
  const snapshot = await readSnapshot(24);
  assert.equal(snapshot.openExposureQuote, 50);
  assert.equal(snapshot.openTrades, 1);
});

// ── 10. the manual idempotent command ────────────────────────────────────────

test("D2 a stale `processing` command is never re-run: a coded outcome-unknown answer instead",
  async () => {
    await prisma.manualCommand.create({ data: { requestId: "stale-cmd", kind: "submit_order" } });
    await prisma.$executeRaw`UPDATE ManualCommand SET updatedAt = ${new Date(Date.now() - 60_000)}
      WHERE requestId = 'stale-cmd'`;
    let runs = 0;
    const answer = await runCommand("stale-cmd", "submit_order", async () => ({ run: ++runs }),
      { body: { a: 1 } }).then(() => null, (error: unknown) => error);
    assert.equal(runs, 0, "the first attempt may have reached the exchange; it is not repeated");
    assert.ok(answer instanceof ManualTradingError);
    assert.equal(answer.httpStatus, 409);
    assert.equal((answer as unknown as { code?: string }).code, "command_outcome_unknown");
  });

test("D2 a reused request id with a different body is refused 409; the same body replays", async () => {
  let runs = 0;
  const first = await runCommand("reuse-cmd", "submit_order", async () => ({ run: ++runs }),
    { body: { side: "BUY", quoteQuantity: 10 } });
  const replay = await runCommand("reuse-cmd", "submit_order", async () => ({ run: ++runs }),
    { body: { quoteQuantity: 10, side: "BUY" } });
  assert.deepEqual(replay, first, "key order does not change the body");
  const mismatch = await runCommand("reuse-cmd", "submit_order", async () => ({ run: ++runs }),
    { body: { side: "BUY", quoteQuantity: 99 } }).then(() => null, (error: unknown) => error);
  assert.ok(mismatch instanceof ManualTradingError);
  assert.equal(mismatch.httpStatus, 409);
  assert.equal((mismatch as unknown as { code?: string }).code, "request_id_reused");
  assert.equal(runs, 1);
});

test("D2 re-running a manual submit under one request id reuses one order and one client id",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance();
    const input = { requestId: "d2-rerun", accountId: account.id, symbol: "BTCUSDT", side: "BUY" as const,
      orderType: "LIMIT" as const, quoteQuantity: 100, limitPrice: 100 };
    const first = await submitManualOrder(input, manualFactory(exchange));
    const again = await submitManualOrder(input, manualFactory(exchange));
    assert.equal(again.id, first.id);
    assert.equal(again.clientOrderId, first.clientOrderId);
    assert.equal(exchange.submissions.length, 1);
    await assert.rejects(prisma.manualOrder.create({ data: { requestId: "other", exchangeAccountId: account.id,
      symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote",
      clientOrderId: first.clientOrderId } }), /Unique constraint/);
  });

// ── 11. restart ──────────────────────────────────────────────────────────────

test("D2 restart: boot reconcilers in a fresh process pick up uncertain orders and intents", async () => {
  const manualExchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  const order = await uncertainLimitBuy("d2-restart", manualExchange);
  const strategyExchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
  const { bot, intent } = await uncertainStrategyBuy(strategyExchange);
  await prisma.$disconnect();

  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/restartBoot.ts",
    JSON.stringify({ book: [
      { clientOrderId: order.clientOrderId, side: "BUY", type: "LIMIT", status: "FILLED",
        executedQty: "1", cummulativeQuoteQty: "100" },
      { clientOrderId: intent.clientOrderId, side: "BUY", type: "MARKET", status: "FILLED",
        executedQty: "0.5", cummulativeQuoteQty: "50" },
    ] })], { cwd: backendRoot, env: process.env, encoding: "utf8" });
  const restarted = JSON.parse(output.trim().split("\n").at(-1)!) as { submissions: number; lookups: number };
  assert.equal(restarted.submissions, 0, "recovery never resubmits");
  assert.ok(restarted.lookups >= 2);
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "filled");
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    "reconciled");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
});

// ── review round 1 (F2, F6, F9) ──────────────────────────────────────────────

test("D2/F2 a BUY the first-submit gate refuses at admission is closed off, so the next fresh signal is admitted",
  async () => {
    const bot = await createBot();
    const exchange = fakeBinance();
    // Entry is switched off between the reservation and the first-submit gate.
    await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "L-gate" }, { clientFactory: async () => exchange.client,
      strategyCrashHooks: { afterIntentPersisted: async () => {
        await prisma.signalBot.update({ where: { id: bot.id }, data: { entryEnabled: false } });
      } } }), /Entry orders disabled/);
    const refused = await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } });
    assert.equal(refused.status, "rejected", "it provably never reached the wire");
    assert.equal(refused.exchangeStatus, "ABSENT");
    assert.equal(exchange.submissions.length, 0);

    await prisma.signalBot.update({ where: { id: bot.id }, data: { entryEnabled: true } });
    const fresh = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "L-next" }, { clientFactory: async () => exchange.client });
    assert.equal(fresh.status, "ok", "not risk_blocked by the refused intent");
    // The refused intent is terminal: no later sweep places it as a second entry.
    await reconcileStrategy(strategyFactory(exchange));
    assert.equal(exchange.submissions.length, 1, "exactly one BUY, no duplicate exposure");
    assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
  });

test("D2/F6 a stale submit_order replays the existing order's current state and never re-executes",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ orderFailures: [{ error: minus1007() }] });
    const order = await uncertainLimitBuy("f6-submit", exchange);
    await prisma.manualCommand.create({ data: { requestId: "f6-submit", kind: "submit_order" } });
    await prisma.$executeRaw`UPDATE ManualCommand SET updatedAt = ${new Date(Date.now() - 60_000)}
      WHERE requestId = 'f6-submit'`;
    let runs = 0;
    const replay = await runCommand("f6-submit", "submit_order", async () => { runs += 1; return null; },
      { body: { accountId: account.id } }) as unknown as { id: string; status: string };
    assert.equal(runs, 0);
    assert.equal(replay.id, order.id);
    assert.equal(replay.status, "submitted", "the current state, still pending reconciliation");
    assert.equal(exchange.submissions.length, 1);
  });

test("D2/F6 a stale cancel_order re-runs safely (idempotent against the order); update_protection does not",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance();
    const order = await submitManualOrder({ requestId: "f6-limit", accountId: account.id, symbol: "BTCUSDT",
      side: "BUY", orderType: "LIMIT", quoteQuantity: 100, limitPrice: 100 }, manualFactory(exchange));
    assert.equal(order.status, "open");
    // The first cancel reached the exchange, then the process died before any local write.
    exchange.book.get(order.clientOrderId)!.status = "CANCELED";
    await prisma.manualCommand.create({ data: { requestId: "f6-cancel", kind: "cancel_order" } });
    await prisma.$executeRaw`UPDATE ManualCommand SET updatedAt = ${new Date(Date.now() - 60_000)}
      WHERE requestId = 'f6-cancel'`;
    const body = { orderId: order.id };
    const canceled = await runCommand("f6-cancel", "cancel_order",
      () => cancelManualOrder(order.id, undefined, manualFactory(exchange)), { body });
    assert.equal(canceled.status, "canceled", "-2011, resolved by query: the same final state");
    const again = await runCommand("f6-cancel", "cancel_order",
      () => cancelManualOrder(order.id, undefined, manualFactory(exchange)), { body });
    assert.deepEqual(again, JSON.parse(JSON.stringify(canceled)), "now a plain replay");
    assert.equal(exchange.submissions.length, 1, "a cancel never places an order");

    await prisma.manualCommand.create({ data: { requestId: "f6-protect", kind: "update_protection" } });
    await prisma.$executeRaw`UPDATE ManualCommand SET updatedAt = ${new Date(Date.now() - 60_000)}
      WHERE requestId = 'f6-protect'`;
    let runs = 0;
    const refusal = await runCommand("f6-protect", "update_protection", async () => ++runs,
      { body: { positionId: "p", stopLossPrice: 90 } }).then(() => null, (error: unknown) => error);
    assert.equal(runs, 0, "a stale absolute-level write could overwrite a newer edit");
    assert.equal((refusal as { code?: string }).code, "command_outcome_unknown");
  });

for (const pathCase of [
  { name: "manual LIMIT BUY", side: "BUY" as const, orderType: "LIMIT" as const },
  { name: "manual MARKET BUY", side: "BUY" as const, orderType: "MARKET" as const },
  { name: "manual MARKET SELL", side: "SELL" as const, orderType: "MARKET" as const },
]) {
  test(`D2/F9 ${pathCase.name}: a failed exchange-rules read before the wire is a definite rejection`,
    async () => {
      const account = await createAccount();
      const exchange = fakeBinance({ freeBase: "1" });
      (exchange.client as unknown as Record<string, unknown>).exchangeInfo =
        async () => { throw new Error("socket hang up"); };
      const position = pathCase.side === "SELL" ? await manualPosition(account, 1) : null;
      const order = await submitManualOrder({ requestId: `f9-${pathCase.name.replaceAll(" ", "-")}`,
        accountId: account.id, symbol: "BTCUSDT", side: pathCase.side, orderType: pathCase.orderType,
        ...(pathCase.side === "BUY" ? { quoteQuantity: 100 } : { baseQuantity: 1, positionId: position!.id }),
        ...(pathCase.orderType === "LIMIT" ? { limitPrice: 100 } : {}),
      }, manualFactory(exchange));
      assert.equal(order.status, "rejected", "nothing was sent, so nothing is pending");
      assert.ok(order.completedAt);
      assert.match(order.error ?? "", /before any order was sent/);
      assert.equal(exchange.submissions.length, 0);
      assert.equal((binance.classifyExchangeFailure(new binance.PreWireError("x"))).outcome, "rejected");
    });
}

test("D2/F9 a strategy BUY whose minimum-notional read fails is rejected and blocks no fresh signal",
  async () => {
    const bot = await createBot();
    const exchange = fakeBinance();
    const client = exchange.client as unknown as Record<string, unknown>;
    const realInfo = client.exchangeInfo;
    client.exchangeInfo = async () => { throw new Error("socket hang up"); };
    await assert.rejects(processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "L-f9" }, { clientFactory: async () => exchange.client }));
    assert.equal((await prisma.strategyOrderIntent.findFirstOrThrow({ where: { botId: bot.id } })).status,
      "rejected");
    assert.equal(await prisma.webhookReceipt.count(), 0);
    client.exchangeInfo = realInfo;
    const fresh = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
      quote_order_qty: 50, dedupe_key: "L-f9-next" }, { clientFactory: async () => exchange.client });
    assert.equal(fresh.status, "ok");
    assert.equal(exchange.submissions.length, 1);
  });

// ── review round 2 (D3 advisory A1): a live order under DRY_RUN ──────────────

test("D2/A1 under DRY_RUN a cancel of an order placed on the exchange is refused, never simulated",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance();
    const order = await prisma.manualOrder.create({ data: { requestId: "a1-live", exchangeAccountId: account.id,
      symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100,
      limitPrice: 90, status: "open", clientOrderId: "a1-live-client", exchangeOrderId: "123456789",
      submittedAt: new Date() } });
    const dryAdapter = (acc: ExchangeAccount) =>
      new BinanceManualExchange(acc, { client: exchange.client, dryRun: true });
    const refusal = await cancelManualOrder(order.id, undefined, dryAdapter)
      .then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof ManualTradingError);
    assert.equal(refusal.httpStatus, 409);
    assert.equal((refusal as unknown as { code?: string }).code, "live_order_in_dry_run");
    const still = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(still.status, "open", "still working: no fabricated cancel");
    assert.equal(still.exchangeOrderId, "123456789");
    assert.equal(still.completedAt, null);
    assert.equal(exchange.cancels.length, 0);

    // A simulated snapshot never replaces the real exchange id.
    await manual.applyManualSnapshot(order.id, { exchangeOrderId: "dry-a1-live-client",
      clientOrderId: "a1-live-client", status: "NEW", executedBaseQuantity: 0, executedQuoteQuantity: 0,
      averagePrice: null, simulated: true });
    assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).exchangeOrderId,
      "123456789");

    // A dry-run order is still canceled by the dry-run adapter, as before.
    const dry = await prisma.manualOrder.create({ data: { requestId: "a1-dry", exchangeAccountId: account.id,
      symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100,
      limitPrice: 90, status: "open", clientOrderId: "a1-dry-client", exchangeOrderId: "dry-a1-dry-client" } });
    assert.equal((await cancelManualOrder(dry.id, undefined, dryAdapter)).status, "canceled");
  });

