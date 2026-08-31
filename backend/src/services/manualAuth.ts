import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
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

/** Distinct HMAC auth for the platform service; browser sessions are not accepted here. */
export async function requireManualAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!config.manualTradingEnabled) {
    res.status(404).json({ error: "manual trading is disabled" });
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
