/**
 * Final Shariah exposure enforcement.
 *
 * The Platform decides; this bot only refuses to CREATE exposure against an
 * authenticated decision that does not say ELIGIBLE. These tests hold that line
 * from both directions:
 *
 *   - a BUY that must not happen reaches no exchange, and claims no reservation;
 *   - a SELL is never refused on Shariah grounds, whatever the status says.
 *
 * Everything runs against the suite's mocked exchange. No network, no Binance.
 */
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExchangeAccount } from "@prisma/client";

/*
 * This file owns its own database.
 *
 * `node --test` runs test files as parallel processes, and the reliability
 * suite deletes and re-migrates the shared fixture database in its own `before`
 * hook. A second real-database suite therefore has to be isolated, or the two
 * race over the same file. The URL has to be chosen before anything constructs
 * the Prisma client, which is why every module below is imported dynamically.
 */
const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".shariah-test.db");
process.env.DATABASE_URL = "file:./tests/.shariah-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { processWebhook } = await import("../src/services/webhook.js");
const { submitManualOrder } = await import("../src/services/manualTrading.js");
const { AuthorizationNonceReplayError, reserveStrategyIntent } =
  await import("../src/services/strategyOrderIntent.js");
const { authorizationNonceHash } = await import("../src/services/shariah.js");
const { reconcileStrategyIntent, strategyMarketAdapter } =
  await import("../src/services/strategyOrderIntent.js");
const { marketBuyQuote, marketSellBase } = await import("../src/services/binance.js");
const {
  admitSpotEntry, clearanceForPersistedEntry, readShariahContext,
  ShariahEnforcementError, shariahScopeForBot,
} = await import("../src/services/shariah.js");
const { signManualRequest, verifyManualRequest } =
  await import("../src/services/manualAuth.js");
const {
  httpStatusFor, mayAdvanceLocalState, orderPlaced, shariahEvidenceCanonical,
  SHARIAH_EVIDENCE_MAX_AGE_MS, SHARIAH_POLICY_VERSION, validateCustomBotPayload,
  validateShariahContext,
} = await import("../src/contract/webhookContract.js");
const {
  clearanceForFirstSubmission, readInstallationShariahMode, readShariahMode,
  setInstallationShariahMode, shariahScopeForManualAccount, verifyShariahEvidence,
} = await import("../src/services/shariah.js");
const { reconcileOneManualOrder } = await import("../src/services/manualTrading.js");
const { createHmac, randomBytes } = await import("node:crypto");
const { webhookSchema } = await import("../src/routes/webhookSchema.js");

const originalDryRun = config.dryRun;
const originalManual = config.manualTradingEnabled;

// A refusal must be provable as "no order was sent", which the suite's default
// DRY_RUN=true would hide: it returns a simulated fill without ever reaching
// `client.order`. Real (mocked) submission makes a missing gate visible.
config.dryRun = false;
config.manualTradingEnabled = true;
// Non-secret fixture. It is the shared Platform/Bot signing key in this suite,
// and nothing here reaches a network.
const originalHmacSecret = config.manualTradingHmacSecret;
config.manualTradingHmacSecret = "test-only-shariah-signing-secret-0000000000";

after(async () => {
  config.dryRun = originalDryRun;
  config.manualTradingEnabled = originalManual;
  config.manualTradingHmacSecret = originalHmacSecret;
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

let seq = 0;
const uniq = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${seq++}`;

const eligible = (over: Record<string, unknown> = {}) => ({
  mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, assetId: "reg_apt_0001",
  baseAsset: "APT", effectiveStatus: "ELIGIBLE", publicationId: "pub_2026_09_02", ...over,
});

/*
 * What the Platform emits on the DIRECT webhook path.
 *
 * That path authenticates the sender with a shared secret carried in the body,
 * which authorises placing an order but proves nothing about a screening
 * decision — so the decision travels with a detached signature of its own,
 * keyed by the secret only the Platform and this bot share. A TradingView alert
 * can produce the body but not this.
 */
function signedShariah(
  symbol: string, side: "buy" | "sell", context: Record<string, unknown>,
  over: { timestamp?: string; secret?: string; nonce?: string } = {}
) {
  const timestamp = over.timestamp ?? String(Date.now());
  // Mirrors the Platform's `mintShariahNonce`: 24 CSPRNG bytes, base64url.
  const nonce = over.nonce ?? randomBytes(24).toString("base64url");
  const canonical = shariahEvidenceCanonical({
    symbol, side, timestamp, nonce, context: context as never });
  const secret = over.secret ?? config.manualTradingHmacSecret;
  return {
    shariah: context,
    shariah_ts: timestamp,
    shariah_nonce: nonce,
    shariah_sig: `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
  };
}

/** A Binance client that records every order it is asked to place. */
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

async function createBot(over: Record<string, unknown> = {}) {
  return prisma.signalBot.create({ data: {
    name: "Shariah fixture", webhookSecret: uniq("shariah-secret-0000000000000000000000"),
    pairs: JSON.stringify(["APTUSDT", "BTCUSDT"]), entryEnabled: true, exitEnabled: true,
    ...over,
  } });
}

async function createAccount(): Promise<ExchangeAccount> {
  return prisma.exchangeAccount.create({ data: {
    name: "Shariah manual fixture", exchange: "binance", marketType: "spot",
    apiKeyEnc: "unused", apiSecretEnc: "unused", testnet: true,
  } });
}

/** A manual adapter that records submissions instead of reaching an exchange. */
function recordingManualAdapter() {
  const submits: Array<{ symbol: string; side: string }> = [];
  return {
    submits,
    adapter: {
      submit: async (intent: { symbol: string; side: string; clientOrderId: string }) => {
        submits.push({ symbol: intent.symbol, side: intent.side });
        return { exchangeOrderId: `ex-${submits.length}`, clientOrderId: intent.clientOrderId,
          status: "FILLED" as const, executedBaseQuantity: 1, executedQuoteQuantity: 100,
          averagePrice: 100, simulated: false };
      },
      query: async () => null,
      cancel: async () => { throw new Error("not used"); },
      ticker: async () => 100,
      baseTotal: async () => 10,
    },
  };
}

afterEach(async () => {
  await prisma.shariahEnforcement.deleteMany();
});

// ── The block itself ────────────────────────────────────────────────────────

test("a well-formed enforce block is accepted and normalised", () => {
  const result = validateShariahContext(eligible());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.context.effectiveStatus, "ELIGIBLE");
  assert.equal(result.ok && result.context.publicationId, "pub_2026_09_02");
});

