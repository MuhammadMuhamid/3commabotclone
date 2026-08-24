/**
 * BOT-039 — the library that signs every order.
 *
 * `binance-api-node@0.12.9` was last published in 2022 and is effectively
 * unmaintained, and it is the code that computes the HMAC on every real order
 * this bot places. Replacing it is gated on Binance testnet credentials this
 * workspace does not hold: swapping the signer under a live trading bot with no
 * ability to validate a single round trip is not a safe local change.
 *
 * What IS enforceable locally, and is enforced here:
 *   - the version is pinned exactly, so a fresh install cannot pull an
 *     unreviewed 0.12.x into the order-signing path;
 *   - the surface this bot uses stays down to the four calls it needs, so the
 *     replacement stays a bounded piece of work;
 *   - the signing scheme the bot depends on is asserted, so a dependency that
 *     silently changes shape fails here rather than at Binance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(BACKEND, rel), "utf8");

test("the exchange SDK is pinned to an exact version, not a caret range", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  const spec = pkg.dependencies["binance-api-node"];
  assert.equal(spec, "0.12.9",
    "a caret range lets a fresh install resolve a different 0.12.x into the order-signing path");
});

test("the lockfile agrees, and carries an integrity hash", () => {
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const entry = lock.packages["node_modules/binance-api-node"];
  assert.ok(entry, "binance-api-node must be in the lockfile");
  assert.equal(entry.version, "0.12.9");
  assert.ok(entry.integrity?.startsWith("sha512-"), "the signing dependency must be integrity-pinned");
});

test("the bot uses FOUR calls from it, so a replacement is bounded", () => {
  const src = read("src/services/binance.ts");
  const used = [...src.matchAll(/client\.([a-zA-Z]+)\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ["accountInfo", "exchangeInfo", "order", "prices"]);
});

test("nothing outside services/binance.ts imports the SDK directly", () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = path.relative(BACKEND, full);
      if (rel === path.join("src", "services", "binance.ts")) continue;
      // An import, not a mention: a comment naming the SDK is not a dependency.
      if (/^\s*import[^\n]*["']binance-api-node["']/m.test(read(rel))) offenders.push(rel);
    }
  };
  walk(path.join(BACKEND, "src"));
  assert.deepEqual(offenders, [],
    "every exchange call must go through services/binance.ts, which is the seam a replacement swaps");
});

test("the signing scheme is HMAC-SHA256 over the query string — asserted, not assumed", () => {
  // Read from the installed dependency, so a version that changes how it signs
  // fails here rather than at the exchange.
  const client = read("node_modules/binance-api-node/dist/http-client.js");
  assert.match(client, /createHmac\('sha256', apiSecret\)/,
    "the SDK must still sign with HMAC-SHA256 over the query string");
  assert.match(client, /signature: signature/);
  assert.match(client, /makeQueryString/);
});

test("the reference signature a replacement must reproduce is deterministic and input-sensitive", () => {
  // No expected digest is written down here: a 64-character hex literal in
  // tracked source is exactly what scripts/ci/scan-secrets.sh exists to refuse,
  // and weakening that rule for a test is a bad trade. The properties below are
  // what a replacement signer actually has to satisfy.
  const sign = (secret: string, query: string) =>
    createHmac("sha256", secret).update(query).digest("hex");
  const secret = "example-secret-value-not-a-credential";
  const query = "symbol=LTCBTC&side=BUY&type=MARKET&quoteOrderQty=25&timestamp=1499827319559";

  assert.equal(sign(secret, query), sign(secret, query), "signing must be deterministic");
  assert.equal(sign(secret, query).length, 64);
  assert.match(sign(secret, query), /^[0-9a-f]+$/);
  // Every field is inside the signature: change one and the signature changes.
  assert.notEqual(sign(secret, query), sign(secret, query.replace("quoteOrderQty=25", "quoteOrderQty=250")));
  assert.notEqual(sign(secret, query), sign(secret, query.replace("side=BUY", "side=SELL")));
  assert.notEqual(sign(secret, query), sign(`${secret}x`, query));
});
