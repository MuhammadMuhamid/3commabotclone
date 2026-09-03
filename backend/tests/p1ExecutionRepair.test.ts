/**
 * BOT-P1-1 / BOT-P1-2 / BOT-P1-3 — execution and recovery repairs.
 *
 * P1-1  distinct SELL orders must not reuse a client order id, and a duplicate
 *       response must never bind a new intent to an older, unrelated fill.
 * P1-2  a SELL intent stuck in `submitted` must be resolvable from current
 *       exchange evidence instead of wedging both full-close paths forever.
 * P1-3  a manual MARKET order must record the lifecycle it actually reached, and
 *       protection must re-arm for exposure a fill did not remove.
 *
 * Everything runs against an in-process fake exchange. No network, no Binance,
 * no real order.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, SignalBot, SmartTrade } from "@prisma/client";
// Type-only, so it is erased before execution and loads no module — this file
// must pick its database URL before any `src` module is constructed.
import type { BinanceClient } from "../src/services/binance.js";

/*
 * This file owns its own database: `node --test` runs test files as parallel
 * processes and two real-database suites would otherwise race over one file.
 * The URL must be chosen before anything constructs the Prisma client, hence
 * the dynamic imports below.
 */
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".p1-repair-test.db");
process.env.DATABASE_URL = "file:./tests/.p1-repair-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { tradesRouter, tradeExchangeClient } = await import("../src/routes/trades.js");
const { checkTakeProfitStopLoss } = await import("../src/services/smartTrade.js");
const { checkManualProtection } = await import("../src/services/manualProtection.js");
const { openOrderAttempt, settleOrderAttempt } = await import("../src/services/orderAttempt.js");
const { BinanceManualExchange, marketSubmissionStatus } =
  await import("../src/services/manualExchange.js");
const { applyManualSnapshot, manualLifecycleStatus } =
  await import("../src/services/manualTrading.js");
const {
  hasUnresolvedStrategySell, reconcileStrategyIntent, resolveUnresolvedStrategySells,
  strategyMarketAdapter, SUBMITTED_ABSENCE_SETTLE_MS,
} = await import("../src/services/strategyOrderIntent.js");
const { marketSellBase, probeOrderByClientId } = await import("../src/services/binance.js");
const { processWebhook } = await import("../src/services/webhook.js");

const originalDryRun = config.dryRun;
const originalManual = config.manualTradingEnabled;
const originalResolve = tradeExchangeClient.resolve;
// Every assertion here is about what did or did not reach the exchange, which
// the suite default DRY_RUN=true would hide behind a simulated fill.
config.dryRun = false;
config.manualTradingEnabled = true;

after(async () => {
  config.dryRun = originalDryRun;
  config.manualTradingEnabled = originalManual;
  tradeExchangeClient.resolve = originalResolve;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  await prisma.realizationEvent.deleteMany();
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.webhookReceipt.deleteMany();
  await prisma.pairCloseMark.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
  tradeExchangeClient.resolve = originalResolve;
});

// ── A fake Binance that behaves like the real one where it matters ───────────
//
// It keeps a book keyed by client order id, REJECTS a reused id exactly as
// Binance does, and answers `-2013` for an id it has never seen. Those two
// behaviours are the whole of BOT-P1-1's blast radius.

interface FakeFill { status: string; executedQty: string; quote: string }

interface FakeExchange {
  client: BinanceClient;
  submissions: Record<string, unknown>[];
  book: Map<string, Record<string, unknown>>;
  lookups: string[];
}

