/**
 * OD-3 — the Classic dashboard's "Pause new entries" control (break-glass
 * parity with the Platform's signed C9).
 *
 * Source assertions, in the idiom of `dashboardFixes.test.ts`: this repository
 * has no DOM harness. What must hold:
 *
 *   - the pause is read from `ops.entries`, its own field — never inferred from
 *     the halt or from `mode` — and the control is hidden on an older Bot that
 *     does not report it;
 *   - a paused Bot shows an ENTRIES PAUSED pill beside the mode and the halt,
 *     and a banner stating what the pause does and does not stop;
 *   - pausing asks for a reason, and cancelling resting LIMIT BUYs is a
 *     separate, explicit opt-in;
 *   - the API calls `/api/ops/entries` with the target state, never the halt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (...parts: string[]) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "src", ...parts), "utf8");

/** The text of one top-level function in a page, so assertions stay local. */
function fnBody(source: string, name: string): string {
  const start = source.search(new RegExp(`function ${name}\\b`));
  assert.notEqual(start, -1, `function ${name} must exist`);
  const next = source.slice(start + 1).search(/\n(?:export default )?function \w+/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

/** The dashboard's `toggleEntries` handler (a const inside the component). */
function toggleEntriesBody(source: string): string {
  const start = source.indexOf("const toggleEntries = async");
  const end = source.indexOf("const load = useCallback", start);
  assert.ok(start !== -1 && end > start, "toggleEntries must exist before load");
  return source.slice(start, end);
}

test("OD-3: the API posts the target state to /api/ops/entries, separate from halt and resume", () => {
  const api = src("api.ts");
  assert.match(api, /"\/api\/ops\/entries"/);
  assert.match(api, /entries: \(target: \{ paused: true; reason: string; cancelWorkingEntries\?: boolean \} \| \{ paused: false \}\)/);
  assert.match(api, /export interface EntriesStatus/);
  assert.match(api, /workingEntryLimits: number/);
});

test("OD-3: the pause state comes from ops.entries and the control is hidden when the Bot does not report it", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.match(dashboard, /setEntries\(ops\?\.entries \?\? null\)/);
  assert.match(dashboard, /\{entries && \(\s*<Btn/, "no switch on an older Bot without one");
  assert.match(dashboard, /entries\.paused \? "Resume new entries" : "Pause new entries"/);
  assert.doesNotMatch(toggleEntriesBody(dashboard), /api\.ops\.(halt|resume)\(/,
    "pausing entries never touches the halt");
});

test("OD-3: a paused Bot shows the ENTRIES PAUSED pill and a banner with the real policy", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.match(dashboard, /\{entries\?\.paused && <EntriesPausedPill entries=\{entries\} \/>\}/);
  assert.match(fnBody(dashboard, "EntriesPausedPill"), /ENTRIES PAUSED/);
  assert.match(dashboard, /New entries paused\{entries\.reason/);
  assert.match(dashboard, /const ENTRIES_PAUSE_POLICY =/);
  assert.match(dashboard, /Exits, TP\/SL " \+\s*"protection and your own SELL \/ Close \/ Partial keep working/);
  assert.match(dashboard, /is not stopped by the pause unless you also cancel it/);
});

test("OD-3: pausing needs a reason, and cancelling resting LIMIT BUYs is a separate explicit opt-in", () => {
  const toggle = toggleEntriesBody(src("pages", "Dashboard.tsx"));
  assert.match(toggle, /reason\.trim\(\)\.length < 3/);
  assert.match(toggle, /const cancelWorkingEntries = entries\.workingEntryLimits > 0 && confirm\(/);
  assert.match(toggle, /NOT confirmed/, "an unconfirmed cancel is reported, never hidden");
});
