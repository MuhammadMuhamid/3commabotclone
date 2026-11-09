/**
 * OD-4 — exchange-key enrollment and webhook-secret reveal on the Bot origin
 * (trace §4.3): C17 / C18 over the signed control channel, and the public
 * `/api/enroll/*` routes, driven through the real `createApp()` composition.
 *
 * Keys are checked by an INJECTED fake probe client; Binance is never
 * contacted. Every request is loopback HTTP.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".enrollment-test.db");
process.env.DATABASE_URL = "file:./tests/.enrollment-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { createHash, createHmac, randomBytes } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { createApp } = await import("../src/app.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const { decrypt } = await import("../src/lib/crypto.js");
const { signAccess } = await import("../src/lib/jwt.js");
const { enrollmentProbeClient } = await import("../src/services/enrollmentProbe.js");
const { enrollmentMintLimit, enrollmentMintLimiter } = await import("../src/routes/manualControlManage.js");

const CONTROL_SECRET = "9e4b" + "d".repeat(60);
const RETURN_URL = "https://platform.example/bot/accounts";
const ORIGIN = new URL(config.publicUrl).origin;
const original = {
  enabled: config.enrollmentEnabled, returnUrl: config.platformReturnUrl,
  secret: config.manualTradingHmacSecret, manual: config.manualTradingEnabled,
  encryptionKey: config.encryptionKey, fromKeys: enrollmentProbeClient.fromKeys,
  mintMax: enrollmentMintLimit.max,
};
config.manualTradingHmacSecret = CONTROL_SECRET;
config.manualTradingEnabled = false;
config.platformReturnUrl = RETURN_URL;
enrollmentMintLimit.max = 10_000;

let server: Server;
let baseUrl = "";
let limitedServer: Server;
let limitedUrl = "";

before(async () => {
  const listen = (limits?: Record<string, number>) => new Promise<{ s: Server; url: string }>((resolve) => {
    const s = createApp({ enrollLimits: limits ?? { session: 1000, state: 1000, keys: 1000, reveal: 1000 } })
      .listen(0, "127.0.0.1", () => resolve({ s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
  });
  ({ s: server, url: baseUrl } = await listen());
  ({ s: limitedServer, url: limitedUrl } = await listen({ session: 2, state: 1000, keys: 1000, reveal: 1000 }));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => limitedServer.close(() => resolve()));
  Object.assign(config, {
    enrollmentEnabled: original.enabled, platformReturnUrl: original.returnUrl,
    manualTradingHmacSecret: original.secret, manualTradingEnabled: original.manual,
    encryptionKey: original.encryptionKey,
  });
  enrollmentProbeClient.fromKeys = original.fromKeys;
  enrollmentMintLimit.max = original.mintMax;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

// ── A scripted fake probe client ────────────────────────────────────────────

interface ProbeScript {
  account?: Record<string, unknown> | (() => never);
  restrictions?: Record<string, unknown> | (() => never);
}
let probeCalls: Array<{ apiKey: string; testnet: boolean }> = [];
function useProbe(script: ProbeScript = {}) {
  enrollmentProbeClient.fromKeys = (keys, testnet) => {
    probeCalls.push({ apiKey: keys.apiKey, testnet });
    return {
      accountInfo: async () => typeof script.account === "function" ? script.account()
        : (script.account ?? { canTrade: true, permissions: ["SPOT"] }),
      apiPermission: async () => typeof script.restrictions === "function" ? script.restrictions()
        : (script.restrictions ?? { enableWithdrawals: false, ipRestrict: true, enableSpotAndMarginTrading: true }),
    };
  };
}

beforeEach(async () => {
  config.enrollmentEnabled = true;
  config.encryptionKey = original.encryptionKey;
  probeCalls = [];
  useProbe();
  await prisma.botControlCommand.deleteMany();
  await prisma.exchangeEnrollment.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── Signed control calls ────────────────────────────────────────────────────

let seq = 0;
const newRequestId = () => `enr_${Date.now().toString(36)}_${(seq++).toString().padStart(6, "0")}`;
const ACTOR = { platformUserId: "00000000-0000-4000-8000-000000000001",
  stepUp: { method: "totp", at: "2026-11-09T00:00:00.000Z" } };

async function control(method: "GET" | "POST", p: string, body?: unknown, requestId = newRequestId()) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const full = `/api/manual-trading/control${p}`;
  const canonical = [method, canonicalPath(full), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
  const response = await fetch(`${baseUrl}${full}`, {
    method,
    headers: { "content-type": "application/json", "x-manual-timestamp": timestamp, "x-manual-nonce": nonce,
      "x-manual-request-id": requestId,
      "x-manual-signature": `v1=${createHmac("sha256", CONTROL_SECRET).update(canonical).digest("hex")}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, text, headers: response.headers,
    body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function mint(input: Record<string, unknown>, requestId?: string) {
  return control("POST", "/exchange-enrollments", { ...input, actor: ACTOR }, requestId);
}

function ticketOf(enrollUrl: unknown): string {
  const match = /#t=([A-Za-z0-9_-]+)$/.exec(String(enrollUrl));
  assert.ok(match, "enrollUrl carries the ticket in the fragment");
  return match[1]!;
}

// ── Browser calls to /api/enroll/* ──────────────────────────────────────────

interface BrowserOpts { origin?: string | null; site?: string | null; type?: string | null; cookie?: string;
  method?: string; raw?: string; base?: string }
async function browser(p: string, body: unknown = {}, opts: BrowserOpts = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.site !== null) headers["sec-fetch-site"] = opts.site ?? "same-origin";
  if (opts.type !== null) headers["content-type"] = opts.type ?? "application/json";
  if (opts.cookie) headers.cookie = opts.cookie;
  const response = await fetch(`${opts.base ?? baseUrl}/api/enroll${p}`, {
    method: opts.method ?? "POST", headers,
    ...(opts.method === "GET" ? {} : { body: opts.raw ?? JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* non-JSON */ }
  return { status: response.status, text, headers: response.headers, body: parsed };
}