function fakeExchange(opts: {
  price?: string;
  freeBase?: string;
  fills?: FakeFill[];
  /** Seed the book so an id can already exist before the first submission. */
  seed?: { clientOrderId: string; orderId: string; side?: string; fill: FakeFill }[];
} = {}): FakeExchange {
  const submissions: Record<string, unknown>[] = [];
  const book = new Map<string, Record<string, unknown>>();
  const lookups: string[] = [];
  const fills = [...(opts.fills ?? [])];
  let seq = 0;
  for (const s of opts.seed ?? []) {
    book.set(s.clientOrderId, {
      orderId: s.orderId, clientOrderId: s.clientOrderId, side: s.side ?? "SELL",
      status: s.fill.status, executedQty: s.fill.executedQty, cummulativeQuoteQty: s.fill.quote,
    });
  }
  const client = {
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: opts.price ?? "100" }),
    accountInfo: async () => ({ balances: [
      { asset: "BTC", free: opts.freeBase ?? "10", locked: "0" },
      { asset: "USDT", free: "100000", locked: "0" },
    ] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.0001", minQty: "0.0001" },
      { filterType: "NOTIONAL", minNotional: "1" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      submissions.push(payload);
      const cid = String(payload.newClientOrderId ?? "");
      if (cid && book.has(cid)) {
        const error = new Error("Duplicate order sent.") as Error & { code: number };
        error.code = -2010;
        throw error;
      }
      const fill = fills.shift() ?? { status: "FILLED",
        executedQty: String(payload.quantity ?? "0"),
        quote: String(Number(payload.quantity ?? 0) * Number(opts.price ?? "100")) };
      seq += 1;
      const order = { orderId: `ex-${seq}`, clientOrderId: cid, side: payload.side,
        status: fill.status, executedQty: fill.executedQty, cummulativeQuoteQty: fill.quote };
      if (cid) book.set(cid, order);
      return order;
    },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      lookups.push(origClientOrderId);
      const order = book.get(origClientOrderId);
      if (!order) {
        const error = new Error("Order does not exist.") as Error & { code: number };
        error.code = -2013;
        throw error;
      }
      return order;
    },
    myTrades: async () => [],
  } as unknown as BinanceClient;
  return { client, submissions, book, lookups };
}

function submittedIds(exchange: FakeExchange): string[] {
  return exchange.submissions.map((s) => String(s.newClientOrderId ?? ""));
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function createAccount(): Promise<ExchangeAccount> {
  return prisma.exchangeAccount.create({ data: {
    name: "P1 fixture", exchange: "binance", marketType: "spot",
    apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true,
  } });
}

async function createBot(overrides: Partial<SignalBot> = {}): Promise<SignalBot> {
  return prisma.signalBot.create({ data: {
    name: "P1 bot", webhookSecret: "p".repeat(40), pairs: JSON.stringify(["BTCUSDT"]),
    ...overrides,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function createTrade(bot: SignalBot, overrides: Partial<SmartTrade> = {}): Promise<SmartTrade> {
  return prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active",
    entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100,
    ...overrides,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

/** Invoke a `tradesRouter` handler directly, so no socket is opened. */
async function callTradesRoute(
  method: "post", routePath: string, params: Record<string, string>, body: unknown
): Promise<{ status: number; body: unknown }> {
  const layers = (tradesRouter as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean>;
      stack: { handle: (req: unknown, res: unknown, next: () => void) => unknown }[] } }[];
  }).stack;
  const layer = layers.find((l) => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer?.route, `route ${method.toUpperCase()} ${routePath} not found`);
  let status = 200;
  let payload: unknown;
  const res = {
    status(code: number) { status = code; return res; },
    json(value: unknown) { payload = value; return res; },
    send() { return res; },
  };
  await layer.route.stack[0]!.handle({ params, body, query: {} }, res, () => {});
  return { status, body: payload };
}

// ════════════════════════════════════════════════════════════════════════════
// BOT-P1-1 — client order id identity
// ════════════════════════════════════════════════════════════════════════════

test("P1-1: two distinct partial exits at the SAME percentage get different client order ids", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [
    { status: "FILLED", executedQty: "0.25", quote: "27.5" },
    { status: "FILLED", executedQty: "0.1875", quote: "20.625" },
  ] });
  tradeExchangeClient.resolve = () => exchange.client;

  const first = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 25 });
  const second = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 25 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const ids = submittedIds(exchange);
  assert.equal(ids.length, 2, "both exits reached the exchange");
  assert.notEqual(ids[0], ids[1], "a second 25% exit must not reuse the first exit's client order id");

  // Two attempts on one slot, both settled, and each bound to its own order.
  const attempts = await prisma.exchangeOrderAttempt.findMany({
    where: { intentKey: `partial:${trade.id}:25` }, orderBy: { attempt: "asc" } });
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
  assert.deepEqual(attempts.map((a) => a.status), ["settled", "settled"]);
  assert.deepEqual(attempts.map((a) => a.clientOrderId), ids);

  // And each exit booked ITS OWN revenue, not the earlier order's.
  const partials = await prisma.partialClose.findMany({
    where: { tradeId: trade.id }, orderBy: { createdAt: "asc" } });
  assert.equal(partials.length, 2);
  assert.equal(partials[0]!.revenue, 27.5);
  assert.equal(partials[1]!.revenue, 20.625);
  assert.notEqual(partials[0]!.exchangeOrderId, partials[1]!.exchangeOrderId);
});

