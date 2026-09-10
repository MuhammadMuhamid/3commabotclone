import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { SPOT_ADAPTERS, fixtureContext } from "../src/services/spotExecution/adapters.js";
import { SPOT_CAPABILITIES } from "../src/services/spotExecution/capabilities.js";
import { type SpotOrderIntent, type SpotVenue } from "../src/services/spotExecution/model.js";
import { venueClientOrderId } from "../src/services/spotExecution/service.js";
import { assertSpotInstrumentRules, normalizeSpotInstrumentRules } from "../src/services/spotExecution/rules.js";
import { assertFreshSpotBalances } from "../src/services/spotExecution/balances.js";

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function intent(venue: SpotVenue): SpotOrderIntent {
  const environment = venue === "binance" || venue === "bybit" || venue === "hyperliquid"
    ? "testnet" : venue === "okx" ? "demo" : "paper";
  const orderType = venue === "hyperliquid" ? "LIMIT" : "MARKET";
  const id = `platform_intent_${venue}_1234567890`;
  return { platformIntent: { id, dedupeKey: `spot:${venue}:dedupe:1234567890`,
      createdAt: "2026-09-10T19:00:00.000Z", payloadHash: "a".repeat(64) },
    accountId: "00000000-0000-4000-8000-000000000001", venue, environment,
    canonicalInstrumentId: `instrument:v1:crypto:spot:${venue}:BTC-USD`,
    venueSymbol: venue === "binance" || venue === "bybit" ? "BTCUSDT"
      : venue === "gateio" ? "BTC_USDT" : venue === "kraken" ? "XBTUSD"
        : venue === "hyperliquid" ? "10000" : "BTC-USD",
    side: "BUY", orderType, timeInForce: orderType === "LIMIT" ? "GTC" : undefined,
    baseQuantity: orderType === "LIMIT" || !SPOT_CAPABILITIES[venue].quoteMarketBuy ? "0.01" : undefined,
    quoteQuantity: orderType === "MARKET" && SPOT_CAPABILITIES[venue].quoteMarketBuy ? "100" : undefined,
    limitPrice: orderType === "LIMIT" ? "50000" : undefined,
    clientOrderId: venueClientOrderId(venue, id), providerOrderId: "provider-1" };
}

function fixture(venue: SpotVenue): unknown {
  const common = { orderId: "provider-1", clientOrderId: intent(venue).clientOrderId,
    status: "FILLED", executedQty: "0.002", cummulativeQuoteQty: "100", transactTime: 1_788_678_000_000 };
  switch (venue) {
    case "binance": return common;
    case "coinbase": return { order: { order_id: "provider-1", client_order_id: intent(venue).clientOrderId,
      status: "FILLED", filled_size: "0.002", filled_value: "100", average_filled_price: "50000",
      total_fees: "0.4", created_time: "2026-09-10T19:00:00Z" } };
    case "bybit": return { result: { list: [{ orderId: "provider-1", orderLinkId: intent(venue).clientOrderId,
      orderStatus: "Filled", cumExecQty: "0.002", cumExecValue: "100", avgPrice: "50000" }] } };
    case "okx": return { data: [{ ordId: "provider-1", clOrdId: intent(venue).clientOrderId,
      state: "filled", accFillSz: "0.002", avgPx: "50000", fee: "-0.1", feeCcy: "USDT" }] };
    case "kraken": return { result: { "provider-1": { cl_ord_id: intent(venue).clientOrderId,
      status: "closed", vol_exec: "0.002", cost: "100", price: "50000", fee: "0.26" } } };
    case "kucoin": return { data: { id: "provider-1", clientOid: intent(venue).clientOrderId,
      isActive: false, cancelExist: false, dealSize: "0.002", dealFunds: "100", fee: "0.1", feeCurrency: "USDT" } };
    case "gateio": return { id: "provider-1", text: intent(venue).clientOrderId, status: "closed",
      finish_as: "filled", filled_amount: "0.002", avg_deal_price: "50000", fee: "0.1", fee_currency: "USDT" };
    case "robinhood": return { id: "provider-1", client_order_id: intent(venue).clientOrderId, state: "filled",
      executions: [{ quantity: "0.002", effective_price: "50000" }], created_at: "2026-09-10T19:00:00Z" };
    case "hyperliquid": return { order: { oid: "provider-1", cloid: intent(venue).clientOrderId,
      status: "filled", totalSz: "0.002", avgPx: "50000", fee: "0.02", feeToken: "USDC" } };
  }
}

