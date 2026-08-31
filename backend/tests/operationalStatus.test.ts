import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BOT_RISK_LIMITS, realisedPnlFromTradeEvents,
} from "../src/services/riskControls.js";
import { operationalStatusSchema } from "../src/routes/webhookSchema.js";
import {
  buildBotOperationalStatus, readBotOperationalStatusForSecret, utcDayStart,
  type BotOperationalStatus,
} from "../src/services/operationalStatus.js";

test("operations status auth accepts only the existing bounded webhook-secret shape", () => {
  const secret = "s".repeat(40);
  assert.deepEqual(operationalStatusSchema.parse({ secret }), { secret });
  assert.equal(operationalStatusSchema.safeParse({ secret: "short" }).success, false);
  assert.equal(operationalStatusSchema.safeParse({ secret, token: "leak" }).success, false);
  assert.equal(operationalStatusSchema.safeParse({}).success, false);
});

test("account status is read only after a webhook secret authenticates", async () => {
  const status = { service: { reachable: true } } as BotOperationalStatus;
  const validSecret = "v".repeat(40);
  let reads = 0;
  const valid = await readBotOperationalStatusForSecret(validSecret, {
    findBot: async (secret) => secret === validSecret ? { id: "bot-1" } : null,
    readStatus: async () => { reads += 1; return status; },
  });
  assert.equal(valid, status);
  assert.equal(reads, 1);

  const invalid = await readBotOperationalStatusForSecret("x".repeat(40), {
    findBot: async () => null,
    readStatus: async () => { reads += 1; return status; },
  });
  assert.equal(invalid, null);
  assert.equal(reads, 1, "invalid auth must not read account-level state");
});

test("realised P/L counts partial and final-close events once at their own times", () => {
  const closedToday = [
    // Total includes a -10 partial from yesterday and a +35 final leg today.
    { pnlUsdt: 25, partialCloses: [{ pnlUsdt: -10 }] },
    // Total includes a +5 partial today and a -2 final leg today.
    { pnlUsdt: 3, partialCloses: [{ pnlUsdt: 5 }] },
  ];
  const partialsToday = [{ pnlUsdt: 5 }, { pnlUsdt: 7 }]; // +7 belongs to an open trade
  assert.equal(realisedPnlFromTradeEvents(closedToday, partialsToday), 45);
});

test("UTC daily P/L has an explicit, stable calendar boundary", () => {
  const now = Date.parse("2026-08-31T23:59:59.999Z");
  assert.equal(utcDayStart(now).toISOString(), "2026-08-31T00:00:00.000Z");
});

test("the endpoint serializer reports authoritative modes and contains no credential fields", () => {
  const status = buildBotOperationalStatus({
    limits: { ...DEFAULT_BOT_RISK_LIMITS, maxDailyLossQuote: 100 },
    rolling: { openExposureQuote: 150, openTrades: 2, realisedPnlInWindow: -9 },
    today: { openExposureQuote: 150, openTrades: 2, realisedPnlInWindow: -12.5 },
    accounts: [{ testnet: true }],
    now: Date.parse("2026-08-31T12:00:00.000Z"),
    dryRun: false,
    binanceTestnet: false,
    version: "1.0.0",
  });
  assert.equal(status.execution.mode, "LIVE");
  assert.equal(status.exchange.mode, "MIXED");
  assert.equal(status.realisedPnl.today, -12.5);
  assert.deepEqual(status.openTrades, { count: 2, exposureQuote: 150, currency: "USDT" });
  assert.equal(status.dailyLossProtection.enabled, true);
  const serialized = JSON.stringify(status);
  for (const forbidden of [
    "apiKey", "apiSecret", "apiKeyEnc", "apiSecretEnc", "webhookSecret",
    "access_token", "refresh_token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