function sessionCookieFrom(headers: Headers): string {
  const raw = headers.get("set-cookie") ?? "";
  const match = /enroll_session=([^;]+)/.exec(raw);
  assert.ok(match, "a session cookie is set");
  return `enroll_session=${match[1]}`;
}

async function openSession(input: Record<string, unknown>) {
  const minted = await mint(input);
  assert.equal(minted.status, 201, minted.text);
  const opened = await browser("/session", { ticket: ticketOf(minted.body.enrollUrl) });
  assert.equal(opened.status, 200, opened.text);
  return { enrollmentId: String(minted.body.enrollmentId), cookie: sessionCookieFrom(opened.headers),
    meta: opened.body, minted };
}

const KEY = `PROBEKEY${"x".repeat(52)}Z9Y8`;
const SECRET = `PROBESECRET${"y".repeat(53)}`;

// ════════════════════════════════════════════════════════════════════════════
// Gate and capability
// ════════════════════════════════════════════════════════════════════════════

test("ENROLLMENT_ENABLED=false: the public routes are 404, C17 is refused, C0 omits enroll.v1", async () => {
  config.enrollmentEnabled = false;
  assert.equal((await browser("/session", { ticket: "a".repeat(43) })).status, 404);
  const refused = await mint({ purpose: "create", testnet: true, name: "x" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "enrollment_disabled");
  assert.equal(await prisma.exchangeEnrollment.count(), 0);
  const status = await control("GET", "/status");
  assert.equal((status.body.capabilities as string[]).includes("enroll.v1"), false);
  config.enrollmentEnabled = true;
  const on = await control("GET", "/status");
  assert.equal((on.body.capabilities as string[]).includes("enroll.v1"), true);
});

// ════════════════════════════════════════════════════════════════════════════
// C17 / C18
// ════════════════════════════════════════════════════════════════════════════

test("C17: the ticket exists only in the live answer — hashed at rest, absent from the row, C8 and a replay", async () => {
  const requestId = newRequestId();
  const minted = await mint({ purpose: "create", testnet: true, name: "Sandbox" }, requestId);
  assert.equal(minted.status, 201, minted.text);
  assert.equal(minted.headers.get("cache-control"), "no-store");
  const ticket = ticketOf(minted.body.enrollUrl);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(String(minted.body.enrollUrl), `${ORIGIN}/enroll#t=${ticket}`);
  const expiresIn = Date.parse(String(minted.body.expiresAt)) - Date.now();
  assert.ok(expiresIn > 0 && expiresIn <= 5 * 60_000, "≤ 5 minutes");

  const row = await prisma.exchangeEnrollment.findUniqueOrThrow({ where: { id: String(minted.body.enrollmentId) } });
  assert.equal(row.ticketHash, createHash("sha256").update(ticket).digest("hex"));
  assert.equal(JSON.stringify(row).includes(ticket), false);
  const command = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(command.result?.includes(ticket), false);
  assert.equal(command.result?.includes("enrollUrl"), false);
  assert.deepEqual(Object.keys(JSON.parse(command.result ?? "{}")).sort(), ["enrollmentId", "expiresAt"]);
  const replay = await mint({ purpose: "create", testnet: true, name: "Sandbox" }, requestId);
  assert.equal(replay.text.includes(ticket), false);
  assert.equal(replay.body.enrollUrl, undefined);
  assert.equal((await control("GET", `/commands/${requestId}`)).text.includes(ticket), false);
  assert.equal(await prisma.exchangeEnrollment.count(), 1, "a replay mints no second ticket");

  const c18 = await control("GET", `/exchange-enrollments/${row.id}`);
  assert.deepEqual(c18.body, { status: "issued", purpose: "create" });
});

test("C17: rule refusals — create needs testnet+name, mainnet needs MAINNET, replace keeps the network", async () => {
  assert.equal((await mint({ purpose: "create", testnet: true })).status, 400);
  const mainnet = await mint({ purpose: "create", testnet: false, name: "Real" });
  assert.equal(mainnet.status, 400);
  assert.equal(mainnet.body.code, "mainnet_confirmation_required");
  assert.equal((await mint({ purpose: "create", testnet: false, name: "Real", mainnetConfirmation: "mainnet" })).status, 400);
  assert.equal((await mint({ purpose: "create", testnet: false, name: "Real", mainnetConfirmation: "MAINNET" })).status, 201);

  const acct = await prisma.exchangeAccount.create({ data: { name: "t", apiKeyEnc: "e", apiSecretEnc: "e", testnet: true } });
  const network = await mint({ purpose: "replace", accountId: acct.id, testnet: false, mainnetConfirmation: "MAINNET" });
  assert.equal(network.status, 409);
  assert.equal(network.body.code, "network_mismatch");
  const missing = await mint({ purpose: "replace", accountId: "00000000-0000-4000-8000-0000000000aa" });
  assert.equal(missing.status, 404);
  assert.equal((await mint({ purpose: "reveal_webhook" })).status, 400);
  assert.equal((await mint({ purpose: "reveal_webhook", botId: acct.id })).body.code, "bot_not_found");
  assert.equal((await mint({ purpose: "create", testnet: true, name: "x", botId: acct.id })).status, 400);
});

test("C17: ticket minting has its own budget (429 bot_rate_limited)", async () => {
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) enrollmentMintLimiter.resetKey(key);
  enrollmentMintLimit.max = 2;
  try {
    assert.equal((await mint({ purpose: "create", testnet: true, name: "a" })).status, 201);
    assert.equal((await mint({ purpose: "create", testnet: true, name: "b" })).status, 201);
    const third = await mint({ purpose: "create", testnet: true, name: "c" });
    assert.equal(third.status, 429);
    assert.equal(third.body.code, "bot_rate_limited");
  } finally {
    enrollmentMintLimit.max = 10_000;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// /api/enroll/session — X8 checks, single use, expiry
// ════════════════════════════════════════════════════════════════════════════

test("X8: wrong Origin, no Sec-Fetch-Site, a non-JSON type or a GET are refused before anything is read", async () => {
  const minted = await mint({ purpose: "create", testnet: true, name: "x" });
  const ticket = ticketOf(minted.body.enrollUrl);
  const cases: BrowserOpts[] = [
    { origin: "https://mytradingview.example" }, { origin: null }, { site: "same-site" }, { site: "cross-site" },
    { site: null }, { type: "text/plain" }, { type: "application/x-www-form-urlencoded" }, { type: null },
  ];
  for (const opts of cases) {
    const response = await browser("/session", { ticket }, opts);
    assert.equal(response.status, 403, JSON.stringify(opts));
    assert.equal(response.body.code, "forbidden");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  assert.equal((await browser("/session", {}, { method: "GET" })).status, 404);
  // None of those consumed the ticket.
  assert.equal((await browser("/session", { ticket })).status, 200);
});

test("session: single use; the cookie is HttpOnly, SameSite=Strict, Path=/api/enroll, 5 minutes; no-store", async () => {
  const minted = await mint({ purpose: "create", testnet: true, name: "Sandbox" });
  const ticket = ticketOf(minted.body.enrollUrl);
  const first = await browser("/session", { ticket });
  assert.equal(first.status, 200);
  const cookie = first.headers.get("set-cookie") ?? "";
  assert.match(cookie, /enroll_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/api\/enroll/);
  assert.match(cookie, /Max-Age=300/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  assert.equal(first.body.purpose, "create");
  assert.equal(first.body.testnet, true);
  assert.equal(first.body.name, "Sandbox");
  assert.equal(first.text.includes(ticket), false);

  const second = await browser("/session", { ticket });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "ticket_invalid");
  const c18 = await control("GET", `/exchange-enrollments/${String(minted.body.enrollmentId)}`);
  assert.equal(c18.body.status, "opened");
});

test("session: an expired ticket is refused and reads as expired; a malformed ticket is the same refusal", async () => {
  const minted = await mint({ purpose: "create", testnet: true, name: "x" });
  await prisma.exchangeEnrollment.update({ where: { id: String(minted.body.enrollmentId) },
    data: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await browser("/session", { ticket: ticketOf(minted.body.enrollUrl) });
  assert.equal(late.status, 409);
  assert.equal((await control("GET", `/exchange-enrollments/${String(minted.body.enrollmentId)}`)).body.status, "expired");
  assert.equal((await browser("/session", { ticket: "short" })).status, 409);
  assert.equal((await browser("/session", { ticket: "a".repeat(43), purpose: "replace" })).status, 400,
    "the body cannot carry purpose (strict)");
});

test("session: a dedicated per-IP rate limit", async () => {
  const opts = { base: limitedUrl };
  assert.notEqual((await browser("/session", { ticket: "b".repeat(43) }, opts)).status, 429);
  assert.notEqual((await browser("/session", { ticket: "b".repeat(43) }, opts)).status, 429);
  const third = await browser("/session", { ticket: "b".repeat(43) }, opts);
  assert.equal(third.status, 429);
});

// ════════════════════════════════════════════════════════════════════════════
// /api/enroll/keys
// ════════════════════════════════════════════════════════════════════════════

test("keys (create, testnet): probed with the submitted keys, stored encrypted, exact return URL, C18 completed", async () => {
  const { enrollmentId, cookie } = await openSession({ purpose: "create", testnet: true, name: "Sandbox" });
  const done = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(probeCalls, [{ apiKey: KEY, testnet: true }]);
  assert.equal(done.body.testnet, true);
  assert.equal(done.body.name, "Sandbox");
  assert.equal(done.body.keyHint, "Z9Y8");
  assert.equal(done.body.returnUrl, `${RETURN_URL}?enrollment=${enrollmentId}&status=ok`);
  assert.match(String((done.body.warnings as string[])[0]), /testnet cannot report/i);
  assert.equal(done.text.includes(KEY), false);
  assert.equal(done.text.includes(SECRET), false);
  assert.match(done.headers.get("set-cookie") ?? "", /enroll_session=;/, "the session cookie is cleared");

  const account = await prisma.exchangeAccount.findUniqueOrThrow({ where: { id: String(done.body.accountId) } });
  assert.equal(account.testnet, true);
  assert.notEqual(account.apiKeyEnc, KEY);
  assert.equal(decrypt(account.apiKeyEnc), KEY);
  assert.equal(decrypt(account.apiSecretEnc), SECRET);
  const c18 = await control("GET", `/exchange-enrollments/${enrollmentId}`);
  assert.deepEqual(c18.body, { status: "completed", purpose: "create", accountId: account.id, keyHint: "Z9Y8",
    outcome: "ok" });
  // The session is spent.
  const again = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie });
  assert.equal(again.status, 401);
  assert.equal(await prisma.exchangeAccount.count(), 1);
});

test("keys: the body cannot override network, purpose or account (strict), and mainnet needs MAINNET again", async () => {
  const { cookie } = await openSession({ purpose: "create", testnet: false, name: "Real", mainnetConfirmation: "MAINNET" });
  for (const extra of [{ testnet: true }, { purpose: "replace" }, { accountId: "x" }, { name: "Other" }]) {
    const response = await browser("/keys", { apiKey: KEY, apiSecret: SECRET, mainnetConfirmation: "MAINNET", ...extra },
      { cookie });
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  const unconfirmed = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie });
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.body.code, "mainnet_confirmation_required");
  assert.equal(probeCalls.length, 0, "nothing reaches the exchange without the confirmation");
  useProbe({ restrictions: { enableWithdrawals: false, ipRestrict: false, enableSpotAndMarginTrading: true } });
  const ok = await browser("/keys", { apiKey: KEY, apiSecret: SECRET, mainnetConfirmation: "MAINNET" }, { cookie });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.testnet, false, "the network is the ticket's");
  assert.match(String((ok.body.warnings as string[])[0]), /not restricted to trusted IPs/);
});

test("keys: each probe refusal stores nothing; transport failures are not counted; the third refusal fails it", async () => {
  const { enrollmentId, cookie } = await openSession({ purpose: "create", testnet: false, name: "Real",
    mainnetConfirmation: "MAINNET" });
  const body = { apiKey: KEY, apiSecret: SECRET, mainnetConfirmation: "MAINNET" };

  useProbe({ account: () => { throw new Error("socket hang up"); } });
  const transport = await browser("/keys", body, { cookie });
  assert.equal(transport.status, 503);
  assert.equal(transport.body.code, "exchange_unavailable");

  useProbe({ account: { canTrade: false, permissions: ["SPOT"] } });
  const cannotTrade = await browser("/keys", body, { cookie });
  assert.equal(cannotTrade.status, 422);
  assert.equal(cannotTrade.body.code, "keys_cannot_trade");

  useProbe({ restrictions: { enableWithdrawals: true, ipRestrict: true } });
  const withdrawals = await browser("/keys", body, { cookie });
  assert.equal(withdrawals.status, 422);
  assert.equal(withdrawals.body.code, "withdrawals_enabled");

  useProbe({ account: () => { throw Object.assign(new Error(`Invalid API-key ${KEY}`), { code: -2015 }); } });
  const rejected = await browser("/keys", body, { cookie });
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.code, "keys_rejected");
  assert.equal(rejected.text.includes(KEY), false, "the exchange's text is never passed on");
  assert.equal(rejected.body.returnUrl, `${RETURN_URL}?enrollment=${enrollmentId}&status=failed`);

  assert.equal(await prisma.exchangeAccount.count(), 0);
  const c18 = await control("GET", `/exchange-enrollments/${enrollmentId}`);
  assert.equal(c18.body.status, "failed");
  assert.equal(c18.body.outcome, "refused:keys_rejected");
  assert.equal((await browser("/keys", body, { cookie })).status, 401, "a failed session is over");
});

