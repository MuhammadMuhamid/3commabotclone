/**
 * OD-4 — the Bot-origin enrollment page (`enroll.html`).
 *
 * The fragment stripper is executed for real against stub `location` /
 * `history` globals; the rest are source assertions in this repository's
 * idiom (no DOM harness).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("the ticket is read once and removed from the URL before anything else runs", async () => {
  const ticket = "T".repeat(20) + "_-" + "a".repeat(21);
  const calls: unknown[][] = [];
  const g = globalThis as Record<string, unknown>;
  g.location = { hash: `#t=${ticket}`, pathname: "/enroll" };
  g.history = { replaceState: (...args: unknown[]) => { calls.push(args); } };
  try {
    const mod = await import("../src/enroll/fragment.ts");
    assert.equal(mod.ticketFromFragment, ticket);
    assert.deepEqual(calls, [[null, "", "/enroll"]], "the fragment is replaced away, path kept");
  } finally {
    delete g.location;
    delete g.history;
  }
  const main = read("src", "enroll", "main.tsx");
  const firstImport = main.split("\n").find((l) => l.startsWith("import "));
  assert.equal(firstImport, 'import { ticketFromFragment } from "./fragment";', "fragment.ts is the first import");
});

test("a malformed fragment yields no ticket (and is still stripped)", () => {
  const src = read("src", "enroll", "fragment.ts");
  assert.match(src, /\^#t=\(\[A-Za-z0-9_-\]\{43\}\)\$/);
  assert.match(src, /if \(raw\) history\.replaceState\(null, "", location\.pathname\)/);
});

test("a separate entry: no dashboard router, auth context or API client, and no browser storage", () => {
  const files = ["main.tsx", "EnrollApp.tsx", "enrollApi.ts", "fragment.ts"].map((f) => read("src", "enroll", f)).join("\n");
  for (const forbidden of [/from "\.\.\/App"/, /react-router/, /AuthContext/, /from "\.\.\/api"/,
    /localStorage/, /sessionStorage/, /serviceWorker/]) {
    assert.doesNotMatch(files, forbidden);
  }
  const vite = read("vite.config.ts");
  assert.match(vite, /enroll: resolve\(import\.meta\.dirname, "enroll\.html"\)/);
  const html = read("enroll.html");
  assert.match(html, /src="\/src\/enroll\/main\.tsx"/);
  assert.match(html, /<meta name="referrer" content="no-referrer" \/>/);
  assert.doesNotMatch(html, /fonts\.googleapis/);
});

test("keys are entered through the shared password fields, with the shared MAINNET confirmation", () => {
  const app = read("src", "enroll", "EnrollApp.tsx");
  assert.match(app, /<ExchangeKeyInputs /);
  assert.match(app, /<MainnetConfirmationField /);
  assert.match(app, /isMainnetConfirmed\(testnet, mainnetConfirmation\)/);
  assert.doesNotMatch(app, /<input[^>]*type="text"/);
});

test("the API helper posts same-origin JSON with no Referer and no cache", () => {
  const api = read("src", "enroll", "enrollApi.ts");
  assert.match(api, /method: "POST"/);
  assert.match(api, /credentials: "same-origin"/);
  assert.match(api, /"content-type": "application\/json"/);
  assert.match(api, /referrerPolicy: "no-referrer"/);
  assert.match(api, /cache: "no-store"/);
});

test("the reveal view shows the secret and the exit-only JSON with copy controls", () => {
  const app = read("src", "enroll", "EnrollApp.tsx");
  assert.match(app, /<CopyField label="Webhook secret" value=\{answer\.webhookSecret\} \/>/);
  assert.match(app, /exitWebhookJson/);
  assert.match(app, /Direct TradingView BUY alerts are disabled/);
});

test("container nginx serves /enroll with a strict, uncached, no-referrer policy and caps the API body", () => {
  const conf = read("nginx.conf");
  const page = conf.slice(conf.indexOf("location ~ ^/enroll"));
  assert.match(page, /Cache-Control\s+"no-store"/);
  assert.match(page, /Referrer-Policy\s+"no-referrer"/);
  assert.match(page, /form-action 'none'/);
  assert.match(page, /try_files \/enroll\.html =404;/);
  assert.match(conf, /location \/api\/enroll\/ \{\s*\n\s*client_max_body_size 4k;/);
});