test("the block rejects unknown keys, arrays, and prototype-shaped input", () => {
  for (const bad of [
    eligible({ extra: 1 }),
    // `JSON.parse` materialises this as an OWN key, so the unknown-key sweep is
    // what stops it — not member access resolving up the prototype chain.
    JSON.parse('{"mode":"off","__proto__":{"polluted":true}}'),
    [eligible()],
    "enforce",
    42,
  ]) {
    const result = validateShariahContext(bad);
    assert.equal(result.ok, false, `accepted: ${JSON.stringify(bad)}`);
    assert.equal(result.ok === false && result.code, "SHARIAH_CONTEXT_INVALID");
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a wrong policy version fails closed with its own code", () => {
  const result = validateShariahContext(eligible({ policyVersion: "TS_SHARIAH_V2" }));
  assert.equal(result.ok === false && result.code, "SHARIAH_POLICY_MISMATCH");
});

test("every required enforce field is required", () => {
  for (const missing of ["policyVersion", "assetId", "baseAsset", "effectiveStatus"]) {
    const body = eligible();
    delete (body as Record<string, unknown>)[missing];
    assert.equal(validateShariahContext(body).ok, false, `${missing} was optional`);
  }
});

test("a null publication is legitimate only for an unresolved REVIEW", () => {
  assert.equal(
    validateShariahContext(eligible({ effectiveStatus: "REVIEW", publicationId: null })).ok, true);
  for (const effectiveStatus of ["ELIGIBLE", "EXCLUDED"]) {
    const result = validateShariahContext(eligible({ effectiveStatus, publicationId: null }));
    assert.equal(result.ok, false, `${effectiveStatus} accepted a null publication`);
  }
});

test("an unrecognised status never becomes a decision", () => {
  for (const effectiveStatus of ["UNSCREENED", "STALE", "eligible", ""]) {
    assert.equal(validateShariahContext(eligible({ effectiveStatus })).ok, false, effectiveStatus);
  }
});

test("mode off carries no decision and needs none", () => {
  const result = validateShariahContext({ mode: "off" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.context.mode, "off");
});

test("the route passes the block through, and the shared validator is what refuses it", () => {
  const base = { secret: "s".repeat(40), action: "buy", symbol: "APTUSDT",
    quote_order_qty: 100, dedupe_key: "L-1700000000000" };

  // The route accepts the block unexamined, deliberately: validating it here
  // would let a malformed block 400 the whole request — and that request could
  // be a SELL. Interpreting it is the service's job.
  for (const shariah of [eligible(), { mode: "sometimes" }, eligible({ extra: 1 })]) {
    assert.equal(webhookSchema.safeParse({ ...base, shariah }).success, true);
  }
  // Every OTHER unknown field is still rejected at the edge.
  assert.equal(webhookSchema.safeParse({ ...base, smuggled: 1 }).success, false);

  // The shared contract validator is the single place those rules live.
  assert.equal(validateCustomBotPayload({ ...base, shariah: eligible() }).ok, true);
  assert.equal(validateCustomBotPayload({ ...base, shariah: { mode: "sometimes" } }).ok, false);
  assert.equal(validateCustomBotPayload({ ...base, shariah: eligible({ extra: 1 }) }).ok, false);

  // And a malformed block refuses the BUY with a Shariah code, not a 400.
  assert.throws(() => readShariahContext({ mode: "sometimes" }),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_CONTEXT_INVALID");
});

test("a failed latch write still lets the exit through", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await prisma.smartTrade.create({ data: {
    botId: bot.id, source: "strategy", botName: bot.name, pair: "APTUSDT",
    direction: "long", status: "active", entryPrice: 100, currentPrice: 100,
    buyPrice: 100, quantity: 1, quoteSpent: 100,
  } });

  // The latch write is bookkeeping. A database fault during it must not become
  // the reason a position cannot be closed.
  const delegate = prisma.shariahEnforcement as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalFind = delegate.findUnique;
  delegate.findUnique = async () => { throw new Error("simulated database fault"); };
  try {
    const exit = await processWebhook(
      { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT",
        dedupe_key: uniq("X"), shariah: eligible() },
      { clientFactory: async () => client as never });
    assert.equal(exit.status, "ok");
    assert.equal(orders.length, 1);
    assert.equal(orders[0].side, "SELL");
  } finally {
    delegate.findUnique = originalFind;
  }
});

test("the blocked outcome tells a sender it is still flat, with a 409", () => {
  assert.equal(httpStatusFor("shariah_blocked"), 409);
  assert.equal(orderPlaced("shariah_blocked"), false);
  assert.equal(mayAdvanceLocalState("shariah_blocked"), false);
});

// ── Mode OFF and absence are unchanged ──────────────────────────────────────

test("a BUY with no Shariah block behaves exactly as before", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT",
      quote_order_qty: 100, dedupe_key: uniq("L") },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].side, "BUY");
});

test("a BUY with mode off behaves exactly as before", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), ...signedShariah("APTUSDT", "buy", { mode: "off" }) },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
  assert.equal(JSON.parse(intent.shariahContext ?? "{}").mode, "off");
});

test("an UNSIGNED mode-off block on the webhook path is recorded as no decision", async () => {
  /*
   * The body's only authentication is the shared secret it carries, so `off`
   * asserted there is the sender of an order claiming policy does not apply to
   * it. The order still goes through — nothing is enforcing — but it is not
   * persisted as a decision the Platform made, because the Platform did not
   * make it, and a later recovery must not re-read it as one.
   */
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), shariah: { mode: "off" } },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
  assert.equal(intent.shariahContext, null);
});

// ── Mode ON: entries ────────────────────────────────────────────────────────

test("enforce + ELIGIBLE places the entry normally", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), shariah: eligible() },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
});

test("REVIEW, EXCLUDED, a wrong policy, a missing field and a mismatched base all refuse a BUY, and none reaches the exchange", async () => {
  const cases: Array<[unknown, string]> = [
    [eligible({ effectiveStatus: "REVIEW" }), "SHARIAH_REVIEW_BLOCKED"],
    [eligible({ effectiveStatus: "REVIEW", publicationId: null }), "SHARIAH_REVIEW_BLOCKED"],
    [eligible({ effectiveStatus: "EXCLUDED" }), "SHARIAH_EXCLUDED_BLOCKED"],
    [eligible({ policyVersion: "TS_SHARIAH_V2" }), "SHARIAH_POLICY_MISMATCH"],
    [{ mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION, effectiveStatus: "ELIGIBLE" },
      "SHARIAH_CONTEXT_INVALID"],
    // An ELIGIBLE proof for BTC must not authorise a BUY of APTUSDT.
    [eligible({ baseAsset: "BTC", assetId: "reg_btc_0001" }), "SHARIAH_ASSET_MISMATCH"],
    // Nor may a base that merely prefixes the symbol satisfy it.
    [eligible({ baseAsset: "APTUSD" }), "SHARIAH_ASSET_MISMATCH"],
  ];
  for (const [shariah, code] of cases) {
    const bot = await createBot();
    const { client, orders } = recordingClient();
    let clientAsked = false;
    const result = await processWebhook(
      { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
        dedupe_key: uniq("L"), shariah },
      { clientFactory: async () => { clientAsked = true; return client as never; } });

    assert.equal(result.status, "shariah_blocked", JSON.stringify(shariah));
    assert.equal((result.detail as { code: string }).code, code);
    assert.equal(orders.length, 0, "a refused BUY reached the exchange");
    assert.equal(clientAsked, false, "a refused BUY read exchange credentials");
    // Nothing was claimed: no durable intent, so no client order id was burned.
    assert.equal(await prisma.strategyOrderIntent.count({ where: { botId: bot.id } }), 0);
    const log = await prisma.webhookLog.findFirstOrThrow({
      where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
    assert.equal(log.status, "blocked");
    assert.ok(log.message?.startsWith(code), log.message ?? "");
  }
});

test("a refused BUY is distinguishable from a halt and from a risk refusal", async () => {
  const bot = await createBot();
  const { client } = recordingClient();
  const blocked = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), shariah: eligible({ effectiveStatus: "EXCLUDED" }) },
    { clientFactory: async () => client as never });
  assert.equal(blocked.status, "shariah_blocked");
  assert.notEqual(blocked.status, "halted");
  assert.notEqual(blocked.status, "risk_blocked");
});

// ── Anti-downgrade ──────────────────────────────────────────────────────────

test("once a scope has been told to enforce, omitting the block no longer buys", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const call = (extra: Record<string, unknown> = {}) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), ...extra },
    { clientFactory: async () => client as never });

  assert.equal((await call(signedShariah("APTUSDT", "buy", eligible()))).status, "ok");
  assert.equal(orders.length, 1);

  // The same sender, now simply leaving the block out.
  const downgraded = await call();
  assert.equal(downgraded.status, "shariah_blocked");
  assert.equal((downgraded.detail as { code: string }).code, "SHARIAH_CONTEXT_REQUIRED");
  assert.equal(orders.length, 1);

  // A malformed block is not a way back to mode off either.
  const malformed = await call(signedShariah("APTUSDT", "buy",
    { mode: "enforce", policyVersion: "TS_SHARIAH_V2" }));
  assert.equal(malformed.status, "shariah_blocked");
  assert.equal(orders.length, 1);

  // Turning it off again takes an explicit, equally authenticated statement —
  // and on this path "equally authenticated" means signed. An UNSIGNED off
  // block is exactly the downgrade v4 exists to refuse.
  assert.equal((await call({ shariah: { mode: "off" } })).status, "shariah_blocked");
  assert.equal(orders.length, 1);

  assert.equal((await call(signedShariah("APTUSDT", "buy", { mode: "off" }))).status, "ok");
  assert.equal(orders.length, 2);
});

test("enforcement is remembered per scope, never globally", async () => {
  const enforcing = await createBot();
  const untouched = await createBot();
  const { client, orders } = recordingClient();
  await processWebhook(
    { secret: enforcing.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), shariah: eligible() },
    { clientFactory: async () => client as never });

  // A bot whose owner never enabled Shariah mode keeps its existing behaviour.
  const other = await processWebhook(
    { secret: untouched.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L") },
    { clientFactory: async () => client as never });
  assert.equal(other.status, "ok");
  assert.equal(orders.length, 2);
});

// ── The installation floor, and the first-webhook bypass it closes ──────────

/*
 * The defect these cover, exactly as it was:
 *
 *   1. the operator enables Shariah Mode on the Platform;
 *   2. no Shariah-carrying request has reached this bot on the WEBHOOK scope
 *      (and none ever could — a manual Platform order latches
 *      `manual-account:<id>`, a different scope entirely);
 *   3. a direct TradingView alert fires a BUY carrying no block;
 *   4. `bot:<id>` has no row, so the latch reads `off`;
 *   5. the BUY is admitted ungated and reaches the exchange.
 *
 * Step 2 is what made it permanent rather than transitional: nothing the
 * Platform did could ever arm the scope the webhook path reads.
 */