test("all target venues expose explicit non-production capabilities and official contracts", () => {
  assert.deepEqual(Object.keys(SPOT_ADAPTERS).sort(), ["binance", "bybit", "coinbase", "gateio",
    "hyperliquid", "kraken", "kucoin", "okx", "robinhood"]);
  for (const [venue, adapter] of Object.entries(SPOT_ADAPTERS)) {
    assert.equal(adapter.capabilities.venue, venue);
    assert.equal(adapter.capabilities.assetClass, "crypto_spot");
    assert.equal("production" in adapter.capabilities.environments, false);
    assert.equal(adapter.capabilities.environments.includes("paper"), true);
    assert.equal(adapter.capabilities.externalHandshake, "UNVERIFIED_DISABLED");
    assert.ok(adapter.capabilities.officialDocs.length >= 2);
  }
});

test("every venue adapter validates, maps Bot-boundary authentication, and normalizes one fixture", () => {
  for (const venue of Object.keys(SPOT_ADAPTERS) as SpotVenue[]) {
    const adapter = SPOT_ADAPTERS[venue], order = intent(venue);
    const context = fixtureContext({ nonce: "fixture-nonce-123456", credentials: {
      apiKey: "fixture-key", apiSecret: Buffer.from("fixture-secret").toString("base64"),
      passphrase: "fixture-passphrase", privateKeyPem: venue === "robinhood" ? ed : ec,
      walletAddress: `0x${"1".padStart(40, "0")}`,
    } });
    adapter.validate(order);
    const submit = adapter.prepareSubmit(order, context);
    const lookup = adapter.prepareQuery(order, context);
    const cancel = adapter.prepareCancel(order, context);
    assert.equal(submit.venue, venue); assert.equal(lookup.venue, venue); assert.equal(cancel.venue, venue);
    assert.equal(submit.baseUrl.includes("api.binance.com"), false, `${venue} must not use Binance mainnet`);
    assert.equal(submit.signaturePreimage.includes("fixture-secret"), false, `${venue} leaked secret into evidence`);
    assert.ok(submit.path.length > 1); assert.ok(lookup.path.length > 1); assert.ok(cancel.path.length > 1);
    if (venue === "bybit") assert.match(submit.body ?? "", /"orderType":"Market"/);
    if (venue === "okx") assert.match(submit.body ?? "", /"ordType":"market"/);
    if (venue === "coinbase") {
      assert.match(lookup.path, /^\/api\/v3\/brokerage\/orders\/historical\/batch\?/);
      assert.deepEqual(JSON.parse(cancel.body ?? "{}"), { order_ids: ["provider-1"] });
    }
    if (venue === "robinhood") {
      assert.match(submit.body ?? "", /"market_order_config":\{"asset_quantity":"0.01"\}/);
      assert.equal(lookup.path, "/api/v1/crypto/trading/orders/");
      assert.equal(cancel.path, "/api/v1/crypto/trading/orders/provider-1/cancel/");
    }
    if (venue === "hyperliquid") {
      assert.equal(submit.headers["x-x3a-signing"], "official-sdk-eip712-required",
        "Hyperliquid must remain an explicit unsigned official-SDK placeholder");
      assert.match(submit.body ?? "", /<BOT_EIP712_SIGNATURE>/);
    }
    const normalized = adapter.normalizeOrder(fixture(venue), order, "2026-09-10T19:01:00.000Z");
    assert.equal(normalized.venue, venue); assert.equal(normalized.status, "FILLED", venue);
    assert.equal(normalized.clientOrderId, order.clientOrderId); assert.equal(normalized.filledBaseQuantity, "0.002");
  }
});

test("stale balance observations fail closed before they can size exposure", () => {
  const fresh = [{ asset: "USDT", available: "100", locked: "0",
    observedAt: "2026-09-10T19:00:00.000Z", stale: false }];
  assert.doesNotThrow(() => assertFreshSpotBalances(fresh, Date.parse("2026-09-10T19:00:10.000Z")));
  assert.throws(() => assertFreshSpotBalances(fresh, Date.parse("2026-09-10T19:00:16.000Z")), /stale/);
  assert.throws(() => assertFreshSpotBalances([{ ...fresh[0]!, stale: true }],
    Date.parse("2026-09-10T19:00:01.000Z")), /stale/);
});

