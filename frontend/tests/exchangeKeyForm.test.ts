/**
 * Slice 2 — the dashboard's exchange-key form (parity inventory §5 #10–#12).
 *
 *   #10  the typed MAINNET confirmation is SENT, so the server can verify it
 *        (it used to be checked in the browser only);
 *   #11  the API key was a plain text input; both key inputs are now
 *        password fields with autocomplete off, shared with enroll.html;
 *   #12  the remove prompt claimed bots "will lose their credentials", while
 *        the server refuses removal of an account in use.
 *
 * Source assertions, in this repository's idiom (no DOM harness).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = (...parts: string[]) =>
  fs.readFileSync(path.join(import.meta.dirname, "..", "src", ...parts), "utf8");

test("#10: Settings sends mainnetConfirmation to the API when the account is mainnet", () => {
  const settings = src("pages", "Settings.tsx");
  assert.match(settings, /api\.exchange\.create\(\{[\s\S]*?testnet \? \{\} : \{ mainnetConfirmation \}/);
  assert.match(src("api.ts"), /mainnetConfirmation\?: string/);
});

test("#11: both key inputs are password fields with autocomplete off, in one shared component", () => {
  const fields = src("components", "ExchangeKeyFields.tsx");
  const inputs = fields.match(/<Input[\s\S]*?\/>/g) ?? [];
  const keyInputs = inputs.filter((i) => /label="API (Key|Secret)"/.test(i));
  assert.equal(keyInputs.length, 2);
  for (const input of keyInputs) {
    assert.match(input, /type="password"/);
    assert.match(input, /autoComplete="off"/);
  }
  assert.match(src("components", "ui.tsx"), /autoComplete=\{autoComplete\}/, "Input forwards autoComplete");
  const settings = src("pages", "Settings.tsx");
  assert.match(settings, /<ExchangeKeyInputs/);
  assert.doesNotMatch(settings, /label="API Key"/, "no second, divergent copy of the key input");
});

test("#12: the remove prompt no longer claims bots lose their credentials", () => {
  const settings = src("pages", "Settings.tsx");
  assert.doesNotMatch(settings, /will lose their credentials/);
  assert.match(settings, /refused while any bot, order or position still uses it/);
});

test("§5 #5: limit entries cannot be newly selected; a stored limit stays visible and editable", () => {
  const fields = src("components", "BotFormFields.tsx");
  assert.match(fields, /disabled=\{t === "limit" && form\.entryOrderType !== "limit"\}/);
});
