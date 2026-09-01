import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExchangeAccount } from "@prisma/client";
import { config } from "../src/config.js";
import { prisma } from "../src/lib/prisma.js";
import { BinanceManualExchange, type ManualExchangeAdapter,
  type ManualOrderSnapshot } from "../src/services/manualExchange.js";
import { reserveManualNonce } from "../src/services/manualAuth.js";
import { applyManualSnapshot, cancelManualOrder, reconcileOneManualOrder,
  reconcilePendingManualOrders, runIdempotentManualCommand,
  submitManualOrder } from "../src/services/manualTrading.js";
import { clientOrderId, marketBuyQuote, marketSellBase } from "../src/services/binance.js";
import { processWebhook } from "../src/services/webhook.js";
import {
  reconcilePendingStrategyIntents, reconcileStrategyIntent, reserveStrategyIntent,
  strategyMarketAdapter, type StrategyMarketAdapter,
} from "../src/services/strategyOrderIntent.js";
import {
  readManualExecutionEvidence, readStrategyExecutionEvidence,
} from "../src/services/executionEvidence.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".tmp-test.db");
const originalConfig = {
  dryRun: config.dryRun,
  manualTradingEnabled: config.manualTradingEnabled,
  mainnetManualTradingEnabled: config.mainnetManualTradingEnabled,
};

function snapshot(status: ManualOrderSnapshot["status"], base = 0, quote = 0,
  clientOrderId = "client-1"): ManualOrderSnapshot {
  return { exchangeOrderId: "exchange-1", clientOrderId, status,
    executedBaseQuantity: base, executedQuoteQuantity: quote,
    averagePrice: base > 0 ? quote / base : null, simulated: false };
}

async function createAccount(overrides: Partial<ExchangeAccount> = {}): Promise<ExchangeAccount> {
  return prisma.exchangeAccount.create({ data: {
    name: "Reliability fixture", exchange: "binance", marketType: "spot",
    apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true, ...overrides,
  } });
}

async function clearDatabase(): Promise<void> {
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.manualCommand.deleteMany();
  await prisma.manualNonce.deleteMany();
  await prisma.webhookReceipt.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.pairCloseMark.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
}

before(() => {
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
  execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"], {
    cwd: backendRoot, env: process.env, stdio: "pipe",
  });
  config.dryRun = false;
  config.manualTradingEnabled = true;
  config.mainnetManualTradingEnabled = false;
});

beforeEach(clearDatabase);

after(async () => {
  Object.assign(config, originalConfig);
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

test("durable nonce and command identities survive a database reconnect", async () => {
  const nonceStore = {
    prune: async (beforeDate: Date) => {
      await prisma.manualNonce.deleteMany({ where: { expiresAt: { lt: beforeDate } } });
    },
    create: async (nonce: string, expiresAt: Date) => {
      await prisma.manualNonce.create({ data: { nonce, expiresAt } });
    },
  };
  const expires = new Date(Date.now() + 60_000);
  assert.equal(await reserveManualNonce("durable-nonce", expires, nonceStore), true);
  await prisma.$disconnect();
  assert.equal(await reserveManualNonce("durable-nonce", expires, nonceStore), false);

  let runs = 0;
  const first = await runIdempotentManualCommand("durable-request", "submit_order",
    async () => ({ run: ++runs }));
  await prisma.$disconnect();
  const replay = await runIdempotentManualCommand("durable-request", "submit_order",
    async () => ({ run: ++runs }));
  assert.deepEqual(first, { run: 1 });
  assert.deepEqual(replay, first);
  assert.equal(runs, 1);
});

test("persisted execution evidence uses exact indexed identities and exact cancel-result linkage", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Evidence strategy", webhookSecret: "e".repeat(40),
    pairs: JSON.stringify(["BTCUSDT"]),
  } });
  const sourceKey = `${bot.id}:BTCUSDT:buy:L-1788264000000`;
  const strategy = await prisma.strategyOrderIntent.create({ data: {
    sourceKey, botId: bot.id, botName: bot.name, clientOrderId: "strategy-evidence-client",
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "submitted", submittedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 1)),
  } });
  const strategyRead = await readStrategyExecutionEvidence({
    secret: bot.webhookSecret, symbol: "BTCUSDT", side: "buy", dedupeKey: "L-1788264000000",
  });
  assert.equal(strategyRead.evidence?.identity.strategyOrderIntentId, strategy.id);
  assert.equal(strategyRead.evidence?.events.at(-1)?.type, "SUBMISSION_ATTEMPTED");

  const account = await createAccount();
  const order = await prisma.manualOrder.create({ data: {
    requestId: "manual_evidence_order", exchangeAccountId: account.id,
    symbol: "ETHUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote",
    requestedQuoteQty: 200, limitPrice: 2000, clientOrderId: "manual-evidence-client",
    status: "canceled", exchangeOrderId: "manual-evidence-exchange",
    submittedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 2)),
    completedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, 3)),
    filledBaseQty: 0.05, filledQuoteQty: 100,
  } });
  const linked = await prisma.manualCommand.create({ data: {
    requestId: "manual_evidence_cancel", kind: "cancel_order", status: "succeeded",
    result: JSON.stringify({ id: order.id, requestId: order.requestId }),
  } });
  await prisma.manualCommand.create({ data: {
    requestId: "manual_evidence_unrelated", kind: "cancel_order", status: "succeeded",
    result: JSON.stringify({ id: "unrelated-order" }),
  } });
  const manualRead = await readManualExecutionEvidence({ orderRequestId: order.requestId });
  assert.equal(manualRead?.identity.manualOrderId, order.id);
  assert.equal(manualRead?.currentState.cumulativeExecutedQuoteQuantity, 100);
  assert.deepEqual(manualRead?.linkedCommands.map((command) => command.identity.manualCommandId),
    [linked.id]);
});