test("the installation floor is what a webhook scope reads, and only the control channel sets it", async () => {
  const bot = await createBot();
  const scope = shariahScopeForBot(bot.id);
  assert.equal(await readShariahMode(scope), "off");

  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  assert.equal(await readShariahMode(scope), "enforce",
    "a scope with no row of its own must still read the floor");
  assert.deepEqual(await readInstallationShariahMode(),
    { mode: "enforce", policyVersion: SHARIAH_POLICY_VERSION });

  // A scope row saying `off` cannot shadow the floor: strictest wins.
  await prisma.shariahEnforcement.upsert({
    where: { scope }, create: { scope, mode: "off", policyVersion: null },
    update: { mode: "off", policyVersion: null } });
  assert.equal(await readShariahMode(scope), "enforce");

  await setInstallationShariahMode("off", null);
  assert.equal(await readShariahMode(scope), "off");
});

test("Shariah mode ON cannot have an ungated FIRST direct webhook BUY", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();

  // The operator turns Shariah Mode on. Nothing else has happened: this bot has
  // never seen a Shariah block, and its own scope has no row.
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  assert.equal(
    await prisma.shariahEnforcement.findUnique({ where: { scope: shariahScopeForBot(bot.id) } }),
    null);

  // The very first direct TradingView alert. It cannot produce a block.
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W") },
    { clientFactory: async () => client as never });

  assert.equal(result.status, "shariah_blocked");
  assert.equal((result.detail as { code: string }).code, "SHARIAH_CONTEXT_REQUIRED");
  assert.equal(orders.length, 0, "no order may reach the exchange");
  assert.equal(await prisma.strategyOrderIntent.count({ where: { botId: bot.id } }), 0,
    "and no durable intent may be claimed");
});

test("a manual account latching enforce does not, by itself, gate the webhook scope", async () => {
  /*
   * The scopes are deliberately separate, and must stay so: enabling
   * enforcement for one sender must not switch it on for another. This pins the
   * reason the FLOOR — not scope bleed — is what closes the webhook path.
   */
  const bot = await createBot();
  const account = await createAccount();
  const manualScope = shariahScopeForManualAccount(account.id);
  await admitSpotEntry({ scope: manualScope, symbol: "APTUSDT",
    context: readShariahContext(eligible()), auth: { kind: "request-signature" } });
  assert.equal(await readShariahMode(manualScope), "enforce");
  assert.equal(await readShariahMode(shariahScopeForBot(bot.id)), "off");
});

test("under the floor, a direct webhook BUY needs a SIGNED decision — and gets one from the Platform", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const call = (extra: Record<string, unknown>) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...extra },
    { clientFactory: async () => client as never });

  // An unsigned ELIGIBLE is the forgery the bot secret alone would have bought:
  // its holder may place an order, but may not certify one.
  const forged = await call({ shariah: eligible() });
  assert.equal(forged.status, "shariah_blocked");
  assert.equal((forged.detail as { code: string }).code, "SHARIAH_EVIDENCE_UNVERIFIED");
  assert.equal(orders.length, 0);

  // The Platform's own delivery carries the detached signature, and executes.
  assert.equal((await call(signedShariah("APTUSDT", "buy", eligible()))).status, "ok");
  assert.equal(orders.length, 1);
});

test("a signature is bound to its symbol, its side, its decision and its time", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const call = (symbol: string, extra: Record<string, unknown>) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol, quote_order_qty: 100,
      dedupe_key: uniq("W"), ...extra },
    { clientFactory: async () => client as never });

  // Lifted onto a different symbol.
  const btc = { ...eligible(), assetId: "reg_btc_0001", baseAsset: "BTC" };
  const lifted = signedShariah("APTUSDT", "buy", btc);
  assert.equal((await call("BTCUSDT", lifted)).status, "shariah_blocked");

  // Lifted from the sell side.
  assert.equal((await call("APTUSDT", signedShariah("APTUSDT", "sell", eligible()))).status,
    "shariah_blocked");

  // Every field of the decision is covered: flip one, keep the signature.
  const signed = signedShariah("APTUSDT", "buy", eligible());
  for (const field of
    ["mode", "policyVersion", "assetId", "baseAsset", "effectiveStatus", "publicationId"]) {
    const tampered = { ...signed, shariah: { ...eligible(), [field]:
      field === "mode" ? "off"
        : field === "effectiveStatus" ? "ELIGIBLE"
          : `${(eligible() as Record<string, string>)[field]}x` } };
    if (field === "effectiveStatus") continue;   // unchanged value proves nothing
    const out = await call("APTUSDT", tampered);
    assert.equal(out.status, "shariah_blocked", `${field} was not covered by the signature`);
  }

  // Expired.
  const stale = signedShariah("APTUSDT", "buy", eligible(),
    { timestamp: String(Date.now() - SHARIAH_EVIDENCE_MAX_AGE_MS - 1000) });
  assert.equal((await call("APTUSDT", stale)).status, "shariah_blocked");

  // Signed with the wrong key.
  const wrongKey = signedShariah("APTUSDT", "buy", eligible(),
    { secret: "some-other-installation-secret-000000000000" });
  assert.equal((await call("APTUSDT", wrongKey)).status, "shariah_blocked");

  assert.equal(orders.length, 0, "not one of these may reach the exchange");
});

test("an unproven decision may still REFUSE an entry; it may only never authorise one", async () => {
  /*
   * The signature requirement must not become a safety regression. Before it
   * existed an unsigned EXCLUDED block did block a BUY even with nothing
   * enforcing, and that must still hold — otherwise adding authentication would
   * have opened a hole rather than closed one.
   */
  const bot = await createBot();
  const { client, orders } = recordingClient();
  for (const effectiveStatus of ["REVIEW", "EXCLUDED"]) {
    const result = await processWebhook(
      { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
        dedupe_key: uniq("U"), shariah: eligible({ effectiveStatus }) },
      { clientFactory: async () => client as never });
    assert.equal(result.status, "shariah_blocked", effectiveStatus);
  }
  // A mismatched base asset is refused on the same terms.
  const mismatched = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("U"), shariah: eligible({ baseAsset: "BTC", assetId: "reg_btc_0001" }) },
    { clientFactory: async () => client as never });
  assert.equal(mismatched.status, "shariah_blocked");
  assert.equal(orders.length, 0);

  // And an unsigned block never latches a scope it could not prove it speaks for.
  assert.equal(await readShariahMode(shariahScopeForBot(bot.id)), "off");
});

test("verifyShariahEvidence refuses when this bot holds no Platform signing secret", () => {
  const original = config.manualTradingHmacSecret;
  config.manualTradingHmacSecret = "";
  try {
    const result = verifyShariahEvidence({
      symbol: "APTUSDT", side: "buy", context: eligible() as never,
      signature: `v1=${"0".repeat(64)}`, timestamp: String(Date.now()) });
    assert.equal(result.ok, false);
  } finally {
    config.manualTradingHmacSecret = original;
  }
});

// ── A queued BUY may not land after enforcement begins ─────────────────────

/*
 * The gap these cover:
 *
 *   a BUY is admitted while nothing is enforcing, so it is persisted with NO
 *   decision at all. Before it reaches the exchange the process dies, leaving
 *   the intent in `requested`. The operator then turns Shariah mode ON. Thirty
 *   seconds later the reconciler picks the intent up, reads its null decision
 *   as "admitted before this feature existed", and places the order.
 *
 * The exposure would be created AFTER enforcement began, which is the one
 * thing enforcement exists to prevent. Recovery must still refuse to re-judge a
 * decision it was admitted under — but an intent with no decision was never
 * admitted under one.
 */

test("a never-submitted BUY carrying no decision cannot first reach the wire under enforcement",
  async () => {
    const bot = await createBot();
    const scope = shariahScopeForBot(bot.id);
    // Admitted while nothing was enforcing: no decision was ever rendered.
    assert.equal(
      (await admitSpotEntry({ scope, symbol: "APTUSDT", context: undefined,
        auth: { kind: "request-signature" } })).persisted, null);

    await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);

    await assert.rejects(
      () => clearanceForFirstSubmission({ scope, symbol: "APTUSDT", persisted: null }),
      (error: unknown) => error instanceof ShariahEnforcementError &&
        error.code === "SHARIAH_CONTEXT_REQUIRED");
  });

test("the same intent still submits freely while nothing is enforcing", async () => {
  const bot = await createBot();
  const clearance = await clearanceForFirstSubmission({
    scope: shariahScopeForBot(bot.id), symbol: "APTUSDT", persisted: null });
  assert.equal(clearance.mode, "off");
});

test("a never-submitted BUY that DOES carry a decision keeps it, and is never re-judged",
  async () => {
    const bot = await createBot();
    const scope = shariahScopeForBot(bot.id);
    const persisted = JSON.stringify(eligible());
    await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
    const clearance = await clearanceForFirstSubmission({ scope, symbol: "APTUSDT", persisted });
    assert.equal(clearance.mode, "enforce");
    assert.equal(clearance.effectiveStatus, "ELIGIBLE");

    // And a stored decision that does not permit entry still refuses, exactly
    // as it did before the floor existed.
    await assert.rejects(
      () => clearanceForFirstSubmission({ scope, symbol: "APTUSDT",
        persisted: JSON.stringify(eligible({ effectiveStatus: "EXCLUDED" })) }),
      (error: unknown) => error instanceof ShariahEnforcementError &&
        error.code === "SHARIAH_EXCLUDED_BLOCKED");
  });

