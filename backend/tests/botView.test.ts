/**
 * The reads behind the Platform's Bot section, over real HTTP against the real
 * router, signed the way the Platform signs them.
 *
 * What matters here: nothing unsigned gets through, a replay is refused, and no
 * secret reaches a response even though the rows sit next to the webhook secret
 * and the encrypted exchange keys.
 *
 * No network. No Binance.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

// Its own database: `node --test` runs files in parallel, and suites sharing a
// SQLite fixture race over it. Chosen before anything constructs Prisma.
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".bot-view-test.db");
process.env.DATABASE_URL = "file:./tests/.bot-view-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes, randomUUID } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");

const SECRET = "7d3e" + "b".repeat(60);
const WEBHOOK_SECRET = "webhook-secret-must-never-leak";
const API_KEY_ENC = "encrypted-api-key-must-never-leak";
const API_SECRET_ENC = "encrypted-api-secret-must-never-leak";

const original = {
  manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret,
};
config.manualTradingEnabled = true;
config.manualTradingHmacSecret = SECRET;

let server: Server;
let baseUrl = "";
let botId = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const account = await prisma.exchangeAccount.create({ data: {
    name: "Testnet account", exchange: "binance", marketType: "spot",
    apiKeyEnc: API_KEY_ENC, apiSecretEnc: API_SECRET_ENC, testnet: true,
  } });
  const bot = await prisma.signalBot.create({ data: {
    name: "Trend bot", pairs: JSON.stringify(["BTCUSDT", "ETHUSDT"]), webhookSecret: WEBHOOK_SECRET,
    exchangeAccountId: account.id,
  } });
  botId = bot.id;
  await prisma.smartTrade.create({ data: {
    botId, botName: bot.name, pair: "BTCUSDT", status: "active", entryPrice: 100, currentPrice: 110,
    quantity: 1, quoteSpent: 100, pnlUsdt: 10, pnlPct: 10, exchangeAccountId: account.id,
  } });
  for (let i = 0; i < 3; i += 1) {
    await prisma.smartTrade.create({ data: {
      botId, botName: bot.name, pair: "ETHUSDT", status: "closed", entryPrice: 50, quantity: 1,
      quoteSpent: 50, pnlUsdt: 2.5, pnlPct: 5, closedAt: new Date(Date.UTC(2026, 9, 1 + i)),
      exchangeOrderId: `order-${i}`, closedReason: "signal",
    } });
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.manualTradingEnabled = original.manualTradingEnabled;
  config.manualTradingHmacSecret = original.secret;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

function signedHeaders(method: string, urlPath: string, secret = SECRET, body?: unknown) {
  const nonce = randomBytes(24).toString("base64url");
  const timestamp = String(Date.now());
  const requestId = randomUUID();
  const canonical = [method, canonicalPath(urlPath), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  return {
    "x-manual-timestamp": timestamp, "x-manual-nonce": nonce, "x-manual-request-id": requestId,
    "x-manual-signature": `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
  };
}

async function get(urlPath: string) {
  const response = await fetch(`${baseUrl}${urlPath}`, { headers: signedHeaders("GET", urlPath) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

test("an unsigned read and a wrongly signed read are refused", async () => {
  const urlPath = "/api/manual-trading/bot-view/summary";
  assert.equal((await fetch(`${baseUrl}${urlPath}`)).status, 401);
  const wrong = await fetch(`${baseUrl}${urlPath}`, { headers: signedHeaders("GET", urlPath, "1a2b" + "c".repeat(60)) });
  assert.equal(wrong.status, 401);
});

test("a signature can't be moved to a different query", async () => {
  const signedFor = "/api/manual-trading/bot-view/trades?status=active";
  const response = await fetch(`${baseUrl}/api/manual-trading/bot-view/trades?status=closed`,
    { headers: signedHeaders("GET", signedFor) });
  assert.equal(response.status, 401);
});

test("a replayed read is refused", async () => {
  const urlPath = "/api/manual-trading/bot-view/bots";
  const headers = signedHeaders("GET", urlPath);
  assert.equal((await fetch(`${baseUrl}${urlPath}`, { headers })).status, 200);
  assert.equal((await fetch(`${baseUrl}${urlPath}`, { headers })).status, 409);
});

test("no read returns the webhook secret or the exchange keys", async () => {
  for (const urlPath of ["/api/manual-trading/bot-view/summary", "/api/manual-trading/bot-view/bots",
    "/api/manual-trading/bot-view/trades?status=active", "/api/manual-trading/bot-view/trades?status=closed"]) {
    const { status, text } = await get(urlPath);
    assert.equal(status, 200, urlPath);
    for (const secret of [WEBHOOK_SECRET, API_KEY_ENC, API_SECRET_ENC]) {
      assert.equal(text.includes(secret), false, `${urlPath} leaked a secret`);
    }
    assert.equal(/webhookSecret|apiKeyEnc|apiSecretEnc/.test(text), false, `${urlPath} named a secret field`);
  }
});

test("the summary reports the mode and the totals", async () => {
  const { body } = await get("/api/manual-trading/bot-view/summary");
  assert.deepEqual(body.mode, { dryRun: config.dryRun, binanceTestnet: config.binanceTestnet });
  assert.equal(body.stats.activeCount, 1);
  assert.equal(body.stats.closedCount, 3);
  assert.equal(body.stats.upnl, 10);
  assert.equal(body.stats.locked, 100);
  assert.equal(body.stats.totalRealizedPnl, 7.5);
});

test("the bot list carries its settings, account and totals", async () => {
  const { body } = await get("/api/manual-trading/bot-view/bots");
  assert.equal(body.length, 1);
  assert.equal(body[0].name, "Trend bot");
  assert.deepEqual(body[0].pairs, ["BTCUSDT", "ETHUSDT"]);
  assert.deepEqual(body[0].account, { name: "Testnet account", testnet: true });
  assert.equal(body[0].activeTrades, 1);
  assert.equal(body[0].closedTrades, 3);
  assert.equal(body[0].realizedPnl, 7.5);
});

test("closed trades page newest first without repeating a row", async () => {
  const first = await get("/api/manual-trading/bot-view/trades?status=closed&pageSize=2");
  const second = await get("/api/manual-trading/bot-view/trades?status=closed&pageSize=2&page=2");
  assert.equal(first.body.total, 3);
  assert.deepEqual(first.body.rows.map((r: { exchangeOrderId: string }) => r.exchangeOrderId), ["order-2", "order-1"]);
  assert.deepEqual(second.body.rows.map((r: { exchangeOrderId: string }) => r.exchangeOrderId), ["order-0"]);
});

test("trades can be narrowed to one bot", async () => {
  const mine = await get(`/api/manual-trading/bot-view/trades?status=active&botId=${botId}`);
  assert.equal(mine.body.total, 1);
  const other = await get(`/api/manual-trading/bot-view/trades?status=active&botId=${randomUUID()}`);
  assert.equal(other.body.total, 0);
});

test("a bad query is a 400, not a wider read", async () => {
  for (const query of ["status=everything", "status=active&pageSize=101", "status=active&page=0",
    "status=active&botId=not-a-uuid", "status=active&extra=1", ""]) {
    const { status } = await get(`/api/manual-trading/bot-view/trades${query ? `?${query}` : ""}`);
    assert.equal(status, 400, query);
  }
});

test("these routes answer only to GET", async () => {
  const urlPath = "/api/manual-trading/bot-view/bots";
  const response = await fetch(`${baseUrl}${urlPath}`, { method: "POST", headers: {
    "content-type": "application/json", ...signedHeaders("POST", urlPath, SECRET, {}) }, body: "{}" });
  assert.equal(response.status, 404);
});

test("with manual trading off the reads answer 404 before any signature is examined", async () => {
  config.manualTradingEnabled = false;
  try {
    assert.equal((await fetch(`${baseUrl}/api/manual-trading/bot-view/bots`)).status, 404);
  } finally {
    config.manualTradingEnabled = true;
  }
});