test("accepted-then-thrown submission is persisted, discovered after reconnect, and never resubmitted", async () => {
  const account = await createAccount();
  let submits = 0;
  let queries = 0;
  let accepted: ManualOrderSnapshot | null = null;
  const adapter: ManualExchangeAdapter = {
    submit: async (intent) => {
      submits++;
      const reserved = await prisma.manualOrder.findUnique({ where: { requestId: "uncertain-request" } });
      assert.equal(reserved?.status, "submitted");
      assert.equal(reserved?.clientOrderId, intent.clientOrderId);
      accepted = snapshot("FILLED", 0.5, 50, intent.clientOrderId);
      throw new Error("connection closed after exchange acceptance");
    },
    query: async (_symbol, clientOrderId) => {
      queries++;
      assert.equal(clientOrderId, accepted?.clientOrderId);
      return accepted;
    },
    cancel: async () => { throw new Error("not used"); },
    ticker: async () => 100,
    baseTotal: async () => 0,
  };

  const uncertain = await submitManualOrder({ requestId: "uncertain-request", accountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 50 }, () => adapter);
  assert.equal(uncertain.status, "submitted");
  assert.equal(submits, 1);

  await prisma.$disconnect();
  await reconcilePendingManualOrders(() => adapter);
  const recovered = await prisma.manualOrder.findUniqueOrThrow({ where: { id: uncertain.id } });
  assert.equal(recovered.status, "filled");
  assert.equal(recovered.filledBaseQty, 0.5);
  assert.equal(await prisma.smartTrade.count({ where: { manualOrderId: uncertain.id } }), 1);
  assert.equal(submits, 1);
  assert.equal(queries, 1);

  const replay = await submitManualOrder({ requestId: "uncertain-request", accountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 50 }, () => adapter);
  assert.equal(replay.id, uncertain.id);
  assert.equal(replay.status, "filled");
  assert.equal(submits, 1);
});

test("strategy MARKET wrappers recover an accepted-then-thrown FILLED order by client id", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const accepted = new Map<string, Record<string, unknown>>();
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      calls.push(payload);
      const id = String(payload.newClientOrderId);
      const side = String(payload.side);
      accepted.set(id, { orderId: calls.length, clientOrderId: id, side, status: "FILLED",
        executedQty: "0.5", cummulativeQuoteQty: "50" });
      throw new Error("socket closed after acceptance");
    },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) =>
      accepted.get(origClientOrderId),
    myTrades: async () => [{ commission: "0.001", commissionAsset: "BTC" }],
  };
  const buy = await marketBuyQuote(client as never, "BTCUSDT", 50,
    { idempotencyScope: "strategy-buy", dryRun: false });
  const sell = await marketSellBase(client as never, "BTCUSDT", 0.5,
    { idempotencyScope: "strategy-sell", dryRun: false });
  assert.equal(buy.executedQty, 0.499);
  assert.equal(sell.executedQty, 0.5);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => typeof call.newClientOrderId === "string"));
});