test("the strategy reconciler refuses to first-submit a decision-less BUY under enforcement",
  async () => {
    const bot = await createBot();
    const { client, orders } = recordingClient();
    // Admitted while nothing was enforcing, so it carries no decision, and
    // stranded in `requested` — nothing was ever sent.
    const intent = await prisma.strategyOrderIntent.create({ data: {
      sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
      clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
      status: "requested", shariahContext: null,
    } });

    // While nothing enforces, that recovery still works exactly as before.
    const recovered = await reconcileStrategyIntent(
      intent.id, strategyMarketAdapter(client as never, false));
    assert.equal(recovered.intent.status, "reconciled");
    assert.equal(orders.length, 1);

    // The same situation, now with the operator enforcing.
    const stranded = await prisma.strategyOrderIntent.create({ data: {
      sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
      clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
      status: "requested", shariahContext: null,
    } });
    await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
    await assert.rejects(
      () => reconcileStrategyIntent(stranded.id, strategyMarketAdapter(client as never, false)),
      (error: unknown) => error instanceof ShariahEnforcementError &&
        error.code === "SHARIAH_CONTEXT_REQUIRED");
    assert.equal(orders.length, 1, "no further order may reach the exchange");
  });

test("the manual reconciler refuses to first-submit a decision-less BUY under enforcement",
  async () => {
    const account = await createAccount();
    const { submits, adapter } = recordingManualAdapter();
    const order = await prisma.manualOrder.create({ data: {
      requestId: uniq("mo"), exchangeAccountId: account.id, symbol: "APTUSDT", side: "BUY",
      orderType: "MARKET", quantityType: "quote", requestedQuoteQty: 100,
      status: "requested", clientOrderId: uniq("bot-"), shariahContext: null } });

    // While nothing enforces, the stalled order is resubmitted as before.
    const before = await reconcileOneManualOrder(
      { ...order, exchangeAccount: account } as never, adapter as never);
    assert.ok(before, "a stalled order must still recover when nothing is enforcing");
    assert.equal(submits.length, 1);

    await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
    await assert.rejects(
      () => reconcileOneManualOrder({ ...order, exchangeAccount: account } as never,
        adapter as never),
      (error: unknown) => error instanceof ShariahEnforcementError &&
        error.code === "SHARIAH_CONTEXT_REQUIRED");
    assert.equal(submits.length, 1, "no further submission may reach the exchange");
  });

test("an interrupted SELL always completes, enforcing or not", async () => {
  const account = await createAccount();
  const { submits, adapter } = recordingManualAdapter();
  const order = await prisma.manualOrder.create({ data: {
    requestId: uniq("mo"), exchangeAccountId: account.id, symbol: "APTUSDT", side: "SELL",
    orderType: "MARKET", quantityType: "base", requestedBaseQty: 1,
    status: "requested", clientOrderId: uniq("bot-"), shariahContext: null } });
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const snapshot = await reconcileOneManualOrder(
    { ...order, exchangeAccount: account } as never, adapter as never);
  assert.ok(snapshot, "an exit interrupted mid-flight must always be able to finish");
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.side, "SELL");
});

// ── SELL is never refused ───────────────────────────────────────────────────

test("a SELL is placed for every status, including one that became EXCLUDED", async () => {
  for (const effectiveStatus of ["ELIGIBLE", "REVIEW", "EXCLUDED"]) {
    const bot = await createBot();
    const { client, orders } = recordingClient();
    await prisma.smartTrade.create({ data: {
      botId: bot.id, source: "strategy", botName: bot.name, pair: "APTUSDT",
      direction: "long", status: "active", entryPrice: 100, currentPrice: 100,
      buyPrice: 100, quantity: 1, quoteSpent: 100,
    } });
    const result = await processWebhook(
      { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT",
        dedupe_key: uniq("X"), shariah: eligible({ effectiveStatus }) },
      { clientFactory: async () => client as never });
    assert.equal(result.status, "ok", `${effectiveStatus} blocked an exit`);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].side, "SELL");
  }
});

test("an exit is not refused even when its Shariah block is unusable", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await prisma.smartTrade.create({ data: {
    botId: bot.id, source: "strategy", botName: bot.name, pair: "APTUSDT",
    direction: "long", status: "active", entryPrice: 100, currentPrice: 100,
    buyPrice: 100, quantity: 1, quoteSpent: 100,
  } });
  const result = await processWebhook(
    { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT", dedupe_key: uniq("X"),
      shariah: { mode: "enforce", policyVersion: "TS_SHARIAH_V2", baseAsset: "WRONG" } },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
});

test("an exit is still refused while enforcing if it is enforcing and latched — it is not", async () => {
  // Latch the scope to enforce with an entry, then prove the exit path is
  // untouched by it: a SELL carrying no block at all still closes.
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), shariah: eligible() },
    { clientFactory: async () => client as never });
  await prisma.smartTrade.create({ data: {
    botId: bot.id, source: "strategy", botName: bot.name, pair: "APTUSDT",
    direction: "long", status: "active", entryPrice: 100, currentPrice: 100,
    buyPrice: 100, quantity: 1, quoteSpent: 100,
  } });
  const exit = await processWebhook(
    { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT", dedupe_key: uniq("X") },
    { clientFactory: async () => client as never });
  assert.equal(exit.status, "ok");
  assert.equal(orders.filter((o) => o.side === "SELL").length, 1);
});

test("the sell wrapper has no Shariah parameter at all, so no exit can be gated", () => {
  // A structural assertion, not a behavioural one: `marketSellBase` takes three
  // arguments plus options, and `marketBuyQuote` takes the same plus a required
  // clearance. If a clearance were ever threaded into the sell path, the
  // asymmetry these tests rely on would be gone.
  assert.equal(marketSellBase.length, 3);
  assert.equal(marketBuyQuote.length, 4);
});

// ── Automated and recovery paths ────────────────────────────────────────────

test("a never-submitted BUY intent is re-gated against its ORIGINAL decision before it can claim the wire", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const intent = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
    clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "requested",
    shariahContext: JSON.stringify(eligible({ effectiveStatus: "EXCLUDED" })),
  } });

  await assert.rejects(
    () => reconcileStrategyIntent(intent.id, strategyMarketAdapter(client as never, false)),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_EXCLUDED_BLOCKED");

  assert.equal(orders.length, 0);
  // It stayed abandonable rather than being stranded past the submission claim.
  const after = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
  assert.equal(after.status, "requested");
  assert.equal(after.submittedAt, null);
});

test("a stored proof for another asset cannot authorise a recovered BUY", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const intent = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
    clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "requested",
    shariahContext: JSON.stringify(eligible({ baseAsset: "BTC", assetId: "reg_btc_0001" })),
  } });
  await assert.rejects(
    () => reconcileStrategyIntent(intent.id, strategyMarketAdapter(client as never, false)),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_ASSET_MISMATCH");
  assert.equal(orders.length, 0);
});

test("recovery reconciles an ALREADY-submitted BUY by query, without re-judging its status", async () => {
  const bot = await createBot();
  let submits = 0;
  let queries = 0;
  const adapter = {
    submit: async () => { submits++; throw new Error("recovery must not resubmit"); },
    query: async () => { queries++; return { orderId: "ex-1", executedQty: 1,
      cummulativeQuoteQty: 100, avgPrice: 100, simulated: false }; },
  };
  const intent = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
    clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "submitted", submittedAt: new Date(),
    // Deliberately a status that would refuse a NEW entry. Reconciling an order
    // that already crossed the wire is not a new exposure decision.
    shariahContext: JSON.stringify(eligible({ effectiveStatus: "EXCLUDED" })),
  } });
  const outcome = await reconcileStrategyIntent(intent.id, adapter);
  assert.equal(submits, 0);
  assert.equal(queries, 1);
  assert.equal(outcome.pending, false);
});

test("a pre-Shariah intent keeps its original ungated recovery semantics", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const intent = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
    clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "requested", shariahContext: null,
  } });
  const outcome = await reconcileStrategyIntent(intent.id, strategyMarketAdapter(client as never, false));
  assert.equal(outcome.pending, false);
  assert.equal(orders.length, 1);
});

