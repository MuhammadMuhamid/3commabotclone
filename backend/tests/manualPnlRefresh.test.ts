/**
 * The monitor skipped every trade with no bot, so a manual position's current
 * price and open P&L stayed at their entry values for as long as it was open.
 *
 * Those trades are now priced, and only priced: the monitor must never sell one,
 * because manual take-profit and stop-loss belong to `manualProtection.ts`.
 *
 * No network. No Binance. The client is a fake with no order methods, so an
 * attempted sell throws.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Its own database: `node --test` runs files in parallel, and suites sharing a
// SQLite fixture race over it. Chosen before anything constructs Prisma.
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".manual-pnl-test.db");
process.env.DATABASE_URL = "file:./tests/.manual-pnl-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { prisma } = await import("../src/lib/prisma.js");
const { calcUnrealizedPnl, checkTakeProfitStopLoss, updateSmartTradePnl } = await import("../src/services/smartTrade.js");

type Client = Parameters<typeof updateSmartTradePnl>[1];

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

afterEach(async () => {
  await prisma.smartTrade.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

function priceClient(prices: Record<string, string>) {
  const asked: string[] = [];
  const client = {
    prices: async ({ symbol }: { symbol: string }) => {
      asked.push(symbol);
      if (!(symbol in prices)) throw new Error("no price");
      return { [symbol]: prices[symbol] };
    },
  } as unknown as NonNullable<Client>;
  return { client, asked };
}

const account = (name: string) => prisma.exchangeAccount.create({ data: {
  name, exchange: "binance", marketType: "spot", apiKeyEnc: "fixture", apiSecretEnc: "fixture", testnet: true,
} });

const manualTrade = (accountId: string | null, pair = "BTCUSDT", extra: Record<string, unknown> = {}) =>
  prisma.smartTrade.create({ data: {
    source: "manual", pair, status: "active", entryPrice: 100, currentPrice: 100, quantity: 1,
    quoteSpent: 100, exchangeAccountId: accountId, ...extra,
  } });

test("a manual trade's price and open P&L follow the market, through its own account", async () => {
  const mine = await account("Mine");
  const trade = await manualTrade(mine.id);
  const { client } = priceClient({ BTCUSDT: "120" });
  const seen: unknown[] = [];
  await checkTakeProfitStopLoss({ resolveClient: async (id) => { seen.push(id); return client; } });
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  const expected = calcUnrealizedPnl(1, 120, 100);
  assert.equal(after.currentPrice, 120);
  // Money columns are stored rounded, so compare at that precision.
  assert.ok(Math.abs(after.pnlUsdt - expected.pnlUsdt) < 1e-6);
  assert.ok(Math.abs(after.pnlPct - expected.pnlPct) < 1e-6);
  assert.ok(after.pnlUsdt > 0);
  assert.deepEqual(seen, [mine.id]);
});

test("a loss reads as a loss", async () => {
  const mine = await account("Mine");
  const trade = await manualTrade(mine.id);
  await checkTakeProfitStopLoss({ resolveClient: async () => priceClient({ BTCUSDT: "80" }).client });
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.currentPrice, 80);
  assert.ok(after.pnlUsdt < 0);
});

test("the monitor never closes a manual trade, even past its take-profit and stop-loss", async () => {
  const mine = await account("Mine");
  const trade = await manualTrade(mine.id, "BTCUSDT", { manualTpPrice: 110, manualSlPrice: 90,
    protectionState: "active", protectionType: "bot_managed" });
  for (const price of ["500", "1"]) {
    await checkTakeProfitStopLoss({ resolveClient: async () => priceClient({ BTCUSDT: price }).client });
    const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
    assert.equal(after.status, "active");
    assert.equal(after.currentPrice, Number(price));
  }
});

test("a trade whose bot was deleted is priced too, and isn't closed", async () => {
  const mine = await account("Mine");
  const trade = await manualTrade(mine.id, "ETHUSDT", { source: "strategy", botName: "Gone" });
  await checkTakeProfitStopLoss({ resolveClient: async () => priceClient({ ETHUSDT: "130" }).client });
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.currentPrice, 130);
  assert.equal(after.status, "active");
});

test("two accounts on one pair are each priced through their own client", async () => {
  const [a, b] = [await account("A"), await account("B")];
  const [tradeA, tradeB] = [await manualTrade(a.id), await manualTrade(b.id)];
  const clients = new Map([[a.id, priceClient({ BTCUSDT: "110" }).client], [b.id, priceClient({ BTCUSDT: "90" }).client]]);
  await checkTakeProfitStopLoss({ resolveClient: async (id) => clients.get(id as string) });
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: tradeA.id } })).currentPrice, 110);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: tradeB.id } })).currentPrice, 90);
});

test("a pair with no price leaves its trade as it was and doesn't stop the others", async () => {
  const mine = await account("Mine");
  const [unpriced, priced] = [await manualTrade(mine.id, "GONEUSDT"), await manualTrade(mine.id, "BTCUSDT")];
  await checkTakeProfitStopLoss({ resolveClient: async () => priceClient({ BTCUSDT: "120" }).client });
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: priced.id } })).currentPrice, 120);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: unpriced.id } })).currentPrice, 100);
});

test("an account that can't be opened for a manual trade doesn't stop a strategy trade's stop-loss", async () => {
  const [broken, working] = [await account("Broken"), await account("Working")];
  const manual = await manualTrade(broken.id);
  const bot = await prisma.signalBot.create({ data: {
    name: "Trend", pairs: JSON.stringify(["ETHUSDT"]), webhookSecret: `secret-${Date.now()}`, exchangeAccountId: working.id,
    takeProfitEnabled: false, stopLossEnabled: true, stopLossPct: 5,
  } });
  const strategy = await manualTrade(null, "ETHUSDT", { source: "strategy", botId: bot.id, botName: bot.name });
  await checkTakeProfitStopLoss({ resolveClient: async (id) => {
    if (id === broken.id) throw new Error("could not decrypt");
    return priceClient({ ETHUSDT: "50" }).client;
  } });
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: manual.id } })).currentPrice, 100);
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: strategy.id } });
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "stop_loss");
});

test("a closed trade keeps its final figures", async () => {
  const mine = await account("Mine");
  const trade = await manualTrade(mine.id, "BTCUSDT", { status: "closed", pnlUsdt: 7, pnlPct: 7, currentPrice: 107 });
  await checkTakeProfitStopLoss({ resolveClient: async () => priceClient({ BTCUSDT: "500" }).client });
  await updateSmartTradePnl(trade.id, priceClient({ BTCUSDT: "500" }).client, 500);
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.pnlUsdt, 7);
  assert.equal(after.currentPrice, 107);
});

test("a strategy trade's take-profit still fires through its bot", async () => {
  const mine = await account("Mine");
  const bot = await prisma.signalBot.create({ data: {
    name: "Trend", pairs: JSON.stringify(["BTCUSDT"]), webhookSecret: `secret-${Date.now()}`, exchangeAccountId: mine.id,
    takeProfitEnabled: true, takeProfitPct: 5, stopLossEnabled: false,
  } });
  const trade = await manualTrade(null, "BTCUSDT", { source: "strategy", botId: bot.id, botName: bot.name });
  const seen: unknown[] = [];
  await checkTakeProfitStopLoss({ resolveClient: async (id) => { seen.push(id); return priceClient({ BTCUSDT: "120" }).client; } });
  assert.deepEqual(seen, [mine.id], "a strategy trade is priced through its bot's account");
  const after = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(after.status, "closed");
  assert.equal(after.closedReason, "take_profit");
});