test("P1-1: a retry of the SAME logical exit keeps its client order id, across a restart", async () => {
  const trade = await createTrade(await createBot());
  const first = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });
  const retry = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });
  assert.equal(retry.id, first.id, "an unsettled attempt is reused, not superseded");
  assert.equal(retry.clientOrderId, first.clientOrderId);

  // A restart holds no state: the identity comes back out of the database.
  await prisma.$disconnect();
  const afterRestart = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });
  assert.equal(afterRestart.clientOrderId, first.clientOrderId,
    "a process restart must not change the id of an already-admitted order");

  // Only settlement releases the slot, and then the id genuinely changes.
  assert.equal(await prisma.$transaction((tx) => settleOrderAttempt(tx, first.id)), true);
  const next = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });
  assert.notEqual(next.clientOrderId, first.clientOrderId);
  assert.equal(next.attempt, 2);
});

test("P1-1: settlement is exactly-once, so one recovered fill cannot be booked twice", async () => {
  const trade = await createTrade(await createBot());
  const attempt = await openOrderAttempt({
    intentKey: `tpsl:${trade.id}:tp`, symbol: "BTCUSDT", side: "SELL" });
  assert.equal(await prisma.$transaction((tx) => settleOrderAttempt(tx, attempt.id, "ex-1")), true);
  assert.equal(await prisma.$transaction((tx) => settleOrderAttempt(tx, attempt.id, "ex-1")), false,
    "a second caller recovering the same fill must not win the settle, so it applies nothing");
});

test("P1-1: a duplicate-id rejection resolves only the order belonging to that same attempt", async () => {
  const trade = await createTrade(await createBot());
  const attempt = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });

  // The exchange already holds THIS attempt's order, filled. A retry under the
  // same id is a true retry, and recovering it is correct.
  const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: attempt.clientOrderId, orderId: "ex-original",
      fill: { status: "FILLED", executedQty: "0.25", quote: "27.5" } },
  ] });
  const recovered = await marketSellBase(exchange.client, "BTCUSDT", 0.25, {
    explicitClientOrderId: attempt.clientOrderId });
  assert.equal(recovered.orderId, "ex-original");
  assert.equal(recovered.cummulativeQuoteQty, 27.5);

  // A genuinely new logical exit carries a new id, so the SAME exchange cannot
  // hand it the earlier order's fill — it is simply a new order.
  await prisma.$transaction((tx) => settleOrderAttempt(tx, attempt.id, "ex-original"));
  const second = await openOrderAttempt({
    intentKey: `partial:${trade.id}:25`, symbol: "BTCUSDT", side: "SELL" });
  assert.notEqual(second.clientOrderId, attempt.clientOrderId);
  const fresh = await marketSellBase(exchange.client, "BTCUSDT", 0.25, {
    explicitClientOrderId: second.clientOrderId });
  assert.notEqual(fresh.orderId, "ex-original",
    "a new intent must never be bound to an older, unrelated fill");
});

