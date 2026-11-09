/**
 * D1 — a manual LIMIT entry that is still working when its position exits.
 *
 * The invariants hold under the owner's policy, OD-1 option C (cancel the
 * working entry first, then sweep a race fill — see od1CancelFirstSweep.test.ts).
 * The tests that pinned the interim rule (a late fill became an unprotected
 * position the operator had to sell) were flipped to option C on 2026-11-09:
 *
 *   I1  a closed trade is never reactivated by an entry snapshot;
 *   I2  snapshots apply as monotonic deltas (duplicates/reorders change nothing);
 *   I3  a protection exit never sells more than the position's own remaining
 *       quantity, nor more than the free balance left after other tracked positions;
 *   I4  a late BUY fill on a closed trade is flagged, unprotected, sellable, and
 *       a late SELL fill on a closed position is flagged rather than dropped;
 *   I5  an entry still working after its trade exited is flagged;
 *   I6  a protection exit is `submitted` before the wire and queried before any
 *       resubmission;
 *   I7  a remainder below the exchange minimum closes as dust;
 *   I8  before a TP/SL or full manual exit, a working entry is refreshed (now:
 *       cancelled) first.
 *
 * Real services + disposable SQLite + the in-memory fake exchange. No network.
 */
import { after, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, ManualOrder, SmartTrade } from "@prisma/client";
import { binanceError, fakeBinance, type FakeBinance } from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".d1-latefill-test.db");
process.env.DATABASE_URL = "file:./tests/.d1-latefill-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { checkManualProtection } = await import("../src/services/manualProtection.js");

