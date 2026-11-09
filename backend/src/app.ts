/**
 * The HTTP application: middleware, routes and terminal error handling, in the
 * exact order the server runs them.
 *
 * Split out of `index.ts` so tests can drive the real composition — the order
 * of body parsers, limiters and routers is itself a security property (the
 * public enrollment routes must see their own 4 kb parser, never the global
 * one; X1: no body ever reaches a log). `index.ts` keeps the process concerns:
 * configuration assertion, background jobs, crash guards and `listen`.
 */
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { exchangeRouter } from "./routes/exchange.js";
import { botsRouter } from "./routes/bots.js";
import { tradesRouter } from "./routes/trades.js";
import {
  operationalStatusHandler, strategyExecutionEvidenceHandler, webhooksRouter,
} from "./routes/webhooks.js";
import { authRouter } from "./routes/auth.js";
import { notificationsRouter } from "./routes/notifications.js";
import { operationsRouter } from "./routes/operations.js";
import { manualTradingRouter } from "./routes/manualTrading.js";
import { createControlRateLimiters } from "./routes/manualControl.js";
import { spotExecutionRouter } from "./routes/spotExecution.js";
import { derivativeExecutionRouter } from "./routes/derivativeExecution.js";
import { equityExecutionRouter } from "./routes/equityExecution.js";
import { traditionalExecutionRouter } from "./routes/traditionalExecution.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { createEnrollRouter, type EnrollRouterLimits } from "./routes/enroll.js";

