/**
 * OD-1 (owner-approved option C) — cancel first, then sweep race fills — with
 * X4 (a full manual SELL takes the per-trade close lock) and X7 (a sweep waits
 * for the fee-netted figure).
 *
 * A partially filled manual LIMIT BUY is still working when its position takes
 * a FULL exit (TP, SL, or an operator's full SELL):
 *
 *   - the entry is CANCELLED before the exit is sized, so a fill in the race is
 *     in the cancel's cumulative answer and the same exit sells it;
 *   - whatever becomes known only after the position closed (an unknown cancel,
 *     a fill that won the race) is booked as a `race_fill_sweep` position and
 *     sold by the protection poller under `manual-sweep-<id>` attempts;
 *   - a cancel is never blind (-2011 -> lookup; definite rejection -> owed;
 *     anything else -> unknown, queried first), bounded at 5 with alerts;
 *   - a partial SELL never cancels; nothing reopens a closed trade (I1); the
 *     untracked wallet surplus is never sold (I3); DRY_RUN never fakes a live
 *     cancel (A1).
 *
 * Trace cases (investigation/bot-safety-trace.md §1.3) are named "case N".
 * Real services + disposable SQLite + the in-memory fake exchange. No network.
 */
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, SmartTrade } from "@prisma/client";
import {
  binanceError, fakeBinance, fetchFailed, htmlStatusError, timeoutError, type FakeBinance,
} from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".od1-cancel-sweep-test.db");
process.env.DATABASE_URL = "file:./tests/.od1-cancel-sweep-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { checkManualProtection } = await import("../src/services/manualProtection.js");
const risk = await import("../src/services/riskControls.js");
const lock = await import("../src/lib/tradeCloseLock.js");
const binance = await import("../src/services/binance.js");

