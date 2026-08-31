import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExchangeAccount, ManualOrder } from "@prisma/client";
import { config } from "../src/config.js";
import { evaluateBotRisk, DEFAULT_BOT_RISK_LIMITS } from "../src/services/riskControls.js";
import { BinanceManualExchange, type ManualExchangeAdapter } from "../src/services/manualExchange.js";
import { MANUAL_AUTH_FRESHNESS_MS, reserveManualNonce, signManualRequest,
  verifyManualRequest } from "../src/services/manualAuth.js";
import { assertManualAccountGate, MAINNET_MANUAL_CONFIRMATION, manualLifecycleStatus,
  manualProtectionState, reconcileOneManualOrder, resolveManualProtectionLevels,
  runIdempotentManualCommand } from
  "../src/services/manualTrading.js";
import { prisma } from "../src/lib/prisma.js";

const account = (testnet = true): ExchangeAccount => ({ id: "a", name: "Primary", exchange: "binance",
  marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet,
  createdAt: new Date(), updatedAt: new Date() });

function signed(now = 1_700_000_000_000) {
  const input = { method: "POST", path: "/api/manual-trading/orders", timestamp: String(now),
    nonce: "nonce_1234567890123456", requestId: "request_123456789012", body: { side: "BUY" } };
  return { ...input, signature: signManualRequest("h".repeat(40), input), secret: "h".repeat(40), now };
}

test("manual HMAC authenticates the canonical method/path/body and rejects tampering/stale timestamps", () => {
  assert.equal(verifyManualRequest(signed()).ok, true);
  assert.equal(verifyManualRequest({ ...signed(), body: { side: "SELL" } }).ok, false);
  const stale = verifyManualRequest({ ...signed(), now: 1_700_000_000_000 + MANUAL_AUTH_FRESHNESS_MS + 1 });
  assert.deepEqual(stale, { ok: false, status: 401,
    error: "manual command timestamp is outside the freshness window" });
});

test("manual nonce reservation rejects replay durably", async () => {
  const used = new Set<string>();
  const store = { prune: async () => {}, create: async (nonce: string) => {
    if (used.has(nonce)) throw Object.assign(new Error("unique"), { code: "P2002" }); used.add(nonce); } };
  assert.equal(await reserveManualNonce("n", new Date(), store), true);
  assert.equal(await reserveManualNonce("n", new Date(), store), false);
});

test("a duplicate stable request id returns the persisted result without running twice", async () => {
  const delegate = prisma.manualCommand as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originals = { create: delegate.create, findUnique: delegate.findUnique, update: delegate.update };
  const rows = new Map<string, { requestId: string; kind: string; status: string; result: string | null;
    error: string | null; updatedAt: Date }>();
  delegate.create = async (arg: unknown) => { const data = (arg as { data: { requestId: string; kind: string } }).data;
    if (rows.has(data.requestId)) throw Object.assign(new Error("unique"), { code: "P2002" });
    rows.set(data.requestId, { ...data, status: "processing", result: null, error: null, updatedAt: new Date() }); };
  delegate.findUnique = async (arg: unknown) => rows.get((arg as { where: { requestId: string } }).where.requestId) ?? null;
  delegate.update = async (arg: unknown) => { const { where, data } = arg as { where: { requestId: string };
    data: Record<string, unknown> }; const row = rows.get(where.requestId)!; Object.assign(row, data, { updatedAt: new Date() }); return row; };
  let runs = 0;
  try {
    assert.deepEqual(await runIdempotentManualCommand("request_123456789012", "submit_order",
      async () => ({ value: ++runs })), { value: 1 });
    assert.deepEqual(await runIdempotentManualCommand("request_123456789012", "submit_order",
      async () => ({ value: ++runs })), { value: 1 });
    assert.equal(runs, 1);
  } finally { delegate.create = originals.create; delegate.findUnique = originals.findUnique;
    delegate.update = originals.update; }
});

function fakeClient() {
  const calls: Array<Record<string, unknown>> = [];
  return { calls,
    client: {
      prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
      exchangeInfo: async () => ({ symbols: [{ filters: [
        { filterType: "LOT_SIZE", stepSize: "0.01", minQty: "0.01" },
        { filterType: "PRICE_FILTER", tickSize: "0.10" },
        { filterType: "MIN_NOTIONAL", minNotional: "10" },
      ] }] }),
      accountInfo: async () => ({ balances: [{ asset: "BTC", free: "2", locked: "0" }] }),
      order: async (payload: Record<string, unknown>) => { calls.push(payload); const limit = payload.type === "LIMIT";
        return { orderId: calls.length, clientOrderId: payload.newClientOrderId, side: payload.side,
          status: limit ? "NEW" : "FILLED", executedQty: limit ? "0" : payload.side === "BUY" ? "0.5" : payload.quantity,
          cummulativeQuoteQty: limit ? "0" : "50", fills: [] }; },
      myTrades: async () => [],
      getOrder: async () => ({ orderId: 7, clientOrderId: "manual-id", side: "BUY", status: "PARTIALLY_FILLED",
        executedQty: "0.25", cummulativeQuoteQty: "25" }),
      cancelOrder: async (payload: Record<string, unknown>) => ({ orderId: 7,
        clientOrderId: payload.origClientOrderId, side: "BUY", status: "CANCELED",
        executedQty: "0", cummulativeQuoteQty: "0" }),
    },
  };
}

