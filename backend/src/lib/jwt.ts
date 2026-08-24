import jwt from "jsonwebtoken";
import { config } from "../config.js";

// ─── Payload types ────────────────────────────────────────────────────────────

export type AccessPayload = { userId: string; type: "access" };

/**
 * Short-lived token (10 min) issued after password verification.
 * Does NOT grant API access — only used to complete TOTP step.
 */
export type SetupPayload = { userId: string; type: "setup" };

// ─── Signing ──────────────────────────────────────────────────────────────────

export function signAccess(userId: string): string {
  if (!config.jwtSecret) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(
    { userId, type: "access" } satisfies AccessPayload,
    config.jwtSecret,
    { expiresIn: "15m", algorithm: "HS256" }
  );
}

export function signSetup(userId: string): string {
  if (!config.jwtSecret) throw new Error("JWT_SECRET is not configured");
  return jwt.sign(
    { userId, type: "setup" } satisfies SetupPayload,
    config.jwtSecret,
    { expiresIn: "10m", algorithm: "HS256" }
  );
}

// ─── Verification ─────────────────────────────────────────────────────────────

export function verifyAccess(token: string): AccessPayload {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
  }) as AccessPayload;
  if (payload.type !== "access") throw new Error("Wrong token type");
  return payload;
}

export function verifySetup(token: string): SetupPayload {
  const payload = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
  }) as SetupPayload;
  if (payload.type !== "setup") throw new Error("Wrong token type");
  return payload;
}
