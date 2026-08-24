/**
 * Characterization of the bot-creation form model. The defaults here decide
 * how much real money a newly created bot commits, so they are pinned
 * explicitly rather than left to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBotPayload, defaultBotForm, PAIRS, UNPROTECTED_SIZE_LIMIT_PCT, unsafeConfigReason,
} from "../src/lib/botForm.js";

test("BOT-003/BOT-015 FIXED: the defaults are survivable", () => {
  // They were maxInvestmentPct 100 with entryVolumePct 100 and every exit
  // control off — the entire free USDT balance in one position with no
  // automated exit path, and exit webhooks refused outright.
  assert.equal(defaultBotForm.maxInvestmentPct, 5);
  assert.equal(defaultBotForm.maxInvestmentUnit, "pct_bot");
  assert.equal(defaultBotForm.stopLossEnabled, true);
  assert.equal(defaultBotForm.stopLossPct, 3);
  assert.equal(defaultBotForm.exitEnabled, true);
  // Take profit stays opt-in: it is a preference, not a safety control.
  assert.equal(defaultBotForm.takeProfitEnabled, false);
  assert.equal(defaultBotForm.maxActiveSmartTradesEnabled, false);
});

test("the defaults themselves pass the safety guard", () => {
  assert.equal(unsafeConfigReason(defaultBotForm), null);
});

test("BOT-003: rebuilding the old configuration by hand is refused", () => {
  const reason = unsafeConfigReason({
    ...defaultBotForm,
    maxInvestmentPct: 100,
    entryVolumePct: 100,
    stopLossEnabled: false,
  });
  assert.ok(reason, "a full-balance position with no stop must be refused");
  assert.match(reason, new RegExp(`${UNPROTECTED_SIZE_LIMIT_PCT}%`));
});

test("the guard reads the EFFECTIVE size, so entry volume counts", () => {
  const base = { ...defaultBotForm, maxInvestmentPct: 100, stopLossEnabled: false };
  assert.equal(unsafeConfigReason({ ...base, entryVolumePct: 40 }), null);
  assert.ok(unsafeConfigReason({ ...base, entryVolumePct: 60 }));
});

test("an enabled stop or target with no distance is refused before submitting", () => {
  assert.match(unsafeConfigReason({ ...defaultBotForm, stopLossPct: 0 }) ?? "", /Stop loss/);
  assert.match(
    unsafeConfigReason({ ...defaultBotForm, takeProfitEnabled: true, takeProfitPct: 0 }) ?? "",
    /Take profit/
  );
});

test("BOT-012: only the implemented direction is representable", () => {
  assert.equal(defaultBotForm.direction, "long");
  // The type is now the literal "long", so a short bot cannot be constructed.
  const asString: string = defaultBotForm.direction;
  assert.equal(asString, "long");
});

test("disabled optional limits are sent as null, not as their stale form value", () => {
  const payload = buildBotPayload({
    ...defaultBotForm,
    takeProfitEnabled: false, takeProfitPct: 5,
    stopLossEnabled: false, stopLossPct: 3,
    maxActiveSmartTradesEnabled: false, maxActiveSmartTrades: 2,
  });
  assert.equal(payload.takeProfitPct, null);
  assert.equal(payload.stopLossPct, null);
  assert.equal(payload.maxActiveSmartTrades, null);
});

test("enabled limits keep their configured values", () => {
  const payload = buildBotPayload({
    ...defaultBotForm,
    takeProfitEnabled: true, takeProfitPct: 7.5,
    stopLossEnabled: true, stopLossPct: 2.5,
    maxActiveSmartTradesEnabled: true, maxActiveSmartTrades: 3,
  });
  assert.equal(payload.takeProfitPct, 7.5);
  assert.equal(payload.stopLossPct, 2.5);
  assert.equal(payload.maxActiveSmartTrades, 3);
});

test("an unset exchange account is normalised to null so the API can fall back to env credentials", () => {
  assert.equal(buildBotPayload({ ...defaultBotForm, exchangeAccountId: "" }).exchangeAccountId, null);
  assert.equal(buildBotPayload({ ...defaultBotForm, exchangeAccountId: "acc-1" }).exchangeAccountId, "acc-1");
});

test("the offered pair list is non-empty and normalised uppercase spot pairs", () => {
  assert.ok(PAIRS.length > 0);
  for (const p of PAIRS) assert.match(p, /^[A-Z0-9]{4,20}$/, p);
});
