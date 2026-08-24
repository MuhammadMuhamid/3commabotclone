import crypto from "crypto";
import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { encrypt, decrypt } from "../lib/crypto.js";
import { signAccess, signSetup, verifySetup } from "../lib/jwt.js";
import { config } from "../config.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const authRouter = Router();

// ─── Cookie helpers ───────────────────────────────────────────────────────────

const BASE_COOKIE = {
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: "strict" as const,
} as const;

function setAccessCookie(res: Response, userId: string): void {
  const token = signAccess(userId);
  res.cookie("access_token", token, { ...BASE_COOKIE, maxAge: 15 * 60 * 1000 }); // 15 min
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie("refresh_token", token, {
    ...BASE_COOKIE,
    maxAge: 30 * 24 * 60 * 60 * 1000,                    // 30 days
    path: "/api/auth/refresh", // browser only sends this cookie to the refresh endpoint
  });
}

function clearAuthCookies(res: Response): void {
  res.clearCookie("access_token", { ...BASE_COOKIE });
  res.clearCookie("refresh_token", { ...BASE_COOKIE, path: "/api/auth/refresh" });
}

// ─── Refresh token helpers ────────────────────────────────────────────────────

function hashToken(raw: string): string {
  // High-entropy random token → SHA-256 is sufficient for storage
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Rotation grace window.
 *
 * The dashboard fires several API calls in parallel (Promise.all in Dashboard.tsx).
 * When the 15-min access token expires they all 401 at the same instant and each
 * one POSTs /api/auth/refresh with the SAME refresh cookie — the browser has not
 * received the rotated cookie yet. Without a grace window the first request
 * deletes the row and every other request sees "token not found", clears the
 * cookies and logs the user out a few minutes into the session.
 *
 * We therefore remember each just-rotated token for a short window and answer
 * those in-flight duplicates with the replacement token instead of killing the
 * session. Single backend process, so an in-memory map is sufficient and needs
 * no DB migration.
 */
const ROTATION_GRACE_MS = 60_000;
const rotatedTokens = new Map<string, { userId: string; replacement: string; at: number }>();

function rememberRotation(oldHash: string, userId: string, replacement: string): void {
  rotatedTokens.set(oldHash, { userId, replacement, at: Date.now() });
}

function consumeRotation(oldHash: string) {
  const entry = rotatedTokens.get(oldHash);
  if (!entry) return null;
  if (Date.now() - entry.at > ROTATION_GRACE_MS) {
    rotatedTokens.delete(oldHash);
    return null;
  }
  return entry;
}

// Keep the grace map from growing unbounded.
setInterval(() => {
  const cutoff = Date.now() - ROTATION_GRACE_MS;
  for (const [hash, entry] of rotatedTokens) {
    if (entry.at < cutoff) rotatedTokens.delete(hash);
  }
}, ROTATION_GRACE_MS).unref?.();

async function issueRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("hex"); // 64-char hex
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Prune expired tokens for this user before creating a new one
  await prisma.refreshToken.deleteMany({
    where: { userId, expiresAt: { lt: new Date() } },
  });

  await prisma.refreshToken.create({ data: { userId, tokenHash, expiresAt } });
  return raw;
}

// ─── GET /api/auth/status ─────────────────────────────────────────────────────
// Tells the frontend whether initial registration is needed.

authRouter.get("/status", async (_req, res) => {
  const count = await prisma.user.count();
  res.json({ setup: count > 0 });
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────
// Creates the one-and-only admin account. Locked once a user exists.

const registerSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, "Username may only contain letters, numbers, and underscores"),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(128),
});

authRouter.post("/register", async (req, res) => {
  const count = await prisma.user.count();
  if (count > 0) {
    res.status(409).json({ error: "Registration is closed — an admin account already exists." });
    return;
  }

  let body: z.infer<typeof registerSchema>;
  try {
    body = registerSchema.parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: e.errors[0]?.message ?? "Invalid input" });
      return;
    }
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const passwordHash = await bcrypt.hash(body.password, 12);
  await prisma.user.create({ data: { username: body.username, passwordHash } });
  res.status(201).json({ message: "Account created. Please log in and complete MFA setup." });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