test("P1-1: a partially filled TP leaves the trade open and the next cycle sends a NEW id", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id,
    takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [
    { status: "PARTIALLY_FILLED", executedQty: "0.4", quote: "44" },
    { status: "FILLED", executedQty: "0.6", quote: "66" },
  ] });

  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
  const afterFirst = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(afterFirst.status, "active", "a 40% fill must not mark the trade closed");
  assert.ok(Math.abs(afterFirst.quantity - 0.6) < 1e-9, "only the executed quantity was removed");

  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
  const ids = submittedIds(exchange);
  assert.equal(ids.length, 2, "the second cycle actually reached the exchange");
  assert.notEqual(ids[0], ids[1],
    "the second TP attempt must not reuse the first attempt's client order id");

  const afterSecond = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(afterSecond.status, "closed");
  assert.equal(afterSecond.closedReason, "take_profit");
  const attempts = await prisma.exchangeOrderAttempt.findMany({
    where: { intentKey: `tpsl:${trade.id}:tp` }, orderBy: { attempt: "asc" } });
  assert.deepEqual(attempts.map((a) => a.attempt), [1, 2]);
  assert.deepEqual(attempts.map((a) => a.clientOrderId), ids);
});

// ════════════════════════════════════════════════════════════════════════════
// BOT-P1-2 — a stuck `submitted` SELL intent
// ════════════════════════════════════════════════════════════════════════════

async function stuckSellIntent(bot: SignalBot, trade: SmartTrade, opts: {
  clientOrderId: string; status?: string; submittedAgoMs?: number;
}) {
  return prisma.strategyOrderIntent.create({ data: {
    sourceKey: `${bot.id}:BTCUSDT:sell:${opts.clientOrderId}`,
    botId: bot.id, botName: bot.name, exchangeAccountId: bot.exchangeAccountId,
    clientOrderId: opts.clientOrderId, symbol: "BTCUSDT", side: "SELL",
    requestedBaseQty: trade.quantity, smartTradeId: trade.id,
    status: opts.status ?? "submitted",
    submittedAt: new Date(Date.now() - (opts.submittedAgoMs ?? SUBMITTED_ABSENCE_SETTLE_MS * 2)),
  } });
}

test("P1-2: a submitted SELL the exchange confirms as FILLED reconciles, with no duplicate SELL", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: "stuck-filled", orderId: "ex-stuck",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  await stuckSellIntent(bot, trade, { clientOrderId: "stuck-filled" });

  const resolution = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));
  assert.equal(resolution.blocked, false);
  assert.equal(resolution.reconciled, 1);
  assert.equal(exchange.submissions.length, 0, "resolution places no order of its own");

  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { clientOrderId: "stuck-filled" } });
  assert.equal(intent.status, "reconciled");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed", "the exit that already happened closed the position");
  assert.equal(await hasUnresolvedStrategySell(trade.id), false);

  // A second resolution pass cannot apply the same fill again.
  const again = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));
  assert.equal(again.reconciled, 0);
  assert.equal(again.blocked, false);
});

test("P1-2: a submitted SELL the exchange has never seen is closed off, and the close proceeds", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  await stuckSellIntent(bot, trade, { clientOrderId: "stuck-absent" });

  const resolution = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));
  assert.equal(resolution.blocked, false);
  assert.equal(resolution.discarded, 1);
  assert.equal(exchange.submissions.length, 0);

  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { clientOrderId: "stuck-absent" } });
  assert.equal(intent.status, "rejected");
  assert.equal(intent.exchangeStatus, "ABSENT");
  assert.ok(intent.reconciledAt, "the resolution is durable, so a restart sees it too");
  assert.equal(await hasUnresolvedStrategySell(trade.id), false);
});