const { applyManualSnapshot, submitManualOrder } = manual;
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
  return prisma.exchangeAccount.create({ data: { name: `od1-${seq}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}

function factory(exchange: FakeBinance, dryRun = false): Factory {
  return (account) => new BinanceManualExchange(account, { client: exchange.client, dryRun });
}

/**
 * A protected LIMIT BUY of 1.0 @ 100 whose first `filled` has been booked
 * (`base` lets a test book the netted figure of `filled` gross).
 */
async function workingEntry(account: ExchangeAccount, exchange: FakeBinance,
  opts: { filled?: number; base?: number; exchangeOrderId?: string } = {}) {
  seq += 1;
  const cid = `od1-entry-${seq}`;
  const filled = opts.filled ?? 0.4;
  const base = opts.base ?? filled;
  const exchangeOrderId = opts.exchangeOrderId ?? `ex-${cid}`;
  const entry = await prisma.manualOrder.create({ data: {
    requestId: `od1-entry-request-${seq}`, exchangeAccountId: account.id, symbol: "BTCUSDT",
    side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
    takeProfitPrice: 110, stopLossPrice: 90, protectionType: "bot-managed",
    protectionState: "pending_entry", status: "open", clientOrderId: cid, exchangeOrderId,
    submittedAt: new Date() } });
  exchange.seed({ clientOrderId: cid, orderId: exchangeOrderId, side: "BUY", type: "LIMIT",
    status: "PARTIALLY_FILLED", executedQty: String(filled), cummulativeQuoteQty: String(filled * 100) });
  await applyManualSnapshot(entry.id, { exchangeOrderId, clientOrderId: cid,
    status: "PARTIALLY_FILLED", executedBaseQuantity: base, executedQuoteQuantity: filled * 100,
    averagePrice: 100, simulated: exchangeOrderId.startsWith("dry-") });
  const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
  return { entry, trade, cid };
}

const reload = {
  trade: (id: string) => prisma.smartTrade.findUniqueOrThrow({ where: { id } }),
  order: (id: string) => prisma.manualOrder.findUniqueOrThrow({ where: { id } }),
};

function racePositions(account: ExchangeAccount): Promise<SmartTrade[]> {
  return prisma.smartTrade.findMany({ where: { exchangeAccountId: account.id, source: "manual",
    manualOrderId: null, clientOrderId: { contains: ":late:" } }, orderBy: { createdAt: "asc" } });
}

const wireSells = (exchange: FakeBinance) => exchange.accepted("SELL");
const near = (actual: number, expected: number, what = "") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what} ${actual} != ${expected}`);
const quiet = () => mock.method(console, "error", () => undefined);

/**
 * Close the trade with a TP exit whose pre-cancel outcome is UNKNOWN, with the
 * fallback refresh and the inline finalizer lookups both failing, so the
 * exchange's later state is learned only by the next reconcile — the shape of
 * every "sweep" case. `accepted` scripts what the exchange really did.
 */
async function closeWithUnknownCancel(account: ExchangeAccount, exchange: FakeBinance,
  opts: { error?: Error; acceptedFillTo?: { executedQty: string; quote: string } } = {}) {
  const fixture = await workingEntry(account, exchange);
  exchange.scriptCancel({ error: opts.error ?? binanceError("Execution status unknown.", -1007),
    accepted: opts.acceptedFillTo !== undefined, fillTo: opts.acceptedFillTo });
  // Fail the two lookups the TP cycle makes after the unknown cancel.
  exchange.setPrice("111");
  const lookupsBefore = exchange.lookups.length;
  const failing = fakeLookupFailures(exchange, 2);
  await poll(factory(exchange));
  failing.restore();
  assert.ok(exchange.lookups.length - lookupsBefore >= 2, "the TP cycle read the entry");
  exchange.setPrice("100");
  return fixture;
}

/** Make the next `n` `getOrder` calls fail with a transport error. */
function fakeLookupFailures(exchange: FakeBinance, n: number) {
  const client = exchange.client as unknown as { getOrder: (args: { origClientOrderId: string }) => Promise<unknown> };
  const original = client.getOrder;
  let left = n;
  client.getOrder = async (args) => {
    if (left > 0) { left -= 1; exchange.lookups.push(args.origClientOrderId); throw fetchFailed(); }
    return original(args);
  };
  return { restore: () => { client.getOrder = original; } };
}

// ── case 1: V1 stale snapshot ───────────────────────────────────────────────

for (const leg of [{ name: "SL", price: "89", reason: "manual_stop_loss" },
  { name: "TP", price: "111", reason: "manual_take_profit" }]) {
  test(`OD-1 case 1 (${leg.name}): ledger 0.4, exchange 1.0 FILLED -> the pre-cancel gets -2011, the lookup says FILLED, the exit sells 1.0; no race position`,
    async () => {
      const account = await createAccount();
      const exchange = fakeBinance({ freeBase: "1" });
      const { entry, trade, cid } = await workingEntry(account, exchange);
      exchange.fill(cid, "1", "100", "FILLED");
      exchange.setPrice(leg.price);
      await poll(factory(exchange));

      assert.deepEqual(exchange.cancels, [cid], "one pre-cancel");
      assert.equal(wireSells(exchange).length, 1);
      near(Number(wireSells(exchange)[0]!.executedQty), 1);
      const cancelAt = exchange.events.indexOf(`cancel:${cid}`);
      const sellAt = exchange.events.findIndex((e) => e.startsWith("order:SELL"));
      assert.ok(cancelAt >= 0 && cancelAt < sellAt, "cancelled BEFORE the exit was placed");
      const closed = await reload.trade(trade.id);
      assert.equal(closed.status, "closed");
      assert.equal(closed.closedReason, leg.reason);
      const after = await reload.order(entry.id);
      assert.equal(after.status, "filled");
      assert.equal(after.exitCancelState, "done");
      assert.equal(after.exitOrigin, "automation");
      assert.equal((await racePositions(account)).length, 0);
    });
}

// ── case 2: the race ────────────────────────────────────────────────────────

for (const leg of [{ name: "TP", price: "111" }, { name: "SL", price: "89" }]) {
  test(`OD-1 case 2 (${leg.name}): a fill in the race (CANCELED with 0.55 against a ledger of 0.4) is sold by ONE exit of 0.55, flagged RACE FILL`,
    async () => {
      const account = await createAccount();
      const exchange = fakeBinance({ freeBase: "0.4" });
      const { entry, trade, cid } = await workingEntry(account, exchange);
      exchange.fillBeforeCancel({ executedQty: "0.55", quote: "55" });
      exchange.setPrice(leg.price);
      await poll(factory(exchange));

      assert.equal(wireSells(exchange).length, 1, "one exit, no separate sweep");
      near(Number(wireSells(exchange)[0]!.executedQty), 0.55);
      const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: trade.id } });
      assert.match(exit.error ?? "", /^RACE FILL/);
      const after = await reload.order(entry.id);
      assert.equal(after.status, "canceled");
      near(after.filledBaseQty, 0.55);
      assert.equal(after.exitCancelState, "done");
      assert.match(after.error ?? "", /^RACE FILL/);
      assert.equal((await reload.trade(trade.id)).status, "closed");
      assert.equal((await racePositions(account)).length, 0);
      assert.deepEqual(exchange.cancels, [cid]);
      near(exchange.wallet.free, 0);
    });
}

// ── case 3: no race ─────────────────────────────────────────────────────────

test("OD-1 case 3: no race (CANCELED at 0.4) -> one SELL of 0.4; a later reconcile changes nothing; nothing reopens (I1)",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    await poll(factory(exchange));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await reconcile(factory(exchange));
      await poll(factory(exchange));
    }
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 0.4);
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    near(closed.quantity, 0.4);
    const after = await reload.order(entry.id);
    assert.equal(after.status, "canceled");
    assert.equal(after.exitCancelState, "done");
    assert.equal(after.exitCancelAttempts, 1);
    assert.equal(after.error, null, "a clean cancel leaves no flag");
    assert.equal((await racePositions(account)).length, 0);
  });

