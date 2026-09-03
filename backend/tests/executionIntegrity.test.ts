/**
 * BOT-P1-5 / BOT-P1-6 — durable exit visibility and executed-quantity accounting.
 *
 * P1-5  a TP, SL or partial-close SELL reserves an `ExchangeOrderAttempt` but no
 *       `StrategyOrderIntent`. Close admission reasons about intents, so a crash
 *       between the exchange submission and the local settlement made a
 *       possibly-live exit invisible: after a restart the in-process close lock
 *       is gone and a second, overlapping SELL could be sent.
 * P1-6  the partial-close route spent the REQUESTED quantity on the cost basis,
 *       on the reduced position and on `PartialClose.quantity`, while taking
 *       revenue from the actual fill. A partial or zero fill therefore removed
 *       base asset locally that was never sold.
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
import type { BinanceClient } from "../src/services/binance.js";

/* This file owns its own database — see the note in p1ExecutionRepair.test.ts. */
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".execution-integrity-test.db");
process.env.DATABASE_URL = "file:./tests/.execution-integrity-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { tradesRouter, tradeExchangeClient } = await import("../src/routes/trades.js");
const { checkTakeProfitStopLoss } = await import("../src/services/smartTrade.js");
const { processWebhook } = await import("../src/services/webhook.js");
const {
  openOrderAttempt, markOrderAttemptSubmitted, settleOrderAttempt,
} = await import("../src/services/orderAttempt.js");
const {
  applyExitFill, exitAttemptProbe, resolveUnresolvedExitAttempts,
} = await import("../src/services/exitSettlement.js");
const { SUBMITTED_ABSENCE_SETTLE_MS } = await import("../src/services/strategyOrderIntent.js");
const { heldLockCount } = await import("../src/lib/tradeCloseLock.js");
const { __clearCloseMarkCache } = await import("../src/lib/tradeCloseTracker.js");

const originalDryRun = config.dryRun;
const originalResolve = tradeExchangeClient.resolve;
// Every assertion here is about what did or did not reach the exchange, which
// the suite default DRY_RUN=true would hide behind a simulated fill.
config.dryRun = false;

after(async () => {
  config.dryRun = originalDryRun;
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
  __clearCloseMarkCache();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
  tradeExchangeClient.resolve = originalResolve;
});

// ── A fake Binance that behaves like the real one where it matters ───────────

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function createAccount(): Promise<ExchangeAccount> {
  return prisma.exchangeAccount.create({ data: {
    name: "P1-5 fixture", exchange: "binance", marketType: "spot",
    apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true,
  } });
}

