/**
 * X1 — a malformed JSON body must never reach a log line or an error answer.
 *
 * body-parser attaches the raw request text to its 400 (`err.body`), and V8's
 * JSON.parse message quotes a slice of the input. The terminal error handler
 * used to `console.error(…, err)`, so a truncated POST to the exchange-account
 * route printed the API key and secret to stdout (trace §0 X1), and a broken
 * webhook body printed its webhook secret.
 *
 * Driven through the real `createApp()` composition, so the parser order the
 * server runs is the one under test. Every console method is captured while
 * the requests run (the process's own std streams carry the test reporter's
 * protocol, so they are left alone; this codebase logs only through console).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".error-log-hygiene-test.db");
process.env.DATABASE_URL = "file:./tests/.error-log-hygiene-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { createApp } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");

let server: Server;
let baseUrl = "";

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

/** Run `fn` with every console method captured. */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const saved = methods.map((m) => console[m]);
  const sink = (...args: unknown[]) => {
    chunks.push(args.map((a) => {
      if (typeof a === "string") return a;
      try { return `${JSON.stringify(a)} ${String(a)} ${(a as { stack?: string }).stack ?? ""} ${JSON.stringify((a as { body?: unknown }).body ?? "")}`; }
      catch { return String(a); }
    }).join(" "));
  };
  for (const m of methods) (console as unknown as Record<string, unknown>)[m] = sink;
  try {
    await fn();
  } finally {
    methods.forEach((m, i) => { (console as unknown as Record<string, unknown>)[m] = saved[i]; });
  }
  return chunks.join("\n");
}

// Key-like markers, assembled at runtime (no credential-shaped literal in source).
const API_KEY = `AKEY${"Q7".repeat(14)}`;
const API_SECRET = `ASEC${"Z9".repeat(14)}`;
const WEBHOOK_SECRET = `WHS${"k3".repeat(16)}`;

/**
 * Malformed on purpose: the unquoted value makes V8 quote the surrounding
 * input in its SyntaxError message, the worst case for a leak.
 */
const MALFORMED: Array<{ path: string; body: string; secrets: string[] }> = [
  { path: "/api/exchange-accounts",
    body: `{"name":"x","apiKey":"${API_KEY}","apiSecret": ${API_SECRET}}`, secrets: [API_KEY, API_SECRET] },
  { path: "/api/bots",
    body: `{"name":"x","apiKey":"${API_KEY}","apiSecret":"${API_SECRET}"`, secrets: [API_KEY, API_SECRET] },
  { path: "/api/enroll/keys",
    body: `{"apiKey":"${API_KEY}","apiSecret": ${API_SECRET}}`, secrets: [API_KEY, API_SECRET] },
  { path: "/api/webhooks/signal_bots",
    body: `{"secret":"${WEBHOOK_SECRET}","action": sell}`, secrets: [WEBHOOK_SECRET] },
  { path: "/api/manual-trading/control/bots",
    body: `{"name":"x","webhookSecret": ${WEBHOOK_SECRET}}`, secrets: [WEBHOOK_SECRET] },
];

for (const c of MALFORMED) {
  test(`X1: malformed JSON to ${c.path} logs and answers no part of the body`, async () => {
    let status = 0;
    let answer = "";
    const output = await captureOutput(async () => {
      const response = await fetch(`${baseUrl}${c.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: c.body,
      });
      status = response.status;
      answer = await response.text();
    });
    assert.ok(status >= 400 && status < 500, `a malformed body is a client error, got ${status}`);
    for (const secret of c.secrets) {
      assert.equal(output.includes(secret), false, `the log must not contain a submitted value (${c.path})`);
      assert.equal(answer.includes(secret), false, `the answer must not echo a submitted value (${c.path})`);
    }
  });
}

test("X1: the parse failure is still logged, as method, path, status and type only", async () => {
  const output = await captureOutput(async () => {
    await fetch(`${baseUrl}/api/exchange-accounts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: `{"apiKey": ${API_KEY}}`,
    });
  });
  assert.match(output, /POST \/api\/exchange-accounts -> 400/);
  assert.match(output, /entity\.parse\.failed/);
  assert.equal(output.includes(API_KEY), false);
});

test("X1: an oversized body is refused with no echo and no log of its content", async () => {
  const big = `{"apiSecret":"${API_SECRET}","pad":"${"p".repeat(120_000)}"}`;
  let status = 0;
  const output = await captureOutput(async () => {
    const response = await fetch(`${baseUrl}/api/exchange-accounts`, {
      method: "POST", headers: { "content-type": "application/json" }, body: big,
    });
    status = response.status;
    await response.text();
  });
  assert.equal(status, 413);
  assert.equal(output.includes(API_SECRET), false);
});
