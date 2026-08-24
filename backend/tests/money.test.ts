/**
 * Characterization of the bot's pure money functions. These need no database,
 * no network and no mocking, and they are where an arithmetic mistake becomes
 * a real order at the wrong size.
 *
 * Cases labelled KNOWN DEFECT record today's behaviour with the finding id, so
 * the later fix shows up as an intentional change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SignalBot } from "@prisma/client";
import {
  calcOrderQuoteUsdt, formatInvestmentLabel, normalizeInvestmentUnit,
} from "../src/lib/investment.js";
import { calcFinalClosePnl, calcRealizedPnl, calcUnrealizedPnl } from "../src/services/smartTrade.js";
import { floorToStep } from "../src/services/binance.js";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

function bot(over: Partial<SignalBot> = {}): SignalBot {
  return {
    maxInvestmentPct: 100, maxInvestmentUnit: "pct_bot", entryVolumePct: 100,
    ...over,
  } as SignalBot;
}

// ── Order sizing ───────────────────────────────────────────────────────────

test("KNOWN DEFECT BOT-003: the shipped defaults spend the entire free USDT balance", () => {
  assert.equal(calcOrderQuoteUsdt(bot(), 5000), 5000);
});

test("a percentage unit takes that share of the balance, then the entry-volume share", () => {
  near(calcOrderQuoteUsdt(bot({ maxInvestmentPct: 10, entryVolumePct: 100 }), 5000), 500);
  near(calcOrderQuoteUsdt(bot({ maxInvestmentPct: 10, entryVolumePct: 50 }), 5000), 250);
});

test("a USDT unit is an absolute amount, still clamped to the balance", () => {
  const b = bot({ maxInvestmentUnit: "usdt_trade", maxInvestmentPct: 340.01 });
  near(calcOrderQuoteUsdt(b, 5000), 340.01);
  near(calcOrderQuoteUsdt(b, 100), 100, 1e-9);
});

test("a webhook may request less than the ceiling but never more", () => {
  const b = bot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 500 });
  near(calcOrderQuoteUsdt(b, 5000, 100), 100);
  near(calcOrderQuoteUsdt(b, 5000, 100_000), 500, 1e-9);
});

test("the result is never negative", () => {
  assert.equal(calcOrderQuoteUsdt(bot({ maxInvestmentPct: -50 }), 5000), 0);
  assert.equal(calcOrderQuoteUsdt(bot(), 0), 0);
  assert.equal(calcOrderQuoteUsdt(bot(), 5000, -1), 0);
});

test("KNOWN DEFECT BOT-013: '*_bot' and '*_trade' units size identically", () => {
  const perBot = bot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 100 });
  const perTrade = bot({ maxInvestmentUnit: "usdt_trade", maxInvestmentPct: 100 });
  assert.equal(calcOrderQuoteUsdt(perBot, 5000), calcOrderQuoteUsdt(perTrade, 5000));
  // Three concurrent positions therefore deploy 300 USDT under a "100 per Bot" setting.
});

test("legacy investment-unit labels still resolve, and unknown ones fall back to pct_bot", () => {
  assert.equal(normalizeInvestmentUnit("% USDT per Bot"), "pct_bot");
  assert.equal(normalizeInvestmentUnit("USDT per SmartTrade"), "usdt_trade");
  assert.equal(normalizeInvestmentUnit("nonsense"), "pct_bot");
  assert.equal(formatInvestmentLabel(340.01, "usdt_bot"), "340.01 USDT");
  assert.equal(formatInvestmentLabel(10, "pct_trade"), "10%");
});

// ── Lot-size rounding ──────────────────────────────────────────────────────

test("floorToStep rounds DOWN to the exchange lot step", () => {
  near(floorToStep(1.23456789, 0.001), 1.234);
  near(floorToStep(1.9999, 1), 1);
  near(floorToStep(100, 0.1), 100);
  assert.equal(floorToStep(5.5, 0), 5.5, "a zero step means no lot filter");
});

test("floorToStep never returns more than it was given", () => {
  for (const step of [1, 0.1, 0.01, 0.001, 0.00001, 0.00000001]) {
    for (const q of [0.1, 1.005, 7.7777777, 12345.6789]) {
      assert.ok(floorToStep(q, step) <= q + 1e-12, `${q} @ ${step}`);
    }
  }
});

// ── P&L ────────────────────────────────────────────────────────────────────

test("realized P&L charges 0.1 % on both sides", () => {
  const { pnlUsdt, pnlPct } = calcRealizedPnl(1000, 1000);
  near(pnlUsdt, 1000 * 0.999 - 1000 * 1.001);
  assert.ok(pnlUsdt < 0, "a flat round trip loses the round-trip commission");
  near(pnlPct, (pnlUsdt / (1000 * 1.001)) * 100);
});

test("a genuine winner survives the fees", () => {
  const { pnlUsdt } = calcRealizedPnl(1050, 1000);
  assert.ok(pnlUsdt > 0);
  near(pnlUsdt, 1050 * 0.999 - 1000 * 1.001);
});

test("unrealized P&L uses the same fee model as realized", () => {
  const qty = 10, price = 105, spent = 1000;
  const unreal = calcUnrealizedPnl(qty, price, spent);
  const real = calcRealizedPnl(qty * price, spent);
  near(unreal.pnlUsdt, real.pnlUsdt);
  near(unreal.pnlPct, real.pnlPct);
});

test("zero cost yields a zero percentage rather than a division by zero", () => {
  assert.equal(calcRealizedPnl(100, 0).pnlPct, 0);
  assert.equal(calcUnrealizedPnl(0, 100, 0).pnlPct, 0);
});

test("a final close accumulates every prior partial close", () => {
  const partial = calcRealizedPnl(600, 500);
  const final = calcFinalClosePnl(500, 500, [{ pnlUsdt: partial.pnlUsdt, revenue: 600 }]);
  const finalLeg = calcRealizedPnl(500, 500);
  near(final.pnlUsdt, finalLeg.pnlUsdt + partial.pnlUsdt);
});

test("a final close with no partials equals a plain realized close", () => {
  const a = calcFinalClosePnl(1050, 1000, []);
  const b = calcRealizedPnl(1050, 1000);
  near(a.pnlUsdt, b.pnlUsdt);
  near(a.pnlPct, b.pnlPct);
});

test("the accumulated percentage is taken over the reconstructed original cost", () => {
  // Enter 1000 USDT, sell half for 600, then close the rest for 700.
  const partial = calcRealizedPnl(600, 500);
  const final = calcFinalClosePnl(700, 500, [{ pnlUsdt: partial.pnlUsdt, revenue: 600 }]);
  const totalCost = 500 * 1.001 + (600 * 0.999 - partial.pnlUsdt);
  near(final.pnlPct, (final.pnlUsdt / totalCost) * 100, 1e-9);
  near(totalCost, 1000 * 1.001, 1e-9);
});
