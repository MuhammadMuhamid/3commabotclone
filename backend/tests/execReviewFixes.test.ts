/**
 * Fixes for the independent review of the Bot exec slice (2026-11-09).
 *
 *   F1  an uncertain (`submitted`) exit of a manual position is resolved
 *       query-first by the OTHER exit owner — the operator's SELL and the TP/SL
 *       poller — before it sizes its own; still unresolved, the operator is
 *       refused 409 `exit_unresolved` and the poller skips the cycle. Never a
 *       blind second SELL. `/state.sweepNote` counts automation-origin held
 *       sweeps only.
 *   F2  OD-1 finalisation engages only for entries the new policy marked
 *       (`exitCancelState` non-null); a legacy still-working entry keeps its
 *       `entry_working_after_exit` flag and is never cancelled at boot.
 *   F3  a full exit of a position whose entry fills are booked GROSS
 *       (`fillsNetted: false`) sells the 0.1 % haircut, without waiting; what it
 *       deliberately leaves closes with the position.
 *   F4/F6/F7  the RACE FILL wording after a failed refresh, C0
 *       `entries.uncertainBuyOrders`, and durable flags appended, not replaced.
 *
 * Re-review of bd2990a:
 *   R1  a `requested` SELL of a tracked position (never sent) is not
 *       first-submitted by the reconciler past its position: closed -> rejected
 *       NEVER SENT; otherwise under the close lock, after the other exits are
 *       resolved, capped at what the position holds (and I3). Probe P7.
 *   CAS the submit path's own requested -> submitted is a compare-and-set.
 *   F3  the reconciler closes a haircut exit's remainder; a haircut that floors
 *       to 0 is refused 409 `haircut_below_lot`.
 *
 * The probes of the review (`tmp/review-exec/backend/tests/zz_review_probe.test.ts`)
 * are reused here with the expectation the review asked for.
 * Real services + disposable SQLite + the in-memory fake exchange. No network.
 */
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount } from "@prisma/client";
import { binanceError, fakeBinance, fetchFailed, type FakeBinance } from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".exec-review-fixes-test.db");
process.env.DATABASE_URL = "file:./tests/.exec-review-fixes-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { checkManualProtection, PROTECTION_FAILURE_ALERT_CYCLES } =
  await import("../src/services/manualProtection.js");
const risk = await import("../src/services/riskControls.js");
const lock = await import("../src/lib/tradeCloseLock.js");
const { openOrderAttempt } = await import("../src/services/orderAttempt.js");

type Factory = (account: ExchangeAccount) => InstanceType<typeof BinanceManualExchange>;
const reconcile = manual.reconcilePendingManualOrders as unknown as
  (factory: Factory, limit?: number, options?: { now?: number }) => Promise<void>;
const poll = checkManualProtection as unknown as (factory: Factory, options?: { now?: number }) => Promise<void>;

const originalDryRun = config.dryRun;
const originalManual = config.manualTradingEnabled;
config.dryRun = false;
config.manualTradingEnabled = true;

