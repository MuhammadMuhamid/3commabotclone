/**
 * WS-BOTCMD contract §8 — Bot dashboard display defects.
 *
 *   0.4  the Halt/Resume control and the halt itself were hidden whenever the
 *        mode was DRY_RUN, and production runs DRY_RUN — so a halted dry-run
 *        Bot could not be seen as halted, or resumed, from its own dashboard;
 *   0.5  the halt prompt said "every entry and exit will be refused", while an
 *        operator's own exits (Close, Partial, manual SELL) pass a halt and the
 *        TP/SL monitors stop;
 *   U3   Close / Partial were offered on MANUAL rows, which the Bot refuses;
 *   U4   the create page rendered an empty "Entry signal JSON" (direct
 *        TradingView BUYs are disabled), and EditBot's Reveal waited for that
 *        same never-served field, so it showed nothing;
 *   U5   the exchange-account form defaulted to MAINNET.
 *
 * Source assertions, in the idiom of `protectiveOrders.test.ts`: this
 * repository has no DOM harness, and each defect here is a value never read,
 * a gate on the wrong field, or wrong copy.
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

const HALT_POLICY =
  "While the Bot is halted, TP/SL protection is not checked and TradingView exits are refused; " +
  "your own SELL / Close / Partial still work.";

// ── 0.4: halt visible, and controllable, in DRY_RUN ─────────────────────────

test("0.4: the Halt/Resume control is not hidden in DRY_RUN", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.doesNotMatch(dashboard, /opsMode !== "DRY_RUN" && \(/,
    "the control must render whatever the dry-run setting is");
  assert.doesNotMatch(dashboard, /opsMode === "HALTED" \?/,
    "halted is read from the risk state, not from a mode in which DRY_RUN hides HALTED");
});

test("0.4: the halt state comes from risk.tradingHalted, independent of dry run", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.match(dashboard, /ops\?\.risk\.tradingHalted/,
    "the dashboard must read the halt from `risk.tradingHalted`, which DRY_RUN does not mask");
  assert.match(fnBody(dashboard, "OpsBadge"), /halted/,
    "the badge must be able to show HALTED alongside DRY RUN");
});

// ── 0.5 / F2: the halt copy states the real policy ──────────────────────────

test("0.5: the halt prompt no longer claims every exit is refused, and states the real policy", () => {
  const dashboard = src("pages", "Dashboard.tsx");
  assert.doesNotMatch(dashboard, /Every entry and exit will be refused/);
  const joined = dashboard.replace(/"\s*\+\s*"/g, "");
  assert.ok(joined.includes(HALT_POLICY), "the policy sentence must be stated exactly");
  const prompt = dashboard.slice(dashboard.indexOf("const reason = prompt("));
  assert.match(prompt.slice(0, prompt.indexOf(");")), /HALT_POLICY/,
    "and the halt prompt itself must carry it");
});

// ── U3: no Close / Partial on manual rows ───────────────────────────────────

test("U3: the trade type carries `source`, and manual rows get no Close or Partial", () => {
  const api = src("api.ts");
  assert.match(api, /source\??: "strategy" \| "manual"/, "SmartTrade must type the source the API sends");
  const row = fnBody(src("pages", "Dashboard.tsx"), "TradeRow");
  assert.match(row, /source === "manual"/, "the row must branch on the trade's source");
  assert.match(row, /Trading Scene/, "and say where a manual position is managed");
});

test("U3: no dashboard copy advises closing a position on Binance", () => {
  for (const page of ["Dashboard.tsx", "EditBot.tsx", "CreateBot.tsx"]) {
    assert.doesNotMatch(src("pages", page), /[Cc]lose[^"\n]*on Binance/, page);
  }
});

// ── U4: no entry JSON; Reveal reads what the backend serves ─────────────────

test("U4: the create page renders no entry-signal JSON, and shows the exit-only note", () => {
  const create = src("pages", "CreateBot.tsx");
  assert.doesNotMatch(create, /entryWebhookJson/);
  assert.doesNotMatch(create, /Entry signal JSON/);
  assert.match(create, /tradingViewSetup/, "the backend's exit-only note must be rendered");
  assert.match(create, /exitWebhookJson/);
});

test("U4: EditBot's Reveal gates on exitWebhookJson, which the backend actually returns", () => {
  const edit = src("pages", "EditBot.tsx");
  assert.doesNotMatch(edit, /entryWebhookJson/);
  assert.match(edit, /revealed\?\.exitWebhookJson/);
  assert.doesNotMatch(src("api.ts"), /entryWebhookJson/);
});

// ── U5: testnet first; mainnet only on a typed confirmation ─────────────────

test("U5: the exchange-account form starts on testnet and resets to testnet", () => {
  const settings = src("pages", "Settings.tsx");
  assert.match(settings, /const \[testnet, setTestnet\] = useState\(true\)/);
  assert.doesNotMatch(settings, /setTestnet\(false\)/, "a reset must never fall back to mainnet");
});

test("U5: a mainnet account needs the typed MAINNET confirmation, and the API always gets a boolean", () => {
  const settings = src("pages", "Settings.tsx");
  assert.match(settings, /"MAINNET"/);
  assert.match(settings, /mainnetConfirmation/);
  assert.match(src("api.ts"), /testnet: boolean \}/, "`testnet` is required in the create body");
});
