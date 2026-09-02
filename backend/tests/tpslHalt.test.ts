/**
 * F-AUTO-01: the global halt must stop the automated TP/SL monitor's real
 * exchange submission, exactly like it already stops webhook execution and
 * manual protective TP/SL.
 *
 * These run against in-memory fakes for the `prisma.smartTrade`,
 * `prisma.riskControl`, `prisma.partialClose` and `prisma.pairCloseMark`
 * delegates (the same technique `manualTrading.test.ts` uses), so no real
 * database or Binance call is involved.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { prisma } from "../src/lib/prisma.js";
import { checkTakeProfitStopLoss } from "../src/services/smartTrade.js";
import type { BinanceClient } from "../src/services/binance.js";

// The suite's default DRY_RUN=true never reaches `client.order()` at all, which
// would make these tests pass even without the halt fix. Real (mocked) order
// submission is needed so a missing halt check is visible as a real SELL call.
const originalDryRun = config.dryRun;
before(() => { config.dryRun = false; });
after(() => { config.dryRun = originalDryRun; });

type FakeBot = {
  id: string;
  exchangeAccountId: string | null;
  takeProfitEnabled: boolean;
  takeProfitPct: number | null;
  stopLossEnabled: boolean;
  stopLossPct: number | null;
};

type FakeTrade = {
  id: string;
  botId: string;
  pair: string;
  status: string;
  quantity: number;
  quoteSpent: number;
  currentPrice: number | null;
  pnlUsdt: number;
  pnlPct: number;
  closedReason?: string | null;
};

function delegate(model: object): Record<string, (...args: unknown[]) => Promise<unknown>> {
  return model as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
}

/** Swaps the delegate methods `checkTakeProfitStopLoss` touches for in-memory fakes. */
function installFakePrisma(bot: FakeBot, trade: FakeTrade) {
  const trades = new Map<string, FakeTrade>([[trade.id, { ...trade }]]);
  let halted = false;

  const smartTrade = delegate(prisma.smartTrade);
  const riskControl = delegate(prisma.riskControl);
  const partialClose = delegate(prisma.partialClose);
  const pairCloseMark = delegate(prisma.pairCloseMark);
  const originals = {
    findMany: smartTrade.findMany, findUnique: smartTrade.findUnique, update: smartTrade.update,
    riskFindUnique: riskControl.findUnique,
    partialFindMany: partialClose.findMany,
    pairUpsert: pairCloseMark.upsert,
  };

  const withBot = (t: FakeTrade) => ({ ...t, bot: { ...bot } });

  smartTrade.findMany = async (arg: unknown) => {
    const { where } = (arg ?? {}) as { where?: { status?: string } };
    return [...trades.values()].filter((t) => !where?.status || t.status === where.status).map(withBot);
  };
  smartTrade.findUnique = async (arg: unknown) => {
    const { where } = arg as { where: { id: string } };
    const t = trades.get(where.id);
    return t ? withBot(t) : null;
  };
  smartTrade.update = async (arg: unknown) => {
    const { where, data } = arg as { where: { id: string }; data: Record<string, unknown> };
    const t = trades.get(where.id)!;
    Object.assign(t, data);
    return withBot(t);
  };
  riskControl.findUnique = async () => (halted
    ? { id: "global", tradingHalted: true, haltedReason: "operator", haltedBy: "operator",
      haltedAt: new Date(), maxTotalExposureQuote: null, maxConcurrentTrades: null,
      maxDailyLossQuote: null, dailyLossWindowHours: 24, updatedAt: new Date() }
    : null);
  partialClose.findMany = async () => [];
  pairCloseMark.upsert = async () => ({});

  return {
    trades,
    setHalted: (v: boolean) => { halted = v; },
    restore: () => {
      smartTrade.findMany = originals.findMany;
      smartTrade.findUnique = originals.findUnique;
      smartTrade.update = originals.update;
      riskControl.findUnique = originals.riskFindUnique;
      partialClose.findMany = originals.partialFindMany;
      pairCloseMark.upsert = originals.pairUpsert;
    },
  };
}

function fakeClient(price: string, calls: Record<string, unknown>[]): BinanceClient {
  return {
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: price }),
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "1", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.0001", minQty: "0.0001" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      return { orderId: "recovered-or-live-sell", clientOrderId: payload.newClientOrderId,
        side: "SELL", status: "FILLED", executedQty: "1", cummulativeQuoteQty: "110" };
    },
  } as unknown as BinanceClient;
}

const bot: FakeBot = {
  id: "halt-bot", exchangeAccountId: null,
  takeProfitEnabled: true, takeProfitPct: 5,
  stopLossEnabled: true, stopLossPct: 3,
};

test("F-AUTO-01 A: an active trade beyond TP while halted places no SELL and stays active", async () => {
  const trade: FakeTrade = { id: "trade-tp-halted", botId: bot.id, pair: "BTCUSDT", status: "active",
    quantity: 1, quoteSpent: 100, currentPrice: null, pnlUsdt: 0, pnlPct: 0 };
  const fake = installFakePrisma(bot, trade);
  fake.setHalted(true);
  const calls: Record<string, unknown>[] = [];
  try {
    await checkTakeProfitStopLoss({ resolveClient: async () => fakeClient("110", calls) });
  } finally {
    fake.restore();
  }
  assert.equal(calls.length, 0, "no exchange SELL was submitted while halted");
  const stored = fake.trades.get(trade.id)!;
  assert.ok(stored.pnlPct >= 5, "the trade genuinely crossed the TP threshold this cycle");
  assert.equal(stored.status, "active", "the trade was left active, not falsely closed");
});

test("F-AUTO-01 B: an active trade beyond SL while halted places no SELL and stays active", async () => {
  const trade: FakeTrade = { id: "trade-sl-halted", botId: bot.id, pair: "BTCUSDT", status: "active",
    quantity: 1, quoteSpent: 100, currentPrice: null, pnlUsdt: 0, pnlPct: 0 };
  const fake = installFakePrisma(bot, trade);
  fake.setHalted(true);
  const calls: Record<string, unknown>[] = [];
  try {
    await checkTakeProfitStopLoss({ resolveClient: async () => fakeClient("90", calls) });
  } finally {
    fake.restore();
  }
  assert.equal(calls.length, 0, "no exchange SELL was submitted while halted");
  const stored = fake.trades.get(trade.id)!;
  assert.ok(stored.pnlPct <= -3, "the trade genuinely crossed the SL threshold this cycle");
  assert.equal(stored.status, "active", "the trade was left active, not falsely closed");
});

test("F-AUTO-01 C: once halt clears, the same eligible trade closes via TP exactly as before", async () => {
  const trade: FakeTrade = { id: "trade-tp-resumed", botId: bot.id, pair: "BTCUSDT", status: "active",
    quantity: 1, quoteSpent: 100, currentPrice: null, pnlUsdt: 0, pnlPct: 0 };
  const fake = installFakePrisma(bot, trade);
  fake.setHalted(false);
  const calls: Record<string, unknown>[] = [];
  try {
    await checkTakeProfitStopLoss({ resolveClient: async () => fakeClient("110", calls) });
  } finally {
    fake.restore();
  }
  assert.equal(calls.length, 1, "the SELL reached the exchange path once halt cleared");
  const stored = fake.trades.get(trade.id)!;
  assert.equal(stored.status, "closed");
  assert.equal(stored.closedReason, "take_profit");
});