after(async () => {
  config.dryRun = originalDryRun;
  config.manualTradingEnabled = originalManual;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  mock.restoreAll();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.manualCommand.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
async function createAccount(): Promise<ExchangeAccount> {
  seq += 1;
  return prisma.exchangeAccount.create({ data: { name: `review-${seq}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}
function factory(exchange: FakeBinance): Factory {
  return (account) => new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
}
/** A protected manual position with no entry order (bought earlier, fully). */
async function protectedPosition(account: ExchangeAccount, quantity: number,
  levels: { tp?: number | null; sl?: number | null } = {}) {
  return prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id, botName: "Manual",
    pair: "BTCUSDT", direction: "long", status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100,
    quantity, quoteSpent: quantity * 100, manualTpPrice: levels.tp === undefined ? 110 : levels.tp,
    manualSlPrice: levels.sl ?? null, protectionType: "bot-managed", protectionState: "active" } });
}
/** A LIMIT BUY entry booked GROSS (its trades lookup failed), `status` at the exchange. */
async function grossEntry(account: ExchangeAccount, exchange: FakeBinance, quantity: number,
  status: "PARTIALLY_FILLED" | "FILLED") {
  seq += 1;
  const cid = `review-entry-${seq}`;
  // A numeric exchange id, as Binance's: the trades (commission) lookup is by
  // order id, so a non-numeric id would always read as "no commission".
  const exchangeOrderId = String(800000 + seq);
  const entry = await prisma.manualOrder.create({ data: {
    requestId: `review-entry-request-${seq}`, exchangeAccountId: account.id, symbol: "BTCUSDT",
    side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: quantity * 100 * 2.5,
    limitPrice: 100, takeProfitPrice: 110, stopLossPrice: 90, protectionType: "bot-managed",
    protectionState: "pending_entry", status: "open", clientOrderId: cid, exchangeOrderId,
    submittedAt: new Date() } });
  exchange.seed({ clientOrderId: cid, orderId: exchangeOrderId, side: "BUY", type: "LIMIT", status,
    executedQty: String(quantity), cummulativeQuoteQty: String(quantity * 100) });
  await manual.applyManualSnapshot(entry.id, { exchangeOrderId, clientOrderId: cid, status,
    executedBaseQuantity: quantity, executedQuoteQuantity: quantity * 100, averagePrice: 100,
    simulated: false, netted: false });
  const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
  return { entry, trade, cid };
}
function failNextLookups(exchange: FakeBinance, n: number) {
  const client = exchange.client as unknown as { getOrder: (args: { origClientOrderId: string }) => Promise<unknown> };
  const original = client.getOrder;
  let left = n;
  client.getOrder = async (args) => {
    if (left > 0) { left -= 1; exchange.lookups.push(args.origClientOrderId); throw fetchFailed(); }
    return original(args);
  };
  return { restore: () => { client.getOrder = original; } };
}
const reload = {
  trade: (id: string) => prisma.smartTrade.findUniqueOrThrow({ where: { id } }),
  order: (id: string) => prisma.manualOrder.findUniqueOrThrow({ where: { id } }),
};
const near = (actual: number, expected: number, what = "") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} != ${expected}`);
const quiet = () => mock.method(console, "error", () => undefined);
const uncertain = () => ({ accepted: true, error: binanceError("Execution status unknown.", -1007) });
const sells = (exchange: FakeBinance) => exchange.accepted("SELL");
function refusal(code: string, status = 409) {
  return (error: unknown) => {
    assert.ok(error instanceof manual.ManualTradingError, `expected a ManualTradingError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.httpStatus, status);
    return true;
  };
}

/** The TP poller's exit is accepted by the exchange but answered -1007 and its recovery lookup fails. */
async function uncertainTpExit(account: ExchangeAccount, exchange: FakeBinance, quantity = 0.4) {
  const target = await protectedPosition(account, quantity);
  exchange.setPrice("111");
  const failing = failNextLookups(exchange, 1);
  await poll(factory(exchange));
  failing.restore();
  const tpExit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: target.id } });
  assert.equal(tpExit.status, "submitted", "the TP exit is live-but-unknown");
  assert.equal(lock.heldLockCount(), 0, "the poller released the lock at the end of its cycle");
  return { target, tpExit };
}

// ════════════════════════════════════════════════════════════════════════════
// F1 — the other exit owner resolves an uncertain exit first
// ════════════════════════════════════════════════════════════════════════════

test("F1 P1: TP exit `submitted` + operator positionFull SELL -> the TP exit is resolved query-first (FILLED), the SELL is refused already_closed; one wire SELL; the untracked 5 untouched",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const { target, tpExit } = await uncertainTpExit(account, exchange);
    near(exchange.wallet.free, 5.0, "the exchange already executed the TP sell");

    await assert.rejects(manual.submitManualOrder({ requestId: "f1-p1", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange)),
    refusal("already_closed"));
    assert.equal(sells(exchange).length, 1, "one wire SELL for one 0.4 position");
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    assert.equal(lock.heldLockCount(), 0);
    const resolved = await reload.order(tpExit.id);
    assert.equal(resolved.status, "filled");
    assert.doesNotMatch(resolved.error ?? "", /LATE SELL FILL/, "booked as the exit, not flagged late");
    const closed = await reload.trade(target.id);
    assert.equal(closed.status, "closed");
    assert.equal(await prisma.manualOrder.count({ where: { requestId: "f1-p1" } }), 0, "nothing reserved");
  });

test("F1 P1b: while the TP exit still cannot be looked up, a full AND a partial operator SELL are refused 409 exit_unresolved; nothing placed",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const { target } = await uncertainTpExit(account, exchange);
    for (const [requestId, extra] of [["f1-p1b-full", { positionFull: true as const }],
      ["f1-p1b-partial", { baseQuantity: 0.1 }]] as const) {
      const failing = failNextLookups(exchange, 1);
      await assert.rejects(manual.submitManualOrder({ requestId, accountId: account.id, symbol: "BTCUSDT",
        side: "SELL", orderType: "MARKET", positionId: target.id, ...extra }, factory(exchange)),
      refusal("exit_unresolved"));
      failing.restore();
      assert.equal(await prisma.manualOrder.count({ where: { requestId } }), 0);
    }
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    assert.equal(lock.heldLockCount(), 0);
    assert.equal((await reload.trade(target.id)).status, "active", "nothing booked without evidence");
  });

test("F1 P2: operator SELL `submitted` + the TP poller -> resolved query-first, no second SELL; the position is closed by the operator's order",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const target = await protectedPosition(account, 0.4);
    const failing = failNextLookups(exchange, 1);
    const sell = await manual.submitManualOrder({ requestId: "f1-p2", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange));
    failing.restore();
    assert.equal(sell.status, "submitted");
    near(exchange.wallet.free, 5.0);

    exchange.setPrice("111");
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1, "one wire SELL");
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    assert.equal((await reload.order(sell.id)).status, "filled");
    assert.equal((await reload.trade(target.id)).status, "closed");
    assert.equal(await prisma.manualOrder.count({ where: { linkedPositionId: target.id } }), 1,
      "the poller reserved no exit of its own");
    assert.equal(lock.heldLockCount(), 0);
  });

test("F1 P2b: while the operator SELL cannot be looked up the poller skips every cycle (no SELL) and raises one bounded alert",
  async () => {
    const errors = quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const target = await protectedPosition(account, 0.4);
    const failing = failNextLookups(exchange, 1);
    const sell = await manual.submitManualOrder({ requestId: "f1-p2b", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange));
    failing.restore();
    assert.equal(sell.status, "submitted");
    exchange.setPrice("89"); // the SL side: it is skipped too, never blindly sold
    await prisma.smartTrade.update({ where: { id: target.id }, data: { manualSlPrice: 90 } });
    for (let cycle = 0; cycle < PROTECTION_FAILURE_ALERT_CYCLES; cycle += 1) {
      const down = failNextLookups(exchange, 1);
      await poll(factory(exchange));
      down.restore();
    }
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    assert.equal(await prisma.manualOrder.count({ where: { linkedPositionId: target.id } }), 1);
    assert.equal(errors.mock.calls.filter((c) => /ALERT: BTCUSDT position .*prior exit of this position is unresolved/
      .test(String(c.arguments[0]))).length, 1, "one alert at the threshold");
    // Evidence arrives: the next cycle books the operator's fill and sells nothing.
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1);
    assert.equal((await reload.trade(target.id)).status, "closed");
  });

test("F1 P3 bound: with no untracked surplus there is still exactly one wire SELL (resolved first, I3 never reached)",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", orderFailures: [uncertain()] });
    const { target } = await uncertainTpExit(account, exchange);
    await assert.rejects(manual.submitManualOrder({ requestId: "f1-p3", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange)),
    refusal("already_closed"));
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 0);
  });

test("F1: a TP exit that never reached the exchange blocks the operator for the 60 s settle window, then is closed off ABSENT and the SELL goes out once",
  async () => {
    quiet();
    const account = await createAccount();
    // Not accepted: -1007 for an order the exchange never recorded.
    const exchange = fakeBinance({ freeBase: "5.4",
      orderFailures: [{ error: binanceError("Execution status unknown.", -1007) }] });
    const { target, tpExit } = await uncertainTpExit(account, exchange);
    assert.equal(sells(exchange).length, 0);
    await assert.rejects(manual.submitManualOrder({ requestId: "f1-absent-1", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id },
    factory(exchange)), refusal("exit_unresolved"));
    await prisma.manualOrder.update({ where: { id: tpExit.id }, data: { submittedAt: new Date(Date.now() - 61_000) } });
    const sell = await manual.submitManualOrder({ requestId: "f1-absent-2", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id },
    factory(exchange));
    assert.equal(sell.status, "filled");
    near(sell.filledBaseQty, 0.4);
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    const absent = await reload.order(tpExit.id);
    assert.equal(absent.status, "rejected");
    assert.match(absent.error ?? "", /^ABSENT/);
  });

test("F1 + A1: under DRY_RUN a live `submitted` exit cannot be looked up, so it blocks (409 exit_unresolved) and is never closed off ABSENT",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const { target, tpExit } = await uncertainTpExit(account, exchange);
    await prisma.manualOrder.update({ where: { id: tpExit.id }, data: { submittedAt: new Date(Date.now() - 61_000) } });
    const dryRun: Factory = (a) => new BinanceManualExchange(a, { client: exchange.client, dryRun: true });
    await assert.rejects(manual.submitManualOrder({ requestId: "f1-dry", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, dryRun),
    refusal("exit_unresolved"));
    assert.equal((await reload.order(tpExit.id)).status, "submitted", "a dry-run 'not found' is no evidence");
    assert.equal((await reload.trade(target.id)).status, "active");
    assert.equal(await prisma.manualOrder.count({ where: { requestId: "f1-dry" } }), 0);
    assert.equal(sells(exchange).length, 1);
    assert.equal(lock.heldLockCount(), 0);
  });

test("F1: a TP exit left `submitted`, then the price falls through the SL -> the SL slot resolves the TP exit first; one wire SELL",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4", orderFailures: [uncertain()] });
    const target = await protectedPosition(account, 0.4, { tp: 110, sl: 90 });
    exchange.setPrice("111");
    const failing = failNextLookups(exchange, 1);
    await poll(factory(exchange));
    failing.restore();
    exchange.setPrice("89");
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    const closed = await reload.trade(target.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "manual_take_profit");
  });

test("F1 P6: halted -> /state.sweepNote counts automation-origin race fills only (an operator-origin one is still swept)",
  async () => {
    quiet();
    const account = await createAccount();
    async function racePosition(origin: "operator" | "automation") {
      seq += 1;
      const cid = `review-${origin}-${seq}`;
      await prisma.manualOrder.create({ data: {
        requestId: `review-${origin}-request-${seq}`, exchangeAccountId: account.id, symbol: "BTCUSDT",
        side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
        status: "canceled", clientOrderId: cid, exchangeOrderId: `ex-${cid}`, filledBaseQty: 0.7,
        filledQuoteQty: 70, exitCancelState: "done", exitOrigin: origin, submittedAt: new Date() } });
      await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
        botName: "Manual (race fill)", pair: "BTCUSDT", direction: "long", status: "active", entryPrice: 100,
        buyPrice: 100, currentPrice: 100, quantity: 0.3, quoteSpent: 30, clientOrderId: `${cid}:late:1`,
        protectionState: "race_fill_sweep" } });
    }
    await racePosition("operator");
    await risk.setBotTradingHalted(true, { by: "operator", reason: "review" });
    const operatorOnly = await manual.listManualState("BTCUSDT") as { protection: { sweepNote?: string } };
    assert.equal(operatorOnly.protection.sweepNote, undefined, "an operator-origin sweep still runs while halted");
    await racePosition("automation");
    const both = await manual.listManualState("BTCUSDT") as { protection: { sweepNote?: string } };
    assert.match(both.protection.sweepNote ?? "", /race fill awaiting sweep — Bot halted/);
  });

// ════════════════════════════════════════════════════════════════════════════
// F2 — legacy still-working entries are not cancelled automatically
// ════════════════════════════════════════════════════════════════════════════

test("F2: a legacy row (exitCancelState null, ENTRY STILL WORKING, trade closed before this version) is NOT cancelled at reconcile; its flag stays",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0" });
    seq += 1;
    const cid = `review-legacy-${seq}`;
    const flag = "ENTRY STILL WORKING: position x was closed while this LIMIT BUY is still working …";
    const entry = await prisma.manualOrder.create({ data: {
      requestId: `review-legacy-request-${seq}`, exchangeAccountId: account.id, symbol: "BTCUSDT",
      side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
      status: "partially_filled", clientOrderId: cid, exchangeOrderId: `ex-${cid}`, filledBaseQty: 0.4,
      filledQuoteQty: 40, protectionState: "entry_working_after_exit", error: flag, submittedAt: new Date() } });
    await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id, botName: "Manual",
      pair: "BTCUSDT", direction: "long", status: "closed", closedAt: new Date(), closedReason: "manual_take_profit",
      entryPrice: 100, buyPrice: 100, currentPrice: 110, quantity: 0.4, quoteSpent: 40, manualOrderId: entry.id,
      protectionState: "removed" } });
    exchange.seed({ clientOrderId: cid, orderId: `ex-${cid}`, side: "BUY", type: "LIMIT",
      status: "PARTIALLY_FILLED", executedQty: "0.4", cummulativeQuoteQty: "40" });

    await reconcile(factory(exchange));
    await reconcile(factory(exchange));
    assert.deepEqual(exchange.cancels, [], "the legacy resting order is left to the operator");
    const kept = await reload.order(entry.id);
    assert.equal(kept.status, "partially_filled");
    assert.equal(kept.exitCancelState, null);
    assert.equal(kept.protectionState, "entry_working_after_exit");
    assert.equal(kept.error, flag);

    // A later fill of the legacy entry stays an unprotected late fill (never a sweep).
    exchange.fill(cid, "0.6", "60", "PARTIALLY_FILLED");
    await reconcile(factory(exchange));
    const late = await prisma.smartTrade.findFirstOrThrow({ where: { clientOrderId: `${cid}:late:1` } });
    assert.equal(late.protectionState, "late_fill_unprotected");
    assert.deepEqual(exchange.cancels, []);
  });

// ════════════════════════════════════════════════════════════════════════════
// F3 — X7 on the active trade: a gross entry is not sold gross
// ════════════════════════════════════════════════════════════════════════════

test("F3 P4: entry booked GROSS and still gross at the pre-cancel -> the TP exit sells the 0.1% haircut (0.3996), noted; the untracked 5 untouched; the position closes",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.3996", buyCommissionRate: 0.001, myTradesFails: true });
    const { trade } = await grossEntry(account, exchange, 0.4, "PARTIALLY_FILLED");
    near(trade.quantity, 0.4, "booked gross");
    exchange.setPrice("111");
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1, "no waiting: the exit goes out on the first cycle");
    near(Number(sells(exchange)[0]!.executedQty), 0.3996);
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "manual_take_profit");
    const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: trade.id } });
    assert.match(exit.error ?? "", /NETTING UNCONFIRMED/);
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1, "nothing is left to sell");
  });

test("F3: the SL of a gross FILLED entry is not delayed: haircut on the first cycle; a large position's remainder (above the notional minimum) closes with it",
  async () => {
    quiet();
    const account = await createAccount();
    // 40 BTC gross; the 0.04 haircut at 89 is 3.56 USDT, above the 1 USDT minimum notional.
    const exchange = fakeBinance({ freeBase: "44.96", buyCommissionRate: 0.001, myTradesFails: true,
      stepSize: "0.001", minQty: "0.001" });
    const { trade } = await grossEntry(account, exchange, 40, "FILLED");
    exchange.setPrice("89");
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1);
    near(Number(sells(exchange)[0]!.executedQty), 39.96);
    near(exchange.wallet.free, 5.0);
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "manual_stop_loss");
    for (let cycle = 0; cycle < 2; cycle += 1) await poll(factory(exchange));
    assert.equal(sells(exchange).length, 1, "the haircut remainder is never sold out of the untracked coins");
    near(exchange.wallet.free, 5.0);
  });

test("F3: a manual positionFull SELL of a gross entry sells the haircut, noted; the untracked 5 untouched",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.3996", buyCommissionRate: 0.001, myTradesFails: true });
    const { trade } = await grossEntry(account, exchange, 0.4, "FILLED");
    const sell = await manual.submitManualOrder({ requestId: "f3-full", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: trade.id }, factory(exchange));
    assert.equal(sell.status, "filled");
    near(sell.filledBaseQty, 0.3996);
    assert.match(sell.error ?? "", /NETTING UNCONFIRMED/);
    near(exchange.wallet.free, 5.0);
    assert.equal((await reload.trade(trade.id)).status, "closed");
  });

test("F3: a gross entry that nets on the one re-query is sold at the netted figure, with no haircut", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "5.3996", buyCommissionRate: 0.001, myTradesFails: true });
  const { trade } = await grossEntry(account, exchange, 0.4, "FILLED");
  exchange.setMyTradesFails(false);
  exchange.setPrice("111");
  await poll(factory(exchange));
  assert.equal(sells(exchange).length, 1);
  near(Number(sells(exchange)[0]!.executedQty), 0.3996);
  const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: trade.id } });
  assert.doesNotMatch(exit.error ?? "", /NETTING UNCONFIRMED/);
  assert.equal((await reload.trade(trade.id)).status, "closed");
});

// ════════════════════════════════════════════════════════════════════════════
// F4 / F6 / F7
// ════════════════════════════════════════════════════════════════════════════

test("F4: a full numeric SELL after a FAILED refresh says the raise covers fills from before and during the cancel",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "1" });
    seq += 1;
    const cid = `review-f4-${seq}`;
    const entry = await prisma.manualOrder.create({ data: {
      requestId: `review-f4-request-${seq}`, exchangeAccountId: account.id, symbol: "BTCUSDT",
      side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
      takeProfitPrice: 110, protectionType: "bot-managed", protectionState: "pending_entry", status: "open",
      clientOrderId: cid, exchangeOrderId: `ex-${cid}`, submittedAt: new Date() } });
    exchange.seed({ clientOrderId: cid, orderId: `ex-${cid}`, side: "BUY", type: "LIMIT",
      status: "PARTIALLY_FILLED", executedQty: "0.4", cummulativeQuoteQty: "40" });
    await manual.applyManualSnapshot(entry.id, { exchangeOrderId: `ex-${cid}`, clientOrderId: cid,
      status: "PARTIALLY_FILLED", executedBaseQuantity: 0.4, executedQuoteQuantity: 40, averagePrice: 100,
      simulated: false });
    const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
    // The exchange already has 0.7 (unknown to the Bot); the refresh fails; the cancel answers 0.7.
    exchange.fill(cid, "0.7", "70", "PARTIALLY_FILLED");
    const failing = failNextLookups(exchange, 1);
    const sell = await manual.submitManualOrder({ requestId: "f4-full", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id }, factory(exchange));
    failing.restore();
    near(sell.filledBaseQty, 0.7);
    assert.match(sell.error ?? "", /^RACE FILL: 0\.3 BTC of the entry filled before and during the cancel/);
    assert.match(sell.error ?? "", /refresh before this exit had failed/);
    assert.match(sell.error ?? "", /ENTRY REFRESH FAILED/);
  });

test("F6: C0 entries.uncertainBuyOrders counts manual BUYs left `submitted`", async () => {
  const account = await createAccount();
  await prisma.manualOrder.create({ data: { requestId: "f6-uncertain", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quantityType: "quote", requestedQuoteQty: 50,
    status: "submitted", clientOrderId: "f6-uncertain-cid" } });
  await prisma.manualOrder.create({ data: { requestId: "f6-sell", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", quantityType: "base", requestedBaseQty: 1,
    status: "submitted", clientOrderId: "f6-sell-cid" } });
  const entries = await risk.readEntriesStatus();
  assert.equal(entries.uncertainBuyOrders, 1);
});

test("F7: the dust note and the SWEEP FAILED hand-off keep the durable flag already recorded", async () => {
  quiet();
  const account = await createAccount();
  const position = await protectedPosition(account, 0.00004);
  const exit = await prisma.manualOrder.create({ data: { requestId: "f7-exit", exchangeAccountId: account.id,
    linkedPositionId: position.id, symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", quantityType: "base",
    requestedBaseQty: 0.4, status: "filled", clientOrderId: "f7-exit-cid",
    error: "RACE FILL: 0.2 BTC of the entry filled while the Bot cancelled it" } });
  assert.equal(await manual.closeManualDust(position.id, { stepSize: 0.0001, minQty: 0.0001, minNotional: 1 },
    100, exit.id), true);
  const noted = (await reload.order(exit.id)).error ?? "";
  assert.match(noted, /^DUST: /);
  assert.match(noted, /RACE FILL: 0\.2 BTC/);

  const entry = await prisma.manualOrder.create({ data: { requestId: "f7-entry", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100,
    limitPrice: 100, status: "canceled", clientOrderId: "f7-entry-cid", filledBaseQty: 0.7, filledQuoteQty: 70,
    exitCancelState: "done", error: "NETTING UNCONFIRMED: the base-asset commission could not be confirmed" } });
  const race = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
    botName: "Manual (race fill)", pair: "BTCUSDT", direction: "long", status: "active", quantity: 0.3,
    quoteSpent: 30, clientOrderId: "f7-entry-cid:late:1", protectionState: "race_fill_sweep" } });
  assert.equal(await manual.handOffRaceFillSweep(race, entry, 3), true);
  const handed = (await reload.order(entry.id)).error ?? "";
  assert.match(handed, /^SWEEP FAILED/);
  assert.match(handed, /NETTING UNCONFIRMED/);
});

// ════════════════════════════════════════════════════════════════════════════
// Re-review R1 — a `requested` SELL is never first-submitted past its position
// ════════════════════════════════════════════════════════════════════════════

/** A SELL reserved but never sent: a crash between the reservation and its `submitted` update. */
async function strandedSell(account: ExchangeAccount, positionId: string, quantity: number, tag: string,
  extra: { requestId?: string; clientOrderId?: string; protectionType?: string; protectionState?: string;
    createdAt?: Date } = {}) {
  return prisma.manualOrder.create({ data: { requestId: `rr-${tag}`, exchangeAccountId: account.id,
    linkedPositionId: positionId, symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", quantityType: "base",
    requestedBaseQty: quantity, protectionState: "none", clientOrderId: `rr-${tag}-cid`, ...extra } });
}

test("R1 P7: a `requested` operator SELL (one failed lookup), then the TP poller closes the position -> the reconciler rejects the stale SELL as never sent; one wire SELL; the untracked 5 untouched",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const target = await protectedPosition(account, 0.4);
    const stale = await strandedSell(account, target.id, 0.4, "p7");
    const failing = failNextLookups(exchange, 1);
    await reconcile(factory(exchange)); // the lookup fails: it stays requested
    failing.restore();
    assert.equal((await reload.order(stale.id)).status, "requested");
    exchange.setPrice("111");
    await poll(factory(exchange)); // the TP exit; F1 does not see a `requested` row
    assert.equal((await reload.trade(target.id)).status, "closed");

    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 1, "one wire SELL for one 0.4 position");
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    const rejected = await reload.order(stale.id);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.submittedAt, null, "never sent");
    assert.match(rejected.error ?? "", /^NEVER SENT: position .* was closed by another exit/);
    assert.equal(lock.heldLockCount(), 0);
    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 1);
  });

test("R1: an automated TP exit held `requested` through a halt while the operator sells the position by hand -> on resume it is rejected, never sent, its attempt abandoned; one wire SELL",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const target = await protectedPosition(account, 0.4);
    const intentKey = `manual-tp-${target.id}-110`;
    const attempt = await openOrderAttempt({ intentKey, symbol: "BTCUSDT", side: "SELL", smartTradeId: target.id,
      origin: "manual-protection", requestedBaseQty: 0.4, closedReason: "manual_take_profit" });
    const held = await strandedSell(account, target.id, 0.4, "auto", { requestId: `${intentKey}#${attempt.attempt}`,
      clientOrderId: attempt.clientOrderId, protectionType: "bot-managed", protectionState: "triggered" });
    await risk.setBotTradingHalted(true, { by: "operator", reason: "re-review" });
    await reconcile(factory(exchange));
    assert.equal((await reload.order(held.id)).status, "requested", "an automated exit waits out the halt");
    const sell = await manual.submitManualOrder({ requestId: "rr-auto-operator", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id },
    factory(exchange));
    assert.equal(sell.status, "filled");
    assert.equal((await reload.trade(target.id)).status, "closed");

    await risk.setBotTradingHalted(false, { by: "operator" });
    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 1, "the held exit never reaches the wire");
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    const rejected = await reload.order(held.id);
    assert.equal(rejected.status, "rejected");
    assert.match(rejected.error ?? "", /^NEVER SENT/);
    assert.equal((await prisma.exchangeOrderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status,
      "abandoned", "the poller's slot re-arms");
    assert.equal(lock.heldLockCount(), 0);
  });

test("R1: a `requested` SELL of 0.4 whose position the operator has since reduced to 0.25 -> first-submitted for the 0.25 it still holds; the untracked 5 untouched",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const target = await protectedPosition(account, 0.4);
    const stale = await strandedSell(account, target.id, 0.4, "cap");
    const partial = await manual.submitManualOrder({ requestId: "rr-cap-partial", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 0.15, positionId: target.id },
    factory(exchange));
    assert.equal(partial.status, "filled");
    near((await reload.trade(target.id)).quantity, 0.25);

    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 2);
    near(Number(sells(exchange)[1]!.executedQty), 0.25, "capped at what the position holds now");
    near(exchange.wallet.free, 5.0, "the untracked 5 are untouched");
    const sent = await reload.order(stale.id);
    assert.equal(sent.status, "filled");
    near(sent.requestedBaseQty ?? 0, 0.25, "the durable row says what was sent");
    assert.equal((await reload.trade(target.id)).status, "closed");
    assert.equal(lock.heldLockCount(), 0);
  });

test("R1: while another exit holds the position's close lock a `requested` SELL is not sent; it goes out on the next cycle",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const target = await protectedPosition(account, 0.4);
    const stale = await strandedSell(account, target.id, 0.4, "busy");
    assert.ok(lock.acquireTradeClose(target.id));
    try {
      await reconcile(factory(exchange));
    } finally {
      lock.releaseTradeClose(target.id);
    }
    assert.equal(sells(exchange).length, 0, "skipped while another exit owns the position");
    assert.equal((await reload.order(stale.id)).status, "requested");
    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    assert.equal((await reload.order(stale.id)).status, "filled");
    assert.equal(lock.heldLockCount(), 0);
  });

test("R1: another SELL of the position left `submitted` and not yet found blocks a `requested` SELL; once it is closed off ABSENT the requested SELL goes out once",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const target = await protectedPosition(account, 0.4);
    const prior = await strandedSell(account, target.id, 0.4, "prior", { createdAt: new Date(Date.now() - 1_000) });
    await prisma.manualOrder.update({ where: { id: prior.id }, data: { status: "submitted", submittedAt: new Date() } });
    const stale = await strandedSell(account, target.id, 0.4, "blocked");
    await reconcile(factory(exchange));
    assert.equal(sells(exchange).length, 0, "no SELL while another exit of the position may be live");
    assert.equal((await reload.order(stale.id)).status, "requested");

    await reconcile(factory(exchange), 100, { now: Date.now() + 61_000 });
    assert.equal((await reload.order(prior.id)).status, "rejected");
    assert.equal(sells(exchange).length, 1);
    near(exchange.wallet.free, 5.0);
    assert.equal((await reload.order(stale.id)).status, "filled");
    assert.equal(lock.heldLockCount(), 0);
  });