async function createBot(overrides: Partial<SignalBot> = {}): Promise<SignalBot> {
  return prisma.signalBot.create({ data: {
    name: "P1-5 bot", webhookSecret: "q".repeat(40), pairs: JSON.stringify(["BTCUSDT"]),
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

/**
 * A durable exit attempt exactly as a crash would leave it: reserved, marked
 * submitted, and never settled. This is crash window B, and it is what the
 * whole of BOT-P1-5 is about.
 */
async function crashedExitAttempt(trade: SmartTrade, opts: {
  origin: "tpsl" | "partial" | "manual-protection";
  clientOrderId: string;
  submittedAgoMs?: number | null;
  sellPercent?: number;
  requestedBaseQty?: number;
  closedReason?: string;
}) {
  return prisma.exchangeOrderAttempt.create({ data: {
    intentKey: `${opts.origin}:${trade.id}:${opts.clientOrderId}`,
    attempt: 1,
    clientOrderId: opts.clientOrderId,
    symbol: trade.pair,
    side: "SELL",
    status: "open",
    smartTradeId: trade.id,
    origin: opts.origin,
    requestedBaseQty: opts.requestedBaseQty ?? trade.quantity,
    sellPercent: opts.sellPercent,
    closedReason: opts.closedReason
      ?? (opts.origin === "partial" ? "partial_close" : "take_profit"),
    submittedAt: opts.submittedAgoMs === null
      ? null
      : new Date(Date.now() - (opts.submittedAgoMs ?? SUBMITTED_ABSENCE_SETTLE_MS * 2)),
  } });
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

const probeFor = (exchange: FakeExchange) => exitAttemptProbe(exchange.client, false);

// ════════════════════════════════════════════════════════════════════════════
// BOT-P1-5 — a durable non-intent SELL participates in close admission
// ════════════════════════════════════════════════════════════════════════════

for (const origin of ["tpsl", "partial"] as const) {
  test(`P1-5: a crashed ${origin} SELL that FILLED reconciles exactly once, with no second SELL`,
    async () => {
      const account = await createAccount();
      const bot = await createBot({ exchangeAccountId: account.id });
      const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
      const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
        { clientOrderId: `crashed-${origin}`, orderId: "ex-crashed",
          fill: { status: "FILLED", executedQty: "1", quote: "110" } },
      ] });
      await crashedExitAttempt(trade, {
        origin, clientOrderId: `crashed-${origin}`, sellPercent: origin === "partial" ? 99 : undefined,
      });

      const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
      assert.equal(resolution.blocked, false);
      assert.equal(resolution.reconciled, 1);
      assert.equal(exchange.submissions.length, 0, "resolution places no order of its own");

      const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
      assert.equal(closed.status, "closed", "the exit that already happened closed the position");
      const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
        where: { clientOrderId: `crashed-${origin}` } });
      assert.equal(attempt.status, "settled");
      assert.equal(attempt.exchangeOrderId, "ex-crashed");

      // A second resolution pass must not apply the same fill again.
      const again = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
      assert.equal(again.reconciled, 0);
      assert.equal(again.blocked, false);
      const stillClosed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
      assert.equal(stillClosed.pnlUsdt, closed.pnlUsdt, "P&L was not booked a second time");
      assert.equal(
        await prisma.partialClose.count({ where: { tradeId: trade.id } }),
        origin === "partial" ? 1 : 0,
        "exactly one accounting row exists for one fill");
    });

  test(`P1-5: a crashed ${origin} SELL still live at the exchange blocks a second close`, async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id });
    const trade = await createTrade(bot);
    const exchange = fakeExchange({ seed: [
      { clientOrderId: `live-${origin}`, orderId: "ex-live",
        fill: { status: "PARTIALLY_FILLED", executedQty: "0.4", quote: "44" } },
    ] });
    await crashedExitAttempt(trade, { origin, clientOrderId: `live-${origin}` });

    const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
    assert.equal(resolution.blocked, true);
    assert.match(String(resolution.reason), /still live at the exchange/);
    assert.equal(exchange.submissions.length, 0, "no replacement SELL is fired at a live order");

    // Nothing was applied, and the remainder is preserved: the attempt stays
    // open so the still-unresolved quantity cannot go missing.
    const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
      where: { clientOrderId: `live-${origin}` } });
    assert.equal(attempt.status, "open");
    assert.equal(attempt.exchangeStatus, "PARTIALLY_FILLED", "the observation is recorded truthfully");
    const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(untouched.quantity, 1);
    assert.equal(await prisma.partialClose.count({ where: { tradeId: trade.id } }), 0);
  });
}

test("P1-5: a terminal zero-fill attempt is released, so a later legitimate exit may proceed",
  async () => {
    const bot = await createBot();
    const trade = await createTrade(bot);
    const exchange = fakeExchange({ seed: [
      { clientOrderId: "dead-sl", orderId: "ex-dead",
        fill: { status: "EXPIRED", executedQty: "0", quote: "0" } },
    ] });
    await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "dead-sl" });

    const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
    assert.equal(resolution.blocked, false);
    assert.equal(resolution.discarded, 1);
    const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
      where: { clientOrderId: "dead-sl" } });
    assert.equal(attempt.status, "abandoned", "released, not recorded as an applied settlement");
    assert.equal(attempt.exchangeStatus, "EXPIRED");
    const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(untouched.quantity, 1, "a dead order moved nothing, so nothing changed");
    assert.equal(untouched.status, "active", "the exposure is still there and still exitable");
  });

test("P1-5: an attempt reserved but never submitted is released at once — crash window A", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  // The exchange has never heard of it, and `submittedAt` is null, which proves
  // no order was ever sent. No settle window is needed for that.
  const exchange = fakeExchange();
  await crashedExitAttempt(trade, {
    origin: "partial", clientOrderId: "never-sent", submittedAgoMs: null, sellPercent: 25 });

  const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
  assert.equal(resolution.blocked, false);
  assert.equal(resolution.discarded, 1);
  const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
    where: { clientOrderId: "never-sent" } });
  assert.equal(attempt.status, "abandoned");
  assert.equal(attempt.exchangeStatus, "ABSENT");
});