test("P1-2: a submitted SELL absent only moments ago stays fail-safe and sends nothing", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange();
  await stuckSellIntent(bot, trade, { clientOrderId: "stuck-fresh", submittedAgoMs: 1_000 });

  const resolution = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /no record of it yet/);
  assert.equal(exchange.submissions.length, 0);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { clientOrderId: "stuck-fresh" } });
  assert.equal(intent.status, "submitted", "an unproven absence must not resolve the intent");
  assert.equal(intent.exchangeStatus, "ABSENT", "but the observation is recorded truthfully");
});

test("P1-2: a SELL still live at the exchange keeps the close blocked", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ seed: [
    { clientOrderId: "stuck-open", orderId: "ex-open",
      fill: { status: "NEW", executedQty: "0", quote: "0" } },
  ] });
  await stuckSellIntent(bot, trade, { clientOrderId: "stuck-open" });

  const resolution = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /still live at the exchange/);
  assert.equal(exchange.submissions.length, 0, "no replacement SELL is fired at a live order");
  assert.equal(await hasUnresolvedStrategySell(trade.id), true);
});

test("P1-2: an unreadable exchange keeps the close blocked rather than guessing", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  await stuckSellIntent(bot, trade, { clientOrderId: "stuck-unknown" });
  const unreadable = {
    getOrder: async () => { throw new Error("connection reset"); },
  } as unknown as BinanceClient;

  const resolution = await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(unreadable, false));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /unknown exchange state/);
  assert.equal(await hasUnresolvedStrategySell(trade.id), true);
});

test("P1-2: dry run proves nothing, so it can never license a resolution", async () => {
  const adapter = strategyMarketAdapter(fakeExchange().client, true);
  const probe = await adapter.probe!({
    symbol: "BTCUSDT", side: "SELL", clientOrderId: "anything",
  } as Parameters<NonNullable<typeof adapter.probe>>[0]);
  assert.equal(probe.state, "unknown");
});

test("P1-2: the dashboard Close goes through the same resolution — blocked, then working", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const live = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: "wedge", orderId: "ex-live",
      fill: { status: "NEW", executedQty: "0", quote: "0" } },
  ] });
  await stuckSellIntent(bot, trade, { clientOrderId: "wedge" });

  // `skipExitCheck` is the dashboard Close button. It must NOT bypass exchange
  // uncertainty: while the prior order is live the close is refused.
  await assert.rejects(
    processWebhook({ secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT",
      quantity: trade.quantity }, { skipExitCheck: true, clientFactory: async () => live.client }),
    /unresolved exchange state/);
  assert.equal(live.submissions.length, 0, "skipExitCheck never fires a second SELL blind");

  // The order then dies at the exchange without filling. Now the close works.
  live.book.set("wedge", { orderId: "ex-live", clientOrderId: "wedge", side: "SELL",
    status: "EXPIRED", executedQty: "0", cummulativeQuoteQty: "0" });
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: trade.quantity },
    { skipExitCheck: true, clientFactory: async () => live.client });
  assert.equal(result.status, "ok");
  assert.equal(live.submissions.length, 1, "exactly one close reached the exchange");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  const wedged = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { clientOrderId: "wedge" } });
  assert.equal(wedged.status, "rejected");
});

test("P1-2: a recovered fill closes the position and the close reports no second order", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: "already-filled", orderId: "ex-already",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  await stuckSellIntent(bot, trade, { clientOrderId: "already-filled" });

  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: trade.quantity },
    { skipExitCheck: true, clientFactory: async () => exchange.client });
  assert.equal(result.status, "ignored_duplicate");
  assert.equal(exchange.submissions.length, 0, "no duplicate close was placed");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
});

