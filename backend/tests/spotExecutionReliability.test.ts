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
import { clearanceForPersistedEntry } from "../src/services/shariah.js";
import { processWebhook } from "../src/services/webhook.js";
import {
  reconcilePendingStrategyIntents, reconcileStrategyIntent, reserveStrategyIntent,
  strategyMarketAdapter, type StrategyMarketAdapter,
} from "../src/services/strategyOrderIntent.js";
import {
  readManualExecutionEvidence, readStrategyExecutionEvidence,
} from "../src/services/executionEvidence.js";
import { deliverPendingRealizations } from "../src/services/realizationEvents.js";
import { canonicalJson, normalizeRealizationEvent, platformWebhookIdentity,
  type RealizationEventV1 } from "../src/contract/realizationEventContract.js";
import { sumMoney } from "../src/lib/money.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".tmp-test.db");
const originalConfig = {
  dryRun: config.dryRun,
  manualTradingEnabled: config.manualTradingEnabled,
  mainnetManualTradingEnabled: config.mainnetManualTradingEnabled,
  realizationDeliveryEnabled: config.realizationDeliveryEnabled,
  realizationPlatformUrl: config.realizationPlatformUrl,
  realizationHmacSecret: config.realizationHmacSecret,
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
  await prisma.realizationEvent.deleteMany();
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
    // A null stored decision is a pre-Shariah intent: ungated, which is the
    // behaviour this recovery test is about.
    { idempotencyScope: "strategy-buy", dryRun: false,
      shariahClearance: clearanceForPersistedEntry(null, "BTCUSDT") });
  const sell = await marketSellBase(client as never, "BTCUSDT", 0.5,
    { idempotencyScope: "strategy-sell", dryRun: false });
  assert.equal(buy.executedQty, 0.499);
  assert.equal(sell.executedQty, 0.5);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => typeof call.newClientOrderId === "string"));
});

// ── F-AUTO-03: a crash between a real TP/SL fill and the local close write ──
// must not surface as an unrecoverable failure that leaves the trade open and
// retrying forever against an already-filled order.

test("F-AUTO-03 A: a SELL retried after the wallet is already drained recovers the earlier FILLED order by client id", async () => {
  const stableId = clientOrderId("tpsl:trade-x:tp");
  const filled = { orderId: "tpsl-1", clientOrderId: stableId, side: "SELL", status: "FILLED",
    executedQty: "1", cummulativeQuoteQty: "110" };
  let orderCalls = 0;
  const client = {
    // The wallet already reflects the earlier real fill: free balance is 0,
    // exactly what a crash-then-retry sees before the local close write ran.
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "0", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    ] }] }),
    order: async () => { orderCalls++; throw new Error("must not resubmit"); },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) =>
      origClientOrderId === stableId ? filled : undefined,
  };
  const recovered = await marketSellBase(client as never, "BTCUSDT", 1,
    { idempotencyScope: "tpsl:trade-x:tp", dryRun: false });
  assert.equal(recovered.executedQty, 1);
  assert.equal(recovered.cummulativeQuoteQty, 110);
  assert.equal(orderCalls, 0, "the already-drained balance was resolved by query, not a new order");
});

test("F-AUTO-03 B: a coded duplicate-order rejection recovers the earlier FILLED order instead of failing", async () => {
  const stableId = clientOrderId("tpsl:trade-y:sl");
  const filled = { orderId: "tpsl-2", clientOrderId: stableId, side: "SELL", status: "FILLED",
    executedQty: "1", cummulativeQuoteQty: "108" };
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "1", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    ] }] }),
    order: async () => { throw Object.assign(new Error("Duplicate order sent."), { code: -2010 }); },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) =>
      origClientOrderId === stableId ? filled : undefined,
  };
  const recovered = await marketSellBase(client as never, "BTCUSDT", 1,
    { idempotencyScope: "tpsl:trade-y:sl", dryRun: false });
  assert.equal(recovered.executedQty, 1);
  assert.equal(recovered.cummulativeQuoteQty, 108);
});