test("the exchange wrapper refuses a BUY whose clearance names another symbol", async () => {
  const { client, orders } = recordingClient();
  await assert.rejects(
    () => marketBuyQuote(client as never, "APTUSDT", 100, {
      idempotencyScope: "swap", dryRun: false,
      shariahClearance: clearanceForPersistedEntry(
        JSON.stringify(eligible({ baseAsset: "BTC", assetId: "reg_btc_0001" })), "BTCUSDT"),
    }),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_ASSET_MISMATCH");
  assert.equal(orders.length, 0);
});

// ── The manual (HMAC) path ──────────────────────────────────────────────────

test("the manual BUY gate refuses before any reservation exists", async () => {
  const account = await createAccount();
  const { adapter, submits } = recordingManualAdapter();
  await assert.rejects(
    () => submitManualOrder({ requestId: uniq("req"), accountId: account.id, symbol: "APTUSDT",
      side: "BUY", orderType: "MARKET", quoteQuantity: 100,
      shariah: eligible({ effectiveStatus: "EXCLUDED" }) }, () => adapter as never),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_EXCLUDED_BLOCKED");
  assert.equal(submits.length, 0);
  assert.equal(await prisma.manualOrder.count({ where: { exchangeAccountId: account.id } }), 0);
});

test("the manual BUY gate admits ELIGIBLE and stores the decision it admitted under", async () => {
  const account = await createAccount();
  const { adapter, submits } = recordingManualAdapter();
  const order = await submitManualOrder({ requestId: uniq("req"), accountId: account.id,
    symbol: "APTUSDT", side: "BUY", orderType: "MARKET", quoteQuantity: 100,
    shariah: eligible() }, () => adapter as never);
  assert.equal(order.status, "filled");
  assert.equal(submits.length, 1);
  const stored = await prisma.manualOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(JSON.parse(stored.shariahContext ?? "{}").effectiveStatus, "ELIGIBLE");
});

test("a manual SELL is never refused on Shariah grounds", async () => {
  for (const effectiveStatus of ["ELIGIBLE", "REVIEW", "EXCLUDED"]) {
    const account = await createAccount();
    const { adapter, submits } = recordingManualAdapter();
    const order = await submitManualOrder({ requestId: uniq("req"), accountId: account.id,
      symbol: "APTUSDT", side: "SELL", orderType: "MARKET", baseQuantity: 1,
      shariah: eligible({ effectiveStatus }) }, () => adapter as never);
    assert.equal(order.status, "filled", `${effectiveStatus} blocked a manual exit`);
    assert.equal(submits.length, 1);
  }
});

test("a manual BUY cannot downgrade by omission once the account was told to enforce", async () => {
  const account = await createAccount();
  const { adapter, submits } = recordingManualAdapter();
  await submitManualOrder({ requestId: uniq("req"), accountId: account.id, symbol: "APTUSDT",
    side: "BUY", orderType: "MARKET", quoteQuantity: 100, shariah: eligible() },
  () => adapter as never);
  assert.equal(submits.length, 1);

  await assert.rejects(
    () => submitManualOrder({ requestId: uniq("req"), accountId: account.id, symbol: "APTUSDT",
      side: "BUY", orderType: "MARKET", quoteQuantity: 100 }, () => adapter as never),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_CONTEXT_REQUIRED");
  assert.equal(submits.length, 1);
});

// ── Signature coverage ──────────────────────────────────────────────────────

test("the manual HMAC already covers the Shariah block, and every tamper invalidates it", () => {
  const secret = "h".repeat(40);
  const now = 1_700_000_000_000;
  const body = { accountId: "acct", symbol: "APTUSDT", side: "BUY", orderType: "MARKET",
    quoteQuantity: 100, shariah: eligible() };
  const envelope = { method: "POST", path: "/api/manual-trading/orders", timestamp: String(now),
    nonce: "nonce_1234567890123456", requestId: "request_123456789012" };
  const signature = signManualRequest(secret, { ...envelope, body });

  assert.equal(
    verifyManualRequest({ secret, ...envelope, signature, body, now }).ok, true,
    "an untampered signed request must verify");

  const tampers: Array<[string, Record<string, unknown>]> = [
    // The three the audit names explicitly.
    ["status", { ...body, shariah: eligible({ effectiveStatus: "REVIEW" }) }],
    ["mode", { ...body, shariah: { ...eligible(), mode: "off" } }],
    ["baseAsset", { ...body, shariah: eligible({ baseAsset: "BTC" }) }],
    // And the rest of the block, so none of it is unsigned.
    ["policyVersion", { ...body, shariah: eligible({ policyVersion: "TS_SHARIAH_V2" }) }],
    ["assetId", { ...body, shariah: eligible({ assetId: "reg_btc_0001" }) }],
    ["publicationId", { ...body, shariah: eligible({ publicationId: "pub_other" }) }],
    // Removing the block entirely is a tamper too, not a downgrade.
    ["removal", { accountId: "acct", symbol: "APTUSDT", side: "BUY", orderType: "MARKET",
      quoteQuantity: 100 }],
  ];
  for (const [name, tampered] of tampers) {
    const result = verifyManualRequest({ secret, ...envelope, signature, body: tampered, now });
    assert.equal(result.ok, false, `${name} survived the signature`);
    assert.equal(result.ok === false && result.status, 401);
  }
});

// ── Existing protections are untouched ──────────────────────────────────────

test("BUY dedupe, the dedupe_key requirement and the global halt all behave as before", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  const key = uniq("L");
  const call = (over: Record<string, unknown> = {}) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: key, shariah: eligible(), ...over },
    { clientFactory: async () => client as never });

  assert.equal((await call()).status, "ok");
  assert.equal((await call()).status, "ignored_duplicate", "the dedupe window changed");
  assert.equal(orders.length, 1);

  await assert.rejects(() => call({ dedupe_key: undefined }), /dedupe_key is required/);

  await prisma.riskControl.upsert({ where: { id: "global" },
    create: { id: "global", tradingHalted: true }, update: { tradingHalted: true } });
  try {
    const halted = await call({ dedupe_key: uniq("L") });
    assert.equal(halted.status, "halted", "the operator halt no longer precedes the entry");
    assert.equal(orders.length, 1);
  } finally {
    await prisma.riskControl.update({ where: { id: "global" }, data: { tradingHalted: false } });
  }
});

test("a concurrent block-less BUY cannot slip through while the latch is being armed", async () => {
  const bot = await createBot();
  const scope = shariahScopeForBot(bot.id);

  // Hold the latch write open, which is exactly the window a racing request
  // would have exploited: it used to read "off" before the write landed and be
  // admitted ungated — and an intent admitted with no decision stays ungated
  // through every later recovery, so the gap would have been permanent.
  const delegate = prisma.shariahEnforcement as unknown as
    Record<string, (...args: unknown[]) => Promise<unknown>>;
  const originalUpsert = delegate.upsert;
  delegate.upsert = async (...args: unknown[]) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return originalUpsert.apply(prisma.shariahEnforcement, args);
  };
  try {
    const arming = admitSpotEntry({ scope, symbol: "APTUSDT",
      context: readShariahContext(eligible()), auth: { kind: "request-signature" } });
    const racing = admitSpotEntry({ scope, symbol: "APTUSDT", context: undefined,
      auth: { kind: "request-signature" } });

    await assert.rejects(() => racing,
      (error: unknown) => error instanceof ShariahEnforcementError &&
        error.code === "SHARIAH_CONTEXT_REQUIRED");
    assert.equal((await arming).persisted !== null, true);
  } finally {
    delegate.upsert = originalUpsert;
  }
});

test("a Shariah refusal at submission ends the intent instead of leaving it pending", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  // A stored decision that admission could not have produced — the shape a
  // hand-edited or corrupted row would have. It must terminate, not hang.
  const intent = await prisma.strategyOrderIntent.create({ data: {
    sourceKey: uniq("scope"), botId: bot.id, botName: bot.name,
    clientOrderId: uniq("client"), symbol: "APTUSDT", side: "BUY", requestedQuoteQty: 100,
    status: "submitted", submittedAt: new Date(),
    shariahContext: JSON.stringify(eligible()),
  } });
  // Force the submit path for an already-attempted intent by resetting it to
  // `requested` only after the durable row exists, mirroring a crash-recovery
  // pass that finds a never-attempted intent.
  await prisma.strategyOrderIntent.update({ where: { id: intent.id },
    data: { status: "requested", submittedAt: null,
      shariahContext: JSON.stringify(eligible({ baseAsset: "BTC", assetId: "reg_btc" })) } });

  await assert.rejects(() => reconcileStrategyIntent(
    intent.id, strategyMarketAdapter(client as never, false)));
  assert.equal(orders.length, 0);
  const settled = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
  // Refused before the submission claim, so it stays retryable rather than
  // being stranded in `submitted` against an order that does not exist.
  assert.equal(settled.status, "requested");
});