test("P1-2: a resolved intent can never be submitted afterwards", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  const intent = await stuckSellIntent(bot, trade, { clientOrderId: "no-such-order" });
  await resolveUnresolvedStrategySells(
    trade.id, async () => strategyMarketAdapter(exchange.client, false));

  await assert.rejects(
    reconcileStrategyIntent(intent.id, strategyMarketAdapter(exchange.client, false)),
    /no exit was placed/);
  assert.equal(exchange.submissions.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// BOT-P1-3 — manual MARKET lifecycle and protection
// ════════════════════════════════════════════════════════════════════════════

async function manualExit(account: ExchangeAccount, position: SmartTrade, clientOrderId: string) {
  return prisma.manualOrder.create({ data: {
    requestId: `req-${clientOrderId}`, exchangeAccountId: account.id,
    linkedPositionId: position.id, symbol: "BTCUSDT", side: "SELL", orderType: "MARKET",
    quantityType: "base", requestedBaseQty: position.quantity, clientOrderId,
    status: "submitted",
  } });
}

for (const scenario of [
  { name: "a fully filled MARKET order", fill: { status: "FILLED", executedQty: "1", quote: "110" },
    expected: "FILLED", lifecycle: "filled", closes: true },
  { name: "a partially filled MARKET order",
    fill: { status: "PARTIALLY_FILLED", executedQty: "0.4", quote: "44" },
    expected: "PARTIALLY_FILLED", lifecycle: "partially_filled", closes: false },
  { name: "a zero-fill MARKET order", fill: { status: "EXPIRED", executedQty: "0", quote: "0" },
    expected: "EXPIRED", lifecycle: "canceled", closes: false },
  { name: "a rejected MARKET order", fill: { status: "REJECTED", executedQty: "0", quote: "0" },
    expected: "REJECTED", lifecycle: "rejected", closes: false },
]) {
  test(`P1-3: ${scenario.name} is recorded as what it actually was`, async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id });
    const position = await createTrade(bot, { source: "manual", exchangeAccountId: account.id,
      quantity: 1, quoteSpent: 100, manualSlPrice: 90, protectionType: "bot-managed",
      protectionState: "active" });
    const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [scenario.fill] });
    const order = await manualExit(account, position, `manual-${scenario.expected}`);

    const adapter = new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
    const snapshot = await adapter.submit({ symbol: "BTCUSDT", side: "SELL", orderType: "MARKET",
      baseQuantity: 1, clientOrderId: order.clientOrderId });
    assert.equal(snapshot.status, scenario.expected,
      "the lifecycle must come from the exchange response, never from the fact that it returned");
    assert.equal(manualLifecycleStatus(snapshot.status), scenario.lifecycle);

    const applied = await applyManualSnapshot(order.id, snapshot);
    assert.equal(applied.status, scenario.lifecycle);
    assert.equal(applied.filledBaseQty, Number(scenario.fill.executedQty),
      "only the actually executed quantity is accounted for");

    const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
    if (scenario.closes) {
      assert.equal(after.status, "closed");
    } else {
      assert.equal(after.status, "active", "an uncovered exit leaves the position open");
      assert.equal(after.protectionState, "active",
        "and protection must still be armed for the exposure that remains");
      const expectedRemaining = 1 - Number(scenario.fill.executedQty);
      assert.ok(Math.abs(after.quantity - expectedRemaining) < 1e-9,
        "the position holds exactly what was not sold");
      if (Number(scenario.fill.executedQty) === 0) {
        assert.equal(after.pnlUsdt, 0, "no P&L may be booked for a quantity that never sold");
      }
    }
  });
}

test("P1-3: with no status from the adapter, only a covering fill may be called FILLED", () => {
  assert.equal(marketSubmissionStatus(
    { executedQty: 1, cummulativeQuoteQty: 110 }, { baseQuantity: 1 }), "FILLED");
  assert.equal(marketSubmissionStatus(
    { executedQty: 0.4, cummulativeQuoteQty: 44 }, { baseQuantity: 1 }), "PARTIALLY_FILLED");
  assert.equal(marketSubmissionStatus(
    { executedQty: 0, cummulativeQuoteQty: 0 }, { baseQuantity: 1 }), "NEW");
  // An explicit exchange status always wins over the inference.
  assert.equal(marketSubmissionStatus(
    { executedQty: 0, cummulativeQuoteQty: 0, exchangeStatus: "EXPIRED" }, { baseQuantity: 1 }),
  "EXPIRED");
});

