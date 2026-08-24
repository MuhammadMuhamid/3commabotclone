import type { SignalBot } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol } from "../lib/symbols.js";
import {
  clientFromAccount,
  clientFromEnv,
  getBaseFreeBalance,
  getUsdtBalance,
  marketBuyQuote,
  marketSellBase,
  type BinanceClient,
} from "./binance.js";
import { updateSmartTradePnl, isTradeClosing, calcFinalClosePnl, calcRealizedPnl } from "./smartTrade.js";
import { calcOrderQuoteUsdt } from "../lib/investment.js";
import { recordPairClose, getLastCloseTs } from "../lib/tradeCloseTracker.js";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { sendExecutionNotification } from "./push.js";

const dedupe = new Map<string, number>();
const DEDUPE_TTL = 120_000;
/** Blocks a second buy/sell for same bot+pair within this window (TV order-fill duplicate guard) */
const TRADE_DEDUPE_TTL = 45_000;

// BUG-04: Per-bot lock prevents concurrent buys from racing past assertCanOpenTrade
const botBuyLocks = new Set<string>();

function pruneDedupe(now: number): void {
  for (const [k, ts] of dedupe) {
    if (now - ts > DEDUPE_TTL) dedupe.delete(k);
  }
}

function isDuplicate(key: string, ttlMs: number = DEDUPE_TTL): boolean {
  const now = Date.now();
  pruneDedupe(now);
  const ts = dedupe.get(key);
  if (ts != null && now - ts < ttlMs) return true;
  dedupe.set(key, now);
  return false;
}

