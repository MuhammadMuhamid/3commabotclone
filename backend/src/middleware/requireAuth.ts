import type { Request, Response, NextFunction } from "express";
import { verifyAccess } from "../lib/jwt.js";

/**
 * Verifies the access_token httpOnly cookie.
 * On success sets res.locals.userId and calls next().
 * On failure returns 401 JSON.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // cookie-parser populates req.cookies
  const token = (req.cookies as Record<string, string> | undefined)?.access_token;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    const payload = verifyAccess(token);
    res.locals.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please log in again." });
  }
}