const { applyManualSnapshot, submitManualOrder, cancelManualOrder } = manual;
const reconcileManual = manual.reconcilePendingManualOrders as unknown as
  (factory: unknown, limit?: number, options?: { now?: number }) => Promise<void>;

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
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.partialClose.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.manualCommand.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
async function createAccount(): Promise<ExchangeAccount> {
  seq += 1;
  return prisma.exchangeAccount.create({ data: { name: `d1-${seq}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}

function factory(exchange: FakeBinance) {
  return (account: ExchangeAccount) =>
    new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
}

/** A protected LIMIT BUY of 1.0 @ 100 whose first 0.4 has filled: the D1 starting point. */
async function workingEntry(account: ExchangeAccount, exchange: FakeBinance,
  opts: { symbol?: string; filled?: number; tp?: number | null; sl?: number | null } = {}) {
  seq += 1;
  const cid = `d1-entry-${seq}`;
  const filled = opts.filled ?? 0.4;
  const entry = await prisma.manualOrder.create({ data: {
    requestId: `d1-entry-request-${seq}`, exchangeAccountId: account.id, symbol: opts.symbol ?? "BTCUSDT",
    side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100, limitPrice: 100,
    takeProfitPrice: opts.tp === undefined ? 110 : opts.tp, stopLossPrice: opts.sl === undefined ? 90 : opts.sl,
    protectionType: "bot-managed", protectionState: "pending_entry", status: "open",
    clientOrderId: cid, exchangeOrderId: `ex-${cid}`, submittedAt: new Date() } });
  exchange.seed({ clientOrderId: cid, orderId: `ex-${cid}`, side: "BUY", type: "LIMIT",
    status: "PARTIALLY_FILLED", executedQty: String(filled), cummulativeQuoteQty: String(filled * 100) });
  await applyManualSnapshot(entry.id, { exchangeOrderId: `ex-${cid}`, clientOrderId: cid,
    status: "PARTIALLY_FILLED", executedBaseQuantity: filled, executedQuoteQuantity: filled * 100,
    averagePrice: 100, simulated: false });
  const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
  return { entry, trade, cid };
}

const reload = {
  trade: (id: string) => prisma.smartTrade.findUniqueOrThrow({ where: { id } }),
  order: (id: string) => prisma.manualOrder.findUniqueOrThrow({ where: { id } }),
};

function latePositions(account: ExchangeAccount): Promise<SmartTrade[]> {
  return prisma.smartTrade.findMany({ where: { exchangeAccountId: account.id, source: "manual",
    manualOrderId: null, clientOrderId: { contains: ":late:" } }, orderBy: { createdAt: "asc" } });
}

function wireSells(exchange: FakeBinance) {
  return exchange.accepted("SELL");
}

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// ── I1 / I4: the audit's D1, inverted (option C) ────────────────────────────

const unknownCancel = () => ({ error: binanceError("Execution status unknown.", -1007) });

for (const leg of [
  { name: "TP", price: "111", reason: "manual_take_profit" },
  { name: "SL", price: "89", reason: "manual_stop_loss" },
]) {
  test(`D1 partial -> ${leg.name} exit -> TRUE late fill (the pre-cancel's outcome was unknown): the closed trade stays closed and the late 0.6 is its own race-fill position, swept (option C)`,
    async (t) => {
      t.mock.method(console, "error", () => undefined);
      const account = await createAccount();
      // The pre-cancel is unknown and both reads after it fail, so the exit
      // sells what is known and the late fill is learned only afterwards.
      const exchange = fakeBinance({ freeBase: "0.4", cancelFailures: [unknownCancel()],
        lookupFailures: [new Error("socket hang up"), new Error("socket hang up")] });
      const { entry, trade, cid } = await workingEntry(account, exchange);
      exchange.setPrice(leg.price);
      await checkManualProtection(factory(exchange));
      const closed = await reload.trade(trade.id);
      assert.equal(closed.status, "closed");
      assert.equal(closed.closedReason, leg.reason);
      assert.equal(wireSells(exchange).length, 1);
      near(Number(wireSells(exchange)[0]!.executedQty), 0.4);

      // The remainder fills AFTER the exit (the price came back to the limit).
      exchange.setPrice("100");
      exchange.fill(cid, "1", "100", "FILLED");
      await reconcileManual(factory(exchange));

      const after = await reload.trade(trade.id);
      assert.equal(after.status, "closed", "I1: never reactivated");
      near(after.quantity, 0.4);
      assert.equal(after.closedReason, leg.reason);

      const late = await latePositions(account);
      assert.equal(late.length, 1, "the late quantity is its own position");
      assert.equal(late[0]!.status, "active");
      near(late[0]!.quantity, 0.6);
      assert.equal(late[0]!.manualTpPrice, null, "no TP/SL is silently attached");
      assert.equal(late[0]!.manualSlPrice, null);
      assert.equal(late[0]!.protectionState, "race_fill_sweep", "option C: swept, not left to the operator");

      const flagged = await reload.order(entry.id);
      assert.equal(flagged.status, "filled");
      assert.match(flagged.error ?? "", /^RACE FILL/);
      assert.match(flagged.error ?? "", /no TP\/SL/);
      near(after.quantity + late[0]!.quantity, flagged.filledBaseQty);

      // Option C: the poller sells it (sweep), whatever the price does.
      exchange.setPrice(leg.price);
      await checkManualProtection(factory(exchange));
      assert.equal(wireSells(exchange).length, 2);
      near(Number(wireSells(exchange)[1]!.executedQty), 0.6);
      const swept = await reload.trade(late[0]!.id);
      assert.equal(swept.status, "closed");
      assert.equal(swept.closedReason, "entry_race_fill_swept");
      assert.equal((await reload.trade(trade.id)).status, "closed");
    });
}

test("D1 a legacy late-fill position (interim rule, before OD-1) stays unprotected, unswept and exitable by a manual SELL",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.6", price: "111" });
    const late = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
      botName: "Manual (late fill)", pair: "BTCUSDT", status: "active", quantity: 0.6, quoteSpent: 60,
      clientOrderId: "legacy-entry:late:1", protectionState: "late_fill_unprotected" } });
    await checkManualProtection(factory(exchange));
    assert.equal(wireSells(exchange).length, 0, "nothing auto-sells a legacy late fill");
    const sell = await submitManualOrder({ requestId: "d1-late-sell-legacy", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 0.6, positionId: late.id },
    factory(exchange));
    assert.equal(sell.status, "filled");
    assert.equal((await reload.trade(late.id)).status, "closed");
  });

