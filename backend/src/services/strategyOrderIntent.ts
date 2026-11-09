import { Prisma, type SignalBot, type StrategyOrderIntent } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import type { OrderProbe, OrderResult, BinanceClient } from "./binance.js";
import {
  classifyExchangeFailure, clientFromAccount, clientFromEnv, describeUncertainFailure, marketBuyQuote,
  marketSellBase, probeOrderByClientId, queryFilledMarketOrder,
} from "./binance.js";
import { calcFinalClosePnl, calcRealizedPnl } from "./smartTrade.js";
import {
  clearanceForFirstSubmission, clearanceForPersistedEntry, shariahScopeForBot,
} from "./shariah.js";
import { persistStrategyRealization } from "./realizationEvents.js";
import { executionEnvironmentForBot } from "./executionEnvironment.js";
import {
  evaluateBotRisk, getBotRiskLimits, readBotRiskSnapshot, setBotTradingHalted,
  shouldLatchHalt,
} from "./riskControls.js";

const UNRESOLVED_STATUSES = ["requested", "submitted"];

/**
 * Consecutive cycles an attempted BUY's exchange state could not be read
 * before the operator is alerted (bounded, as `UNMONITORED_ALERT_CYCLES`).
 */
export const STRATEGY_LOOKUP_ALERT_CYCLES = 3;
const strategyLookupFailures = new Map<string, number>();

export interface StrategyIntentReservation {
  sourceKey: string;
  webhookLogId?: string;
  bot: SignalBot;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  requestedBaseQty?: number;
  requestedQuoteQty?: number;
  sellPercent?: number;
  exitLeg?: string;
  platformDeploymentId?: string;
  platformOrderIntentId?: string;
  platformDedupeKey?: string;
  platformWebhookIdentity?: string;
  skipExitCheck?: boolean;
  smartTradeId?: string;
  /**
   * The exact authenticated Shariah decision this order was admitted under, as
   * the shared contract serialises it. Null means none was attached, which is
   * how every pre-Shariah intent reads.
   */
  shariahContext?: string | null;
  /**
   * The at-rest identity of the single-use Platform authorisation this entry is
   * spending, from `admitSpotEntry`. Writing it IS the claim: the column is
   * unique, so the first intent to reach the database owns the authorisation
   * and every later one is refused.
   *
   * Null for a SELL, for the manual channel, and for anything admitted while
   * enforcement is off — none of those spend an authorisation, and nulls do not
   * collide.
   */
  authorizationNonceHash?: string | null;
}

/**
 * A durable authorisation was presented twice.
 *
 * Deliberately a plain error class in this module rather than a Shariah one:
 * what the database refused is the reuse of a single-use authorisation
 * identity, which is an admission-boundary fact. The webhook path translates it
 * into the Shariah vocabulary its caller understands, because that path is the
 * only one that mints these today.
 */
export class AuthorizationNonceReplayError extends Error {
  constructor(readonly symbol: string) {
    super(
      `${symbol}: the single-use authorisation for this order has already been claimed ` +
      "by an earlier intent"
    );
    this.name = "AuthorizationNonceReplayError";
  }
}

export interface StrategyMarketAdapter {
  submit(intent: StrategyOrderIntent): Promise<OrderResult>;
  query(intent: StrategyOrderIntent): Promise<OrderResult | null>;
  /**
   * The same lookup as `query`, but reporting WHY there is no usable fill.
   *
   * BOT-P1-2: `query` answers `null` for "the exchange never heard of this
   * order" and for "the lookup failed" alike, and no amount of retrying can
   * turn the first into a resolution. Optional so an existing adapter keeps
   * working — one that cannot probe is treated as no evidence, which is the
   * fail-safe reading.
   */
  probe?(intent: StrategyOrderIntent): Promise<OrderProbe>;
}

export type StrategyAdapterFactory =
  (intent: StrategyOrderIntent) => Promise<StrategyMarketAdapter>;

export interface StrategyCrashHooks {
  afterIntentPersisted?(intent: StrategyOrderIntent): Promise<void> | void;
  afterSubmissionMarked?(intent: StrategyOrderIntent): Promise<void> | void;
  afterExchangeResult?(intent: StrategyOrderIntent, result: OrderResult): Promise<void> | void;
}

export interface StrategyExecutionOutcome {
  intent: StrategyOrderIntent;
  result?: OrderResult;
  pending: boolean;
  appliedNow: boolean;
  shortfall?: string;
}

function sameNumber(left: number | null, right: number | undefined): boolean {
  return left == null && right == null ||
    left != null && right != null && Math.abs(left - right) <= 1e-8;
}