test("Re-review advisory: a reconcile tick between the reservation and the submit path's own claim -> that claim is a compare-and-set; one wire SELL under one client order id",
  async () => {
    quiet();
    const account = await createAccount();
    // Binance may accept a reused client order id once the earlier order FILLED.
    const exchange = fakeBinance({ freeBase: "5.4", reuseAfterFill: true });
    const target = await protectedPosition(account, 0.4);
    const delegate = prisma.manualOrder as unknown as { create: (args: unknown) => Promise<{ requestId: string }> };
    const create = delegate.create;
    delegate.create = async (args) => {
      const row = await create.call(delegate, args);
      if (row.requestId === "rr-cas") await reconcile(factory(exchange)); // the tick lands here
      return row;
    };
    let sell;
    try {
      sell = await manual.submitManualOrder({ requestId: "rr-cas", accountId: account.id, symbol: "BTCUSDT",
        side: "SELL", orderType: "MARKET", baseQuantity: 0.1, positionId: target.id }, factory(exchange));
    } finally {
      delegate.create = create;
    }
    assert.equal(sells(exchange).length, 1, "one wire SELL under one client order id");
    near(exchange.wallet.free, 5.3);
    assert.equal(sell.status, "filled");
    near((await reload.trade(target.id)).quantity, 0.3);
    assert.equal(lock.heldLockCount(), 0);
  });