test("P1-5: an absence moments after submission stays fail-safe — the 60s floor is preserved",
  async () => {
    const bot = await createBot();
    const trade = await createTrade(bot);
    const exchange = fakeExchange();
    await crashedExitAttempt(trade, {
      origin: "tpsl", clientOrderId: "just-sent", submittedAgoMs: 1_000 });

    const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
    assert.equal(resolution.blocked, true);
    assert.match(String(resolution.reason), /no record of it yet/);
    const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
      where: { clientOrderId: "just-sent" } });
    assert.equal(attempt.status, "open", "an unproven absence must not resolve the attempt");
    assert.equal(attempt.exchangeStatus, "ABSENT", "but the observation is recorded truthfully");

    // Past the floor, the same absence is now proof.
    const later = await resolveUnresolvedExitAttempts(
      trade.id, probeFor(exchange), Date.now() + SUBMITTED_ABSENCE_SETTLE_MS + 1_000);
    assert.equal(later.blocked, false);
    assert.equal(later.discarded, 1);
  });

test("P1-5: an unreadable exchange stays fail-safe and never licenses a second SELL", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "unreadable" });
  const unreadable = { getOrder: async () => { throw new Error("connection reset"); } } as
    unknown as BinanceClient;

  const resolution = await resolveUnresolvedExitAttempts(
    trade.id, exitAttemptProbe(unreadable, false));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /unknown exchange state/);
  const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
    where: { clientOrderId: "unreadable" } });
  assert.equal(attempt.status, "open");
});

test("P1-5: a terminal order carrying a partial fill is never simplified away", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  const exchange = fakeExchange({ seed: [
    { clientOrderId: "expired-partial", orderId: "ex-ep",
      fill: { status: "EXPIRED", executedQty: "0.4", quote: "44" } },
  ] });
  await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "expired-partial" });

  const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /unknown exchange state/);
  assert.match(String(resolution.reason), /partial fill/);
  const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(untouched.quantity, 1, "real exposure is reconciled deliberately, never guessed");
});

test("P1-5: dry run proves nothing, so it can never license a resolution", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  const exchange = fakeExchange();
  await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "dry" });

  const resolution = await resolveUnresolvedExitAttempts(
    trade.id, exitAttemptProbe(exchange.client, true));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /dry run/);
  assert.equal(exchange.lookups.length, 0, "a simulated run consults no exchange");
});

test("P1-5: an attempt owned by the manual protection authority is never booked here", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  const exchange = fakeExchange({ seed: [
    { clientOrderId: "manual-exit", orderId: "ex-manual",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  await crashedExitAttempt(trade, { origin: "manual-protection", clientOrderId: "manual-exit" });

  const resolution = await resolveUnresolvedExitAttempts(trade.id, probeFor(exchange));
  assert.equal(resolution.blocked, true);
  assert.match(String(resolution.reason), /owned by another exit authority/);
  assert.equal(resolution.reconciled, 0);
  const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(untouched.status, "active", "the ManualOrder lifecycle books that fill, not this");
});

// ── The admission surfaces ───────────────────────────────────────────────────

test("P1-5: the webhook Close respects an unresolved TP attempt, then proceeds once it dies",
  async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id });
    const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const live = fakeExchange({ price: "110", freeBase: "10", seed: [
      { clientOrderId: "wedge-tp", orderId: "ex-wedge",
        fill: { status: "NEW", executedQty: "0", quote: "0" } },
    ] });
    await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "wedge-tp" });

    // `skipExitCheck` is the dashboard Close button. It must NOT bypass this.
    await assert.rejects(
      processWebhook({ secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT",
        quantity: trade.quantity }, { skipExitCheck: true, clientFactory: async () => live.client }),
      /a prior exit order has unresolved exchange state/);
    assert.equal(live.submissions.length, 0, "no second SELL was fired at a live TP order");

    live.book.set("wedge-tp", { orderId: "ex-wedge", clientOrderId: "wedge-tp", side: "SELL",
      status: "EXPIRED", executedQty: "0", cummulativeQuoteQty: "0" });
    const result = await processWebhook(
      { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: trade.quantity },
      { skipExitCheck: true, clientFactory: async () => live.client });
    assert.equal(result.status, "ok");
    assert.equal(live.submissions.length, 1, "exactly one close reached the exchange");
    const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(closed.status, "closed");
    assert.equal(heldLockCount(), 0, "the close lock is never leaked");
  });