function assertReservationMatches(
  existing: StrategyOrderIntent,
  input: StrategyIntentReservation
): void {
  const matches = existing.sourceKey === input.sourceKey &&
    existing.botId === input.bot.id && existing.clientOrderId === input.clientOrderId &&
    existing.symbol === input.symbol && existing.side === input.side &&
    sameNumber(existing.requestedBaseQty, input.requestedBaseQty) &&
    sameNumber(existing.requestedQuoteQty, input.requestedQuoteQty) &&
    sameNumber(existing.sellPercent, input.sellPercent) &&
    existing.skipExitCheck === (input.skipExitCheck ?? false) &&
    existing.smartTradeId === (input.smartTradeId ?? null) &&
    existing.platformDeploymentId === (input.platformDeploymentId ?? null) &&
    existing.platformOrderIntentId === (input.platformOrderIntentId ?? null) &&
    existing.platformDedupeKey === (input.platformDedupeKey ?? null) &&
    existing.platformWebhookIdentity === (input.platformWebhookIdentity ?? null);
  if (!matches) {
    throw new Error(
      `Durable strategy intent conflict for ${input.clientOrderId}; ` +
      "existing monetary identity does not match this webhook"
    );
  }
}

/** Reserve one logical strategy order before an exchange call can be attempted. */
export async function reserveStrategyIntent(
  input: StrategyIntentReservation,
  hooks: StrategyCrashHooks = {}
): Promise<StrategyOrderIntent> {
  let intent: StrategyOrderIntent;
  try {
    intent = await prisma.strategyOrderIntent.create({ data: {
      sourceKey: input.sourceKey,
      webhookLogId: input.webhookLogId,
      botId: input.bot.id,
      botName: input.bot.name,
      exchangeAccountId: input.bot.exchangeAccountId,
      clientOrderId: input.clientOrderId,
      symbol: input.symbol,
      side: input.side,
      orderType: "MARKET",
      requestedBaseQty: input.requestedBaseQty,
      requestedQuoteQty: input.requestedQuoteQty,
      sellPercent: input.sellPercent,
      exitLeg: input.exitLeg,
      platformDeploymentId: input.platformDeploymentId,
      platformOrderIntentId: input.platformOrderIntentId,
      platformDedupeKey: input.platformDedupeKey,
      platformWebhookIdentity: input.platformWebhookIdentity,
      skipExitCheck: input.skipExitCheck ?? false,
      smartTradeId: input.smartTradeId,
      shariahContext: input.shariahContext ?? null,
      authorizationNonceHash: input.authorizationNonceHash ?? null,
      // OD-5: recorded once, from the inputs that choose the endpoint.
      executionEnvironment: await executionEnvironmentForBot(input.bot),
    }});
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const existing = await prisma.strategyOrderIntent.findFirst({ where: {
      OR: [{ sourceKey: input.sourceKey }, { clientOrderId: input.clientOrderId }],
    }});
    /*
     * The order of these two branches is the whole recovery/replay distinction.
     *
     * A row matching `sourceKey` or `clientOrderId` means THIS logical order is
     * already on file: a retry, a reconnect, a reconciliation sweep. That is
     * recovery, it returns the existing intent, and it does NOT re-claim the
     * authorisation — the row it just found is the claim. This is why a
     * legitimate delivery retry inside the freshness window still works, and
     * why an already-admitted intent never needs a second nonce.
     *
     * No such row, but the authorisation is already spent, means a DIFFERENT
     * order is presenting an authorisation that has been used. That is the
     * replay: a fresh `dedupe_key` produced a fresh `sourceKey` and a fresh
     * `clientOrderId`, so every ordinary idempotency control saw a new order —
     * and the unique index is what saw through it.
     */
    if (!existing) {
      if (input.authorizationNonceHash) {
        const claimed = await prisma.strategyOrderIntent.findUnique({
          where: { authorizationNonceHash: input.authorizationNonceHash },
          select: { id: true },
        });
        if (claimed) throw new AuthorizationNonceReplayError(input.symbol);
      }
      throw error;
    }
    assertReservationMatches(existing, input);
    intent = existing;
  }
  await hooks.afterIntentPersisted?.(intent);
  return intent;
}

export async function hasUnresolvedStrategySell(smartTradeId: string): Promise<boolean> {
  return (await prisma.strategyOrderIntent.count({ where: {
    smartTradeId, side: "SELL", status: { in: UNRESOLVED_STATUSES },
  }})) > 0;
}

/**
 * How long a `submitted` intent must have been submitted before the exchange
 * answering "no such order" is accepted as proof that none was ever placed.
 *
 * The one way `-2013` can lie is the moment between our request leaving and the
 * order being registered, and that window is bounded by the HTTP call itself.
 * Below the threshold the answer is reported as the not-yet-settled state it
 * is; it is never used to license a replacement sell. A `requested` intent
 * needs no such wait — the compare-and-set to `submitted` happens BEFORE the
 * wire call, so a row still saying `requested` provably never crossed it.
 */
export const SUBMITTED_ABSENCE_SETTLE_MS = 60_000;

