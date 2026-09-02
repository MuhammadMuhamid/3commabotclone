import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const backendRoot = path.join(import.meta.dirname, "..");
const repositoryRoot = path.join(backendRoot, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bot-backup-restore-owned-"));
const source = path.join(scratch, "source.db");
const offlineSource = path.join(scratch, "source.offline.db");
const backup = path.join(scratch, "backup.db");
const target = path.join(scratch, "fresh-restore.db");
const helper = path.join(backendRoot, "tests", "helpers", "backupRestoreFixture.mjs");
const prismaCli = path.join(backendRoot, "node_modules", "prisma", "build", "index.js");
const backupScript = path.join(repositoryRoot, "scripts", "backup-db.sh");
const restoreScript = path.join(repositoryRoot, "scripts", "restore-db.sh");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fixtureEnvironment(database: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    DRY_RUN: "true",
    DATABASE_URL: `file:${database}`,
    ENCRYPTION_KEY: "test-only-backup-key-0000000000000000",
    SCRYPT_SALT: "00112233445566778899aabbccddeeff",
    JWT_SECRET: "test-only-backup-jwt-000000000000000000000000",
    SECURE_COOKIES: "false",
  };
}

function runFixture(mode: "seed" | "verify", database: string): unknown {
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", helper, mode], {
    cwd: backendRoot,
    env: fixtureEnvironment(database),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
}

function runScript(script: string, args: string[]) {
  return spawnSync(script, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

test("a task-owned Bot database backs up and restores into an independent application-readable target", () => {
  assert.match(path.basename(scratch), /^bot-backup-restore-owned-/);
  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.existsSync(target), false);

  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: backendRoot,
    env: fixtureEnvironment(source),
    stdio: "pipe",
  });
  const expected = runFixture("seed", source);

  const backedUp = runScript(backupScript, ["--source", source, "--output", backup]);
  assert.equal(backedUp.status, 0, backedUp.stderr);
  assert.match(backedUp.stdout, /integrity ok; foreign keys ok; current Bot schema present/);
  assert.match(backedUp.stdout, /SHA-256 [0-9a-f]{64}/);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);

  fs.renameSync(source, offlineSource);
  assert.equal(fs.existsSync(source), false, "source is removed from the verification path");
  const restored = runScript(restoreScript, ["--backup", backup, "--target", target]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /restored database: integrity ok/);
  assert.notEqual(fs.statSync(target).ino, fs.statSync(backup).ino);

  const verified = runFixture("verify", target) as {
    state: unknown;
    recoveryBehavior: {
      existingIntentId: string;
      strategyIntentCount: number;
      alreadyReconciled: Record<string, unknown>;
      pendingIntent: Record<string, unknown>;
      commandReplay: unknown;
      commandActionCalls: number;
      nonceReplay: boolean;
      webhookReplay: unknown;
      webhookClientCalls: number;
    };
  };
  assert.deepEqual(verified.state, expected);
  assert.equal(verified.recoveryBehavior.existingIntentId, "intent-partial-fixture");
  assert.equal(verified.recoveryBehavior.strategyIntentCount, 2);
  assert.deepEqual(verified.recoveryBehavior.alreadyReconciled, {
    appliedNow: false,
    pending: false,
    reconciledSubmitCalls: 0,
    reconciledQueryCalls: 0,
  });
  assert.deepEqual(verified.recoveryBehavior.pendingIntent, {
    pending: true,
    pendingSubmitCalls: 0,
    pendingQueryCalls: 1,
    status: "submitted",
  });
  assert.deepEqual(verified.recoveryBehavior.commandReplay, {
    id: "manual-order-fixture",
    requestId: "manual-request-fixed",
  });
  assert.equal(verified.recoveryBehavior.commandActionCalls, 0);
  assert.equal(verified.recoveryBehavior.nonceReplay, false);
  assert.deepEqual(verified.recoveryBehavior.webhookReplay, { status: "ignored_duplicate" });
  assert.equal(verified.recoveryBehavior.webhookClientCalls, 0);

  execFileSync(process.execPath, [prismaCli, "migrate", "status"], {
    cwd: backendRoot,
    env: fixtureEnvironment(target),
    stdio: "pipe",
  });
});

test("backup and restore fail closed on unsafe or incompatible inputs", () => {
  const collision = runScript(backupScript, ["--source", offlineSource, "--output", backup]);
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /refusing to overwrite existing backup/);

  const missing = runScript(restoreScript, [
    "--backup", path.join(scratch, "missing.db"), "--target", path.join(scratch, "missing-target.db"),
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not a regular file/);

  const ambiguous = runScript(restoreScript, ["--backup", backup]);
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stderr, /usage:/);

  const existingTarget = runScript(restoreScript, ["--backup", backup, "--target", target]);
  assert.notEqual(existingTarget.status, 0);
  assert.match(existingTarget.stderr, /without --replace/);

  const replacementTarget = path.join(scratch, "intentional-replacement.db");
  fs.writeFileSync(replacementTarget, "previous-database", { mode: 0o600 });
  fs.writeFileSync(`${replacementTarget}-wal`, "previous-wal", { mode: 0o600 });
  const replacement = runScript(restoreScript, [
    "--backup", backup, "--target", replacementTarget, "--replace",
  ]);
  assert.equal(replacement.status, 0, replacement.stderr);
  const safetyBase = fs.readdirSync(scratch)
    .find((name) => name.startsWith("intentional-replacement.db.replaced-") && !name.endsWith("-wal"));
  assert.ok(safetyBase);
  assert.equal(fs.readFileSync(path.join(scratch, safetyBase), "utf8"), "previous-database");
  assert.equal(fs.readFileSync(path.join(scratch, `${safetyBase}-wal`), "utf8"), "previous-wal");
  assert.equal(execFileSync("sqlite3", [replacementTarget, "PRAGMA integrity_check;"],
    { encoding: "utf8" }).trim(), "ok");

  const malformed = path.join(scratch, "truncated.db");
  fs.writeFileSync(malformed, fs.readFileSync(backup).subarray(0, 127), { mode: 0o600 });
  const malformedResult = runScript(restoreScript, [
    "--backup", malformed, "--target", path.join(scratch, "malformed-target.db"),
  ]);
  assert.notEqual(malformedResult.status, 0);
  assert.match(malformedResult.stderr, /failed SQLite integrity_check/);

  const wrongSchema = path.join(scratch, "wrong-schema.db");
  execFileSync("sqlite3", [wrongSchema, "CREATE TABLE unrelated (id TEXT PRIMARY KEY);"]);
  const incompatible = runScript(backupScript, [
    "--source", wrongSchema, "--output", path.join(scratch, "wrong-schema-backup.db"),
  ]);
  assert.notEqual(incompatible.status, 0);
  assert.match(incompatible.stderr, /missing required current Bot table/);
});
