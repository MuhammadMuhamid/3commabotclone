/**
 * BOT-023 — money is stored as SQLite REAL.
 *
 * The roadmap's answer is integer minor units or Decimal, and that needs a
 * migration of a live database this workspace may not touch. What is done here
 * is to stop the error COMPOUNDING: every monetary write is quantized to
 * Binance's own 8 decimal places, and every sum over rows is compensated.
 *
 * These tests pin that bound. They do NOT claim exact decimal arithmetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MONEY_DP, MONEY_FIELDS, quantize, quantizeData, sumMoney } from "../src/lib/money.js";

test("quantize rounds to Binance's 8 decimal places", () => {
  assert.equal(MONEY_DP, 8);
  assert.equal(quantize(0.1 + 0.2), 0.3);
  assert.equal(quantize(1.234567894), 1.23456789);
  assert.equal(quantize(1.234567896), 1.2345679);
  assert.equal(quantize(0), 0);
});

test("a loss is not rounded towards zero — that would invent money", () => {
  // Math.round is half-UP, so -0.000000005 would become -0 and a loss would
  // shrink. Negative values round half AWAY from zero here.
  assert.equal(quantize(-1.234567896), -1.2345679);
  assert.equal(quantize(-0.1 - 0.2), -0.3);
  assert.ok(Object.is(quantize(-1.234567894), -1.23456789));
});

test("a non-finite value passes through rather than becoming a silent zero", () => {
  assert.ok(Number.isNaN(quantize(NaN)));
  assert.equal(quantize(Infinity), Infinity);
});

test("REPEATED store/read/arithmetic cycles no longer drift", () => {
  // A trade whose P&L is recomputed and rewritten a thousand times.
  let naive = 0;
  let quantized = 0;
  for (let i = 0; i < 1000; i += 1) {
    naive = naive + 0.07 - 0.06;
    quantized = quantize(quantize(quantized) + 0.07 - 0.06);
  }
  assert.equal(quantized, 10);
  assert.notEqual(naive, 10, "the naive path is expected to drift; that is the defect");
  assert.ok(Math.abs(naive - 10) > 1e-13);
});

test("a sum over many partial closes is compensated, not accumulated", () => {
  const rows = Array.from({ length: 10_000 }, () => 0.1);
  const naive = rows.reduce((a, b) => a + b, 0);
  assert.equal(sumMoney(rows), 1000);
  assert.notEqual(naive, 1000);
});

test("sumMoney ignores a non-finite row instead of poisoning the total", () => {
  assert.equal(sumMoney([1, 2, NaN, 3]), 6);
  assert.equal(sumMoney([]), 0);
});

// ── The write path ──────────────────────────────────────────────────────────

test("every monetary field of a write is quantized, and nothing else is touched", () => {
  const out = quantizeData("SmartTrade", {
    pair: "SOLUSDT",
    status: "active",
    quantity: 1.2345678949,
    quoteSpent: 0.1 + 0.2,
    pnlUsdt: -0.1 - 0.2,
    botName: "keep me",
  }) as Record<string, unknown>;
  assert.equal(out.quantity, 1.23456789);
  assert.equal(out.quoteSpent, 0.3);
  assert.equal(out.pnlUsdt, -0.3);
  assert.equal(out.pair, "SOLUSDT");
  assert.equal(out.botName, "keep me");
});

test("Prisma's update operators are quantized too", () => {
  const out = quantizeData("SmartTrade", {
    quoteSpent: { decrement: 0.1 + 0.2 },
    pnlUsdt: { set: 1.234567896 },
  }) as Record<string, Record<string, number>>;
  assert.equal(out.quoteSpent!.decrement, 0.3);
  assert.equal(out.pnlUsdt!.set, 1.2345679);
});

test("createMany's array form is handled", () => {
  const out = quantizeData("PartialClose", [
    { revenue: 0.1 + 0.2 }, { revenue: 1.234567896 },
  ]) as Record<string, number>[];
  assert.equal(out[0]!.revenue, 0.3);
  assert.equal(out[1]!.revenue, 1.2345679);
});

test("a model with no monetary fields is left completely alone", () => {
  const data = { email: "a@b.c", passwordHash: "x" };
  assert.equal(quantizeData("User", data), data);
});

test("the registry names every Float field the schema calls money", () => {
  // If a monetary column is added to schema.prisma and not listed here, its
  // writes silently stop being quantized. This is the reminder.
  assert.deepEqual(Object.keys(MONEY_FIELDS).sort(),
    ["PartialClose", "RiskControl", "SignalBot", "SmartTrade"]);
  assert.ok(MONEY_FIELDS.SmartTrade!.includes("pnlUsdt"));
  assert.ok(MONEY_FIELDS.PartialClose!.includes("revenue"));
});
