/**
 * Characterization of the bot-creation form model. The defaults here decide
 * how much real money a newly created bot commits, so they are pinned
 * explicitly rather than left to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotPayload, defaultBotForm, PAIRS } from "../src/lib/botForm.js";

test("KNOWN DEFECT BOT-003/BOT-015: the shipped defaults are the maximum-risk ones", () => {
  assert.equal(defaultBotForm.maxInvestmentPct, 100, "100 % of the balance");
  assert.equal(defaultBotForm.entryVolumePct, 100);
  assert.equal(defaultBotForm.maxInvestmentUnit, "pct_bot");
  assert.equal(defaultBotForm.stopLossEnabled, false, "no stop loss");
  assert.equal(defaultBotForm.takeProfitEnabled, false, "no take profit");
  assert.equal(defaultBotForm.exitEnabled, false, "and exits are refused outright");
  assert.equal(defaultBotForm.maxActiveSmartTradesEnabled, false);
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