test("durable webhook identity suppresses a successful replay after reconnect", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Dedupe strategy", webhookSecret: "strategy-dedupe-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true,
  } });
  let wireOrders = 0;
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      wireOrders++;
      return { orderId: wireOrders, side: "BUY", status: "FILLED", executedQty: "0.5",
        cummulativeQuoteQty: "50", clientOrderId: payload.newClientOrderId, fills: [] };
    },
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
  const body = { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "L-1700000000000" };
  const first = await processWebhook(body, { clientFactory: async () => client as never });
  await prisma.$disconnect();
  const replay = await processWebhook(body, { clientFactory: async () => client as never });
  assert.equal(first.status, "ok");
  assert.equal(replay.status, "ignored_duplicate");
  assert.equal(wireOrders, 1);
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
});

test("strategy crash A/G: a never-attempted intent survives and submits once only after halt clears", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Never attempted strategy", webhookSecret: "never-attempted-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true,
  } });
  let wireOrders = 0;
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      wireOrders++;
      return { orderId: "never-attempted-1", clientOrderId: payload.newClientOrderId,
        side: "BUY", status: "FILLED", executedQty: "0.5",
        cummulativeQuoteQty: "50", fills: [] };
    },
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
  const body = { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "crash-before-submit" };
  await assert.rejects(processWebhook(body, {
    clientFactory: async () => client as never,
    strategyCrashHooks: { afterIntentPersisted: () => { throw new Error("crash before submit"); } },
  }), /crash before submit/);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow();
  assert.equal(intent.status, "requested");
  assert.equal(wireOrders, 0);
  assert.equal(await prisma.webhookReceipt.count(), 0);

  await prisma.riskControl.create({ data: { id: "global", tradingHalted: true,
    haltedReason: "operator", haltedBy: "operator" } });
  await prisma.$disconnect();
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  assert.equal(wireOrders, 0);
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    "requested");

  await prisma.riskControl.deleteMany();
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  assert.equal(wireOrders, 1);
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    "reconciled");
});

test("the durable submission marker is written before the wire call and a crash there never resubmits", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Submission marker strategy", webhookSecret: "submission-marker-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true,
  } });
  let wireOrders = 0;
  let queries = 0;
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async () => { wireOrders++; throw new Error("must not reach wire"); },
    getOrder: async () => { queries++; throw new Error("not found"); },
  };
  await assert.rejects(processWebhook({
    secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "crash-after-marker",
  }, {
    clientFactory: async () => client as never,
    strategyCrashHooks: {
      afterSubmissionMarked: () => { throw new Error("crash after durable submission marker"); },
    },
  }), /crash after durable submission marker/);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow();
  assert.equal(intent.status, "submitted");
  assert.equal(wireOrders, 0);

  await prisma.$disconnect();
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  assert.equal(wireOrders, 0);
  assert.equal(queries, 2);
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } })).status,
    "submitted");
});

test("strategy crash B/H: accepted-then-thrown BUY is recovered while halted without resubmission", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Accepted crash strategy", webhookSecret: "accepted-crash-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true,
  } });
  const accepted = new Map<string, Record<string, unknown>>();
  let wireOrders = 0;
  let queries = 0;
  let visible = false;
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      wireOrders++;
      const id = String(payload.newClientOrderId);
      accepted.set(id, { orderId: "accepted-buy-1", clientOrderId: id, side: "BUY",
        status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "50" });
      throw new Error("socket closed after acceptance");
    },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      queries++;
      if (!visible) throw new Error("not visible before process death");
      return accepted.get(origClientOrderId);
    },
    myTrades: async () => [{ commission: "0.001", commissionAsset: "BTC" }],
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
  const body = { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "accepted-before-crash" };
  await assert.rejects(processWebhook(body, { clientFactory: async () => client as never }),
    /socket closed after acceptance/);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow();
  assert.equal(intent.status, "submitted");
  assert.equal(wireOrders, 1);
  assert.equal(await prisma.smartTrade.count(), 0);
  assert.equal(await prisma.webhookReceipt.count(), 1);

  await prisma.riskControl.create({ data: { id: "global", tradingHalted: true,
    haltedReason: "operator", haltedBy: "operator" } });
  visible = true;
  await prisma.$disconnect();
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  const recovered = await prisma.smartTrade.findUniqueOrThrow({
    where: { clientOrderId: intent.clientOrderId },
  });
  assert.equal(recovered.quantity, 0.499);
  assert.equal(wireOrders, 1);
  assert.equal(queries, 2);

  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  assert.equal(wireOrders, 1);
  assert.equal(queries, 2);
  assert.equal(await prisma.smartTrade.count({ where: { clientOrderId: intent.clientOrderId } }), 1);
  assert.equal((await processWebhook(body, { clientFactory: async () => client as never })).status,
    "ignored_duplicate");
});