/**
 * How old a never-submitted BUY may be before the reconciler stops trying to
 * place it, and closes it off as a stale signal instead.
 *
 * BOT-P1-3: `reconcilePendingStrategyIntents` selects every `requested` and
 * `submitted` intent with no age predicate, and runs every 30 seconds. An
 * entry blocked at creation — the operator paused the bot or turned
 * `entryEnabled` off in that window, the halt latched, or the process was
 * killed between `create` and the requested->submitted compare-and-set — sits
 * `requested` for as long as the block lasts. When it clears, hours or days
 * later, the sweep places the ORIGINAL MARKET BUY at the then-current price,
 * within 30 seconds and with no operator-visible warning that an old order was
 * queued. Nothing else bounds this: the `WebhookReceipt` dedupe TTL is 120
 * seconds and long gone, `clearanceForFirstSubmission` decides who may buy and
 * never when, and `SUBMITTED_ABSENCE_SETTLE_MS` bounds only the ABSENCE
 * interpretation of an already-submitted order.
 *
 * Fifteen minutes is chosen as comfortably longer than every legitimate delay
 * — a process restart and its boot reconciliation, a database reconnect, a
 * transient block an operator clears at once — and far shorter than the
 * horizon over which a MARKET entry price still has anything to do with the
 * signal that asked for it. An entry signal older than this is stale on any
 * reading, and re-deciding it is the strategy's job, not the reconciler's.
 *
 * BUY ONLY. An interrupted exit must always be able to complete, at any age:
 * refusing a SELL because it is old traps the position it was meant to close.
 */
export const REQUESTED_INTENT_MAX_AGE_MS = 15 * 60_000;

export interface UnresolvedSellResolution {
  /** True when a prior SELL still holds unknown or live exchange state. */
  blocked: boolean;
  reason?: string;
  /** Intents this call reconciled from an authoritative exchange fill. */
  reconciled: number;
  /** Intents this call proved never reached the exchange, and closed off. */
  discarded: number;
}

/**
 * Resolve every unresolved SELL intent on one trade against current exchange
 * evidence — the repair for BOT-P1-2.
 *
 * The guard this serves is correct in intent: never place a second exit while
 * a first one's fate is unknown. What it lacked was any way to LEARN that fate,
 * so a SELL intent left `submitted` by a crash between the compare-and-set and
 * the HTTP request wedged both full-close paths for that trade permanently, and
 * `skipExitCheck` — the dashboard Close button — did not exempt it. The
 * documented remedy was editing the database by hand.
 *
 * This asks the exchange first and acts only on what it answers:
 *
 *   filled  → reconcile it through the ordinary authoritative path. The exit
 *             already happened; no duplicate SELL is placed, and the local
 *             ledger catches up exactly once.
 *   open    → still live. Stay blocked, and say so: a replacement here is how
 *             a position gets sold twice.
 *   absent  → the exchange has no such order. `requested` proves it never
 *             crossed the submission boundary; `submitted` needs the settle
 *             window above. Then, and only then, the intent is closed off as
 *             `rejected` and a new close may proceed.
 *   dead    → terminal at the exchange and moved no base asset. Same treatment
 *             as absent: resolved, and it changed nothing.
 *   unknown → no evidence. Stay blocked with the truthful reason.
 *
 * Every transition is a compare-and-set on the status this call observed, so a
 * concurrent reconciliation that moves the row first always wins and this call
 * reports blocked rather than overwriting it.
 */
export async function resolveUnresolvedStrategySells(
  smartTradeId: string,
  adapterFactory: StrategyAdapterFactory = defaultAdapterFactory,
  now: number = Date.now()
): Promise<UnresolvedSellResolution> {
  const intents = await prisma.strategyOrderIntent.findMany({
    where: { smartTradeId, side: "SELL", status: { in: UNRESOLVED_STATUSES } },
    orderBy: { createdAt: "asc" },
  });
  const outcome: UnresolvedSellResolution = { blocked: false, reconciled: 0, discarded: 0 };
  const reasons: string[] = [];
  for (const intent of intents) {
    const reason = await resolveOneUnresolvedSell(intent, adapterFactory, now, outcome);
    if (reason) reasons.push(reason);
  }
  if (reasons.length > 0) {
    outcome.blocked = true;
    outcome.reason = reasons.join("; ");
  }
  return outcome;
}

async function closeOffUnresolvedIntent(
  intent: StrategyOrderIntent,
  exchangeStatus: string,
  error: string
): Promise<boolean> {
  const closed = await prisma.strategyOrderIntent.updateMany({
    // The observed status, not merely "unresolved": if a concurrent submission
    // moved this row from `requested` to `submitted` since the probe, that
    // submission owns it and this call must not overwrite its outcome.
    where: { id: intent.id, status: intent.status },
    data: { status: "rejected", exchangeStatus, error, reconciledAt: new Date() },
  });
  return closed.count === 1;
}