// ── I1 / I2 / I5: the unchanged snapshot re-read after the exit ─────────────

test("D1 the reconciler re-reading an unchanged partial after a TP exit resurrects nothing, and the entry is now CANCELLED (option C), not flagged",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    await reconcileManual(factory(exchange));
    await checkManualProtection(factory(exchange));
    await reconcileManual(factory(exchange));

    const after = await reload.trade(trade.id);
    assert.equal(after.status, "closed");
    near(after.quantity, 0.4);
    assert.equal((await latePositions(account)).length, 0, "no fill, no late position");
    assert.equal(wireSells(exchange).length, 1);

    const canceled = await reload.order(entry.id);
    assert.equal(canceled.status, "canceled", "cancelled before the exit");
    assert.equal(canceled.exitCancelState, "done");
    assert.equal(canceled.error, null, "nothing left working, nothing to flag");
    assert.equal(exchange.cancels.length, 1);

    // Nothing is left for the operator's cancel route to cancel.
    const refusal = await cancelManualOrder(entry.id, undefined, factory(exchange))
      .then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof manual.ManualTradingError);
    assert.equal(refusal.httpStatus, 409);
    assert.equal((await reload.trade(trade.id)).status, "closed");
  });

// ── I8: refresh before exit (the stale-snapshot variant) ────────────────────

test("D1/I8 snapshot says 0.4 but the exchange has 1.0 filled: the SL exit sells the refreshed 1.0, no late flag",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "1" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    // The rest filled at the exchange before the stop; our stored snapshot is stale.
    exchange.fill(cid, "1", "100", "FILLED");
    exchange.setPrice("89");
    await checkManualProtection(factory(exchange));

    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "manual_stop_loss");
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 1);
    const refreshed = await reload.order(entry.id);
    assert.equal(refreshed.status, "filled");
    assert.doesNotMatch(refreshed.error ?? "", /LATE FILL/);

    await reconcileManual(factory(exchange));
    assert.equal((await reload.trade(trade.id)).status, "closed");
    assert.equal((await latePositions(account)).length, 0);
  });

test("D1/I8 a failed entry refresh never blocks protection: the exit uses the known quantity and is flagged",
  async (t) => {
    t.mock.method(console, "error", () => undefined);
    const account = await createAccount();
    // Option C: the refresh is the fallback of a pre-cancel that did not settle the entry.
    const exchange = fakeBinance({ freeBase: "0.4", cancelFailures: [unknownCancel()],
      lookupFailures: [new Error("socket hang up")] });
    const { trade } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    assert.equal((await reload.trade(trade.id)).status, "closed");
    const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: trade.id } });
    assert.match(exit.error ?? "", /ENTRY REFRESH FAILED/);
  });

// ── fill during cancellation (option C) ─────────────────────────────────────

test("D1 a fill that lands during the pre-exit cancel is sold by the same TP exit (option C), not left as a late fill",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade } = await workingEntry(account, exchange);
    exchange.fillBeforeCancel({ executedQty: "0.7", quote: "70" });
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 0.7);
    assert.equal((await reload.trade(trade.id)).status, "closed");
    assert.equal((await latePositions(account)).length, 0);
    const canceled = await reload.order(entry.id);
    assert.equal(canceled.status, "canceled");
    assert.match(canceled.error ?? "", /^RACE FILL/);
  });

test("D1 cancel -2011 because the fill won before the exit: the FILLED answer is sold by the exit (option C)",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "1" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    exchange.fill(cid, "1", "100", "FILLED");
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    assert.equal((await reload.order(entry.id)).status, "filled");
    near(Number(wireSells(exchange)[0]!.executedQty), 1);
    assert.equal((await reload.trade(trade.id)).status, "closed");
    assert.equal((await latePositions(account)).length, 0);
  });

