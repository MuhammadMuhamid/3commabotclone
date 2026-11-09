/**
 * Slice 2 shared bot/account administration, through the Classic dashboard
 * routes (the Platform's C10–C16 call the same services; see
 * `botManageControl.test.ts`).
 *
 *   MAINNET  the typed mainnet confirmation is verified by the SERVER (it was
 *            browser-only: any other client created a real-money account
 *            with `testnet:false` alone) — parity inventory §5 #10;
 *   X5       an edit can no longer move a bot with open trades to another
 *            account, or drop a pair that still has an open trade;
 *   §5       tightened validation (name, pairs, per-unit investment bounds,
 *            market-only entries, an existing account) on every changed
 *            value, while a previously valid bot stays editable;
 *   merge    `stopLossPct: null` with the stop still enabled is judged as
 *            null (it used to fall back to the stored distance and pass);
 *   X6       rotation refused while realizations are pending under the
 *            current secret.
 *
 * Routers on a loopback app without the JWT guard (that guard is the app's).
 * No exchange is contacted.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { SignalBot } from "@prisma/client";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".bot-admin-guards-test.db");
process.env.DATABASE_URL = "file:./tests/.bot-admin-guards-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { prisma } = await import("../src/lib/prisma.js");
const { botsRouter } = await import("../src/routes/bots.js");
const { exchangeRouter } = await import("../src/routes/exchange.js");
const { errorHandler } = await import("../src/middleware/errors.js");

let server: Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/bots", botsRouter);
  app.use("/api/exchange-accounts", exchangeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  await prisma.realizationEvent.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

async function call(method: string, urlPath: string, body?: unknown):
Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

let seq = 0;
async function storedBot(over: Partial<SignalBot> = {}): Promise<SignalBot> {
  seq += 1;
  return prisma.signalBot.create({ data: {
    name: `bot ${seq}`, webhookSecret: `wh${String(seq).padStart(4, "0")}${"q".repeat(40)}`,
    pairs: JSON.stringify(["BTCUSDT", "ETHUSDT"]), ...over,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function account(testnet = true, name = "acct") {
  return prisma.exchangeAccount.create({ data: { name, apiKeyEnc: "enc", apiSecretEnc: "enc", testnet } });
}

async function activeTrade(bot: SignalBot, pair = "BTCUSDT") {
  return prisma.smartTrade.create({ data: {
    botId: bot.id, botName: bot.name, pair, status: "active", entryPrice: 100, buyPrice: 100,
    currentPrice: 100, quantity: 1, quoteSpent: 100,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

async function intent(bot: SignalBot, over: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.strategyOrderIntent.create({ data: {
    sourceKey: `fixture:${seq}`, clientOrderId: `fixture-${seq}-${bot.id}`.slice(0, 36),
    botId: bot.id, botName: bot.name, symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 10,
    status: "submitted", ...over,
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
}

const validBot = {
  name: "Create me", pairs: ["BTCUSDT"], maxInvestmentPct: 5, maxInvestmentUnit: "pct_bot",
  stopLossEnabled: true, stopLossPct: 3,
};

// ── MAINNET is verified by the server ───────────────────────────────────────

test("MAINNET: testnet:false without the typed confirmation is refused, and nothing is stored", async () => {
  for (const confirmation of [undefined, "", "mainnet", "MAINNET "]) {
    const response = await call("POST", "/api/exchange-accounts", {
      name: "real money", apiKey: "fixture-key-0001", apiSecret: "fixture-secret",
      testnet: false, ...(confirmation === undefined ? {} : { mainnetConfirmation: confirmation }),
    });
    assert.equal(response.status, 400, `confirmation ${JSON.stringify(confirmation)} must be refused`);
    assert.equal(response.body.code, "mainnet_confirmation_required");
  }
  assert.equal(await prisma.exchangeAccount.count(), 0);
});

test("MAINNET: the exact typed confirmation creates the account; the key hint is stored, the key never returned", async () => {
  const response = await call("POST", "/api/exchange-accounts", {
    name: "real money", apiKey: "fixture-key-0001", apiSecret: "fixture-secret",
    testnet: false, mainnetConfirmation: "MAINNET",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.testnet, false);
  assert.equal(JSON.stringify(response.body).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(response.body).includes("fixture-key"), false);
  const stored = await prisma.exchangeAccount.findUniqueOrThrow({ where: { id: String(response.body.id) } });
  assert.equal(stored.keyHint, "0001");
  assert.notEqual(stored.apiKeyEnc, "fixture-key-0001", "stored encrypted");
});

test("testnet accounts need no confirmation", async () => {
  const response = await call("POST", "/api/exchange-accounts",
    { name: "sandbox", apiKey: "k", apiSecret: "s", testnet: true });
  assert.equal(response.status, 201);
});

// ── Account delete: atomic and typed ────────────────────────────────────────

test("account delete: in use is 409 account_in_use and nothing is removed; unused is 204", async () => {
  const used = await account();
  await storedBot({ exchangeAccountId: used.id });
  const refused = await call("DELETE", `/api/exchange-accounts/${used.id}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "account_in_use");
  assert.ok(await prisma.exchangeAccount.findUnique({ where: { id: used.id } }));
  const free = await account();
  assert.equal((await call("DELETE", `/api/exchange-accounts/${free.id}`)).status, 204);
  assert.equal((await call("DELETE", `/api/exchange-accounts/${free.id}`)).status, 404);
});

// ── X5: no account change or pair removal under an open trade ───────────────

test("X5: changing the account of a bot with an active trade is 409 bot_has_open_trades, unchanged", async () => {
  const a = await account();
  const b = await account();
  const bot = await storedBot({ exchangeAccountId: a.id });
  await activeTrade(bot);
  const response = await call("PATCH", `/api/bots/${bot.id}`, { exchangeAccountId: b.id });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "bot_has_open_trades");
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).exchangeAccountId, a.id);
  // Detaching it ("" → none) is a change of account too.
  assert.equal((await call("PATCH", `/api/bots/${bot.id}`, { exchangeAccountId: "" })).status, 409);
});

test("X5: an unresolved intent also blocks an account change", async () => {
  const a = await account();
  const bot = await storedBot();
  await intent(bot);
  const response = await call("PATCH", `/api/bots/${bot.id}`, { exchangeAccountId: a.id });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "bot_has_open_trades");
});

test("X5: with nothing open the account changes; re-sending the same account is not a change", async () => {
  const a = await account();
  const bot = await storedBot({ exchangeAccountId: a.id });
  const same = await call("PATCH", `/api/bots/${bot.id}`, { exchangeAccountId: a.id, name: "renamed" });
  assert.equal(same.status, 200, "an unchanged account is allowed even with trades (none here)");
  await activeTrade(bot);
  const stillSame = await call("PATCH", `/api/bots/${bot.id}`, { exchangeAccountId: a.id, name: "again" });
  assert.equal(stillSame.status, 200, "an open trade does not block an edit that keeps the account");
});

test("X5: removing a pair with an active trade is 409 pair_has_open_trades; removing an idle pair is fine", async () => {
  const bot = await storedBot();
  await activeTrade(bot, "BTCUSDT");
  const refused = await call("PATCH", `/api/bots/${bot.id}`, { pairs: ["ETHUSDT"] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "pair_has_open_trades");
  assert.deepEqual(JSON.parse((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).pairs),
    ["BTCUSDT", "ETHUSDT"]);
  const fine = await call("PATCH", `/api/bots/${bot.id}`, { pairs: ["BTCUSDT"] });
  assert.equal(fine.status, 200);
});

// ── Tightened validation on create ──────────────────────────────────────────

test("§5: create refuses each unsafe or meaningless value with a typed 400", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["blank name", { name: "   " }],
    ["long name", { name: "n".repeat(65) }],
    ["pct over 100", { maxInvestmentPct: 150 }],
    ["usdt over 1e7", { maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 10_000_001 }],
    ["bad pair", { pairs: ["BTC-USD"] }],
    ["non-USDT quote", { pairs: ["ETHBTC"] }],
    ["too many pairs", { pairs: Array.from({ length: 51 }, (_, i) => `C${i}USDT`) }],
    ["limit entries", { entryOrderType: "limit" }],
  ];
  for (const [label, over] of cases) {
    const response = await call("POST", "/api/bots", { ...validBot, ...over });
    assert.equal(response.status, 400, `${label} must be refused`);
    assert.equal(response.body.code, "invalid_request", label);
  }
  const missing = await call("POST", "/api/bots",
    { ...validBot, exchangeAccountId: "00000000-0000-4000-8000-0000000000aa" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "account_not_found");
  assert.equal(await prisma.signalBot.count(), 0);
});

test("§5: create normalises pairs and trims the name; the secret is revealed once in the 201", async () => {
  const response = await call("POST", "/api/bots",
    { ...validBot, name: "  Spaced  ", pairs: ["btc/usdt", "BTCUSDT", "eth/usdc"] });
  assert.equal(response.status, 201);
  assert.equal(response.body.name, "Spaced");
  assert.deepEqual(response.body.pairs, ["BTCUSDT", "ETHUSDC"]);
  assert.match(String(response.body.webhookSecret), /^[0-9a-f]{48}$/);
});

// ── A previously valid bot stays editable ───────────────────────────────────

test("§5: a legacy bot re-sent unchanged by the Classic form still saves; changed values are judged", async () => {
  const legacy = await storedBot({
    name: "L".repeat(80), pairs: JSON.stringify(["WEIRD"]), maxInvestmentPct: 500,
    maxInvestmentUnit: "pct_bot", entryOrderType: "limit", stopLossEnabled: true, stopLossPct: 3,
  });
  const fullForm = {
    name: legacy.name, alertType: "custom", direction: "long", pairs: ["WEIRD"], maxInvestmentPct: 500,
    maxInvestmentUnit: "pct_bot", exchangeAccountId: null, entryEnabled: true, entryVolumePct: 100,
    entryOrderType: "limit", exitEnabled: true, takeProfitEnabled: true, takeProfitPct: 5,
    stopLossEnabled: true, stopLossPct: 3, maxActiveSmartTradesEnabled: false, maxActiveSmartTrades: null,
  };
  const saved = await call("PATCH", `/api/bots/${legacy.id}`, fullForm);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.takeProfitEnabled, true);
  // Each changed value meets the tightened rules.
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { maxInvestmentPct: 400 })).status, 400);
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { pairs: ["WEIRD", "BAD-1"] })).status, 400);
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { pairs: ["WEIRD", "SOLUSDT"] })).status, 200);
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { entryOrderType: "market" })).status, 200);
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { entryOrderType: "limit" })).status, 400);
  assert.equal((await call("PATCH", `/api/bots/${legacy.id}`, { name: "L".repeat(81) })).status, 400);
});

test("merge: setting stopLossPct to null while the stop stays enabled is refused (it used to pass)", async () => {
  const bot = await storedBot({ stopLossEnabled: true, stopLossPct: 3 });
  const response = await call("PATCH", `/api/bots/${bot.id}`, { stopLossPct: null });
  assert.equal(response.status, 400);
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).stopLossPct, 3);
  // Turning the stop off together with its distance stays a legal edit at a small size.
  const off = await call("PATCH", `/api/bots/${bot.id}`, { stopLossEnabled: false, stopLossPct: null });
  assert.equal(off.status, 200);
});

// ── X6: rotation (service; the Classic dashboard has no rotate route) ───────

test("X6: rotation is refused while an exit is unresolved or a realization is pending under the current secret", async () => {
  const { rotateWebhookSecret } = await import("../src/services/botAdmin.js");
  const { platformWebhookIdentity } = await import("../src/contract/realizationEventContract.js");
  const bot = await storedBot();
  const sell = await intent(bot, { side: "SELL", requestedBaseQty: 1, requestedQuoteQty: null });
  await assert.rejects(rotateWebhookSecret(bot.id), { code: "realizations_pending", status: 409 });
  await prisma.strategyOrderIntent.update({ where: { id: sell.id }, data: { status: "reconciled" } });
  await prisma.realizationEvent.create({ data: {
    id: "bot-realization-v1:final:fixture", strategyIntentId: sell.id, kind: "final", eventTime: new Date(),
    payload: JSON.stringify({ platformWebhookIdentity: platformWebhookIdentity(bot.webhookSecret) }),
    payloadSha256: "0",
  } });
  await assert.rejects(rotateWebhookSecret(bot.id), { code: "realizations_pending" });
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).webhookSecret, bot.webhookSecret);
  await prisma.realizationEvent.updateMany({ data: { deliveryStatus: "delivered" } });
  const rotated = await rotateWebhookSecret(bot.id);
  assert.notEqual(rotated.webhookSecret, bot.webhookSecret);
  assert.match(rotated.webhookSecret, /^[0-9a-f]{48}$/);
});