// ── case 4: unknown cancel, then the sweep ──────────────────────────────────

for (const failure of [
  { name: "-1006", make: () => binanceError("Execution status unknown.", -1006) },
  { name: "-1007", make: () => binanceError("Timeout waiting for response from backend server.", -1007) },
  { name: "HTTP 502", make: () => htmlStatusError(502) },
  { name: "transport", make: fetchFailed },
  { name: "timeout", make: timeoutError },
]) {
  test(`OD-1 case 4 (${failure.name}): an unknown cancel never blocks the exit (0.4 sold); the next query shows CANCELED 0.7 -> race position 0.3 -> exactly one sweep of 0.3`,
    async () => {
      quiet();
      const account = await createAccount();
      const exchange = fakeBinance({ freeBase: "0.4" });
      const { entry, trade } = await closeWithUnknownCancel(account, exchange,
        { error: failure.make(), acceptedFillTo: { executedQty: "0.7", quote: "70" } });
      assert.equal((await reload.trade(trade.id)).status, "closed");
      assert.equal(wireSells(exchange).length, 1);
      near(Number(wireSells(exchange)[0]!.executedQty), 0.4);
      const unknown = await reload.order(entry.id);
      assert.equal(unknown.exitCancelState, "unknown");
      assert.equal(unknown.status, "partially_filled", "nothing assumed about the cancel");

      // Nothing to sweep until a query has shown the fill.
      await poll(factory(exchange));
      assert.equal(wireSells(exchange).length, 1, "the sweep is never placed before the query");
      assert.equal((await racePositions(account)).length, 0);

      await reconcile(factory(exchange));
      const race = await racePositions(account);
      assert.equal(race.length, 1);
      near(race[0]!.quantity, 0.3);
      assert.equal(race[0]!.protectionState, "race_fill_sweep");
      assert.equal(race[0]!.manualTpPrice, null);
      const booked = await reload.order(entry.id);
      assert.equal(booked.status, "canceled");
      assert.equal(booked.exitCancelState, "done");
      assert.match(booked.error ?? "", /^RACE FILL/);

      for (let cycle = 0; cycle < 3; cycle += 1) {
        await poll(factory(exchange));
        await reconcile(factory(exchange));
      }
      assert.equal(wireSells(exchange).length, 2, "exactly one sweep");
      near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
      const swept = await reload.trade(race[0]!.id);
      assert.equal(swept.status, "closed");
      assert.equal(swept.closedReason, "entry_race_fill_swept");
      const attempt = await prisma.exchangeOrderAttempt.findFirstOrThrow({
        where: { intentKey: `manual-sweep-${race[0]!.id}` } });
      assert.equal(attempt.origin, "manual-sweep");
      assert.equal(wireSells(exchange)[1]!.clientOrderId,
        binance.clientOrderId(`manual-sweep-${race[0]!.id}#1`), "deterministic sweep client id");
      assert.equal((await reload.trade(trade.id)).status, "closed", "I1");
      near(exchange.wallet.free, 0);
    });
}

// ── case 5: unknown cancel while the order keeps working ────────────────────

test("OD-1 case 5: an entry still working after unknown cancels is cancelled again by the finalizer, at most 5 times; then failed, flagged, alerted once, no further cancels",
  async () => {
    const errors = quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const unknown = () => ({ error: binanceError("Execution status unknown.", -1007) });
    exchange.scriptCancel(unknown(), unknown(), unknown(), unknown(), unknown(), unknown());
    const { entry, trade } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    await poll(factory(exchange));
    assert.equal((await reload.trade(trade.id)).status, "closed", "the exit was not blocked");
    // Pre-cancel (1) and the inline finalizer (2) already ran.
    assert.equal(exchange.cancels.length, 2);
    for (let cycle = 0; cycle < 6; cycle += 1) await reconcile(factory(exchange));

    assert.equal(exchange.cancels.length, 5, "bounded at 5 cancels");
    const failed = await reload.order(entry.id);
    assert.equal(failed.exitCancelState, "failed");
    assert.equal(failed.exitCancelAttempts, 5);
    assert.match(failed.error ?? "", /^ENTRY CANCEL FAILED/);
    assert.match(failed.error ?? "", /cancel it on Binance manually/);
    const alerts = errors.mock.calls.map((c) => String(c.arguments[0])).filter((m) => /ALERT/.test(m));
    assert.equal(alerts.filter((m) => /ENTRY CANCEL FAILED/.test(m)).length, 1, "one give-up ALERT");
    assert.equal(alerts.filter((m) => /3 cancels .* unconfirmed/.test(m)).length, 1, "one ALERT at 3");
    assert.equal(wireSells(exchange).length, 1);
  });