test("strategy crash C/E: a normal SELL response is recovered and close accounting is applied once", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "SELL crash strategy", webhookSecret: "sell-crash-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]), exitEnabled: true,
  } });
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active",
    direction: "long", quantity: 0.5, quoteSpent: 50,
  } });
  let wireOrders = 0;
  let queries = 0;
  let acceptedId = "";
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      wireOrders++;
      acceptedId = String(payload.newClientOrderId);
      return { orderId: "accepted-sell-1", clientOrderId: acceptedId, side: "SELL",
        status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "60" };
    },
    getOrder: async () => {
      queries++;
      return { orderId: "accepted-sell-1", clientOrderId: acceptedId, side: "SELL",
        status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "60" };
    },
  };
  const body = { secret: bot.webhookSecret, action: "sell", symbol: "BTCUSDT",
    dedupe_key: "sell-response-before-crash" };
  await assert.rejects(processWebhook(body, {
    clientFactory: async () => client as never,
    strategyCrashHooks: { afterExchangeResult: () => { throw new Error("crash after response"); } },
  }), /crash after response/);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow();
  assert.equal(intent.status, "submitted");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status,
    "active");

  await prisma.$disconnect();
  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  assert.equal(closed.status, "closed");
  assert.equal(closed.pnlUsdt, 9.89);
  assert.equal(await prisma.pairCloseMark.count({ where: { botId: bot.id, pair: "BTCUSDT" } }), 1);
  assert.equal(wireOrders, 1);
  assert.equal(queries, 1);

  await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
  assert.equal(wireOrders, 1);
  assert.equal(queries, 1);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).pnlUsdt,
    closed.pnlUsdt);
});

test("strategy crash D: a persisted SmartTrade is linked without a lookup or duplicate", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Link recovery strategy", webhookSecret: "link-recovery-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]),
  } });
  const sourceKey = `${bot.id}:BTCUSDT:buy:persisted-before-link`;
  const intent = await reserveStrategyIntent({ sourceKey, bot, symbol: "BTCUSDT", side: "BUY",
    clientOrderId: clientOrderId(sourceKey), requestedQuoteQty: 50 });
  await prisma.strategyOrderIntent.update({ where: { id: intent.id }, data: {
    status: "submitted", submittedAt: new Date(),
  }});
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", direction: "long",
    quantity: 0.499, quoteSpent: 50, entryPrice: 100, currentPrice: 100,
    exchangeOrderId: "already-persisted", clientOrderId: intent.clientOrderId,
  }});
  let exchangeCalls = 0;
  const adapter: StrategyMarketAdapter = {
    submit: async () => { exchangeCalls++; throw new Error("must not submit"); },
    query: async () => { exchangeCalls++; throw new Error("must not query"); },
  };
  const linked = await reconcileStrategyIntent(intent.id, adapter);
  assert.equal(linked.intent.smartTradeId, trade.id);
  assert.equal(linked.intent.status, "reconciled");
  assert.equal(exchangeCalls, 0);
  assert.equal(await prisma.smartTrade.count({ where: { clientOrderId: intent.clientOrderId } }), 1);
});

