/**
 * Phase 1 boundaries for the execution bot: what must fail closed, and what
 * must keep working.
 *
 * `config.ts` reads the environment at import time, so the fail-closed cases
 * run `assertConfig()` in a child process with a specific environment rather
 * than mutating `process.env` after the fact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  isPublishedPlaceholder,
  isUsableScryptSalt,
  SCRYPT_SALT_RE,
} from "../src/config.js";
import { maskSecret } from "../src/routes/bots.js";

const ROOT = path.join(import.meta.dirname, "..");

const VALID_KEY = "k".repeat(40);
const VALID_JWT = "j".repeat(64);
const VALID_SALT = "00112233445566778899aabbccddeeff";

/** Run `assertConfig()` in a clean child process; returns its stderr on failure. */
function bootConfig(env: Record<string, string | undefined>): { ok: boolean; message: string } {
  const clean: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    DATABASE_URL: "file:./tests/.tmp-config.db",
  };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'const { assertConfig } = await import("./src/config.ts"); assertConfig();',
      ],
      { cwd: ROOT, env: clean, stdio: ["ignore", "pipe", "pipe"] }
    );
    return { ok: true, message: "" };
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    return { ok: false, message: `${e.stderr?.toString() ?? ""}${e.stdout?.toString() ?? ""}` };
  }
}

const baseEnv = {
  ENCRYPTION_KEY: VALID_KEY,
  SCRYPT_SALT: VALID_SALT,
  JWT_SECRET: VALID_JWT,
};

// ── The checks run unconditionally, DRY_RUN included ───────────────────────

test("a fully-configured environment starts, in dry run and in live mode", () => {
  assert.equal(bootConfig({ ...baseEnv, DRY_RUN: "true" }).ok, true);
  assert.equal(bootConfig({ ...baseEnv, DRY_RUN: "false" }).ok, true);
});

test("KNOWN DEFECT BOT-004 fixed: a missing secret is fatal even in DRY_RUN", () => {
  // The old behaviour warned in dry run and failed only in live mode, and
  // DRY_RUN defaults to true — so `cp .env.example .env` produced a running
  // server whose key material was published in this repository.
  for (const missing of ["ENCRYPTION_KEY", "JWT_SECRET", "SCRYPT_SALT"] as const) {
    const r = bootConfig({ ...baseEnv, DRY_RUN: "true", [missing]: undefined });
    assert.equal(r.ok, false, `${missing} must be fatal in dry run`);
    assert.match(r.message, new RegExp(missing));
  }
});

test("published placeholder values are refused, not warned about", () => {
  const r = bootConfig({
    ...baseEnv,
    ENCRYPTION_KEY: "change-me-to-a-long-random-string-at-least-32-chars",
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /published in this repository/);

  const jwt = bootConfig({
    ...baseEnv,
    JWT_SECRET: "change-me-to-a-very-long-random-string-for-jwt-signing",
  });
  assert.equal(jwt.ok, false);
  assert.match(jwt.message, /published in this repository/);
});

test("KNOWN DEFECT X-08 fixed: a non-hex salt is refused instead of silently losing the salt", () => {
  // `Buffer.from("my-trading-bot-salt-2026", "hex")` returns a ZERO-LENGTH
  // buffer without throwing, so this used to pass the length-only check and
  // leave scrypt running unsalted.
  const r = bootConfig({ ...baseEnv, SCRYPT_SALT: "my-trading-bot-salt-2026" });
  assert.equal(r.ok, false);
  assert.match(r.message, /SCRYPT_SALT must be hexadecimal/);
});

test("a short encryption key or JWT secret is refused", () => {
  assert.equal(bootConfig({ ...baseEnv, ENCRYPTION_KEY: "short" }).ok, false);
  assert.equal(bootConfig({ ...baseEnv, JWT_SECRET: "short" }).ok, false);
});

test("a half-configured VAPID pair is refused, because it fails every send", () => {
  const r = bootConfig({ ...baseEnv, VAPID_PUBLIC_KEY: "public-only" });
  assert.equal(r.ok, false);
  assert.match(r.message, /VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY/);
});

test("an out-of-band SETUP_TOKEN is optional but validated when present", () => {
  assert.equal(bootConfig({ ...baseEnv, SETUP_TOKEN: "s".repeat(32) }).ok, true);
  assert.equal(bootConfig({ ...baseEnv, SETUP_TOKEN: "tiny" }).ok, false);
  assert.equal(bootConfig({ ...baseEnv, SETUP_TOKEN: "change-me" }).ok, false);
});

// ── Salt validation, without breaking existing installations ───────────────

test("the recommended salt form is exactly 32 hex characters", () => {
  assert.equal(SCRYPT_SALT_RE.test(VALID_SALT), true);
  assert.equal(SCRYPT_SALT_RE.test("00112233445566778899aabbccddee"), false);
});

test("a legacy shorter hex salt is still accepted, so stored API keys stay decryptable", () => {
  // The old derivation ran padEnd(32,"0").slice(0,32) before decoding, so a
  // 16-character hex salt produced a valid key. Rejecting it outright would be
  // data loss dressed up as a security fix.
  assert.equal(isUsableScryptSalt("0011223344556677"), true);
  assert.equal(isUsableScryptSalt(VALID_SALT), true);
});

test("anything containing a non-hex character is rejected — that is the actual defect", () => {
  for (const bad of [
    "my-trading-bot-salt-2026",
    "zzzzzzzzzzzzzzzz",
    "0011223344556677 ",
    "0011-2233-4455-6677",
    "",
    "0011",
    "0".repeat(65),
  ]) {
    assert.equal(isUsableScryptSalt(bad), false, JSON.stringify(bad));
  }
});

test("placeholder detection covers the values this repository ships", () => {
  for (const v of [
    "change-me-to-a-long-random-string-at-least-32-chars",
    "change-me-to-16-hex-chars",
    "change-me-to-a-very-long-random-string-for-jwt-signing",
    "REPLACE_ME",
    "PLACEHOLDER",
    "dev-insecure-key",
  ]) {
    assert.equal(isPublishedPlaceholder(v), true, v);
  }
  for (const v of ["", VALID_KEY, VALID_JWT, VALID_SALT, "hunter2"]) {
    assert.equal(isPublishedPlaceholder(v), false, v);
  }
});

// ── Webhook secret masking ─────────────────────────────────────────────────

test("a masked secret keeps only four characters at each end", () => {
  // Built rather than written out: a 40-character hex literal is exactly the
  // shape of a real webhook secret, and `scripts/ci/scan-secrets.sh` is right
  // to fail on one in tracked source.
  const secret = "abcdef01".repeat(5);
  const masked = maskSecret(secret);
  assert.equal(masked.length, secret.length);
  assert.equal(masked.slice(0, 4), "abcd");
  assert.equal(masked.slice(-4), "ef01");
  assert.equal(masked.slice(4, -4), "*".repeat(secret.length - 8));
  assert.ok(!masked.includes("0123456789"), masked);
});

test("a short value is masked completely rather than mostly revealed", () => {
  assert.equal(maskSecret("12345678"), "********");
  assert.equal(maskSecret("abc"), "***");
  assert.equal(maskSecret(""), "");
});

test("masking never lengthens or shortens the value, so the UI layout is stable", () => {
  for (const n of [0, 1, 7, 8, 9, 32, 40, 64, 256]) {
    assert.equal(maskSecret("x".repeat(n)).length, n, `length ${n}`);
  }
});
