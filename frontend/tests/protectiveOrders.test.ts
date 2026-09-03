/**
 * V1-UX-2: the stop-loss control must not claim protection it does not
 * provide.
 *
 * `EXCHANGE_STOPS_ENABLED` is off by default, so no resting order exists at
 * Binance: protection is a 30-second poll inside the bot process and ceases
 * entirely while that process is down. The backend has always computed that
 * sentence (`routes/operations.ts`) and `api.ts` has always typed it as
 * `protectiveOrders.note` — but nothing rendered it, while `botForm.ts`
 * REQUIRES a stop for any position at or above half the balance.
 *
 * These are source assertions rather than render assertions: this repository
 * has no DOM test harness, and what regressed here was a value never being
 * consumed at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (...parts: string[]) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "src", ...parts), "utf8");

test("the Dashboard consumes and renders the backend's protectiveOrders note", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.match(dashboard, /protectiveOrders/,
    "the dashboard must read `protectiveOrders` from the ops status it already fetches");
  assert.match(dashboard, /\{protectiveOrders\.note\}/,
    "and render the note itself, not a re-worded copy that can drift from it");
});

test("the stop-loss description states that protection is a poll, not a resting order", () => {
  const source = src("components", "BotFormFields.tsx");
  const start = source.indexOf('label="Stop loss"');
  assert.notEqual(start, -1, "the stop-loss control must still exist");
  const end = source.indexOf("on={form.stopLossEnabled}", start);
  // Rejoin the string-concatenation the description is written across, so the
  // assertions below read the sentence an operator sees.
  const description = source.slice(start, end).replace(/"\s*\+\s*"/g, "");
  assert.match(description, /30-second/,
    "the description must say how often protection actually runs");
  assert.match(description, /not a resting stop order at Binance/,
    "and that there is no resting order at the exchange");
  assert.match(description, /while the server is down/,
    "and that a position is unprotected while this process is down");
});