test("P1-5: a webhook Close finds the crashed TP already filled and places no second order",
  async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id });
    const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
      { clientOrderId: "already-tp", orderId: "ex-already",
        fill: { status: "FILLED", executedQty: "1", quote: "110" } },
    ] });
    await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "already-tp" });

    const result = await processWebhook(
      { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: trade.quantity },
      { skipExitCheck: true, clientFactory: async () => exchange.client });
    assert.equal(result.status, "ignored_duplicate");
    assert.equal(exchange.submissions.length, 0, "no duplicate close was placed");
    const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "take_profit");
  });

test("P1-5: the dashboard partial close respects an unresolved partial attempt", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: "wedge-partial", orderId: "ex-wp",
      fill: { status: "NEW", executedQty: "0", quote: "0" } },
  ] });
  tradeExchangeClient.resolve = () => exchange.client;
  await crashedExitAttempt(trade, {
    origin: "partial", clientOrderId: "wedge-partial", sellPercent: 25 });

  const blocked = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 25 });
  assert.equal(blocked.status, 409);
  assert.match(String((blocked.body as { error: string }).error), /unresolved exchange state/);
  assert.equal(exchange.submissions.length, 0, "no overlapping scale-out reached the exchange");
  assert.equal(heldLockCount(), 0, "the close lock is never leaked");
});

test("P1-5: the TP/SL monitor reconciles its own crashed attempt instead of re-selling", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id,
    takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", seed: [
    { clientOrderId: "monitor-crashed", orderId: "ex-mc",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "monitor-crashed" });

  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
  assert.equal(exchange.submissions.length, 0, "the monitor sent no second SELL");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "take_profit");
  // The stale-SELL guard sees the recovery-discovered close exactly as it would
  // a synchronous one.
  assert.ok(await prisma.pairCloseMark.findUnique({
    where: { botId_pair: { botId: bot.id, pair: "BTCUSDT" } } }));
});

test("P1-5: two concurrent resolvers of one fill cannot both apply it", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", seed: [
    { clientOrderId: "raced", orderId: "ex-raced",
      fill: { status: "FILLED", executedQty: "1", quote: "110" } },
  ] });
  await crashedExitAttempt(trade, { origin: "tpsl", clientOrderId: "raced" });

  const [a, b] = await Promise.all([
    resolveUnresolvedExitAttempts(trade.id, probeFor(exchange)),
    resolveUnresolvedExitAttempts(trade.id, probeFor(exchange)),
  ]);
  assert.equal(a.reconciled + b.reconciled, 1, "exactly one resolver booked the fill");
  assert.equal(exchange.submissions.length, 0);
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  assert.equal(await prisma.exchangeOrderAttempt.count({
    where: { smartTradeId: trade.id, status: "open" } }), 0);
});

test("P1-5: attempt identity and its ownership survive a restart", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot);
  const first = await openOrderAttempt({
    intentKey: `tpsl:${trade.id}:tp`, symbol: "BTCUSDT", side: "SELL",
    smartTradeId: trade.id, origin: "tpsl", closedReason: "take_profit" });
  await markOrderAttemptSubmitted(first.id, 1);

  // A restart holds no state: the identity and the owner come back out of the
  // database, which is exactly why close admission can still see it.
  await prisma.$disconnect();
  const afterRestart = await openOrderAttempt({
    intentKey: `tpsl:${trade.id}:tp`, symbol: "BTCUSDT", side: "SELL",
    smartTradeId: trade.id, origin: "tpsl", closedReason: "take_profit" });
  assert.equal(afterRestart.clientOrderId, first.clientOrderId);
  assert.equal(afterRestart.smartTradeId, trade.id);
  assert.ok(afterRestart.submittedAt, "the submission mark is durable too");

  const visible = await prisma.exchangeOrderAttempt.findMany({
    where: { smartTradeId: trade.id, side: "SELL", status: "open" } });
  assert.equal(visible.length, 1, "the attempt is findable by the position that owns it");
});

