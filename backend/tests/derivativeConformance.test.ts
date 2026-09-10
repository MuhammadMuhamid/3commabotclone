import { test } from "node:test";
import assert from "node:assert/strict";
import { DERIVATIVE_ADAPTERS, derivativeFixtureContext } from "../src/services/derivativeExecution/adapters.js";
import { DERIVATIVE_CAPABILITIES } from "../src/services/derivativeExecution/capabilities.js";
import { applyFundingEvent, derivativePnl, derivativeSizing, evaluateCompletedCandleProtection,
  expiryTransition, fundingPayment } from "../src/services/derivativeExecution/math.js";
import type { DerivativeOrderIntent, DerivativeVenue } from "../src/services/derivativeExecution/model.js";
import { derivativeClientOrderId } from "../src/services/derivativeExecution/service.js";

function intent(venue: DerivativeVenue, overrides: Partial<DerivativeOrderIntent> = {}): DerivativeOrderIntent {
  const cap = DERIVATIVE_CAPABILITIES[venue];
  const environment = cap.environments.find((value) => value !== "paper") ?? "paper";
  const id = `platform_derivative_${venue}_123456789`;
  const quantityUnit = cap.quantityUnits[0]!;
  return { platformIntent: { id, dedupeKey: `x3b:${venue}:dedupe:123456789`,
      createdAt: "2026-09-10T20:00:00.000Z", payloadHash: "a".repeat(64) },
    accountId: "00000000-0000-4000-8000-000000000001", venue, environment,
    canonicalInstrumentId: `instrument:v1:crypto:perpetual:${venue}:BTC-USDT`, venueSymbol: "BTCUSDT",
    instrument: { kind: cap.contractKinds[0]!, contractSize: cap.contractKinds[0] === "LINEAR" ? "0.001" : "100",
      baseCurrency: "BTC", quoteCurrency: "USDT", settlementCurrency: "USDT", marginCurrency: "USDT" },
    positionDirection: "LONG", actionSide: "BUY", quantityUnit, quantity: quantityUnit === "BASE" ? "0.01" : "10",
    marginMode: "ISOLATED", positionMode: "ONE_WAY", reduceOnly: false, closePosition: false,
    orderType: "LIMIT", timeInForce: "GTC", limitPrice: "50000", paperReferencePrice: environment === "paper" ? "50000" : undefined,
    shariah: { mode: "off" }, clientOrderId: derivativeClientOrderId(venue, id), ...overrides };
}

function fixture(venue: DerivativeVenue, order: DerivativeOrderIntent): unknown {
  const common = { status: "FILLED", averageFillPrice: "50000",
    markPrice: "50010", indexPrice: "50005", lastPrice: "50011", liquidationPrice: "30000",
    maintenanceMargin: "12", fee: "0.25", feeCurrency: "USDT" };
  switch (venue) {
    case "binance": return { ...common, orderId: "provider-1", clientOrderId: order.clientOrderId, executedQty: "0.002", avgPrice: "50000" };
    case "bybit": return { result: { list: [{ ...common, orderId: "provider-1", orderLinkId: order.clientOrderId,
      orderStatus: "Filled", cumExecQty: "0.002", avgPrice: "50000" }] } };
    case "okx": return { data: [{ ...common, ordId: "provider-1", clOrdId: order.clientOrderId, state: "filled", accFillSz: "2", avgPx: "50000" }] };
    case "kucoin": return { data: { ...common, id: "provider-1", clientOid: order.clientOrderId, status: "filled", dealSize: "2" } };
    case "gateio": return { ...common, id: "provider-1", text: order.clientOrderId, status: "closed", fillSize: "2", avg_deal_price: "50000" };
    case "kraken": return { result: { orders: [{ ...common, order_id: "provider-1", cliOrdId: order.clientOrderId, status: "filled", fillSize: "2" }] } };
    case "hyperliquid": return { order: { ...common, oid: "provider-1", cloid: order.clientOrderId, status: "filled", filledContracts: "0.002", avgPx: "50000" } };
    case "coinbase": return { order: { ...common, order_id: "provider-1", client_order_id: order.clientOrderId,
      status: "FILLED", filled_size: "0.002", average_filled_price: "50000" } };
  }
}

