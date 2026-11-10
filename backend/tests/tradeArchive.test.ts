/**
 * Feature B — "Archive / Hide from History" replaces deleting a closed trade.
 *
 * Archive is presentation state only. The invariants proved here:
 *   - `DELETE /api/trades/:id` deletes nothing (410 `trade_delete_removed`);
 *   - archive / restore are idempotent, concurrency-safe and typed;
 *   - a trade that is not closed, still has an order that may reach the
 *     exchange, or carries an unresolved operator flag is refused, never hidden;
 *   - every accounting and risk figure (risk snapshot, `dailyLossBreached`, the
 *     halt latch, Resume, bot-view summary, per-bot realised P&L, dashboard
 *     stats) is byte-identical before archive, after archive, after a repeat
 *     archive and after restore — including with the daily-loss halt latched;
 *   - the signed control route follows the C6 pattern (request-id replay,
 *     strict body, typed refusal) and `tradeArchive.v1` is advertised.
 *
 * Loopback HTTP through the real routers; no exchange is contacted.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount, SmartTrade } from "@prisma/client";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".trade-archive-test.db");
process.env.DATABASE_URL = "file:./tests/.trade-archive-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { tradesRouter } = await import("../src/routes/trades.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const risk = await import("../src/services/riskControls.js");
const botView = await import("../src/services/botView.js");
const { setTradeArchived } = await import("../src/services/tradeArchive.js");

const CONTROL_SECRET = "5be1" + "c".repeat(60);
const original = {
  manualTradingEnabled: config.manualTradingEnabled, secret: config.manualTradingHmacSecret,
};
config.manualTradingHmacSecret = CONTROL_SECRET;
config.manualTradingEnabled = false; // `/control/*` is control plane (bot-view enables it per test)

let server: Server;
let baseUrl = "";
before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  // `requireAuth` stands in: it sets `res.locals.userId` for an authenticated session.
  app.use("/api/trades", (_req, res, next) => { res.locals.userId = "dash-user-1"; next(); }, tradesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  Object.assign(config, {
    manualTradingEnabled: original.manualTradingEnabled, manualTradingHmacSecret: original.secret,
  });
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  config.manualTradingEnabled = false;
  await prisma.botControlCommand.deleteMany();
  await prisma.partialClose.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.exchangeOrderAttempt.deleteMany();
  await prisma.smartTrade.deleteMany();
  await prisma.manualOrder.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.riskControl.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── HTTP helpers ────────────────────────────────────────────────────────────

let seq = 0;
const newRequestId = () => `req_${Date.now().toString(36)}_arch${(seq++).toString().padStart(6, "0")}`;
const ACTOR = {
  platformUserId: "00000000-0000-4000-8000-0000000000bb",
  stepUp: { method: "totp", at: "2026-11-09T00:00:00.000Z" },
};
const C = "/api/manual-trading/control";

interface Reply { status: number; body: Record<string, unknown>; replayed: boolean }

async function signed(method: "GET" | "POST", p: string, body?: unknown, requestId = newRequestId()): Promise<Reply> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const canonical = [method, canonicalPath(p), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  const response = await fetch(`${baseUrl}${p}`, { method, headers: {
    "content-type": "application/json", "x-manual-timestamp": timestamp, "x-manual-nonce": nonce,
    "x-manual-request-id": requestId,
    "x-manual-signature": `v1=${createHmac("sha256", CONTROL_SECRET).update(canonical).digest("hex")}`,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {},
    replayed: response.headers.get("x-control-replayed") === "true" };
}

async function dash(method: "GET" | "POST" | "DELETE", p: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/trades${p}`, { method, headers: { "content-type": "application/json" } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}
const body = (r: { body: unknown }) => r.body as Record<string, unknown>;
const rows = (r: { body: unknown }) => r.body as Array<Record<string, unknown>>;

// ── fixtures ────────────────────────────────────────────────────────────────

let n = 0;
async function closedTrade(data: Partial<SmartTrade> = {}): Promise<SmartTrade> {
  n += 1;
  return prisma.smartTrade.create({ data: {
    pair: "BTCUSDT", status: "closed", entryPrice: 100, currentPrice: 90, quantity: 1, quoteSpent: 100,
    pnlUsdt: -10, pnlPct: -10, closedReason: "stop_loss", closedAt: new Date(), botName: `bot ${n}`,
    ...data,
  } as Parameters<typeof prisma.smartTrade.create>[0]["data"] });
}

async function account(): Promise<ExchangeAccount> {
  n += 1;
  return prisma.exchangeAccount.create({ data: { name: `arch-${n}`, exchange: "binance",
    marketType: "spot", apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true } });
}

async function manualOrder(acc: ExchangeAccount, data: Record<string, unknown>) {
  n += 1;
  return prisma.manualOrder.create({ data: {
    requestId: `mo-req-${n}-${"x".repeat(16)}`, clientOrderId: `mo-${n}`, exchangeAccountId: acc.id,
    symbol: "BTCUSDT", side: "SELL", orderType: "LIMIT", quantityType: "base", status: "filled",
    ...data,
  } as Parameters<typeof prisma.manualOrder.create>[0]["data"] });
}

// ── DELETE is gone ──────────────────────────────────────────────────────────

test("DELETE /api/trades/:id answers 410 and deletes nothing — the trade and its PartialClose rows stay", async () => {
  const trade = await closedTrade();
  await prisma.partialClose.create({ data: { tradeId: trade.id, pct: 50, quantity: 0.5, revenue: 45,
    pnlUsdt: -5, avgPrice: 90 } });
  const reply = await dash("DELETE", `/${trade.id}`);
  assert.equal(reply.status, 410);
  assert.deepEqual(reply.body, {
    error: "Deleting trades was replaced by Archive. Archived trades keep their P&L and daily-loss history.",
    code: "trade_delete_removed",
  });
  assert.ok(await prisma.smartTrade.findUnique({ where: { id: trade.id } }));
  assert.equal(await prisma.partialClose.count({ where: { tradeId: trade.id } }), 1);
  // An active trade, an unknown id: still nothing deleted, same answer.
  const active = await closedTrade({ status: "active", closedAt: null });
  assert.equal((await dash("DELETE", `/${active.id}`)).status, 410);
  assert.equal(await prisma.smartTrade.count(), 2);
});

// ── archive / restore through the Classic routes ────────────────────────────

test("Classic archive/restore: idempotent, actor recorded, history filters exclude|include|only", async () => {
  const visible = await closedTrade({ pnlUsdt: 5 });
  const target = await closedTrade({ pnlUsdt: -7 });

  const first = await dash("POST", `/${target.id}/archive`);
  assert.equal(first.status, 200);
  assert.equal(body(first).archived, true);
  assert.equal(body(first).changed, true);
  assert.equal(body(first).archivedBy, "classic:dash-user-1");
  const at = body(first).archivedAt;
  assert.equal(typeof at, "string");

  const repeat = await dash("POST", `/${target.id}/archive`);
  assert.equal(repeat.status, 200);
  assert.equal(body(repeat).changed, false);
  assert.equal(body(repeat).archivedAt, at, "a repeat archive changes nothing");

  // Default History hides archived; rows created without archivedAt (pre-migration shape) stay visible.
  const def = await dash("GET", "?status=history");
  assert.deepEqual(rows(def).map((r) => r.id), [visible.id]);
  assert.equal(rows(def)[0]!.archivedAt, null);
  assert.equal(rows(def)[0]!.archiveBlocked, null);
  const incl = await dash("GET", "?status=history&archived=include");
  assert.deepEqual(new Set(rows(incl).map((r) => r.id)), new Set([visible.id, target.id]));
  const only = await dash("GET", "?status=history&archived=only");
  assert.deepEqual(rows(only).map((r) => r.id), [target.id]);
  assert.equal(rows(only)[0]!.archivedAt, at);
  assert.equal((await dash("GET", "?status=history&archived=bogus")).status, 400);

  const restored = await dash("POST", `/${target.id}/restore`);
  assert.equal(restored.status, 200);
  assert.deepEqual([body(restored).archived, body(restored).changed, body(restored).archivedAt,
    body(restored).archivedBy], [false, true, null, null]);
  const again = await dash("POST", `/${target.id}/restore`);
  assert.equal(body(again).changed, false);
  assert.equal(rows(await dash("GET", "?status=history")).length, 2);
});

test("two concurrent archive requests both succeed and write exactly once", async () => {
  const trade = await closedTrade();
  const [a, b] = await Promise.all([dash("POST", `/${trade.id}/archive`), dash("POST", `/${trade.id}/archive`)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal([body(a).changed, body(b).changed].filter(Boolean).length, 1);
  assert.equal(body(a).archivedAt, body(b).archivedAt);
});

test("malformed id → 400 invalid_id; unknown id → 404 not_found; active trade → 409 trade_not_closed", async () => {
  const bad = await dash("POST", "/not-a-uuid/archive");
  assert.equal(bad.status, 400);
  assert.equal(body(bad).code, "invalid_id");
  const unknown = await dash("POST", "/00000000-0000-4000-8000-00000000dead/archive");
  assert.equal(unknown.status, 404);
  assert.equal(body(unknown).code, "not_found");
  const active = await closedTrade({ status: "active", closedAt: null });
  const refused = await dash("POST", `/${active.id}/archive`);
  assert.equal(refused.status, 409);
  assert.equal(body(refused).code, "trade_not_closed");
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: active.id } })).archivedAt, null);
});

test("unresolved orders refuse archive (open exit attempt, unresolved intent, pending manual order, owed entry cancel, protective order)", async () => {
  const acc = await account();
  const cases: Array<[string, (t: SmartTrade) => Promise<unknown>]> = [
    ["open exchange order attempt", (t) => prisma.exchangeOrderAttempt.create({ data: {
      intentKey: `exit:${t.id}`, attempt: 1, clientOrderId: `att-${t.id}`, symbol: "BTCUSDT", side: "SELL",
      status: "open", smartTradeId: t.id } })],
    ["unresolved strategy intent", (t) => prisma.strategyOrderIntent.create({ data: {
      sourceKey: `sk-${t.id}`, botId: "b", botName: "b", clientOrderId: `soi-${t.id}`, symbol: "BTCUSDT",
      side: "SELL", status: "submitted", smartTradeId: t.id } })],
    ["pending manual SELL linked to the position", (t) => manualOrder(acc, {
      linkedPositionId: t.id, status: "open" })],
    ["entry still owing an OD-1 cancel", async (t) => {
      const entry = await manualOrder(acc, { side: "BUY", status: "canceled", exitCancelState: "unknown" });
      await prisma.smartTrade.update({ where: { id: t.id }, data: { manualOrderId: entry.id, source: "manual" } });
    }],
    ["entry still working at the exchange", async (t) => {
      const entry = await manualOrder(acc, { side: "BUY", status: "partially_filled" });
      await prisma.smartTrade.update({ where: { id: t.id }, data: { manualOrderId: entry.id, source: "manual" } });
    }],
    ["protective order id still set", (t) => prisma.smartTrade.update({ where: { id: t.id },
      data: { protectiveOrderId: "stop-1" } })],
  ];
  for (const [label, arrange] of cases) {
    const trade = await closedTrade();
    await arrange(trade);
    const reply = await dash("POST", `/${trade.id}/archive`);
    assert.equal(reply.status, 409, label);
    assert.equal(body(reply).code, "trade_has_unresolved_orders", label);
    assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).archivedAt, null, label);
    const listed = rows(await dash("GET", "?status=history")).find((r) => r.id === trade.id);
    assert.equal((listed?.archiveBlocked as { code: string } | null)?.code, "trade_has_unresolved_orders", label);
  }
});

test("unresolved operator flags refuse archive as trade_needs_attention; informational flags do not", async () => {
  const acc = await account();
  const needs: Array<[string, (t: SmartTrade) => Promise<unknown>]> = [
    ["entry cancel gave up", async (t) => {
      const entry = await manualOrder(acc, { side: "BUY", status: "canceled", exitCancelState: "failed" });
      await prisma.smartTrade.update({ where: { id: t.id }, data: { manualOrderId: entry.id, source: "manual" } });
    }],
    ["SWEEP FAILED flag on a linked order", (t) => manualOrder(acc, { linkedPositionId: t.id,
      error: "SWEEP FAILED: the Bot could not sell race-fill position" })],
    ["late-fill position closed unprotected", (t) => prisma.smartTrade.update({ where: { id: t.id },
      data: { protectionState: "late_fill_unprotected" } })],
  ];
  for (const [label, arrange] of needs) {
    const trade = await closedTrade();
    await arrange(trade);
    const reply = await dash("POST", `/${trade.id}/archive`);
    assert.equal(reply.status, 409, label);
    assert.equal(body(reply).code, "trade_needs_attention", label);
  }
  const dust = await closedTrade({ closedReason: "dust_below_exchange_minimum" });
  await manualOrder(acc, { linkedPositionId: dust.id, error: "DUST: 0.00001 BTC remained on position" });
  assert.equal((await dash("POST", `/${dust.id}/archive`)).status, 200);
});

test("restore is always allowed for an archived trade, even one that would now be refused", async () => {
  const trade = await closedTrade();
  await setTradeArchived(trade.id, true, "classic:test");
  await prisma.smartTrade.update({ where: { id: trade.id }, data: { protectiveOrderId: "late-stop" } });
  const reply = await dash("POST", `/${trade.id}/restore`);
  assert.equal(reply.status, 200);
  assert.equal(body(reply).archived, false);
});

// ── P&L / daily-loss / halt invariance ──────────────────────────────────────

/** Every accounting and risk read an operator or the halt latch depends on. */
async function accountingFingerprint(): Promise<string> {
  const limits = await risk.getBotRiskLimits();
  const snapshot = await risk.readBotRiskSnapshot(limits.dailyLossWindowHours);
  const halt = await risk.readBotHaltState();
  const summary = await botView.readBotViewSummary();
  const bots = await botView.listBotViewBots();
  return JSON.stringify({
    snapshot,
    breached: risk.dailyLossBreached(limits, snapshot),
    describe: risk.describeBotRiskState(limits, snapshot),
    halt: { ...halt, haltedAt: halt.haltedAt?.toISOString() ?? null },
    limits: { ...limits },
    summary,
    perBot: bots.map((b) => ({ id: b.id, closed: b.closedTrades, realized: b.realizedPnl })),
    stats: await botView.readBotStats(),
    partials: await prisma.partialClose.findMany({ orderBy: { id: "asc" } }),
    pnl: await prisma.smartTrade.findMany({ orderBy: { id: "asc" },
      select: { id: true, status: true, pnlUsdt: true, pnlPct: true, closedAt: true, quoteSpent: true } }),
  });
}

