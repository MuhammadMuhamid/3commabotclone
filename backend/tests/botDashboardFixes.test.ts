/**
 * WS-BOTCMD contract §8 — demonstrated Bot dashboard defects, red first.
 *
 *   0.3  re-halting over a daily-loss latch replaced it with an operator halt,
 *        so the next resume skipped the daily-loss re-check;
 *   U3   the dashboard Close / Partial on a MANUAL position answered "this
 *        trade's bot was deleted, close the position directly on Binance" —
 *        advice that corrupts the manual ledger — and the deleted-bot copy
 *        told the operator to sell outside the ledger too;
 *   0.7  deleting a bot with an open trade or an unresolved order intent
 *        orphaned it: the TP/SL monitor skips bot-less trades and neither
 *        Close nor Partial can reach them;
 *   U5   an exchange account created without an explicit `testnet` flag
 *        silently became a MAINNET account.
 *
 * The routers are mounted on a loopback-only express app without the JWT
 * guard (that guard is index.ts's, not the router's). No exchange is
 * contacted: nothing here reaches an order path.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".bot-dashboard-fixes-test.db");
process.env.DATABASE_URL = "file:./tests/.bot-dashboard-fixes-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { prisma } = await import("../src/lib/prisma.js");
const { operationsRouter } = await import("../src/routes/operations.js");
const { tradesRouter } = await import("../src/routes/trades.js");
const { botsRouter } = await import("../src/routes/bots.js");
const { exchangeRouter } = await import("../src/routes/exchange.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { getBotRiskLimits, setBotTradingHalted } = await import("../src/services/riskControls.js");

let server: Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/ops", operationsRouter);
  app.use("/api/trades", tradesRouter);
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
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.webhookLog.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

async function call(method: string, urlPath: string, body?: unknown):
Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

let seq = 0;
async function createBot(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.signalBot.create({ data: {
    name: `fixture bot ${seq}`, webhookSecret: `${"s".repeat(38)}${String(seq).padStart(2, "0")}`,
    pairs: JSON.stringify(["BTCUSDT"]), ...overrides,
  } as Parameters<typeof prisma.signalBot.create>[0]["data"] });
}

async function createTrade(data: Record<string, unknown>) {
  return prisma.smartTrade.create({ data: {
    pair: "BTCUSDT", status: "active", entryPrice: 100, buyPrice: 100, currentPrice: 100,
    quantity: 1, quoteSpent: 100, ...data,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

// ── 0.3: a halt never overwrites an existing halt ───────────────────────────

test("0.3: re-halting over a daily-loss latch keeps the latch, and resume still re-checks the loss", async () => {
  await prisma.riskControl.create({ data: { id: "global", maxDailyLossQuote: 10 } });
  // A realised loss of 20 inside the window: the limit of 10 is still breached.
  await createTrade({ status: "closed", pnlUsdt: -20, closedAt: new Date(), botName: "gone" });
  await setBotTradingHalted(true, { by: "daily_loss", reason: "rolling loss 20 reached 10" });

  const halt = await call("POST", "/api/ops/halt", { confirmation: "HALT_TRADING", reason: "operator check" });
  assert.equal(halt.status, 200);
  assert.equal(halt.body.alreadyHalted, true, "an existing halt is reported, not replaced");

  const limits = await getBotRiskLimits();
  assert.equal(limits.haltedBy, "daily_loss", "the daily-loss latch must survive a second halt");
  assert.equal(limits.haltedReason, "rolling loss 20 reached 10");

  const resume = await call("POST", "/api/ops/resume", { confirmation: "RESUME_TRADING" });
  assert.equal(resume.status, 409, "resume must still re-check the breached daily loss");
  assert.equal(resume.body.code, "still_breached");
  assert.equal((await getBotRiskLimits()).tradingHalted, true);
});

test("0.3: a first halt still halts, as an operator halt", async () => {
  const halt = await call("POST", "/api/ops/halt", { confirmation: "HALT_TRADING", reason: "first halt" });
  assert.equal(halt.status, 200);
  assert.equal(halt.body.halted, true);
  assert.equal(halt.body.alreadyHalted, false);
  const limits = await getBotRiskLimits();
  assert.equal(limits.tradingHalted, true);
  assert.equal(limits.haltedBy, "operator");
  assert.equal(limits.haltedReason, "first halt");
});

// ── U3: manual positions are Trading Scene's, and nobody is told "Binance" ──

for (const route of ["close", "partial-close"] as const) {
  test(`U3: dashboard ${route} on a MANUAL position answers 409 trade_manual, pointing to Trading Scene`, async () => {
    const trade = await createTrade({ source: "manual", botName: "Manual" });
    const response = await call("POST", `/api/trades/${trade.id}/${route}`,
      route === "partial-close" ? { pct: 25 } : undefined);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "trade_manual");
    assert.match(String(response.body.error), /Trading Scene/);
    assert.match(String(response.body.error), /Trade panel/);
    assert.doesNotMatch(String(response.body.error), /Binance/,
      "selling outside the ledger breaks the manual ledger and its TP/SL");
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).status, "active");
  });

  test(`U3: dashboard ${route} on a strategy trade whose bot was deleted no longer says "close on Binance"`, async () => {
    const trade = await createTrade({ source: "strategy", botName: "deleted bot" });
    const response = await call("POST", `/api/trades/${trade.id}/${route}`,
      route === "partial-close" ? { pct: 25 } : undefined);
    assert.equal(response.status, 422);
    assert.equal(response.body.code, "bot_deleted");
    assert.doesNotMatch(String(response.body.error), /on Binance/);
  });
}

// ── 0.7: deleting a bot never orphans an open trade or an unresolved intent ─

test("0.7: deleting a bot that has an active trade is refused, and the trade stays linked", async () => {
  const bot = await createBot();
  const trade = await createTrade({ botId: bot.id, botName: bot.name });
  const response = await call("DELETE", `/api/bots/${bot.id}`);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "bot_has_open_trades");
  assert.ok(await prisma.signalBot.findUnique({ where: { id: bot.id } }), "the bot must still exist");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).botId, bot.id);
});

test("0.7: deleting a bot that has an unresolved order intent is refused", async () => {
  const bot = await createBot();
  await prisma.strategyOrderIntent.create({ data: {
    sourceKey: `fixture:${bot.id}:buy`, clientOrderId: `fixture-${bot.id}`.slice(0, 36),
    botId: bot.id, botName: bot.name, symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 10,
    status: "submitted",
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
  const response = await call("DELETE", `/api/bots/${bot.id}`);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "bot_has_unresolved_intents");
  assert.ok(await prisma.signalBot.findUnique({ where: { id: bot.id } }));
});

test("0.7: a bot with only closed trades can still be deleted, and its history is kept", async () => {
  const bot = await createBot();
  const closed = await createTrade({ botId: bot.id, botName: bot.name, status: "closed", closedAt: new Date() });
  const response = await call("DELETE", `/api/bots/${bot.id}`);
  assert.equal(response.status, 204);
  assert.equal(await prisma.signalBot.findUnique({ where: { id: bot.id } }), null);
  const kept = await prisma.smartTrade.findUniqueOrThrow({ where: { id: closed.id } });
  assert.equal(kept.botId, null);
  assert.equal(kept.botName, bot.name);
});

test("0.7: deleting an unknown bot is 404, not a hang", async () => {
  const response = await call("DELETE", "/api/bots/00000000-0000-4000-8000-0000000000dd");
  assert.equal(response.status, 404);
});

// ── U5: no silent mainnet ───────────────────────────────────────────────────

test("U5: an exchange account without an explicit testnet boolean is refused, and nothing is stored", async () => {
  const response = await call("POST", "/api/exchange-accounts",
    { name: "no flag", apiKey: "fixture-key", apiSecret: "fixture-secret" });
  assert.equal(response.status, 400);
  assert.equal(await prisma.exchangeAccount.count(), 0, "no account may default to mainnet");
});

test("U5: an explicit testnet flag is honoured either way", async () => {
  const testnet = await call("POST", "/api/exchange-accounts",
    { name: "testnet", apiKey: "fixture-key", apiSecret: "fixture-secret", testnet: true });
  assert.equal(testnet.status, 201);
  assert.equal(testnet.body.testnet, true);
  // Slice 2: mainnet also needs the typed confirmation, now verified by the server
  // (botAdminGuards.test.ts covers its refusal).
  const mainnet = await call("POST", "/api/exchange-accounts",
    { name: "mainnet", apiKey: "fixture-key", apiSecret: "fixture-secret", testnet: false,
      mainnetConfirmation: "MAINNET" });
  assert.equal(mainnet.status, 201);
  assert.equal(mainnet.body.testnet, false);
  // The response never carries key material.
  assert.equal(JSON.stringify(mainnet.body).includes("fixture-secret"), false);
});

// ── U4: Reveal serves what EditBot actually renders ─────────────────────────

test("U4: Reveal returns the exit payload with the secret, and no entry payload", async () => {
  const bot = await createBot();
  const masked = await call("GET", `/api/bots/${bot.id}`);
  assert.equal(masked.body.secretRevealed, false);
  assert.equal(masked.body.exitWebhookJson, undefined);
  const revealed = await call("GET", `/api/bots/${bot.id}?reveal=1`);
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.secretRevealed, true);
  assert.equal(revealed.body.webhookSecret, bot.webhookSecret);
  assert.equal((revealed.body.exitWebhookJson as { secret?: string }).secret, bot.webhookSecret);
  assert.equal(revealed.body.entryWebhookJson, undefined,
    "direct TradingView BUYs are disabled; there is no entry payload to reveal");
});