test("P1-5: one attempt cannot be applied twice — crash window D", async () => {
  const bot = await createBot();
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const attempt = await crashedExitAttempt(trade, {
    origin: "partial", clientOrderId: "double-apply", sellPercent: 50 });
  const fill = { orderId: "ex-d", executedQty: 0.5, cummulativeQuoteQty: 55, avgPrice: 110 };

  const first = await applyExitFill(attempt, fill);
  assert.ok(first);
  assert.equal(first.executedQty, 0.5);
  const second = await applyExitFill(attempt, fill);
  assert.equal(second, null, "the compare-and-set loser applies nothing at all");

  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.ok(Math.abs(after.quantity - 0.5) < 1e-9, "the position moved once");
  assert.equal(await prisma.partialClose.count({ where: { tradeId: trade.id } }), 1);
});

test("P1-5: local accounting applied but the attempt not yet settled cannot double-book — window D",
  async () => {
    const bot = await createBot();
    const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const attempt = await crashedExitAttempt(trade, {
      origin: "tpsl", clientOrderId: "window-d" });
    // The settle IS the accounting write, in one transaction: there is no state
    // in which the ledger moved and the attempt is still open. Proving it: once
    // some other path settles the attempt, no fill can be applied through it.
    assert.equal(await prisma.$transaction((tx) => settleOrderAttempt(tx, attempt.id, "ex-x")), true);
    const applied = await applyExitFill(attempt,
      { orderId: "ex-x", executedQty: 1, cummulativeQuoteQty: 110, avgPrice: 110 });
    assert.equal(applied, null);
    const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(untouched.quantity, 1);
    assert.equal(untouched.status, "active");
  });

// ════════════════════════════════════════════════════════════════════════════
// BOT-P1-6 — executed quantity is the accounting authority
// ════════════════════════════════════════════════════════════════════════════

for (const scenario of [
  { name: "a full fill", executed: "0.5", quote: "55", expectQty: 0.5, expectRemaining: 0.5,
    expectPartials: 1 },
  { name: "a partial fill", executed: "0.2", quote: "22", expectQty: 0.2, expectRemaining: 0.8,
    expectPartials: 1 },
  { name: "a zero fill", executed: "0", quote: "0", expectQty: 0, expectRemaining: 1,
    expectPartials: 0 },
]) {
  test(`P1-6: a 50% partial close with ${scenario.name} accounts only for what executed`,
    async () => {
      const account = await createAccount();
      const bot = await createBot({ exchangeAccountId: account.id });
      const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
      const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [
        { status: scenario.executed === "0" ? "EXPIRED" : "FILLED",
          executedQty: scenario.executed, quote: scenario.quote },
      ] });
      tradeExchangeClient.resolve = () => exchange.client;

      const response = await callTradesRoute(
        "post", "/:id/partial-close", { id: trade.id }, { pct: 50 });
      assert.equal(response.status, 200);
      const body = response.body as {
        partial: { quantity: number; revenue: number } | null;
        requestedQty: number; executedQty: number;
      };

      // Requested and executed stay distinguishable, always.
      assert.equal(body.requestedQty, 0.5, "the request was for half the position");
      assert.equal(body.executedQty, scenario.expectQty);

      const partials = await prisma.partialClose.findMany({ where: { tradeId: trade.id } });
      assert.equal(partials.length, scenario.expectPartials);
      if (partials[0]) {
        assert.equal(partials[0].quantity, scenario.expectQty,
          "PartialClose.quantity records what SOLD, not what was asked for");
        assert.equal(partials[0].revenue, Number(scenario.quote));
      }

      const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
      assert.ok(Math.abs(after.quantity - scenario.expectRemaining) < 1e-9,
        `position must fall by the executed quantity only (got ${after.quantity})`);
      // Cost basis moves in the same proportion as the quantity, never further.
      assert.ok(Math.abs(after.quoteSpent - scenario.expectRemaining * 100) < 1e-9,
        `cost basis must stay proportional (got ${after.quoteSpent})`);
      assert.equal(after.status, "active", "a partial exit never fabricates a close");
      // The durable attempt keeps the requested figure; the ledger keeps the
      // executed one, so the two can always be told apart after the fact.
      const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
        where: { smartTradeId: trade.id } });
      assert.equal(attempt.requestedBaseQty, 0.5);
      assert.equal(attempt.status, "settled");
    });
}

