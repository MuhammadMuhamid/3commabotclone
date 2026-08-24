import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT ?? "4000", 10),
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",

  // AES-256-GCM key material
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",
  // scrypt KDF salt (16-byte hex). Run: openssl rand -hex 16
  scryptSalt: process.env.SCRYPT_SALT ?? "",

  // JWT signing secret. Run: openssl rand -hex 64
  jwtSecret: process.env.JWT_SECRET ?? "",

  // Secure cookies (set false in local dev if not using HTTPS)
  secureCookies: process.env.SECURE_COOKIES !== "false",

  // CORS origin — must match the frontend URL.
  // Defaults to Vite dev server; always set explicitly in production.
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  // Optional env-var Binance credentials (legacy; prefer exchange accounts in Settings)
  binanceApiKey: process.env.BINANCE_API_KEY ?? "",
  binanceApiSecret: process.env.BINANCE_API_SECRET ?? "",
  binanceTestnet: (process.env.BINANCE_TESTNET ?? "false").toLowerCase() === "true",

  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:admin@alphawebstudioz.com",
};

/** Called at startup — hard-fails in production if critical secrets are missing. */
export function assertConfig(): void {
  const errors: string[] = [];

  if (config.encryptionKey.length < 32)
    errors.push("ENCRYPTION_KEY must be ≥32 characters");

  if (config.scryptSalt.length < 16)
    errors.push("SCRYPT_SALT must be ≥16 hex chars  →  run: openssl rand -hex 16");

  if (config.jwtSecret.length < 32)
    errors.push("JWT_SECRET must be ≥32 characters  →  run: openssl rand -hex 64");

  const vapidCount = [config.vapidPublicKey, config.vapidPrivateKey].filter(Boolean).length;
  if (vapidCount === 1) errors.push("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be configured together");

  if (!config.dryRun && errors.length > 0) {
    for (const e of errors) console.error(`FATAL: ${e}`);
    process.exit(1);
  }
  for (const e of errors) console.warn(`WARNING (dev-only): ${e}`);
}

// Keep old name as an alias so existing callers don't break during migration
export const assertEncryptionKey = assertConfig;
