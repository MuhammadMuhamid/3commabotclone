import type { SignalBot } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol } from "../lib/symbols.js";
import {
  clientFromAccount,
  clientFromEnv,
  getBaseFreeBalance,
  getUsdtBalance,
  clientOrderId,
  ExchangeError,
  MinNotionalError,
  type BinanceClient,
} from "./binance.js";
import { updateSmartTradePnl } from "./smartTrade.js";
import { acquireTradeClose, releaseTradeClose } from "../lib/tradeCloseLock.js";
import {
  evaluateBotRisk, getBotRiskLimits, readBotRiskSnapshot, setBotTradingHalted,
  shouldLatchHalt,
} from "./riskControls.js";
import type { ReceiverOutcome } from "../contract/webhookContract.js";
import { calcOrderQuoteUsdt, isPerBotUnit } from "../lib/investment.js";
import { getLastCloseTs } from "../lib/tradeCloseTracker.js";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { sendExecutionNotification } from "./push.js";
import {
  hasUnresolvedStrategySell, reconcileStrategyIntent, reserveStrategyIntent,
  strategyMarketAdapter, type StrategyCrashHooks,
} from "./strategyOrderIntent.js";
import { platformWebhookIdentity } from "../contract/realizationEventContract.js";

const DEDUPE_TTL = 120_000;
/** Blocks a second buy/sell for same bot+pair within this window (TV order-fill duplicate guard) */
const TRADE_DEDUPE_TTL = 45_000;

// BUG-04: Per-bot lock prevents concurrent buys from racing past assertCanOpenTrade
const botBuyLocks = new Set<string>();

