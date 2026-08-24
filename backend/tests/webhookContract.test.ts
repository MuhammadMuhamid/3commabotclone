/**
 * Contract characterization for the receiving half of the cross-repository
 * webhook. Validates the exact zod schema the route uses, plus the action and
 * symbol normalisation applied to every accepted payload.
 *
 * The KNOWN MISMATCH cases record today's behaviour so a later fix is visible
 * as a deliberate change rather than an accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { webhookSchema, positionStatusSchema } from "../src/routes/webhookSchema.js";
import { resolveAction, resolveSymbol, isPlaceholderPayload, tradeEventKey } from "../src/services/webhook.js";
import { normalizeSymbol, parsePair, toBinanceSymbol } from "../src/lib/symbols.js";

const SECRET = "s".repeat(40);
const buy = (over: Record<string, unknown> = {}) => ({
  secret: SECRET, action: "buy", symbol: "APTUSDT",
  quote_order_qty: 340.01, dedupe_key: "L-1888888-1700000000000", ...over,
});
const sell = (over: Record<string, unknown> = {}) => ({
  secret: SECRET, action: "sell", symbol: "APTUSDT",
  dedupe_key: "X-1888888-1700000000000", ...over,
});

// ── Schema ─────────────────────────────────────────────────────────────────

test("the BUY payload the platform emits parses", () => {
  const r = webhookSchema.safeParse(buy());
  assert.equal(r.success, true, r.success ? "" : JSON.stringify(r.error.issues));
});

test("the full-close SELL payload the platform emits parses", () => {
  assert.equal(webhookSchema.safeParse(sell()).success, true);
});

test("every partial exit leg below 100 % parses", () => {
  for (const exit_leg of ["tp1", "tp2", "runner", "stop", "signal"]) {
    for (const sell_percent of [0.01, 1, 25, 40, 50, 66.6667, 99.99]) {
      const r = webhookSchema.safeParse(sell({ sell_percent, exit_leg }));
      assert.equal(r.success, true, `${exit_leg} @ ${sell_percent}`);
    }
  }
});

test("X-01 FIXED: sell_percent exactly 100 is accepted as a full close", () => {
  // The sender can produce exactly 100 whenever rrTp1Size + rrTp2Size >= 100.
  const rrTp1Size = 50, rrTp2Size = 50;
  const already = rrTp1Size;
  const currentPct = Math.min(100, (rrTp2Size / Math.max(0.000001, 100 - already)) * 100);
  assert.equal(currentPct, 100, "a 50/50 TP split makes the TP2 leg exactly 100");

  // It used to be a terminal 400, so the take-profit never reached the exchange
  // while the sender marked the tier done. Both the schema and the service now
  // treat it as the full close it is.
  assert.equal(webhookSchema.safeParse(sell({ sell_percent: currentPct, exit_leg: "tp2" })).success, true);
  // Above 100 is still refused.
  assert.equal(webhookSchema.safeParse(sell({ sell_percent: 100.01 })).success, false);
});

test("sell_percent must be positive and is refused on a buy action", () => {
  assert.equal(webhookSchema.safeParse(sell({ sell_percent: 0 })).success, false);
  assert.equal(webhookSchema.safeParse(sell({ sell_percent: -5 })).success, false);
  assert.equal(webhookSchema.safeParse(buy({ sell_percent: 50 })).success, false);
});

test("sell_percent and quantity are mutually exclusive", () => {
  assert.equal(webhookSchema.safeParse(sell({ sell_percent: 50, quantity: 1 })).success, false);
});

test("the schema is strict — an unexpected field is rejected outright", () => {
  const r = webhookSchema.safeParse(buy({ price: 12.34 }));
  assert.equal(r.success, false);
});

test("either symbol or tv_instrument is required, never neither", () => {
  const { symbol: _s, ...noSymbol } = buy();
  assert.equal(webhookSchema.safeParse(noSymbol).success, false);
  assert.equal(webhookSchema.safeParse({ ...noSymbol, tv_instrument: "BINANCE:APTUSDT" }).success, true);
});

test("secret length bounds are 32..256", () => {
  assert.equal(webhookSchema.safeParse(buy({ secret: "s".repeat(31) })).success, false);
  assert.equal(webhookSchema.safeParse(buy({ secret: "s".repeat(32) })).success, true);
  assert.equal(webhookSchema.safeParse(buy({ secret: "s".repeat(256) })).success, true);
  assert.equal(webhookSchema.safeParse(buy({ secret: "s".repeat(257) })).success, false);
});

test("quote_order_qty bounds: positive, finite, <= 1,000,000", () => {
  assert.equal(webhookSchema.safeParse(buy({ quote_order_qty: 0 })).success, false);
  assert.equal(webhookSchema.safeParse(buy({ quote_order_qty: 1_000_000 })).success, true);
  assert.equal(webhookSchema.safeParse(buy({ quote_order_qty: 1_000_001 })).success, false);
  assert.equal(webhookSchema.safeParse(buy({ quote_order_qty: Infinity })).success, false);
  assert.equal(webhookSchema.safeParse(buy({ quote_order_qty: null })).success, true);
});

test("the position-status request shape is bounded at 100 symbols", () => {
  const syms = (n: number) => Array.from({ length: n }, (_, i) => `SYM${i}USDT`);
  assert.equal(positionStatusSchema.safeParse({ secret: SECRET, symbols: syms(100) }).success, true);
  assert.equal(positionStatusSchema.safeParse({ secret: SECRET, symbols: syms(101) }).success, false);
  assert.equal(positionStatusSchema.safeParse({ secret: SECRET, symbols: [] }).success, false);
});

// ── Normalisation ──────────────────────────────────────────────────────────

test("action normalisation accepts every alias the strategies emit", () => {
  for (const a of ["buy", "BUY", "Enter Long", "enter_long", "long", "entry-long", "openlong"]) {
    assert.equal(resolveAction(a), "buy", a);
  }
  for (const a of ["sell", "SELL", "exit long", "close_long", "close", "exit", "closeposition", "market"]) {
    assert.equal(resolveAction(a), "sell", a);
  }
});

test("an unknown action is rejected rather than guessed", () => {
  for (const a of ["short", "enter_short", "hold", "", "cancel"]) {
    assert.throws(() => resolveAction(a), /Unknown action/, a);
  }
});

test("symbol normalisation strips exchange prefixes and separators", () => {
  assert.equal(normalizeSymbol("BINANCE:NEARUSDT"), "NEARUSDT");
  assert.equal(normalizeSymbol(" near/usdt "), "NEARUSDT");
  assert.equal(normalizeSymbol("APT-USDT"), "APTUSDT");
  assert.equal(normalizeSymbol("BTCUSDT"), "BTCUSDT");
  assert.equal(resolveSymbol({ tv_instrument: "BINANCE:APTUSDT" }), "APTUSDT");
  assert.equal(resolveSymbol({ symbol: "apt/usdt", tv_instrument: "IGNORED" }), "APTUSDT");
  assert.throws(() => resolveSymbol({}), /symbol or tv_instrument required/);
});

test("pair parsing recognises the supported quote assets, longest-quote-first", () => {
  assert.deepEqual(parsePair("APTUSDT"), { base: "APT", quote: "USDT" });
  assert.deepEqual(parsePair("ETHBTC"), { base: "ETH", quote: "BTC" });
  assert.deepEqual(parsePair("BINANCE:NEAR/USDC"), { base: "NEAR", quote: "USDC" });
  assert.throws(() => parsePair("APTXYZ"), /Unsupported pair format/);
  assert.equal(toBinanceSymbol("apt/usdt"), "APTUSDT");
});

// ── Placeholder / dedupe guards ────────────────────────────────────────────

test("unrendered TradingView placeholders are refused before any exchange call", () => {
  assert.equal(isPlaceholderPayload({ secret: SECRET, action: "{{strategy.order.action}}" }), true);
  assert.equal(isPlaceholderPayload({ secret: SECRET, action: "buy", symbol: "{{alert_message}}" }), true);
  assert.equal(isPlaceholderPayload({ secret: "REPLACE_ME", action: "buy" }), true);
  assert.equal(isPlaceholderPayload({ action: "buy" }), true, "a missing secret is a placeholder payload");
  assert.equal(isPlaceholderPayload(buy()), false);
});

test("the trade dedupe key separates bot, symbol, side and exit leg", () => {
  assert.equal(tradeEventKey("bot1", "APTUSDT", "sell", "tp1"), "trade:bot1:APTUSDT:sell:tp1");
  assert.notEqual(tradeEventKey("bot1", "APTUSDT", "sell", "tp1"), tradeEventKey("bot1", "APTUSDT", "sell", "tp2"));
  assert.notEqual(tradeEventKey("bot1", "APTUSDT", "buy"), tradeEventKey("bot1", "APTUSDT", "sell"));
  assert.notEqual(tradeEventKey("bot1", "APTUSDT", "buy"), tradeEventKey("bot2", "APTUSDT", "buy"));
});