test("daily-loss halt latched: archiving the losing trade keeps the loss, the breach and the halt; Resume still refuses", async () => {
  const bot = await prisma.signalBot.create({ data: { name: "loss bot", webhookSecret: `w${"s".repeat(39)}`,
    pairs: JSON.stringify(["BTCUSDT"]) } });
  await risk.updateBotRiskLimits({ maxDailyLossQuote: 50, dailyLossWindowHours: 24 });
  const loser = await closedTrade({ botId: bot.id, pnlUsdt: -60, pnlPct: -60 });
  await prisma.partialClose.create({ data: { tradeId: loser.id, pct: 25, quantity: 0.25, revenue: 20,
    pnlUsdt: -5, avgPrice: 80 } });
  await closedTrade({ botId: bot.id, pnlUsdt: 3, pnlPct: 3 });
  const limits = await risk.getBotRiskLimits();
  const snap = await risk.readBotRiskSnapshot(limits.dailyLossWindowHours);
  assert.equal(risk.dailyLossBreached(limits, snap), true, "fixture: the limit is reached");
  await risk.haltBotTrading({ by: "daily_loss", reason: "daily loss limit reached" });

  const before = await accountingFingerprint();
  await setTradeArchived(loser.id, true, "classic:test");
  assert.equal(await accountingFingerprint(), before, "after archive");
  await setTradeArchived(loser.id, true, "classic:test");
  await dash("POST", `/${loser.id}/archive`);
  assert.equal(await accountingFingerprint(), before, "after repeated archive");
  const resume = await risk.resumeBotTrading();
  assert.equal(resume.ok, false);
  assert.equal(resume.ok === false && resume.code, "still_breached");
  assert.equal((await risk.readBotHaltState()).halted, true, "the halt is not cleared");
  assert.equal(await accountingFingerprint(), before, "after a refused resume");
  await setTradeArchived(loser.id, false, "classic:test");
  assert.equal(await accountingFingerprint(), before, "after restore");
  // Through the control channel too.
  const ctl = await signed("POST", `${C}/trades/${loser.id}/archive`, { archived: true, actor: ACTOR });
  assert.equal(ctl.status, 200);
  assert.equal(await accountingFingerprint(), before, "after a Platform archive");
});