test("the admission helper writes nothing when it refuses", async () => {
  const bot = await createBot();
  const scope = shariahScopeForBot(bot.id);
  await assert.rejects(
    () => admitSpotEntry({ scope, symbol: "APTUSDT",
      context: readShariahContext(eligible({ effectiveStatus: "REVIEW" })),
      auth: { kind: "request-signature" } }),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_REVIEW_BLOCKED");
  // The latch still moved: the sender authentically said it is enforcing, and
  // that statement is what a later omission is measured against.
  const row = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  assert.equal(row?.mode, "enforce");
});

// ── Single-use authorisation: the replay defence (contract v5) ──────────────
//
// Everything above proves the Platform is the only thing that can CERTIFY a
// BUY. Everything below proves it can only certify one at a time.
//
// The weakness these close: a v4 signature named a symbol, a side, a decision
// and a time — nothing that identified the ORDER. Every ordinary idempotency
// control on this receiver is keyed by `dedupe_key`, which the sender of the
// replay chooses, so a captured payload re-sent with a new key looked like a
// brand new order to all of them. The only thing bounding it was the freshness
// window, which is an expiry, not a defence.
//
// No network and no Binance: every submission below goes to `recordingClient`.

/** One enforcing installation, one bot, one recording exchange. */
async function replayFixture() {
  // A generous per-Bot allowance. Investment sizing is a different control with
  // its own tests; leaving the default here would let it refuse an entry these
  // tests expect to succeed, and a green suite would be proving the wrong thing.
  const bot = await createBot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 10_000 });
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const call = (extra: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    processWebhook(
      { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
        dedupe_key: uniq("W"), ...extra, ...over },
      { clientFactory: async () => client as never });
  return { bot, client, orders, call };
}

test("A: one valid ELIGIBLE signed webhook BUY reaches the mocked exchange", async () => {
  const { orders, call } = await replayFixture();
  const out = await call(signedShariah("APTUSDT", "buy", eligible()));

  assert.equal(out.status, "ok");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].side, "BUY");
  assert.equal(orderPlaced("ok"), true);
});

test("B: an EXACT replay of the same payload places no second order", async () => {
  const { orders, call } = await replayFixture();
  const evidence = signedShariah("APTUSDT", "buy", eligible());
  const dedupe_key = uniq("W");

  assert.equal((await call(evidence, { dedupe_key })).status, "ok");
  const replayed = await call(evidence, { dedupe_key });

  /*
   * Byte-identical, so it is indistinguishable from the sender's own delivery
   * retry — and it is answered as one. The ordinary caller-key guard suppresses
   * it, which is the correct outcome: `ignored_duplicate` truthfully tells the
   * sender the original order did execute.
   *
   * What matters, and what is asserted, is that no SECOND order exists.
   */
  assert.equal(replayed.status, "ignored_duplicate");
  assert.equal(orderPlaced(replayed.status as never), false);
  assert.equal(orders.length, 1);
});

test("C: the same signed evidence under a FRESH dedupe key is refused as a replay",
  async () => {
    const { orders, call } = await replayFixture();
    const evidence = signedShariah("APTUSDT", "buy", eligible());

    assert.equal((await call(evidence, { dedupe_key: uniq("W") })).status, "ok");

    /*
     * THE weakness. Under v4 this was an `ok` and a second position: a fresh
     * `dedupe_key` produces a fresh caller key, a fresh `sourceKey` and a fresh
     * `clientOrderId`, so every idempotency control on this path saw a new
     * order — and the evidence was still inside its freshness window, so the
     * signature verified.
     */
    const replayed = await call(evidence, { dedupe_key: uniq("W") });
    assert.equal(replayed.status, "shariah_blocked");
    assert.equal((replayed.detail as { code: string }).code, "SHARIAH_EVIDENCE_REPLAYED");
    assert.equal(orders.length, 1, "a replay must not create a second position");

    // And the refusal is a refusal: the sender is told it is still flat.
    assert.equal(mayAdvanceLocalState("shariah_blocked"), false);
    assert.equal(httpStatusFor("shariah_blocked"), 409);
  });

test("C2: changing the dedupe key ANY number of times never buys twice", async () => {
  const { orders, call } = await replayFixture();
  const evidence = signedShariah("APTUSDT", "buy", eligible());

  assert.equal((await call(evidence, { dedupe_key: uniq("W") })).status, "ok");
  for (let i = 0; i < 8; i++) {
    const out = await call(evidence, { dedupe_key: uniq("W") });
    assert.equal(out.status, "shariah_blocked");
    assert.equal((out.detail as { code: string }).code, "SHARIAH_EVIDENCE_REPLAYED");
  }
  assert.equal(orders.length, 1);
});

test("D: the same nonce lifted onto a different symbol fails its binding", async () => {
  const bot = await createBot();
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const evidence = signedShariah("APTUSDT", "buy", eligible());
  const nonce = evidence.shariah_nonce;

  // Keep the nonce and the signature; change the symbol the order names.
  const out = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "BTCUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...evidence },
    { clientFactory: async () => client as never });

  assert.equal(out.status, "shariah_blocked");
  /*
   * SHARIAH_ASSET_MISMATCH, not EVIDENCE_UNVERIFIED, and that is the stronger
   * answer rather than a looser one.
   *
   * Two independent things refuse this. The signature covers the symbol, so
   * lifting it onto BTCUSDT breaks it — and the base-asset binding refuses an
   * APT decision for a BTC order whether or not anything verified, which is the
   * v4 rule that an unproven decision may still REFUSE. The binding is checked
   * first, so it is the code the operator sees.
   */
  assert.equal((out.detail as { code: string }).code, "SHARIAH_ASSET_MISMATCH");
  assert.equal(orders.length, 0);

  /*
   * And the failed attempt did not SPEND the authorisation. An attacker must
   * not be able to burn a legitimate sender's nonce by presenting it somewhere
   * it does not belong — that would turn the replay defence into a denial of
   * the order it is meant to protect.
   */
  const spent = await prisma.strategyOrderIntent.findUnique({
    where: { authorizationNonceHash: authorizationNonceHash(String(nonce)) } });
  assert.equal(spent, null);
});

test("E: the same nonce with a modified Shariah status fails its signature", async () => {
  const { orders, call } = await replayFixture();
  const signed = signedShariah("APTUSDT", "buy", eligible());

  /*
   * Every field of the decision is inside the signed bytes, so keeping the
   * nonce and the signature while rewriting the verdict cannot verify.
   *
   * Downgrading it is refused on the verdict itself: an unproven decision may
   * still make things STRICTER, so a rewritten REVIEW or EXCLUDED is honoured
   * as a refusal rather than discarded. Either way no order is placed.
   */
  for (const status of ["REVIEW", "EXCLUDED"] as const) {
    const out = await call({ ...signed, shariah: eligible({ effectiveStatus: status }) });
    assert.equal(out.status, "shariah_blocked");
    assert.equal((out.detail as { code: string }).code,
      status === "REVIEW" ? "SHARIAH_REVIEW_BLOCKED" : "SHARIAH_EXCLUDED_BLOCKED");
  }

  // The reverse, which is the one that would matter: an EXCLUDED decision
  // rewritten to ELIGIBLE while keeping its nonce and signature.
  const excluded = signedShariah("APTUSDT", "buy", eligible({ effectiveStatus: "EXCLUDED" }));
  const upgraded = await call({ ...excluded, shariah: eligible() });
  assert.equal(upgraded.status, "shariah_blocked");
  assert.equal((upgraded.detail as { code: string }).code, "SHARIAH_EVIDENCE_UNVERIFIED");

  assert.equal(orders.length, 0);
});

test("E2: swapping in a DIFFERENT, unspent nonce invalidates the signature", async () => {
  const { orders, call } = await replayFixture();
  const first = signedShariah("APTUSDT", "buy", eligible());
  const second = signedShariah("APTUSDT", "buy", eligible());

  assert.equal((await call(first)).status, "ok");
  assert.equal(orders.length, 1);

  /*
   * The nonce is INSIDE the signed bytes, not merely alongside them. So a
   * replayer holding a spent signature cannot pair it with a fresh nonce to get
   * a second entry: the swap breaks the very signature that made the decision
   * the Platform's. Minting an unspent nonce requires the signing key, which is
   * the one thing a signal source does not have.
   */
  const spliced = await call({ ...first, shariah_nonce: second.shariah_nonce });
  assert.equal(spliced.status, "shariah_blocked");
  assert.equal((spliced.detail as { code: string }).code, "SHARIAH_EVIDENCE_UNVERIFIED");
  assert.equal(orders.length, 1);
});