async function resolveOneUnresolvedSell(
  intent: StrategyOrderIntent,
  adapterFactory: StrategyAdapterFactory,
  now: number,
  outcome: UnresolvedSellResolution
): Promise<string | null> {
  const label = `a prior SELL (${intent.clientOrderId})`;
  let probe: OrderProbe;
  try {
    const adapter = await adapterFactory(intent);
    probe = adapter.probe
      ? await adapter.probe(intent)
      : { state: "unknown", reason: "this adapter cannot query the exchange" };
  } catch (error) {
    return `${label} could not be checked at the exchange (${
      error instanceof Error ? error.message : "lookup failed"})`;
  }

  if (probe.state === "filled") {
    // The ordinary authoritative path, so the recovered fill closes or reduces
    // the position through exactly the same accounting — and exactly once.
    try {
      await applyAuthoritativeResult(intent.id, probe.result);
    } catch (error) {
      // The fill is real but could not be booked (a ledger conflict, say). The
      // intent is therefore still unresolved, and the only safe answer is to
      // stay blocked and say what happened — never to place another exit.
      return `${label} filled at the exchange but could not be reconciled (${
        error instanceof Error ? error.message : "reconciliation failed"})`;
    }
    outcome.reconciled += 1;
    return null;
  }
  if (probe.state === "open") {
    return `${label} is still live at the exchange (${probe.exchangeStatus}); ` +
      "it must settle before another close";
  }
  if (probe.state === "unknown") {
    return `${label} has unknown exchange state (${probe.reason})`;
  }

  if (intent.status === "submitted" && probe.state === "absent") {
    const submittedAt = (intent.submittedAt ?? intent.createdAt).getTime();
    if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) {
      await prisma.strategyOrderIntent.updateMany({
        where: { id: intent.id, status: "submitted" },
        data: { exchangeStatus: "ABSENT" },
      });
      return `${label} was submitted moments ago and the exchange has no record of it yet; ` +
        "retry once it settles";
    }
  }

  const closed = probe.state === "absent"
    ? await closeOffUnresolvedIntent(intent, "ABSENT",
      intent.status === "requested"
        ? "Never reached the exchange: the intent was still `requested`, so no order was sent"
        : "The exchange has no order under this client order id; no exit was placed")
    : await closeOffUnresolvedIntent(intent, probe.exchangeStatus,
      `The exchange order ended ${probe.exchangeStatus} with no fill; no exit was placed`);
  if (!closed) {
    return `${label} changed state while it was being resolved; retry`;
  }
  outcome.discarded += 1;
  return null;
}

function resultFromIntent(intent: StrategyOrderIntent): OrderResult | undefined {
  if (!intent.exchangeOrderId || intent.averageFillPrice == null) return undefined;
  return {
    orderId: intent.exchangeOrderId,
    executedQty: intent.filledBaseQty,
    cummulativeQuoteQty: intent.filledQuoteQty,
    avgPrice: intent.averageFillPrice,
    simulated: intent.simulated,
  };
}

async function linkExistingBuy(intent: StrategyOrderIntent): Promise<StrategyOrderIntent | null> {
  if (intent.side !== "BUY") return null;
  const trade = await prisma.smartTrade.findUnique({ where: { clientOrderId: intent.clientOrderId } });
  if (!trade) return null;
  return prisma.strategyOrderIntent.update({ where: { id: intent.id }, data: {
    smartTradeId: trade.id,
    status: "reconciled",
    exchangeOrderId: trade.exchangeOrderId,
    exchangeStatus: "FILLED",
    filledBaseQty: trade.quantity,
    filledQuoteQty: trade.quoteSpent,
    averageFillPrice: trade.entryPrice,
    reconciledAt: new Date(),
    error: null,
  }});
}