test("strategy crash E/F: repeated partial recovery is exactly once and query misses never resubmit", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Partial recovery strategy", webhookSecret: "partial-recovery-strategy-secret",
    pairs: JSON.stringify(["BTCUSDT"]), exitEnabled: true,
  } });
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", direction: "long",
    quantity: 1, quoteSpent: 100,
  }});
  const sourceKey = `${bot.id}:BTCUSDT:sell:partial-recovery`;
  const reserved = await reserveStrategyIntent({ sourceKey, bot, symbol: "BTCUSDT", side: "SELL",
    clientOrderId: clientOrderId(sourceKey), requestedBaseQty: 0.4, sellPercent: 40,
    smartTradeId: trade.id });
  const intent = await prisma.strategyOrderIntent.update({ where: { id: reserved.id }, data: {
    status: "submitted", submittedAt: new Date(),
  }});
  let submits = 0;
  let queries = 0;
  const found: StrategyMarketAdapter = {
    submit: async () => { submits++; throw new Error("must not submit"); },
    query: async () => {
      queries++;
      return { orderId: "partial-sell-1", executedQty: 0.4,
        cummulativeQuoteQty: 44, avgPrice: 110, simulated: false };
    },
  };
  await reconcileStrategyIntent(intent.id, found);
  await reconcileStrategyIntent(intent.id, found);
  assert.equal(submits, 0);
  assert.equal(queries, 1);
  assert.equal(await prisma.partialClose.count({ where: { strategyIntentId: intent.id } }), 1);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).quantity, 0.6);

  const missingKey = `${bot.id}:ETHUSDT:buy:missing-after-attempt`;
  const missing = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: missingKey, botId: bot.id, botName: bot.name,
    clientOrderId: clientOrderId(missingKey), symbol: "ETHUSDT", side: "BUY",
    requestedQuoteQty: 25, status: "submitted", submittedAt: new Date(),
  }});
  const absent: StrategyMarketAdapter = {
    submit: async () => { submits++; throw new Error("must not submit"); },
    query: async () => { queries++; return null; },
  };
  assert.equal((await reconcileStrategyIntent(missing.id, absent)).pending, true);
  assert.equal((await reconcileStrategyIntent(missing.id, absent)).pending, true);
  assert.equal(submits, 0);
  assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: missing.id } })).status,
    "submitted");
});

test("a known webhook exchange rejection releases its receipt but the durable intent prevents resubmission", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Rejected strategy", webhookSecret: "strategy-rejection-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true,
  } });
  let wireOrders = 0;
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async () => {
      wireOrders++;
      throw Object.assign(new Error("exchange rejected order"), { code: -2010 });
    },
  };
  const body = { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "L-1700000060000" };
  await assert.rejects(processWebhook(body, { clientFactory: async () => client as never }), /rejected/);
  await assert.rejects(processWebhook(body, { clientFactory: async () => client as never }), /rejected/);
  assert.equal(wireOrders, 1);
  assert.equal(await prisma.webhookReceipt.count(), 0);
  assert.equal((await prisma.strategyOrderIntent.findFirstOrThrow()).status, "rejected");
});

test("a query miss never resubmits an already-attempted intent, while an unattempted request can submit", async () => {
  const account = await createAccount();
  const common = { exchangeAccountId: account.id, symbol: "BTCUSDT", side: "BUY",
    orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 20, limitPrice: 100 };
  const attempted = await prisma.manualOrder.create({ data: {
    ...common, requestId: "attempted", clientOrderId: "attempted-client",
    status: "submitted", submittedAt: new Date(),
  } });
  let submits = 0;
  const adapter: ManualExchangeAdapter = {
    query: async () => null,
    submit: async (intent) => { submits++; return snapshot("NEW", 0, 0, intent.clientOrderId); },
    cancel: async () => { throw new Error("not used"); }, ticker: async () => 100, baseTotal: async () => 0,
  };
  await prisma.$disconnect();
  assert.equal(await reconcileOneManualOrder(attempted, adapter), null);
  assert.equal(submits, 0);

  await prisma.manualOrder.create({ data: {
    ...common, requestId: "unattempted", clientOrderId: "unattempted-client",
  } });
  await reconcilePendingManualOrders(() => adapter);
  assert.equal(submits, 1);
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { requestId: "attempted" } })).status,
    "submitted");
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { requestId: "unattempted" } })).status,
    "open");
});