test("keys: without usable key material it is 503 with nothing stored and no exchange call", async () => {
  const { cookie } = await openSession({ purpose: "create", testnet: true, name: "x" });
  config.encryptionKey = "";
  try {
    const response = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "secrets_unavailable");
  } finally {
    config.encryptionKey = original.encryptionKey;
  }
  assert.equal(probeCalls.length, 0);
  assert.equal(await prisma.exchangeAccount.count(), 0);
});

test("keys (replace): the same account gets new keys and a new hint; its network never changes", async () => {
  const acct = await prisma.exchangeAccount.create({ data: { name: "Live", apiKeyEnc: "old", apiSecretEnc: "old",
    testnet: true, keyHint: "OLD1" } });
  const { enrollmentId, cookie, meta } = await openSession({ purpose: "replace", accountId: acct.id });
  assert.deepEqual(meta.account, { id: acct.id, name: "Live", testnet: true, keyHint: "OLD1" });
  const done = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.accountId, acct.id);
  const after = await prisma.exchangeAccount.findUniqueOrThrow({ where: { id: acct.id } });
  assert.equal(after.testnet, true);
  assert.equal(after.keyHint, "Z9Y8");
  assert.equal(decrypt(after.apiKeyEnc), KEY);
  assert.equal(await prisma.exchangeAccount.count(), 1);
  assert.equal((await control("GET", `/exchange-enrollments/${enrollmentId}`)).body.accountId, acct.id);
});