test("D1 cancel rejected (-2011, then not found): the pre-cancel flags it without blocking the exit; the operator route still answers a coded refusal",
  async (t) => {
    t.mock.method(console, "error", () => undefined);
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    exchange.book.delete(cid);
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    assert.equal((await reload.trade(trade.id)).status, "closed", "the exit was not blocked");
    const flagged = await reload.order(entry.id);
    assert.equal(flagged.exitCancelState, "failed");
    assert.match(flagged.error ?? "", /^ENTRY CANCEL FAILED/);
    const refusal = await cancelManualOrder(entry.id, undefined, factory(exchange))
      .then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof manual.ManualTradingError);
    assert.equal((refusal as unknown as { code?: string }).code, "order_not_found_at_exchange");
    assert.equal((await reload.order(entry.id)).status, "partially_filled");
    assert.equal((await reload.trade(trade.id)).status, "closed");
  });

// ── I2: duplicate and reordered snapshots ───────────────────────────────────

function snap(cid: string, status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED", base: number,
  quote: number) {
  return { exchangeOrderId: `ex-${cid}`, clientOrderId: cid, status, executedBaseQuantity: base,
    executedQuoteQuantity: quote, averagePrice: base > 0 ? quote / base : null, simulated: false };
}

test("D1/I2 duplicate, reordered and corrective snapshots change only what is new", async () => {
  const account = await createAccount();
  const exchange = fakeBinance();
  const { entry, trade, cid } = await workingEntry(account, exchange);

  await applyManualSnapshot(entry.id, snap(cid, "PARTIALLY_FILLED", 0.4, 40));
  near((await reload.trade(trade.id)).quantity, 0.4);

  // A partial exit while the entry is still working must not be undone.
  const exit = await prisma.manualOrder.create({ data: { requestId: "d1-partial-exit",
    exchangeAccountId: account.id, linkedPositionId: trade.id, symbol: "BTCUSDT", side: "SELL",
    orderType: "MARKET", quantityType: "base", requestedBaseQty: 0.2, clientOrderId: "d1-partial-exit",
    status: "submitted" } });
  await applyManualSnapshot(exit.id, snap("d1-partial-exit", "FILLED", 0.2, 22));
  near((await reload.trade(trade.id)).quantity, 0.2);
  await applyManualSnapshot(entry.id, snap(cid, "PARTIALLY_FILLED", 0.4, 40));
  near((await reload.trade(trade.id)).quantity, 0.2);

  // Base-asset commission corrected by a later trades lookup: equal quote, lower base.
  await applyManualSnapshot(entry.id, snap(cid, "PARTIALLY_FILLED", 0.3996, 40));
  near((await reload.trade(trade.id)).quantity, 0.1996);
  // The uncorrected gross figure arriving again (trades lookup failed) is not new.
  await applyManualSnapshot(entry.id, snap(cid, "PARTIALLY_FILLED", 0.4, 40));
  near((await reload.trade(trade.id)).quantity, 0.1996);

  // The remainder fills: only the new 0.6 is added.
  await applyManualSnapshot(entry.id, snap(cid, "FILLED", 0.9996, 100));
  near((await reload.trade(trade.id)).quantity, 0.7996);
  // An older answer after the terminal one changes nothing.
  await applyManualSnapshot(entry.id, snap(cid, "PARTIALLY_FILLED", 0.4, 40));
  await applyManualSnapshot(entry.id, snap(cid, "CANCELED", 0.4, 40));
  near((await reload.trade(trade.id)).quantity, 0.7996);
  assert.equal((await reload.order(entry.id)).status, "filled");
});

// ── isolation ───────────────────────────────────────────────────────────────