async function reservePersistentDedupe(key: string, ttlMs: number): Promise<boolean> {
  const keyHash = crypto.createHash("sha256").update(key).digest("hex");
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
  { skipExitCheck = false }: { skipExitCheck?: boolean } = {}
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

  // Namespace caller keys: TradingView's {{timenow}} can be identical for
  // different coins and bots closing on the same bar.
  if (body.dedupe_key) {
    const callerKey = `caller:${bot.id}:${symbol}:${side}:${body.dedupe_key}`;
    if (isDuplicate(callerKey) || !(await reservePersistentDedupe(callerKey, DEDUPE_TTL))) {
      return { status: "ignored_duplicate" };
    }
  }

  const tradeKey = tradeEventKey(bot.id, symbol, side, body.exit_leg);
  if (isDuplicate(tradeKey, TRADE_DEDUPE_TTL) ||
      !(await reservePersistentDedupe(tradeKey, TRADE_DEDUPE_TTL))) {
    return { status: "ignored_duplicate" };
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

  try {
    let result: { status: string; detail?: unknown };

    if (side === "buy") {
      if (!bot.entryEnabled) throw new Error("Entry orders disabled on this bot");

      // BUG-04: Serialize concurrent buys per bot to prevent exceeding maxActiveSmartTrades
      if (botBuyLocks.has(bot.id)) {
        throw new Error("Trade creation in progress for this bot. Retry shortly.");
      }
      botBuyLocks.add(bot.id);

      try {
        await assertCanOpenTrade(bot, symbol);
        const client = await getClient(bot);
        const usdt = await getUsdtBalance(client);
        const quote = calcOrderQuoteUsdt(bot, usdt, body.quote_order_qty);
        if (quote <= 0) throw new Error("Quote amount must be > 0");

        const orderResult = await marketBuyQuote(client, symbol, quote);
        const trade = await prisma.smartTrade.create({
          data: {
            botId: bot.id,
            botName: bot.name,  // F5: persisted so history survives bot deletion
            pair: symbol,
            direction: bot.direction === "short" ? "short" : "long",
            status: "active",
            entryPrice: orderResult.avgPrice,
            buyPrice: orderResult.avgPrice,
            currentPrice: orderResult.avgPrice,
            quantity: orderResult.executedQty,
            quoteSpent: orderResult.cummulativeQuoteQty,
            exchangeOrderId: orderResult.orderId,
          },
        });
        await updateSmartTradePnl(trade.id, client);
        void sendExecutionNotification({
          side: "buy", symbol, quantity: orderResult.executedQty,
          quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
          orderId: orderResult.orderId,
        }).catch((e) => console.error("BUY notification failed", e));
        result = { status: "ok", detail: { side: "buy", ...orderResult } };
      } finally {
        botBuyLocks.delete(bot.id);
      }
    } else {
      // BUG-03: Enforce exitEnabled for webhook sells; skipExitCheck=true for dashboard manual closes
      if (!skipExitCheck && !bot.exitEnabled) {
        throw new Error("Exit orders disabled on this bot");
      }

      const client = await getClient(bot);
      let qty = body.quantity;
      const active = await prisma.smartTrade.findFirst({
        where: { botId: bot.id, pair: symbol, status: "active" },
        orderBy: { createdAt: "desc" },
      });
      if (!active && !skipExitCheck) {
        throw new Error(`No active SmartTrade for ${symbol}`);
      }
      const partialPct = body.sell_percent;
      if (partialPct != null && (!Number.isFinite(partialPct) || partialPct <= 0 || partialPct >= 100)) {
        throw new Error("sell_percent must be greater than 0 and less than 100; omit it for a full close");
      }
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

      // BUG-05: Prevent sell racing with TP/SL monitor on the same trade
      if (active && isTradeClosing(active.id)) {
        throw new Error("Trade is already being closed by TP/SL monitor. Please wait.");
      }

      // STALE-SELL GUARD: if the active trade was opened AFTER the last close
      // for this bot+pair, this SELL signal was meant for the previous trade
      // (which is already closed). Skip to avoid accidentally closing the new trade.
      // skipExitCheck=true means the user clicked Close on the dashboard — always allow.
      if (active && !skipExitCheck) {
        const lastCloseTs = getLastCloseTs(bot.id, symbol);
        if (lastCloseTs !== undefined && active.createdAt.getTime() > lastCloseTs) {
          return {
            status: "ignored_stale_sell",
            detail: `${symbol} position was re-opened after a recent close. Sell signal skipped to protect the new trade (opened ${new Date(active.createdAt).toISOString()}).`,
          };
        }
      }

      // BUG-09: Removed redundant getBaseFreeBalance cap — resolveSellQuantity inside marketSellBase handles it
      const orderResult = await marketSellBase(client, symbol, qty);
      if (partialPct != null) {
        if (!active) throw new Error(`No active SmartTrade for ${symbol}`);
        const soldQty = Math.min(orderResult.executedQty, active.quantity);
        const proportionalCost = active.quoteSpent * (soldQty / active.quantity);
        const { pnlUsdt, pnlPct } = calcRealizedPnl(orderResult.cummulativeQuoteQty, proportionalCost);
        const newQuantity = Math.max(0, active.quantity - soldQty);
        const newQuoteSpent = Math.max(0, active.quoteSpent - proportionalCost);
        await prisma.$transaction([
          prisma.partialClose.create({
            data: {
              tradeId: active.id,
              pct: partialPct,
              quantity: soldQty,
              revenue: orderResult.cummulativeQuoteQty,
              pnlUsdt,
              avgPrice: orderResult.avgPrice,
              exchangeOrderId: String(orderResult.orderId),
            },
          }),
          prisma.smartTrade.update({
            where: { id: active.id },
            data: {
              quantity: newQuantity,
              quoteSpent: newQuoteSpent,
              currentPrice: orderResult.avgPrice,
            },
          }),
        ]);
        await updateSmartTradePnl(active.id, client);
        void sendExecutionNotification({
          side: "sell", symbol, quantity: soldQty,
          quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
          orderId: orderResult.orderId, pnlPct,
        }).catch((e) => console.error("PARTIAL SELL notification failed", e));
        result = {
          status: "ok",
          detail: { side: "sell", partial: true, sellPercent: partialPct, exitLeg: body.exit_leg, ...orderResult },
        };
      } else {
        if (active) {
          // Fetch prior partial closes so their P&L is included in the final total
          const partials = await prisma.partialClose.findMany({ where: { tradeId: active.id } });
          const { pnlUsdt, pnlPct } = calcFinalClosePnl(
            orderResult.cummulativeQuoteQty,
            active.quoteSpent,
            partials
          );
          await prisma.smartTrade.update({
            where: { id: active.id },
            data: {
              status: "closed",
              closedAt: new Date(),
              closedReason: "signal_exit",
              currentPrice: orderResult.avgPrice,
              pnlUsdt,
              pnlPct,
            },
          });
          // Record this close so future stale sell signals don't close the next trade
          recordPairClose(bot.id, symbol);
          void sendExecutionNotification({
            side: "sell", symbol, quantity: orderResult.executedQty,
            quoteAmount: orderResult.cummulativeQuoteQty, price: orderResult.avgPrice,
            orderId: orderResult.orderId, pnlPct,
          }).catch((e) => console.error("SELL notification failed", e));
        }
        result = { status: "ok", detail: { side: "sell", ...orderResult } };
      }
    }

    // BUG-01: Mark the single log entry as ok on success
    await prisma.webhookLog.update({ where: { id: log.id }, data: { status: "ok" } });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // BUG-01: Update the existing log entry instead of creating a second one
    await prisma.webhookLog.update({
      where: { id: log.id },
      data: { status: "error", message: msg },
    });
    throw e;
  }
}
