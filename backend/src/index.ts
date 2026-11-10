import { config, assertConfig } from "./config.js";
import { pruneExecutionEvents } from "./services/executionEvents.js";
import { createApp } from "./app.js";
import { checkTakeProfitStopLoss } from "./services/smartTrade.js";
import { detectManualCloses } from "./services/manualCloseSync.js";
import { prisma } from "./lib/prisma.js";
import { pruneCloseMarks } from "./lib/tradeCloseTracker.js";
import { startInterval } from "./lib/scheduler.js";
import { checkManualProtection, reconcileManualTrading } from "./services/manualProtection.js";
import { reconcilePendingStrategyIntents } from "./services/strategyOrderIntent.js";
import { deliverPendingRealizations } from "./services/realizationEvents.js";
import { reconcileSpotExecutionOrders } from "./services/spotExecution/service.js";
import { reconcileDerivativeExecutionOrders } from "./services/derivativeExecution/service.js";

// Hard-fail in production if any critical secret is missing
assertConfig();

const app = createApp();

// ─── Background jobs ──────────────────────────────────────────────────────────
//
// BOT-033: these ran under `setInterval`, which fires on the clock whether or
// not the previous run has finished. The TP/SL monitor walks every open
// position and makes Binance calls, so once a cycle exceeded 30 seconds a
// second cycle started on top of the first — two concurrent passes over the
// same positions. `startInterval` schedules the next run only after the
// previous one settles, and logs when a cycle overruns its interval.
startInterval("tpsl", 30_000, checkTakeProfitStopLoss);

// F2: Detect positions closed directly on Binance
startInterval("manual-close-sync", 60_000, detectManualCloses);
void reconcileManualTrading().catch((e) => console.error("manual reconciliation failed", e));
startInterval("manual-order-reconcile", 30_000, reconcileManualTrading);
startInterval("manual-tpsl", 30_000, checkManualProtection);
void reconcilePendingStrategyIntents().catch(
  (e) => console.error("strategy intent reconciliation failed", e));
startInterval("strategy-intent-reconcile", 30_000, reconcilePendingStrategyIntents);
if (config.spotExecutionEnabled) {
  void reconcileSpotExecutionOrders().catch((e) => console.error("spot execution reconciliation failed", e));
  startInterval("spot-execution-reconcile", 30_000, reconcileSpotExecutionOrders);
}
if (config.derivativeExecutionEnabled) {
  void reconcileDerivativeExecutionOrders().catch((e) => console.error("derivatives execution reconciliation failed", e));
  startInterval("derivatives-execution-reconcile", 30_000, reconcileDerivativeExecutionOrders);
}
void deliverPendingRealizations().catch((e) => console.error("realization delivery failed", e));
startInterval("realization-delivery", 30_000, async () => { await deliverPendingRealizations(); });

// Webhook log retention — prune entries older than 30 days, and the durable
// stale-sell markers past their TTL (BOT-019).
async function pruneWebhookLogs(): Promise<void> {
  const pruned = await pruneCloseMarks();
  if (pruned > 0) console.log(`[cleanup] Pruned ${pruned} expired pair-close marker(s)`);
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const { count } = await prisma.webhookLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (count > 0) console.log(`[cleanup] Pruned ${count} webhook log(s) older than 30 days`);
}
pruneWebhookLogs().catch(console.error);
startInterval("webhook-log-prune", 24 * 60 * 60 * 1000, pruneWebhookLogs);
startInterval("execution-event-prune", 24 * 60 * 60 * 1000, async () => { await pruneExecutionEvents(); });

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