test("F-AUTO-03 C: a genuine coded rejection that is not a duplicate still fails rather than being papered over", async () => {
  const client = {
    accountInfo: async () => ({ balances: [{ asset: "BTC", free: "1", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
    ] }] }),
    order: async () => {
      throw Object.assign(new Error("Account has insufficient balance for requested action."),
        { code: -2010 });
    },
    getOrder: async () => undefined,
  };
  await assert.rejects(marketSellBase(client as never, "BTCUSDT", 1,
    { idempotencyScope: "tpsl:trade-z:tp", dryRun: false }), /insufficient balance/i);
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

/**
 * BOT-P1-3 — a never-submitted BUY expires; a never-submitted SELL does not.
 *
 * The reconciler runs every 30 seconds with no age predicate, so before this
 * repair an entry blocked at creation was placed at the then-current price
 * whenever the block cleared, however many hours later.
 */
async function requestedIntentAfterCrash(opts: {
  botName: string; secret: string; action: "buy" | "sell"; dedupeKey: string;
  client: unknown; exitEnabled?: boolean; withTrade?: boolean;
}) {
  const bot = await prisma.signalBot.create({ data: {
    name: opts.botName, webhookSecret: opts.secret, pairs: JSON.stringify(["BTCUSDT"]),
    entryEnabled: true, exitEnabled: opts.exitEnabled ?? true,
  } });
  if (opts.withTrade) {
    await prisma.smartTrade.create({ data: {
      botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active",
      direction: "long", quantity: 0.5, quoteSpent: 50,
    } });
  }
  const body: Record<string, unknown> = { secret: bot.webhookSecret, action: opts.action,
    symbol: "BTCUSDT", dedupe_key: opts.dedupeKey };
  if (opts.action === "buy") body.quote_order_qty = 50;
  await assert.rejects(processWebhook(body, {
    clientFactory: async () => opts.client as never,
    strategyCrashHooks: { afterIntentPersisted: () => { throw new Error("crash before submit"); } },
  }), /crash before submit/);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow();
  assert.equal(intent.status, "requested");
  return { bot, intent };
}

/** Move an intent back in time, exactly as a long block would leave it. */
async function ageIntent(id: string, ms: number): Promise<void> {
  await prisma.strategyOrderIntent.update({
    where: { id }, data: { createdAt: new Date(Date.now() - ms) } });
}

function fakeBuyClient(counter: { wireOrders: number }) {
  return {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      counter.wireOrders++;
      return { orderId: "aged-buy-1", clientOrderId: payload.newClientOrderId, side: "BUY",
        status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "50", fills: [] };
    },
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
}

test("BOT-P1-3: a two-hour-old never-submitted BUY is closed off as stale instead of being placed",
  async () => {
    const counter = { wireOrders: 0 };
    const client = fakeBuyClient(counter);
    const { bot, intent } = await requestedIntentAfterCrash({
      botName: "Stale entry strategy", secret: "stale-entry-strategy-secret",
      action: "buy", dedupeKey: "stale-entry", client,
    });
    await ageIntent(intent.id, 2 * 60 * 60_000);

    await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));

    assert.equal(counter.wireOrders, 0, "the original MARKET BUY was never placed");
    const settled = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    assert.equal(settled.status, "rejected");
    assert.match(String(settled.error), /Stale entry signal/);
    assert.equal(settled.exchangeStatus, "ABSENT", "it provably never crossed the wire");
    assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 0);

    // Terminal: a later sweep neither retries it nor changes the answer.
    await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));
    assert.equal(counter.wireOrders, 0);
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({
      where: { id: intent.id } })).status, "rejected");
  });

test("BOT-P1-3: the same BUY thirty seconds old still submits, so crash recovery is unaffected",
  async () => {
    const counter = { wireOrders: 0 };
    const client = fakeBuyClient(counter);
    const { bot, intent } = await requestedIntentAfterCrash({
      botName: "Fresh entry strategy", secret: "fresh-entry-strategy-secret",
      action: "buy", dedupeKey: "fresh-entry", client,
    });
    await ageIntent(intent.id, 30_000);

    await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));

    assert.equal(counter.wireOrders, 1, "an interrupted entry still completes");
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({
      where: { id: intent.id } })).status, "reconciled");
    assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
  });