test("restart reconciliation moves stale open and partial rows to exchange terminal truth", async () => {
  const account = await createAccount();
  const common = { exchangeAccountId: account.id, symbol: "BTCUSDT", side: "BUY",
    orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
    submittedAt: new Date() };
  await prisma.manualOrder.create({ data: { ...common, requestId: "stale-open",
    clientOrderId: "stale-open-client", status: "open" } });
  await prisma.manualOrder.create({ data: { ...common, requestId: "stale-partial",
    clientOrderId: "stale-partial-client", status: "partially_filled",
    filledBaseQty: 0.25, filledQuoteQty: 25 } });
  let submits = 0;
  const adapter: ManualExchangeAdapter = {
    query: async (_symbol, clientOrderId) => clientOrderId === "stale-open-client"
      ? snapshot("FILLED", 1, 100, clientOrderId)
      : snapshot("CANCELED", 0.4, 40, clientOrderId),
    submit: async () => { submits++; throw new Error("must not resubmit"); },
    cancel: async () => { throw new Error("not used"); }, ticker: async () => 100, baseTotal: async () => 0,
  };
  await prisma.$disconnect();
  await reconcilePendingManualOrders(() => adapter);
  const open = await prisma.manualOrder.findUniqueOrThrow({ where: { requestId: "stale-open" } });
  const partial = await prisma.manualOrder.findUniqueOrThrow({ where: { requestId: "stale-partial" } });
  assert.equal(open.status, "filled");
  assert.equal(partial.status, "canceled");
  assert.equal(partial.filledBaseQty, 0.4);
  assert.equal(submits, 0);
});

test("BUY lifecycle and repeated partial reconciliation are persistent and idempotent", async () => {
  const account = await createAccount();
  let clientId = "";
  const adapter: ManualExchangeAdapter = {
    submit: async (intent) => { clientId = intent.clientOrderId; return snapshot("NEW", 0, 0, clientId); },
    query: async () => null, cancel: async () => { throw new Error("not used"); },
    ticker: async () => 100, baseTotal: async () => 0,
  };
  const order = await submitManualOrder({ requestId: "buy-lifecycle", accountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quoteQuantity: 100, limitPrice: 100 },
  () => adapter);
  assert.equal(order.status, "open");

  const partial = snapshot("PARTIALLY_FILLED", 0.4, 40, clientId);
  await applyManualSnapshot(order.id, partial);
  await applyManualSnapshot(order.id, partial);
  let persisted = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
  let trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: order.id } });
  assert.equal(persisted.status, "partially_filled");
  assert.equal(persisted.filledBaseQty, 0.4);
  assert.equal(trade.quantity, 0.4);
  assert.equal(await prisma.smartTrade.count({ where: { manualOrderId: order.id } }), 1);

  await applyManualSnapshot(order.id, snapshot("FILLED", 1, 100, clientId));
  persisted = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
  trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: order.id } });
  assert.equal(persisted.status, "filled");
  assert.equal(persisted.filledQuoteQty, 100);
  assert.ok(persisted.completedAt);
  assert.equal(trade.quantity, 1);
  assert.equal(trade.quoteSpent, 100);

  await applyManualSnapshot(order.id, snapshot("CANCELED", 0.4, 40, clientId));
  persisted = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(persisted.status, "filled");
  assert.equal(persisted.filledBaseQty, 1);
});

test("repeated SELL partial snapshots apply only their cumulative delta", async () => {
  const account = await createAccount();
  const position = await prisma.smartTrade.create({ data: {
    source: "manual", exchangeAccountId: account.id, botName: "Manual", pair: "BTCUSDT",
    status: "active", direction: "long", quantity: 1, quoteSpent: 100,
  } });
  const order = await prisma.manualOrder.create({ data: {
    requestId: "sell-lifecycle", exchangeAccountId: account.id, linkedPositionId: position.id,
    symbol: "BTCUSDT", side: "SELL", orderType: "LIMIT", quantityType: "base",
    requestedBaseQty: 1, limitPrice: 110, clientOrderId: "sell-client", status: "open",
  } });
  const partial = snapshot("PARTIALLY_FILLED", 0.4, 44, "sell-client");
  await applyManualSnapshot(order.id, partial);
  await applyManualSnapshot(order.id, partial);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } })).quantity, 0.6);

  await applyManualSnapshot(order.id, snapshot("PARTIALLY_FILLED", 0.2, 22, "sell-client"));
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } })).quantity, 0.6);
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).filledBaseQty, 0.4);

  await applyManualSnapshot(order.id, snapshot("FILLED", 1, 110, "sell-client"));
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: position.id } });
  assert.equal(closed.status, "closed");
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } })).status, "filled");
});

