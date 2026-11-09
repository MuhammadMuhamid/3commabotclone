/**
 * Slice 2 — the Platform's signed bot and account commands, contract v2.0
 * C10–C16 and C19, plus C0 `capabilities` (B-CAP).
 *
 * Every request goes over loopback HTTP through the real
 * `manualTradingRouter`, signed exactly as the Platform signs it (written out
 * here, not imported: a contract test). Manual trading stays DISABLED: these
 * are control plane. No exchange is contacted; C19 uses an injected client.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { SignalBot } from "@prisma/client";
import type { BinanceClient } from "../src/services/binance.js";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".bot-manage-control-test.db");
process.env.DATABASE_URL = "file:./tests/.bot-manage-control-test.db";
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
const { accountBalanceClient } = await import("../src/services/exchangeAccounts.js");

const CONTROL_SECRET = "5d2a" + "c".repeat(60);
const original = {
  manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret,
};
const originalResolve = accountBalanceClient.resolve;
config.manualTradingEnabled = false;
config.manualTradingHmacSecret = CONTROL_SECRET;

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
  config.manualTradingEnabled = original.manualTradingEnabled;
  config.manualTradingHmacSecret = original.secret;
  accountBalanceClient.resolve = originalResolve;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  accountBalanceClient.resolve = originalResolve;
  await prisma.botControlCommand.deleteMany();
  await prisma.realizationEvent.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── The Platform's signing scheme, written out ──────────────────────────────

let seq = 0;
const newRequestId = () => `mng_${Date.now().toString(36)}_${(seq++).toString().padStart(6, "0")}`;
const ACTOR = {
  platformUserId: "00000000-0000-4000-8000-000000000001",
  stepUp: { method: "totp", at: "2026-11-09T00:00:00.000Z" },
};

async function send(method: "GET" | "POST" | "PATCH", p: string, body?: unknown,
  opts: { requestId?: string; unsigned?: boolean } = {}):
Promise<{ status: number; body: Record<string, unknown>; replayed: boolean; text: string }> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = opts.requestId ?? newRequestId();
  const canonical = [method, canonicalPath(p), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  const signature = `v1=${createHmac("sha256", CONTROL_SECRET).update(canonical).digest("hex")}`;
  const response = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      "content-type": "application/json", "x-manual-timestamp": timestamp, "x-manual-nonce": nonce,
      "x-manual-request-id": requestId, ...(opts.unsigned ? {} : { "x-manual-signature": signature }),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status, text,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    replayed: response.headers.get("x-control-replayed") === "true",
  };
}

const C = "/api/manual-trading/control";
const get = (p: string) => send("GET", `${C}${p}`);
const post = (p: string, body: unknown, requestId?: string) => send("POST", `${C}${p}`, body, { requestId });
const patch = (p: string, body: unknown, requestId?: string) => send("PATCH", `${C}${p}`, body, { requestId });

// ── Fixtures ────────────────────────────────────────────────────────────────

let n = 0;
async function storedBot(over: Partial<SignalBot> = {}): Promise<SignalBot> {
  n += 1;
  return prisma.signalBot.create({ data: {
    name: `managed bot ${n}`, webhookSecret: `m${String(n).padStart(3, "0")}${"w".repeat(44)}`,
    pairs: JSON.stringify(["BTCUSDT", "ETHUSDT"]), ...over,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}
async function account(over: Record<string, unknown> = {}) {
  return prisma.exchangeAccount.create({ data: {
    name: "acct", apiKeyEnc: "ENC-KEY-MATERIAL", apiSecretEnc: "ENC-SECRET-MATERIAL", testnet: true,
    keyHint: "AB12", ...over,
  } as Parameters<typeof prisma.exchangeAccount.create>[0]["data"] });
}
async function activeTrade(bot: SignalBot | null, over: Record<string, unknown> = {}) {
  return prisma.smartTrade.create({ data: {
    botId: bot?.id ?? null, botName: bot?.name ?? "x", pair: "BTCUSDT", status: "active",
    entryPrice: 100, buyPrice: 100, currentPrice: 100, quantity: 1, quoteSpent: 100, ...over,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

const NEW_BOT = {
  name: "From Trading Scene", pairs: ["BTCUSDT"], maxInvestmentPct: 5, maxInvestmentUnit: "pct_bot",
  stopLossEnabled: true, stopLossPct: 3, actor: ACTOR,
};

const VIEW_KEYS = ["activeTrades", "alertType", "createdAt", "direction", "entryEnabled", "entryOrderType",
  "entryVolumePct", "exchangeAccount", "exchangeAccountId", "exitEnabled", "id", "maxActiveSmartTrades",
  "maxActiveSmartTradesEnabled", "maxEntryOrders", "maxInvestmentLabel", "maxInvestmentPct",
  "maxInvestmentUnit", "name", "pairs", "status", "stopLossPct", "takeProfitPct", "unresolvedIntents",
  "updatedAt", "webhookPath", "webhookSecretMasked"];

// ════════════════════════════════════════════════════════════════════════════
// C0 capabilities
// ════════════════════════════════════════════════════════════════════════════

test("B-CAP: C0 lists bots.v1 and accounts.v1, and not enroll.v1 while enrollment is off", async () => {
  const status = await get("/status");
  assert.equal(status.status, 200);
  const caps = status.body.capabilities as string[];
  assert.ok(Array.isArray(caps));
  assert.ok(caps.includes("bots.v1"));
  assert.ok(caps.includes("accounts.v1"));
  assert.equal(caps.includes("enroll.v1"), false);
});

// ════════════════════════════════════════════════════════════════════════════
// C10 create
// ════════════════════════════════════════════════════════════════════════════

test("C10: unsigned is 401 and creates nothing", async () => {
  const response = await send("POST", `${C}/bots`, NEW_BOT, { unsigned: true });
  assert.equal(response.status, 401);
  assert.equal(await prisma.signalBot.count(), 0);
});

test("C10: 201 with the BotConfigView and the secret, live only; the row, C8 and a replay hold secretIssued", async () => {
  const requestId = newRequestId();
  const live = await post("/bots", NEW_BOT, requestId);
  assert.equal(live.status, 201, live.text);
  const secret = String(live.body.webhookSecret);
  assert.match(secret, /^[0-9a-f]{48}$/);
  const bot = live.body.bot as Record<string, unknown>;
  assert.deepEqual(Object.keys(bot).sort(), VIEW_KEYS);
  assert.equal(bot.webhookPath, "/api/webhooks/signal_bots");
  assert.equal(String(bot.webhookSecretMasked).includes(secret), false);
  assert.equal(bot.stopLossPct, 3);
  assert.equal(bot.takeProfitPct, null);

  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(row.kind, "bot_create");
  assert.equal(row.result?.includes(secret), false, "the secret is never at rest in the command table");
  assert.equal(JSON.parse(row.result ?? "{}").secretIssued, true);

  const replay = await post("/bots", NEW_BOT, requestId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 201);
  assert.equal(replay.text.includes(secret), false);
  assert.equal(replay.body.secretIssued, true);
  assert.equal(await prisma.signalBot.count(), 1, "a replay never creates a second bot");

  const c8 = await get(`/commands/${requestId}`);
  assert.equal(c8.text.includes(secret), false);
});

test("C10: strict body, tightened validation and a missing account are typed refusals; nothing is created", async () => {
  assert.equal((await post("/bots", { ...NEW_BOT, webhookSecret: "chosen" })).status, 400);
  const { actor: _actor, ...withoutActor } = NEW_BOT;
  assert.equal((await post("/bots", withoutActor)).status, 400, "actor is required");
  const pct = await post("/bots", { ...NEW_BOT, maxInvestmentPct: 101 });
  assert.equal(pct.status, 400);
  assert.equal(pct.body.code, "invalid_request");
  const pair = await post("/bots", { ...NEW_BOT, pairs: ["BTC_USDT"] });
  assert.equal(pair.status, 400);
  const limit = await post("/bots", { ...NEW_BOT, entryOrderType: "limit" });
  assert.equal(limit.status, 400);
  const unsafe = await post("/bots", { ...NEW_BOT, maxInvestmentPct: 60, stopLossEnabled: false, stopLossPct: null });
  assert.equal(unsafe.status, 400);
  const noAccount = await post("/bots", { ...NEW_BOT, exchangeAccountId: "00000000-0000-4000-8000-0000000000ab" });
  assert.equal(noAccount.status, 404);
  assert.equal(noAccount.body.code, "account_not_found");
  assert.equal(await prisma.signalBot.count(), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// C11 read
// ════════════════════════════════════════════════════════════════════════════

test("C11: the view with counts and a masked secret; 404 and 400 are typed", async () => {
  const acct = await account();
  const bot = await storedBot({ exchangeAccountId: acct.id, takeProfitEnabled: true, takeProfitPct: 4,
    stopLossEnabled: false, stopLossPct: 3, maxInvestmentPct: 2 });
  await activeTrade(bot);
  const response = await get(`/bots/${bot.id}`);
  assert.equal(response.status, 200);
  const view = response.body.bot as Record<string, unknown>;
  assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS);
  assert.equal(view.activeTrades, 1);
  assert.equal(view.takeProfitPct, 4);
  assert.equal(view.stopLossPct, null, "a disabled stop reads as null");
  assert.deepEqual(view.exchangeAccount, { id: acct.id, name: "acct", testnet: true });
  assert.equal(response.text.includes(bot.webhookSecret), false);
  assert.equal(response.text.includes("ENC-"), false);
  const missing = await get("/bots/00000000-0000-4000-8000-0000000000cd");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "bot_not_found");
  assert.equal((await get("/bots/not-a-uuid")).body.code, "invalid_id");
});

// ════════════════════════════════════════════════════════════════════════════
// C12 edit
// ════════════════════════════════════════════════════════════════════════════

test("C12: a partial edit returns the view; an empty patch is refused", async () => {
  const bot = await storedBot();
  const response = await patch(`/bots/${bot.id}`, { name: "Renamed", takeProfitEnabled: true, takeProfitPct: 6,
    actor: ACTOR });
  assert.equal(response.status, 200, response.text);
  const view = response.body.bot as Record<string, unknown>;
  assert.equal(view.name, "Renamed");
  assert.equal(view.takeProfitPct, 6);
  const empty = await patch(`/bots/${bot.id}`, { actor: ACTOR });
  assert.equal(empty.status, 400);
  assert.equal((await patch(`/bots/${bot.id}`, { name: "x", webhookSecret: "y", actor: ACTOR })).status, 400);
});

test("C12 / X5: account change and pair removal under an open trade are refused, with the row unchanged", async () => {
  const a = await account();
  const b = await account({ name: "other" });
  const bot = await storedBot({ exchangeAccountId: a.id });
  await activeTrade(bot);
  const moved = await patch(`/bots/${bot.id}`, { exchangeAccountId: b.id, actor: ACTOR });
  assert.equal(moved.status, 409);
  assert.equal(moved.body.code, "bot_has_open_trades");
  const dropped = await patch(`/bots/${bot.id}`, { pairs: ["ETHUSDT"], actor: ACTOR });
  assert.equal(dropped.status, 409);
  assert.equal(dropped.body.code, "pair_has_open_trades");
  const row = await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } });
  assert.equal(row.exchangeAccountId, a.id);
  assert.deepEqual(JSON.parse(row.pairs), ["BTCUSDT", "ETHUSDT"]);
});

test("C12: a legacy bot stays editable — only changed values meet the tightened rules", async () => {
  const legacy = await storedBot({ name: "N".repeat(90), maxInvestmentPct: 300, entryOrderType: "limit",
    pairs: JSON.stringify(["OLDPAIR"]) });
  const edit = await patch(`/bots/${legacy.id}`, { stopLossPct: 4, actor: ACTOR });
  assert.equal(edit.status, 200, edit.text);
  const raise = await patch(`/bots/${legacy.id}`, { maxInvestmentPct: 301, actor: ACTOR });
  assert.equal(raise.status, 400);
});

// ════════════════════════════════════════════════════════════════════════════
// C13 delete — parity with the dashboard (botDashboardFixes 0.7)
// ════════════════════════════════════════════════════════════════════════════

test("C13: refused with an open trade or an unresolved intent; deletes otherwise; 404 typed", async () => {
  const withTrade = await storedBot();
  await activeTrade(withTrade);
  const refused = await post(`/bots/${withTrade.id}/delete`, { actor: ACTOR });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "bot_has_open_trades");

  const withIntent = await storedBot();
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: "fx:del", clientOrderId: "fx-del-1", botId: withIntent.id, botName: withIntent.name,
    symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 10, status: "requested",
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
  assert.equal((await post(`/bots/${withIntent.id}/delete`, { actor: ACTOR })).body.code,
    "bot_has_unresolved_intents");

  const idle = await storedBot();
  const deleted = await post(`/bots/${idle.id}/delete`, { actor: ACTOR });
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body, { deleted: true });
  assert.equal(await prisma.signalBot.findUnique({ where: { id: idle.id } }), null);
  const gone = await post(`/bots/${idle.id}/delete`, { actor: ACTOR });
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, "bot_not_found");
});

// ════════════════════════════════════════════════════════════════════════════
// C14 rotate
// ════════════════════════════════════════════════════════════════════════════

test("C14: a new secret, live only; the stored result and a replay hold secretIssued; no second rotation", async () => {
  const bot = await storedBot();
  const requestId = newRequestId();
  const live = await post(`/bots/${bot.id}/rotate-secret`, { actor: ACTOR }, requestId);
  assert.equal(live.status, 200, live.text);
  const secret = String(live.body.webhookSecret);
  assert.notEqual(secret, bot.webhookSecret);
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).webhookSecret, secret);
  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(row.result?.includes(secret), false);
  const replay = await post(`/bots/${bot.id}/rotate-secret`, { actor: ACTOR }, requestId);
  assert.equal(replay.replayed, true);
  assert.equal(replay.text.includes(secret), false);
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).webhookSecret, secret,
    "the replay did not rotate again");
});

test("C14 / X6: refused while an exit intent is unresolved", async () => {
  const bot = await storedBot();
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: "fx:rot", clientOrderId: "fx-rot-1", botId: bot.id, botName: bot.name,
    symbol: "BTCUSDT", side: "SELL", requestedBaseQty: 1, status: "submitted",
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
  const refused = await post(`/bots/${bot.id}/rotate-secret`, { actor: ACTOR });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "realizations_pending");
  assert.equal((await prisma.signalBot.findUniqueOrThrow({ where: { id: bot.id } })).webhookSecret, bot.webhookSecret);
});

// ════════════════════════════════════════════════════════════════════════════
// C15 / C16 / C19 accounts
// ════════════════════════════════════════════════════════════════════════════

test("C15: accounts with hint and usage counts, never key material", async () => {
  const acct = await account({ testnet: false, name: "main" });
  const legacy = await account({ keyHint: null, name: "legacy" });
  const bot = await storedBot({ exchangeAccountId: acct.id });
  await activeTrade(bot);                                        // strategy trade, via the bot
  await activeTrade(null, { exchangeAccountId: acct.id, source: "manual" }); // manual position
  const response = await get("/exchange-accounts");
  assert.equal(response.status, 200);
  const accounts = response.body.accounts as Array<Record<string, unknown>>;
  const main = accounts.find((a) => a.id === acct.id)!;
  assert.deepEqual(Object.keys(main).sort(), ["botsUsing", "createdAt", "exchange", "id", "keyHint",
    "marketType", "name", "openTrades", "testnet"]);
  assert.equal(main.keyHint, "AB12");
  assert.equal(main.botsUsing, 1);
  assert.equal(main.openTrades, 2);
  assert.equal(main.testnet, false);
  assert.equal(accounts.find((a) => a.id === legacy.id)!.keyHint, null);
  assert.equal(response.text.includes("ENC-"), false);
});

test("C16: the typed confirmation is required; in use is 409 account_in_use; otherwise deleted", async () => {
  const used = await account();
  await storedBot({ exchangeAccountId: used.id });
  assert.equal((await post(`/exchange-accounts/${used.id}/delete`, { actor: ACTOR })).status, 400);
  const refused = await post(`/exchange-accounts/${used.id}/delete`, { confirmation: "REMOVE_ACCOUNT", actor: ACTOR });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "account_in_use");
  const free = await account();
  const deleted = await post(`/exchange-accounts/${free.id}/delete`, { confirmation: "REMOVE_ACCOUNT", actor: ACTOR });
  assert.deepEqual(deleted.body, { deleted: true });
  assert.equal(await prisma.exchangeAccount.findUnique({ where: { id: free.id } }), null);
});

test("C19: balances are numbers only; an exchange failure is one typed 502 without the exchange's text", async () => {
  const acct = await account();
  accountBalanceClient.resolve = () => ({
    accountInfo: async () => ({ balances: [
      { asset: "USDT", free: "120.5", locked: "4.5" }, { asset: "BTC", free: "0.01", locked: "0" },
      { asset: "DUST", free: "1", locked: "0" },
    ] }),
    prices: async () => ({ BTCUSDT: "50000" }),
  } as unknown as BinanceClient);
  const ok = await get(`/exchange-accounts/${acct.id}/balance`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.usdtFree, 120.5);
  assert.equal(ok.body.totalUsdt, 625);
  assert.deepEqual(ok.body.breakdown, [
    { asset: "USDT", free: 120.5, locked: 4.5, usdt: 125 }, { asset: "BTC", free: 0.01, locked: 0, usdt: 500 },
  ]);
  assert.equal(typeof ok.body.cachedAt, "string");

  accountBalanceClient.resolve = () => ({
    accountInfo: async () => { throw Object.assign(new Error("Invalid API-key, IP, or permissions SECRETTEXT"), { code: -2015 }); },
    prices: async () => ({}),
  } as unknown as BinanceClient);
  const failed = await get(`/exchange-accounts/${acct.id}/balance`);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "exchange_unavailable");
  assert.equal(failed.text.includes("SECRETTEXT"), false);
  assert.equal((await get("/exchange-accounts/00000000-0000-4000-8000-0000000000ef/balance")).status, 404);
});