test("BOT-P1-3: a never-submitted SELL of any age still reconciles — an exit never expires",
  async () => {
    let wireOrders = 0;
    const client = {
      accountInfo: async () => ({ balances: [{ asset: "BTC", free: "0.5", locked: "0" }] }),
      exchangeInfo: async () => ({ symbols: [{ filters: [
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
      ] }] }),
      order: async (payload: Record<string, unknown>) => {
        wireOrders++;
        return { orderId: "aged-sell-1", clientOrderId: payload.newClientOrderId, side: "SELL",
          status: "FILLED", executedQty: "0.5", cummulativeQuoteQty: "60" };
      },
    };
    const { intent } = await requestedIntentAfterCrash({
      botName: "Aged exit strategy", secret: "aged-exit-strategy-secret",
      action: "sell", dedupeKey: "aged-exit", client, withTrade: true,
    });
    await ageIntent(intent.id, 2 * 60 * 60_000);

    await reconcilePendingStrategyIntents(async () => strategyMarketAdapter(client as never, false));

    assert.equal(wireOrders, 1, "an interrupted exit must always be able to complete");
    assert.equal((await prisma.strategyOrderIntent.findUniqueOrThrow({
      where: { id: intent.id } })).status, "reconciled");
    assert.equal((await prisma.smartTrade.findFirstOrThrow()).status, "closed");
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

async function runRealizationLifecycle(
  legs: Array<{ qty: number; revenue: number; percent: number; leg: "tp1" | "tp2" }>,
  final: { qty: number; revenue: number; leg: "runner" | "stop" | "signal" },
  suffix: string,
  directPlatformCorrelation = true
): Promise<{ events: RealizationEventV1[]; cumulativePnl: number; tradeId: string }> {
  const bot = await prisma.signalBot.create({ data: {
    name: `Realization ${suffix}`, webhookSecret: `realization-${suffix}-${"s".repeat(32)}`,
    pairs: JSON.stringify(["BTCUSDT"]), exitEnabled: true,
  }});
  const trade = await prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair: "BTCUSDT", status: "active",
    direction: "long", quantity: 1, quoteSpent: 100,
  }});
  const deploymentId = "11111111-1111-4111-8111-111111111111";
  const webhookIdentity = platformWebhookIdentity(bot.webhookSecret);
  let ordinal = 1;
  for (const leg of legs) {
    const dedupe = `X-${suffix}-${ordinal}`;
    const sourceKey = `${bot.id}:BTCUSDT:sell:${dedupe}`;
    const reserved = await reserveStrategyIntent({ sourceKey, bot, symbol: "BTCUSDT", side: "SELL",
      clientOrderId: clientOrderId(sourceKey), requestedBaseQty: leg.qty,
      sellPercent: leg.percent, exitLeg: leg.leg, smartTradeId: trade.id,
      platformDeploymentId: directPlatformCorrelation ? deploymentId : undefined,
      platformOrderIntentId: directPlatformCorrelation ? String(ordinal) : undefined,
      platformDedupeKey: dedupe, platformWebhookIdentity: webhookIdentity });
    await prisma.strategyOrderIntent.update({ where: { id: reserved.id },
      data: { status: "submitted", submittedAt: new Date() } });
    const adapter: StrategyMarketAdapter = { submit: async () => { throw new Error("not used"); },
      query: async () => ({ orderId: `exchange-${suffix}-${ordinal}`,
        executedQty: leg.qty, cummulativeQuoteQty: leg.revenue,
        avgPrice: leg.revenue / leg.qty, simulated: false }) };
    await reconcileStrategyIntent(reserved.id, adapter);
    await reconcileStrategyIntent(reserved.id, adapter);
    ordinal++;
  }
  const dedupe = `X-${suffix}-final`;
  const sourceKey = `${bot.id}:BTCUSDT:sell:${dedupe}`;
  const finalIntent = await reserveStrategyIntent({ sourceKey, bot, symbol: "BTCUSDT", side: "SELL",
    clientOrderId: clientOrderId(sourceKey), requestedBaseQty: final.qty,
    exitLeg: final.leg, smartTradeId: trade.id,
    platformDeploymentId: directPlatformCorrelation ? deploymentId : undefined,
    platformOrderIntentId: directPlatformCorrelation ? String(ordinal) : undefined,
    platformDedupeKey: dedupe,
    platformWebhookIdentity: webhookIdentity });
  await prisma.strategyOrderIntent.update({ where: { id: finalIntent.id },
    data: { status: "submitted", submittedAt: new Date() } });
  const finalAdapter: StrategyMarketAdapter = { submit: async () => { throw new Error("not used"); },
    query: async () => ({ orderId: `exchange-${suffix}-final`, executedQty: final.qty,
      cummulativeQuoteQty: final.revenue, avgPrice: final.revenue / final.qty, simulated: false }) };
  await reconcileStrategyIntent(finalIntent.id, finalAdapter);
  await reconcileStrategyIntent(finalIntent.id, finalAdapter);
  const stored = await prisma.realizationEvent.findMany({ orderBy: [{ eventTime: "asc" }, { id: "asc" }] });
  const events = stored.map((row) => normalizeRealizationEvent(JSON.parse(row.payload)));
  const closed = await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } });
  return { events, cumulativePnl: closed.pnlUsdt, tradeId: trade.id };
}