test("F: two CONCURRENT requests on one authorisation admit at most one BUY", async () => {
  // Two different bots on one installation, because the in-process buy lock
  // serialises same-bot entries and would hide the race this is testing. It is
  // also the sharper case: the signing key is installation-wide, so evidence
  // minted for one bot verifies against another.
  const botA = await createBot();
  const botB = await createBot();
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const evidence = signedShariah("APTUSDT", "buy", eligible());

  const fire = (secret: string) => processWebhook(
    { secret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...evidence },
    { clientFactory: async () => client as never })
    .then((r) => r, (e: Error) => ({ status: "threw", detail: e.message }));

  const results = await Promise.all([fire(botA.webhookSecret), fire(botB.webhookSecret)]);

  assert.equal(results.filter((r) => r.status === "ok").length, 1,
    "exactly one of two concurrent requests on one authorisation may buy");
  assert.equal(orders.length, 1, "only one order may reach the exchange");

  const loser = results.find((r) => r.status !== "ok");
  assert.equal(loser?.status, "shariah_blocked");
  assert.equal((loser?.detail as { code: string }).code, "SHARIAH_EVIDENCE_REPLAYED");

  // Exactly one durable claim exists for the authorisation, whichever won.
  const claims = await prisma.strategyOrderIntent.findMany({
    where: { authorizationNonceHash: authorizationNonceHash(String(evidence.shariah_nonce)) } });
  assert.equal(claims.length, 1);
});

test("F2: the unique constraint, not the pre-check, is what decides the race", async () => {
  /*
   * The read in `admitSpotEntry` cannot arbitrate a tie — two racing requests
   * both see an unspent authorisation. This drives the reservation directly,
   * with the pre-check bypassed entirely, to prove the database is the
   * authority and that it fails with a reason rather than a raw constraint
   * error leaking out of the persistence layer.
   */
  const bot = await createBot();
  const hash = authorizationNonceHash(randomBytes(24).toString("base64url"));
  const reserve = (sourceKey: string) => reserveStrategyIntent({
    sourceKey, bot, clientOrderId: uniq("coid"), symbol: "APTUSDT", side: "BUY",
    requestedQuoteQty: 100, authorizationNonceHash: hash,
  });

  const first = await reserve(uniq("scope"));
  assert.equal(first.authorizationNonceHash, hash);

  await assert.rejects(() => reserve(uniq("scope")), AuthorizationNonceReplayError);

  // A different authorisation on the same bot is unaffected.
  const other = await reserveStrategyIntent({
    sourceKey: uniq("scope"), bot, clientOrderId: uniq("coid"), symbol: "APTUSDT",
    side: "BUY", requestedQuoteQty: 100,
    authorizationNonceHash: authorizationNonceHash(randomBytes(24).toString("base64url")),
  });
  assert.notEqual(other.id, first.id);
});

test("F3: intents carrying NO authorisation never collide with each other", async () => {
  // The column is nullable-unique, and every SELL, every manual order and
  // everything admitted while enforcement is off writes null. If nulls
  // collided, the second such order in the installation's life would fail.
  const bot = await createBot();
  const made = [];
  for (let i = 0; i < 3; i++) {
    made.push(await reserveStrategyIntent({
      sourceKey: uniq("scope"), bot, clientOrderId: uniq("coid"), symbol: "APTUSDT",
      side: "SELL", requestedBaseQty: 1,
    }));
  }
  assert.equal(new Set(made.map((m) => m.id)).size, 3);
  assert.deepEqual(made.map((m) => m.authorizationNonceHash), [null, null, null]);
});

test("G: a consumed authorisation is still refused after the process restarts", async () => {
  const { orders, call } = await replayFixture();
  const evidence = signedShariah("APTUSDT", "buy", eligible());
  assert.equal((await call(evidence)).status, "ok");

  const hash = authorizationNonceHash(String(evidence.shariah_nonce));
  const claim = await prisma.strategyOrderIntent.findUnique({
    where: { authorizationNonceHash: hash } });
  assert.ok(claim, "the claim must be a durable row, not process memory");

  /*
   * The restart. Dropping the connection discards every in-process cache,
   * promise chain and lock this module holds; the next query reopens the SQLite
   * file from disk. If the defence lived in a `Set`, it would be gone here —
   * which is exactly why it does not.
   */
  await prisma.$disconnect();

  const afterRestart = await call(evidence);
  assert.equal(afterRestart.status, "shariah_blocked");
  assert.equal((afterRestart.detail as { code: string }).code, "SHARIAH_EVIDENCE_REPLAYED");
  assert.equal(orders.length, 1);
});

test("H: evidence older than the freshness window is refused on its face", async () => {
  const { orders, call } = await replayFixture();

  for (const age of [SHARIAH_EVIDENCE_MAX_AGE_MS + 1_000, SHARIAH_EVIDENCE_MAX_AGE_MS * 10]) {
    const stale = signedShariah("APTUSDT", "buy", eligible(),
      { timestamp: String(Date.now() - age) });
    const out = await call(stale);
    assert.equal(out.status, "shariah_blocked");
    assert.equal((out.detail as { code: string }).code, "SHARIAH_EVIDENCE_UNVERIFIED");
  }
  assert.equal(orders.length, 0);

  /*
   * Defence in depth, deliberately kept. The nonce is now the replay defence,
   * so this bound is no longer load-bearing for that — but ancient signed
   * evidence is refused before storage is consulted at all, so the replay store
   * never has to be the first line and never has to be trusted to be complete.
   */
  assert.equal(SHARIAH_EVIDENCE_MAX_AGE_MS, 120 * 1000);
});

test("I: a genuinely new authorisation buys again, immediately", async () => {
  const { orders, call } = await replayFixture();

  // Same symbol, same side, same decision, same second — four distinct
  // authorisations. Nothing about the nonce is derived from the order, so
  // legitimate back-to-back entries are unaffected by the replay defence.
  // Sized to stay inside the fixture bot's per-Bot allowance, which is a
  // separate limit and not what is under test here.
  for (let i = 0; i < 4; i++) {
    const out = await call(signedShariah("APTUSDT", "buy", eligible()));
    assert.equal(out.status, "ok", `entry ${i + 1} was refused`);
  }
  assert.equal(orders.length, 4);
});

test("J: reconciling an already-admitted intent needs no second authorisation", async () => {
  const { bot, client, orders, call } = await replayFixture();
  const evidence = signedShariah("APTUSDT", "buy", eligible());
  const dedupe_key = uniq("W");
  assert.equal((await call(evidence, { dedupe_key })).status, "ok");
  assert.equal(orders.length, 1);

  const scope = `${bot.id}:APTUSDT:buy:${dedupe_key}`;
  const admitted = await prisma.strategyOrderIntent.findUnique({ where: { sourceKey: scope } });
  assert.ok(admitted);
  const hash = authorizationNonceHash(String(evidence.shariah_nonce));
  assert.equal(admitted.authorizationNonceHash, hash);

  /*
   * 1. QUERY-FIRST. The reconciler re-runs against the same intent. The
   *    requested->submitted transition is already spent, so it queries the
   *    exchange for the deterministic client order id instead of submitting.
   *    Nothing about the replay defence changes that, and nothing about
   *    recovery re-enters the Shariah gate.
   */
  const again = await reconcileStrategyIntent(admitted.id, strategyMarketAdapter(client));
  assert.equal(again.appliedNow, false);
  assert.equal(orders.length, 1, "reconciliation must never resubmit");

  /*
   * 2. THE ADMISSION GATE, re-entered by a redelivery of the same signal after
   *    the ordinary dedupe receipt has expired.
   *
   *    This is the case that is genuinely hard: the authorisation IS spent, by
   *    the very intent this request is trying to reconcile. Asking only "has
   *    this been used" would refuse it and strand a legitimate retry. The
   *    intent identity is what separates the two, and it is derived from the
   *    sender's own `dedupe_key` — the same signal always derives the same one.
   */
  await prisma.webhookReceipt.deleteMany({});
  const readmitted = await admitSpotEntry({
    scope: shariahScopeForBot(bot.id), symbol: "APTUSDT",
    context: readShariahContext(evidence.shariah),
    auth: { kind: "detached", side: "buy", signature: evidence.shariah_sig,
      timestamp: evidence.shariah_ts, nonce: evidence.shariah_nonce },
    intentKey: scope,
  });
  assert.equal(readmitted.authorizationNonceHash, hash);

  /*
   * 3. And the reservation resolves to the intent already on file rather than
   *    claiming anything a second time. The row it returns IS the claim.
   */
  const recovered = await reserveStrategyIntent({
    // The full monetary identity of the admitted row: `assertReservationMatches`
    // is a separate guard that a recovery must satisfy on its own terms.
    sourceKey: scope, bot, clientOrderId: admitted.clientOrderId, symbol: "APTUSDT",
    side: "BUY", requestedQuoteQty: admitted.requestedQuoteQty ?? undefined,
    smartTradeId: admitted.smartTradeId ?? undefined,
    authorizationNonceHash: hash,
  });
  assert.equal(recovered.id, admitted.id, "recovery must return the original intent");

  /*
   * 4. The contrast that makes the above safe rather than a hole: the SAME
   *    authorisation presented under a DIFFERENT intent identity — which is
   *    exactly what a fresh `dedupe_key` produces — is still a replay.
   */
  await assert.rejects(() => admitSpotEntry({
    scope: shariahScopeForBot(bot.id), symbol: "APTUSDT",
    context: readShariahContext(evidence.shariah),
    auth: { kind: "detached", side: "buy", signature: evidence.shariah_sig,
      timestamp: evidence.shariah_ts, nonce: evidence.shariah_nonce },
    intentKey: `${bot.id}:APTUSDT:buy:${uniq("W")}`,
  }), (e: unknown) => e instanceof ShariahEnforcementError &&
    e.code === "SHARIAH_EVIDENCE_REPLAYED");

  // Throughout: exactly one intent and one claim for this authorisation.
  const claims = await prisma.strategyOrderIntent.findMany({
    where: { authorizationNonceHash: hash } });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, admitted.id);
  assert.equal(orders.length, 1);
});