export function createApp(opts: { enrollLimits?: EnrollRouterLimits } = {}): Express {
  const app = express();

  // ─── Trust nginx proxy (needed so rate-limiting reads real client IP) ─────────
  app.set("trust proxy", 1);

  // ─── Security headers ─────────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc:  ["'self'"],
          scriptSrc:   ["'self'"],
          styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc:     ["'self'", "https://fonts.gstatic.com"],
          imgSrc:      ["'self'", "data:"],   // data: needed for TOTP QR codes
          connectSrc:  ["'self'"],
          frameAncestors: ["'none'"],         // clickjacking protection
        },
      },
      // COEP is off. The reason recorded here was "binance-api-node uses
      // cross-origin resources", which is not a reason: COEP is a response header
      // governing what a BROWSER DOCUMENT may embed, and the exchange SDK runs
      // server-side in this process. The header is left off because this origin
      // serves the dashboard, and turning it on would require every embedded
      // resource to opt in — a separate change with its own browser testing.
      crossOriginEmbedderPolicy: false,
    })
  );

  // ─── CORS ─────────────────────────────────────────────────────────────────────
  // credentials:true is required so the browser sends httpOnly cookies
  app.use(
    cors({
      origin: config.corsOrigin,
      credentials: true,
    })
  );

  // ─── Cookie parsing ───────────────────────────────────────────────────────────
  app.use(cookieParser());

  // ─── OD-4 public enrollment routes ───────────────────────────────────────────
  // BEFORE the global parsers below: these routes read their bodies with their
  // own 4 kb parser and answer parse errors themselves, without logging (X1),
  // and check Origin / Sec-Fetch-Site / Content-Type before reading anything.
  // Authorized by the enrollment ticket/session only — never the dashboard JWT.
  app.use("/api/enroll", createEnrollRouter(opts.enrollLimits));

  // ─── Body parsing — strict per-route limits ───────────────────────────────────
  // Webhooks need only ~200 bytes; keep other routes tight too.
  app.use("/api/webhooks", express.json({ limit: "10kb" }));
  app.use(express.json({ limit: "100kb" }));

  // ─── Rate limiters ────────────────────────────────────────────────────────────
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 min
    max: 20,                   // 20 login/register/TOTP attempts
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts — please try again in 15 minutes." },
  });

  // Session refresh is not a credential attempt — a long-lived dashboard session
  // legitimately refreshes every 15 min (more with several tabs open). Sharing the
  // 20-per-15-min credential budget locked users out mid-session, so it gets its
  // own, more generous limiter.
  const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many refresh attempts — please try again shortly." },
    /*
     * An anonymous visit to /login runs GET /api/auth/me, which 401s, which makes
     * the frontend's transparent-refresh path POST here with no refresh cookie at
     * all. Those requests used to spend from the same 120-per-15-minutes budget
     * as real sessions, so repeatedly loading the login page could lock out a
     * legitimate user mid-session (finding BOT-040).
     *
     * A cookieless refresh is rejected by the route before it touches the
     * database, so it costs nothing and does not need a budget.
     */
    skip: (req) => !(req.cookies as Record<string, string> | undefined)?.refresh_token,
  });

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please slow down." },
  });

  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 30, // TradingView fires at most one alert per 5m candle per symbol
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many webhook requests." },
  });

  // The platform polls /signal_bots/status every 30 seconds for every deployment
  // group. Sharing the 30/min order-signal budget meant routine polling could
  // exhaust it and start rejecting real BUY/SELL signals, so it gets its own.
  const webhookStatusLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many status requests." },
  });

  // ─── Open routes (no auth) ────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    // Do NOT expose dryRun or any internal state publicly
    res.json({ status: "ok" });
  });

  // Apply the strict authLimiter only to credential/TOTP/token-mutation routes.
  // GET /status and GET /me are called on every page load — they must NOT be
  // rate-limited by the same counter or the frontend spins forever after ~10 loads.
  app.use("/api/auth/login",    authLimiter);
  app.use("/api/auth/register", authLimiter);
  app.use("/api/auth/totp",     authLimiter); // covers /totp/qr, /totp/enable, /totp/verify
  app.use("/api/auth/refresh",  refreshLimiter);
  app.use("/api/auth/logout",   authLimiter);
  app.use("/api/auth", authRouter);
  // Webhook routes: auth-exempt so TradingView can POST without a session.
  // Order signals and the position-status poll get separate budgets — see above.
  app.use("/api/webhooks/signal_bots/status", webhookStatusLimiter);
  // This read-only platform poll must not spend from the real-order signal
  // budget. Register the complete handler before the generic webhook limiter.
  app.post(
    "/api/webhooks/signal_bots/operations",
    webhookStatusLimiter,
    operationalStatusHandler
  );
  app.post(
    "/api/webhooks/signal_bots/execution-evidence",
    webhookStatusLimiter,
    strategyExecutionEvidenceHandler
  );
  app.use("/api/webhooks", webhookLimiter, webhooksRouter);
  // Separate service-to-service HMAC contract; never accepts strategy body secrets
  // or browser cookies as authentication.
  //
  // Contract F9: the Platform's operator controls (`/control/*`) get their own
  // limiters and do NOT spend from `apiLimiter`, which manual orders and the
  // Platform's read views share — so that traffic cannot starve a halt. Their
  // 429 carries `code: "bot_rate_limited"`.
  app.use("/api/manual-trading/control", ...createControlRateLimiters());
  app.use(
    "/api/manual-trading",
    (req, res, next) => (req.path.startsWith("/control/") ? next() : apiLimiter(req, res, next)),
    manualTradingRouter
  );
  app.use("/api/spot-execution/v1", apiLimiter, spotExecutionRouter);
  app.use("/api/derivative-execution/v1", apiLimiter, derivativeExecutionRouter);
  app.use("/api/equity-execution/v1", apiLimiter, equityExecutionRouter);
  app.use("/api/traditional-execution/v1", apiLimiter, traditionalExecutionRouter);

  // ─── Protected routes (requireAuth applied globally below) ───────────────────
  app.get("/api/config", requireAuth, apiLimiter, (_req, res) => {
    res.json({
      publicUrl: config.publicUrl,
      webhookPath: "/api/webhooks/signal_bots",
      dryRun: config.dryRun,
    });
  });

  app.use("/api/exchange-accounts", requireAuth, apiLimiter, exchangeRouter);
  app.use("/api/bots",              requireAuth, apiLimiter, botsRouter);
  app.use("/api/trades",            requireAuth, apiLimiter, tradesRouter);
  app.use("/api/notifications",     requireAuth, apiLimiter, notificationsRouter);
  app.use("/api/ops",               requireAuth, apiLimiter, operationsRouter);

  // ─── Terminal error handling ──────────────────────────────────────────────────
  // Express 4 does not catch a rejected promise from an async handler, so a
  // rejection used to escape to the process-level guard below: the daemon stayed
  // up, correctly, but the request never received a response and the browser hung
  // forever. These two must be registered AFTER every route.
  app.use("/api", notFoundHandler);
  app.use(errorHandler);

  return app;
}