// Step 1 of 2: verify credentials, return a short-lived setupToken.

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

authRouter.post("/login", async (req, res) => {
  let body: z.infer<typeof loginSchema>;
  try {
    body = loginSchema.parse(req.body);
  } catch {
    res.status(400).json({ error: "Username and password are required" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username: body.username } });

  // Use a dummy hash to ensure constant-time comparison even when user doesn't exist
  const dummyHash = "$2b$12$invalidhashfortimingprotectionXXXXXXXXXXXXXXXXXXXXXXXX";
  const hash = user?.passwordHash ?? dummyHash;
  const valid = await bcrypt.compare(body.password, hash);

  if (!user || !valid) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const setupToken = signSetup(user.id);

  if (!user.totpEnabled) {
    // First login — user must complete TOTP setup before gaining access
    res.json({ step: "totp_setup", setupToken });
  } else {
    // TOTP already configured — prompt for code
    res.json({ step: "totp_verify", setupToken });
  }
});

// ─── POST /api/auth/totp/qr ───────────────────────────────────────────────────
// Generates a TOTP secret + QR code. Requires a valid setupToken.
// Stores the encrypted secret in the DB (not yet activated until /enable).

authRouter.post("/totp/qr", async (req, res) => {
  const { setupToken } = req.body as { setupToken?: string };
  if (!setupToken) {
    res.status(400).json({ error: "setupToken required" });
    return;
  }

  let userId: string;
  try {
    ({ userId } = verifySetup(setupToken));
  } catch {
    res.status(401).json({ error: "Setup session expired — please log in again." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.totpEnabled) { res.status(409).json({ error: "MFA is already active" }); return; }

  // Generate a fresh TOTP secret and store it encrypted (not yet enabled)
  const secret = authenticator.generateSecret(20);
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: encrypt(secret) },
  });

  const otpauth = authenticator.keyuri(user.username, "Signal Bot", secret);
  const qrCode = await QRCode.toDataURL(otpauth);

  // Return both QR and manual key (for users who can't scan)
  res.json({ qrCode, manualKey: secret });
});

// ─── POST /api/auth/totp/enable ───────────────────────────────────────────────
// Step 2 of first-time setup: verify the first TOTP code, activate MFA,
// and issue session cookies.

const totpCodeSchema = z.object({
  setupToken: z.string().min(1),
  code: z.string().length(6).regex(/^\d{6}$/, "Code must be 6 digits"),
});

authRouter.post("/totp/enable", async (req, res) => {
  let body: z.infer<typeof totpCodeSchema>;
  try {
    body = totpCodeSchema.parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) { res.status(400).json({ error: e.errors[0]?.message ?? "Invalid" }); return; }
    res.status(400).json({ error: "Invalid request" }); return;
  }

  let userId: string;
  try {
    ({ userId } = verifySetup(body.setupToken));
  } catch {
    res.status(401).json({ error: "Setup session expired — please log in again." }); return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpSecret) {
    res.status(400).json({ error: "Generate a QR code first (GET /api/auth/totp/qr)" }); return;
  }
  if (user.totpEnabled) {
    res.status(409).json({ error: "MFA is already active" }); return;
  }

  const secret = decrypt(user.totpSecret);
  // window:1 accepts the previous and next 30-second step (±30s tolerance)
  const valid = authenticator.verify({ token: body.code, secret, options: { window: 1 } } as Parameters<typeof authenticator.verify>[0]);
  if (!valid) {
    res.status(401).json({ error: "Invalid authenticator code — check your device clock" }); return;
  }

  await prisma.user.update({ where: { id: userId }, data: { totpEnabled: true } });

  const refreshToken = await issueRefreshToken(userId);
  setAccessCookie(res, userId);
  setRefreshCookie(res, refreshToken);
  res.json({ username: user.username });
});

