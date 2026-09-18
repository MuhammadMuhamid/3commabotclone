/**
 * The signed Shariah decision must reach every channel, and must never be able
 * to stand between a position and its exit.
 *
 * Two defects, in sequence, and the second was caused by the fix for the first.
 *
 * ── First: three channels rejected the block outright ────────────────────
 *
 * The Platform builds one `shariah` block and attaches it to orders — that is
 * how an executing side can see which policy allowed an entry.
 * `derivativeExecution` declared the field; `spotExecution`, `equityExecution`
 * and `traditionalExecution` did not, and all four parse `.strict()` schemas,
 * which reject an undeclared key. So three of four would have answered 400 to
 * every order, by rejecting their own evidence.
 *
 * ── Second: declaring it STRICTLY made a malformed block able to block an
 *    exit ────────────────────────────────────────────────────────────────
 *
 * A strict `z.object` at the route means an unknown key, a lowercase `mode` or
 * a non-enum status refuses the whole request — and that request may be a
 * `reduceOnly` close. The route parses before the service reaches its
 * entry/exit branch, so the refusal lands on an exit.
 *
 * `routes/webhookSchema.ts` already had the right answer and states the reason:
 * "A Shariah block must never be able to stand between a position and its
 * exit." It uses `z.unknown().optional()` and lets the SERVICE interpret it,
 * on the entry path only. The four execution routes now match it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "routes");
const CHANNELS = [
  "spotExecution.ts", "derivativeExecution.ts",
  "equityExecution.ts", "traditionalExecution.ts",
] as const;

const read = (file: string): string => fs.readFileSync(path.join(ROUTES, file), "utf8");

test("every execution channel accepts the block the Platform sends", () => {
  const missing: string[] = [];
  for (const file of CHANNELS) {
    const source = read(file);
    // Declared, and actually present as a shorthand property on the command
    // the route parses — `shariah }` and `shariah,` are both spellings in use.
    const declared = /const shariah = /.test(source);
    const attached = /[,{]\s*shariah\s*[,}]/.test(source);
    if (!declared || !attached) missing.push(file);
  }
  assert.deepEqual(missing, [],
    "these channels would reject the Platform's own signed decision, answering 400 to every order");
});

test("no channel validates the block at the route — that is what blocks exits", () => {
  /*
   * The load-bearing assertion. A strict schema here is not a stricter
   * product: it is a malformed block acquiring the power to refuse a close.
   * The parent object stays `.strict()`, so nothing ELSE unknown gets in.
   */
  const offenders: string[] = [];
  for (const file of CHANNELS) {
    const source = read(file);
    if (!/const shariah = z\.unknown\(\)\.optional\(\);/.test(source)) offenders.push(file);
    if (!/\}\)\.strict\(\)/.test(source)) offenders.push(`${file} (parent no longer strict)`);
  }
  assert.deepEqual(offenders, [],
    "a route-level schema for the Shariah block can 400 a reduceOnly close; "
    + "the service interprets it instead, on the entry path only");
});

test("the rule is stated once, and the four channels did not each invent it", () => {
  // `webhookSchema.ts` is where the reasoning lives; the channels follow it
  // rather than carrying four copies of a decision that could drift apart.
  const schema = fs.readFileSync(path.join(ROUTES, "webhookSchema.ts"), "utf8");
  assert.match(schema, /never be able to stand between a position and its exit/,
    "the rule these four channels follow has moved or gone");
  assert.match(schema, /z\.unknown\(\)\.optional\(\)/);
});

test("the service reads the block on ENTRY only", () => {
  /*
   * The other half. `readShariahContext` throws on a malformed block, so
   * calling it above the entry/exit branch refuses an exit however permissive
   * the schema is — which is exactly what it used to do.
   */
  const service = fs.readFileSync(
    path.join(ROUTES, "..", "services", "derivativeExecution", "service.ts"), "utf8");
  const entry = service.indexOf("readShariahContext(command.shariah)");
  const branch = service.indexOf("!command.reduceOnly && !command.closePosition");
  assert.ok(entry > 0 && branch > 0, "the entry/exit branch could not be located");
  assert.ok(branch < entry,
    "the block is parsed before the entry/exit branch, so a malformed one refuses a close");
  assert.match(service, /noteSpotExit\(scope, command\.shariah/,
    "an exit must be handed the RAW block, so its own reader can swallow a bad one");
});
