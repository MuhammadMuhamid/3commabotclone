/**
 * Terminal error handling for Express 4.
 *
 * Express 4 does not catch a rejected promise from an async handler. The
 * rejection escaped to the process-level `unhandledRejection` guard, which logs
 * and deliberately keeps the daemon alive — so the request simply **never got a
 * response**. A dashboard delete of a missing bot id (`P2025`) hung the browser
 * forever rather than returning 404.
 *
 * Two pieces:
 *   * `asyncHandler` forwards a rejection to Express's error pipeline;
 *   * `errorHandler` is the last middleware and always answers.
 *
 * Neither changes any status code a route already sets deliberately.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";

/** Wrap an async route so a rejection reaches `errorHandler` instead of vanishing. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Prisma error codes that map to a specific HTTP status rather than a 500. */
function prismaStatus(code: string): number | null {
  switch (code) {
    case "P2025": return 404;   // record required but not found
    case "P2002": return 409;   // unique constraint violation
    case "P2003": return 409;   // foreign key constraint violation
    case "P2000": return 400;   // value too long for the column
    default: return null;
  }
}

export interface ErrorBody {
  error: string;
}

/**
 * Last middleware in the chain. Every request gets an answer.
 *
 * A 5xx never carries the thrown message or a stack. This process holds
 * decrypted Binance API keys, the database DSN and webhook secrets, and any of
 * those can end up inside an exception string.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (res.headersSent) {
    // Nothing useful can be sent now; destroy rather than leave it hanging.
    req.socket.destroy();
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const status = prismaStatus(err.code);
    if (status !== null) {
      const message =
        status === 404 ? "Not found"
        : status === 409 ? "Conflict: that record already exists or is still referenced"
        : "Invalid request";
      console.warn(`[error] ${req.method} ${req.path} -> ${status} (prisma ${err.code})`);
      res.status(status).json({ error: message } satisfies ErrorBody);
      return;
    }
  }

  const status = typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : 500;

  console.error(`[error] ${req.method} ${req.path} -> ${status}`, err);

  if (status >= 500) {
    res.status(status).json({ error: "Internal server error" } satisfies ErrorBody);
    return;
  }
  const message = err instanceof Error && !config.isProduction
    ? err.message
    : "Request failed";
  res.status(status).json({ error: message } satisfies ErrorBody);
}

/** 404 for an unmatched API path, so the SPA does not receive HTML. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` } satisfies ErrorBody);
}
