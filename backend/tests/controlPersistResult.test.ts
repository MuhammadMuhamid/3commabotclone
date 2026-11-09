/**
 * X2 — a control command whose live answer carries a secret stores and
 * replays only a non-secret projection (`persistResult`).
 *
 * Before the hook, `runControlCommand` wrote the live body to
 * `BotControlCommand.result` and C8 / a same-request replay returned it, so a
 * webhook secret or an enrollment ticket returned by a command would sit at
 * rest in the Bot database and be readable again (trace §0 X2).
 */
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".control-persist-result-test.db");
process.env.DATABASE_URL = "file:./tests/.control-persist-result-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { prisma } = await import("../src/lib/prisma.js");
const { runControlCommand, readControlCommand } = await import("../src/services/controlCommands.js");

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

beforeEach(async () => { await prisma.botControlCommand.deleteMany(); });

const ACTOR = {
  platformUserId: "00000000-0000-4000-8000-000000000001",
  stepUp: { method: "totp" as const, at: "2026-11-09T00:00:00.000Z" },
};
const SECRET = `live-${"s".repeat(40)}`;
let seq = 0;
const rid = () => `persist_${Date.now().toString(36)}_${String(seq++).padStart(6, "0")}`;

test("X2: the live answer carries the secret; the row, the replay and C8 carry only the projection", async () => {
  const requestId = rid();
  let runs = 0;
  const command = {
    requestId, kind: "bot_rotate_secret" as const, target: "bot:x", params: {}, actor: ACTOR,
    persistResult: (body: unknown) => {
      const { webhookSecret: _omit, ...rest } = body as Record<string, unknown>;
      return { ...rest, secretIssued: true };
    },
  };
  const action = async () => { runs += 1; return { body: { bot: { id: "x" }, webhookSecret: SECRET } }; };

  const live = await runControlCommand(command, action);
  assert.equal(live.replayed, false);
  assert.equal((live.body as { webhookSecret: string }).webhookSecret, SECRET);

  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(row.result?.includes(SECRET), false, "the secret is never at rest");
  assert.deepEqual(JSON.parse(row.result ?? "{}"), { bot: { id: "x" }, secretIssued: true });

  const replay = await runControlCommand(command, action);
  assert.equal(replay.replayed, true);
  assert.equal(runs, 1, "a replay never re-runs the action (no second secret)");
  assert.equal(JSON.stringify(replay.body).includes(SECRET), false);
  assert.equal((replay.body as { secretIssued?: boolean }).secretIssued, true);

  const c8 = await readControlCommand(requestId);
  assert.equal(JSON.stringify(c8).includes(SECRET), false);
});

test("X2: a projection that throws stores nothing — never the unprojected body", async () => {
  const requestId = rid();
  const live = await runControlCommand({
    requestId, kind: "enrollment_create", target: "enrollment", params: {}, actor: ACTOR,
    persistResult: () => { throw new Error("projection bug"); },
  }, async () => ({ body: { enrollmentId: "e1", enrollUrl: `https://bot.example/enroll#t=${SECRET}` } }));
  assert.equal(live.httpStatus, 200);
  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.equal(row.status, "succeeded");
  assert.equal(row.result, null);
});

test("X2: without a projection, the stored body is the live body (existing commands unchanged)", async () => {
  const requestId = rid();
  await runControlCommand({ requestId, kind: "halt", target: "bot", params: {}, actor: ACTOR },
    async () => ({ body: { halted: true } }));
  const row = await prisma.botControlCommand.findUniqueOrThrow({ where: { requestId } });
  assert.deepEqual(JSON.parse(row.result ?? "{}"), { halted: true });
});

test("X1 × control: an internal failure is logged by class name only, never its message", async () => {
  const lines: string[] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const outcome = await runControlCommand({
      requestId: rid(), kind: "bot_create", target: "bot:new", params: {}, actor: ACTOR,
    }, async () => { throw new Error(`prisma said webhookSecret: "${SECRET}"`); });
    assert.equal(outcome.httpStatus, 500);
  } finally {
    console.error = saved;
  }
  assert.equal(lines.join("\n").includes(SECRET), false);
  assert.match(lines.join("\n"), /name=Error/);
});