test("hygiene: malformed or oversized JSON to /api/enroll/keys is a fixed 400 and nothing reaches a log", async () => {
  const { cookie } = await openSession({ purpose: "create", testnet: true, name: "x" });
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  const sink = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ")); };
  Object.assign(console, { error: sink, warn: sink, log: sink, info: sink });
  let malformed;
  let oversized;
  try {
    malformed = await browser("/keys", undefined, { cookie, raw: `{"apiKey":"${KEY}","apiSecret": ${SECRET}}` });
    oversized = await browser("/keys", undefined, { cookie, raw: JSON.stringify({ apiKey: KEY, apiSecret: SECRET, pad: "p".repeat(5000) }) });
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: "Invalid request.", code: "invalid_request" });
  assert.equal(oversized.status, 400);
  const output = lines.join("\n");
  assert.equal(output.includes(KEY), false);
  assert.equal(output.includes(SECRET), false);
  assert.equal(malformed.text.includes(KEY), false);
});

// ════════════════════════════════════════════════════════════════════════════
// /api/enroll/reveal
// ════════════════════════════════════════════════════════════════════════════

test("reveal: the secret and the exit-only JSON exactly once, no-store; never in a command row", async () => {
  const bot = await prisma.signalBot.create({ data: { name: "Revealed", webhookSecret: `rv${"s".repeat(46)}`,
    pairs: JSON.stringify(["BTCUSDT"]) } });
  const { enrollmentId, cookie, meta } = await openSession({ purpose: "reveal_webhook", botId: bot.id });
  assert.deepEqual(meta.bot, { id: bot.id, name: "Revealed" });
  assert.equal((await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie })).body.code, "wrong_purpose");
  const shown = await browser("/reveal", {}, { cookie });
  assert.equal(shown.status, 200, shown.text);
  assert.equal(shown.headers.get("cache-control"), "no-store");
  assert.equal(shown.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shown.body.webhookSecret, bot.webhookSecret);
  assert.deepEqual(shown.body.exitWebhookJson,
    { secret: bot.webhookSecret, action: "sell", symbol: "{{ticker}}", dedupe_key: "{{timenow}}" });
  assert.equal(shown.body.webhookUrl, `${config.publicUrl}/api/webhooks/signal_bots`);
  assert.equal(shown.body.returnUrl, `${RETURN_URL}?enrollment=${enrollmentId}&status=ok`);
  assert.equal((await browser("/reveal", {}, { cookie })).status, 401, "once");
  const c18 = await control("GET", `/exchange-enrollments/${enrollmentId}`);
  assert.deepEqual(c18.body, { status: "completed", purpose: "reveal_webhook", outcome: "revealed" });
  const rows = await prisma.botControlCommand.findMany();
  assert.equal(JSON.stringify(rows).includes(bot.webhookSecret), false);
  assert.equal((await browser("/reveal", { botId: bot.id }, { cookie })).status, 401);
});