test("summary totals include archived trades; only the listing hides them", async () => {
  const a = await closedTrade({ pnlUsdt: -12.5 });
  await closedTrade({ pnlUsdt: 2.25 });
  const before = (await botView.readBotViewSummary()).stats;
  await setTradeArchived(a.id, true, "classic:test");
  const after = (await botView.readBotViewSummary()).stats;
  assert.equal(after.totalRealizedPnl, before.totalRealizedPnl);
  assert.equal(after.totalRealizedPnl, -10.25);
  assert.equal(after.closedCount, 2);
  const listed = await botView.listBotViewTrades({ status: "closed", page: 1, pageSize: 50 });
  assert.equal(listed.total, 1);
});

// ── the signed control route and the bot-view read ──────────────────────────

test("control: signed archive, request-id replay, strict body, typed refusal, capability advertised", async () => {
  const trade = await closedTrade();
  const requestId = newRequestId();
  const first = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: true, actor: ACTOR }, requestId);
  assert.equal(first.status, 200);
  assert.equal(first.body.archived, true);
  assert.equal(first.body.archivedBy, `platform:${ACTOR.platformUserId}`);
  assert.equal(first.replayed, false);

  const replay = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: true, actor: ACTOR }, requestId);
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  // The same request id with different parameters is a conflict, never a re-run.
  const conflict = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: false, actor: ACTOR }, requestId);
  assert.notEqual(conflict.status, 200);
  assert.equal((await prisma.smartTrade.findUniqueOrThrow({ where: { id: trade.id } })).archivedAt !== null, true);

  const restore = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: false, actor: ACTOR });
  assert.equal(restore.status, 200);
  assert.equal(restore.body.archived, false);

  const extra = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: true, actor: ACTOR, x: 1 });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.code, "invalid_request");
  const noActor = await signed("POST", `${C}/trades/${trade.id}/archive`, { archived: true });
  assert.equal(noActor.status, 400);
  const badId = await signed("POST", `${C}/trades/nope/archive`, { archived: true, actor: ACTOR });
  assert.equal(badId.status, 400);
  assert.equal(badId.body.code, "invalid_id");
  const unknown = await signed("POST", `${C}/trades/00000000-0000-4000-8000-00000000beef/archive`,
    { archived: true, actor: ACTOR });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "not_found");

  const active = await closedTrade({ status: "active", closedAt: null });
  const refused = await signed("POST", `${C}/trades/${active.id}/archive`, { archived: true, actor: ACTOR });
  assert.equal(refused.status, 409);
  assert.deepEqual(Object.keys(refused.body).sort(), ["code", "error"]);
  assert.equal(refused.body.code, "trade_not_closed");

  const unsigned = await fetch(`${baseUrl}${C}/trades/${trade.id}/archive`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true, actor: ACTOR }) });
  assert.equal(unsigned.status, 401);

  const status = await signed("GET", `${C}/status`);
  assert.ok((status.body.capabilities as string[]).includes("tradeArchive.v1"));
});

