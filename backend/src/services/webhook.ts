import type { SignalBot } from "@prisma/client";
import { config } from "../config.js";
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
import {
  SHARIAH_NONCE_FIELD, SHARIAH_SIGNATURE_FIELD, SHARIAH_TIMESTAMP_FIELD,
  type ReceiverOutcome,
} from "../contract/webhookContract.js";
import { calcOrderQuoteUsdt, isPerBotUnit } from "../lib/investment.js";
import { getLastCloseTs } from "../lib/tradeCloseTracker.js";
import { exitAttemptProbe, resolveUnresolvedExitAttempts } from "./exitSettlement.js";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { sendExecutionNotification } from "./push.js";
import {
  AuthorizationNonceReplayError,
  reconcileStrategyIntent, reserveStrategyIntent, resolveUnresolvedStrategySells,
  strategyMarketAdapter, type StrategyCrashHooks,
} from "./strategyOrderIntent.js";
import { platformWebhookIdentity } from "../contract/realizationEventContract.js";
import {
  admitSpotEntry, noteSpotExit, readShariahContext, ShariahEnforcementError,
  shariahScopeForBot,
} from "./shariah.js";

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
  /**
   * The Platform's authenticated Shariah decision. Deliberately `unknown`: this
   * is caller-supplied data, and the only thing entitled to interpret it is the
   * shared contract's validator.
   */
  shariah?: unknown;
  /**
   * The detached Platform signature over that decision, the timestamp it
   * covers, and the single-use identity of the authorisation it grants. All
   * `unknown`: caller-supplied, and only the enforcement service may decide
   * whether any of them is usable.
   */
  shariah_sig?: unknown;
  shariah_ts?: unknown;
  shariah_nonce?: unknown;
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

  /*
   * CRIT-03: Redact the webhook secret before storing the log payload.
   * The secret is a live credential — it must never be written to the database.
   *
   * The detached Shariah credentials go with it, for the same reason and on the
   * same rule. `shariah_nonce` is a single-use authorisation and `shariah_sig`
   * is what makes it usable; together they are a bearer token for one entry,
   * and a request that was REFUSED — by the risk gate, by the halt, by a
   * balance — leaves its authorisation unspent for the remainder of its
   * freshness window. This log is retained for thirty days, so persisting them
   * would keep a live credential long past the moment it mattered.
   *
   * The DECISION itself (`shariah`) is deliberately kept: it is the auditable
   * evidence of what was asserted, and it authorises nothing on its own. And
   * nothing is lost for forensics — an admitted entry records the hash of its
   * authorisation on the intent, which is what links the two.
   */
  const {
    secret: _redacted,
    [SHARIAH_SIGNATURE_FIELD]: _sig,
    [SHARIAH_NONCE_FIELD]: _nonce,
    ...safeBody
  } = body;
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

    /*
     * The Shariah gate, alongside the operator halt and for the same reason:
     * this is the earliest point where the bot, the symbol and the side are all
     * known, and nothing has been claimed yet. It runs before `entryEnabled`,
     * before any credential or balance is read, before a client order id
     * exists, and before `reserveStrategyIntent` — so a refusal leaves no
     * durable reservation and reaches no exchange.
     *
     * Only a BUY can be refused here. A SELL merely records what it asserted:
     * an exit is never blocked on a Shariah status, so there is no branch below
     * that could stop one.
     */
    const shariahScope = shariahScopeForBot(bot.id);
    /*
     * This path authenticates the SENDER with a shared secret carried in the
     * body, which authorises placing an order — not certifying one. So the
     * decision block, if present, has to prove itself separately: a detached
     * Platform signature over the symbol, the side and the decision. A direct
     * TradingView alert can produce neither the block nor the signature, which
     * is why enforcement refuses it rather than silently trusting it.
     */
    const shariahAuth = {
      kind: "detached" as const,
      side,
      signature: body[SHARIAH_SIGNATURE_FIELD],
      timestamp: body[SHARIAH_TIMESTAMP_FIELD],
      nonce: body[SHARIAH_NONCE_FIELD],
    };
    let shariahEvidence: string | null = null;
    /*
     * The single-use authorisation this BUY is spending, carried from the gate
     * to the durable reservation below and claimed there — not here. Between
     * the two, several things can still legitimately refuse the order
     * (`entryEnabled`, the trade caps, the balance, the account risk gate), and
     * none of them should cost the sender its authorisation.
     */
    let authorizationNonceHash: string | null = null;
    /*
     * The durable identity this BUY will be reserved under, computed ONCE here
     * and reused verbatim below.
     *
     * Two reasons it is hoisted. The gate needs it to tell a redelivery of this
     * order apart from a replay presenting its authorisation for a different
     * one. And computing it twice would risk the two disagreeing: without a
     * caller `dedupe_key` it falls back to a wall-clock minute bucket, so two
     * calls either side of a minute boundary derive different scopes. A BUY
     * without a `dedupe_key` is refused below regardless, but the value must
     * not be able to drift between the check and the claim.
     */
    const buyIntentKey = side === "buy"
      ? idempotencyScope(bot.id, symbol, "buy", body.dedupe_key)
      : null;
    if (side === "buy") {
      try {
        const admission = await admitSpotEntry({
          scope: shariahScope, symbol, context: readShariahContext(body.shariah),
          auth: shariahAuth, intentKey: buyIntentKey,
          requireDurableAuthority: platformCorrelation !== undefined,
        });
        shariahEvidence = admission.persisted;
        authorizationNonceHash = admission.authorizationNonceHash;
        if (platformCorrelation && !authorizationNonceHash) {
          throw new ShariahEnforcementError(
            "SHARIAH_EVIDENCE_UNVERIFIED",
            `${symbol}: BUY requires a signed, single-use Platform authorisation`
          );
        }
      } catch (error) {
        if (!(error instanceof ShariahEnforcementError)) throw error;
        await prisma.webhookLog.update({ where: { id: log.id },
          data: { status: "blocked", message: `${error.code}: ${error.message}` } });
        await releasePersistentDedupe(reservedDedupeKeys);
        return { status: "shariah_blocked", detail: { code: error.code, reason: error.message } };
      }
    } else {
      shariahEvidence = await noteSpotExit(shariahScope, body.shariah,
        { symbol, auth: shariahAuth });
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
         * emission. TradingView may post exits to this endpoint directly, so
         * the receiver still enforces the same limits while keeping exits safe.
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
        /*
         * Non-null throughout this branch by construction — it is computed
         * exactly when `side` is "buy". Checked rather than cast so a future
         * refactor that moves either one cannot silently reserve under a key
         * the gate never saw.
         */
        if (!buyIntentKey) throw new Error(`${symbol}: BUY reached reservation with no intent key`);
        const scope = buyIntentKey;
        let intent;
        try {
          intent = await reserveStrategyIntent({
            sourceKey: scope,
            webhookLogId: log.id,
            bot,
            clientOrderId: clientOrderId(scope),
            symbol,
            side: "BUY",
            requestedQuoteQty: quote,
            shariahContext: shariahEvidence,
            authorizationNonceHash,
          }, strategyCrashHooks);
        } catch (error) {
          /*
           * The authoritative replay refusal.
           *
           * `admitSpotEntry` already turns away the sequential replay, but only
           * the unique index can decide a race, and this is where it speaks. It
           * is reached when two requests carrying the same signed authorisation
           * are in flight together: both passed the gate's read, one won the
           * insert, and this is the other one.
           *
           * Nothing has reached the exchange on this path — the reservation is
           * what licenses a submission, and it did not happen — so this is
           * reported exactly as the gate's own refusal is, and the sender is
           * told it is still flat.
           */
          if (!(error instanceof AuthorizationNonceReplayError)) throw error;
          await prisma.webhookLog.update({ where: { id: log.id },
            data: { status: "blocked", message: `SHARIAH_EVIDENCE_REPLAYED: ${error.message}` } });
          await releasePersistentDedupe(reservedDedupeKeys);
          return {
            status: "shariah_blocked",
            detail: { code: "SHARIAH_EVIDENCE_REPLAYED", reason: error.message },
          };
        }
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
      let active = await prisma.smartTrade.findFirst({
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
       *
       * This is the PURE validation of the payload, and it stays ahead of the
       * close lock and of any exchange call: a malformed request must be
       * refused before anything is claimed. The sizing it feeds happens below,
       * after a prior unresolved SELL has been resolved, because that can
       * legitimately change what the position holds.
       */
      let partialPct = body.sell_percent;
      if (partialPct != null && (!Number.isFinite(partialPct) || partialPct <= 0 || partialPct > 100)) {
        throw new Error("sell_percent must be greater than 0 and at most 100; omit it for a full close");
      }
      if (partialPct != null && partialPct >= 100) partialPct = null;
      if (partialPct != null && body.quantity != null && body.quantity > 0) {
        throw new Error("Use either sell_percent or quantity, not both");
      }

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
       * BOT-P1-2 moved this ahead of the quantity arithmetic: resolving a prior
       * unresolved SELL below can legitimately reduce or close the position, so
       * the quantity has to be computed from what the trade holds AFTER that,
       * and the lock has to be held across the whole read-resolve-read sequence.
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

      /*
       * BOT-P1-2: a prior SELL intent stuck in `submitted` used to wedge this
       * path forever, and `skipExitCheck` did not exempt it, so the dashboard
       * Close button was dead too and the remedy was editing the database.
       *
       * The guard is right — never place a second exit while a first one's fate
       * is unknown — it just had no way to LEARN that fate. It does now, and it
       * is the same query-first authority the reconciler uses: the exact
       * exchange order belonging to that exact intent is looked up, a fill is
       * reconciled through the ordinary accounting path, an order proven never
       * to have been placed is closed off, and anything still live or genuinely
       * unknowable keeps this call blocked with a truthful reason. Deliberately
       * NOT exempted by `skipExitCheck`: an operator close must go through the
       * same resolution, never around it.
       */
      if (active) {
        const resolution = await resolveUnresolvedStrategySells(
          active.id, async () => strategyMarketAdapter(client));
        if (resolution.blocked) {
          throw new Error(
            `${symbol}: a prior strategy SELL has unresolved exchange state — ${resolution.reason}`
          );
        }
        if (resolution.reconciled > 0) {
          // The recovered fill has already moved the ledger. Re-read before
          // sizing anything, so this close cannot be sized off a stale quantity.
          const refreshed = await prisma.smartTrade.findUnique({ where: { id: active.id } });
          if (!refreshed || refreshed.status !== "active") {
            await prisma.webhookLog.update({ where: { id: log.id }, data: { status: "ok" } });
            return {
              status: "ignored_duplicate",
              detail: `${symbol}: the prior SELL was already filled at the exchange and has now ` +
                "been reconciled; it closed this position. No second order was placed.",
            };
          }
          active = refreshed;
        }
      }

      /*
       * BOT-P1-5: the same admission gate, for the exits that reserve a durable
       * `ExchangeOrderAttempt` and no `StrategyOrderIntent` — TP, SL and the
       * dashboard partial close. Before this, a crash between one of those
       * exchange submissions and its local settlement left an order that may
       * already be live at Binance completely invisible here: the in-process
       * close lock is gone after a restart and this path reasons about intents,
       * so a webhook or dashboard Close could send a second, overlapping SELL.
       *
       * Deliberately NOT exempted by `skipExitCheck`, for the same reason the
       * intent resolution above is not: an operator close must go through the
       * resolution, never around it.
       */
      if (active) {
        const attemptResolution = await resolveUnresolvedExitAttempts(
          active.id, exitAttemptProbe(client, config.dryRun));
        if (attemptResolution.blocked) {
          throw new Error(
            `${symbol}: a prior exit order has unresolved exchange state — ${attemptResolution.reason}`
          );
        }
        if (attemptResolution.reconciled > 0) {
          const refreshed = await prisma.smartTrade.findUnique({ where: { id: active.id } });
          if (!refreshed || refreshed.status !== "active") {
            await prisma.webhookLog.update({ where: { id: log.id }, data: { status: "ok" } });
            return {
              status: "ignored_duplicate",
              detail: `${symbol}: a prior TP/SL/partial exit was already filled at the exchange ` +
                "and has now been reconciled; it closed this position. No second order was placed.",
            };
          }
          active = refreshed;
        }
      }

      let qty = body.quantity;
      if (partialPct != null) {
        if (!active) throw new Error(`No active SmartTrade for ${symbol}`);
        // Sized off the position as it stands NOW, after any prior unresolved
        // SELL was reconciled — never off the quantity read before that.
        qty = active.quantity * partialPct / 100;
      }
      // Treat 0 the same as null/undefined — indicator sends 0.000000 to mean "auto-detect"
      if (qty == null || qty <= 0) {
        qty = active?.quantity ?? (await getBaseFreeBalance(client, symbol));
      }
      // A webhook sell may reduce the tracked position, never unrelated wallet holdings.
      if (active) qty = Math.min(qty, active.quantity);
      if (!qty || qty <= 0) throw new Error("No quantity to sell");

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
        // Evidence only. Nothing reads this back to decide whether to exit.
        shariahContext: shariahEvidence,
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
