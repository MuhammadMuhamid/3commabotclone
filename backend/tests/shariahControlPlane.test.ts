/**
 * BOT-P1-4 — the Shariah floor control plane, with manual trading DISABLED.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 *
 * `setInstallationShariahMode` is the sole writer of this installation's
 * enforcement floor, and its only caller is `PUT
 * /api/manual-trading/shariah-enforcement`. That whole router was gated on
 * MANUAL_TRADING_ENABLED, so on the safe, recommended posture —
 * MANUAL_TRADING_ENABLED=false, no manual order channel — the Platform's push
 * 404'd, the floor stayed `off`, and every DIRECT webhook BUY carrying no
 * Shariah evidence kept being admitted. Turning manual trading off silently
 * turned Shariah enforcement off with it.
 *
 * MANUAL_TRADING_ENABLED controls MANUAL TRADING. It must not control whether
 * the Platform can arm the enforcement floor.
 *
 * ── What this suite holds ───────────────────────────────────────────────────
 *
 * Everything below runs with `manualTradingEnabled === false` for the entire
 * file — it is never flipped on, anywhere. The floor is armed over real HTTP
 * against the real router, signed with the real HMAC, and the direct webhook
 * path is then driven end to end against the suite's mocked exchange.
 *
 * No network. No Binance. No manual order is ever accepted.
 */
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

/*
 * Its own database, for the reason `shariahEnforcement.test.ts` documents:
 * `node --test` runs files as parallel processes, and two suites sharing one
 * SQLite fixture race over it. The URL must be chosen before anything
 * constructs the Prisma client, hence the dynamic imports below.
 */
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".shariah-control-test.db");
process.env.DATABASE_URL = "file:./tests/.shariah-control-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const express = (await import("express")).default;
const { createHash, createHmac, randomBytes, randomUUID } = await import("node:crypto");
const { config, collectConfigErrors } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { manualTradingRouter } = await import("../src/routes/manualTrading.js");
const { errorHandler } = await import("../src/middleware/errors.js");
const { canonicalJson, canonicalPath } = await import("../src/services/manualAuth.js");
const { processWebhook } = await import("../src/services/webhook.js");
const { readInstallationShariahMode } = await import("../src/services/shariah.js");
const { shariahEvidenceCanonical, SHARIAH_POLICY_VERSION } =
  await import("../src/contract/webhookContract.js");

/*
 * A real key: 64 hex characters, and NOT one of the repository's published
 * placeholder shapes — `requireManualAuth` now refuses to authenticate against
 * those, so a "test-only-…" fixture would prove the wrong thing here.
 */
const CONTROL_SECRET = "9f2c" + "a".repeat(60);

const original = {
  dryRun: config.dryRun,
  manualTradingEnabled: config.manualTradingEnabled,
  secret: config.manualTradingHmacSecret,
};

/*
 * The whole point of the suite: manual trading stays OFF throughout.
 * `dryRun` is off so a refusal is provable as "no order was sent" rather than
 * hidden behind a simulated fill.
 */
config.dryRun = false;
config.manualTradingEnabled = false;
config.manualTradingHmacSecret = CONTROL_SECRET;

let server: Server;
let baseUrl = "";

