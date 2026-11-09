/**
 * OD-4 public routes: `/api/enroll/session | state | keys | reveal`.
 *
 * These are the only Bot routes a browser reaches without the dashboard's
 * login. They authorize by the enrollment ticket / session alone — the
 * dashboard's JWT is never read here, and the `enroll_session` cookie is
 * never read anywhere else. Every restriction from the design (trace §4.2):
 *
 *   - gated by ENROLLMENT_ENABLED (default false): 404 while off;
 *   - mounted BEFORE the app's global JSON parsers, with its own 4 kb parser
 *     and its own error handler that answers a fixed 400 and logs nothing of
 *     the request (X1);
 *   - POST only, and every request must carry `Origin` = the Bot's public
 *     origin, `Sec-Fetch-Site: same-origin` and `Content-Type:
 *     application/json` (X8: the Platform and the Bot are same-site, so
 *     SameSite alone does not separate them; a JSON content type also forces
 *     a CORS preflight, which the Bot-origin-only CORS policy refuses);
 *   - a dedicated per-IP rate limit per route;
 *   - `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on every
 *     answer;
 *   - error answers carry a fixed message and a code, never an input value;
 *   - purpose, network, account, bot and name come from the stored ticket
 *     only; bodies are `.strict()`, so a browser cannot even send them.
 */
import express, { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { botPublicOrigin, config } from "../config.js";
import { ControlRefusal } from "../services/controlCommands.js";
import {
  ENROLL_SESSION_COOKIE, ENROLLMENT_SESSION_TTL_MS, EnrollmentEnded, enrollmentMeta, openEnrollmentSession,
  resolveEnrollmentSession, returnUrlFor, revealWebhookSecret, submitEnrollmentKeys,
} from "../services/enrollment.js";
import { apiKeySchema, apiSecretSchema } from "../services/exchangeAccounts.js";

export interface EnrollRouterLimits {
  windowMs?: number;
  session?: number;
  state?: number;
  keys?: number;
  reveal?: number;
}

const SESSION_COOKIE_BASE = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: "/api/enroll",
};

function cookieOptions() {
  return { ...SESSION_COOKIE_BASE, secure: config.secureCookies };
}

function refuse(res: Response, status: number, code: string, error: string): void {
  res.status(status).json({ error, code });
}

function sendRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof ControlRefusal)) return false;
  refuse(res, error.status, error.code, error.message);
  return true;
}

/** The fixed answer for a body this router could not read or did not accept. */
const badRequest = (res: Response) => refuse(res, 400, "invalid_request", "Invalid request.");

/** Parse a body strictly; any failure is the fixed 400 (zod's own messages can quote input). */
function parseStrict<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { badRequest(res); return null; }
  return parsed.data as z.infer<T>;
}

const sessionSchema = z.object({ ticket: z.string().max(128) }).strict();
const emptySchema = z.object({}).strict();
const keysSchema = z.object({
  apiKey: apiKeySchema,
  apiSecret: apiSecretSchema,
  mainnetConfirmation: z.string().max(16).optional(),
}).strict();

function sessionCookie(req: Request): unknown {
  return (req.cookies as Record<string, unknown> | undefined)?.[ENROLL_SESSION_COOKIE];
}

export function createEnrollRouter(limits: EnrollRouterLimits = {}): Router {
  const router = Router();
  const windowMs = limits.windowMs ?? 15 * 60_000;
  const limiter = (max: number) => rateLimit({
    windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many attempts. Wait a few minutes, then start again from Trading Scene.",
      code: "rate_limited" },
  });

  // 1. Off unless explicitly enabled; no hint of what would be here.
  router.use((_req, res, next) => {
    if (!config.enrollmentEnabled) { refuse(res, 404, "not_found", "Not found."); return; }
    next();
  });

  // 2. Never cached, never leaks a Referer.
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // 3. Same-origin, JSON, POST — before any body is read (X8).
  router.use((req, res, next) => {
    const origin = botPublicOrigin();
    if (req.method !== "POST") { refuse(res, 404, "not_found", "Not found."); return; }
    if (!origin || req.get("origin") !== origin || req.get("sec-fetch-site") !== "same-origin"
        || !/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(req.get("content-type") ?? "")) {
      refuse(res, 403, "forbidden", "Forbidden.");
      return;
    }
    next();
  });

  // 4. Its own 4 kb parser (the app's global parsers are mounted after this router).
  router.use(express.json({ limit: "4kb", strict: true }));

  // ── POST /session: ticket -> session cookie ───────────────────────────────
  router.post("/session", limiter(limits.session ?? 10), async (req, res, next) => {
    try {
      const body = parseStrict(sessionSchema, req, res);
      if (!body) return;
      const { sessionToken, meta } = await openEnrollmentSession(body.ticket);
      res.cookie(ENROLL_SESSION_COOKIE, sessionToken, { ...cookieOptions(), maxAge: ENROLLMENT_SESSION_TTL_MS });
      res.json(meta);
    } catch (error) {
      if (sendRefusal(res, error)) return;
      next(error);
    }
  });

  // ── POST /state: the live session's metadata (a reload has no fragment) ──
  router.post("/state", limiter(limits.state ?? 30), async (req, res, next) => {
    try {
      if (!parseStrict(emptySchema, req, res)) return;
      res.json(await enrollmentMeta(await resolveEnrollmentSession(sessionCookie(req))));
    } catch (error) {
      if (sendRefusal(res, error)) return;
      next(error);
    }
  });

  // ── POST /keys: probe, then create or replace ─────────────────────────────
  router.post("/keys", limiter(limits.keys ?? 5), async (req, res, next) => {
    let enrollmentId: string | null = null;
    try {
      const row = await resolveEnrollmentSession(sessionCookie(req));
      enrollmentId = row.id;
      const body = parseStrict(keysSchema, req, res);
      if (!body) return;
      const answer = await submitEnrollmentKeys(row, body);
      res.clearCookie(ENROLL_SESSION_COOKIE, cookieOptions());
      res.json(answer);
    } catch (error) {
      if (error instanceof ControlRefusal) {
        // A refusal that ended the enrollment carries the way back.
        const failed = error instanceof EnrollmentEnded;
        if (failed) res.clearCookie(ENROLL_SESSION_COOKIE, cookieOptions());
        res.status(error.status).json({
          error: error.message, code: error.code,
          ...(failed && enrollmentId ? { returnUrl: returnUrlFor(enrollmentId, "failed") } : {}),
        });
        return;
      }
      next(error);
    }
  });

  // ── POST /reveal: the webhook secret, once ────────────────────────────────
  router.post("/reveal", limiter(limits.reveal ?? 5), async (req, res, next) => {
    try {
      const row = await resolveEnrollmentSession(sessionCookie(req));
      if (!parseStrict(emptySchema, req, res)) return;
      const answer = await revealWebhookSecret(row);
      res.clearCookie(ENROLL_SESSION_COOKIE, cookieOptions());
      res.json(answer);
    } catch (error) {
      if (sendRefusal(res, error)) return;
      next(error);
    }
  });

  router.use((_req: Request, res: Response) => refuse(res, 404, "not_found", "Not found."));

  // 5. Its own error handler: body errors are the fixed 400; anything else a
  //    masked 500 logged by class name only. Nothing of the request is logged.
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { req.socket.destroy(); return; }
    if (typeof (err as { type?: unknown } | null)?.type === "string") { badRequest(res); return; }
    console.error(`[enroll] ${req.path} failed name=${err instanceof Error ? err.name : typeof err}`);
    refuse(res, 500, "internal_error", "Internal server error.");
  });

  return router;
}
