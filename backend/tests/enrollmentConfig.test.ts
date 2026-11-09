/**
 * OD-4 configuration: enrollment is off unless ENROLLMENT_ENABLED=true, and
 * when it is on the process refuses to start without an HTTPS Bot origin and
 * an exact HTTPS return URL (no query, no fragment) — the return URL is never
 * taken from a request, so it must be right in the environment.
 *
 * `config.ts` reads the environment at import, so each case boots
 * `assertConfig()` in a child process (as `security.test.ts` does).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const base = {
  ENCRYPTION_KEY: "k".repeat(40), SCRYPT_SALT: "00112233445566778899aabbccddeeff", JWT_SECRET: "j".repeat(64),
};

function boot(env: Record<string, string>): { ok: boolean; message: string } {
  try {
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      'const { assertConfig, config } = await import("./src/config.ts"); assertConfig(); ' +
      'process.stdout.write(String(config.enrollmentEnabled));'],
    { cwd: ROOT, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test",
      DATABASE_URL: "file:./tests/.tmp-config.db", ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, message: "" };
  } catch (err) {
    const e = err as { stderr?: Buffer };
    return { ok: false, message: e.stderr?.toString() ?? "" };
  }
}

test("enrollment is off by default and needs nothing extra then", () => {
  assert.equal(boot({}).ok, true);
});

test("ENROLLMENT_ENABLED=true needs an HTTPS PUBLIC_URL and an exact HTTPS PLATFORM_RETURN_URL", () => {
  const good = { ENROLLMENT_ENABLED: "true", PUBLIC_URL: "https://bot.example.test",
    PLATFORM_RETURN_URL: "https://platform.example.test/bot/accounts" };
  assert.equal(boot(good).ok, true);
  const missing = boot({ ...good, PLATFORM_RETURN_URL: "" });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /PLATFORM_RETURN_URL/);
  for (const bad of ["http://platform.example.test/x", "https://platform.example.test/x?next=evil",
    "https://platform.example.test/x#frag", "https://user:pw@platform.example.test/x", "not a url"]) {
    assert.equal(boot({ ...good, PLATFORM_RETURN_URL: bad }).ok, false, bad);
  }
  const plainBot = boot({ ...good, PUBLIC_URL: "http://bot.example.test" });
  assert.equal(plainBot.ok, false);
  assert.match(plainBot.message, /PUBLIC_URL/);
  assert.equal(boot({ ...good, PUBLIC_URL: "http://localhost:4000",
    PLATFORM_RETURN_URL: "http://localhost:3000/bot" }).ok, true, "loopback HTTP is allowed for local runs");
});

test("a typo in ENROLLMENT_ENABLED is loud, not silently off", () => {
  const typo = boot({ ENROLLMENT_ENABLED: "yes" });
  assert.equal(typo.ok, false);
  assert.match(typo.message, /ENROLLMENT_ENABLED must be exactly true or false/);
});