async function applyAuthoritativeResult(
  intentId: string,
  result: OrderResult
): Promise<StrategyExecutionOutcome> {
  return prisma.$transaction(async (tx) => {
    const intent = await tx.strategyOrderIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new Error("Durable strategy intent disappeared during reconciliation");
    if (intent.status === "reconciled") {
      return { intent, result: resultFromIntent(intent), pending: false, appliedNow: false };
    }
    if (intent.status === "rejected") {
      throw new Error(intent.error ?? "Strategy order was authoritatively rejected");
    }

    const resultData = {
      exchangeOrderId: result.orderId,
      exchangeStatus: "FILLED",
      filledBaseQty: result.executedQty,
      filledQuoteQty: result.cummulativeQuoteQty,
      averageFillPrice: result.avgPrice,
      simulated: result.simulated,
    };
    let smartTradeId = intent.smartTradeId;
    let shortfall: string | undefined;

    if (intent.side === "BUY") {
      const existing = await tx.smartTrade.findUnique({
        where: { clientOrderId: intent.clientOrderId },
      });
      if (existing) {
        smartTradeId = existing.id;
      } else {
        const trade = await tx.smartTrade.create({ data: {
          botId: intent.botId,
          botName: intent.botName,
          pair: intent.symbol,
          direction: "long",
          status: "active",
          entryPrice: result.avgPrice,
          buyPrice: result.avgPrice,
          currentPrice: result.avgPrice,
          quantity: result.executedQty,
          quoteSpent: result.cummulativeQuoteQty,
          exchangeOrderId: result.orderId,
          clientOrderId: intent.clientOrderId,
        }});
        smartTradeId = trade.id;
      }
    } else {
      if (!smartTradeId) throw new Error("Recovered strategy SELL has no linked SmartTrade");
      const trade = await tx.smartTrade.findUnique({ where: { id: smartTradeId } });
      if (!trade) throw new Error("Recovered strategy SELL references a missing SmartTrade");

      if (intent.sellPercent != null) {
        const applied = await tx.partialClose.findUnique({
          where: { strategyIntentId: intent.id },
        });
        if (!applied) {
          if (trade.status !== "active") {
            throw new Error("Recovered partial SELL conflicts with a SmartTrade that is no longer active");
          }
          const soldQty = Math.min(result.executedQty, trade.quantity);
          const proportionalCost = trade.quantity > 0
            ? trade.quoteSpent * (soldQty / trade.quantity) : 0;
          const { pnlUsdt } = calcRealizedPnl(result.cummulativeQuoteQty, proportionalCost);
          const realizedAt = new Date();
          const partial = await tx.partialClose.create({ data: {
            tradeId: trade.id,
            pct: intent.sellPercent,
            quantity: soldQty,
            revenue: result.cummulativeQuoteQty,
            pnlUsdt,
            avgPrice: result.avgPrice,
            exchangeOrderId: result.orderId,
            strategyIntentId: intent.id,
            createdAt: realizedAt,
          }});
          await tx.smartTrade.update({ where: { id: trade.id }, data: {
            quantity: Math.max(0, trade.quantity - soldQty),
            quoteSpent: Math.max(0, trade.quoteSpent - proportionalCost),
            currentPrice: result.avgPrice,
          }});
          await persistStrategyRealization(tx, {
            intent, kind: "partial", sourceId: partial.id, realizedAt,
            realizedPnlQuote: pnlUsdt, realizedQuantity: soldQty,
            exitPrice: result.avgPrice, exitRevenueQuote: result.cummulativeQuoteQty,
            exchangeOrderId: result.orderId, simulated: result.simulated,
          });
        }
      } else if (trade.status === "active") {
        const covered = result.executedQty >= trade.quantity * 0.999;
        if (!covered) {
          const remaining = Math.max(0, trade.quantity - result.executedQty);
          await tx.smartTrade.update({ where: { id: trade.id }, data: {
            quantity: remaining,
            quoteSpent: Math.max(0, trade.quoteSpent * (remaining / trade.quantity)),
            currentPrice: result.avgPrice,
          }});
          shortfall = `${intent.symbol}: the close filled ${result.executedQty} of ` +
            `${trade.quantity} base units. The trade remains OPEN with ${remaining} outstanding`;
        } else {
          const partials = await tx.partialClose.findMany({ where: { tradeId: trade.id } });
          const { pnlUsdt, pnlPct, finalLegPnlUsdt } = calcFinalClosePnl(
            result.cummulativeQuoteQty, trade.quoteSpent, partials);
          const realizedAt = new Date();
          await tx.smartTrade.update({ where: { id: trade.id }, data: {
            status: "closed",
            closedAt: realizedAt,
            closedReason: "signal_exit",
            currentPrice: result.avgPrice,
            pnlUsdt,
            pnlPct,
          }});
          await tx.pairCloseMark.upsert({
            where: { botId_pair: { botId: intent.botId, pair: intent.symbol } },
            create: { botId: intent.botId, pair: intent.symbol, closedAt: new Date() },
            update: { closedAt: new Date() },
          });
          await persistStrategyRealization(tx, {
            intent, kind: "final", sourceId: intent.id, realizedAt,
            realizedPnlQuote: finalLegPnlUsdt,
            realizedQuantity: result.executedQty,
            exitPrice: result.avgPrice, exitRevenueQuote: result.cummulativeQuoteQty,
            exchangeOrderId: result.orderId, simulated: result.simulated,
          });
        }
      }
    }

    const reconciled = await tx.strategyOrderIntent.update({ where: { id: intent.id }, data: {
      ...resultData,
      smartTradeId,
      status: "reconciled",
      reconciledAt: new Date(),
      error: shortfall ?? null,
    }});
    return { intent: reconciled, result, pending: false, appliedNow: true, shortfall };
  });
}

