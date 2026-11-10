import { config } from "../config.js";
import { formatInvestmentLabel } from "../lib/investment.js";
import { sumMoney } from "../lib/money.js";
import { prisma } from "../lib/prisma.js";
import { archivedWhere, findArchiveBlockers, type ArchiveBlock, type ArchivedFilter } from "./tradeArchive.js";

/**
 * What the Platform's Bot section reads over the signed channel.
 *
 * Every response is built field by field rather than from a spread row. These
 * rows sit next to the webhook secret and the encrypted exchange keys, so a
 * column added to the schema later stays out of this view until it is named here.
 */

export const BOT_VIEW_MAX_PAGE_SIZE = 100;

export async function readBotStats() {
  const active = await prisma.smartTrade.findMany({ where: { status: "active" } });
  const closedCount = await prisma.smartTrade.count({ where: { status: "closed" } });
  const botCount = await prisma.signalBot.count();
  const activeBotCount = await prisma.signalBot.count({ where: { status: "active" } });
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayClosed = await prisma.smartTrade.findMany({
    where: { status: "closed", closedAt: { gte: todayStart } },
  });
  return {
    upnl: sumMoney(active.map((t) => t.pnlUsdt)),
    locked: sumMoney(active.map((t) => t.quoteSpent)),
    activeCount: active.length,
    closedCount,
    todayPnl: sumMoney(todayClosed.map((t) => t.pnlUsdt)),
    botCount,
    activeBotCount,
    stoppedBotCount: botCount - activeBotCount,
  };
}

/**
 * Every summary figure here counts ALL closed trades, archived ones included:
 * Archive (Feature B) is presentation state and never changes a total.
 */
export async function readBotViewSummary() {
  const [stats, realizedRows] = await Promise.all([
    readBotStats(),
    prisma.smartTrade.findMany({ where: { status: "closed" }, select: { pnlUsdt: true } }),
  ]);
  return {
    mode: { dryRun: config.dryRun, binanceTestnet: config.binanceTestnet },
    stats: { ...stats, totalRealizedPnl: sumMoney(realizedRows.map((t) => t.pnlUsdt)) },
  };
}

function parsePairs(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export async function listBotViewBots() {
  const bots = await prisma.signalBot.findMany({
    orderBy: { createdAt: "desc" },
    include: { exchangeAccount: { select: { name: true, testnet: true } } },
  });
  return Promise.all(bots.map(async (bot) => {
    const [activeTrades, closedTrades, signalCount] = await Promise.all([
      prisma.smartTrade.count({ where: { botId: bot.id, status: "active" } }),
      prisma.smartTrade.findMany({ where: { botId: bot.id, status: "closed" }, select: { pnlUsdt: true } }),
      prisma.webhookLog.count({ where: { botId: bot.id } }),
    ]);
    return {
      id: bot.id,
      name: bot.name,
      status: bot.status,
      pairs: parsePairs(bot.pairs),
      investment: formatInvestmentLabel(bot.maxInvestmentPct, bot.maxInvestmentUnit),
      entryEnabled: bot.entryEnabled,
      exitEnabled: bot.exitEnabled,
      takeProfitPct: bot.takeProfitEnabled ? bot.takeProfitPct : null,
      stopLossPct: bot.stopLossEnabled ? bot.stopLossPct : null,
      maxEntryOrders: bot.maxEntryOrders,
      maxActiveSmartTrades: bot.maxActiveSmartTradesEnabled ? bot.maxActiveSmartTrades : null,
      account: bot.exchangeAccount
        ? { name: bot.exchangeAccount.name, testnet: bot.exchangeAccount.testnet }
        : null,
      activeTrades,
      closedTrades: closedTrades.length,
      realizedPnl: sumMoney(closedTrades.map((t) => t.pnlUsdt)),
      signalCount,
      createdAt: bot.createdAt,
    };
  }));
}

export async function listBotViewTrades(query: {
  status: "active" | "closed"; botId?: string; page: number; pageSize: number;
  /** Feature B: History listing filter (default `exclude`). Listing only — never a summary. */
  archived?: ArchivedFilter;
}) {
  const where = {
    status: query.status,
    ...(query.botId ? { botId: query.botId } : {}),
    // An active trade is never archived; the filter applies to History only.
    ...(query.status === "closed" ? archivedWhere(query.archived ?? "exclude") : {}),
  };
  const [total, trades] = await Promise.all([
    prisma.smartTrade.count({ where }),
    prisma.smartTrade.findMany({
      where,
      // The id breaks ties, so a row can't appear on two pages.
      orderBy: [query.status === "closed" ? { closedAt: "desc" } : { createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        bot: { select: { name: true } },
        exchangeAccount: { select: { name: true, testnet: true } },
        _count: { select: { partialCloses: true } },
      },
    }),
  ]);
  const blockers = query.status === "closed" ? await findArchiveBlockers(trades) : new Map<string, ArchiveBlock>();
  return {
    total,
    page: query.page,
    pageSize: query.pageSize,
    rows: trades.map((trade) => ({
      id: trade.id,
      botId: trade.botId,
      // A deleted bot leaves its trades behind, with the name kept on the trade.
      botName: trade.bot?.name ?? (trade.botName || null),
      source: trade.source,
      pair: trade.pair,
      status: trade.status,
      entryPrice: trade.entryPrice,
      currentPrice: trade.currentPrice,
      quantity: trade.quantity,
      quoteSpent: trade.quoteSpent,
      pnlUsdt: trade.pnlUsdt,
      pnlPct: trade.pnlPct,
      exchangeOrderId: trade.exchangeOrderId,
      closedReason: trade.closedReason,
      partialCloses: trade._count.partialCloses,
      account: trade.exchangeAccount
        ? { name: trade.exchangeAccount.name, testnet: trade.exchangeAccount.testnet }
        : null,
      createdAt: trade.createdAt,
      closedAt: trade.closedAt,
      // Feature B: presentation state, and why Archive would be refused (null = allowed).
      archivedAt: trade.archivedAt,
      archiveBlocked: blockers.get(trade.id) ?? null,
    })),
  };
}