function dedupeHash(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function reservePersistentDedupe(key: string, ttlMs: number): Promise<boolean> {
  const keyHash = dedupeHash(key);
  const now = new Date();
  await prisma.webhookReceipt.deleteMany({ where: { expiresAt: { lt: now } } });
  try {
    await prisma.webhookReceipt.create({
      data: { keyHash, expiresAt: new Date(now.getTime() + ttlMs) },
    });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}

async function releasePersistentDedupe(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await prisma.webhookReceipt.deleteMany({
    where: { keyHash: { in: keys.map(dedupeHash) } },
  });
}

/** TradingView "Order fills" alert with Message {{alert_message}} sends literal placeholder → 401 */
export function isPlaceholderPayload(body: WebhookBody): boolean {
  const raw = JSON.stringify(body);
  if (raw.includes("{{alert_message}}") || raw.includes("{{strategy.order")) return true;
  if (!body.secret || body.secret === "REPLACE_ME") return true;
  return false;
}

export function tradeEventKey(secret: string, symbol: string, side: "buy" | "sell", leg?: string): string {
  return `trade:${secret}:${symbol}:${side}${leg ? `:${leg}` : ""}`;
}

export type WebhookBody = {
  secret?: string;
  action?: string;
  symbol?: string;
  tv_instrument?: string;
  quote_order_qty?: number | null;
  quantity?: number | null;
  /** Percentage of the currently tracked SmartTrade to sell. Omitted = full close. */
  sell_percent?: number | null;
  /** Stable exit identity; allows TP1 and TP2 on the same candle without defeating dedupe. */
  exit_leg?: "tp1" | "tp2" | "runner" | "stop" | "signal";
  dedupe_key?: string;
};

export function resolveAction(action: string): "buy" | "sell" {
  const a = action.toLowerCase().replace(/[\s_-]/g, "");
  if (["buy", "enterlong", "long", "entrylong", "openlong"].includes(a)) return "buy";
  if (
    ["sell", "exitlong", "closelong", "close", "exit", "closeposition", "market"].includes(a)
  ) {
    return "sell";
  }
  throw new Error(`Unknown action: ${action}`);
}

export function resolveSymbol(body: WebhookBody): string {
  const s = body.symbol ?? body.tv_instrument;
  if (!s) throw new Error("symbol or tv_instrument required");
  return normalizeSymbol(s);
}

async function getClient(bot: SignalBot): Promise<BinanceClient> {
  if (bot.exchangeAccountId) {
    const acc = await prisma.exchangeAccount.findUnique({
      where: { id: bot.exchangeAccountId },
    });
    if (!acc) throw new Error("Exchange account not found");
    return clientFromAccount(acc);
  }
  const env = clientFromEnv();
  if (!env) throw new Error("No Binance credentials. Add exchange account in Settings.");
  return env;
}

function botPairs(bot: SignalBot): string[] {
  return JSON.parse(bot.pairs) as string[];
}

async function assertCanOpenTrade(bot: SignalBot, symbol: string): Promise<void> {
  if (bot.maxActiveSmartTradesEnabled && bot.maxActiveSmartTrades != null) {
    const activeCount = await prisma.smartTrade.count({
      where: { botId: bot.id, status: "active" },
    });
    if (activeCount >= bot.maxActiveSmartTrades) {
      throw new Error(
        `Max active SmartTrades reached (${activeCount}/${bot.maxActiveSmartTrades})`
      );
    }
  }
  if (bot.maxEntryOrders != null) {
    const pairActive = await prisma.smartTrade.count({
      where: { botId: bot.id, pair: symbol, status: "active" },
    });
    if (pairActive >= bot.maxEntryOrders) {
      throw new Error(`Max entry orders for ${symbol} reached`);
    }
  }
}

export async function processWebhook(
  body: WebhookBody,
  { skipExitCheck = false, clientFactory = getClient, strategyCrashHooks,
    platformCorrelation }: {
    skipExitCheck?: boolean;
    clientFactory?: (bot: SignalBot) => Promise<BinanceClient>;
    strategyCrashHooks?: StrategyCrashHooks;
    platformCorrelation?: { deploymentId: string; orderIntentId: string };
  } = {}
): Promise<{ status: string; detail?: unknown }> {
  if (isPlaceholderPayload(body)) {
    throw new Error(
      "Invalid webhook payload (TradingView placeholder). Use alert() function calls only and Message {{alert_message}}."
    );
  }

  const secret = body.secret;
  if (!secret) throw new Error("secret required");

  const bot = await prisma.signalBot.findUnique({ where: { webhookSecret: secret } });
  if (!bot) throw new Error("Invalid secret");
  if (bot.status !== "active") throw new Error("Bot is not active");

  const symbol = resolveSymbol(body);
  const allowed = botPairs(bot).map(normalizeSymbol);
  if (!allowed.includes(symbol)) {
    throw new Error(`Pair ${symbol} not allowed for this bot`);
  }

  if (!body.action) throw new Error("action required");
  const actionRaw = body.action;
  const side = resolveAction(actionRaw);
  const reservedDedupeKeys: string[] = [];

  // Namespace caller keys: TradingView's {{timenow}} can be identical for
  // different coins and bots closing on the same bar.
  if (body.dedupe_key) {
    const callerKey = `caller:${bot.id}:${symbol}:${side}:${body.dedupe_key}`;
    if (!(await reservePersistentDedupe(callerKey, DEDUPE_TTL))) {
      return { status: "ignored_duplicate" };
    }
    reservedDedupeKeys.push(callerKey);
  }

  /*
   * The source-independent guard: it catches a duplicate arriving from the
   * OTHER sender within its window, which the caller key cannot because the two
   * senders' keys are namespaced separately.
   *
   * BOT-027: it used to apply to entries as well, and a bot whose
   * `maxEntryOrders` legitimately permits several positions in one pair could
   * not open a second within 45 seconds — the request came back
   * `ignored_duplicate` with HTTP 200, so the sender believed an order had been
   * placed when none had. A scale-in is not a duplicate.
   *
   * Entries are therefore keyed by the caller's `dedupe_key` alone. When the
   * sender supplies one, the caller-key guard above already covers the retry
   * case exactly, and does it durably. When it does not, an entry is not
   * deduplicated here — `assertCanOpenTrade` and the risk gate are what bound
   * how many positions can exist, which is the correct place for that decision.
   *
   * Exits keep the guard: closing the same position twice is never intended,
   * and the leg identity keeps a legitimate TP1-then-TP2 on one candle distinct.
   */
  if (side === "sell") {
    const tradeKey = tradeEventKey(bot.id, symbol, side, body.exit_leg);
    if (!(await reservePersistentDedupe(tradeKey, TRADE_DEDUPE_TTL))) {
      await releasePersistentDedupe(reservedDedupeKeys);
      return { status: "ignored_duplicate" };
    }
    reservedDedupeKeys.push(tradeKey);
  }

  // CRIT-03: Redact the webhook secret before storing the log payload.
  // The secret is a live credential — it must never be written to the database.
  const { secret: _redacted, ...safeBody } = body;
  const log = await prisma.webhookLog.create({
    data: {
      botId: bot.id,
      payload: JSON.stringify(safeBody),
      status: "processing",
    },
  });

  // BOT-005: the trade whose close lock this call holds, released in the
  // `finally` below however this function ends.
  let closeLockHeld: string | null = null;
  let submissionAttempted = false;
  let strategyIntentId: string | null = null;

  try {
    let result: { status: string; detail?: unknown };

    /*
     * The operator halt applies to every exchange submission. Numeric exposure,
     * concurrency and loss limits still exempt SELL exits in evaluateBotRisk;
     * this early pass is what prevents the sell branch from bypassing the halt.
     * It also stops an already-blocked BUY before credentials/balances are read.
     */
    const preflight = await guardOrder(side, 0);
    if (!preflight.ok) {
      await prisma.webhookLog.update({ where: { id: log.id },
        data: { status: "blocked", message: preflight.reason } });
      await releasePersistentDedupe(reservedDedupeKeys);
      return { status: preflight.outcome, detail: preflight.reason };
    }

    if (side === "buy") {
      if (!bot.entryEnabled) throw new Error("Entry orders disabled on this bot");

      /*
       * F-AUTO-02: without a caller `dedupe_key`, `idempotencyScope` falls back
       * to a per-minute bucket. `maxEntryOrders` bounds concurrently ACTIVE
       * SmartTrade rows, not lifetime or per-minute entries — once an entry's
       * SmartTrade closes, another is immediately eligible, including a
       * `maxEntryOrders === 1` bot. A legitimate close-then-re-enter inside the
       * same wall-clock minute derives the same fallback bucket as the closed
       * entry's original signal, so it would silently collide with that stale
       * identity instead of opening its own position. Every BUY therefore
       * requires a stable caller-provided key; reject explicitly before any
       * intent is reserved rather than fall back to the minute bucket.
       */
      if (!body.dedupe_key) {
        throw new Error(
          `${symbol}: dedupe_key is required for entry signals — a stable, ` +
          "caller-provided identity for the logical signal, reused on retries. " +
          "The per-minute fallback cannot tell a genuine re-entry apart from a " +
          "retry of a prior entry."
        );
      }

      // BUG-04: Serialize concurrent buys per bot to prevent exceeding maxActiveSmartTrades
      if (botBuyLocks.has(bot.id)) {
        throw new Error("Trade creation in progress for this bot. Retry shortly.");
      }
      botBuyLocks.add(bot.id);

      try {
        await assertCanOpenTrade(bot, symbol);
        const client = await clientFactory(bot);
        const usdt = await getUsdtBalance(client);
        /*
         * BOT-013: "per Bot" units are a ceiling on the bot's TOTAL
         * commitment, so what its open trades already hold is subtracted. The
         * two unit families used to compute identically — "100 USDT per Bot"
         * with three concurrent positions deployed 300 USDT.
         */
        const committed = await prisma.smartTrade.aggregate({
          where: { botId: bot.id, status: "active" },
          _sum: { quoteSpent: true },
        });
        const quote = calcOrderQuoteUsdt(
          bot,
          usdt,
          body.quote_order_qty,
          committed._sum.quoteSpent ?? 0
        );
        if (quote <= 0) {
          throw new Error(
            isPerBotUnit(bot.maxInvestmentUnit)
              ? `This bot's per-Bot allowance is fully committed ` +
                `(${(committed._sum.quoteSpent ?? 0).toFixed(2)} already open). No entry placed.`
              : "Quote amount must be > 0"
          );
        }

        /*
         * BOT-011: the account-level risk gate, immediately before the order.
         *
         * This is the RECEIVING half of the check. The platform gates its own
         * emission, but it is not the only sender — TradingView posts to this
         * same endpoint directly — so a gate that lived only in the sender
         * would not cover the second path.
         *
         * `assertCanOpenTrade` above is per-bot and defaults to disabled; this
         * is across every bot on the account.
         */
        const riskDecision = await guardOrder("buy", quote);
        if (!riskDecision.ok) {
          await prisma.webhookLog.update({
            where: { id: log.id },
            data: { status: "blocked", message: riskDecision.reason },
          });
          await releasePersistentDedupe(reservedDedupeKeys);
          return { status: riskDecision.outcome, detail: riskDecision.reason };
        }

        // Persist the complete monetary identity before crossing the exchange
        // boundary. The durable requested->submitted transition below is the
        // sole authority that may perform the initial submission.
        const scope = idempotencyScope(bot.id, symbol, "buy", body.dedupe_key);
        const intent = await reserveStrategyIntent({
          sourceKey: scope,
          webhookLogId: log.id,
          bot,
          clientOrderId: clientOrderId(scope),
          symbol,
          side: "BUY",
          requestedQuoteQty: quote,
        }, strategyCrashHooks);
        strategyIntentId = intent.id;
        const execution = await reconcileStrategyIntent(
          intent.id,
          strategyMarketAdapter(client),
          { hooks: strategyCrashHooks }
        );
        submissionAttempted = execution.intent.status !== "requested" &&
          execution.intent.status !== "rejected";
        if (execution.pending || !execution.result) {
          throw new Error(
            `${symbol}: strategy BUY outcome remains unresolved; deterministic reconciliation pending`
          );
        }
        const orderResult = execution.result;
        const tradeId = execution.intent.smartTradeId;
        if (tradeId) await updateSmartTradePnl(tradeId, client);
        if (execution.appliedNow) {
          void sendExecutionNotification({
            side: "buy", symbol, quantity: orderResult.executedQty,
            quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
            orderId: orderResult.orderId,
          }).catch((e) => console.error("BUY notification failed", e));
        }
        result = { status: "ok", detail: { side: "buy", ...orderResult } };
      } finally {
        botBuyLocks.delete(bot.id);
      }
    } else {
      // BUG-03: Enforce exitEnabled for webhook sells; skipExitCheck=true for dashboard manual closes
      if (!skipExitCheck && !bot.exitEnabled) {
        throw new Error("Exit orders disabled on this bot");
      }

      const client = await clientFactory(bot);
      let qty = body.quantity;
      const active = await prisma.smartTrade.findFirst({
        where: { botId: bot.id, pair: symbol, status: "active" },
        orderBy: { createdAt: "desc" },
      });
      if (!active && !skipExitCheck) {
        throw new Error(`No active SmartTrade for ${symbol}`);
      }
      /*
       * X-01: a `sell_percent` of exactly 100 is a FULL CLOSE, not an invalid
       * partial. It used to be rejected outright — a terminal 400 — so the
       * take-profit never reached the exchange while the sender marked the tier
       * done. It is now treated as the full close it is.
       */
      let partialPct = body.sell_percent;
      if (partialPct != null && (!Number.isFinite(partialPct) || partialPct <= 0 || partialPct > 100)) {
        throw new Error("sell_percent must be greater than 0 and at most 100; omit it for a full close");
      }
      if (partialPct != null && partialPct >= 100) partialPct = null;
      if (partialPct != null) {
        if (!active) throw new Error(`No active SmartTrade for ${symbol}`);
        if (body.quantity != null && body.quantity > 0) {
          throw new Error("Use either sell_percent or quantity, not both");
        }
        qty = active.quantity * partialPct / 100;
      }
      // Treat 0 the same as null/undefined — indicator sends 0.000000 to mean "auto-detect"
      if (qty == null || qty <= 0) {
        qty = active?.quantity ?? (await getBaseFreeBalance(client, symbol));
      }
      // A webhook sell may reduce the tracked position, never unrelated wallet holdings.
      if (active) qty = Math.min(qty, active.quantity);
      if (!qty || qty <= 0) throw new Error("No quantity to sell");

      /*
       * BOT-005: TAKE the lock, do not merely read it.
       *
       * `isTradeClosing` reports whether someone else holds it; it does not
       * stop this path proceeding. Of the four paths that close a trade, only
       * the TP/SL monitor actually acquired the lock — so a TP trigger
       * coinciding with a SELL webhook issued two market sells for one
       * position, and because a sell is capped against the shared WALLET
       * balance, the second could eat another bot's position in the same asset.
       *
       * Released in the `finally` at the end of the sell branch.
       */
      if (active) {
        if (!acquireTradeClose(active.id)) {
          throw new Error("Trade is already being closed. Please wait.");
        }
        closeLockHeld = active.id;
      }

      // STALE-SELL GUARD: if the active trade was opened AFTER the last close
      // for this bot+pair, this SELL signal was meant for the previous trade
      // (which is already closed). Skip to avoid accidentally closing the new trade.
      // skipExitCheck=true means the user clicked Close on the dashboard — always allow.
      if (active && !skipExitCheck) {
        const lastCloseTs = await getLastCloseTs(bot.id, symbol);
        if (lastCloseTs !== undefined && active.createdAt.getTime() > lastCloseTs) {
          await releasePersistentDedupe(reservedDedupeKeys);
          return {
            status: "ignored_stale_sell",
            detail: `${symbol} position was re-opened after a recent close. Sell signal skipped to protect the new trade (opened ${new Date(active.createdAt).toISOString()}).`,
          };
        }
      }

      if (active && await hasUnresolvedStrategySell(active.id)) {
        throw new Error(
          `${symbol}: a prior strategy SELL has unresolved exchange state; reconcile it before another close`
        );
      }

      const scope = idempotencyScope(bot.id, symbol, "sell", body.dedupe_key);
      const intent = await reserveStrategyIntent({
        sourceKey: scope,
        webhookLogId: log.id,
        bot,
        clientOrderId: clientOrderId(scope),
        symbol,
        side: "SELL",
        requestedBaseQty: qty,
        sellPercent: partialPct ?? undefined,
        exitLeg: body.exit_leg,
        skipExitCheck,
        smartTradeId: active?.id,
        platformDeploymentId: platformCorrelation?.deploymentId,
        platformOrderIntentId: platformCorrelation?.orderIntentId,
        platformDedupeKey: body.dedupe_key,
        platformWebhookIdentity: body.dedupe_key ? platformWebhookIdentity(secret) : undefined,
      }, strategyCrashHooks);
      strategyIntentId = intent.id;
      const execution = await reconcileStrategyIntent(
        intent.id,
        strategyMarketAdapter(client),
        { hooks: strategyCrashHooks }
      );
      submissionAttempted = execution.intent.status !== "requested" &&
        execution.intent.status !== "rejected";
      if (execution.pending || !execution.result) {
        throw new Error(
          `${symbol}: strategy SELL outcome remains unresolved; deterministic reconciliation pending`
        );
      }
      if (execution.shortfall) throw new Error(`${execution.shortfall} — investigate before retrying.`);

      const orderResult = execution.result;
      if (active && partialPct != null) await updateSmartTradePnl(active.id, client);
      if (execution.appliedNow) {
        const closed = active
          ? await prisma.smartTrade.findUnique({ where: { id: active.id } })
          : null;
        void sendExecutionNotification({
          side: "sell", symbol, quantity: orderResult.executedQty,
          quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
          orderId: orderResult.orderId, pnlPct: closed?.pnlPct,
        }).catch((e) => console.error("SELL notification failed", e));
      }
      result = partialPct != null
        ? { status: "ok", detail: {
          side: "sell", partial: true, sellPercent: partialPct,
          exitLeg: body.exit_leg, ...orderResult,
        }}
        : { status: "ok", detail: { side: "sell", ...orderResult } };
    }

    // BUG-01: Mark the single log entry as ok on success
    await prisma.webhookLog.update({ where: { id: log.id }, data: { status: "ok" } });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (strategyIntentId) {
      const durable = await prisma.strategyOrderIntent.findUnique({ where: { id: strategyIntentId } });
      submissionAttempted = durable != null &&
        durable.status !== "requested" && durable.status !== "rejected";
    }
    // A known exchange rejection (or any failure before submission) created no
    // order, so a retry must be allowed. Ambiguous transport failures and local
    // post-submit failures retain the receipt to fail safe against duplication.
    if (!submissionAttempted ||
        (e instanceof ExchangeError && e.code !== undefined) ||
        e instanceof MinNotionalError) {
      await releasePersistentDedupe(reservedDedupeKeys);
    }
    // BUG-01: Update the existing log entry instead of creating a second one
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: "error", message: msg },
    });
    throw e;
  } finally {
    // A lock leaked by an exception makes the trade permanently uncloseable,
    // which is worse than the double sell it prevents.
    if (closeLockHeld) releaseTradeClose(closeLockHeld);
  }
}

