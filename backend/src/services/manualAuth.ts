import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, isUsableManualControlSecret } from "../config.js";
import { prisma } from "../lib/prisma.js";

export const MANUAL_AUTH_FRESHNESS_MS = 60_000;
const HEADER_TS = "x-manual-timestamp";
const HEADER_NONCE = "x-manual-nonce";
const HEADER_REQUEST = "x-manual-request-id";
const HEADER_SIGNATURE = "x-manual-signature";

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
  ).join(",")}}`;
}

export function canonicalPath(raw: string): string {
  const url = new URL(raw, "http://manual.local");
  const sorted = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) =>
    ak.localeCompare(bk) || av.localeCompare(bv));
  const query = new URLSearchParams(sorted).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function manualCanonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  requestId: string;
  body?: unknown;
}): string {
  const bodyHash = createHash("sha256").update(canonicalJson(input.body)).digest("hex");
  return [
    input.method.toUpperCase(), canonicalPath(input.path), input.timestamp,
    input.nonce, input.requestId, bodyHash,
  ].join("\n");
}

export function signManualRequest(secret: string, input: Parameters<typeof manualCanonicalRequest>[0]): string {
  return `v1=${createHmac("sha256", secret).update(manualCanonicalRequest(input)).digest("hex")}`;
}

export type ManualAuthCheck =
  | { ok: true; requestId: string; nonce: string; expiresAt: Date }
  | { ok: false; status: 401 | 409; error: string };

export function verifyManualRequest(input: {
  secret: string;
  method: string;
  path: string;
  timestamp?: string;
  nonce?: string;
  requestId?: string;
  signature?: string;
  body?: unknown;
  now?: number;
}): ManualAuthCheck {
  const { timestamp, nonce, requestId, signature } = input;
  if (!timestamp || !nonce || !requestId || !signature) {
    return { ok: false, status: 401, error: "manual command authentication required" };
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
    return { ok: false, status: 401, error: "invalid manual command identity" };
  }
  const ts = Number(timestamp);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MANUAL_AUTH_FRESHNESS_MS) {
    return { ok: false, status: 401, error: "manual command timestamp is outside the freshness window" };
  }
  const expected = signManualRequest(input.secret, {
    method: input.method, path: input.path, timestamp, nonce, requestId, body: input.body,
  });
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, status: 401, error: "invalid manual command signature" };
  }
  return { ok: true, requestId, nonce, expiresAt: new Date(now + MANUAL_AUTH_FRESHNESS_MS) };
}

export interface ManualNonceStore {
  prune(before: Date): Promise<void>;
  create(nonce: string, expiresAt: Date): Promise<void>;
}

export async function reserveManualNonce(
  nonce: string, expiresAt: Date, store: ManualNonceStore
): Promise<boolean> {
  await store.prune(new Date());
  try { await store.create(nonce, expiresAt); return true; }
  catch (error) {
    if ((error as { code?: unknown }).code === "P2002") return false;
    throw error;
  }
}

/**
 * Paths on this router that are CONTROL PLANE, not manual trading.
 *
 * The Shariah installation floor is set by the Platform over this same
 * authenticated channel, and arming it is not a manual order. Before BOT-P1-4
 * the whole router was gated on MANUAL_TRADING_ENABLED, so an operator who had
 * deliberately disabled manual trading — the safe, recommended posture — could
 * not arm the floor at all: the Platform's push 404'd, the floor stayed `off`,
 * and every DIRECT webhook BUY kept being admitted with no Shariah evidence.
 * Manual trading being off must not disarm Shariah enforcement.
 *
 * These paths are exempt from the manual-ORDER feature flag, and from that
 * flag only. They are authenticated by exactly the same HMAC, over exactly the
 * same canonical request, with the same freshness window and the same
 * single-use nonce as a real order.
 */
const CONTROL_PLANE_PATHS = new Set(["/shariah-enforcement"]);

export function isManualControlPlanePath(path: string): boolean {
  return CONTROL_PLANE_PATHS.has(path.replace(/\/+$/, "") || "/");
}

/**
 * The manual-ORDER feature flag.
 *
 * Applies to order submission, cancellation, protection edits and the readings
 * that serve them — never to the control plane above. Registered BEFORE
 * `requireManualAuth` so a disabled installation answers exactly as it always
 * did (404, before any signature is examined) for everything that is genuinely
 * manual trading.
 */
export function requireManualTradingFeature(req: Request, res: Response, next: NextFunction): void {
  if (!config.manualTradingEnabled && !isManualControlPlanePath(req.path)) {
    res.status(404).json({ error: "manual trading is disabled" });
    return;
  }
  next();
}

/** Distinct HMAC auth for the platform service; browser sessions are not accepted here. */
export async function requireManualAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  /*
   * Never authenticate against a key that is absent or is one of this
   * repository's published placeholders. `createHmac("sha256", "")` is a
   * perfectly valid MAC that anyone who guessed the key is unset can compute,
   * so falling through to it would make the enforcement floor settable by the
   * internet. Refusing outright is also what makes the Platform report a
   * failure instead of believing the floor was armed.
   */
  if (!isUsableManualControlSecret(config.manualTradingHmacSecret)) {
    res.status(503).json({ error: "manual control secret is not configured" });
    return;
  }
  const result = verifyManualRequest({
    secret: config.manualTradingHmacSecret,
    method: req.method,
    path: req.originalUrl,
    timestamp: req.header(HEADER_TS),
    nonce: req.header(HEADER_NONCE),
    requestId: req.header(HEADER_REQUEST),
    signature: req.header(HEADER_SIGNATURE),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const reserved = await reserveManualNonce(result.nonce, result.expiresAt, {
    prune: async (before) => { await prisma.manualNonce.deleteMany({ where: { expiresAt: { lt: before } } }); },
    create: async (nonce, expiresAt) => { await prisma.manualNonce.create({ data: { nonce, expiresAt } }); },
  });
  if (!reserved) { res.status(409).json({ error: "manual command nonce was already used" }); return; }
  res.locals.manualRequestId = result.requestId;
  next();
}
