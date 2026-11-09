/**
 * The operator's exits for one STRATEGY trade: full Close and Partial close.
 *
 * Extracted from `routes/trades.ts` so the Bot's own dashboard and the
 * Platform's signed control routes (contract v1.2 C6/C7) run exactly the same
 * money path. Neither is re-implemented here:
 *
 *   - Close is `processWebhook(..., { skipExitCheck: true })` — the close lock,
 *     the 45 s exit receipt, resolution of any prior unresolved SELL intent and
 *     exit attempt, and the durable SELL intent all live there;
 *   - Partial is the locked attempt path it always was: lock held across
 *     read → resolve → sell → settle, `openOrderAttempt`,
 *     `markOrderAttemptSubmitted` before the wire, `marketSellBase`,
 *     `applyExitFill`.
 *
 * What is added is refusal only, each a typed `ControlRefusal`:
 *
 *   - a MANUAL position is Trading Scene's (U3): it is closed from the Trade
 *     panel's SELL, never through a strategy route;
 *   - Close refuses up front what `processWebhook` would refuse with an
 *     untyped error (paused bot, pair no longer listed) and what it cannot
 *     express (more than one active trade for the bot and pair), and passes
 *     `expectSmartTradeId` so a sibling opened in between is refused, not sold
 *     (F3);
 *   - Partial now also resolves prior unresolved strategy SELL intents before
 *     selling, as Close always did (F4, finding 0.8).
 *
 * An order that was submitted but whose outcome is unknown is reported as
 * `ControlPending` with the durable intent/attempt id, never as a success or a
 * failure.
 */
import type { ExchangeAccount, SignalBot, SmartTrade } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol } from "../lib/symbols.js";
import { acquireTradeClose, isTradeClosing, releaseTradeClose } from "../lib/tradeCloseLock.js";
import {
  classifyExchangeFailure, clientFromAccount, clientFromEnv, marketSellBase, MinNotionalError,
  resolveSellQuantity, type BinanceClient,
} from "./binance.js";
import { config } from "../config.js";
import { sendExecutionNotification } from "./push.js";
import { markOrderAttemptSubmitted, openOrderAttempt } from "./orderAttempt.js";
import { applyExitFill, exitAttemptProbe, resolveUnresolvedExitAttempts } from "./exitSettlement.js";
import {
  hasUnresolvedStrategySell, resolveUnresolvedStrategySells, strategyMarketAdapter,
} from "./strategyOrderIntent.js";
import { processWebhook } from "./webhook.js";
import { ControlPending, ControlRefusal } from "./controlCommands.js";

/**
 * How the exit paths obtain an exchange client.
 *
 * A mutable export in the same idiom as `checkTakeProfitStopLoss`'s
 * `resolveClient` option: an HTTP handler has nowhere to accept an injected
 * dependency. Production never reassigns it.
 *
 *   - `resolve` is the Partial path's resolution (unchanged from the route);
 *   - `closeFactory` is null in production, so Close keeps `processWebhook`'s
 *     own account resolution; tests set it to a fake exchange.
 */
export const tradeExchangeClient = {
  resolve(bot: { exchangeAccountId: string | null; exchangeAccount: ExchangeAccount | null }):
  BinanceClient | null {
    return bot.exchangeAccountId && bot.exchangeAccount
      ? clientFromAccount(bot.exchangeAccount)
      : clientFromEnv();
  },
  closeFactory: null as ((bot: SignalBot) => Promise<BinanceClient>) | null,
};

/** The shape the dashboard expects a trade in, after a close changed it. */
export function tradeWithDetail(tradeId: string) {
  return prisma.smartTrade.findUnique({
    where: { id: tradeId },
    include: {
      bot: { select: { id: true, name: true, exchangeAccount: { select: { name: true } } } },
      partialCloses: { orderBy: { createdAt: "asc" } },
    },
  });
}

const EXIT_UNRESOLVED_MESSAGE =
  "A prior exit for this trade has unresolved exchange state; it must be reconciled before " +
  "another exit. No order was placed.";

function assertActiveStrategyTrade<T extends SmartTrade & { bot: unknown }>(
  trade: T | null
): asserts trade is T & { bot: NonNullable<T["bot"]> } {
  if (!trade) throw new ControlRefusal(404, "trade_not_found", "Trade not found.");
  if (trade.status !== "active") {
    throw new ControlRefusal(409, "trade_not_active", "This trade is no longer active.");
  }
  // U3: never close a Trading Scene position through a strategy route, and
  // never advise selling outside the ledger.
  if (trade.source !== "strategy") {
    throw new ControlRefusal(409, "trade_manual",
      "This position was opened from Trading Scene. Close it from the Trading Scene Trade " +
      "panel (SELL) so its ledger and take-profit/stop-loss stay correct.");
  }
  if (!trade.bot) {
    throw new ControlRefusal(422, "bot_deleted",
      "This trade's bot was deleted, so it can no longer be closed here and has no " +
      "take-profit/stop-loss.");
  }
}

