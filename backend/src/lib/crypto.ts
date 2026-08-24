import crypto from "crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";

/**
 * Derives a 32-byte AES key from ENCRYPTION_KEY + SCRYPT_SALT using scrypt.
 * The key is computed once and cached — scrypt is intentionally slow (N=16384).
 *
 * IMPORTANT: if either ENCRYPTION_KEY or SCRYPT_SALT changes, all previously
 * encrypted data (Binance API keys) must be re-entered in Settings.
 */
let _cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  const pw = config.encryptionKey || "dev-insecure-key";
  const saltHex = config.scryptSalt || "dev-insecure-salt-00000000000000";

  if (!config.encryptionKey || !config.scryptSalt) {
    // Only safe in local dev (assertConfig() already printed a warning)
    return crypto.createHash("sha256").update(pw + saltHex).digest();
  }

  // Pad or truncate salt hex to exactly 32 hex chars (16 bytes)
  const saltStr = saltHex.padEnd(32, "0").slice(0, 32);
  const salt = Buffer.from(saltStr, "hex");
  return crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
}

function key(): Buffer {
  if (!_cachedKey) _cachedKey = deriveKey();
  return _cachedKey;
}

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(blob: string): string {
  try {
    const buf = Buffer.from(blob, "base64");
    const iv  = buf.subarray(0, 12);
    const tag  = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error(
      "Cannot decrypt stored data. " +
      "ENCRYPTION_KEY or SCRYPT_SALT may have changed since last deploy. " +
      "Re-add your Binance API keys in Settings."
    );
  }
}