// ── case 6: -2011 then not found ────────────────────────────────────────────

test("OD-1 case 6: cancel -2011 then not found on an acknowledged entry -> failed + flag; the exit is not blocked",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    exchange.book.delete(cid);
    exchange.setPrice("111");
    await poll(factory(exchange));
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 0.4);
    const failed = await reload.order(entry.id);
    assert.equal(failed.exitCancelState, "failed");
    assert.match(failed.error ?? "", /^ENTRY CANCEL FAILED/);
    for (let cycle = 0; cycle < 3; cycle += 1) await reconcile(factory(exchange));
    assert.equal(exchange.cancels.length, 1, "failed is final: no retry");
  });

// ── case 7: duplicate and out-of-order snapshots after the close ────────────

test("OD-1 case 7: CANCELED(0.7), then PARTIALLY_FILLED(0.55), then CANCELED(0.7) again after the close -> the race position stays 0.3; nothing reopens",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade, cid } = await closeWithUnknownCancel(account, exchange);
    const snap = (status: "PARTIALLY_FILLED" | "CANCELED", base: number) => ({ exchangeOrderId: `ex-${cid}`,
      clientOrderId: cid, status, executedBaseQuantity: base, executedQuoteQuantity: base * 100,
      averagePrice: 100, simulated: false });
    await applyManualSnapshot(entry.id, snap("PARTIALLY_FILLED", 0.55));
    near((await racePositions(account))[0]!.quantity, 0.15);
    await applyManualSnapshot(entry.id, snap("PARTIALLY_FILLED", 0.55));
    await applyManualSnapshot(entry.id, snap("PARTIALLY_FILLED", 0.5));
    near((await racePositions(account))[0]!.quantity, 0.15, "duplicate / older: no change");
    await applyManualSnapshot(entry.id, snap("CANCELED", 0.7));
    await applyManualSnapshot(entry.id, snap("PARTIALLY_FILLED", 0.55));
    await applyManualSnapshot(entry.id, snap("CANCELED", 0.7));
    const race = await racePositions(account);
    assert.equal(race.length, 1);
    near(race[0]!.quantity, 0.3);
    assert.equal((await reload.trade(trade.id)).status, "closed");
    near((await reload.trade(trade.id)).quantity, 0.4);
    assert.equal((await reload.order(entry.id)).status, "canceled");
  });

// ── case 8: fees (X7) ───────────────────────────────────────────────────────

test("OD-1 case 8 / X7: a gross race fill (trades lookup failed) is corrected to the netted 0.2997 and the sweep waits for it",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.3996", buyCommissionRate: 0.001 });
    // The first 0.4 gross was booked netted (0.3996). A numeric exchange id, as
    // Binance's: the trades lookup is by order id.
    const { entry, trade, cid } = await workingEntry(account, exchange,
      { filled: 0.4, base: 0.3996, exchangeOrderId: "700001" });
    exchange.scriptCancel({ error: binanceError("Execution status unknown.", -1007) });
    exchange.setPrice("111");
    const failing = fakeLookupFailures(exchange, 2);
    await poll(factory(exchange));
    failing.restore();
    assert.equal((await reload.trade(trade.id)).status, "closed");
    near(Number(wireSells(exchange)[0]!.executedQty), 0.3996);
    exchange.setPrice("100");

    // The remainder fills to 0.7 gross and the order is cancelled; the trades lookup fails.
    exchange.fill(cid, "0.7", "70", "CANCELED");
    exchange.setMyTradesFails(true);
    await reconcile(factory(exchange));
    const gross = await racePositions(account);
    assert.equal(gross.length, 1);
    near(gross[0]!.quantity, 0.3004, "booked gross");
    assert.equal((await reload.order(entry.id)).fillsNetted, false);

    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 1, "no sweep from a gross figure");

    exchange.setMyTradesFails(false);
    await poll(factory(exchange));
    const netted = await reload.order(entry.id);
    assert.equal(netted.fillsNetted, true);
    near(netted.filledBaseQty, 0.6993);
    assert.equal(netted.status, "canceled", "a netting correction keeps the terminal status");
    assert.equal(wireSells(exchange).length, 2);
    near(Number(wireSells(exchange)[1]!.executedQty), 0.2997, "the sweep sells the netted figure");
    const swept = await reload.trade(gross[0]!.id);
    assert.equal(swept.status, "closed");
  });