test("D1 account and symbol isolation: a late fill on account A touches nothing on B or on ETHUSDT",
  async (t) => {
    t.mock.method(console, "error", () => undefined);
    const accountA = await createAccount();
    const accountB = await createAccount();
    // A's pre-cancel is unknown and its reads fail, so the late fill is learned after the close.
    const exchangeA = fakeBinance({ freeBase: "0.4", cancelFailures: [unknownCancel()],
      lookupFailures: [new Error("socket hang up"), new Error("socket hang up")] });
    const exchangeB = fakeBinance({ freeBase: "1" });
    const { trade: tradeA, cid } = await workingEntry(accountA, exchangeA);
    const tradeB = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: accountB.id,
      botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
      manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
    const eth = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: accountA.id,
      botName: "Manual", pair: "ETHUSDT", status: "active", quantity: 2, quoteSpent: 200 } });
    // A strategy bot on env credentials may be the same Binance account, but the
    // Bot cannot know that: it is not counted (documented isolation limit).
    const envBot = await prisma.signalBot.create({ data: { name: "env", webhookSecret: "e".repeat(40),
      pairs: JSON.stringify(["BTCUSDT"]) } });
    await prisma.smartTrade.create({ data: { botId: envBot.id, botName: "env", pair: "BTCUSDT",
      status: "active", quantity: 5, quoteSpent: 500 } });

    exchangeA.setPrice("111");
    exchangeB.setPrice("111");
    await checkManualProtection((account) => new BinanceManualExchange(account,
      { client: account.id === accountA.id ? exchangeA.client : exchangeB.client, dryRun: false }));
    exchangeA.fill(cid, "1", "100", "FILLED");
    await reconcileManual((account: ExchangeAccount) => new BinanceManualExchange(account,
      { client: account.id === accountA.id ? exchangeA.client : exchangeB.client, dryRun: false }));

    assert.equal((await reload.trade(tradeA.id)).status, "closed");
    near(Number(wireSells(exchangeA)[0]!.executedQty), 0.4);
    assert.equal((await reload.trade(tradeB.id)).status, "closed");
    near(Number(wireSells(exchangeB)[0]!.executedQty), 1);
    assert.equal((await latePositions(accountB)).length, 0);
    const ethAfter = await reload.trade(eth.id);
    assert.equal(ethAfter.status, "active");
    assert.equal(ethAfter.quantity, 2);
    assert.equal((await latePositions(accountA)).filter((t) => t.pair === "BTCUSDT").length, 1);
  });

// ── I7: fee in the base asset leaves dust ───────────────────────────────────

test("D1/I7 a net-of-fee quantity leaves a sub-minimum remainder: closed as dust, never re-attempted",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.3996", stepSize: "0.001", minQty: "0.001" });
    const entry = await prisma.manualOrder.create({ data: {
      requestId: "d1-dust-entry", exchangeAccountId: account.id, symbol: "BTCUSDT", side: "BUY",
      orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 40, limitPrice: 100,
      takeProfitPrice: 110, protectionType: "bot-managed", protectionState: "pending_entry",
      status: "open", clientOrderId: "d1-dust-entry", submittedAt: new Date() } });
    // FILLED 0.4 gross; 0.0004 BTC commission netted by the trades lookup.
    exchange.seed({ clientOrderId: entry.clientOrderId, side: "BUY", type: "LIMIT", status: "FILLED",
      executedQty: "0.4", cummulativeQuoteQty: "40" });
    await applyManualSnapshot(entry.id, snap(entry.clientOrderId, "FILLED", 0.3996, 40));
    const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
    exchange.setPrice("111");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await checkManualProtection(factory(exchange));
      await reconcileManual(factory(exchange));
    }
    assert.equal(wireSells(exchange).length, 1, "one exit, no endless below-minimum retries");
    near(Number(wireSells(exchange)[0]!.executedQty), 0.399);
    const closed = await reload.trade(trade.id);
    assert.equal(closed.status, "closed");
    assert.equal(closed.closedReason, "dust_below_exchange_minimum");
    const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: trade.id } });
    assert.match(exit.error ?? "", /DUST/);
  });

// ── manual close while the entry is working (I8 + I5) ───────────────────────

test("D1/I8 + F1 a manual SELL while the entry is working refreshes first but never sells more than asked",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.7" });
    const { entry, trade, cid } = await workingEntry(account, exchange);
    exchange.fill(cid, "0.7", "70", "PARTIALLY_FILLED");
    const sell = await submitManualOrder({ requestId: "d1-manual-close", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 0.4, positionId: trade.id },
    factory(exchange));
    assert.equal(sell.status, "filled");
    near(sell.filledBaseQty, 0.4);
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 0.4);
    // The refreshed remainder stays an active, TP/SL-protected position.
    const remaining = await reload.trade(trade.id);
    assert.equal(remaining.status, "active");
    near(remaining.quantity, 0.3);
    assert.equal(remaining.protectionState, "active");
    assert.equal(remaining.manualTpPrice, 110);
    assert.notEqual((await reload.order(entry.id)).protectionState, "entry_working_after_exit");
    await reconcileManual(factory(exchange));
    near((await reload.trade(trade.id)).quantity, 0.3);
    assert.equal((await latePositions(account)).length, 0);
  });