function listedPairs(bot: SignalBot): string[] {
  try {
    const parsed: unknown = JSON.parse(bot.pairs);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string").map(normalizeSymbol) : [];
  } catch {
    return [];
  }
}

export type CloseTradeResult = {
  status: "ok" | "ignored_duplicate";
  detail?: unknown;
};

/**
 * Observation hooks for a caller that must know which durable order record an
 * exit reserved BEFORE the order is sent (the control channel records it on
 * its command row, R1). They are awaited at that point and must not throw;
 * they never change what the exit does.
 */
export interface TradeExitObserver {
  onIntentReserved?(intentId: string): Promise<void> | void;
  onAttemptOpened?(attemptId: string): Promise<void> | void;
}

/** Close one strategy trade at market, on the operator's authority (C6). */
export async function closeStrategyTrade(
  tradeId: string, observer: TradeExitObserver = {}
): Promise<CloseTradeResult> {
  const trade = await prisma.smartTrade.findUnique({ where: { id: tradeId }, include: { bot: true } });
  assertActiveStrategyTrade(trade);
  const bot = trade.bot;
  // `processWebhook` refuses both of these with an untyped error; refusing
  // first with a code tells the operator why (findings 0.1, 0.2).
  if (bot.status !== "active") {
    throw new ControlRefusal(422, "bot_paused",
      "This trade's bot is paused, and a paused bot's trade cannot be closed here. " +
      "Start the bot, then close the trade.");
  }
  if (!listedPairs(bot).includes(normalizeSymbol(trade.pair))) {
    throw new ControlRefusal(422, "pair_not_listed",
      `${trade.pair} is no longer in this bot's pair list, so this trade cannot be closed here.`);
  }
  const activeSamePair = await prisma.smartTrade.count({
    where: { botId: bot.id, pair: trade.pair, status: "active" },
  });
  if (activeSamePair !== 1) {
    throw new ControlRefusal(422, "ambiguous_trade",
      `This bot has ${activeSamePair} active trades on ${trade.pair}; a Close here cannot target ` +
      "one of them. Nothing was sold.");
  }
  // BOT-005: informative only; `processWebhook` takes the lock itself.
  if (isTradeClosing(trade.id)) {
    throw new ControlRefusal(409, "trade_closing", "This trade is already being closed. Please wait.");
  }

  const seen: { intentId: string | null } = { intentId: null };
  let result: Awaited<ReturnType<typeof processWebhook>>;
  try {
    result = await processWebhook(
      { secret: bot.webhookSecret, action: "SELL", symbol: trade.pair, quantity: trade.quantity },
      {
        skipExitCheck: true,
        expectSmartTradeId: trade.id,
        clientFactory: tradeExchangeClient.closeFactory ?? undefined,
        // Observation only: records which durable SELL intent this close
        // reserved — before the requested->submitted claim and the wire call —
        // so an unknown outcome can be reported from that record.
        strategyCrashHooks: {
          afterIntentPersisted: async (intent) => {
            seen.intentId = intent.id;
            await observer.onIntentReserved?.(intent.id);
          },
        },
      }
    );
  } catch (error) {
    const intent = seen.intentId && !(error instanceof ControlRefusal)
      ? await prisma.strategyOrderIntent.findUnique({ where: { id: seen.intentId } })
      : null;
    if (intent?.status === "reconciled") {
      // The order executed and was booked; a later step failed (for example a
      // fill shortfall check). It is reported as executed, with a warning —
      // never as a failure, which would invite a second close.
      console.error(`[trade-exit] close of ${trade.id} executed, then failed`, error);
      return { status: "ok", detail: {
        intentId: intent.id, filledBaseQty: intent.filledBaseQty, filledQuoteQty: intent.filledQuoteQty,
        warning: "The close order executed, but a later check failed (for example a fill " +
          "shortfall). Review this trade before acting on it again.",
      } };
    }
    throw await classifyCloseFailure(error, trade.id, seen.intentId);
  }
  if (result.status === "ignored_duplicate") {
    /*
     * A2: nothing was sold. If the trade is still open, the 45 s exit receipt
     * for this bot and pair swallowed the close (a recent exit for the pair),
     * and reporting that as handled would over-promise: the position is open.
     * Only a trade that a reconciled prior exit actually closed is reported as
     * `ignored_duplicate`.
     */
    const now = await prisma.smartTrade.findUnique({ where: { id: trade.id }, select: { status: true } });
    if (now?.status === "active") {
      throw new ControlRefusal(409, "exit_recent",
        "A close for this trade was already sent in the last 45 seconds; no new order was placed. " +
        "Check the trade's current state.");
    }
    return { status: result.status, detail: result.detail };
  }
  if (result.status === "ok") {
    return { status: result.status, detail: result.detail };
  }
  // An operator SELL passes the halt and is never stale or Shariah-gated, so
  // nothing else is expected here; if it ever is, it was not executed.
  throw new ControlRefusal(409, "close_not_executed",
    `The close was not executed (${result.status}).`);
}