// ─── POST /api/auth/totp/verify ───────────────────────────────────────────────
// Step 2 of subsequent logins: verify TOTP code and issue session cookies.

authRouter.post("/totp/verify", async (req, res) => {
  let body: z.infer<typeof totpCodeSchema>;
  try {
    body = totpCodeSchema.parse(req.body);
  } catch (e) {
    if (e instanceof z.ZodError) { res.status(400).json({ error: e.errors[0]?.message ?? "Invalid" }); return; }
    res.status(400).json({ error: "Invalid request" }); return;
  }

  let userId: string;
  try {
    ({ userId } = verifySetup(body.setupToken));
  } catch {
    res.status(401).json({ error: "Session expired — please log in again." }); return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.totpSecret || !user.totpEnabled) {
    res.status(400).json({ error: "MFA not configured for this account" }); return;
  }

  const secret = decrypt(user.totpSecret);
  // window:1 accepts the previous and next 30-second step (±30s tolerance)
  const valid = authenticator.verify({ token: body.code, secret, options: { window: 1 } } as Parameters<typeof authenticator.verify>[0]);
  if (!valid) {
    res.status(401).json({ error: "Invalid authenticator code — check your device clock" }); return;
  }

  const refreshToken = await issueRefreshToken(userId);
  setAccessCookie(res, userId);
  setRefreshCookie(res, refreshToken);
  res.json({ username: user.username });
});

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
// Rotates the refresh token and issues a new 15-min access JWT.

authRouter.post("/refresh", async (req, res) => {
  const rawToken = (req.cookies as Record<string, string> | undefined)?.refresh_token;
  if (!rawToken) { res.status(401).json({ error: "No refresh token" }); return; }

  const tokenHash = hashToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored) {
    // Possibly a concurrent refresh that lost the race — replay the rotation
    // instead of destroying a session that is actually still valid.
    const replayed = consumeRotation(tokenHash);
    if (replayed) {
      setAccessCookie(res, replayed.userId);
      setRefreshCookie(res, replayed.replacement);
      res.json({ ok: true });
      return;
    }
    clearAuthCookies(res);
    res.status(401).json({ error: "Refresh token expired or revoked — please log in again." });
    return;
  }

  if (stored.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { tokenHash } }).catch(() => {});
    clearAuthCookies(res);
    res.status(401).json({ error: "Refresh token expired or revoked — please log in again." });
    return;
  }

  // Rotate: delete old token, issue new one.
  // deleteMany (not delete) because two concurrent refreshes can both pass the
  // findUnique above before either deletes. delete() throws P2025 on the loser,
  // and that rejection was unhandled — it crashed the whole API process on every
  // token expiry. deleteMany reports count 0 instead of throwing.
  const { count } = await prisma.refreshToken.deleteMany({ where: { tokenHash } });
  if (count === 0) {
    const replayed = consumeRotation(tokenHash);
    if (replayed) {
      setAccessCookie(res, replayed.userId);
      setRefreshCookie(res, replayed.replacement);
      res.json({ ok: true });
      return;
    }
    clearAuthCookies(res);
    res.status(401).json({ error: "Refresh token expired or revoked — please log in again." });
    return;
  }

  const newRefresh = await issueRefreshToken(stored.userId);
  rememberRotation(tokenHash, stored.userId, newRefresh);
  setAccessCookie(res, stored.userId);
  setRefreshCookie(res, newRefresh);
  res.json({ ok: true });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

authRouter.post("/logout", async (req, res) => {
  const rawToken = (req.cookies as Record<string, string> | undefined)?.refresh_token;
  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    await prisma.refreshToken.deleteMany({ where: { tokenHash } }).catch(() => {});
    rotatedTokens.delete(tokenHash); // a deliberate logout must not be replayable
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
// Returns the current user's profile. Requires a valid access token.

authRouter.get("/me", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true, totpEnabled: true },
  });
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(user);
});
