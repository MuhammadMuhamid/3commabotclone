/**
 * Feature B — the Classic dashboard archives a closed trade instead of
 * deleting it. Source assertions, in the idiom of `dashboardFixes.test.ts`:
 * this repository has no DOM harness.
 *
 *   - no client calls `DELETE /api/trades/:id` any more;
 *   - the row action is Archive (and Restore for an archived row), with the
 *     owner-approved confirm text, and the server's refusal reason is shown;
 *   - History totals are computed from ALL closed trades (the list loads
 *     `archived=include`), and only the list hides archived rows by default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (...parts: string[]) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "src", ...parts), "utf8");

const api = src("api.ts");
const dashboard = src("pages", "Dashboard.tsx");

test("the trade delete call is gone; archive and restore are POSTs", () => {
  assert.doesNotMatch(api, /\/api\/trades\/\$\{id\}`,\s*\{\s*method:\s*"DELETE"/);
  assert.match(api, /archive: \(id: string\) => request<TradeArchiveResult>\(`\/api\/trades\/\$\{id\}\/archive`, \{ method: "POST" \}\)/);
  assert.match(api, /restore: \(id: string\) => request<TradeArchiveResult>\(`\/api\/trades\/\$\{id\}\/restore`, \{ method: "POST" \}\)/);
  assert.doesNotMatch(dashboard, /api\.trades\.remove/);
  assert.doesNotMatch(dashboard, /\bTrash2\b/);
});

test("Archive / Restore row actions with the approved confirm text and the server's reason", () => {
  assert.match(dashboard, /<Archive size=\{13\} \/>/);
  assert.match(dashboard, /<ArchiveRestore size=\{13\} \/>/);
  assert.ok(dashboard.includes("It will be hidden from History. "));
  assert.ok(dashboard.includes("Its P&L and daily-loss history are kept. You can restore it."));
  assert.match(dashboard, /`Archive this \$\{formatPair\(t\.pair\)\} trade\?/);
  // A refusal's message (the server's `error`) is what the toast shows.
  assert.match(dashboard, /toast\(e instanceof Error \? e\.message : "Archive failed", "error"\)/);
  // A row the server already says it would refuse is disabled, with the reason.
  assert.match(dashboard, /disabled=\{busy \|\| Boolean\(t\.archiveBlocked\)\}/);
  assert.match(dashboard, /Cannot archive yet: \$\{t\.archiveBlocked\.message\}/);
  assert.match(dashboard, /<Badge variant="muted">Archived<\/Badge>/);
});

test("History totals include archived trades; the list hides them unless Show archived", () => {
  assert.match(dashboard, /api\.trades\.list\(tradeTab, undefined, tradeTab === "history" \? "include" : undefined\)/);
  // The summary bar is fed the full list, never the filtered one.
  assert.match(dashboard, /<HistoryStatsBar trades=\{trades\} \/>/);
  assert.doesNotMatch(dashboard, /<HistoryStatsBar trades=\{visibleTrades\} \/>/);
  assert.match(dashboard, /const visibleTrades = tradeTab === "history" && !showArchived\s*\? trades\.filter\(\(t\) => !t\.archivedAt\) : trades;/);
  assert.match(dashboard, /visibleTrades\.map\(\(t\) => \(/);
  assert.ok(dashboard.includes("Show archived"));
  assert.ok(dashboard.includes("Totals include archived trades"));
});