test("unsupported venue semantics reject before a request can be prepared", () => {
  const hyper = intent("hyperliquid");
  assert.throws(() => SPOT_ADAPTERS.hyperliquid.prepareSubmit({ ...hyper, orderType: "MARKET",
    limitPrice: undefined, timeInForce: undefined }, fixtureContext()), /does not support MARKET/);
  const kraken = intent("kraken");
  assert.throws(() => SPOT_ADAPTERS.kraken.prepareSubmit({ ...kraken, baseQuantity: undefined,
    quoteQuantity: "100" }, fixtureContext()), /does not support quote-sized/);
  const okx = intent("okx");
  assert.throws(() => SPOT_ADAPTERS.okx.prepareSubmit({ ...okx, environment: "testnet" }, fixtureContext()),
    /does not support testnet/);
  const binance = intent("binance");
  assert.throws(() => SPOT_ADAPTERS.binance.prepareSubmit({ ...binance, orderType: "LIMIT",
    limitPrice: "50000", timeInForce: "POST_ONLY" }, fixtureContext()), /does not support POST_ONLY/);
  const coinbase = intent("coinbase");
  assert.throws(() => SPOT_ADAPTERS.coinbase.prepareCancel({ ...coinbase, providerOrderId: undefined },
    fixtureContext({ credentials: { apiKey: "fixture", apiSecret: "fixture", privateKeyPem: ec } })),
  /provider order id/);
});

test("provider mappings do not attach limit-only fields to market orders", () => {
  for (const venue of ["bybit", "kraken", "kucoin"] as const) {
    const order = intent(venue);
    const context = fixtureContext({ credentials: { apiKey: "fixture-key",
      apiSecret: Buffer.from("fixture-secret").toString("base64"), passphrase: "fixture-passphrase" } });
    const body = SPOT_ADAPTERS[venue].prepareSubmit(order, context).body ?? "";
    assert.doesNotMatch(body, /timeInForce|timeinforce|postOnly/, venue);
  }
  const gateMaker = { ...intent("gateio"), orderType: "LIMIT_MAKER" as const,
    baseQuantity: "0.01", quoteQuantity: undefined, limitPrice: "50000" };
  assert.match(SPOT_ADAPTERS.gateio.prepareSubmit(gateMaker, fixtureContext()).body ?? "",
    /"time_in_force":"poc"/);
});

test("unknown provider lifecycle values fail closed", () => {
  assert.throws(() => SPOT_ADAPTERS.binance.normalizeOrder({ ...fixture("binance"),
    status: "FUTURE_NEW_STATE" }, intent("binance"), "2026-09-10T19:01:00.000Z"), /unrecognized/);
});

test("provider precision and minimum payloads normalize without false universal fields", () => {
  const fixtures: Record<SpotVenue, unknown> = {
    binance: { symbols: [{ filters: [{ filterType: "LOT_SIZE", stepSize: "0.00001", minQty: "0.0001" },
      { filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "MIN_NOTIONAL", minNotional: "10" }] }] },
    coinbase: { base_increment: "0.00000001", quote_increment: "0.01", base_min_size: "0.0001", quote_min_size: "1" },
    bybit: { result: { list: [{ lotSizeFilter: { qtyStep: "0.000001", minOrderQty: "0.00001", minOrderAmt: "5", quotePrecision: "0.01" }, priceFilter: { tickSize: "0.01" } }] } },
    okx: { data: [{ lotSz: "0.00000001", tickSz: "0.1", minSz: "0.00001" }] },
    kraken: { result: { XXBTZUSD: { lot_decimals: 8, pair_decimals: 1, ordermin: "0.0001", costmin: "0.5" } } },
    kucoin: { data: [{ baseIncrement: "0.00000001", quoteIncrement: "0.01", priceIncrement: "0.1", baseMinSize: "0.00001", minFunds: "0.1" }] },
    gateio: [{ amount_precision: 6, precision: 2, min_base_amount: "0.0001", min_quote_amount: "1" }],
    robinhood: { results: [{ asset_increment: "0.00000001", quote_increment: "0.01", price_increment: "0.01", min_order_size: "0.0001", min_order_value: "1" }] },
    hyperliquid: { universe: [{ name: "@107", szDecimals: 5 }] },
  };
  for (const venue of Object.keys(fixtures) as SpotVenue[]) {
    const rules = normalizeSpotInstrumentRules(venue, fixtures[venue]);
    assert.ok(rules.baseIncrement); assert.ok(rules.priceIncrement);
    assertSpotInstrumentRules({ ...intent(venue), orderType: "LIMIT", timeInForce: "GTC",
      baseQuantity: venue === "hyperliquid" ? "0.001" : "0.001", quoteQuantity: undefined,
      limitPrice: venue === "okx" || venue === "kucoin" ? "50000.0" : "50000" }, rules);
  }
  const binanceRules = normalizeSpotInstrumentRules("binance", fixtures.binance);
  assert.throws(() => assertSpotInstrumentRules({ ...intent("binance"), baseQuantity: "0.000001",
    quoteQuantity: undefined }, binanceRules), /not aligned|below/);
});