async function assertNeverAttemptedMaySubmit(intent: StrategyOrderIntent): Promise<void> {
  /*
   * BOT-P1-3: an entry that never crossed the wire expires; an exit never
   * does. Rejecting is safe by construction here and nowhere else — a row
   * still saying `requested` provably never reached the exchange, which is the
   * same invariant `SUBMITTED_ABSENCE_SETTLE_MS` and the ABSENT close-off both
   * already rely on — so nothing is being abandoned at Binance, and this is a
   * terminal answer rather than another 30-second retry.
   */
  const ageMs = Date.now() - intent.createdAt.getTime();
  if (intent.side === "BUY" && ageMs > REQUESTED_INTENT_MAX_AGE_MS) {
    const reason =
      `Stale entry signal: this BUY was still \`requested\` after ${Math.round(ageMs / 60_000)} ` +
      `minutes (maximum ${REQUESTED_INTENT_MAX_AGE_MS / 60_000}), so it never reached the ` +
      "exchange and will not be placed now at an unrelated price";
    await closeOffUnresolvedIntent(intent, "ABSENT", reason);
    throw new Error(reason);
  }

  const bot = await prisma.signalBot.findUnique({ where: { id: intent.botId } });
  if (!bot || bot.status !== "active") throw new Error("Strategy bot is not active");
  if (intent.side === "BUY" && !bot.entryEnabled) throw new Error("Entry orders disabled on this bot");
  if (intent.side === "SELL" && !intent.skipExitCheck && !bot.exitEnabled) {
    throw new Error("Exit orders disabled on this bot");
  }

  /*
   * Re-prove the ORIGINAL authenticated Shariah decision before this intent may
   * claim the submission boundary.
   *
   * It is deliberately here rather than at the adapter: a throw at this point
   * leaves the intent in `requested`, which is provably abandonable and still
   * retryable. Throwing after the compare-and-set would strand it in
   * `submitted`, where no resubmission is ever permitted.
   *
   * It re-reads the stored decision and never fetches a fresher status. A retry
   * that has not reached the wire must still satisfy the gate it was admitted
   * under; it must not be re-judged against a status that changed since.
   *
   * SELL is absent on purpose. An exit is never gated here, so a status that
   * moved to REVIEW or EXCLUDED after entry cannot trap a position.
   */
  if (intent.side === "BUY") {
    /*
     * Measured against the mode in force NOW, not only against the stored
     * decision. This intent has not reached the wire — `submitted` would mean
     * it had — so placing it is creating exposure, and creating exposure while
     * this installation enforces requires a decision. An intent that carries
     * one keeps it and is still never re-judged; an intent that carries none
     * was admitted while nothing was enforcing and may not proceed now.
     */
    await clearanceForFirstSubmission({
      scope: shariahScopeForBot(bot.id),
      symbol: intent.symbol,
      persisted: intent.shariahContext,
    });

    const [activeCount, pairCount] = await Promise.all([
      prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }),
      prisma.smartTrade.count({ where: { botId: bot.id, pair: intent.symbol, status: "active" } }),
    ]);
    if (bot.maxActiveSmartTradesEnabled && bot.maxActiveSmartTrades != null &&
        activeCount >= bot.maxActiveSmartTrades) {
      throw new Error(`Max active SmartTrades reached (${activeCount}/${bot.maxActiveSmartTrades})`);
    }
    if (bot.maxEntryOrders != null && pairCount >= bot.maxEntryOrders) {
      throw new Error(`Max entry orders for ${intent.symbol} reached`);
    }
    /*
     * D2: no second exposure while an earlier BUY for this bot and pair has an
     * unresolved exchange outcome. "Earlier" is an attempted (`submitted`)
     * intent, or an older never-attempted one — so two crash-orphaned
     * `requested` intents cannot block each other: the oldest goes first.
     */
    const unresolved = await prisma.strategyOrderIntent.findFirst({ where: {
      id: { not: intent.id }, botId: bot.id, symbol: intent.symbol, side: "BUY",
      OR: [{ status: "submitted" }, { status: "requested", createdAt: { lt: intent.createdAt } }],
    }, select: { clientOrderId: true } });
    if (unresolved) {
      throw new Error(`An earlier BUY for ${intent.symbol} (${unresolved.clientOrderId}) has an ` +
        "unresolved exchange outcome; no second entry is placed until it is reconciled");
    }
  } else if (!intent.smartTradeId || !(await prisma.smartTrade.findFirst({ where: {
    id: intent.smartTradeId, status: "active",
  }}))) {
    throw new Error("Linked SmartTrade is no longer active");
  }

  const limits = await getBotRiskLimits();
  // This intent's own reserved exposure is already in the snapshot as an
  // unresolved BUY; `quoteQty` below adds it once, so it is excluded there.
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours,
    { excludeStrategyIntentId: intent.id });
  const decision = evaluateBotRisk(limits, snapshot, {
    // Exact: a side that is not literally SELL is judged as an entry.
    side: intent.side === "SELL" ? "sell" : "buy",
    quoteQty: intent.requestedQuoteQty ?? 0,
    // D-9: `skipExitCheck` is durable and only the authenticated dashboard
    // Close sets it, so it is a server-side record that an OPERATOR asked for
    // this exit — which the halt never refuses. Every other intent is a signal
    // and stays halted in both directions.
    origin: intent.skipExitCheck ? "operator" : "automation",
  });
  if (!decision.allowed) {
    const latch = shouldLatchHalt(decision);
    if (latch) await setBotTradingHalted(true, { reason: decision.reason, by: latch });
    throw new Error(decision.reason);
  }
}

async function clientForIntent(intent: StrategyOrderIntent): Promise<BinanceClient> {
  if (intent.exchangeAccountId) {
    const account = await prisma.exchangeAccount.findUnique({ where: { id: intent.exchangeAccountId } });
    if (!account) throw new Error("Strategy intent exchange account no longer exists");
    return clientFromAccount(account);
  }
  const client = clientFromEnv();
  if (!client) throw new Error("No Binance credentials available for strategy reconciliation");
  return client;
}