test("OD-1 case 8 / X7: netting that never confirms -> after 3 lookups the sweep sells 0.1% less, with a note",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", buyCommissionRate: 0.001 });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7", "70", "CANCELED");
    exchange.setMyTradesFails(true);
    await reconcile(factory(exchange));
    const race = await racePositions(account);
    near(race[0]!.quantity, 0.3);
    await poll(factory(exchange));
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 1, "two cycles of waiting");
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2);
    near(Number(wireSells(exchange)[1]!.executedQty), 0.2997);
    const sweep = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: race[0]!.id } });
    assert.match(sweep.error ?? "", /^NETTING UNCONFIRMED/);
    assert.equal((await reload.trade(race[0]!.id)).status, "closed");
  });

test("OD-1 case 8: commission paid in BNB is not netted from the base, so the sweep does not wait",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", buyCommissionRate: 0.001, commissionAsset: "BNB" });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7", "70", "CANCELED");
    await reconcile(factory(exchange));
    near((await racePositions(account))[0]!.quantity, 0.3);
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2);
    near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
  });

// ── case 9: dust and lot size ───────────────────────────────────────────────

test("OD-1 case 9: a race fill below the lot minimum is dust-closed, with no sweep order", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const { cid } = await closeWithUnknownCancel(account, exchange);
  exchange.fill(cid, "0.40004", "40.004", "CANCELED");
  await reconcile(factory(exchange));
  const race = await racePositions(account);
  near(race[0]!.quantity, 0.00004);
  await poll(factory(exchange));
  assert.equal(wireSells(exchange).length, 1, "no sweep order for dust");
  const closed = await reload.trade(race[0]!.id);
  assert.equal(closed.status, "closed");
  assert.equal(closed.closedReason, "dust_below_exchange_minimum");
});

test("OD-1 case 9: a race fill of 0.3004 with step 0.001 sweeps 0.300 and closes the 0.0004 as noted dust",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", stepSize: "0.001", minQty: "0.001" });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7004", "70.04", "CANCELED");
    await reconcile(factory(exchange));
    const race = await racePositions(account);
    near(race[0]!.quantity, 0.3004);
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2);
    near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
    const closed = await reload.trade(race[0]!.id);
    assert.equal(closed.status, "closed");
    const sweep = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: race[0]!.id } });
    assert.match(sweep.error ?? "", /DUST/);
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2);
  });

// ── case 10: untracked surplus and drift ────────────────────────────────────

test("OD-1 case 10: with 5 untracked coins the sweep sells only the race fill; a wallet below tracked is refused and alerted",
  async () => {
    const errors = quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.4" });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7", "70", "CANCELED");
    await reconcile(factory(exchange));
    await poll(factory(exchange));
    near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
    near(exchange.wallet.free, 5, "the untracked 5 are untouched (I3)");

    const shortAccount = await createAccount();
    const short = fakeBinance({ freeBase: "0.4" });
    const fixture = await closeWithUnknownCancel(shortAccount, short);
    short.fill(fixture.cid, "0.7", "70", "CANCELED");
    await reconcile(factory(short));
    short.wallet.free = 0.1; // an external sell: the wallet holds less than tracked
    for (let cycle = 0; cycle < 3; cycle += 1) await poll(factory(short));
    assert.equal(wireSells(short).length, 1, "drift: never sells another holding");
    const race = await racePositions(shortAccount);
    assert.equal(race[0]!.status, "active");
    assert.ok(errors.mock.calls.some((c) => /ALERT: BTCUSDT position .* race fill awaiting its sweep/
      .test(String(c.arguments[0]))));
  });

// ── case 11: uncertain sweep ────────────────────────────────────────────────

test("OD-1 case 11: an uncertain sweep is queried, never resent (reused id accepted after FILLED) — exactly one sweep",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", reuseAfterFill: true });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7", "70", "CANCELED");
    await reconcile(factory(exchange));
    const race = await racePositions(account);
    // The sweep is accepted, the caller sees -1007, and the recovery lookup fails.
    const sweepFailure = { accepted: true, error: binanceError("Execution status unknown.", -1007) };
    (exchange as unknown as { submissions: unknown[] }).submissions.length = 0;
    const orderFailures = exchange.client as unknown as { order: (p: Record<string, unknown>) => Promise<unknown> };
    const originalOrder = orderFailures.order;
    let scripted = true;
    orderFailures.order = async (payload) => {
      if (scripted) {
        scripted = false;
        await originalOrder(payload);
        throw sweepFailure.error;
      }
      return originalOrder(payload);
    };
    const failing = fakeLookupFailures(exchange, 1);
    await poll(factory(exchange));
    failing.restore();
    const pending = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: race[0]!.id } });
    assert.equal(pending.status, "submitted");
    await poll(factory(exchange));
    await reconcile(factory(exchange));
    await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2, "exactly one sweep reached the exchange");
    assert.equal((await reload.trade(race[0]!.id)).status, "closed");
    near(exchange.wallet.free, 0);
  });