// ════════════════════════════════════════════════════════════════════════════
// The two authorities never cross
// ════════════════════════════════════════════════════════════════════════════

test("auth separation: the enroll session never authenticates the dashboard, and the dashboard JWT never the enroll routes", async () => {
  const { cookie } = await openSession({ purpose: "create", testnet: true, name: "x" });
  const dashboard = await fetch(`${baseUrl}/api/bots`, { headers: { cookie } });
  assert.equal(dashboard.status, 401);
  const accounts = await fetch(`${baseUrl}/api/exchange-accounts`, { headers: { cookie } });
  assert.equal(accounts.status, 401);

  const jwtCookie = `access_token=${signAccess("00000000-0000-4000-8000-0000000000aa")}`;
  assert.equal((await fetch(`${baseUrl}/api/bots`, { headers: { cookie: jwtCookie } })).status, 200,
    "sanity: the JWT works where it belongs");
  const state = await browser("/state", {}, { cookie: jwtCookie });
  assert.equal(state.status, 401);
  assert.equal(state.body.code, "session_invalid");
  const keys = await browser("/keys", { apiKey: KEY, apiSecret: SECRET }, { cookie: jwtCookie });
  assert.equal(keys.status, 401);
  assert.equal(probeCalls.length, 0);
  // And the live enroll session still answers /state.
  assert.equal((await browser("/state", {}, { cookie })).status, 200);
});

test("CORS stays Bot-origin only: a preflight from another origin gets no allow-origin", async () => {
  const response = await fetch(`${baseUrl}/api/enroll/keys`, { method: "OPTIONS", headers: {
    origin: "https://mytradingview.example", "access-control-request-method": "POST",
    "access-control-request-headers": "content-type",
  } });
  assert.notEqual(response.headers.get("access-control-allow-origin"), "https://mytradingview.example");
});
