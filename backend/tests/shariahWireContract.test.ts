/**
 * The signed Shariah decision must survive every execution channel's schema.
 *
 * The Platform builds one `shariah` block and attaches it to every order it
 * sends, on every channel — that is the whole mechanism by which an executing
 * side can see which policy allowed an entry. `derivativeExecution.ts` declared
 * the field. `spotExecution`, `equityExecution` and `traditionalExecution` did
 * not, and all three parse `.strict()` schemas, which reject an undeclared key
 * outright.
 *
 * So on three of the four channels the gate would have answered 400 to EVERY
 * order by rejecting its own evidence — a refusal indistinguishable, from the
 * Platform's side, from a validation error in the order itself. Bounded in
 * practice only because all four channels are paper/testnet-only and default
 * off.
 *
 * This reads the route sources rather than mounting four routers, because the
 * property under test is a property of the SCHEMAS: that all four declare the
 * same block, and that a channel added later cannot quietly omit it.
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

test("every execution channel declares the Shariah block its Platform sends", () => {
  const missing: string[] = [];
  for (const file of CHANNELS) {
    const source = read(file);
    // Declared as a schema, AND actually attached to the command it parses.
    const declares = /const shariah = z\.object\(\{/.test(source);
    const accepts = /shariah:\s*shariah\.optional\(\)/.test(source);
    if (!declares || !accepts) missing.push(file);
  }
  assert.deepEqual(missing, [],
    "these channels parse a strict schema that would reject the Platform's own "
    + "signed decision, answering 400 to every order");
});

test("the four channels agree on the block's shape — there is one wire contract", () => {
  /*
   * Four copies of a contract are four chances to drift. They are literal
   * copies today and this is what keeps them one contract: a field widened on
   * one channel and not the others is the shape of a bug that only appears on
   * whichever channel an operator happens to enable.
   */
  const shapes = CHANNELS.map((file) => {
    const source = read(file);
    const match = /const shariah = z\.object\(\{[\s\S]*?\}\)\.strict\(\);/.exec(source);
    assert.ok(match, `${file} has no Shariah block declaration to compare`);
    return match[0].replace(/\s+/g, " ").trim();
  });
  for (let i = 1; i < shapes.length; i += 1) {
    assert.equal(shapes[i], shapes[0],
      `${CHANNELS[i]} declares a different Shariah block from ${CHANNELS[0]}`);
  }
});

test("the block is optional everywhere — an installation with no Platform gate still trades", () => {
  // `.optional()` rather than required: the Bot accepts direct webhooks from
  // senders that have no Shariah decision to attach, and its own installation
  // floor is what protects those. Requiring the field here would break them.
  for (const file of CHANNELS) {
    assert.match(read(file), /shariah:\s*shariah\.optional\(\)/,
      `${file} requires the block; a sender without one would be refused`);
  }
});