// ── Helpers used above ──────────────────────────────────────────────────────

/**
 * The scope string a deterministic client order id is derived from.
 *
 * When the sender supplied a `dedupe_key` that is the natural identity of the
 * logical order, so a retry of the SAME order produces the SAME exchange client
 * id and Binance itself rejects the duplicate. Without one, a per-minute bucket
 * is the best available: it still collapses an immediate retry, and it does not
 * collide across distinct signals.
 */
export function idempotencyScope(
  botId: string,
  symbol: string,
  side: "buy" | "sell",
  dedupeKey: string | undefined,
  now = Date.now()
): string {
  if (dedupeKey) return `${botId}:${symbol}:${side}:${dedupeKey}`;
  const minuteBucket = Math.floor(now / 60_000);
  return `${botId}:${symbol}:${side}:t${minuteBucket}`;
}

type OrderGuard =
  | { ok: true }
  | { ok: false; outcome: ReceiverOutcome; reason: string };

/**
 * The account-level risk gate for an entry.
 *
 * Returns a `ReceiverOutcome` so the route can answer 409 rather than 200 — a
 * sender that ignores the response body must still fail safe, which is the
 * lesson of X-12.
 */
async function guardOrder(side: "buy" | "sell", quoteQty: number): Promise<OrderGuard> {
  const limits = await getBotRiskLimits();
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
  const decision = evaluateBotRisk(limits, snapshot, { side, quoteQty });
  if (decision.allowed) return { ok: true };

  const latch = shouldLatchHalt(decision);
  if (latch) {
    await setBotTradingHalted(true, { reason: decision.reason, by: latch });
    console.error(`[risk] kill switch LATCHED by ${latch}: ${decision.reason}`);
  }
  console.error(`[risk] entry BLOCKED (${decision.code}): ${decision.reason}`);
  return {
    ok: false,
    outcome: decision.code === "trading_halted" ? "halted" : "risk_blocked",
    reason: decision.reason,
  };
}
