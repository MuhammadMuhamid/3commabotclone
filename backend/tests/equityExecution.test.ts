import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ALPACA_PAPER_CAPABILITIES, alpacaPaperAdapter } from "../src/services/equityExecution/alpaca.js";
import { EquityCapabilityError, type EquityPaperOrderIntent } from "../src/services/equityExecution/model.js";
import {
  alpacaClientOrderId, submitEquityPaperOrder, type EquityPaperTransport,
} from "../src/services/equityExecution/service.js";

function intent(overrides: Partial<EquityPaperOrderIntent> = {}): EquityPaperOrderIntent {
  const now = new Date().toISOString();
  const platformId = "platform_equity_order_123456789";
  return { platformIntent: { id: platformId, dedupeKey: "x4:alpaca:order:123456789",
      createdAt: now, payloadHash: "a".repeat(64) }, environment: "paper",
    canonicalInstrumentId: "instrument:v1:NASDAQ:stock:AAPL:USD:USD:cash", providerSymbol: "AAPL",
    instrumentType: "STOCK", primaryVenue: "NASDAQ", side: "BUY", positionEffect: "OPEN_LONG",
    quantity: "2", orderType: "LIMIT", timeInForce: "DAY", limitPrice: "225.50",
    extendedHours: false, adjustmentMode: "raw",
    session: { phase: "REGULAR", observedAt: now, calendarDate: now.slice(0, 10) },
    asset: { status: "ACTIVE", tradable: true, fractionable: true, shortable: true,
      borrowStatus: "EASY_TO_BORROW", observedAt: now },
    clientOrderId: alpacaClientOrderId(platformId), ...overrides };
}

test("Alpaca is paper-only, fixed-host and explicitly UNVERIFIED", () => {
  assert.deepEqual(ALPACA_PAPER_CAPABILITIES.environments, ["paper"]);
  assert.equal(ALPACA_PAPER_CAPABILITIES.productionAvailable, false);
  assert.equal(ALPACA_PAPER_CAPABILITIES.endpoint, "https://paper-api.alpaca.markets");
  assert.equal(ALPACA_PAPER_CAPABILITIES.externalHandshake, "UNVERIFIED_DISABLED");
  assert.ok(ALPACA_PAPER_CAPABILITIES.officialDocs.length >= 4);
  const source = fs.readFileSync("src/services/equityExecution/model.ts", "utf8");
  assert.doesNotMatch(source, /environment:\s*"live"|environment:\s*"production"/);
});

test("canonical adapter prepares the official Alpaca paper order contract", () => {
  const order = intent();
  const prepared = alpacaPaperAdapter.prepareSubmit(order, { apiKey: "fixture-key", apiSecret: "fixture-secret" });
  assert.equal(prepared.baseUrl, "https://paper-api.alpaca.markets");
  assert.equal(prepared.path, "/v2/orders");
  assert.equal(prepared.headers["APCA-API-KEY-ID"], "fixture-key");
  assert.equal(prepared.body.includes("fixture-key"), false);
  assert.deepEqual(JSON.parse(prepared.body), { symbol: "AAPL", qty: "2", side: "buy", type: "limit",
    time_in_force: "day", extended_hours: false, client_order_id: order.clientOrderId, limit_price: "225.50" });
  const normalized = alpacaPaperAdapter.normalizeOrder({ id: "paper-order-1", client_order_id: order.clientOrderId,
    symbol: "AAPL", status: "filled", filled_qty: "2", filled_avg_price: "225.49",
    submitted_at: "2026-09-10T14:30:00Z", filled_at: "2026-09-10T14:30:01Z" }, order);
  assert.equal(normalized.environment, "paper"); assert.equal(normalized.status, "FILLED");
  assert.equal(normalized.averageFillPrice, "225.49");
});

test("closed, halted, stale, adjusted and unsupported extended orders reject before provider submission", async () => {
  let submits = 0;
  const transport: EquityPaperTransport = { submit: async (order) => { submits += 1;
    return alpacaPaperAdapter.normalizeOrder({ id: "should-not-run", status: "new" }, order); } };
  const command = (overrides: Partial<EquityPaperOrderIntent>) => {
    const { clientOrderId: _clientOrderId, ...value } = intent(overrides); return value;
  };
  for (const value of [
    command({ session: { ...intent().session, phase: "CLOSED" } }),
    command({ asset: { ...intent().asset, tradable: false } }),
    command({ adjustmentMode: "split" as never }),
    command({ session: { ...intent().session, phase: "PRE" }, extendedHours: true, orderType: "MARKET", limitPrice: undefined }),
  ]) await assert.rejects(() => submitEquityPaperOrder(value, transport), EquityCapabilityError);
  assert.equal(submits, 0);
});

test("shortability and borrow are fresh per-order capabilities, never assumptions", () => {
  assert.doesNotThrow(() => alpacaPaperAdapter.validate(intent({ side: "SELL", positionEffect: "OPEN_SHORT" })));
  assert.throws(() => alpacaPaperAdapter.validate(intent({ side: "SELL", positionEffect: "OPEN_SHORT",
    asset: { ...intent().asset, shortable: null, borrowStatus: "UNKNOWN" } })), /borrow_status truth is required/);
  assert.throws(() => alpacaPaperAdapter.validate(intent({ side: "SELL", positionEffect: "OPEN_SHORT",
    asset: { ...intent().asset, observedAt: "2026-01-01T00:00:00Z" } })), /asset capability observation is stale/);
});

test("extended-hours and dynamic tick/lot rules fail closed", () => {
  const pre = intent({ session: { ...intent().session, phase: "PRE" }, extendedHours: true });
  assert.doesNotThrow(() => alpacaPaperAdapter.validate(pre));
  assert.throws(() => alpacaPaperAdapter.validate({ ...pre, extendedHours: false }), /extendedHours=true/);
  assert.throws(() => alpacaPaperAdapter.validate(intent({ limitPrice: "225.501" })), /sub-penny/);
  assert.throws(() => alpacaPaperAdapter.validate(intent({ limitPrice: "0.12345" })), /sub-penny/);
  assert.throws(() => alpacaPaperAdapter.validate(intent({ quantity: "0.5",
    asset: { ...intent().asset, fractionable: false } })), /not fractionable/);
});