test("D1/F1 an over-request (4.0 of a 0.4 position) is still refused while the entry is working, with no order",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { trade } = await workingEntry(account, exchange);
    const refusal = await submitManualOrder({ requestId: "d1-over-request", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 4, positionId: trade.id },
    factory(exchange)).then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof manual.ManualTradingError);
    // OD-7 (2026-11-09): the refusal is now a typed 409, not an untyped 422.
    assert.equal(refusal.httpStatus, 409);
    assert.equal(refusal.code, "sell_exceeds_position");
    assert.equal(exchange.cancels.length, 0, "OD-1: refused before any cancel");
    assert.equal(exchange.submissions.length, 0, "nothing reached the exchange");
    assert.equal(await prisma.manualOrder.count({ where: { side: "SELL" } }), 0, "no order was reserved");
    const untouched = await reload.trade(trade.id);
    assert.equal(untouched.status, "active");
    near(untouched.quantity, 0.4);
  });

// ── restart ─────────────────────────────────────────────────────────────────

test("D1 restart: a closed trade whose entry is still partially filled is not resurrected at boot",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "0.4" });
    const { trade, cid } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    await checkManualProtection(factory(exchange));
    assert.equal((await reload.trade(trade.id)).status, "closed");
    await prisma.$disconnect();
    const output = execFileSync(process.execPath, ["--import", "tsx", "tests/helpers/restartBoot.ts",
      JSON.stringify({ price: "111", freeBase: "0", runProtection: true, book: [
        { clientOrderId: cid, side: "BUY", type: "LIMIT", status: "PARTIALLY_FILLED",
          executedQty: "0.4", cummulativeQuoteQty: "40" }] })],
    { cwd: backendRoot, env: process.env, encoding: "utf8" });
    const restarted = JSON.parse(output.trim().split("\n").at(-1)!) as { submissions: number };
    assert.equal(restarted.submissions, 0);
    assert.equal((await reload.trade(trade.id)).status, "closed");
  });

// ── I3: balance mismatch and the phantom-sell loop ──────────────────────────

test("D1/I3 a wallet below the tracked quantity still refuses; a surplus sells only the attributable quantity",
  async () => {
    const account = await createAccount();
    const short = fakeBinance({ price: "111", freeBase: "0.5" });
    const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
      botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
      manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
    await checkManualProtection(factory(short));
    assert.equal(wireSells(short).length, 0, "drift: never sells another holding to cover a shortfall");
    assert.equal((await reload.trade(position.id)).status, "active");

    const surplus = fakeBinance({ price: "111", freeBase: "6" });
    await checkManualProtection(factory(surplus));
    assert.equal(wireSells(surplus).length, 1);
    near(Number(wireSells(surplus)[0]!.executedQty), 1);
    near(surplus.wallet.free, 5);
  });

test("D1/I3 the phantom-sell loop: 3 TP cycles interleaved with 3 reconciles sell the 0.4 exactly once",
  async () => {
    const account = await createAccount();
    // 5 BTC the bot does not track (say, a long-term holding) plus the 0.4.
    const exchange = fakeBinance({ freeBase: "5.4" });
    const { trade } = await workingEntry(account, exchange);
    exchange.setPrice("111");
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await checkManualProtection(factory(exchange));
      await reconcileManual(factory(exchange));
    }
    assert.equal(wireSells(exchange).length, 1);
    near(Number(wireSells(exchange)[0]!.executedQty), 0.4);
    near(exchange.wallet.free, 5);
    assert.equal((await reload.trade(trade.id)).status, "closed");
  });

// ── protection-failure alert ────────────────────────────────────────────────