test("fake Binance adapter places true MARKET BUY and MARKET SELL", async () => {
  const fake = fakeClient();
  const exchange = new BinanceManualExchange(account(), { client: fake.client as never, dryRun: false });
  await exchange.submit({ symbol: "BTCUSDT", side: "BUY", orderType: "MARKET",
    quoteQuantity: 50, clientOrderId: "buy-id" });
  await exchange.submit({ symbol: "BTCUSDT", side: "SELL", orderType: "MARKET",
    baseQuantity: 0.5, clientOrderId: "sell-id" });
  assert.deepEqual(fake.calls.map((c) => [c.side, c.type]), [["BUY", "MARKET"], ["SELL", "MARKET"]]);
  assert.equal(fake.calls[0]!.quoteOrderQty, "50.00");
  assert.equal(fake.calls[1]!.quantity, "0.5");
});

test("fake Binance adapter places true LIMIT BUY/SELL with GTC filters and cancels pending limit", async () => {
  const fake = fakeClient();
  const exchange = new BinanceManualExchange(account(), { client: fake.client as never, dryRun: false });
  await exchange.submit({ symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quoteQuantity: 50,
    limitPrice: 99.99, clientOrderId: "limit-buy" });
  await exchange.submit({ symbol: "BTCUSDT", side: "SELL", orderType: "LIMIT", baseQuantity: 0.55,
    limitPrice: 101.09, clientOrderId: "limit-sell" });
  assert.deepEqual(fake.calls.map((c) => [c.side, c.type, c.timeInForce]),
    [["BUY", "LIMIT", "GTC"], ["SELL", "LIMIT", "GTC"]]);
  assert.equal(fake.calls[0]!.price, "99.9");
  assert.equal(fake.calls[1]!.price, "101.1");
  assert.equal((await exchange.cancel("BTCUSDT", "limit-buy")).status, "CANCELED");
});

test("lifecycle maps partial fills and reconciliation queries before resubmitting", async () => {
  assert.equal(manualLifecycleStatus("PARTIALLY_FILLED"), "partially_filled");
  let submits = 0;
  const snapshot = { exchangeOrderId: "1", clientOrderId: "c", status: "NEW" as const,
    executedBaseQuantity: 0, executedQuoteQuantity: 0, averagePrice: null, simulated: false };
  const adapter = { query: async () => null, submit: async () => { submits++; return snapshot; },
    cancel: async () => snapshot, ticker: async () => 1, baseTotal: async () => 1 } satisfies ManualExchangeAdapter;
  const order = { status: "requested", symbol: "BTCUSDT", clientOrderId: "c",
    side: "BUY", orderType: "LIMIT", requestedQuoteQty: 20, requestedBaseQty: null,
    limitPrice: 100 } as ManualOrder;
  assert.equal(await reconcileOneManualOrder(order, adapter), snapshot);
  assert.equal(submits, 1);
  assert.equal(await reconcileOneManualOrder({ ...order, status: "submitted" }, adapter), snapshot);
  assert.equal(submits, 2);
  assert.equal(await reconcileOneManualOrder({ ...order, status: "open" }, adapter), null);
  assert.equal(submits, 2);
});

test("attached TP/SL stays pending until a fill, then edit/remove is authoritative", () => {
  assert.equal(manualProtectionState(120, 90, 0), "pending_entry");
  assert.equal(manualProtectionState(120, 90, 0.1), "active");
  assert.deepEqual(resolveManualProtectionLevels({ tp: 120, sl: 90 }, { tp: 125 }),
    { tp: 125, sl: 90, state: "active" });
  assert.deepEqual(resolveManualProtectionLevels({ tp: 120, sl: 90 }, { tp: null, sl: null }),
    { tp: null, sl: null, state: "removed" });
});

test("manual orders cannot bypass the global halt", () => {
  for (const side of ["buy", "sell"] as const) {
    const decision = evaluateBotRisk({ ...DEFAULT_BOT_RISK_LIMITS, tradingHalted: true,
      haltedReason: "operator" }, { openExposureQuote: 0, openTrades: 0, realisedPnlInWindow: 0 },
      { side, quoteQty: 10 });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "trading_halted");
  }
});

test("mainnet requires both the server gate and explicit confirmation", () => {
  const oldManual = config.manualTradingEnabled, oldMainnet = config.mainnetManualTradingEnabled;
  try {
    config.manualTradingEnabled = true; config.mainnetManualTradingEnabled = false;
    assert.throws(() => assertManualAccountGate(account(false), MAINNET_MANUAL_CONFIRMATION), /disabled/);
    config.mainnetManualTradingEnabled = true;
    assert.throws(() => assertManualAccountGate(account(false)), /confirmation/);
    assert.doesNotThrow(() => assertManualAccountGate(account(false), MAINNET_MANUAL_CONFIRMATION));
  } finally { config.manualTradingEnabled = oldManual; config.mainnetManualTradingEnabled = oldMainnet; }
});