/**
 * Turn a failed Close into what actually happened, read from durable state —
 * never from the error's text.
 */
async function classifyCloseFailure(
  error: unknown, tradeId: string, intentId: string | null
): Promise<unknown> {
  if (error instanceof ControlRefusal) return error;
  if (intentId) {
    const intent = await prisma.strategyOrderIntent.findUnique({ where: { id: intentId } });
    if (intent?.status === "requested" || intent?.status === "submitted") {
      // `submitted` may be live at the exchange; `requested` is retried by the
      // intent reconciler. Either way the outcome is not known yet.
      return new ControlPending({ intentId },
        "The close order was reserved or submitted and its outcome is not yet known; " +
        "it is being reconciled.");
    }
    if (intent?.status === "rejected") {
      return new ControlRefusal(422, "exchange_rejected",
        "The exchange rejected this close; no order was executed.",
        error instanceof Error ? error.message : undefined);
    }
  }
  if (await hasUnresolvedStrategySell(tradeId) ||
      (await prisma.exchangeOrderAttempt.count({
        where: { smartTradeId: tradeId, side: "SELL", status: "open" } })) > 0) {
    return new ControlRefusal(409, "exit_unresolved", EXIT_UNRESOLVED_MESSAGE,
      error instanceof Error ? error.message : undefined);
  }
  if (isTradeClosing(tradeId)) {
    return new ControlRefusal(409, "trade_closing", "This trade is already being closed. Please wait.");
  }
  return error;
}

export type PartialCloseResult = {
  partial: unknown;
  trade: Awaited<ReturnType<typeof tradeWithDetail>>;
  requestedQty: number;
  executedQty: number;
  detail?: string;
};