test("bot-view trades: archived filter (default exclude), archivedAt and archiveBlocked on each row", async () => {
  config.manualTradingEnabled = true; // `/bot-view/*` follows the manual feature flag (unchanged)
  const shown = await closedTrade();
  const hidden = await closedTrade();
  await setTradeArchived(hidden.id, true, "platform:test");
  const def = await signed("GET", "/api/manual-trading/bot-view/trades?status=closed");
  assert.equal(def.status, 200);
  const defRows = def.body.rows as Array<Record<string, unknown>>;
  assert.deepEqual(defRows.map((r) => r.id), [shown.id]);
  assert.equal(def.body.total, 1);
  assert.equal(defRows[0]!.archivedAt, null);
  assert.equal(defRows[0]!.archiveBlocked, null);
  const only = await signed("GET", "/api/manual-trading/bot-view/trades?status=closed&archived=only");
  assert.deepEqual((only.body.rows as Array<Record<string, unknown>>).map((r) => r.id), [hidden.id]);
  assert.equal(typeof (only.body.rows as Array<Record<string, unknown>>)[0]!.archivedAt, "string");
  const incl = await signed("GET", "/api/manual-trading/bot-view/trades?status=closed&archived=include");
  assert.equal(incl.body.total, 2);
  const bad = await signed("GET", "/api/manual-trading/bot-view/trades?status=closed&archived=all");
  assert.equal(bad.status, 400);
});
