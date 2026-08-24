/**
 * Phase 2 money-path fixes, at the pure layer.
 *
 * Every case here is one of the audit's findings, and each asserts the CORRECTED
 * behaviour with the old behaviour spelled out so the difference is visible.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SignalBot } from "@prisma/client";
import {
  clientOrderId, floorQuote, floorToStep, netBaseQty,
} from "../src/services/binance.js";
import { calcOrderQuoteUsdt, isPerBotUnit } from "../src/lib/investment.js";
import {
  acquireTradeClose, heldLockCount, isTradeClosing, releaseTradeClose, withTradeCloseLock,
} from "../src/lib/tradeCloseLock.js";
import {
  DEFAULT_BOT_RISK_LIMITS, describeBotRiskState, evaluateBotRisk, shouldLatchHalt,
  type BotRiskLimits, type BotRiskSnapshot,
} from "../src/services/riskControls.js";
import {
  DEFAULT_LIMIT_OFFSET_FRACTION, exchangeStopsEnabled, planProtectiveOrder,
  ProtectiveOrderRejected, type SymbolPrecision,
} from "../src/services/exchangeStops.js";
import { idempotencyScope } from "../src/services/webhook.js";
import { assertSafeBotConfig, UNPROTECTED_SIZE_LIMIT_PCT } from "../src/routes/bots.js";

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

// ── BOT-014: the quote is floored, never rounded up ─────────────────────────

test("BOT-014: a quote amount is floored to two decimals, never rounded up", () => {
  // `1234.56789.toFixed(2)` is "1234.57" — above the balance the amount was
  // already clamped to, so Binance answered -2010 Insufficient balance.
  assert.equal((1234.56789).toFixed(2), "1234.57", "the old behaviour, for contrast");
  near(floorQuote(1234.56789), 1234.56);
  near(floorQuote(100), 100);
  near(floorQuote(0.999), 0.99);
  assert.equal(floorQuote(0.001), 0);
});

test("flooring never returns more than it was given, across the range", () => {
  for (const q of [0.01, 0.999, 1.005, 12.345, 999.999, 1234.56789, 1_000_000.005]) {
    assert.ok(floorQuote(q) <= q, String(q));
  }
  for (const bad of [0, -1, NaN, Infinity]) assert.equal(floorQuote(bad), 0, String(bad));
});

// ── BOT-006: the recorded quantity is net of base-asset commission ──────────

test("BOT-006: base-asset commission is netted out of the recorded quantity", () => {
  // Binance charges spot BUY commission in the BASE asset, so the wallet
  // received less than executedQty. Storing the gross figure made a later
  // "full close" ask for more than the position held.
  const fills = [
    { commission: "0.001", commissionAsset: "APT" },
    { commission: "0.002", commissionAsset: "APT" },
  ];
  near(netBaseQty(10, fills, "APT"), 9.997);
});

test("a fee paid in another asset does not reduce the base received", () => {
  const fills = [{ commission: "0.05", commissionAsset: "BNB" }];
  near(netBaseQty(10, fills, "APT"), 10);
  // Case-insensitive on the asset name.
  near(netBaseQty(10, [{ commission: "0.5", commissionAsset: "apt" }], "APT"), 9.5);
});

test("absent, empty or malformed fills leave the quantity untouched", () => {
  near(netBaseQty(10, undefined, "APT"), 10);
  near(netBaseQty(10, [], "APT"), 10);
  near(netBaseQty(10, [{ commissionAsset: "APT" }], "APT"), 10);
  near(netBaseQty(10, [{ commission: "not-a-number", commissionAsset: "APT" }], "APT"), 10);
});

test("commission can never drive the quantity negative", () => {
  assert.equal(netBaseQty(1, [{ commission: "5", commissionAsset: "APT" }], "APT"), 0);
});

// ── BOT-032: lot-step flooring without float dust ──────────────────────────

test("BOT-032: flooring to a lot step does not leave float dust", () => {
  // The old form was `parseFloat((Math.floor(qty/step)*step).toFixed(decimals))`.
  // `Math.floor(0.29 / 0.01) * 0.01` is 0.28000000000000003.
  near(floorToStep(0.29, 0.01), 0.29);
  near(floorToStep(1.23456789, 0.001), 1.234);
  near(floorToStep(2.9999999999999996, 0.1), 3);
  near(floorToStep(100, 0.1), 100);
});

test("flooring to a step never exceeds the input, across steps and magnitudes", () => {
  for (const step of [1, 0.1, 0.01, 0.001, 0.00001, 0.00000001]) {
    for (const q of [0.1, 0.29, 1.005, 2.9999999999999996, 7.7777777, 12345.6789]) {
      const out = floorToStep(q, step);
      assert.ok(out <= q + 1e-12, `${q} @ ${step} -> ${out}`);
      assert.ok(out >= 0, `${q} @ ${step} -> ${out}`);
    }
  }
});

test("a zero or absent step means no lot filter, and a bad quantity is zero", () => {
  assert.equal(floorToStep(5.5, 0), 5.5);
  assert.equal(floorToStep(0, 0.1), 0);
  assert.equal(floorToStep(-1, 0.1), 0);
  assert.equal(floorToStep(NaN, 0.1), 0);
});

// ── BOT-007: deterministic client order ids ────────────────────────────────

test("BOT-007: the client order id is deterministic per logical order", () => {
  const a = clientOrderId("bot1:APTUSDT:buy:L-1700000000000");
  const b = clientOrderId("bot1:APTUSDT:buy:L-1700000000000");
  assert.equal(a, b, "a retry of the same logical order reuses the id");
  assert.notEqual(a, clientOrderId("bot1:APTUSDT:buy:L-1700000900000"));
  assert.notEqual(a, clientOrderId("bot1:APTUSDT:sell:L-1700000000000"));
});

test("the client order id fits Binance's 36-character alphanumeric limit", () => {
  for (const scope of ["", "x", "a".repeat(500), "bot1:APTUSDT:buy:L-1700000000000"]) {
    const id = clientOrderId(scope);
    assert.ok(id.length <= 36, `${id.length} chars`);
    assert.match(id, /^[A-Za-z0-9_-]+$/, id);
  }
});

test("the idempotency scope uses the dedupe key when there is one", () => {
  assert.equal(
    idempotencyScope("bot1", "APTUSDT", "buy", "L-1700000000000"),
    "bot1:APTUSDT:buy:L-1700000000000"
  );
  // Without one, a per-minute bucket still collapses an immediate retry.
  const t = 1_700_000_030_000;
  assert.equal(
    idempotencyScope("bot1", "APTUSDT", "buy", undefined, t),
    idempotencyScope("bot1", "APTUSDT", "buy", undefined, t + 5_000)
  );
  assert.notEqual(
    idempotencyScope("bot1", "APTUSDT", "buy", undefined, t),
    idempotencyScope("bot1", "APTUSDT", "buy", undefined, t + 60_000)
  );
});

// ── BOT-013: per-Bot units aggregate ───────────────────────────────────────

function bot(over: Partial<SignalBot> = {}): SignalBot {
  return {
    maxInvestmentPct: 100, maxInvestmentUnit: "pct_bot", entryVolumePct: 100, ...over,
  } as SignalBot;
}

test("BOT-013: a per-Bot allowance is reduced by what is already committed", () => {
  const perBot = bot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 100 });
  near(calcOrderQuoteUsdt(perBot, 5000, null, 0), 100);
  near(calcOrderQuoteUsdt(perBot, 5000, null, 60), 40);
  assert.equal(calcOrderQuoteUsdt(perBot, 5000, null, 100), 0, "fully committed");
  assert.equal(calcOrderQuoteUsdt(perBot, 5000, null, 250), 0, "over-committed is still zero");
});

test("a per-SmartTrade allowance is NOT reduced — that is the distinction", () => {
  const perTrade = bot({ maxInvestmentUnit: "usdt_trade", maxInvestmentPct: 100 });
  near(calcOrderQuoteUsdt(perTrade, 5000, null, 0), 100);
  near(calcOrderQuoteUsdt(perTrade, 5000, null, 300), 100);
});

test("the exact case from the finding: 100 USDT per Bot with three positions", () => {
  const perBot = bot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 100 });
  let committed = 0;
  const sizes: number[] = [];
  for (let i = 0; i < 4; i++) {
    const q = calcOrderQuoteUsdt(perBot, 5000, null, committed);
    sizes.push(q);
    committed += q;
  }
  near(committed, 100, 1e-9);
  assert.deepEqual(sizes, [100, 0, 0, 0], "the total deployed is 100, not 400");
});

test("percentage per-Bot units aggregate the same way", () => {
  const b = bot({ maxInvestmentUnit: "pct_bot", maxInvestmentPct: 10 });
  near(calcOrderQuoteUsdt(b, 5000, null, 0), 500);
  near(calcOrderQuoteUsdt(b, 5000, null, 200), 300);
  assert.equal(isPerBotUnit("pct_bot"), true);
  assert.equal(isPerBotUnit("usdt_bot"), true);
  assert.equal(isPerBotUnit("pct_trade"), false);
  assert.equal(isPerBotUnit("usdt_trade"), false);
});

test("omitting the committed amount preserves the previous behaviour exactly", () => {
  const b = bot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 340.01 });
  near(calcOrderQuoteUsdt(b, 5000), 340.01);
});

// ── BOT-005: the close lock is taken, not merely observed ──────────────────

test("BOT-005: only one holder at a time, and the loser is told", () => {
  const id = "trade-1";
  assert.equal(acquireTradeClose(id), true);
  assert.equal(isTradeClosing(id), true);
  assert.equal(acquireTradeClose(id), false, "the second caller must be refused, not proceed");
  releaseTradeClose(id);
  assert.equal(isTradeClosing(id), false);
  assert.equal(acquireTradeClose(id), true);
  releaseTradeClose(id);
});

test("the lock is released even when the guarded work throws", async () => {
  const id = "trade-2";
  await assert.rejects(
    withTradeCloseLock(id, async () => { throw new Error("sell failed"); }),
    /sell failed/
  );
  assert.equal(isTradeClosing(id), false, "a leaked lock makes a trade uncloseable forever");
  assert.equal(heldLockCount(), 0);
});

test("a contended close reports that it did not run, rather than silently doing nothing", async () => {
  const id = "trade-3";
  assert.equal(acquireTradeClose(id), true);
  const result = await withTradeCloseLock(id, async () => "sold");
  assert.deepEqual(result, { ran: false });
  releaseTradeClose(id);
  const second = await withTradeCloseLock(id, async () => "sold");
  assert.deepEqual(second, { ran: true, value: "sold" });
});

test("different trades do not block each other", () => {
  assert.equal(acquireTradeClose("a"), true);
  assert.equal(acquireTradeClose("b"), true);
  releaseTradeClose("a");
  releaseTradeClose("b");
  assert.equal(heldLockCount(), 0);
});

// ── BOT-011: account-level risk controls ───────────────────────────────────

const limits = (o: Partial<BotRiskLimits> = {}): BotRiskLimits => ({ ...DEFAULT_BOT_RISK_LIMITS, ...o });
const snap = (o: Partial<BotRiskSnapshot> = {}): BotRiskSnapshot =>
  ({ openExposureQuote: 0, openTrades: 0, realisedPnlInWindow: 0, ...o });

test("BOT-011: with every limit unset nothing is refused — the controls are opt-in", () => {
  const hostile = snap({ openExposureQuote: 1e6, openTrades: 500, realisedPnlInWindow: -1e6 });
  assert.deepEqual(evaluateBotRisk(limits(), hostile, { side: "buy", quoteQty: 800 }), { allowed: true });
  assert.deepEqual(evaluateBotRisk(limits(), hostile, { side: "sell", quoteQty: 0 }), { allowed: true });
});

test("a numeric limit never blocks an exit", () => {
  const tight = limits({ maxTotalExposureQuote: 1, maxConcurrentTrades: 0, maxDailyLossQuote: 1 });
  const bad = snap({ openExposureQuote: 9999, openTrades: 99, realisedPnlInWindow: -5000 });
  assert.deepEqual(evaluateBotRisk(tight, bad, { side: "sell", quoteQty: 0 }), { allowed: true });
  assert.equal(evaluateBotRisk(tight, bad, { side: "buy", quoteQty: 1 }).allowed, false);
});

test("the kill switch stops entries AND exits", () => {
  const halted = limits({ tradingHalted: true, haltedReason: "operator stop", haltedBy: "operator" });
  for (const side of ["buy", "sell"] as const) {
    const d = evaluateBotRisk(halted, snap(), { side, quoteQty: 100 });
    assert.equal(d.allowed, false, side);
    assert.equal(d.allowed ? "" : d.code, "trading_halted");
  }
});

test("exposure is judged after the proposed order", () => {
  const l = limits({ maxTotalExposureQuote: 1000 });
  assert.equal(evaluateBotRisk(l, snap({ openExposureQuote: 700 }), { side: "buy", quoteQty: 340 }).allowed, false);
  assert.equal(evaluateBotRisk(l, snap({ openExposureQuote: 600 }), { side: "buy", quoteQty: 340 }).allowed, true);
  assert.equal(evaluateBotRisk(l, snap(), { side: "buy", quoteQty: 1000 }).allowed, true);
  assert.equal(evaluateBotRisk(l, snap(), { side: "buy", quoteQty: 1000.01 }).allowed, false);
});

test("only a daily-loss breach latches the switch", () => {
  const l = limits({ maxDailyLossQuote: 500 });
  const breach = evaluateBotRisk(l, snap({ realisedPnlInWindow: -600 }), { side: "buy", quoteQty: 1 });
  assert.equal(shouldLatchHalt(breach), "daily_loss");
  const conc = evaluateBotRisk(limits({ maxConcurrentTrades: 0 }), snap(), { side: "buy", quoteQty: 1 });
  assert.equal(shouldLatchHalt(conc), null);
  assert.equal(shouldLatchHalt({ allowed: true }), null);
});

test("a profit, however large, is not a loss", () => {
  const l = limits({ maxDailyLossQuote: 500 });
  assert.equal(evaluateBotRisk(l, snap({ realisedPnlInWindow: 1e6 }), { side: "buy", quoteQty: 1 }).allowed, true);
});

test("the operator summary distinguishes HALTED from ACTIVE and shows each limit", () => {
  assert.match(
    describeBotRiskState(limits({ tradingHalted: true, haltedBy: "daily_loss", haltedReason: "x" }), snap()),
    /^HALTED \(daily_loss\): x$/
  );
  const active = describeBotRiskState(
    limits({ maxTotalExposureQuote: 5000, maxConcurrentTrades: 4, maxDailyLossQuote: 250 }),
    snap({ openExposureQuote: 1140.01, openTrades: 3, realisedPnlInWindow: -80 })
  );
  assert.match(active, /^ACTIVE — exposure 1140\.01\/5000\.00, trades 3\/4, 24h loss 80\.00\/250\.00$/);
});

// ── BOT-003 / BOT-015: the configuration guard ─────────────────────────────

test("BOT-003: a large percentage position with no stop loss is refused", () => {
  const err = assertSafeBotConfig({
    maxInvestmentPct: 100, maxInvestmentUnit: "pct_bot", entryVolumePct: 100,
    stopLossEnabled: false, takeProfitEnabled: false,
  });
  assert.ok(err, "the shipped default configuration must not be reconstructible");
  assert.match(err, new RegExp(`${UNPROTECTED_SIZE_LIMIT_PCT}%`));
});

test("the same size WITH a stop loss is accepted", () => {
  assert.equal(
    assertSafeBotConfig({
      maxInvestmentPct: 100, maxInvestmentUnit: "pct_bot", entryVolumePct: 100,
      stopLossEnabled: true, stopLossPct: 3, takeProfitEnabled: false,
    }),
    null
  );
});

test("the threshold is the EFFECTIVE size, so entryVolumePct counts", () => {
  const base = {
    maxInvestmentPct: 100, maxInvestmentUnit: "pct_bot",
    stopLossEnabled: false, takeProfitEnabled: false,
  };
  // 100 % x 40 % = 40 %, under the threshold.
  assert.equal(assertSafeBotConfig({ ...base, entryVolumePct: 40 }), null);
  // 100 % x 60 % = 60 %, over it.
  assert.ok(assertSafeBotConfig({ ...base, entryVolumePct: 60 }));
});

test("absolute USDT units are not judged against a percentage threshold", () => {
  assert.equal(
    assertSafeBotConfig({
      maxInvestmentPct: 100_000, maxInvestmentUnit: "usdt_bot", entryVolumePct: 100,
      stopLossEnabled: false, takeProfitEnabled: false,
    }),
    null,
    "a USDT amount cannot be compared to a share of the balance here"
  );
});

test("an enabled stop or target with no distance is refused", () => {
  const base = {
    maxInvestmentPct: 5, maxInvestmentUnit: "pct_bot", entryVolumePct: 100,
    stopLossEnabled: true, takeProfitEnabled: false,
  };
  assert.match(assertSafeBotConfig({ ...base, stopLossPct: 0 }) ?? "", /stopLossPct/);
  assert.match(assertSafeBotConfig({ ...base, stopLossPct: null }) ?? "", /stopLossPct/);
  assert.equal(assertSafeBotConfig({ ...base, stopLossPct: 3 }), null);
  assert.match(
    assertSafeBotConfig({ ...base, stopLossPct: 3, takeProfitEnabled: true, takeProfitPct: 0 }) ?? "",
    /takeProfitPct/
  );
});

// ── BOT-017: exchange-native stops, disabled by default ───────────────────

const precision: SymbolPrecision = {
  stepSize: 0.01, tickSize: 0.001, minQty: 0.01, minNotional: 10,
};

test("BOT-017: exchange-native protective orders are OFF unless explicitly enabled", () => {
  const before = process.env.EXCHANGE_STOPS_ENABLED;
  try {
    delete process.env.EXCHANGE_STOPS_ENABLED;
    assert.equal(exchangeStopsEnabled(), false, "unset must not arm order placement");
    for (const raw of ["1", "yes", "TRUE", "on", ""]) {
      process.env.EXCHANGE_STOPS_ENABLED = raw;
      assert.equal(exchangeStopsEnabled(), false, raw);
    }
    process.env.EXCHANGE_STOPS_ENABLED = "true";
    assert.equal(exchangeStopsEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.EXCHANGE_STOPS_ENABLED;
    else process.env.EXCHANGE_STOPS_ENABLED = before;
  }
});

test("the plan rounds quantity and prices DOWN, and places the limit below the trigger", () => {
  const plan = planProtectiveOrder({
    symbol: "aptusdt", quantity: 8.0567, stopPrice: 9.87654,
    precision, clientOrderId: "bot-test",
  });
  assert.equal(plan.symbol, "APTUSDT");
  assert.equal(plan.side, "SELL");
  assert.equal(plan.type, "STOP_LOSS_LIMIT");
  assert.equal(plan.timeInForce, "GTC");
  near(plan.quantity, 8.05, 1e-9);
  near(plan.stopPrice, 9.876, 1e-9);
  assert.ok(plan.price < plan.stopPrice, "the limit must sit below the trigger to fill in a fast move");
  near(plan.price, floorToStep(9.876 * (1 - DEFAULT_LIMIT_OFFSET_FRACTION), 0.001), 1e-9);
});

test("rounding the quantity down is what keeps the order acceptable", () => {
  // Rounding UP would ask to sell more base asset than is held, which Binance
  // rejects — the same class of error as BOT-014 on the buy side.
  const plan = planProtectiveOrder({
    symbol: "APTUSDT", quantity: 8.019999, stopPrice: 10,
    precision, clientOrderId: "x",
  });
  assert.ok(plan.quantity <= 8.019999);
  near(plan.quantity, 8.01, 1e-9);
});

test("a quantity below the lot minimum is refused with a specific code", () => {
  assert.throws(
    () => planProtectiveOrder({
      symbol: "APTUSDT", quantity: 0.001, stopPrice: 10, precision, clientOrderId: "x",
    }),
    (err: unknown) => err instanceof ProtectiveOrderRejected && err.code === "below_min_qty"
  );
});

test("a notional below the exchange minimum is refused with a specific code", () => {
  assert.throws(
    () => planProtectiveOrder({
      symbol: "APTUSDT", quantity: 0.02, stopPrice: 10,
      precision: { ...precision, minNotional: 100 }, clientOrderId: "x",
    }),
    (err: unknown) => err instanceof ProtectiveOrderRejected && err.code === "below_min_notional"
  );
});

test("a non-positive stop price is refused rather than sent", () => {
  for (const stopPrice of [0, -1, NaN]) {
    assert.throws(
      () => planProtectiveOrder({
        symbol: "APTUSDT", quantity: 8, stopPrice, precision, clientOrderId: "x",
      }),
      (err: unknown) => err instanceof ProtectiveOrderRejected && err.code === "invalid_prices",
      String(stopPrice)
    );
  }
});

test("a wider offset produces a lower limit, and zero produces limit == trigger", () => {
  const wide = planProtectiveOrder({
    symbol: "APTUSDT", quantity: 8, stopPrice: 100,
    precision, clientOrderId: "x", limitOffsetFraction: 0.02,
  });
  const tight = planProtectiveOrder({
    symbol: "APTUSDT", quantity: 8, stopPrice: 100,
    precision, clientOrderId: "x", limitOffsetFraction: 0,
  });
  assert.ok(wide.price < tight.price);
  near(tight.price, 100, 1e-9);
});