test("OD-1 case 11: a sweep ABSENT after 60 s re-arms as attempt 2; after 3 attempts the position is handed to the operator (SWEEP FAILED)",
  async () => {
    const errors = quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4", orderFailures: [] });
    const { entry, cid } = await closeWithUnknownCancel(account, exchange);
    exchange.fill(cid, "0.7", "70", "CANCELED");
    await reconcile(factory(exchange));
    const race = (await racePositions(account))[0]!;
    // Every sweep SELL is answered "unknown" and never actually placed.
    const client = exchange.client as unknown as { order: (p: Record<string, unknown>) => Promise<unknown> };
    const placed: string[] = [];
    client.order = async (payload) => {
      placed.push(String(payload.newClientOrderId));
      throw binanceError("Execution status unknown.", -1007);
    };
    let now = Date.now();
    for (let cycle = 0; cycle < 8; cycle += 1) {
      now += 61_000;
      await poll(factory(exchange), { now });
    }
    assert.deepEqual(placed, [1, 2, 3].map((n) => binance.clientOrderId(`manual-sweep-${race.id}#${n}`)),
      "three attempts, each under its own deterministic id");
    const handed = await reload.trade(race.id);
    assert.equal(handed.status, "active");
    assert.equal(handed.protectionState, "late_fill_unprotected", "no longer swept");
    assert.match((await reload.order(entry.id)).error ?? "", /^SWEEP FAILED.*sell 0\.3 BTC from the Trade panel/);
    assert.equal(errors.mock.calls.filter((c) => /ALERT: SWEEP FAILED/.test(String(c.arguments[0]))).length, 1);
    for (let cycle = 0; cycle < 2; cycle += 1) await poll(factory(exchange), { now: now += 61_000 });
    assert.equal(placed.length, 3);
  });

// ── case 12: the manual full SELL (numeric) and a partial SELL ──────────────

test("OD-1 case 12: a manual full SELL (quantity = position) cancels once and sells the race delta in the same order, flagged RACE FILL",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    exchange.fillBeforeCancel({ executedQty: "0.55", quote: "55" });
    const sell = await submitManualOrder({ requestId: "od1-full-sell", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id }, factory(exchange));
    assert.deepEqual(exchange.cancels, [cid], "one cancel");
    assert.equal(wireSells(exchange).length, 1, "one SELL");
    near(sell.filledBaseQty, 0.55, "raised by the race delta only");
    assert.match(sell.error ?? "", /^RACE FILL: 0\.15 BTC .*0\.4 asked, 0\.55 sold/);
    assert.equal((await reload.trade(trade.id)).status, "closed");
    const after = await reload.order(entry.id);
    assert.equal(after.status, "canceled");
    assert.equal(after.exitOrigin, "operator");
    assert.equal((await racePositions(account)).length, 0);
    assert.equal(lock.heldLockCount(), 0, "X4 lock released");
  });

test("OD-1 case 12: a partial manual SELL never cancels; the entry keeps working and a later fill adds to the active position",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    const sell = await submitManualOrder({ requestId: "od1-partial-sell", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", baseQuantity: 0.2, positionId: trade.id }, factory(exchange));
    near(sell.filledBaseQty, 0.2);
    assert.match(sell.error ?? "", /^ENTRY STILL WORKING \(partial exit\)/);
    assert.equal(exchange.cancels.length, 0);
    const working = await reload.order(entry.id);
    assert.equal(working.status, "partially_filled");
    assert.equal(working.exitCancelState, null, "the policy is not engaged by a partial exit");
    exchange.fill(cid, "0.7", "70", "PARTIALLY_FILLED");
    await reconcile(factory(exchange));
    const active = await reload.trade(trade.id);
    assert.equal(active.status, "active");
    near(active.quantity, 0.5);
    assert.equal(active.protectionState, "active");
  });

test("OD-1 case 12: an over-request is refused before any cancel is issued", async () => {
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const { trade } = await workingEntry(account, exchange);
  const refusal = await submitManualOrder({ requestId: "od1-over", accountId: account.id, symbol: "BTCUSDT",
    side: "SELL", orderType: "MARKET", baseQuantity: 4, positionId: trade.id }, factory(exchange))
    .then(() => null, (error: unknown) => error);
  assert.ok(refusal instanceof manual.ManualTradingError);
  assert.equal(exchange.cancels.length, 0);
  assert.equal(exchange.submissions.length, 0);
  assert.equal(lock.heldLockCount(), 0);
});

// ── case 13: concurrency ────────────────────────────────────────────────────

test("OD-1 case 13 / X4: while the poller holds the trade lock, a manual full SELL is refused 409 trade_closing — no cancel, no order",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { trade } = await workingEntry(account, exchange);
    assert.ok(lock.acquireTradeClose(trade.id), "the poller holds it");
    try {
      const refusal = await submitManualOrder({ requestId: "od1-contended", accountId: account.id,
        symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id },
      factory(exchange)).then(() => null, (error: unknown) => error);
      assert.ok(refusal instanceof manual.ManualTradingError);
      assert.equal(refusal.httpStatus, 409);
      assert.equal(refusal.code, "trade_closing");
      assert.equal(exchange.cancels.length, 0);
      assert.equal(exchange.submissions.length, 0);
    } finally {
      lock.releaseTradeClose(trade.id);
    }
    assert.equal((await reload.trade(trade.id)).status, "active");
    // Racing for real: whichever takes the lock first exits; the other is
    // refused (409) or skips. One exit between them, and no lock leaks.
    exchange.setPrice("111");
    const [manualSell] = await Promise.allSettled([
      submitManualOrder({ requestId: "od1-racer", accountId: account.id, symbol: "BTCUSDT", side: "SELL",
        orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id }, factory(exchange)),
      poll(factory(exchange)),
    ]);
    if (manualSell.status === "rejected") {
      assert.equal((manualSell.reason as { code?: string }).code, "trade_closing");
    }
    assert.equal(wireSells(exchange).length, 1, "one exit between them");
    assert.equal((await reload.trade(trade.id)).status, "closed");
    assert.equal(lock.heldLockCount(), 0);
  });

