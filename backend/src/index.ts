import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config, assertConfig } from "./config.js";
import { exchangeRouter } from "./routes/exchange.js";
import { botsRouter } from "./routes/bots.js";
import { tradesRouter } from "./routes/trades.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { authRouter } from "./routes/auth.js";
import { notificationsRouter } from "./routes/notifications.js";
import { requireAuth } from "./middleware/requireAuth.js";
import { checkTakeProfitStopLoss } from "./services/smartTrade.js";
import { detectManualCloses } from "./services/manualCloseSync.js";
import { prisma } from "./lib/prisma.js";

// Hard-fail in production if any critical secret is missing
assertConfig();

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
    // Disable COEP — binance-api-node uses cross-origin resources
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
// Webhook route: auth-exempt so TradingView can POST without a session
app.use("/api/webhooks", webhookLimiter, webhooksRouter);

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

// ─── Background jobs ──────────────────────────────────────────────────────────
// TP/SL monitor + PnL refresh — runs every 30s
setInterval(() => {
  checkTakeProfitStopLoss().catch(console.error);
}, 30_000);

// F2: Detect positions closed directly on Binance — runs every 60s
setInterval(() => {
  detectManualCloses().catch(console.error);
}, 60_000);

// Webhook log retention — prune entries older than 30 days
async function pruneWebhookLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.webhookLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) console.log(`[cleanup] Pruned ${count} webhook log(s) older than 30 days`);
}
pruneWebhookLogs().catch(console.error);
setInterval(() => pruneWebhookLogs().catch(console.error), 24 * 60 * 60 * 1000);

// ─── Crash guard ──────────────────────────────────────────────────────────────
// Node exits the process on an unhandled rejection. For a live trading daemon
// that is the worst possible response: it takes the TP/SL monitor and the
// manual-close sync down with it. A stray rejection in one request handler must
// not be able to stop position monitoring, so log loudly and stay up.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] API stayed up — investigate:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] API stayed up — investigate:", err);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`Signal Bot API  →  http://localhost:${config.port}  (dryRun=${config.dryRun})`);
});
