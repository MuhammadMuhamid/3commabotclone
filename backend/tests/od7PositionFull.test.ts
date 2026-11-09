/**
 * OD-7 — no over-sell for a selected position (`manualPositionFull.v1`).
 *
 *   - `positionFull: true` sells ALL that remains of `positionId` — plus a
 *     race fill when its entry is still working (OD-1) — capped by the free
 *     balance attributable to it (I3) and the lot rules; never an untracked
 *     holding;
 *   - it is mutually exclusive with `baseQuantity` (400 at the route, 422 in
 *     the service), SELL-only and needs a `positionId`;
 *   - a `baseQuantity` above the remaining position is a typed 409
 *     `sell_exceeds_position`, with no cancel and no order;
 *   - C0 advertises `manualPositionFull.v1`, so the Platform sends the flag
 *     only to a Bot whose strict schema accepts it.
 *
 * Real services + disposable SQLite + the in-memory fake exchange; the route
 * checks go over loopback HTTP signed exactly as the Platform signs them.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount } from "@prisma/client";
import { fakeBinance, type FakeBinance } from "./helpers/fakeBinance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".od7-position-full-test.db");
process.env.DATABASE_URL = "file:./tests/.od7-position-full-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const { BinanceManualExchange } = await import("../src/services/manualExchange.js");
const manual = await import("../src/services/manualTrading.js");
const { heldLockCount } = await import("../src/lib/tradeCloseLock.js");

type Factory = (account: ExchangeAccount) => InstanceType<typeof BinanceManualExchange>;
const SECRET = "4b7e" + "a".repeat(60);
// Tolerates a build without the seam, so a red run fails per test, not at load.
const seam = (manual as { manualAdapterSeam?: { factory: Factory } }).manualAdapterSeam ?? { factory: null as unknown as Factory };
const defaultFactory = seam.factory;
const original = { dryRun: config.dryRun, manual: config.manualTradingEnabled, secret: config.manualTradingHmacSecret };
config.manualTradingHmacSecret = SECRET;

let server: Server;
let baseUrl = "";
before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config, { dryRun: original.dryRun, manualTradingEnabled: original.manual,
    manualTradingHmacSecret: original.secret });
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  config.dryRun = false;
  config.manualTradingEnabled = true;
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.manualCommand.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
  seam.factory = defaultFactory;
});

let seq = 0;
async function createAccount(): Promise<ExchangeAccount> {
  seq += 1;
  return prisma.exchangeAccount.create({ data: { name: `od7-${seq}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}

function factory(exchange: FakeBinance): Factory {
  return (account) => new BinanceManualExchange(account, { client: exchange.client, dryRun: false });
}

async function position(account: ExchangeAccount, quantity: number, extra: Record<string, unknown> = {}) {
  return prisma.smartTrade.create({ data: { source: "manual", exchangeAccountId: account.id, botName: "Manual",
    pair: "BTCUSDT", status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity,
    quoteSpent: quantity * 100, ...extra } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

// ── service ─────────────────────────────────────────────────────────────────

test("OD-7: positionFull sells exactly the selected position, never the untracked surplus; the lock is released",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "5.7" }); // 0.7 tracked + 5 untracked
    const target = await position(account, 0.7);
    const sell = await manual.submitManualOrder({ requestId: "od7-full", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange));
    assert.equal(sell.status, "filled");
    near(sell.filledBaseQty, 0.7);
    near(sell.requestedBaseQty ?? 0, 0.7);
    near(exchange.wallet.free, 5);
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: target.id } })).status, "closed");
    assert.equal(heldLockCount(), 0);
  });

test("OD-7: positionFull is capped by the free balance attributable to the position (I3)", async () => {
  const account = await createAccount();
  // Another tracked position in the same asset holds 0.5 of the 0.9 free.
  const exchange = fakeBinance({ freeBase: "0.9" });
  await position(account, 0.5, { pair: "BTCUSDC" });
  const target = await position(account, 0.7);
  const sell = await manual.submitManualOrder({ requestId: "od7-capped", accountId: account.id, symbol: "BTCUSDT",
    side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange));
  near(sell.filledBaseQty, 0.4);
  near(exchange.wallet.free, 0.5, "the other position's coins are untouched");
  const remaining = await prisma.smartTrade.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(remaining.status, "active");
  near(remaining.quantity, 0.3);
});

test("OD-7 + OD-1: positionFull with a working entry cancels it first and also sells the race fill", async () => {
  const account = await createAccount();
  const exchange = fakeBinance({ freeBase: "0.4" });
  const entry = await prisma.manualOrder.create({ data: { requestId: "od7-entry", exchangeAccountId: account.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "LIMIT", quantityType: "quote", requestedQuoteQty: 100,
    limitPrice: 100, takeProfitPrice: 110, protectionType: "bot-managed", protectionState: "pending_entry",
    status: "open", clientOrderId: "od7-entry-cid", exchangeOrderId: "ex-od7", submittedAt: new Date() } });
  exchange.seed({ clientOrderId: "od7-entry-cid", orderId: "ex-od7", status: "PARTIALLY_FILLED",
    executedQty: "0.4", cummulativeQuoteQty: "40" });
  await manual.applyManualSnapshot(entry.id, { exchangeOrderId: "ex-od7", clientOrderId: "od7-entry-cid",
    status: "PARTIALLY_FILLED", executedBaseQuantity: 0.4, executedQuoteQuantity: 40, averagePrice: 100,
    simulated: false });
  const trade = await prisma.smartTrade.findUniqueOrThrow({ where: { manualOrderId: entry.id } });
  exchange.fillBeforeCancel({ executedQty: "0.6", quote: "60" });
  const sell = await manual.submitManualOrder({ requestId: "od7-full-race", accountId: account.id,
    symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", positionFull: true, positionId: trade.id },
  factory(exchange));
  assert.deepEqual(exchange.cancels, ["od7-entry-cid"]);
  near(sell.filledBaseQty, 0.6);
  assert.match(sell.error ?? "", /^RACE FILL: 0\.2 BTC/);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "closed");
  assert.equal((await prisma.manualOrder.findUniqueOrThrow({ where: { id: entry.id } })).status, "canceled");
});

test("OD-7: a baseQuantity above the remaining position is a typed 409 sell_exceeds_position, with no cancel and no order",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance({ freeBase: "10" });
    const target = await position(account, 0.4);
    const refusal = await manual.submitManualOrder({ requestId: "od7-over", accountId: account.id,
      symbol: "BTCUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 0.41, positionId: target.id },
    factory(exchange)).then(() => null, (error: unknown) => error);
    assert.ok(refusal instanceof manual.ManualTradingError);
    assert.equal(refusal.httpStatus, 409);
    assert.equal(refusal.code, "sell_exceeds_position");
    assert.match(refusal.message, /remaining 0\.4/);
    assert.equal(exchange.submissions.length, 0);
    assert.equal(exchange.cancels.length, 0);
    assert.equal(await prisma.manualOrder.count(), 0);
  });

test("OD-7: the service refuses a malformed positionFull (with a quantity, on a BUY, without a position) and a vanished position",
  async () => {
    const account = await createAccount();
    const exchange = fakeBinance();
    const target = await position(account, 0.4);
    const bad = [
      { side: "SELL" as const, positionFull: true as const, positionId: target.id, baseQuantity: 0.4 },
      { side: "BUY" as const, positionFull: true as const, positionId: target.id, quoteQuantity: 10 },
      { side: "SELL" as const, positionFull: true as const },
    ];
    for (const [i, extra] of bad.entries()) {
      const refusal = await manual.submitManualOrder({ requestId: `od7-bad-${i}`, accountId: account.id,
        symbol: "BTCUSDT", orderType: "MARKET", ...extra }, factory(exchange))
        .then(() => null, (error: unknown) => error);
      assert.ok(refusal instanceof manual.ManualTradingError, JSON.stringify(extra));
      assert.equal(refusal.code, "invalid_position_full");
    }
    await prisma.smartTrade.update({ where: { id: target.id }, data: { status: "closed" } });
    const gone = await manual.submitManualOrder({ requestId: "od7-gone", accountId: account.id, symbol: "BTCUSDT",
      side: "SELL", orderType: "MARKET", positionFull: true, positionId: target.id }, factory(exchange))
      .then(() => null, (error: unknown) => error);
    assert.ok(gone instanceof manual.ManualTradingError);
    assert.equal(gone.httpStatus, 422);
    assert.equal(exchange.submissions.length, 0);
  });

// ── route ───────────────────────────────────────────────────────────────────

async function signedPost(p: string, body: unknown) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = `od7_${Date.now().toString(36)}_${(seq++).toString().padStart(6, "0")}`;
  const canonical = ["POST", canonicalPath(p), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  const response = await fetch(`${baseUrl}${p}`, { method: "POST", body: JSON.stringify(body), headers: {
    "content-type": "application/json", "x-manual-timestamp": timestamp, "x-manual-nonce": nonce,
    "x-manual-request-id": requestId,
    "x-manual-signature": `v1=${createHmac("sha256", SECRET).update(canonical).digest("hex")}`,
  } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test("OD-7 route: positionFull is accepted only as `true` on a SELL with a positionId and no quantity", async () => {
  const account = await createAccount();
  const target = await position(account, 0.4);
  const base = { accountId: account.id, symbol: "BTCUSDT", orderType: "MARKET" };
  for (const body of [
    { ...base, side: "SELL", positionFull: true, positionId: target.id, baseQuantity: 0.4 },
    { ...base, side: "SELL", positionFull: true },
    { ...base, side: "BUY", positionFull: true, positionId: target.id, quoteQuantity: 10 },
    { ...base, side: "SELL", positionFull: false, positionId: target.id, baseQuantity: 0.4 },
  ]) {
    const r = await signedPost("/api/manual-trading/orders", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.manualOrder.count(), 0);
  // The well-formed request reaches the service and sells the whole position.
  const exchange = fakeBinance({ freeBase: "0.4" });
  seam.factory = factory(exchange);
  const ok = await signedPost("/api/manual-trading/orders",
    { ...base, side: "SELL", positionFull: true, positionId: target.id });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  near(Number(ok.body.filledBaseQty), 0.4);
});

test("OD-7 route: an over-sell reaches the Platform as 409 {code: sell_exceeds_position}", async () => {
  const exchange = fakeBinance({ freeBase: "10" });
  seam.factory = factory(exchange);
  const account = await createAccount();
  const target = await position(account, 0.4);
  const r = await signedPost("/api/manual-trading/orders", { accountId: account.id, symbol: "BTCUSDT",
    side: "SELL", orderType: "MARKET", baseQuantity: 1, positionId: target.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sell_exceeds_position");
  assert.equal(exchange.submissions.length, 0);
});

test("OD-7: C0 advertises manualPositionFull.v1", async () => {
  const { readControlStatus } = await import("../src/routes/manualControl.js");
  const status = await readControlStatus();
  assert.ok(status.capabilities.includes("manualPositionFull.v1"));
  assert.ok(status.capabilities.includes("entries.v1"));
});
