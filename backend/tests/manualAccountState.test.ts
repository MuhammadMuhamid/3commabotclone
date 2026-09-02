/**
 * The bounded account reading the trading ticket asks for.
 *
 * It exists so an operator can size an order against reality instead of
 * learning the balance from a Binance rejection. Everything below is about
 * keeping it BOUNDED: one symbol, two assets, no credential, no write, and no
 * authority over what actually executes.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".account-state-test.db");
process.env.DATABASE_URL = "file:./tests/.account-state-test.db";
for (const file of [testDb, `${testDb}-journal`]) fs.rmSync(file, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { prisma } = await import("../src/lib/prisma.js");
const { readManualAccountState } = await import("../src/services/manualAccountState.js");
const { ManualTradingError } = await import("../src/services/manualTrading.js");

after(async () => {
  await prisma.$disconnect();
  for (const file of [testDb, `${testDb}-journal`]) fs.rmSync(file, { force: true });
});

const calls: string[] = [];
function fakeClient() {
  return {
    accountInfo: async () => {
      calls.push("accountInfo");
      return { balances: [
        { asset: "USDT", free: "60.86", locked: "10" },
        { asset: "APT", free: "12.3456789", locked: "2" },
        { asset: "BTC", free: "1", locked: "0" },
      ] };
    },
    exchangeInfo: async ({ symbol }: { symbol: string }) => {
      calls.push(`exchangeInfo:${symbol}`);
      return { symbols: [{ baseAsset: "APT", quoteAsset: "USDT", filters: [
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.01" },
        { filterType: "PRICE_FILTER", tickSize: "0.0001" },
        { filterType: "NOTIONAL", minNotional: "5" },
      ] }] };
    },
  } as never;
}

async function account(testnet = true) {
  return prisma.exchangeAccount.create({ data: { name: `acct-${Math.random()}`,
    exchange: "binance", marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused",
    testnet } });
}

test("it returns free and locked for exactly the two assets of the symbol", async () => {
  const acct = await account();
  const state = await readManualAccountState(
    { accountId: acct.id, symbol: "APTUSDT" }, fakeClient);
  assert.deepEqual(state.base, { asset: "APT", free: 12.3456789, locked: 2 });
  assert.deepEqual(state.quote, { asset: "USDT", free: 60.86, locked: 10 });
  // The account also holds BTC. It is not this symbol's business.
  assert.deepEqual(Object.keys(state).sort(),
    ["base", "quote", "rules", "simulated", "symbol"]);
  assert.equal(JSON.stringify(state).includes("BTC"), false,
    "an unrelated asset must not leak into a per-symbol reading");
});

test("it carries the exchange's own size and price rules", async () => {
  const acct = await account();
  const state = await readManualAccountState(
    { accountId: acct.id, symbol: "aptusdt" }, fakeClient);
  assert.equal(state.symbol, "APTUSDT");
  assert.deepEqual(state.rules,
    { lotStep: 0.001, minQty: 0.01, priceTick: 0.0001, minNotional: 5 });
});

test("an asset the account does not hold reads as zero, not as missing", async () => {
  const acct = await account();
  const state = await readManualAccountState({ accountId: acct.id, symbol: "ETHUSDT" },
    () => ({
      accountInfo: async () => ({ balances: [{ asset: "USDT", free: "1", locked: "0" }] }),
      exchangeInfo: async () => ({ symbols: [{ filters: [] }] }),
    }) as never);
  assert.deepEqual(state.base, { asset: "ETH", free: 0, locked: 0 });
  assert.deepEqual(state.rules, { lotStep: 0, minQty: 0, priceTick: 0, minNotional: 0 });
});

test("it says whether the reading came from a simulated account", async () => {
  const testnet = await readManualAccountState(
    { accountId: (await account(true)).id, symbol: "APTUSDT" }, fakeClient);
  const mainnet = await readManualAccountState(
    { accountId: (await account(false)).id, symbol: "APTUSDT" }, fakeClient);
  assert.equal(testnet.simulated, true);
  assert.equal(mainnet.simulated, false);
});

test("an unknown account and an unsupported symbol both fail closed", async () => {
  await assert.rejects(
    () => readManualAccountState(
      { accountId: "00000000-0000-4000-8000-000000000000", symbol: "APTUSDT" }, fakeClient),
    (e: unknown) => e instanceof ManualTradingError && e.httpStatus === 404);
  const acct = await account();
  await assert.rejects(
    () => readManualAccountState({ accountId: acct.id, symbol: "APTGBP" }, fakeClient),
    (e: unknown) => e instanceof ManualTradingError && e.httpStatus === 422);
});

test("it reads and never writes: two calls, both queries, and no order among them", async () => {
  calls.length = 0;
  const acct = await account();
  await readManualAccountState({ accountId: acct.id, symbol: "APTUSDT" }, fakeClient);
  assert.deepEqual(calls, ["accountInfo", "exchangeInfo:APTUSDT"]);

  const source = fs.readFileSync(
    path.join(backendRoot, "src", "services", "manualAccountState.ts"), "utf8");
  for (const forbidden of ["client.order(", "marketBuyQuote", "marketSellBase", "prisma.manualOrder",
    ".create(", ".update(", ".upsert(", ".delete("]) {
    assert.equal(source.includes(forbidden), false,
      `the account reading must not be able to ${forbidden}`);
  }
});

test("no credential or key material can reach the caller", async () => {
  const acct = await account();
  const state = await readManualAccountState(
    { accountId: acct.id, symbol: "APTUSDT" }, fakeClient);
  const body = JSON.stringify(state);
  for (const secret of ["apiKey", "apiSecret", "Enc", acct.apiKeyEnc, acct.apiSecretEnc]) {
    assert.equal(body.includes(secret), false, `${secret} leaked into the reading`);
  }
  assert.equal(body.includes(acct.id), false, "the account id is the caller's own input, not output");
});

test("the route is behind the Platform HMAC, like every other manual command", () => {
  const routes = fs.readFileSync(
    path.join(backendRoot, "src", "routes", "manualTrading.ts"), "utf8");
  assert.match(routes, /manualTradingRouter\.use\(requireManualAuth\);/);
  const definition = routes.indexOf('manualTradingRouter.get("/account-state"');
  const guard = routes.indexOf("manualTradingRouter.use(requireManualAuth);");
  assert.ok(guard > -1 && definition > guard,
    "the account reading must be registered under the authenticated router");
});
