/**
 * B-SLICE2 — the trade-id-targeted operator exit (C6 Close / C7 Partial, shared
 * with the Classic dashboard).
 *
 *   - Close selects the trade BY ID (`operatorTarget`), never "the newest for
 *     the pair": a paused bot's trade, a trade whose pair was delisted and one
 *     of several sibling trades are each closable on their own, with exactly
 *     one order, and nothing else is sold;
 *   - sibling closes get distinct dedupe legs and intent scopes
 *     (`op:<tradeId>:<commandKey>`): two in one minute are two intents and two
 *     orders; the same command twice is one;
 *   - the intent reconciler lets an OPERATOR SELL finish for a paused bot; an
 *     automated SELL for a paused bot is still held;
 *   - `trade_manual` and `bot_deleted` stay refusals; the halt and the entries
 *     pause never block an operator exit.
 *
 * Real services + disposable SQLite + the in-memory fake exchange. No network.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SignalBot, SmartTrade } from "@prisma/client";
import { fakeBinance, type FakeBinance } from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".operator-exit-test.db");
process.env.DATABASE_URL = "file:./tests/.operator-exit-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { closeStrategyTrade, partialCloseStrategyTrade, tradeExchangeClient } =
  await import("../src/services/tradeExit.js");
const { processWebhook } = await import("../src/services/webhook.js");
const strategy = await import("../src/services/strategyOrderIntent.js");
const risk = await import("../src/services/riskControls.js");
const { heldLockCount } = await import("../src/lib/tradeCloseLock.js");
const { ControlRefusal } = await import("../src/services/controlCommands.js");
const { readControlStatus } = await import("../src/routes/manualControl.js");
const { __clearCloseMarkCache } = await import("../src/lib/tradeCloseTracker.js");

const original = { dryRun: config.dryRun, resolve: tradeExchangeClient.resolve };

after(async () => {
  config.dryRun = original.dryRun;
  tradeExchangeClient.resolve = original.resolve;
  tradeExchangeClient.closeFactory = null;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  config.dryRun = false;
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
});

function useExchange(exchange: FakeBinance): void {
  tradeExchangeClient.resolve = () => exchange.client;
  tradeExchangeClient.closeFactory = async () => exchange.client;
}

let n = 0;
async function createBot(overrides: Record<string, unknown> = {}): Promise<SignalBot> {
  n += 1;
  return prisma.signalBot.create({ data: { name: `op bot ${n}`,
    webhookSecret: `o${String(n).padStart(3, "0")}${"t".repeat(36)}`, pairs: JSON.stringify(["BTCUSDT"]),
    ...overrides } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function createTrade(bot: SignalBot, overrides: Record<string, unknown> = {}): Promise<SmartTrade> {
  return prisma.smartTrade.create({ data: { botId: bot.id, botName: bot.name, pair: "BTCUSDT",
    status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100,
    createdAt: new Date(Date.now() - 3_600_000), ...overrides } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

const status = async (id: string) => (await prisma.smartTrade.findUniqueOrThrow({ where: { id } })).status;

for (const shape of [
  { name: "a paused bot's trade", bot: { status: "paused" } },
  { name: "a trade whose pair was delisted", bot: { pairs: JSON.stringify(["ETHUSDT"]) } },
  { name: "a trade whose bot has exits disabled", bot: { exitEnabled: false } },
]) {
  test(`C6 targeted: ${shape.name} is closed — exactly that trade, one order`, async () => {
    const exchange = fakeBinance({ freeBase: "1" });
    useExchange(exchange);
    const bot = await createBot(shape.bot);
    const trade = await createTrade(bot, { quantity: 0.6 });
    const result = await closeStrategyTrade(trade.id, {}, { commandKey: `req-${n}` });
    assert.equal(result.status, "ok");
    assert.equal(exchange.accepted("SELL").length, 1);
    assert.equal(Number(exchange.accepted("SELL")[0]!.executedQty), 0.6);
    assert.equal(await status(trade.id), "closed");
    const intent = await prisma.strategyOrderIntent.findFirstOrThrow({ where: { smartTradeId: trade.id } });
    assert.equal(intent.status, "reconciled");
    assert.equal(intent.skipExitCheck, true);
    assert.equal(intent.platformDedupeKey, null, "no realization, as before");
    assert.match(intent.sourceKey, new RegExp(`:sell:op:${trade.id}:req-${n}$`));
    assert.equal(heldLockCount(), 0);
  });
}

test("C6 targeted: one of twin trades is closed alone; two sibling closes in one minute are two intents and two orders",
  async () => {
    const exchange = fakeBinance({ freeBase: "2" });
    useExchange(exchange);
    const bot = await createBot({ maxEntryOrders: 2 });
    const older = await createTrade(bot, { quantity: 0.4 });
    const newer = await createTrade(bot, { quantity: 0.7, createdAt: new Date() });
    // The dashboard path: no request id, so its minute bucket names the command.
    await closeStrategyTrade(older.id);
    assert.equal(await status(older.id), "closed");
    assert.equal(await status(newer.id), "active", "the newest sibling is not what a targeted close sells");
    await closeStrategyTrade(newer.id);
    assert.equal(await status(newer.id), "closed");
    const sells = exchange.accepted("SELL").map((o) => Number(o.executedQty));
    assert.deepEqual(sells, [0.4, 0.7]);
    assert.equal(await prisma.strategyOrderIntent.count({ where: { side: "SELL" } }), 2);
  });

test("C6 targeted: the same command twice is one intent and one order; a closed trade is trade_not_active", async () => {
  const exchange = fakeBinance({ freeBase: "1" });
  useExchange(exchange);
  const bot = await createBot();
  const trade = await createTrade(bot);
  await closeStrategyTrade(trade.id, {}, { commandKey: "req-same" });
  const again = await closeStrategyTrade(trade.id, {}, { commandKey: "req-same" })
    .then(() => null, (error: unknown) => error);
  assert.ok(again instanceof ControlRefusal);
  assert.equal(again.code, "trade_not_active");
  assert.equal(exchange.accepted("SELL").length, 1);
  assert.equal(await prisma.strategyOrderIntent.count(), 1);
});

test("C6 targeted: trade_manual and bot_deleted stay refusals, with no order", async () => {
  const exchange = fakeBinance({ freeBase: "1" });
  useExchange(exchange);
  const bot = await createBot();
  const manualTrade = await prisma.smartTrade.create({ data: { source: "manual", botName: "Manual",
    pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100 } });
  const orphan = await createTrade(bot);
  await prisma.smartTrade.update({ where: { id: orphan.id }, data: { botId: null } });
  for (const [id, code] of [[manualTrade.id, "trade_manual"], [orphan.id, "bot_deleted"]] as const) {
    const refusal = await closeStrategyTrade(id).then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof ControlRefusal);
    assert.equal(refusal.code, code);
  }
  assert.equal(exchange.submissions.length, 0);
});

test("C6 targeted: neither the halt nor the entries pause blocks an operator close", async () => {
  const exchange = fakeBinance({ freeBase: "2" });
  useExchange(exchange);
  const bot = await createBot({ status: "paused" });
  const halted = await createTrade(bot);
  await risk.setBotTradingHalted(true, { by: "operator", reason: "op test" });
  await risk.setEntriesPaused({ paused: true, reason: "op test", by: "test" });
  await closeStrategyTrade(halted.id, {}, { commandKey: "req-halted" });
  assert.equal(await status(halted.id), "closed");
  assert.equal(exchange.accepted("SELL").length, 1);
});

test("C7 targeted: a paused bot's, a delisted pair's and one twin's trade each sell exactly their own slice", async () => {
  const exchange = fakeBinance({ freeBase: "10" });
  useExchange(exchange);
  const paused = await createTrade(await createBot({ status: "paused" }), { quantity: 1 });
  const delisted = await createTrade(await createBot({ pairs: JSON.stringify(["ETHUSDT"]) }), { quantity: 1 });
  const twinBot = await createBot({ maxEntryOrders: 2 });
  const twin = await createTrade(twinBot, { quantity: 1 });
  const sibling = await createTrade(twinBot, { quantity: 1, createdAt: new Date() });
  for (const trade of [paused, delisted, twin]) {
    const result = await partialCloseStrategyTrade(trade.id, 25);
    assert.equal(result.executedQty, 0.25);
    const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(after.status, "active");
    assert.equal(after.quantity, 0.75);
  }
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: sibling.id } })).quantity, 1);
  assert.equal(exchange.accepted("SELL").length, 3);
});

test("reconciler: an operator SELL intent of a paused bot is submitted and booked; an automated one is still held",
  async () => {
    const exchange = fakeBinance({ freeBase: "2" });
    const bot = await createBot({ status: "paused" });
    const operatorTrade = await createTrade(bot, { quantity: 0.5 });
    const automatedTrade = await createTrade(bot, { quantity: 0.5, pair: "BTCUSDT" });
    const intent = (key: string, trade: SmartTrade, skipExitCheck: boolean) =>
      prisma.strategyOrderIntent.create({ data: { sourceKey: key, botId: bot.id, botName: bot.name,
        clientOrderId: `${key}-cid`, symbol: "BTCUSDT", side: "SELL", requestedBaseQty: 0.5, skipExitCheck,
        smartTradeId: trade.id, status: "requested" } });
    const operatorIntent = await intent("op-intent", operatorTrade, true);
    const automatedIntent = await intent("auto-intent", automatedTrade, false);
    await strategy.reconcilePendingStrategyIntents(async () => strategy.strategyMarketAdapter(exchange.client, false));
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: operatorIntent.id } })).status,
      "reconciled");
    assert.equal(await status(operatorTrade.id), "closed");
    const held = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: automatedIntent.id } });
    assert.equal(held.status, "requested");
    assert.match(held.error ?? "", /Strategy bot is not active/);
    assert.equal(await status(automatedTrade.id), "active");
    assert.equal(exchange.accepted("SELL").length, 1);
  });

test("processWebhook: operatorTarget is honoured only for an operator SELL; a misuse is refused before anything is reserved",
  async () => {
    const exchange = fakeBinance();
    const bot = await createBot();
    const trade = await createTrade(bot);
    const target = { smartTradeId: trade.id, commandKey: "k" };
    for (const [body, opts] of [
      [{ action: "BUY", quote_order_qty: 10 }, { skipExitCheck: true }],
      [{ action: "SELL" }, { skipExitCheck: false }],
      [{ action: "SELL", dedupe_key: "d-1" }, { skipExitCheck: true }],
    ] as const) {
      await assert.rejects(processWebhook({ secret: bot.webhookSecret, symbol: "BTCUSDT", ...body },
        { ...opts, operatorTarget: target, clientFactory: async () => exchange.client }),
      /operatorTarget is honoured only/);
    }
    assert.equal(await prisma.webhookLog.count(), 0);
    assert.equal(await prisma.webhookReceipt.count(), 0);
    assert.equal(exchange.submissions.length, 0);
    // A target that is not this bot's trade is refused, never substituted.
    const other = await createBot();
    await assert.rejects(processWebhook({ secret: other.webhookSecret, symbol: "BTCUSDT", action: "SELL" },
      { skipExitCheck: true, operatorTarget: target, clientFactory: async () => exchange.client }),
    (error: unknown) => (error as { code?: string }).code === "trade_not_active");
    assert.equal(exchange.submissions.length, 0);
    assert.equal(await status(trade.id), "active");
  });

test("C0 advertises operatorExit.v1", async () => {
  const c0 = await readControlStatus();
  assert.ok(c0.capabilities.includes("operatorExit.v1"));
});