test("OD-1 case 13: two finalizers at once (boot + interval) issue at most one cancel and book the race fill once",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { cid } = await closeWithUnknownCancel(account, exchange);
    const cancelsBefore = exchange.cancels.length;
    exchange.fill(cid, "0.55", "55", "PARTIALLY_FILLED");
    const results = await Promise.allSettled([reconcile(factory(exchange)), reconcile(factory(exchange))]);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.equal(exchange.cancels.length - cancelsBefore, 1, "one effective cancel");
    const race = await racePositions(account);
    assert.equal(race.length, 1);
    near(race[0]!.quantity, 0.15);
  });

// ── case 14: restart ────────────────────────────────────────────────────────

function restart(spec: Record<string, unknown>): { submissions: number; lookups: number } {
  const output = execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/restartBoot.ts",
    JSON.stringify(spec)], { cwd: backendRoot, env: process.env, encoding: "utf8" });
  return JSON.parse(output.trim().split("\n").at(-1)!) as { submissions: number; lookups: number };
}

test("OD-1 case 14: a crash after the finalizer's cancel was sent: the boot reconcile queries CANCELED, books the race fill, and exactly one sweep follows",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, cid } = await closeWithUnknownCancel(account, exchange);
    assert.equal((await reload.order(entry.id)).exitCancelState, "unknown");
    await prisma.$disconnect();
    const restarted = restart({ price: "100", freeBase: "0.3", runProtection: true, book: [
      { clientOrderId: cid, orderId: `ex-${cid}`, side: "BUY", type: "LIMIT", status: "CANCELED",
        executedQty: "0.7", cummulativeQuoteQty: "70" }] });
    assert.equal(restarted.submissions, 1, "exactly one sweep");
    const race = await racePositions(account);
    assert.equal(race.length, 1);
    near(race[0]!.quantity, 0.3);
    assert.equal(race[0]!.status, "closed");
    assert.equal((await reload.order(entry.id)).exitCancelState, "done");
  });

test("OD-1 case 14: a crash after the sweep was marked submitted: the restarted process only queries", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const { cid } = await closeWithUnknownCancel(account, exchange);
  exchange.fill(cid, "0.7", "70", "CANCELED");
  await reconcile(factory(exchange));
  const race = (await racePositions(account))[0]!;
  const client = exchange.client as unknown as { order: (p: Record<string, unknown>) => Promise<unknown> };
  const originalOrder = client.order;
  client.order = async (payload) => {
    await originalOrder(payload);
    throw binanceError("Execution status unknown.", -1007);
  };
  const failing = fakeLookupFailures(exchange, 1);
  await poll(factory(exchange));
  failing.restore();
  const sweep = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: race.id } });
  assert.equal(sweep.status, "submitted");
  await prisma.$disconnect();
  const restarted = restart({ price: "100", freeBase: "0", runProtection: true, book: [
    { clientOrderId: sweep.clientOrderId, side: "SELL", type: "MARKET", status: "FILLED",
      executedQty: "0.3", cummulativeQuoteQty: "30" }] });
  assert.equal(restarted.submissions, 0, "query-only after a restart");
  assert.equal((await reload.trade(race.id)).status, "closed");
});

// ── case 15: halt (and the operator's own sweep) ────────────────────────────

