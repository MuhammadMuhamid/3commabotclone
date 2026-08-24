import "dotenv/config";

/**
 * Values published in this repository's own examples, documentation and deploy
 * scripts. A server that boots on one of these has no secret at all: the
 * encryption key protecting stored Binance API keys, and the JWT signing secret
 * that makes sessions forgeable without a password or a TOTP code, would both
 * be constants anyone can read.
 *
 * `deploy/remote-deploy.sh` string-matches the same shapes and regenerates
 * them, but only on that one deployment path.
 */
const PUBLISHED_PLACEHOLDERS = [
  "change-me",
  "changeme",
  "change_me",
  "replace-me",
  "replace_me",
  "replaceme",
  "placeholder",
  "dev-insecure-key",
  "dev-insecure-salt",
  "your-secret-here",
  "secret",
  "test-only",
  "example",
];

export function isPublishedPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return PUBLISHED_PLACEHOLDERS.some((p) => v === p || v.startsWith(p));
}

/**
 * The REQUIRED salt form: exactly 32 hex characters, i.e. `openssl rand -hex 16`.
 */
export const SCRYPT_SALT_RE = /^[0-9a-fA-F]{32}$/;

/**
 * The ACCEPTED form, which is deliberately wider.
 *
 * The old derivation ran `saltHex.padEnd(32, "0").slice(0, 32)` before
 * decoding, so a shorter all-hex salt produced a valid key. Rejecting those
 * outright would make every API key such a deployment has stored
 * undecryptable — a data-loss bug dressed up as a security fix. Anything
 * all-hex and at least 16 characters is therefore still accepted, with the same
 * normalisation as before, and the operator is told to move to the 32-character
 * form.
 *
 * What is NOT accepted is a salt containing a non-hex character. That is the
 * actual defect: `Buffer.from(str, "hex")` stops at the first invalid character
 * without throwing, so `my-trading-bot-salt-2026` passed the old length check
 * and decoded to a ZERO-LENGTH buffer, leaving scrypt unsalted and the derived
 * key a pure function of ENCRYPTION_KEY.
 */
export const SCRYPT_SALT_ACCEPTED_RE = /^[0-9a-fA-F]{16,64}$/;

/** True when the salt can be decoded to real bytes without silent truncation. */
export function isUsableScryptSalt(value: string): boolean {
  return SCRYPT_SALT_ACCEPTED_RE.test(value);
}

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",
  isProduction: (process.env.NODE_ENV ?? "").toLowerCase() === "production",

  // AES-256-GCM key material. No fallback — see lib/crypto.ts.
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  // scrypt KDF salt, exactly 32 hex chars. Run: openssl rand -hex 16
  scryptSalt: process.env.SCRYPT_SALT ?? "",

  // JWT signing secret. Run: openssl rand -hex 64
  jwtSecret: process.env.JWT_SECRET ?? "",

  /**
   * Out-of-band token required to create the FIRST account, and only the first.
   * Registration was otherwise open to the internet until an account existed,
   * on a host published by certificate transparency the moment certbot runs.
   */
  setupToken: process.env.SETUP_TOKEN ?? "",

  // Secure cookies (set false in local dev if not using HTTPS)
  secureCookies: process.env.SECURE_COOKIES !== "false",

  // CORS origin — must match the frontend URL.
  // Defaults to the Vite dev server; always set it explicitly in production.
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  // Optional env-var Binance credentials (legacy; prefer exchange accounts in Settings)
  binanceApiKey: process.env.BINANCE_API_KEY ?? "",
  binanceApiSecret: process.env.BINANCE_API_SECRET ?? "",
  binanceTestnet: (process.env.BINANCE_TESTNET ?? "false").toLowerCase() === "true",

  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:alerts@localhost",
};

/** Every problem found, so an operator fixes the whole file in one pass. */
export function collectConfigErrors(): string[] {
  const errors: string[] = [];

  if (config.encryptionKey.length < 32) {
    errors.push("ENCRYPTION_KEY must be at least 32 characters  ->  openssl rand -hex 32");
  } else if (isPublishedPlaceholder(config.encryptionKey)) {
    errors.push("ENCRYPTION_KEY is a value published in this repository — generate a real one");
  }

  // Node's Buffer.from(str, "hex") stops at the first non-hex character and
  // returns the bytes decoded so far WITHOUT throwing. A passphrase-style salt
  // therefore passed the old length-only check and decoded to a zero-length
  // buffer, leaving scrypt unsalted and the derived key a pure function of
  // ENCRYPTION_KEY.
  if (!isUsableScryptSalt(config.scryptSalt)) {
    errors.push(
      "SCRYPT_SALT must be hexadecimal, 16-64 characters (32 recommended)  ->  " +
      "openssl rand -hex 16. A non-hex character makes Node decode a shorter " +
      "salt than you configured, silently."
    );
  }

  if (config.jwtSecret.length < 32) {
    errors.push("JWT_SECRET must be at least 32 characters  ->  openssl rand -hex 64");
  } else if (isPublishedPlaceholder(config.jwtSecret)) {
    errors.push("JWT_SECRET is a value published in this repository — generate a real one");
  }

  if (config.setupToken && config.setupToken.length < 16) {
    errors.push("SETUP_TOKEN must be at least 16 characters when set  ->  openssl rand -hex 32");
  }
  if (config.setupToken && isPublishedPlaceholder(config.setupToken)) {
    errors.push("SETUP_TOKEN is a value published in this repository — generate a real one");
  }

  const vapidCount = [config.vapidPublicKey, config.vapidPrivateKey].filter(Boolean).length;
  if (vapidCount === 1) {
    errors.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together");
  }

  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    errors.push(`PORT is not a valid port number: ${JSON.stringify(process.env.PORT)}`);
  }

  return errors;
}

/**
 * Called at startup. Fails the process on any missing or placeholder secret,
 * **regardless of DRY_RUN**.
 *
 * The previous behaviour gated the hard failure on `!config.dryRun`, and
 * DRY_RUN defaults to true — so the documented first-run path
 * (`cp .env.example .env`) started a server that encrypted real Binance API
 * keys under a key derived from string literals in this repository, and signed
 * sessions with a published secret. A `bot.db` written in that state is
 * decryptable by anyone holding the source.
 *
 * Dry run means "do not talk to the exchange". It has never meant "the secrets
 * do not matter".
 */
export function assertConfig(): void {
  // A legacy short-but-valid salt still works, and saying so is better than
  // leaving the operator to wonder why the recommendation differs.
  if (isUsableScryptSalt(config.scryptSalt) && !SCRYPT_SALT_RE.test(config.scryptSalt)) {
    console.warn(
      "SCRYPT_SALT is hexadecimal but not the recommended 32 characters. It " +
      "still derives the same key it always has, so stored API keys keep " +
      "working; migrate to `openssl rand -hex 16` when you next rotate them."
    );
  }
  const errors = collectConfigErrors();
  if (errors.length === 0) return;
  console.error("FATAL: configuration is not safe to start with:");
  for (const e of errors) console.error(`  - ${e}`);
  console.error("");
  console.error("See backend/.env.example. These checks are not skipped in DRY_RUN:");
  console.error("this process stores real exchange credentials and signs real sessions.");
  process.exit(1);
}

// Keep the old name as an alias so existing callers do not break.
export const assertEncryptionKey = assertConfig;