export function strategyMarketAdapter(
  client: BinanceClient,
  dryRun = config.dryRun
): StrategyMarketAdapter {
  return {
    submit: (intent) => intent.side === "BUY"
      ? marketBuyQuote(client, intent.symbol, intent.requestedQuoteQty ?? 0, {
        explicitClientOrderId: intent.clientOrderId, dryRun,
        // Derived from the durable decision, so a first submission and a
        // recovery resubmission are proved by exactly the same evidence.
        shariahClearance: clearanceForPersistedEntry(intent.shariahContext, intent.symbol),
      })
      : marketSellBase(client, intent.symbol, intent.requestedBaseQty ?? 0, {
        explicitClientOrderId: intent.clientOrderId, dryRun,
      }),
    query: (intent) => dryRun
      ? Promise.resolve(null)
      : queryFilledMarketOrder(
        client, intent.symbol, intent.side as "BUY" | "SELL", intent.clientOrderId),
    // In dry run there is no exchange to consult, so there is no evidence — not
    // evidence of absence. Anything else would let a simulated run authorise a
    // resolution it cannot possibly have proved.
    probe: (intent) => dryRun
      ? Promise.resolve<OrderProbe>({ state: "unknown", reason: "dry run: no exchange to consult" })
      : probeOrderByClientId(
        client, intent.symbol, intent.side as "BUY" | "SELL", intent.clientOrderId),
  };
}

const defaultAdapterFactory: StrategyAdapterFactory = async (intent) =>
  strategyMarketAdapter(await clientForIntent(intent));

/**
 * Advance one durable intent. Only a successful requested->submitted compare
 * and-set may call submit; every already-attempted state queries first.
 */
export async function reconcileStrategyIntent(
  intentId: string,
  adapter: StrategyMarketAdapter,
  options: {
    hooks?: StrategyCrashHooks; allowNeverAttempted?: boolean; now?: number;
    /**
     * F2: set by the synchronous webhook admission. A `requested` BUY whose
     * first-submit gate refuses it there provably never reached the wire, and
     * its sender is told "no" — so it is closed off `rejected` instead of
     * lingering (and blocking fresh entries) until it is 15 minutes stale. A
     * crash-orphaned `requested` row met by the background reconciler keeps
     * the existing behaviour: held, and still submittable once the gate clears.
     */
    rejectOnGateRefusal?: boolean;
  } = {}
): Promise<StrategyExecutionOutcome> {
  let intent = await prisma.strategyOrderIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new Error("Strategy intent not found");
  if (intent.status === "reconciled") {
    return { intent, result: resultFromIntent(intent), pending: false, appliedNow: false };
  }
  if (intent.status === "rejected") throw new Error(intent.error ?? "Strategy order was rejected");

  const linked = await linkExistingBuy(intent);
  if (linked) {
    return { intent: linked, result: resultFromIntent(linked), pending: false, appliedNow: false };
  }

  let result: OrderResult | null;
  let submittedHere = false;
  if (intent.status === "requested") {
    if (options.allowNeverAttempted === false) {
      return { intent, pending: true, appliedNow: false };
    }
    try {
      await assertNeverAttemptedMaySubmit(intent);
    } catch (error) {
      if (options.rejectOnGateRefusal && intent.side === "BUY") {
        // Compare-and-set on `requested`: nothing was sent, nothing is abandoned.
        await closeOffUnresolvedIntent(intent, "ABSENT", `Refused before submission: ${
          error instanceof Error ? error.message : "first-submit gate refused"}`);
      }
      throw error;
    }
    const claimed = await prisma.strategyOrderIntent.updateMany({
      where: { id: intent.id, status: "requested" },
      data: { status: "submitted", submittedAt: new Date(), error: null },
    });
    if (claimed.count === 1) {
      submittedHere = true;
      intent = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
      await options.hooks?.afterSubmissionMarked?.(intent);
    } else {
      intent = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    }
  }

  try {
    if (!submittedHere && intent.side === "BUY" && adapter.probe) {
      // D2: an already-attempted BUY is resolved query-first, never resubmitted.
      const resolved = await resolveAttemptedBuy(intent, adapter, options.now ?? Date.now());
      if (resolved.result) {
        await options.hooks?.afterExchangeResult?.(intent, resolved.result);
        return await applyAuthoritativeResult(intent.id, resolved.result);
      }
      return resolved.outcome;
    }
    result = submittedHere ? await adapter.submit(intent) : await adapter.query(intent);
    if (!result) {
      const pending = await prisma.strategyOrderIntent.update({ where: { id: intent.id }, data: {
        error: "Exchange order not found by deterministic client id; no resubmission will occur",
      }});
      return { intent: pending, pending: true, appliedNow: false };
    }
    await options.hooks?.afterExchangeResult?.(intent, result);
    return await applyAuthoritativeResult(intent.id, result);
  } catch (error) {
    /*
     * D2: only a DEFINITE rejection is terminal — a local refusal raised before
     * the wire (Shariah: the clearance assertion is the first statement in
     * `marketBuyQuote`; the minimum notional) or a whitelisted Binance code.
     * Anything else (-1006/-1007, 5xx, transport failures, unknown codes, a
     * crash after the exchange answered) may have executed: the intent stays
     * `submitted` with the reason recorded, and is resolved query-first.
     */
    const failure = classifyExchangeFailure(error);
    const rejected = failure.outcome === "rejected";
    await prisma.strategyOrderIntent.updateMany({
      where: { id: intent.id, status: { not: "reconciled" } },
      data: {
        status: rejected ? "rejected" : "submitted",
        error: rejected || !submittedHere
          ? (error instanceof Error ? error.message : "Strategy exchange outcome unknown")
          : describeUncertainFailure(failure),
        reconciledAt: rejected ? new Date() : null,
      },
    });
    throw error;
  }
}