before(async () => {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use("/api/manual-trading", manualTradingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config.dryRun = original.dryRun;
  config.manualTradingEnabled = original.manualTradingEnabled;
  config.manualTradingHmacSecret = original.secret;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

afterEach(async () => {
  await prisma.shariahEnforcement.deleteMany();
});

let seq = 0;
const uniq = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${seq++}`;

/**
 * The PLATFORM's signing scheme, written out rather than imported.
 *
 * `platform/backend/src/manualTrading/client.ts` computes exactly this: HMAC of
 * METHOD, canonical path, timestamp, nonce, request id and the SHA-256 of the
 * canonical JSON body, joined by newlines and prefixed `v1=`. Reproducing it
 * here is what makes this a contract test rather than a test of the receiver
 * against itself.
 */
async function callControl(input: {
  method: "GET" | "PUT" | "POST";
  path: string;
  body?: unknown;
  secret?: string;
  headers?: Record<string, string>;
  omitSignature?: boolean;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = randomUUID();
  const canonical = [
    input.method.toUpperCase(), canonicalPath(input.path), timestamp, nonce, requestId,
    createHash("sha256").update(canonicalJson(input.body)).digest("hex"),
  ].join("\n");
  const signature =
    `v1=${createHmac("sha256", input.secret ?? CONTROL_SECRET).update(canonical).digest("hex")}`;
  const response = await fetch(`${baseUrl}${input.path}`, {
    method: input.method,
    headers: {
      "content-type": "application/json",
      "x-manual-timestamp": timestamp,
      "x-manual-nonce": nonce,
      "x-manual-request-id": requestId,
      ...(input.omitSignature ? {} : { "x-manual-signature": signature }),
      ...input.headers,
    },
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const FLOOR = "/api/manual-trading/shariah-enforcement";

const eligible = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, assetId: "reg_apt_0001",
  baseAsset: "APT", effectiveStatus: "ELIGIBLE", publicationId: "pub_2026_09_02", ...over,
});

/** Exactly what the Platform emits alongside a direct webhook order. */
function signedShariah(symbol: string, side: "buy" | "sell", context: Record<string, unknown>) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(24).toString("base64url");
  const canonical = shariahEvidenceCanonical({
    symbol, side, timestamp, nonce, context: context as never });
  return {
    shariah: context,
    shariah_ts: timestamp,
    shariah_nonce: nonce,
    shariah_sig: `v1=${createHmac("sha256", config.manualTradingHmacSecret)
      .update(canonical).digest("hex")}`,
  };
}

function recordingClient() {
  const orders: Array<Record<string, unknown>> = [];
  const client = {
    accountInfo: async () => ({ balances: [
      { asset: "USDT", free: "5000", locked: "0" },
      { asset: "APT", free: "10", locked: "0" },
    ] }),
    exchangeInfo: async () => ({ symbols: [{ baseAsset: "APT", quoteAsset: "USDT", filters: [
      { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
      { filterType: "MIN_NOTIONAL", minNotional: "10" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      orders.push(payload);
      return { orderId: orders.length, side: payload.side, status: "FILLED",
        executedQty: "1", cummulativeQuoteQty: "100",
        clientOrderId: payload.newClientOrderId, fills: [] };
    },
    getOrder: async () => undefined,
    myTrades: async () => [],
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: "100" }),
  };
  return { client, orders };
}

async function createBot() {
  // A generous allowance: investment sizing is a different control with its own
  // tests, and the default would refuse entries this suite expects to succeed.
  return prisma.signalBot.create({ data: {
    name: "control-plane fixture",
    webhookSecret: uniq("control-secret-0000000000000000000000"),
    pairs: JSON.stringify(["APTUSDT"]), entryEnabled: true, exitEnabled: true,
    maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 10_000,
  } });
}

// ── The invariant, stated once ──────────────────────────────────────────────

test("manual trading is disabled for every assertion in this file", () => {
  assert.equal(config.manualTradingEnabled, false);
});

// ── I: manual trading itself stays unavailable ──────────────────────────────

test("I: a perfectly signed manual order is still refused while manual trading is disabled",
  async () => {
    for (const call of [
      { method: "POST" as const, path: "/api/manual-trading/orders", body: {
        accountId: randomUUID(), symbol: "APTUSDT", side: "BUY" as const,
        orderType: "MARKET" as const, quoteQuantity: 100 } },
      { method: "POST" as const, path: `/api/manual-trading/orders/${randomUUID()}/cancel`,
        body: {} },
      { method: "GET" as const, path: "/api/manual-trading/state" },
      { method: "GET" as const,
        path: `/api/manual-trading/account-state?accountId=${randomUUID()}&symbol=APTUSDT` },
      { method: "POST" as const,
        path: "/api/manual-trading/execution-evidence/manual-orders/lookup",
        body: { orderId: randomUUID() } },
    ]) {
      const response = await callControl(call);
      assert.equal(response.status, 404, `${call.method} ${call.path}`);
      assert.equal(response.body.error, "manual trading is disabled");
    }
  });

test("I: the feature gate answers before the signature is even examined", async () => {
  const response = await callControl({
    method: "POST", path: "/api/manual-trading/orders", body: { nonsense: true },
    omitSignature: true });
  assert.equal(response.status, 404, "a disabled feature must not leak an auth oracle");
  assert.equal(response.body.error, "manual trading is disabled");
});

// ── A–C: the floor is armable with manual trading off ───────────────────────

test("A: with the floor off, a legacy direct webhook BUY carrying no decision still trades",
  async () => {
    const bot = await createBot();
    const { client, orders } = recordingClient();
    assert.equal((await readInstallationShariahMode()).mode, "off");

    const out = await processWebhook(
      { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
        dedupe_key: uniq("W") },
      { clientFactory: async () => client as never });

    assert.equal(out.status, "ok", "mode off must remain backward compatible");
    assert.equal(orders.length, 1);
  });

test("B+C: the Platform can arm the floor, and the bot then reports it", async () => {
  const armed = await callControl({ method: "PUT", path: FLOOR,
    body: { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION } });

  assert.equal(armed.status, 200, "MANUAL_TRADING_ENABLED must not gate the control plane");
  assert.deepEqual(armed.body, { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION,
    supportedPolicyVersion: SHARIAH_POLICY_VERSION });

  // The Platform proves the arming from the answer it gets back, so that answer
  // has to be the floor that actually landed — not an echo of the request.
  assert.equal((await readInstallationShariahMode()).mode, "enforce");

  const read = await callControl({ method: "GET", path: FLOOR });
  assert.equal(read.status, 200);
  assert.equal(read.body.mode, "enforce");
  assert.equal(read.body.policyVersion, SHARIAH_POLICY_VERSION);

  // ...and disarming is an equally authenticated, equally explicit act.
  const disarmed = await callControl({ method: "PUT", path: FLOOR, body: { mode: "off" } });
  assert.equal(disarmed.status, 200);
  assert.equal(disarmed.body.mode, "off");
  assert.equal((await readInstallationShariahMode()).mode, "off");
});

// ── D–H: what the armed floor does to direct webhook traffic ────────────────

async function armed() {
  const response = await callControl({ method: "PUT", path: FLOOR,
    body: { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION } });
  assert.equal(response.status, 200);
  assert.equal((await readInstallationShariahMode()).mode, "enforce");
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const buy = (extra: Record<string, unknown> = {}) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...extra },
    { clientFactory: async () => client as never });
  return { bot, client, orders, buy };
}

test("D: a direct webhook BUY with no Shariah evidence is blocked before the exchange",
  async () => {
    const { orders, buy } = await armed();
    const out = await buy();
    assert.equal(out.status, "shariah_blocked");
    assert.equal((out.detail as { code: string }).code, "SHARIAH_CONTEXT_REQUIRED");
    assert.equal(orders.length, 0, "nothing may reach the exchange");
  });

test("E: a direct webhook BUY whose decision says REVIEW is blocked", async () => {
  const { orders, buy } = await armed();
  const out = await buy(signedShariah("APTUSDT", "buy", eligible({ effectiveStatus: "REVIEW" })));
  assert.equal(out.status, "shariah_blocked");
  assert.equal((out.detail as { code: string }).code, "SHARIAH_REVIEW_BLOCKED");
  assert.equal(orders.length, 0);
});

test("F: a direct webhook BUY whose decision says EXCLUDED is blocked", async () => {
  const { orders, buy } = await armed();
  const out = await buy(signedShariah("APTUSDT", "buy", eligible({ effectiveStatus: "EXCLUDED" })));
  assert.equal(out.status, "shariah_blocked");
  assert.equal((out.detail as { code: string }).code, "SHARIAH_EXCLUDED_BLOCKED");
  assert.equal(orders.length, 0);
});

test("G: a validly signed ELIGIBLE authorisation still reaches the mocked exchange", async () => {
  const { orders, buy } = await armed();
  const out = await buy(signedShariah("APTUSDT", "buy", eligible()));
  assert.equal(out.status, "ok");
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.side, "BUY");
});

test("H: a SELL is never Shariah-blocked, whatever the decision says", async () => {
  const { bot, client, orders, buy } = await armed();
  assert.equal((await buy(signedShariah("APTUSDT", "buy", eligible()))).status, "ok");
  assert.equal(orders.length, 1);

  /*
   * A position that cannot be closed is a worse outcome than any replay. None
   * of these exits may be refused on Shariah grounds: one carrying nothing, one
   * carrying a malformed block, one whose decision says EXCLUDED.
   */
  for (const [name, extra] of [
    ["no decision", {}],
    ["a malformed decision", { shariah: { mode: "enforce", nonsense: true } }],
    ["an EXCLUDED decision", signedShariah("APTUSDT", "sell", eligible({
      effectiveStatus: "EXCLUDED" }))],
  ] as const) {
    const exit = await processWebhook(
      { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT",
        dedupe_key: uniq("X"), ...extra },
      { clientFactory: async () => client as never, skipExitCheck: true })
      .then((r) => r, (e: Error) => ({ status: "threw", detail: e.message }));
    assert.notEqual(exit.status, "shariah_blocked", `an exit with ${name} must never be gated`);
  }
});

// ── J: only well-formed, authenticated floor changes are accepted ───────────

test("J: an unauthenticated or malformed floor change is rejected and changes nothing",
  async () => {
    const armedFirst = await callControl({ method: "PUT", path: FLOOR,
      body: { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION } });
    assert.equal(armedFirst.status, 200);

    for (const [name, call] of [
      ["no signature at all", { method: "PUT" as const, path: FLOOR,
        body: { mode: "off" }, omitSignature: true }],
      ["a signature from the wrong key", { method: "PUT" as const, path: FLOOR,
        body: { mode: "off" }, secret: "0".repeat(64) }],
      ["a signature over a different body", { method: "PUT" as const, path: FLOOR,
        body: { mode: "off" },
        headers: { "x-manual-signature": "v1=" + "0".repeat(64) } }],
    ] as const) {
      const response = await callControl(call);
      assert.equal(response.status, 401, name);
      assert.equal((await readInstallationShariahMode()).mode, "enforce",
        `${name} must not lower the floor`);
    }

    // Authenticated, but not a floor this receiver understands.
    for (const body of [
      { mode: "ON" },
      { mode: "enforce" },                                   // no policy identity
      { mode: "enforce", policyVersion: "TS_SHARIAH_V0" },    // the wrong one
      { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, extra: 1 },
      {},
    ]) {
      const response = await callControl({ method: "PUT", path: FLOOR, body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await readInstallationShariahMode()).mode, "enforce");
    }
  });

test("J: a replayed floor change is refused by the same nonce store as a real order",
  async () => {
    const timestamp = String(Date.now());
    const nonce = randomBytes(24).toString("base64url");
    const requestId = randomUUID();
    const body = { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION };
    const canonical = ["PUT", canonicalPath(FLOOR), timestamp, nonce, requestId,
      createHash("sha256").update(canonicalJson(body)).digest("hex")].join("\n");
    const signature =
      `v1=${createHmac("sha256", CONTROL_SECRET).update(canonical).digest("hex")}`;
    const send = () => fetch(`${baseUrl}${FLOOR}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-manual-timestamp": timestamp,
        "x-manual-nonce": nonce, "x-manual-request-id": requestId,
        "x-manual-signature": signature },
      body: JSON.stringify(body),
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 409, "the control plane replays no more than an order does");
  });