test("F3 (re-review): an uncertain haircut exit later booked by the reconciler closes the presumed-commission remainder; a later TP sells nothing",
  async () => {
    quiet();
    const account = await createAccount();
    // 40.5 BTC booked gross; its haircut exit, floor(40.4595 to the 0.01 lot) = 40.45, FILLED at the
    // exchange and its reply was lost. The 0.05 left is above the 0.1 % close tolerance of a fill.
    const exchange = fakeBinance({ freeBase: "5", buyCommissionRate: 0.001, myTradesFails: true,
      stepSize: "0.01", minQty: "0.01" });
    const { trade } = await grossEntry(account, exchange, 40.5, "FILLED");
    const exit = await prisma.manualOrder.create({ data: { requestId: "rr-f3-exit", exchangeAccountId: account.id,
      linkedPositionId: trade.id, symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", quantityType: "base",
      requestedBaseQty: 40.45, protectionState: "none", status: "submitted", submittedAt: new Date(),
      clientOrderId: "rr-f3-exit-cid" } });
    exchange.seed({ clientOrderId: "rr-f3-exit-cid", orderId: "900001", side: "SELL", type: "MARKET",
      status: "FILLED", executedQty: "40.45", cummulativeQuoteQty: "4045" });

    await reconcile(factory(exchange));
    assert.equal((await reload.order(exit.id)).status, "filled");
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed", "the 0.05 left is the presumed commission, not a position");
    assert.equal(closed.closedReason, "manual_sell");
    exchange.setPrice("111");
    await poll(factory(exchange));
    assert.equal(sells(exchange).length, 0, "nothing is sold out of the untracked coins");
    near(exchange.wallet.free, 5.0);
    assert.equal(lock.heldLockCount(), 0);
  });

test("F3 (re-review nit): a positionFull SELL whose haircut floors to 0 at the lot is refused 409 haircut_below_lot, not 422 'position not found'; nothing placed",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.0001", buyCommissionRate: 0.001, myTradesFails: true });
    const { trade } = await grossEntry(account, exchange, 0.0001, "FILLED");
    await assert.rejects(manual.submitManualOrder({ requestId: "rr-f3-zero", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", positionFull: true, positionId: trade.id },
    factory(exchange)), (error: unknown) => {
      refusal("haircut_below_lot")(error);
      assert.match((error as Error).message, /floors to 0 at the exchange lot step/);
      return true;
    });
    assert.equal(sells(exchange).length, 0);
    assert.equal(await prisma.manualOrder.count({ where: { requestId: "rr-f3-zero" } }), 0, "nothing reserved");
    assert.equal((await reload.trade(trade.id)).status, "active", "still tracked");
    assert.equal(lock.heldLockCount(), 0);
  });