test("X3B provider capability matrix is explicit and has no production environment", () => {
  assert.deepEqual(Object.keys(DERIVATIVE_ADAPTERS).sort(), ["binance", "bybit", "coinbase", "gateio",
    "hyperliquid", "kraken", "kucoin", "okx"]);
  for (const [venue, cap] of Object.entries(DERIVATIVE_CAPABILITIES)) {
    assert.equal(cap.venue, venue); assert.equal(cap.assetClass, "crypto_derivative");
    assert.equal(cap.environments.includes("paper"), true); assert.equal(cap.environments.includes("production" as never), false);
    assert.ok(cap.officialDocs.length >= 2); assert.equal(cap.protective.nativeRestingProof, "UNVERIFIED_DISABLED");
    assert.match(cap.protective.exposure, /downtime.*unprotected.*trigger-price parity is not claimed/i);
    assert.equal(typeof cap.reduceOnly, "boolean"); assert.equal(typeof cap.closePosition, "boolean");
  }
  assert.deepEqual(DERIVATIVE_CAPABILITIES.coinbase.environments, ["paper", "testnet"]);
  assert.equal(DERIVATIVE_CAPABILITIES.coinbase.externalHandshake, "UNVERIFIED_DISABLED");
});

test("all provider adapters validate, prepare safe non-production mappings, and normalize truth fields", () => {
  for (const venue of Object.keys(DERIVATIVE_ADAPTERS) as DerivativeVenue[]) {
    const order = intent(venue); const adapter = DERIVATIVE_ADAPTERS[venue];
    const context = derivativeFixtureContext(); adapter.validate(order, context.nowMs);
    const submit = adapter.prepareSubmit(order, context), query = adapter.prepareQuery(order, context), cancel = adapter.prepareCancel(order, context);
    assert.equal(submit.venue, venue); assert.match(submit.baseUrl, /testnet|demo|paper\.invalid|okx\.com|api-n5e1/);
    assert.equal(submit.baseUrl.includes("api.binance.com"), false); assert.equal(submit.signaturePreimage.includes("fixture-secret"), false);
    assert.ok(submit.body?.includes(order.clientOrderId)); assert.ok(query.path.length > 1); assert.ok(cancel.path.length > 1);
    if (venue === "okx" && order.environment === "demo") assert.equal(submit.headers["x-simulated-trading"], "1");
    if ((venue === "binance" || venue === "bybit") && order.instrument.kind === "LINEAR"
        && order.quantityUnit === "CONTRACTS") assert.match(submit.body ?? "", venue === "binance"
      ? /quantity=0\.01/ : /qty":"0\.01"/);
    if (venue === "binance") assert.ok(submit.headers["X-MBX-APIKEY"]);
    if (venue === "bybit") assert.ok(submit.headers["X-BAPI-SIGN"]);
    if (venue === "gateio") assert.ok(submit.headers.SIGN);
    if (venue === "kraken") assert.ok(submit.headers.Authent);
    if (venue === "coinbase") assert.ok(submit.headers["CB-ACCESS-SIGN"]);
    if (venue === "hyperliquid") {
      assert.equal(submit.headers["x-x3b-signing"], "official-sdk-eip712-required");
      assert.match(submit.body ?? "", /<BOT_EIP712_SIGNATURE>/);
    }
    const normalized = adapter.normalizeOrder(fixture(venue, order), order, "2026-09-10T20:01:00.000Z");
    assert.equal(normalized.status, "FILLED", venue); assert.equal(normalized.filledContracts, "2", venue);
    assert.equal(normalized.prices.mark, "50010"); assert.equal(normalized.prices.index, "50005");
    assert.equal(normalized.prices.last, "50011"); assert.equal(normalized.liquidationPrice, "30000");
    assert.equal(normalized.maintenanceMargin, "12"); assert.equal(normalized.fee?.currency, "USDT");
  }
});

test("contract/base sizing and linear/inverse long-short PnL preserve settlement truth", () => {
  const linear = { kind: "LINEAR" as const, contractSize: "0.001", baseCurrency: "BTC", quoteCurrency: "USDT",
    settlementCurrency: "USDT", marginCurrency: "USDT" };
  assert.deepEqual(derivativeSizing(linear, "CONTRACTS", "10", "50000"),
    { contracts: "10", baseQuantity: "0.01", quoteNotional: "500" });
  assert.deepEqual(derivativeSizing(linear, "BASE", "0.01", "50000"),
    { contracts: "10", baseQuantity: "0.01", quoteNotional: "500" });
  assert.equal(derivativePnl("LINEAR", "LONG", "10", "0.001", "50000", "55000"), "50");
  assert.equal(derivativePnl("LINEAR", "SHORT", "10", "0.001", "50000", "45000"), "50");
  const inverse = { ...linear, kind: "INVERSE" as const, contractSize: "100", settlementCurrency: "BTC", marginCurrency: "BTC" };
  assert.deepEqual(derivativeSizing(inverse, "CONTRACTS", "10", "50000"),
    { contracts: "10", baseQuantity: "0.02", quoteNotional: "1000" });
  assert.ok(Math.abs(Number(derivativePnl("INVERSE", "LONG", "10", "100", "50000", "55000")) - 0.0018181818) < 1e-9);
  assert.ok(Number(derivativePnl("INVERSE", "SHORT", "10", "100", "50000", "55000")) < 0);
});

test("mark/index/last protection is completed-candle only and funding boundary replay is idempotent", () => {
  const protective = { kind: "STOP_LOSS" as const, triggerPrice: "49000", triggerPriceRole: "MARK" as const,
    paperTriggerModel: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE" as const };
  const forming = evaluateCompletedCandleProtection(protective, "LONG", { complete: false,
    closeTime: "2026-09-10T20:01:00Z", mark: "48000", index: "50000", last: "50000" });
  assert.deepEqual(forming, { triggered: false, execute: null });
  const complete = evaluateCompletedCandleProtection(protective, "LONG", { complete: true,
    closeTime: "2026-09-10T20:01:00Z", mark: "48000", index: "50000", last: "50000" });
  assert.deepEqual(complete, { triggered: true, execute: "NEXT_MARKET_OBSERVATION" });
  assert.equal(fundingPayment("LONG", "LINEAR", "10", "0.001", "50000", "0.0001"), "-0.05");
  assert.equal(fundingPayment("SHORT", "LINEAR", "10", "0.001", "50000", "0.0001"), "0.05");
  const start = { balance: "0", currency: "USDT", appliedEventIds: [] as string[] };
  const once = applyFundingEvent(start, { id: "funding:BTC:1788678000", amount: "-0.05", currency: "USDT" });
  assert.deepEqual(applyFundingEvent(once, { id: "funding:BTC:1788678000", amount: "-0.05", currency: "USDT" }), once);
  assert.equal(once.balance, "-0.05");
});

test("position mode, stale position, reduce-only, close-position, and expiry constraints fail closed", () => {
  const now = Date.parse("2026-09-10T20:00:00Z");
  assert.throws(() => DERIVATIVE_ADAPTERS.hyperliquid.validate(intent("hyperliquid", { positionMode: "HEDGE" }), now), /margin\/position mode/);
  const reducing = intent("okx", { positionDirection: "LONG", actionSide: "SELL", reduceOnly: true,
    position: { direction: "LONG", contracts: "10", entryPrice: "50000", markPrice: "49000",
      observedAt: "2026-09-10T20:00:00Z", version: "position:1" } });
  assert.doesNotThrow(() => DERIVATIVE_ADAPTERS.okx.validate(reducing, now));
  assert.throws(() => DERIVATIVE_ADAPTERS.okx.validate({ ...reducing, closePosition: true, reduceOnly: false }, now),
    /cannot safely represent closePosition; no reduce-only fallback/);
  assert.throws(() => DERIVATIVE_ADAPTERS.okx.validate({ ...reducing,
    position: { ...reducing.position!, observedAt: "2026-09-10T19:59:40Z" } }, now), /stale.*not submitted/);
  assert.throws(() => DERIVATIVE_ADAPTERS.okx.validate({ ...reducing, actionSide: "BUY" }, now), /increase exposure/);
  assert.throws(() => DERIVATIVE_ADAPTERS.okx.validate({ ...reducing, quantity: "11" }, now), /exceeds/);
  assert.equal(expiryTransition(undefined, "2026-09-10T20:00:00Z", "10"), "PERPETUAL");
  assert.equal(expiryTransition("2026-09-10T20:00:00Z", "2026-09-10T20:00:01Z", "10"), "DELIVERY_PENDING");
  assert.equal(expiryTransition("2026-09-10T20:00:00Z", "2026-09-10T20:00:01Z", "0"), "DELIVERED");
});
