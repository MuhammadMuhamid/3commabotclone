import { Prisma, type SignalBot, type StrategyOrderIntent } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import type { OrderResult, BinanceClient } from "./binance.js";
import {
  clientFromAccount, clientFromEnv, ExchangeError, marketBuyQuote,
  marketSellBase, MinNotionalError, queryFilledMarketOrder,
} from "./binance.js";
import { calcFinalClosePnl, calcRealizedPnl } from "./smartTrade.js";
import {
  clearanceForFirstSubmission, clearanceForPersistedEntry, shariahScopeForBot,
  ShariahEnforcementError,
} from "./shariah.js";
import { persistStrategyRealization } from "./realizationEvents.js";
import {
  evaluateBotRisk, getBotRiskLimits, readBotRiskSnapshot, setBotTradingHalted,
  shouldLatchHalt,
} from "./riskControls.js";

const UNRESOLVED_STATUSES = ["requested", "submitted"];

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
}

export interface StrategyMarketAdapter {
  submit(intent: StrategyOrderIntent): Promise<OrderResult>;
  query(intent: StrategyOrderIntent): Promise<OrderResult | null>;
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
    }});
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const existing = await prisma.strategyOrderIntent.findFirst({ where: {
      OR: [{ sourceKey: input.sourceKey }, { clientOrderId: input.clientOrderId }],
    }});
    if (!existing) throw error;
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
  } else if (!intent.smartTradeId || !(await prisma.smartTrade.findFirst({ where: {
    id: intent.smartTradeId, status: "active",
  }}))) {
    throw new Error("Linked SmartTrade is no longer active");
  }

  const limits = await getBotRiskLimits();
  const snapshot = await readBotRiskSnapshot(limits.dailyLossWindowHours);
  const decision = evaluateBotRisk(limits, snapshot, {
    side: intent.side === "BUY" ? "buy" : "sell",
    quoteQty: intent.requestedQuoteQty ?? 0,
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
  options: { hooks?: StrategyCrashHooks; allowNeverAttempted?: boolean } = {}
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
    await assertNeverAttemptedMaySubmit(intent);
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
     * A Shariah refusal is a rejection, not an ambiguous outcome. The clearance
     * assertion is the first statement in `marketBuyQuote` and precedes the
     * exchange call in the manual LIMIT path, so nothing was ever sent. Without
     * this the intent would be marked `submitted` — a state that may only ever
     * be queried — and would sit unresolved forever against an order that does
     * not exist.
     */
    const rejected = error instanceof MinNotionalError ||
      error instanceof ShariahEnforcementError ||
      (error instanceof ExchangeError && error.code !== undefined);
    await prisma.strategyOrderIntent.updateMany({
      where: { id: intent.id, status: { not: "reconciled" } },
      data: {
        status: rejected ? "rejected" : "submitted",
        error: error instanceof Error ? error.message : "Strategy exchange outcome unknown",
        reconciledAt: rejected ? new Date() : null,
      },
    });
    throw error;
  }
}

/** Startup/periodic recovery. Attempted intents reconcile even while halted. */
export async function reconcilePendingStrategyIntents(
  adapterFactory: StrategyAdapterFactory = defaultAdapterFactory,
  limit = 100
): Promise<void> {
  const intents = await prisma.strategyOrderIntent.findMany({
    where: { status: { in: UNRESOLVED_STATUSES } },
    orderBy: { createdAt: "asc" },
    take: Math.min(limit, 100),
  });
  for (const intent of intents) {
    try {
      await reconcileStrategyIntent(intent.id, await adapterFactory(intent));
    } catch (error) {
      await prisma.strategyOrderIntent.updateMany({
        where: { id: intent.id, status: { not: "reconciled" } },
        data: { error: `reconciliation pending: ${
          error instanceof Error ? error.message : "unknown error"}` },
      });
    }
  }
}
