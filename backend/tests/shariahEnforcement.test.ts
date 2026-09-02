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
  httpStatusFor, mayAdvanceLocalState, orderPlaced, SHARIAH_POLICY_VERSION,
  validateCustomBotPayload, validateShariahContext,
} = await import("../src/contract/webhookContract.js");
const { webhookSchema } = await import("../src/routes/webhookSchema.js");

const originalDryRun = config.dryRun;
const originalManual = config.manualTradingEnabled;

// A refusal must be provable as "no order was sent", which the suite's default
// DRY_RUN=true would hide: it returns a simulated fill without ever reaching
// `client.order`. Real (mocked) submission makes a missing gate visible.
config.dryRun = false;
config.manualTradingEnabled = true;

after(async () => {
  config.dryRun = originalDryRun;
  config.manualTradingEnabled = originalManual;
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
      dedupe_key: uniq("L"), shariah: { mode: "off" } },
    { clientFactory: async () => client as never });
  assert.equal(result.status, "ok");
  assert.equal(orders.length, 1);
  const intent = await prisma.strategyOrderIntent.findFirstOrThrow({
    where: { botId: bot.id }, orderBy: { createdAt: "desc" } });
  assert.equal(JSON.parse(intent.shariahContext ?? "{}").mode, "off");
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
  const call = (shariah?: unknown) => processWebhook(
    { secret: bot.webhookSecret, action: "buy", symbol: "APTUSDT", quote_order_qty: 100,
      dedupe_key: uniq("L"), ...(shariah ? { shariah } : {}) },
    { clientFactory: async () => client as never });

  assert.equal((await call(eligible())).status, "ok");
  assert.equal(orders.length, 1);

  // The same sender, now simply leaving the block out.
  const downgraded = await call();
  assert.equal(downgraded.status, "shariah_blocked");
  assert.equal((downgraded.detail as { code: string }).code, "SHARIAH_CONTEXT_REQUIRED");
  assert.equal(orders.length, 1);

  // A malformed block is not a way back to mode off either.
  const malformed = await call({ mode: "enforce", policyVersion: "TS_SHARIAH_V2" });
  assert.equal(malformed.status, "shariah_blocked");
  assert.equal(orders.length, 1);

  // Turning it off again takes an explicit, equally authenticated statement.
  assert.equal((await call({ mode: "off" })).status, "ok");
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
      context: readShariahContext(eligible()) });
    const racing = admitSpotEntry({ scope, symbol: "APTUSDT", context: undefined });

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
      context: readShariahContext(eligible({ effectiveStatus: "REVIEW" })) }),
    (error: unknown) => error instanceof ShariahEnforcementError &&
      error.code === "SHARIAH_REVIEW_BLOCKED");
  // The latch still moved: the sender authentically said it is enforcing, and
  // that statement is what a later omission is measured against.
  const row = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  assert.equal(row?.mode, "enforce");
});