/**
 * D2: resolve an attempted (`submitted`) BUY from what the exchange says about
 * its ORIGINAL client order id. Nothing here ever submits.
 *
 *   filled                  -> returned for the ordinary authoritative booking;
 *   terminal + partial fill -> the executed part is booked (real exposure);
 *   dead (no fill)          -> closed off `rejected` with that exchange status;
 *   absent                  -> the existing SELL rule (`resolveOneUnresolvedSell`):
 *                              pending inside SUBMITTED_ABSENCE_SETTLE_MS, then
 *                              closed off `rejected`/ABSENT;
 *   open                    -> pending;
 *   unknown / lookup failed -> pending, never closed; alert after N cycles.
 */
async function resolveAttemptedBuy(
  intent: StrategyOrderIntent,
  adapter: StrategyMarketAdapter,
  now: number
): Promise<{ result?: OrderResult; outcome: StrategyExecutionOutcome }> {
  let probe: OrderProbe;
  try {
    probe = await adapter.probe!(intent);
  } catch (error) {
    probe = { state: "unknown", reason: error instanceof Error ? error.message : "lookup failed" };
  }
  const pending = async (error: string, exchangeStatus?: string) => {
    const updated = await prisma.strategyOrderIntent.update({ where: { id: intent.id }, data: {
      error, ...(exchangeStatus ? { exchangeStatus } : {}) } });
    return { outcome: { intent: updated, pending: true, appliedNow: false } };
  };
  const closedOff = async (exchangeStatus: string, error: string) => {
    await closeOffUnresolvedIntent(intent, exchangeStatus, error);
    const updated = await prisma.strategyOrderIntent.findUniqueOrThrow({ where: { id: intent.id } });
    return { outcome: { intent: updated, pending: false, appliedNow: false } };
  };

  if (probe.state === "filled") {
    strategyLookupFailures.delete(intent.id);
    return { result: probe.result, outcome: { intent, pending: false, appliedNow: false } };
  }
  if (probe.state === "unknown" && probe.partialFill) {
    strategyLookupFailures.delete(intent.id);
    return { result: probe.partialFill, outcome: { intent, pending: false, appliedNow: false } };
  }
  if (probe.state === "unknown") {
    const count = (strategyLookupFailures.get(intent.id) ?? 0) + 1;
    strategyLookupFailures.set(intent.id, count);
    if (count === STRATEGY_LOOKUP_ALERT_CYCLES || count % (STRATEGY_LOOKUP_ALERT_CYCLES * 10) === 0) {
      console.error(`[strategy-reconcile] ALERT: BUY ${intent.symbol} intent ${intent.id} ` +
        `(${intent.clientOrderId}) has had no readable exchange state for ${count} consecutive ` +
        "cycles; it stays unresolved, and no new entry for this bot and pair is admitted meanwhile.");
    }
    return pending(`reconciliation pending: exchange state unknown (${count} consecutive ` +
      `cycle(s)): ${probe.reason}`);
  }
  strategyLookupFailures.delete(intent.id);
  if (probe.state === "open") {
    return pending(`still working at the exchange (${probe.exchangeStatus}); reconciliation pending`,
      probe.exchangeStatus);
  }
  if (probe.state === "dead") {
    return closedOff(probe.exchangeStatus,
      `The exchange order ended ${probe.exchangeStatus} with no fill; no position was opened`);
  }
  // absent
  const submittedAt = (intent.submittedAt ?? intent.createdAt).getTime();
  if (now - submittedAt < SUBMITTED_ABSENCE_SETTLE_MS) {
    return pending("the exchange has no record of this order yet; reconciliation pending", "ABSENT");
  }
  return closedOff("ABSENT", "The exchange has no order under this client order id " +
    `${SUBMITTED_ABSENCE_SETTLE_MS / 1000} s after an uncertain submission; no position was opened`);
}

/** Startup/periodic recovery. Attempted intents reconcile even while halted. */
export async function reconcilePendingStrategyIntents(
  adapterFactory: StrategyAdapterFactory = defaultAdapterFactory,
  limit = 100,
  /** Time seam for the absence rule; production passes nothing. */
  now: number = Date.now()
): Promise<void> {
  const intents = await prisma.strategyOrderIntent.findMany({
    where: { status: { in: UNRESOLVED_STATUSES } },
    orderBy: { createdAt: "asc" },
    take: Math.min(limit, 100),
  });
  for (const intent of intents) {
    try {
      await reconcileStrategyIntent(intent.id, await adapterFactory(intent), { now });
    } catch (error) {
      await prisma.strategyOrderIntent.updateMany({
        where: { id: intent.id, status: { not: "reconciled" } },
        data: { error: `reconciliation pending: ${
          error instanceof Error ? error.message : "unknown error"}` },
      });
    }
  }
}
