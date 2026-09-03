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
 * Whether the Platform -> Bot control key is real enough to authenticate with.
 *
 * Deliberately independent of `manualTradingEnabled`: the Shariah
 * installation-floor control plane runs on this key, and it must never fall
 * back to computing an HMAC with `""` — that would make the enforcement floor
 * settable by anyone who guessed the key is unset.
 */
export function isUsableManualControlSecret(value: string): boolean {
  return value.length >= 32 && !isPublishedPlaceholder(value);
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

  // Distinct platform -> bot manual-order channel. Disabled unless explicitly armed.
  manualTradingEnabled: process.env.MANUAL_TRADING_ENABLED === "true",
  mainnetManualTradingEnabled: process.env.MAINNET_MANUAL_TRADING_ENABLED === "true",
  manualTradingHmacSecret: process.env.MANUAL_TRADING_HMAC_SECRET ?? "",

  // Durable Bot -> Platform realization outbox delivery. Accounting never
  // depends on this peer being available.
  realizationDeliveryEnabled: process.env.REALIZATION_DELIVERY_ENABLED === "true",
  realizationPlatformUrl: process.env.REALIZATION_PLATFORM_URL ?? "",
  realizationHmacSecret: process.env.REALIZATION_HMAC_SECRET ?? "",

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

  /*
   * MANUAL_TRADING_HMAC_SECRET is the Platform -> Bot CONTROL-PLANE key, not a
   * manual-trading key. It authenticates two independent things: manual order
   * submission, and the Shariah installation floor (`PUT
   * /api/manual-trading/shariah-enforcement`, plus the detached evidence on the
   * direct webhook path). The floor is armed whether or not manual trading is
   * enabled, so a MALFORMED key is a startup failure regardless of
   * MANUAL_TRADING_ENABLED — it used to be checked only when manual trading was
   * on, which left the control plane holding an unvalidated key.
   *
   * Presence stays required only for manual trading. An installation that
   * neither trades manually nor arms the floor does not need a key, and the
   * control route refuses the operation outright rather than authenticating
   * with a missing one — see `requireManualAuth`.
   */
  if (config.manualTradingHmacSecret.length > 0 && config.manualTradingHmacSecret.length < 32) {
    errors.push("MANUAL_TRADING_HMAC_SECRET must be at least 32 characters  ->  openssl rand -hex 32");
  } else if (config.manualTradingHmacSecret.length >= 32
             && isPublishedPlaceholder(config.manualTradingHmacSecret)) {
    errors.push("MANUAL_TRADING_HMAC_SECRET is a published placeholder value — generate a real one");
  } else if (config.manualTradingEnabled && config.manualTradingHmacSecret.length === 0) {
    errors.push("MANUAL_TRADING_HMAC_SECRET must be set when manual trading is enabled");
  }

  if (config.realizationDeliveryEnabled && config.realizationHmacSecret.length < 32) {
    errors.push("REALIZATION_HMAC_SECRET must be at least 32 characters when realization delivery is enabled");
  } else if (config.realizationDeliveryEnabled && isPublishedPlaceholder(config.realizationHmacSecret)) {
    errors.push("REALIZATION_HMAC_SECRET is a published placeholder value — generate a real one");
  }
  if (config.realizationDeliveryEnabled) {
    try {
      const url = new URL(config.realizationPlatformUrl);
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
          || url.username || url.password || url.search || url.hash
          || url.pathname !== "/api/internal/realization-events/v1") throw new Error();
    } catch {
      errors.push("REALIZATION_PLATFORM_URL must be the HTTPS ingestion endpoint (plain HTTP is allowed only on loopback)");
    }
  }

  const vapidCount = [config.vapidPublicKey, config.vapidPrivateKey].filter(Boolean).length;
  if (vapidCount === 1) {
    errors.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together");
  }

  /*
   * BOT-P1-1: a boolean flag whose value the parse expression does not
   * recognise is silently the default, and for two of these the default is
   * REAL MONEY ON MAINNET.
   *
   * `DRY_RUN` is read as `=== "true"`, so `DRY_RUN=1`, `DRY_RUN=yes`,
   * `DRY_RUN=on` or a trailing space all yield `dryRun === false`: the process
   * starts LIVE and every accepted webhook places a real Binance Spot order,
   * while the operator's `.env` reads as though it were simulating.
   * `BINANCE_TESTNET` fails the same way into `api.binance.com`. The point of
   * this clause is to make a typo LOUD, not to accept more spellings, so only
   * the forms the parse expression itself understands are allowed and the
   * parse expressions are left exactly as they are.
   *
   * Unset stays legal: each flag then keeps its documented default.
   *
   * `DRY_RUN` and `BINANCE_TESTNET` lowercase before comparing, so `TRUE` and
   * `False` are genuinely understood there. `SECURE_COOKIES` is compared with
   * a case-SENSITIVE `!== "false"`, so `SECURE_COOKIES=FALSE` would leave
   * secure cookies on while reading as though they were off — it is therefore
   * held to the exact lowercase forms it actually honours.
   */
  const booleanFlags: Array<[string, RegExp]> = [
    ["DRY_RUN", /^(true|false)$/i],
    ["BINANCE_TESTNET", /^(true|false)$/i],
    ["SECURE_COOKIES", /^(true|false)$/],
  ];
  for (const [name, accepted] of booleanFlags) {
    const raw = process.env[name];
    if (raw !== undefined && !accepted.test(raw)) {
      errors.push(
        `${name} must be exactly true or false when set, not ` +
        `${JSON.stringify(raw)} — it is compared as a string, so any other ` +
        "value is silently ignored and the default is used instead"
      );
    }
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