test("P1-3: a zero-fill stop re-arms on the next cycle instead of disarming permanently", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const position = await createTrade(bot, { source: "manual", exchangeAccountId: account.id,
    quantity: 1, quoteSpent: 100, manualSlPrice: 95, protectionType: "bot-managed",
    protectionState: "active" });
  const exchange = fakeExchange({ price: "90", freeBase: "1", fills: [
    { status: "EXPIRED", executedQty: "0", quote: "0" },
    { status: "FILLED", executedQty: "1", quote: "90" },
  ] });
  const adapterFactory = () =>
    new BinanceManualExchange(account, { client: exchange.client, dryRun: false });

  await checkManualProtection(adapterFactory);
  const afterZeroFill = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
  assert.equal(afterZeroFill.status, "active", "a zero fill must not close the position");
  assert.equal(afterZeroFill.protectionState, "active");
  assert.equal(afterZeroFill.pnlUsdt, 0, "and it must book no P&L");

  await checkManualProtection(adapterFactory);
  const ids = submittedIds(exchange);
  assert.equal(ids.length, 2, "the stop was re-attempted rather than silently disarmed");
  assert.notEqual(ids[0], ids[1], "the re-attempt is a new order, not a reused client order id");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "manual_stop_loss");
});

test("P1-3: a partially filled stop sells only what filled, and stays protected for the rest", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const position = await createTrade(bot, { source: "manual", exchangeAccountId: account.id,
    quantity: 1, quoteSpent: 100, manualSlPrice: 95, protectionType: "bot-managed",
    protectionState: "active" });
  const exchange = fakeExchange({ price: "90", freeBase: "1", fills: [
    { status: "PARTIALLY_FILLED", executedQty: "0.3", quote: "27" },
  ] });

  await checkManualProtection(() =>
    new BinanceManualExchange(account, { client: exchange.client, dryRun: false }));

  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
  assert.equal(after.status, "active");
  assert.equal(after.protectionState, "active");
  assert.ok(Math.abs(after.quantity - 0.7) < 1e-9, "only the executed 0.3 left the position");
  const order = await prisma.manualOrder.findFirstOrThrow({
    where: { linkedPositionId: position.id } });
  assert.equal(order.status, "partially_filled", "a partial fill is not terminal");
  const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
    where: { clientOrderId: order.clientOrderId } });
  assert.equal(attempt.status, "open",
    "the attempt stays open while its order is live, so no second exit is placed over it");
});

test("P1-3: the exchange probe tells absence, liveness and a dead order apart", async () => {
  const exchange = fakeExchange({ seed: [
    { clientOrderId: "live", orderId: "ex-1", fill: { status: "NEW", executedQty: "0", quote: "0" } },
    { clientOrderId: "dead", orderId: "ex-2",
      fill: { status: "EXPIRED", executedQty: "0", quote: "0" } },
    { clientOrderId: "part-dead", orderId: "ex-3",
      fill: { status: "CANCELED", executedQty: "0.2", quote: "22" } },
    { clientOrderId: "done", orderId: "ex-4",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  const probe = (id: string) => probeOrderByClientId(exchange.client, "BTCUSDT", "SELL", id);
  assert.equal((await probe("nothing")).state, "absent");
  assert.equal((await probe("live")).state, "open");
  assert.equal((await probe("dead")).state, "dead");
  assert.equal((await probe("part-dead")).state, "unknown",
    "a terminal order carrying a real partial fill is not safe to call resolved");
  assert.equal((await probe("done")).state, "filled");
});