test("realization outbox stores exactly one final event for a no-partial close", async () => {
  const result = await runRealizationLifecycle([], { qty: 1, revenue: 120, leg: "signal" }, "full");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.kind, "final");
  assert.equal(Number(result.events[0]?.realizedPnlQuote), result.cumulativePnl);
});

test("one partial plus final stores per-event economics whose sum is cumulative accounting", async () => {
  const result = await runRealizationLifecycle(
    [{ qty: 0.4, revenue: 48, percent: 40, leg: "tp1" }],
    { qty: 0.6, revenue: 78, leg: "runner" }, "one-partial");
  assert.deepEqual(result.events.map((event) => event.kind), ["partial", "final"]);
  const sum = sumMoney(result.events.map((event) => Number(event.realizedPnlQuote)));
  assert.equal(sum, result.cumulativePnl);
});

test("multiple partials plus final preserve exact deltas and repeated reconciliation emits nothing extra", async () => {
  const result = await runRealizationLifecycle([
    { qty: 0.2, revenue: 24, percent: 20, leg: "tp1" },
    { qty: 0.3, revenue: 39, percent: 37.5, leg: "tp2" },
  ], { qty: 0.5, revenue: 70, leg: "runner" }, "multi-partial");
  assert.deepEqual(result.events.map((event) => event.kind), ["partial", "partial", "final"]);
  const sum = sumMoney(result.events.map((event) => Number(event.realizedPnlQuote)));
  assert.equal(sum, result.cumulativePnl);
  assert.equal(await prisma.realizationEvent.count(), 3);
});

test("new Bot with old Platform keeps an immutable event pending for later exact correlation", async () => {
  const result = await runRealizationLifecycle(
    [], { qty: 1, revenue: 120, leg: "signal" }, "old-platform", false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.platformDeploymentId, null);
  assert.equal(result.events[0]?.platformOrderIntentId, null);
  assert.match(result.events[0]?.platformWebhookIdentity ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal((await prisma.realizationEvent.findFirstOrThrow()).deliveryStatus, "pending");
});

test("persisted payload survives restart and is retried verbatim after an ambiguous outage", async () => {
  await runRealizationLifecycle([], { qty: 1, revenue: 125, leg: "stop" }, "replay");
  const original = await prisma.realizationEvent.findFirstOrThrow();
  await prisma.smartTrade.updateMany({ data: { pnlUsdt: -999, quantity: 999, currentPrice: 1 } });
  await prisma.$disconnect();
  assert.equal((await prisma.realizationEvent.findUniqueOrThrow({ where: { id: original.id } })).payload,
    original.payload, "restart reopens the immutable stored payload");

  config.realizationDeliveryEnabled = true;
  config.realizationPlatformUrl = "http://127.0.0.1/api/internal/realization-events/v1";
  config.realizationHmacSecret = "r".repeat(40);
  const bodies: string[] = [];
  const lostResponse: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    throw new Error("response lost after durable peer commit");
  };
  assert.deepEqual(await deliverPendingRealizations(lostResponse, new Date()),
    { attempted: 1, delivered: 0 });
  const pending = await prisma.realizationEvent.findUniqueOrThrow({ where: { id: original.id } });
  assert.equal(pending.deliveryStatus, "pending");
  await prisma.realizationEvent.update({ where: { id: original.id }, data: { nextAttemptAt: new Date(0) } });
  const accepted: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ status: "accepted", acceptedEventIds: [original.id] }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await deliverPendingRealizations(accepted, new Date()),
    { attempted: 1, delivered: 1 });
  assert.equal(bodies.length, 2);
  const firstEvent = (JSON.parse(bodies[0]!) as { events: unknown[] }).events[0];
  const secondEvent = (JSON.parse(bodies[1]!) as { events: unknown[] }).events[0];
  assert.equal(canonicalJson(firstEvent), original.payload);
  assert.equal(canonicalJson(secondEvent), original.payload);
  assert.deepEqual(firstEvent, secondEvent);
});

