/**
 * OD-5 (Bot emitter) — trace §5.3, Bot parts.
 *
 *   - the contract module is the Platform's, byte for byte (checked against
 *     the Platform checkout when TRADING_SCENE_PLATFORM_ROOT is set);
 *   - v1 stays exactly v1 (stored payloads round-trip unchanged); v2 adds a
 *     required `environment`, and an unknown value is refused;
 *   - the environment is recorded at RESERVATION from the inputs that choose
 *     the endpoint, and a later config flip never relabels it;
 *   - the version is decided at PERSIST time: v1 unless the flag is on AND
 *     the Platform's last acknowledged answer listed `realization.v2`;
 *   - BUY/SELL mismatch, legacy null, DRY_RUN-labelled real fills and `dry-`
 *     ids under a real label all declare UNKNOWN;
 *   - delivery batches never mix versions; only an acknowledged answer
 *     changes the remembered capability.
 *
 * No network: deliveries use an injected fetch.
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { SignalBot, StrategyOrderIntent } from "@prisma/client";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".realization-environment-test.db");
process.env.DATABASE_URL = "file:./tests/.realization-environment-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { createHash } = await import("node:crypto");
const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const contract = await import("../src/contract/realizationEventContract.js");
const {
  deliverPendingRealizations, persistStrategyRealization, recordPlatformCapabilities,
} = await import("../src/services/realizationEvents.js");
const { reserveStrategyIntent } = await import("../src/services/strategyOrderIntent.js");

const original = {
  dryRun: config.dryRun, testnet: config.binanceTestnet, v2: config.realizationContractV2Enabled,
  delivery: config.realizationDeliveryEnabled, url: config.realizationPlatformUrl,
  secret: config.realizationHmacSecret,
};

after(async () => {
  Object.assign(config, {
    dryRun: original.dryRun, binanceTestnet: original.testnet, realizationContractV2Enabled: original.v2,
    realizationDeliveryEnabled: original.delivery, realizationPlatformUrl: original.url,
    realizationHmacSecret: original.secret,
  });
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => {
  Object.assign(config, { dryRun: false, binanceTestnet: false, realizationContractV2Enabled: false,
    realizationDeliveryEnabled: true, realizationPlatformUrl: "http://127.0.0.1/api/internal/realization-events/v1",
    realizationHmacSecret: "r".repeat(40) });
  await prisma.realizationEvent.deleteMany();
  await prisma.platformCapability.deleteMany();
  await prisma.strategyOrderIntent.deleteMany();
  await prisma.signalBot.deleteMany();
  await prisma.exchangeAccount.deleteMany();
});

// ── Fixtures ────────────────────────────────────────────────────────────────

let n = 0;
const IDENTITY = contract.platformWebhookIdentity(`fixture-webhook-${"w".repeat(30)}`);

async function intent(over: Partial<StrategyOrderIntent> = {}): Promise<StrategyOrderIntent> {
  n += 1;
  return prisma.strategyOrderIntent.create({ data: {
    sourceKey: `env:${n}`, clientOrderId: `env-${n}`, botId: "bot-x", botName: "x", symbol: "BTCUSDT",
    side: "SELL", requestedBaseQty: 1, status: "reconciled", platformWebhookIdentity: IDENTITY,
    platformDedupeKey: `dk-${n}`, smartTradeId: `trade-${n}`, ...over,
  } as Parameters<typeof prisma.strategyOrderIntent.create>[0]["data"] });
}

async function persist(sell: StrategyOrderIntent, over: { exchangeOrderId?: string; simulated?: boolean } = {}) {
  return persistStrategyRealization(prisma, {
    // Strictly increasing realization times: the outbox is delivered oldest first.
    intent: sell, kind: "final", sourceId: sell.id, realizedAt: new Date(Date.UTC(2026, 10, 10) + n * 1000),
    realizedPnlQuote: 1.5, realizedQuantity: 1, exitPrice: 101.5, exitRevenueQuote: 101.5,
    exchangeOrderId: over.exchangeOrderId ?? `ex-${sell.id.slice(0, 8)}`, simulated: over.simulated ?? false,
  });
}

async function seeV2() {
  await prisma.platformCapability.create({ data: { name: "realization.v2", seenAt: new Date() } });
}

// ════════════════════════════════════════════════════════════════════════════
// Contract
// ════════════════════════════════════════════════════════════════════════════

test("contract: byte-identical to the Platform's copy (when TRADING_SCENE_PLATFORM_ROOT is set)", (t) => {
  const root = process.env.TRADING_SCENE_PLATFORM_ROOT;
  const mine = fs.readFileSync(path.join(backendRoot, "src", "contract", "realizationEventContract.ts"));
  assert.match(mine.toString("utf8"), /copied byte-for-byte into the Bot repository/);
  if (!root) { t.skip("TRADING_SCENE_PLATFORM_ROOT not set"); return; }
  const theirs = fs.readFileSync(path.join(root, "platform", "backend", "src", "contract", "realizationEventContract.ts"));
  assert.equal(createHash("sha256").update(mine).digest("hex"), createHash("sha256").update(theirs).digest("hex"));
});

const V1 = {
  contractVersion: 1, type: "BOT_CUSTOM_REALIZATION", eventId: "bot-realization-v1:final:x1", kind: "final",
  realizedAt: "2026-11-10T00:00:00.000Z", realizedPnlQuote: "1.5", realizedQuantity: "1", exitPrice: "101.5",
  exitRevenueQuote: "101.5", quoteCurrency: "USDT", symbol: "BTCUSDT", positionDirection: "long", exitSide: "sell",
  strategyOrderIntentId: "i1", exchangeOrderId: "ex1", platformWebhookIdentity: IDENTITY,
  platformDeploymentId: null, platformOrderIntentId: null, platformDedupeKey: "dk", exitLeg: null,
  accounting: { pnlBasis: "modeled_fee_adjusted", feeModel: "fixed_rate_both_sides", buyFeeRate: "0.001",
    sellFeeRate: "0.001", commissionSource: "modeled_not_exchange_observed" },
};

test("contract: a stored v1 payload round-trips byte-for-byte; v2 needs a known environment; versions never mix", () => {
  const stored = contract.canonicalJson(V1);
  assert.equal(contract.canonicalJson(contract.normalizeRealizationEvent(JSON.parse(stored))), stored);
  assert.throws(() => contract.normalizeRealizationEvent({ ...V1, environment: "TESTNET" }), /shape/,
    "a v1 event cannot carry environment");
  const v2 = contract.normalizeRealizationEvent({ ...V1, contractVersion: 2, environment: "TESTNET" });
  assert.equal(v2.contractVersion, 2);
  assert.throws(() => contract.normalizeRealizationEvent({ ...V1, contractVersion: 2 }), /shape/);
  assert.throws(() => contract.normalizeRealizationEvent({ ...V1, contractVersion: 2, environment: "REAL" }),
    /environment/);
  assert.throws(() => contract.normalizeRealizationBatch({ contractVersion: 1, type: "BOT_CUSTOM_REALIZATION_BATCH",
    events: [{ ...V1, contractVersion: 2, environment: "MAINNET" }] }), /versions differ/);
});

// ════════════════════════════════════════════════════════════════════════════
// Reservation
// ════════════════════════════════════════════════════════════════════════════

async function reserveFor(bot: SignalBot) {
  n += 1;
  return reserveStrategyIntent({
    sourceKey: `res:${n}`, bot, clientOrderId: `res-${n}`, symbol: "BTCUSDT", side: "BUY", requestedQuoteQty: 10,
  });
}

test("reservation records the environment from the endpoint's own inputs, and a config flip never relabels it", async () => {
  const testnetAccount = await prisma.exchangeAccount.create({ data: { name: "t", apiKeyEnc: "e", apiSecretEnc: "e", testnet: true } });
  const mainnetAccount = await prisma.exchangeAccount.create({ data: { name: "m", apiKeyEnc: "e", apiSecretEnc: "e", testnet: false } });
  const bot = (exchangeAccountId: string | null) => prisma.signalBot.create({ data: {
    name: "b", webhookSecret: `s${n++}${"z".repeat(40)}`, pairs: "[\"BTCUSDT\"]", exchangeAccountId } });

  assert.equal((await reserveFor(await bot(testnetAccount.id))).executionEnvironment, "TESTNET");
  assert.equal((await reserveFor(await bot(mainnetAccount.id))).executionEnvironment, "MAINNET");
  config.binanceTestnet = true;
  const envCredential = await reserveFor(await bot(null));
  assert.equal(envCredential.executionEnvironment, "TESTNET", "env credentials follow BINANCE_TESTNET");
  config.binanceTestnet = false;
  assert.equal((await reserveFor(await bot(null))).executionEnvironment, "MAINNET");
  config.dryRun = true;
  assert.equal((await reserveFor(await bot(mainnetAccount.id))).executionEnvironment, "DRY_RUN");
  config.dryRun = false;

  // A "restart" with the flag flipped: the stored value stands.
  config.binanceTestnet = false;
  const reread = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: envCredential.id } });
  assert.equal(reread.executionEnvironment, "TESTNET");
});

// ════════════════════════════════════════════════════════════════════════════
// Persist-time version decision
// ════════════════════════════════════════════════════════════════════════════

test("persist: v1 while the flag is off, and while the capability is unseen; v2 only with both", async () => {
  const offSeen = await intent({ executionEnvironment: "TESTNET" });
  await seeV2();
  assert.equal((await persist(offSeen))?.contractVersion, 1, "flag off: v1 even though the Platform can take v2");

  config.realizationContractV2Enabled = true;
  await prisma.platformCapability.deleteMany();
  const onUnseen = await intent({ executionEnvironment: "TESTNET" });
  assert.equal((await persist(onUnseen))?.contractVersion, 1, "capability unseen: v1");

  await seeV2();
  const both = await intent({ executionEnvironment: "TESTNET" });
  const event = await persist(both);
  assert.equal(event?.contractVersion, 2);
  assert.equal((event as { environment?: string }).environment, "TESTNET");
  const row = await prisma.realizationEvent.findUniqueOrThrow({ where: { strategyIntentId: both.id } });
  assert.equal(row.payload, contract.canonicalJson(event));
  assert.equal(row.payloadSha256, createHash("sha256").update(row.payload).digest("hex"));
  // Earlier rows keep their v1 shape forever.
  const earlier = await prisma.realizationEvent.findUniqueOrThrow({ where: { strategyIntentId: offSeen.id } });
  assert.equal(JSON.parse(earlier.payload).contractVersion, 1);
});

test("persist: UNKNOWN for legacy null, a BUY/SELL environment mismatch, a DRY_RUN-labelled real fill, a dry- id", async () => {
  config.realizationContractV2Enabled = true;
  await seeV2();
  const env = async (sell: StrategyOrderIntent, exchangeOrderId?: string) =>
    ((await persist(sell, { exchangeOrderId })) as { environment?: string } | null)?.environment;

  assert.equal(await env(await intent({ executionEnvironment: null })), "UNKNOWN");

  const mismatch = await intent({ executionEnvironment: "MAINNET", smartTradeId: "trade-mix" });
  await intent({ side: "BUY", executionEnvironment: "TESTNET", smartTradeId: "trade-mix", requestedQuoteQty: 10,
    requestedBaseQty: null, platformDedupeKey: null });
  assert.equal(await env(mismatch), "UNKNOWN", "the account changed mid-trade");

  const consistent = await intent({ executionEnvironment: "MAINNET", smartTradeId: "trade-same" });
  await intent({ side: "BUY", executionEnvironment: "MAINNET", smartTradeId: "trade-same", requestedQuoteQty: 10,
    requestedBaseQty: null, platformDedupeKey: null });
  assert.equal(await env(consistent), "MAINNET");

  assert.equal(await env(await intent({ executionEnvironment: "DRY_RUN" })), "UNKNOWN");
  assert.equal(await env(await intent({ executionEnvironment: "MAINNET" }), "dry-123"), "UNKNOWN");
});

test("persist: a simulated realization is still never emitted", async () => {
  config.realizationContractV2Enabled = true;
  await seeV2();
  assert.equal(await persist(await intent({ executionEnvironment: "DRY_RUN" }), { simulated: true }), null);
  assert.equal(await prisma.realizationEvent.count(), 0);
});

// ════════════════════════════════════════════════════════════════════════════
// Delivery
// ════════════════════════════════════════════════════════════════════════════

function platform(answer: (body: { contractVersion: number; events: Array<{ eventId: string; contractVersion: number }> })
  => { status: number; json: unknown }) {
  const bodies: Array<{ contractVersion: number; events: Array<{ eventId: string; contractVersion: number }> }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as typeof bodies[number];
    bodies.push(body);
    const { status, json } = answer(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, bodies };
}

const acceptAll = (capabilities?: string[]) => (body: { events: Array<{ eventId: string }> }) => ({
  status: 200,
  json: { status: "accepted", acceptedEventIds: body.events.map((e) => e.eventId),
    ...(capabilities ? { capabilities } : {}) },
});

test("delivery: the capability is learned from an acknowledged answer and forgotten when one omits it", async () => {
  await persist(await intent({ executionEnvironment: "TESTNET" }));
  const learn = platform(acceptAll(["realization.v2"]));
  assert.deepEqual(await deliverPendingRealizations(learn.fetchImpl, new Date()), { attempted: 1, delivered: 1 });
  assert.ok(await prisma.platformCapability.findUnique({ where: { name: "realization.v2" } }));

  await persist(await intent({ executionEnvironment: "TESTNET" }));
  const failing = platform(() => ({ status: 500, json: { capabilities: [] } }));
  await deliverPendingRealizations(failing.fetchImpl, new Date());
  assert.ok(await prisma.platformCapability.findUnique({ where: { name: "realization.v2" } }),
    "an unacknowledged answer changes nothing");

  await prisma.realizationEvent.updateMany({ data: { nextAttemptAt: new Date(0) } });
  const rolledBack = platform(acceptAll());
  await deliverPendingRealizations(rolledBack.fetchImpl, new Date());
  assert.equal(await prisma.platformCapability.findUnique({ where: { name: "realization.v2" } }), null,
    "a rolled-back Platform's acknowledgement clears it, so new events are v1 again");
  await recordPlatformCapabilities("realization.v2");
  assert.equal(await prisma.platformCapability.count(), 0, "a malformed list is not a capability");
});

test("delivery: oldest first, one version per batch — v1 rows go out as a v1 batch, then v2 rows as a v2 batch", async () => {
  await persist(await intent({ executionEnvironment: "TESTNET" }));
  await persist(await intent({ executionEnvironment: "TESTNET" }));
  config.realizationContractV2Enabled = true;
  await seeV2();
  await persist(await intent({ executionEnvironment: "MAINNET" }));
  const p = platform(acceptAll(["realization.v2"]));
  assert.deepEqual(await deliverPendingRealizations(p.fetchImpl, new Date()), { attempted: 3, delivered: 2 });
  assert.deepEqual(await deliverPendingRealizations(p.fetchImpl, new Date()), { attempted: 1, delivered: 1 });
  assert.equal(p.bodies.length, 2);
  assert.equal(p.bodies[0]!.contractVersion, 1);
  assert.deepEqual(p.bodies[0]!.events.map((e) => e.contractVersion), [1, 1]);
  assert.equal(p.bodies[1]!.contractVersion, 2);
  assert.deepEqual(p.bodies[1]!.events.map((e) => e.contractVersion), [2]);
  assert.equal(await prisma.realizationEvent.count({ where: { deliveryStatus: "delivered" } }), 3);
  // Every body the Bot sent is a valid batch under the shared contract.
  for (const body of p.bodies) assert.doesNotThrow(() => contract.normalizeRealizationBatch(body));
});