test("P1-6: a zero fill books no P&L and leaves the exposure fully intact", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100, pnlUsdt: 0 });
  const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [
    { status: "EXPIRED", executedQty: "0", quote: "0" },
  ] });
  tradeExchangeClient.resolve = () => exchange.client;

  const response = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 50 });
  assert.equal(response.status, 200);
  assert.equal((response.body as { partial: unknown }).partial, null);
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.quantity, 1);
  assert.equal(after.quoteSpent, 100);
  assert.equal(after.status, "active");
  assert.equal(await prisma.partialClose.count({ where: { tradeId: trade.id } }), 0);

  // And the slot is free, so the operator can legitimately try again.
  const attempts = await prisma.exchangeOrderAttempt.findMany({ where: { smartTradeId: trade.id } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.status, "settled");
  const retry = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 50 });
  assert.equal(retry.status, 200);
  assert.equal((retry.body as { executedQty: number }).executedQty, 0.5);
  const ids = exchange.submissions.map((s) => String(s.newClientOrderId));
  assert.notEqual(ids[0], ids[1], "the retry is a new logical order with its own id");
});

test("P1-6: a restart-discovered fill lands on exactly the same state as the synchronous one",
  async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id });

    // (a) synchronous: the response is handled normally.
    const syncTrade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const syncExchange = fakeExchange({ price: "110", freeBase: "10", fills: [
      { status: "FILLED", executedQty: "0.2", quote: "22" },
    ] });
    tradeExchangeClient.resolve = () => syncExchange.client;
    assert.equal(
      (await callTradesRoute("post", "/:id/partial-close", { id: syncTrade.id }, { pct: 50 })).status,
      200);

    // (b) recovery: the identical fill is discovered after a crash, by a probe.
    const crashTrade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const crashExchange = fakeExchange({ price: "110", freeBase: "10", seed: [
      { clientOrderId: "same-fill", orderId: "ex-same",
        fill: { status: "FILLED", executedQty: "0.2", quote: "22" } },
    ] });
    await crashedExitAttempt(crashTrade, {
      origin: "partial", clientOrderId: "same-fill", sellPercent: 50, requestedBaseQty: 0.5 });
    const resolution = await resolveUnresolvedExitAttempts(crashTrade.id, probeFor(crashExchange));
    assert.equal(resolution.reconciled, 1);

    const sync = await prisma.smartTrade.findUniqueOrThrow({ where: { id: syncTrade.id } });
    const recovered = await prisma.smartTrade.findUniqueOrThrow({ where: { id: crashTrade.id } });
    assert.equal(recovered.quantity, sync.quantity);
    assert.equal(recovered.quoteSpent, sync.quoteSpent);
    assert.equal(recovered.status, sync.status);

    const syncPartial = await prisma.partialClose.findFirstOrThrow({
      where: { tradeId: syncTrade.id } });
    const recoveredPartial = await prisma.partialClose.findFirstOrThrow({
      where: { tradeId: crashTrade.id } });
    assert.equal(recoveredPartial.quantity, syncPartial.quantity);
    assert.equal(recoveredPartial.revenue, syncPartial.revenue);
    assert.equal(recoveredPartial.pnlUsdt, syncPartial.pnlUsdt);
    assert.equal(recoveredPartial.pct, syncPartial.pct);
  });

test("P1-6: a partial TP fill removes only the executed quantity and re-arms for the rest",
  async () => {
    const account = await createAccount();
    const bot = await createBot({ exchangeAccountId: account.id,
      takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false });
    const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
    const exchange = fakeExchange({ price: "110", freeBase: "10", fills: [
      { status: "EXPIRED", executedQty: "0", quote: "0" },
      { status: "FILLED", executedQty: "0.4", quote: "44" },
      { status: "FILLED", executedQty: "0.6", quote: "66" },
    ] });

    // A zero fill changes nothing at all — no fictitious close, no P&L.
    await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
    const afterZero = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(afterZero.status, "active");
    assert.equal(afterZero.quantity, 1);
    assert.equal(afterZero.quoteSpent, 100);

    await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
    const afterPartial = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(afterPartial.status, "active", "a 40% fill must not mark the trade closed");
    assert.ok(Math.abs(afterPartial.quantity - 0.6) < 1e-9);
    assert.ok(Math.abs(afterPartial.quoteSpent - 60) < 1e-9, "cost basis stays proportional");

    await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
    const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "take_profit");

    const ids = exchange.submissions.map((s) => String(s.newClientOrderId));
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3, "each cycle is a distinct logical order");
  });