test("D1 a protection exit that keeps failing is recorded and raises one bounded alert", async (t) => {
  const account = await createAccount();
  const insufficient = () => binanceError("Account has insufficient balance for requested action.", -2010);
  const exchange = fakeBinance({ price: "111", freeBase: "1", orderFailures: [
    { error: insufficient() }, { error: insufficient() }, { error: insufficient() }] });
  const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
    botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
    manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
  const errors = t.mock.method(console, "error", () => undefined);
  for (let cycle = 0; cycle < 3; cycle += 1) await checkManualProtection(factory(exchange));
  const exits: ManualOrder[] = await prisma.manualOrder.findMany({ where: { linkedPositionId: position.id } });
  assert.ok(exits.length >= 1);
  assert.ok(exits.every((exit) => exit.status === "rejected" && /insufficient/.test(exit.error ?? "")),
    "each failed exit is durably recorded as what it was");
  const alerts = errors.mock.calls.filter((call) => /ALERT/.test(String(call.arguments[0])));
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0]!.arguments[0]), /NOT protected/);
  assert.equal((await reload.trade(position.id)).status, "active");
  mock.restoreAll();
});

// ── I6 / R1 ─────────────────────────────────────────────────────────────────

test("D1/I6 an accepted-then-unknown exit is queried, not resubmitted, even where Binance would accept the reused id",
  async () => {
    const account = await createAccount();
    // The immediate recovery lookup also fails, so the first cycle cannot learn the fill.
    const exchange = fakeBinance({ price: "111", freeBase: "6", reuseAfterFill: true, orderFailures: [{
      accepted: true, error: binanceError("Execution status unknown.", -1006) }],
    lookupFailures: [new Error("socket hang up")] });
    const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
      botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
      manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
    await checkManualProtection(factory(exchange));
    const exit = await prisma.manualOrder.findFirstOrThrow({ where: { linkedPositionId: position.id } });
    const statusAfterFirstCycle = exit.status;
    await checkManualProtection(factory(exchange));
    await reconcileManual(factory(exchange));
    assert.equal(wireSells(exchange).length, 1, "exactly one SELL reached the exchange");
    near(exchange.wallet.free, 5);
    assert.equal(statusAfterFirstCycle, "submitted", "the row said `submitted` once the wire was crossed");
    assert.equal((await reload.trade(position.id)).status, "closed");
  });

// ── I4: a late SELL fill on a closed position ───────────────────────────────

test("D1/I4 a SELL that fills after its position closed is flagged, not silently dropped", async (t) => {
  const account = await createAccount();
  const exchange = fakeBinance({ price: "111", freeBase: "1.5" });
  const position = await prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id,
    botName: "Manual", pair: "BTCUSDT", status: "active", quantity: 1, quoteSpent: 100,
    manualTpPrice: 110, protectionType: "bot-managed", protectionState: "active" } });
  const resting = await prisma.manualOrder.create({ data: { requestId: "d1-resting-sell",
    exchangeAccountId: account.id, linkedPositionId: position.id, symbol: "BTCUSDT", side: "SELL",
    orderType: "LIMIT", quantityType: "base", requestedBaseQty: 0.5, limitPrice: 120,
    clientOrderId: "d1-resting-sell", status: "open", submittedAt: new Date() } });
  exchange.seed({ clientOrderId: "d1-resting-sell", side: "SELL", type: "LIMIT", status: "NEW" });
  await checkManualProtection(factory(exchange));
  assert.equal((await reload.trade(position.id)).status, "closed");

  exchange.fill("d1-resting-sell", "0.5", "60", "FILLED");
  const errors = t.mock.method(console, "error", () => undefined);
  await reconcileManual(factory(exchange));
  const late = await reload.order(resting.id);
  assert.equal(late.status, "filled");
  assert.match(late.error ?? "", /LATE SELL FILL/);
  assert.ok(errors.mock.calls.some((call) => /LATE SELL FILL/.test(String(call.arguments[0]))));
  const closed = await reload.trade(position.id);
  assert.equal(closed.status, "closed");
  assert.ok(closed.quantity >= 0);
  mock.restoreAll();
});