test("delivery fails closed when immutable stored payload no longer matches its hash", async () => {
  await runRealizationLifecycle([], { qty: 1, revenue: 125, leg: "stop" }, "corrupt");
  const stored = await prisma.realizationEvent.findFirstOrThrow();
  await prisma.realizationEvent.update({ where: { id: stored.id },
    data: { payload: stored.payload.replace('"realizedPnlQuote":"', '"realizedPnlQuote":"9') } });
  config.realizationDeliveryEnabled = true;
  let calls = 0;
  const forbidden: typeof fetch = async () => { calls++; throw new Error("must not deliver"); };
  assert.deepEqual(await deliverPendingRealizations(forbidden, new Date()),
    { attempted: 1, delivered: 0 });
  assert.equal(calls, 0);
  const quarantined = await prisma.realizationEvent.findUniqueOrThrow({ where: { id: stored.id } });
  assert.equal(quarantined.deliveryStatus, "integrity_error");
});

test("snapshots, rejected orders, unfilled cancellations, and uncorrelated history emit no realization", async () => {
  const bot = await prisma.signalBot.create({ data: { name: "Non-events",
    webhookSecret: `non-events-${"s".repeat(32)}`, pairs: JSON.stringify(["BTCUSDT"]) } });
  await prisma.strategyOrderIntent.create({ data: { sourceKey: "snapshot-only", botId: bot.id,
    botName: bot.name, clientOrderId: "snapshot-only-client", symbol: "BTCUSDT", side: "SELL",
    requestedBaseQty: 1, status: "rejected", exchangeStatus: "REJECTED", filledBaseQty: 0,
    filledQuoteQty: 0, error: "rejected", reconciledAt: new Date() } });
  const account = await createAccount();
  await prisma.manualOrder.create({ data: { requestId: "canceled-unfilled",
    exchangeAccountId: account.id, symbol: "BTCUSDT", side: "SELL", orderType: "LIMIT",
    quantityType: "base", requestedBaseQty: 1, clientOrderId: "canceled-unfilled-client",
    status: "canceled", filledBaseQty: 0, filledQuoteQty: 0 } });
  await prisma.partialClose.create({ data: { trade: { create: { botId: bot.id, botName: bot.name,
    pair: "BTCUSDT", quantity: 0.5, quoteSpent: 50, status: "closed", closedAt: new Date() } },
    pct: 50, quantity: 0.5, revenue: 55, pnlUsdt: 4.945, avgPrice: 110 } });
  assert.equal(await prisma.realizationEvent.count(), 0);
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

// ── F-AUTO-02: multi-entry-capable bots require a stable dedupe_key ─────────

function buyFillClient(calls: { count: number }) {
  return {
    accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1000", locked: "0" }] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      calls.count++;
      return { orderId: calls.count, side: "BUY", status: "FILLED", executedQty: "0.5",
        cummulativeQuoteQty: "50", clientOrderId: payload.newClientOrderId, fills: [] };
    },
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
}

test("F-AUTO-02 A: a multi-entry-capable bot rejects an entry signal missing dedupe_key before any intent exists", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Multi-entry strategy", webhookSecret: "multi-entry-missing-key-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, maxEntryOrders: 2,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);
  await assert.rejects(processWebhook({
    secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT", quote_order_qty: 50,
  }, { clientFactory: async () => client as never }), /dedupe_key/);
  assert.equal(calls.count, 0, "no exchange BUY was submitted");
  assert.equal(await prisma.strategyOrderIntent.count(), 0, "no intent was reserved");
  assert.equal(await prisma.smartTrade.count(), 0);
});