// ── K: a missing or unusable control key never falls back to unenforced ─────

test("K: with no usable control secret the floor cannot be changed, and nothing is claimed",
  async () => {
    const armedFirst = await callControl({ method: "PUT", path: FLOOR,
      body: { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION } });
    assert.equal(armedFirst.status, 200);

    for (const unusable of ["", "short", "test-only-shariah-signing-secret-0000000000"]) {
      config.manualTradingHmacSecret = unusable;
      try {
        /*
         * 503, not 200 and not a silent success. `createHmac("sha256", "")` is
         * a perfectly computable MAC, so falling through to it would make the
         * floor settable by anyone who guessed the key is unset — and answering
         * anything but an error would let the Platform record an arming that
         * never happened.
         */
        for (const method of ["GET", "PUT"] as const) {
          const response = await callControl({ method, path: FLOOR,
            secret: unusable, ...(method === "PUT" ? { body: { mode: "off" } } : {}) });
          assert.equal(response.status, 503, `${method} with secret ${JSON.stringify(unusable)}`);
        }
      } finally {
        config.manualTradingHmacSecret = CONTROL_SECRET;
      }
      assert.equal((await readInstallationShariahMode()).mode, "enforce",
        "an unusable key must never quietly lower the floor");
    }
  });

test("K: a malformed control key fails config validation whether or not manual trading is on",
  () => {
    const priorEnabled = config.manualTradingEnabled;
    const priorSecret = config.manualTradingHmacSecret;
    try {
      const has = (needle: string): boolean =>
        collectConfigErrors().some((e) => e.includes(needle));

      // The coupling that was the defect: with manual trading off, a short or
      // placeholder control key used to be accepted without a word.
      config.manualTradingEnabled = false;
      config.manualTradingHmacSecret = "too-short";
      assert.equal(has("at least 32 characters"), true);

      config.manualTradingHmacSecret = "test-only-shariah-signing-secret-0000000000";
      assert.equal(has("published placeholder"), true);

      // Absent is still allowed with manual trading off — the installation may
      // genuinely have no execution control channel, and the route refuses at
      // request time rather than the process refusing to boot.
      config.manualTradingHmacSecret = "";
      assert.equal(collectConfigErrors().some((e) => e.includes("MANUAL_TRADING_HMAC_SECRET")),
        false);

      // ...but manual trading still requires one, exactly as before.
      config.manualTradingEnabled = true;
      assert.equal(has("must be set when manual trading is enabled"), true);

      config.manualTradingHmacSecret = CONTROL_SECRET;
      assert.equal(collectConfigErrors().some((e) => e.includes("MANUAL_TRADING_HMAC_SECRET")),
        false);
    } finally {
      config.manualTradingEnabled = priorEnabled;
      config.manualTradingHmacSecret = priorSecret;
    }
  });
