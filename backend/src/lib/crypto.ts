import crypto from "crypto";
import { config, isUsableScryptSalt } from "../config.js";

const ALGO = "aes-256-gcm";

/**
 * Derives a 32-byte AES key from ENCRYPTION_KEY + SCRYPT_SALT using scrypt.
 * The key is computed once and cached — scrypt is intentionally slow (N=16384).
 *
 * IMPORTANT: if either ENCRYPTION_KEY or SCRYPT_SALT changes, all previously
 * encrypted data (Binance API keys) must be re-entered in Settings.
 */
let _cachedKey: Buffer | null = null;

/**
 * There is deliberately no fallback.
 *
 * A `dev-insecure-key` / `dev-insecure-salt-…` pair used to be substituted
 * whenever either variable was unset, and because the hard configuration check
 * was gated on `!DRY_RUN` — which defaults to true — the documented first-run
 * path reached it. Any Binance API key added through Settings in that state was
 * encrypted under a key derived from two string literals in this repository, so
 * a copy of `bot.db` was decryptable by anyone holding the source.
 *
 * `assertConfig()` refuses to start without real key material, and this throws
 * if it is ever reached anyway — a decryption failure is recoverable, silently
 * encrypting a live credential under a published key is not.
 */
function deriveKey(): Buffer {
  if (!config.encryptionKey || !config.scryptSalt) {
    throw new Error(
      "ENCRYPTION_KEY and SCRYPT_SALT are required before any secret can be " +
      "stored or read. See backend/.env.example."
    );
  }
  if (!isUsableScryptSalt(config.scryptSalt)) {
    throw new Error(
      "SCRYPT_SALT must be hexadecimal (16-64 characters). Node's " +
      "Buffer.from(str, \"hex\") truncates silently at the first invalid " +
      "character, which would leave scrypt unsalted."
    );
  }

  // The derivation itself is UNCHANGED, padEnd/slice included: altering it
  // would make every stored API key undecryptable. The validation above
  // rejects input that would silently lose the salt, rather than normalising
  // it into a different key.
  const saltHex = config.scryptSalt.padEnd(32, "0").slice(0, 32);
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(config.encryptionKey, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** True when key material is present and valid, so a caller can refuse early. */
export function canStoreSecrets(): boolean {
  return config.encryptionKey.length >= 32 && isUsableScryptSalt(config.scryptSalt);
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