test("F-AUTO-02 B: distinct dedupe_key values on a multi-entry bot open distinct entries", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Multi-entry distinct strategy", webhookSecret: "multi-entry-distinct-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, maxEntryOrders: 2,
    // per-trade unit: each entry gets its own allowance rather than sharing
    // one per-Bot ceiling, so two legitimate entries both fit.
    maxInvestmentUnit: "usdt_trade", maxInvestmentPct: 100,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);
  const first = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "entry-1" }, { clientFactory: async () => client as never });
  const second = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "entry-2" }, { clientFactory: async () => client as never });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(calls.count, 2, "each distinct entry reached the exchange once");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }), 2);
});

test("F-AUTO-02 C: an exact retry with the same dedupe_key on a multi-entry bot stays idempotent", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Multi-entry retry strategy", webhookSecret: "multi-entry-retry-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, maxEntryOrders: 2,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);
  const body = { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "same-entry" };
  const first = await processWebhook(body, { clientFactory: async () => client as never });
  const retry = await processWebhook(body, { clientFactory: async () => client as never });
  assert.equal(first.status, "ok");
  assert.equal(retry.status, "ignored_duplicate");
  assert.equal(calls.count, 1, "the retry never reached the exchange a second time");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id } }), 1);
});

test("F-AUTO-02 D: a single-entry (maxEntryOrders === 1) bot also rejects an entry signal missing dedupe_key", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Single-entry strategy", webhookSecret: "single-entry-no-key-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, maxEntryOrders: 1,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);
  await assert.rejects(processWebhook({
    secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT", quote_order_qty: 50,
  }, { clientFactory: async () => client as never }), /dedupe_key/);
  assert.equal(calls.count, 0, "no exchange BUY was submitted");
  assert.equal(await prisma.strategyOrderIntent.count(), 0, "no intent was reserved");
  assert.equal(await prisma.smartTrade.count(), 0);
});

test("F-AUTO-02 E: maxEntryOrders == null also rejects an entry signal missing dedupe_key", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Unlimited-entry strategy", webhookSecret: "unlimited-entry-no-key-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, maxEntryOrders: null,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);
  await assert.rejects(processWebhook({
    secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT", quote_order_qty: 50,
  }, { clientFactory: async () => client as never }), /dedupe_key/);
  assert.equal(calls.count, 0, "no exchange BUY was submitted");
  assert.equal(await prisma.strategyOrderIntent.count(), 0, "no intent was reserved");
  assert.equal(await prisma.smartTrade.count(), 0);
});

test("F-AUTO-02 F: a single-entry bot's close-then-re-enter in the same minute is not blocked by the old minute identity", async () => {
  const bot = await prisma.signalBot.create({ data: {
    name: "Single-entry reentry strategy", webhookSecret: "single-entry-reentry-secret",
    pairs: JSON.stringify(["BTCUSDT"]), entryEnabled: true, exitEnabled: true, maxEntryOrders: 1,
  } });
  const calls = { count: 0 };
  const client = buyFillClient(calls);

  const first = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "A" }, { clientFactory: async () => client as never });
  assert.equal(first.status, "ok");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }), 1);

  const sellClient = {
    ...client,
    order: async (payload: Record<string, unknown>) => {
      calls.count++;
      return { orderId: calls.count, side: "SELL", status: "FILLED", executedQty: "0.5",
        cummulativeQuoteQty: "51", fills: [], clientOrderId: payload.newClientOrderId };
    },
  };
  const close = await processWebhook({ secret: bot.webhookSecret, action: "sell", symbol: "BTCUSDT" },
    { clientFactory: async () => sellClient as never });
  assert.equal(close.status, "ok");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }), 0);

  // Same wall-clock minute as the first BUY, but a distinct caller-provided
  // dedupe_key — a legitimate second entry, not a retry of the first.
  const second = await processWebhook({ secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT",
    quote_order_qty: 50, dedupe_key: "B" }, { clientFactory: async () => client as never });
  assert.equal(second.status, "ok", "the re-entry gets its own StrategyOrderIntent, not the closed entry's");
  assert.equal(await prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }), 1);
  assert.equal(
    await prisma.strategyOrderIntent.count({ where: { botId: bot.id, side: "BUY" } }),
    2,
    "the re-entry reserved a distinct intent from dedupe_key B, not A's"
  );
});