test("K: REVIEW and EXCLUDED still cannot buy, nonce or no nonce", async () => {
  const { bot, orders, call } = await replayFixture();

  for (const status of ["REVIEW", "EXCLUDED"] as const) {
    // Properly signed, properly nonced, entirely legitimate evidence — and
    // still refused, because the decision does not permit new exposure.
    const out = await call(signedShariah("APTUSDT", "buy", eligible({ effectiveStatus: status })));
    assert.equal(out.status, "shariah_blocked");
    assert.equal((out.detail as { code: string }).code,
      status === "REVIEW" ? "SHARIAH_REVIEW_BLOCKED" : "SHARIAH_EXCLUDED_BLOCKED");
  }
  assert.equal(orders.length, 0);

  /*
   * A refused decision spends nothing. There is nothing to spend: no entry was
   * authorised, so no authorisation was used up.
   */
  const claimed = await prisma.strategyOrderIntent.count({
    where: { botId: bot.id, authorizationNonceHash: { not: null } } });
  assert.equal(claimed, 0);
});

test("L: a SELL is never blocked by a Shariah authorisation having been spent", async () => {
  const bot = await createBot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 10_000 });
  const { client, orders } = recordingClient();
  await setInstallationShariahMode("enforce", SHARIAH_POLICY_VERSION);
  const buyEvidence = signedShariah("APTUSDT", "buy", eligible());

  const buy = await processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...buyEvidence },
    { clientFactory: async () => client as never });
  assert.equal(buy.status, "ok");

  const exit = (extra: Record<string, unknown>) => processWebhook(
    { secret: bot.webhookSecret, action: "sell", symbol: "APTUSDT",
      dedupe_key: uniq("X"), ...extra },
    { clientFactory: async () => client as never, skipExitCheck: true })
    .then((r) => r, (e: Error) => ({ status: "threw", detail: e.message }));

  /*
   * Four exits, every one of which a Shariah-specific rule might have trapped:
   * an exit carrying the authorisation the BUY already spent, one carrying a
   * malformed authorisation, one carrying none at all, and one whose decision
   * says the asset is EXCLUDED. None of them may be refused on Shariah grounds.
   *
   * This is the invariant the whole feature is bounded by. A position that
   * cannot be closed is a worse outcome than any replay.
   */
  for (const [name, extra] of [
    ["a spent authorisation", { ...buyEvidence, shariah: eligible() }],
    ["a malformed authorisation", { ...buyEvidence, shariah_nonce: "!!short!!" }],
    ["no authorisation at all", { shariah: eligible() }],
    ["an EXCLUDED decision", signedShariah("APTUSDT", "sell", eligible({ effectiveStatus: "EXCLUDED" }))],
  ] as const) {
    const out = await exit(extra as Record<string, unknown>);
    assert.notEqual(out.status, "shariah_blocked", `an exit was refused with ${name}`);
    assert.notEqual((out.detail as { code?: string })?.code, "SHARIAH_EVIDENCE_REPLAYED");
  }

  // And no exit ever claimed an authorisation, so none could ever exhaust one.
  const sellClaims = await prisma.strategyOrderIntent.count({
    where: { botId: bot.id, side: "SELL", authorizationNonceHash: { not: null } } });
  assert.equal(sellClaims, 0);
  assert.ok(orders.some((o) => o.side === "SELL"), "an exit must actually have been placed");
});

test("M: Mode OFF traffic is unchanged and never needs an authorisation", async () => {
  const bot = await createBot({ maxInvestmentUnit: "usdt_bot", maxInvestmentPct: 10_000 });
  const { client, orders } = recordingClient();
  // No installation floor, no latch: an ordinary non-enforcing installation.
  const call = (extra: Record<string, unknown>) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("W"), ...extra },
    { clientFactory: async () => client as never });

  // A direct TradingView alert: no block, no signature, no nonce. Repeatedly.
  assert.equal((await call({})).status, "ok");
  assert.equal((await call({})).status, "ok");

  /*
   * A signed `mode: "off"` block carries a nonce, because the Platform signs
   * every delivery the same way — but an `off` decision authorises nothing, so
   * presenting the SAME one twice is not a replay of an authorisation. Making
   * Mode OFF single-use would be a behaviour change for traffic this feature is
   * not about.
   */
  const off = signedShariah("APTUSDT", "buy", { mode: "off" });
  assert.equal((await call(off)).status, "ok");
  assert.equal((await call(off)).status, "ok");

  assert.equal(orders.length, 4);
  const claimed = await prisma.strategyOrderIntent.count({
    where: { botId: bot.id, authorizationNonceHash: { not: null } } });
  assert.equal(claimed, 0, "nothing under Mode OFF may spend an authorisation");
});

test("N: a missing or malformed authorisation under enforcement fails CLOSED", async () => {
  const { orders, call } = await replayFixture();
  const signed = signedShariah("APTUSDT", "buy", eligible());

  const { shariah_nonce: _dropped, ...withoutNonce } = signed;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["absent", withoutNonce],
    ["empty", { ...signed, shariah_nonce: "" }],
    ["too short", { ...signed, shariah_nonce: "AAAAAAAAAAAAAAAAAAAAA" }],
    ["too long", { ...signed, shariah_nonce: "A".repeat(129) }],
    ["wrong alphabet", { ...signed, shariah_nonce: `${"A".repeat(21)}+` }],
    ["not a string", { ...signed, shariah_nonce: 12345 }],
    ["an object", { ...signed, shariah_nonce: { toString: () => "A".repeat(32) } }],
  ];
  for (const [name, payload] of cases) {
    const out = await call(payload);
    assert.equal(out.status, "shariah_blocked", `a ${name} nonce was not refused`);
    assert.equal((out.detail as { code: string }).code, "SHARIAH_EVIDENCE_UNVERIFIED");
  }
  assert.equal(orders.length, 0);

  // The route's own schema turns the malformed shapes away earlier still, so a
  // BUY carrying one never reaches the service.
  for (const bad of ["", "short", "A".repeat(129), `${"A".repeat(21)}+`]) {
    assert.equal(webhookSchema.safeParse({
      secret: "s".repeat(40), action: "buy", symbol: "APTUSDT", shariah_nonce: bad,
    }).success, false, `the schema accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(webhookSchema.safeParse({
    secret: "s".repeat(40), action: "buy", symbol: "APTUSDT",
    shariah_nonce: randomBytes(24).toString("base64url"),
  }).success, true);
});

test("the refusal is auditable, and leaks no authorisation material", async () => {
  const { bot, call } = await replayFixture();
  const evidence = signedShariah("APTUSDT", "buy", eligible());
  await call(evidence);
  const replayed = await call(evidence, { dedupe_key: uniq("W") });
  assert.equal((replayed.detail as { code: string }).code, "SHARIAH_EVIDENCE_REPLAYED");

  const logs = await prisma.webhookLog.findMany({ where: { botId: bot.id } });
  const blocked = logs.filter((l) => l.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.match(String(blocked[0].message), /^SHARIAH_EVIDENCE_REPLAYED: /);

  /*
   * A replay is operationally distinguishable, and that is the whole point of
   * giving it its own code. What it must NOT do is write the credential it is
   * refusing into the log of the system refusing it.
   */
  const everything = JSON.stringify(logs);
  assert.equal(everything.includes(String(evidence.shariah_nonce)), false,
    "the nonce must never be logged");
  assert.equal(everything.includes(String(evidence.shariah_sig)), false,
    "the signature must never be logged");
  assert.equal(everything.includes(config.manualTradingHmacSecret), false);
  assert.equal(everything.includes(bot.webhookSecret), false);

  // Nor into the durable claim: the intent stores a hash, never the nonce.
  const claim = await prisma.strategyOrderIntent.findFirst({
    where: { botId: bot.id, authorizationNonceHash: { not: null } } });
  assert.equal(claim?.authorizationNonceHash,
    authorizationNonceHash(String(evidence.shariah_nonce)));
  assert.equal(JSON.stringify(claim).includes(String(evidence.shariah_nonce)), false);
});
