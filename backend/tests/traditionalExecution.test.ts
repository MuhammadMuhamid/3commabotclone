import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { prepareOandaPracticeOrder, submitIbkrPaperOrder, TRADITIONAL_PAPER_CAPABILITIES } from "../src/services/traditionalExecution/adapters.js";
import { validateTraditionalIntent, type TraditionalPaperOrderIntent } from "../src/services/traditionalExecution/model.js";
import { submitTraditionalPaperOrder } from "../src/services/traditionalExecution/service.js";

const platformIntent = { id: "x5_platform_intent_95", dedupeKey: "traditional:fixture:EURUSD:1788966000000",
  createdAt: "2026-09-09T15:00:00.000Z", payloadHash: "a".repeat(64) };
const fx: TraditionalPaperOrderIntent = { platformIntent, environment: "OANDA_PRACTICE",
  canonicalInstrumentId: "instrument:v1:OANDA:fx_pair:EUR:USD:USD:cash", providerId: "oanda-v20-fx-practice",
  providerSymbol: "EUR_USD", instrumentType: "FX_PAIR", side: "BUY", positionDirection: "LONG", quantity: "1000",
  orderType: "MARKET", priceBasis: "ASK", session: { open: true, observedAt: "2026-09-09T15:00:00.000Z",
    calendarId: "OANDA_FX_WEEK" }, clientOrderId: "x5_fixture_fx" };
const future: TraditionalPaperOrderIntent = { platformIntent: { ...platformIntent, dedupeKey: "traditional:fixture:CLX26:1788966000000" },
  environment: "IBKR_PAPER", canonicalInstrumentId: "instrument:v1:NYMEX:future:CL:USD:USD:dated-20261020",
  providerId: "ibkr-tws-futures-paper", providerSymbol: "CL|FUT|NYMEX|202611", instrumentType: "FUTURE",
  side: "SELL", positionDirection: "SHORT", quantity: "2", orderType: "LIMIT", limitPrice: "70.25",
  priceBasis: "EXCHANGE_ORDER", session: { open: true, observedAt: "2026-09-09T15:00:00.000Z", calendarId: "CME_GLOBEX" },
  contract: { root: "CL", contractCode: "CLX26", expiry: "2026-10-20", multiplier: 1000, tickSize: 0.01, tickValue: 10 },
  clientOrderId: "x5_fixture_future" };
const now = Date.parse("2026-09-09T15:00:10.000Z");

test("OANDA adapter compiles only practice host and side-aware units", () => {
  validateTraditionalIntent(fx, now);
  const prepared = prepareOandaPracticeOrder(fx, { accountId: "practice-account", token: "practice-token" }, now);
  assert.equal(prepared.baseUrl, "https://api-fxpractice.oanda.com");
  assert.equal(prepared.path, "/v3/accounts/practice-account/orders");
  assert.equal(JSON.parse(prepared.body).order.units, "1000");
  const sell = prepareOandaPracticeOrder({ ...fx, side: "SELL", positionDirection: "SHORT", priceBasis: "BID" },
    { accountId: "practice-account", token: "practice-token" }, now);
  assert.equal(JSON.parse(sell.body).order.units, "-1000");
  assert.equal(JSON.stringify(TRADITIONAL_PAPER_CAPABILITIES).includes("api-fxtrade.oanda.com"), false);
  assert.equal(TRADITIONAL_PAPER_CAPABILITIES.productionAvailable, false);
});

test("Bot rejects FX midpoint/wrong-side and stale session before provider", () => {
  assert.throws(() => validateTraditionalIntent({ ...fx, priceBasis: "BID" }, now), /buys use ask/);
  assert.throws(() => validateTraditionalIntent({ ...fx, session: { ...fx.session, observedAt: "2026-09-09T14:59:00.000Z" } }, now), /stale/);
  assert.throws(() => prepareOandaPracticeOrder(fx, { accountId: "", token: "" }, now), /credentials are unavailable/);
});

test("IBKR paper adapter validates expiry, whole contracts, multiplier, tick value and tick price", async () => {
  validateTraditionalIntent(future, now);
  assert.throws(() => validateTraditionalIntent({ ...future, quantity: "0.5" }, now), /whole contracts/);
  assert.throws(() => validateTraditionalIntent({ ...future, limitPrice: "70.251" }, now), /off tick/);
  assert.throws(() => validateTraditionalIntent({ ...future, contract: { ...future.contract!, tickValue: 9 } }, now), /inconsistent/);
  assert.throws(() => validateTraditionalIntent({ ...future, contract: { ...future.contract!, expiry: "2026-09-01" } }, now), /expired/);
  const old = config.ibkrPaperGatewayEnabled; config.ibkrPaperGatewayEnabled = false; let calls = 0;
  try {
    await assert.rejects(() => submitIbkrPaperOrder(future, { submit: async () => { calls += 1; return {}; } }, now), /UNVERIFIED_DISABLED/);
    assert.equal(calls, 0);
    config.ibkrPaperGatewayEnabled = true;
    const result = await submitIbkrPaperOrder(future, { submit: async (intent) => { calls += 1; return { id: intent.clientOrderId }; } }, now);
    assert.deepEqual(result, { id: future.clientOrderId }); assert.equal(calls, 1);
  } finally { config.ibkrPaperGatewayEnabled = old; }
});

test("service fixture proves deterministic client id without any external handshake", async () => {
  const oldAccount = config.oandaPracticeAccountId; const oldToken = config.oandaPracticeToken;
  config.oandaPracticeAccountId = "practice-account"; config.oandaPracticeToken = "fixture-token";
  let body = "";
  try {
    const { clientOrderId: _clientOrderId, ...command } = fx;
    const result = await submitTraditionalPaperOrder(command, { submitOanda: async (prepared) => {
      body = prepared.body; return { status: "PENDING" };
    } }, now);
    assert.deepEqual(result, { status: "PENDING" });
    assert.match(JSON.parse(body).order.clientExtensions.id, /^x5_[0-9a-f]{32}$/);
  } finally { config.oandaPracticeAccountId = oldAccount; config.oandaPracticeToken = oldToken; }
});