test("P1-6: precision and step rules still govern the requested quantity", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  // 33% of 0.29 is 0.0957, which the 0.0001 step floors to 0.0957.
  const trade = await createTrade(bot, { quantity: 0.29, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "0.29" });
  tradeExchangeClient.resolve = () => exchange.client;

  const response = await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 33 });
  assert.equal(response.status, 200);
  const submitted = Number(exchange.submissions[0]!.quantity);
  assert.equal(submitted, 0.0957, "step-normalised, and never above the requested slice");
  const partial = await prisma.partialClose.findFirstOrThrow({ where: { tradeId: trade.id } });
  assert.equal(partial.quantity, 0.0957, "the executed quantity is the normalised one");
});

// ── Regression: the surrounding behaviour must be unchanged ──────────────────

test("regression: a normal SL close still closes the trade and marks the pair", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id,
    takeProfitEnabled: false, stopLossEnabled: true, stopLossPct: 3 });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "90", freeBase: "10" });

  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "stop_loss");
  assert.equal(exchange.submissions.length, 1);
  assert.ok(await prisma.pairCloseMark.findUnique({
    where: { botId_pair: { botId: bot.id, pair: "BTCUSDT" } } }));
  assert.equal(heldLockCount(), 0);
});

test("regression: a full close through the webhook still books the accumulated P&L", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  tradeExchangeClient.resolve = () => exchange.client;

  // A 50% scale-out first, then the full close.
  assert.equal(
    (await callTradesRoute("post", "/:id/partial-close", { id: trade.id }, { pct: 50 })).status, 200);
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT" },
    { skipExitCheck: true, clientFactory: async () => exchange.client });
  assert.equal(result.status, "ok");

  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  const partials = await prisma.partialClose.findMany({ where: { tradeId: trade.id } });
  assert.equal(partials.length, 1);
  assert.ok(closed.pnlUsdt > partials[0]!.pnlUsdt,
    "the final total accumulates the partial leg as well as the closing leg");
  assert.equal(exchange.submissions.length, 2, "one scale-out and one close, no more");
});

test("regression: a SELL is never refused on Shariah grounds", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  // The strictest possible posture: enforcement on, with nothing cleared.
  await prisma.shariahEnforcement.upsert({
    where: { scope: "global" },
    create: { scope: "global", mode: "enforce" },
    update: { mode: "enforce" },
  });

  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "SELL", symbol: "BTCUSDT", quantity: trade.quantity },
    { skipExitCheck: true, clientFactory: async () => exchange.client });
  assert.equal(result.status, "ok", "an exit is never gated on a Shariah decision");
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  await prisma.shariahEnforcement.deleteMany();
});

test("regression: a halted bot places no TP/SL order and leaves the position untouched", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id,
    takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false });
  const trade = await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  await prisma.riskControl.upsert({
    where: { id: "global" },
    create: { id: "global", tradingHalted: true, haltedReason: "test" },
    update: { tradingHalted: true },
  });

  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });
  assert.equal(exchange.submissions.length, 0);
  const untouched = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(untouched.status, "active");
  assert.equal(await prisma.exchangeOrderAttempt.count({ where: { smartTradeId: trade.id } }), 0,
    "the halt is checked before any attempt is reserved");
  await prisma.riskControl.deleteMany();
});

test("regression: Spot-only — every exit this repair touches is a spot MARKET SELL", async () => {
  const account = await createAccount();
  const bot = await createBot({ exchangeAccountId: account.id,
    takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false });
  await createTrade(bot, { quantity: 1, quoteSpent: 100 });
  const exchange = fakeExchange({ price: "110", freeBase: "10" });
  await checkTakeProfitStopLoss({ resolveClient: async () => exchange.client });

  assert.ok(exchange.submissions.length > 0, "the exit actually reached the fake exchange");
  for (const submission of exchange.submissions) {
    assert.equal(submission.side, "SELL");
    assert.equal(submission.type, "MARKET");
    assert.ok(!("reduceOnly" in submission), "no futures-only field is ever sent");
    assert.ok(!("positionSide" in submission));
  }
});