/** Sell `pct` percent (1..99) of one strategy trade at market (C7). */
export async function partialCloseStrategyTrade(
  tradeId: string, pct: number, observer: TradeExitObserver = {}
): Promise<PartialCloseResult> {
  const trade = await prisma.smartTrade.findUnique({
    where: { id: tradeId },
    include: { bot: { include: { exchangeAccount: true } } },
  });
  assertActiveStrategyTrade(trade);
  /*
   * BOT-005: hold the lock across the whole read-sell-write sequence, not
   * just check it. This path reads the quantity, sells, then writes the
   * reduced quantity back — a TP/SL close landing in between would sell the
   * same base asset twice and, because a sell is capped against the shared
   * WALLET balance, could eat another bot's position in the same asset.
   */
  if (!acquireTradeClose(trade.id)) {
    throw new ControlRefusal(409, "trade_closing", "Trade is being closed. Please wait.");
  }
  try {
    /*
     * D-9: the halt does NOT refuse this. A scale-out is an operator, on an
     * authenticated route, reducing a position by hand — and an operator's
     * exit is never gated by the halt. The halt stops the AUTOMATION in both
     * directions (signals, the TP/SL monitors); the operator's own exits —
     * this path, Close and manual SELL — stay open. `evaluateBotRisk` is the
     * single statement of that rule.
     *
     * Everything that makes an exit SAFE still applies below: the close lock,
     * resolution of any unresolved prior exit, the 99% cap and the wallet cap.
     */
    const client = tradeExchangeClient.resolve(trade.bot);
    if (!client) {
      throw new ControlRefusal(422, "no_exchange_credentials", "No Binance credentials configured.");
    }

    /*
     * F4 / finding 0.8: a prior strategy SELL intent (a webhook exit or an
     * earlier Close) left `submitted` by a restart may already have sold this
     * position at Binance; the in-process lock does not survive a restart.
     * Resolve it first, with the same query-first authority Close uses, and
     * refuse while it is unresolved.
     */
    const intents = await resolveUnresolvedStrategySells(
      trade.id, async () => strategyMarketAdapter(client));
    if (intents.blocked) {
      throw new ControlRefusal(409, "exit_unresolved", EXIT_UNRESOLVED_MESSAGE, intents.reason);
    }

    /*
     * BOT-P1-5: a durable exit attempt left unresolved by a crash is the only
     * surviving evidence that a SELL may already be live at Binance. Resolving
     * it here, from current exchange evidence, is what stops this scale-out
     * landing on top of a TP, SL or earlier partial never settled locally.
     */
    const attempts = await resolveUnresolvedExitAttempts(
      trade.id, exitAttemptProbe(client, config.dryRun));
    if (attempts.blocked) {
      throw new ControlRefusal(409, "exit_unresolved", EXIT_UNRESOLVED_MESSAGE, attempts.reason);
    }
    // A recovered fill has already moved the ledger, so this exit has to be
    // sized off the position as it stands NOW, never off the stale read above.
    const current = intents.reconciled + attempts.reconciled > 0
      ? await prisma.smartTrade.findUnique({ where: { id: trade.id } })
      : trade;
    if (!current || current.status !== "active") {
      throw new ControlRefusal(409, "already_closed",
        "A prior exit was already filled at the exchange and has now been reconciled; " +
        "it closed this position. No second order was placed.");
    }

    const requestedQty = current.quantity * (pct / 100);
    const sellQty = await resolveSellQuantity(client, trade.pair, requestedQty);

    /*
     * BOT-P1-1: the durable attempt is the order's identity. A retry or crash
     * recovery of THIS exit finds the same open attempt and keeps its id; a
     * genuinely new exit can only be opened once this one has settled.
     */
    const attempt = await openOrderAttempt({
      intentKey: `partial:${trade.id}:${pct}`, symbol: trade.pair, side: "SELL",
      smartTradeId: trade.id, origin: "partial", sellPercent: pct,
      requestedBaseQty: sellQty, closedReason: "partial_close",
    });
    // Observation only, before anything is sent (R1).
    await observer.onAttemptOpened?.(attempt.id);
    // Before the wire call, never after: a null `submittedAt` is what proves to
    // a later recovery that no order was ever sent under this id.
    await markOrderAttemptSubmitted(attempt.id, sellQty);

    let orderResult: Awaited<ReturnType<typeof marketSellBase>>;
    try {
      orderResult = await marketSellBase(client, trade.pair, sellQty, {
        explicitClientOrderId: attempt.clientOrderId,
      });
    } catch (error) {
      // The shared D2 classifier decides: only a DEFINITE rejection (or a
      // pre-wire refusal such as minimum notional) placed nothing. A coded but
      // uncertain answer (-1006/-1007/5xx) or a transport failure is an order
      // of unknown outcome, reconciled by the attempt's client order id.
      if (classifyExchangeFailure(error).outcome === "rejected" || error instanceof MinNotionalError) {
        throw new ControlRefusal(422, "exchange_rejected",
          "The exchange rejected this partial close; no order was executed.",
          error instanceof Error ? error.message : String(error));
      }
      throw new ControlPending({ attemptId: attempt.id },
        "The partial-close order was submitted and its outcome is not yet known; " +
        "it is being reconciled.");
    }

    /*
     * BOT-P1-6: the ACTUAL executed quantity is the accounting authority.
     * `applyExitFill` is the single settlement authority shared with the TP/SL
     * monitor and restart recovery; its compare-and-set makes it exactly once.
     */
    let applied: Awaited<ReturnType<typeof applyExitFill>>;
    try {
      applied = await applyExitFill(attempt, orderResult);
    } catch (error) {
      console.error(`[trade-exit] partial fill for ${trade.id} could not be booked yet`, error);
      throw new ControlPending({ attemptId: attempt.id },
        "The partial-close order reached the exchange but could not be booked yet; " +
        "recovery will apply it.");
    }
    if (!applied) {
      throw new ControlRefusal(409, "already_recorded",
        "This partial exit has already been recorded; no second sale was made.");
    }
    if (applied.executedQty <= 0) {
      // Nothing was sold, so nothing was booked. Truthful beats tidy.
      return {
        partial: null,
        trade: await tradeWithDetail(trade.id),
        requestedQty: sellQty,
        executedQty: 0,
        detail: `${trade.pair}: the exchange filled none of the requested ${sellQty}; ` +
          `the position is unchanged (${orderResult.exchangeStatus ?? "no fill"}).`,
      };
    }

    void sendExecutionNotification({
      side: "sell", symbol: trade.pair, quantity: orderResult.executedQty,
      quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
      orderId: orderResult.orderId, pnlPct: applied.pnlPct,
    }).catch((e) => console.error("Partial-close notification failed", e));

    // Requested and executed stay distinguishable on the wire: `partial.quantity`
    // is what actually sold, `requestedQty` is what was asked for.
    return {
      partial: applied.partial, trade: await tradeWithDetail(trade.id),
      requestedQty: sellQty, executedQty: applied.executedQty,
    };
  } finally {
    // A leaked lock makes the trade permanently uncloseable, which is worse
    // than the double sell it prevents.
    releaseTradeClose(trade.id);
  }
}