test("OD-1 case 15: halted -> the cancel still runs; an automation sweep is held (and reported) until resume, then goes out once",
  async () => {
    quiet();
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, cid } = await closeWithUnknownCancel(account, exchange);
    await risk.setBotTradingHalted(true, { by: "operator", reason: "od1 test" });
    exchange.fill(cid, "0.7", "70", "PARTIALLY_FILLED");
    const cancelsBefore = exchange.cancels.length;
    await reconcile(factory(exchange));
    assert.equal(exchange.cancels.length - cancelsBefore, 1, "the finalizer's cancel runs while halted");
    assert.equal((await reload.order(entry.id)).status, "canceled");
    const race = await racePositions(account);
    near(race[0]!.quantity, 0.3);
    for (let cycle = 0; cycle < 2; cycle += 1) await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 1, "held while halted");
    const state = await manual.listManualState() as { protection: { sweepNote?: string } };
    assert.match(state.protection.sweepNote ?? "", /race fill awaiting sweep — Bot halted; sell it from the Trade panel/);

    const resumed = await risk.resumeBotTrading();
    assert.ok(resumed.ok);
    for (let cycle = 0; cycle < 2; cycle += 1) await poll(factory(exchange));
    assert.equal(wireSells(exchange).length, 2, "out once on resume");
    near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
  });

test("OD-1 case 15: the remainder of an operator's own full SELL is still swept while halted", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const { entry, trade, cid } = await workingEntry(account, exchange);
  exchange.scriptCancel({ error: binanceError("Execution status unknown.", -1007) });
  // The SELL's refresh, its post-cancel fallback and the inline finalizer all fail to read.
  const failing = fakeLookupFailures(exchange, 3);
  await risk.setBotTradingHalted(true, { by: "operator", reason: "od1 test" });
  const sell = await submitManualOrder({ requestId: "od1-halted-full", accountId: account.id, symbol: "BTCUSDT",
    side: "SELL", orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id }, factory(exchange));
  failing.restore();
  assert.equal(sell.status, "filled", "an operator SELL is never blocked by the halt");
  assert.equal((await reload.order(entry.id)).exitOrigin, "operator");
  exchange.fill(cid, "0.7", "70", "CANCELED");
  await reconcile(factory(exchange));
  await poll(factory(exchange));
  assert.equal(wireSells(exchange).length, 2);
  near(Number(wireSells(exchange)[1]!.executedQty), 0.3);
  const sweep = await prisma.manualOrder.findFirstOrThrow({ where: {
    linkedPositionId: (await racePositions(account))[0]!.id } });
  assert.equal(manual.manualOrderOrigin({ side: "SELL", protectionState: "sweep" }), "operator");
  assert.equal(sweep.requestId.startsWith("manual-sweep-"), true);
});

// ── case 16: dry run ────────────────────────────────────────────────────────

test("OD-1 case 16: under DRY_RUN a simulated entry is cancelled locally (its fills kept); a live entry is never cancelled by simulation (A1)",
  async () => {
    quiet();
    const account = await createAccount();
    // The drift guard reads the wallet even in dry run (pre-existing), so it holds the coins.
    const exchange = fakeBinance({ freeBase: "1" });
    const dry = await workingEntry(account, exchange, { exchangeOrderId: "dry-od1-sim" });
    exchange.setPrice("111");
    await poll(factory(exchange, true));
    const canceled = await reload.order(dry.entry.id);
    assert.equal(canceled.status, "canceled");
    near(canceled.filledBaseQty, 0.4, "its recorded fills are kept");
    assert.equal(canceled.exitCancelState, "done");
    assert.equal((await reload.trade(dry.trade.id)).status, "closed");
    assert.equal(exchange.cancels.length, 0, "no exchange cancel in dry run");

    const liveAccount = await createAccount();
    const live = await workingEntry(liveAccount, exchange, { exchangeOrderId: "987654321" });
    await poll(factory(exchange, true));
    const still = await reload.order(live.entry.id);
    assert.equal(still.status, "partially_filled", "still working: no fabricated cancel");
    assert.equal(still.exchangeOrderId, "987654321");
    assert.equal(still.exitCancelState, "pending", "the cancel stays owed");
    assert.match(still.exitCancelLastError ?? "", /DRY_RUN is on/);
    assert.equal(exchange.cancels.length, 0);
    const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: live.trade.id } });
    assert.match(exit.error ?? "", /^ENTRY CANCEL PENDING: DRY_RUN is on/);
  });

// ── /state carries the new fields ───────────────────────────────────────────

test("OD-1 /state: entries carry exitCancelState / exitOrigin and positions carry race_fill_sweep", async () => {
  quiet();
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const { entry, cid } = await closeWithUnknownCancel(account, exchange);
  exchange.fill(cid, "0.7", "70", "CANCELED");
  await reconcile(factory(exchange));
  const state = await manual.listManualState() as {
    orders: { id: string; exitCancelState: string | null; exitOrigin: string | null }[];
    positions: { protectionState: string | null }[] };
  const row = state.orders.find((o) => o.id === entry.id)!;
  assert.equal(row.exitCancelState, "done");
  assert.equal(row.exitOrigin, "automation");
  assert.ok(state.positions.some((p) => p.protectionState === "race_fill_sweep"));
});