test("cancel-vs-fill converges to FILLED when fill wins and CANCELED when cancel wins", async () => {
  const account = await createAccount();
  const createOpen = (requestId: string, clientOrderId: string) => prisma.manualOrder.create({ data: {
    requestId, exchangeAccountId: account.id, symbol: "BTCUSDT", side: "BUY",
    orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 50, limitPrice: 100,
    clientOrderId, status: "open",
  } });
  const fillWins = await createOpen("fill-wins", "fill-wins-client");
  const fillClient = {
    cancelOrder: async () => { throw Object.assign(new Error("unknown order"), { code: -2011 }); },
    getOrder: async () => ({ orderId: 7, clientOrderId: "fill-wins-client", side: "BUY",
      status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "50" }),
    myTrades: async () => [],
  };
  const fillExchange = new BinanceManualExchange(account, { client: fillClient as never, dryRun: false });
  assert.equal((await cancelManualOrder(fillWins.id, undefined, () => fillExchange)).status, "filled");

  const cancelWins = await createOpen("cancel-wins", "cancel-wins-client");
  const cancelClient = {
    cancelOrder: async () => ({ orderId: 8, clientOrderId: "cancel-wins-client", side: "BUY",
      status: "CANCELED", executedQty: "0", cummulativeQuoteQty: "0" }),
    myTrades: async () => [],
  };
  const cancelExchange = new BinanceManualExchange(account, { client: cancelClient as never, dryRun: false });
  assert.equal((await cancelManualOrder(cancelWins.id, undefined, () => cancelExchange)).status, "canceled");
});

test("halt, Spot-only, and dry-run gates stop the real adapter submission boundary", async () => {
  const account = await createAccount();
  await prisma.riskControl.create({ data: { id: "global", tradingHalted: true,
    haltedReason: "operator", haltedBy: "operator" } });
  let submits = 0;
  const blocked: ManualExchangeAdapter = {
    submit: async () => { submits++; return snapshot("FILLED", 0.1, 10); }, query: async () => null,
    cancel: async () => { throw new Error("not used"); }, ticker: async () => 100, baseTotal: async () => 0,
  };
  await assert.rejects(submitManualOrder({ requestId: "halted", accountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 10 }, () => blocked), /halted/);
  assert.equal(submits, 0);
  assert.equal(await prisma.manualOrder.count(), 0);

  await prisma.riskControl.deleteMany();
  const nonSpot = await createAccount({ marketType: "margin", name: "Rejected non-Spot" });
  await assert.rejects(submitManualOrder({ requestId: "non-spot", accountId: nonSpot.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 10 }, () => blocked),
  /Binance Spot/);
  assert.equal(submits, 0);

  let wireOrders = 0;
  const dryClient = { prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
    order: async () => { wireOrders++; throw new Error("must not be called"); } };
  const dryExchange = new BinanceManualExchange(account, { client: dryClient as never, dryRun: true });
  const simulated = await dryExchange.submit({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET",
    quoteQuantity: 10, clientOrderId: "dry-client" });
  assert.equal(simulated.simulated, true);
  assert.equal(wireOrders, 0);
});

test("the global halt blocks both BUY and SELL at the strategy webhook submission path", async () => {
  const account = await createAccount();
  const bot = await prisma.signalBot.create({ data: {
    name: "Halted strategy", webhookSecret: "strategy-halt-secret", pairs: JSON.stringify(["BTCUSDT"]),
    exchangeAccountId: account.id, entryEnabled: true, exitEnabled: true,
  } });
  await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active", direction: "long",
    quantity: 0.5, quoteSpent: 50,
  } });
  await prisma.riskControl.create({ data: { id: "global", tradingHalted: true,
    haltedReason: "operator", haltedBy: "operator" } });

  const buy = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT" });
  const sell = await processWebhook({ secret: bot.webhookSecret, action: "sell", symbol: "BTCUSDT" });
  const replayedSell = await processWebhook({ secret: bot.webhookSecret, action: "sell", symbol: "BTCUSDT" });
  assert.equal(buy.status, "halted");
  assert.equal(sell.status, "halted");
  assert.equal(replayedSell.status, "halted");
  assert.equal(await prisma.webhookLog.count({ where: { botId: bot.id, status: "blocked" } }), 3);
  assert.equal(await prisma.webhookReceipt.count(), 0);
  assert.equal((await prisma.smartTrade.findFirstOrThrow({ where: { botId: bot.id } })).status, "active");
});
