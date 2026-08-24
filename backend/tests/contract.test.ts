/**
 * The shared cross-repository webhook contract, from the RECEIVING side.
 *
 * The drift assertion is the same one the platform runs against its own copy:
 * if either file changes, both builds go red until both copies and the
 * fingerprint are updated together. That is the mechanism that replaces
 * "hand-duplicated with no shared artifact and no test", which is what produced
 * X-01, X-02 and X-12.
 *
 * The round-trip assertion feeds every payload the SENDER can emit through the
 * validator this repository uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalizeContractSource, CONTRACT_FINGERPRINT, CONTRACT_VERSION, dedupeKey,
  emittablePayloads, httpStatusFor, isExitAction, legacyDedupeKey, LIMITS,
  mayAdvanceLocalState, orderPlaced, parseDedupeKey, RECEIVER_OUTCOMES,
  validateCustomBotPayload,
} from "../src/contract/webhookContract.js";
import { webhookSchema } from "../src/routes/webhookSchema.js";
import { resolveAction, resolveSymbol } from "../src/services/webhook.js";

const CONTRACT_PATH = path.join(import.meta.dirname, "..", "src", "contract", "webhookContract.ts");
const SECRET = "s".repeat(40);

// ── Drift ───────────────────────────────────────────────────────────────────

test("this repository's vendored contract matches its recorded fingerprint", () => {
  const canonical = canonicalizeContractSource(fs.readFileSync(CONTRACT_PATH, "utf8"));
  const actual = `sha256:v${CONTRACT_VERSION}:${crypto
    .createHash("sha256")
    .update(canonical)
    .digest("hex")}`;
  assert.equal(
    actual,
    CONTRACT_FINGERPRINT,
    "The contract changed. Update BOTH repositories' copies and paste this hash " +
      `into CONTRACT_FINGERPRINT in both:\n  ${actual}\n`
  );
});

// ── Round trip ──────────────────────────────────────────────────────────────

test("every payload the sender can emit is accepted by the contract validator", () => {
  const payloads = emittablePayloads(SECRET);
  assert.ok(payloads.length > 50, `expected a broad set, got ${payloads.length}`);
  for (const payload of payloads) {
    const result = validateCustomBotPayload(payload);
    assert.equal(result.ok, true, result.ok ? "" : `${result.code}: ${result.message}`);
  }
});

test("every payload the sender can emit ALSO passes the route's zod schema", () => {
  // Two validators exist: the contract's (shared, dependency-free) and the
  // route's zod schema (which produces the 400 messages). They must agree, or
  // the contract test would pass while the running server rejected traffic.
  for (const payload of emittablePayloads(SECRET)) {
    const r = webhookSchema.safeParse(payload);
    assert.equal(
      r.success,
      true,
      `zod rejected a contract-valid payload: ${r.success ? "" : r.error.errors[0]?.message}`
    );
  }
});

test("X-01: sell_percent of exactly 100 is accepted by BOTH validators", () => {
  const body = {
    secret: SECRET, action: "sell", symbol: "APTUSDT",
    sell_percent: 100, exit_leg: "tp2",
    dedupe_key: dedupeKey("sell", 1_700_000_000_000, "tp2"),
  };
  assert.equal(validateCustomBotPayload(body).ok, true);
  assert.equal(webhookSchema.safeParse(body).success, true);
});

test("the two validators agree on what to REJECT, not just what to accept", () => {
  const bad: Record<string, unknown>[] = [
    { secret: "short", action: "buy", symbol: "APTUSDT" },
    { secret: SECRET, action: "buy" },
    { secret: SECRET, action: "buy", symbol: "APTUSDT", price: 1 },
    { secret: SECRET, action: "sell", symbol: "APTUSDT", sell_percent: 0 },
    { secret: SECRET, action: "sell", symbol: "APTUSDT", sell_percent: 101 },
    { secret: SECRET, action: "buy", symbol: "APTUSDT", sell_percent: 50 },
    { secret: SECRET, action: "sell", symbol: "APTUSDT", sell_percent: 50, quantity: 1 },
    { secret: SECRET, action: "buy", symbol: "APTUSDT", quote_order_qty: 0 },
    { secret: SECRET, action: "buy", symbol: "APTUSDT", quote_order_qty: LIMITS.quoteOrderQtyMax + 1 },
    { secret: SECRET, action: "buy", symbol: "AP" },
    { secret: SECRET, action: "sell", symbol: "APTUSDT", exit_leg: "moon" },
  ];
  for (const body of bad) {
    assert.equal(validateCustomBotPayload(body).ok, false, `contract accepted ${JSON.stringify(body)}`);
    assert.equal(webhookSchema.safeParse(body).success, false, `zod accepted ${JSON.stringify(body)}`);
  }
});

// ── Dedupe key ──────────────────────────────────────────────────────────────

test("X-02: the canonical key is bar open time only, so both senders agree", () => {
  const barTime = 1_700_000_000_000;
  assert.equal(dedupeKey("buy", barTime), `L-${barTime}`);
  assert.equal(dedupeKey("sell", barTime, "tp1"), `X-${barTime}-tp1`);
  // The legacy form embedded a bar index the two senders computed differently.
  assert.notEqual(
    legacyDedupeKey("buy", Math.floor(barTime / 900_000), barTime),
    legacyDedupeKey("buy", 4321, barTime)
  );
  // Both legacy shapes still fit the schema, so an un-updated sender is not
  // locked out during a rollout.
  for (const key of [
    dedupeKey("buy", barTime),
    legacyDedupeKey("buy", 4321, barTime),
    legacyDedupeKey("sell", 4321, barTime, "tp1"),
  ]) {
    assert.equal(
      webhookSchema.safeParse({ secret: SECRET, action: "buy", symbol: "APTUSDT", dedupe_key: key }).success,
      true,
      key
    );
  }
});

test("a canonical key round-trips; a legacy key is recognised as non-canonical", () => {
  const t = 1_700_000_000_000;
  assert.deepEqual(parseDedupeKey(dedupeKey("sell", t, "stop")), {
    action: "sell", barOpenTimeMs: t, exitLeg: "stop",
  });
  assert.equal(parseDedupeKey(legacyDedupeKey("buy", 4321, t)), null);
});

// ── Outcomes ────────────────────────────────────────────────────────────────

test("X-12: the outcomes that placed no order answer 409, not 200", () => {
  assert.equal(httpStatusFor("ok"), 200);
  assert.equal(httpStatusFor("ignored_duplicate"), 200);
  assert.equal(httpStatusFor("ignored_stale_sell"), 409);
  assert.equal(httpStatusFor("halted"), 409);
  assert.equal(httpStatusFor("risk_blocked"), 409);
});

test("a 2xx is never an outcome the sender may not act on", () => {
  for (const outcome of RECEIVER_OUTCOMES) {
    if (httpStatusFor(outcome) < 300) {
      assert.equal(mayAdvanceLocalState(outcome), true, outcome);
    }
    if (orderPlaced(outcome)) assert.equal(mayAdvanceLocalState(outcome), true, outcome);
  }
  assert.equal(orderPlaced("ok"), true);
  assert.equal(orderPlaced("ignored_stale_sell"), false);
  assert.equal(mayAdvanceLocalState("ignored_stale_sell"), false);
});

// ── Normalisation agrees with the contract's own helper ────────────────────

test("the contract's isExitAction agrees with the receiver's resolveAction", () => {
  for (const a of ["sell", "SELL", "exit long", "close_long", "closeposition", "exit"]) {
    assert.equal(resolveAction(a), "sell", a);
    assert.equal(isExitAction(a), true, a);
  }
  for (const a of ["buy", "enterlong", "openlong"]) {
    assert.equal(resolveAction(a), "buy", a);
    assert.equal(isExitAction(a), false, a);
  }
});

test("symbol resolution accepts either field, as the contract permits", () => {
  assert.equal(resolveSymbol({ symbol: "apt/usdt" }), "APTUSDT");
  assert.equal(resolveSymbol({ tv_instrument: "BINANCE:APTUSDT" }), "APTUSDT");
});
