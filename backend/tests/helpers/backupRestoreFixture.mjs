import { createHash } from "node:crypto";
import { prisma } from "../../src/lib/prisma.js";
import { reserveManualNonce } from "../../src/services/manualAuth.js";
import { runIdempotentManualCommand } from "../../src/services/manualTrading.js";
import { processWebhook } from "../../src/services/webhook.js";
import {
  reconcileStrategyIntent,
  reserveStrategyIntent,
} from "../../src/services/strategyOrderIntent.js";

const instant = (suffix) => new Date(`2026-09-02T12:00:${suffix}Z`);
const botId = "bot-backup-fixture";
const accountId = "account-backup-fixture";
const strategyTradeId = "trade-strategy-fixture";
const manualTradeId = "trade-manual-fixture";
const manualOrderId = "manual-order-fixture";
const partialIntentId = "intent-partial-fixture";
const pendingIntentId = "intent-pending-fixture";
const webhookDedupeKey = "L-1788350400000";
const webhookSecret = "fixture-webhook-credential-20260902";

async function seed() {
  await prisma.user.create({ data: {
    id: "user-backup-fixture",
    username: "fixture-operator",
    passwordHash: "fixture-password-hash-not-a-credential",
    totpSecret: "fixture-totp-seed-not-a-credential",
    totpEnabled: true,
    createdAt: instant("00.123"),
    refreshTokens: { create: {
      id: "refresh-backup-fixture",
      tokenHash: "fixture-refresh-token-hash",
      expiresAt: instant("59.123"),
      createdAt: instant("01.123"),
    }},
    pushSubscriptions: { create: {
      id: "push-backup-fixture",
      endpoint: "https://fixture.invalid/push",
      p256dh: "fixture-public-key",
      auth: "fixture-push-auth",
      createdAt: instant("02.123"),
      updatedAt: instant("03.123"),
    }},
  }});

  await prisma.exchangeAccount.create({ data: {
    id: accountId,
    name: "Disposable recovery account",
    exchange: "binance",
    marketType: "spot",
    apiKeyEnc: "fixture-encrypted-api-key-not-a-credential",
    apiSecretEnc: "fixture-encrypted-api-secret-not-a-credential",
    testnet: false,
    createdAt: instant("04.123"),
    updatedAt: instant("05.123"),
  }});
  const bot = await prisma.signalBot.create({ data: {
    id: botId,
    name: "Disposable recovery bot",
    pairs: JSON.stringify(["BTCUSDT"]),
    webhookSecret,
    exchangeAccountId: accountId,
    maxInvestmentPct: 7.5,
    maxEntryOrders: 3,
    createdAt: instant("06.123"),
    updatedAt: instant("07.123"),
  }});
  await prisma.webhookLog.create({ data: {
    id: "webhook-log-fixture",
    botId,
    payload: JSON.stringify({ action: "sell", symbol: "BTCUSDT", dedupe_key: "X-fixed" }),
    status: "ok",
    message: "fixture receipt",
    createdAt: instant("08.123"),
  }});

  await prisma.smartTrade.create({ data: {
    id: strategyTradeId,
    botId,
    botName: bot.name,
    pair: "BTCUSDT",
    status: "active",
    entryPrice: 100,
    currentPrice: 112.5,
    quantity: 0.75,
    quoteSpent: 75,
    pnlUsdt: 9.375,
    pnlPct: 12.5,
    buyPrice: 100,
    exchangeOrderId: "exchange-entry-fixed",
    clientOrderId: "client-strategy-entry-fixed",
    protectiveOrderId: "protective-client-fixed",
    source: "strategy",
    exchangeAccountId: accountId,
    createdAt: instant("09.123"),
    updatedAt: instant("10.123"),
  }});
  await prisma.strategyOrderIntent.create({ data: {
    id: partialIntentId,
    sourceKey: `${botId}:BTCUSDT:sell:X-fixed`,
    webhookLogId: "webhook-log-fixture",
    botId,
    botName: bot.name,
    exchangeAccountId: accountId,
    clientOrderId: "client-strategy-partial-fixed",
    symbol: "BTCUSDT",
    side: "SELL",
    requestedBaseQty: 0.25,
    sellPercent: 25,
    exitLeg: "tp1",
    smartTradeId: strategyTradeId,
    status: "reconciled",
    exchangeOrderId: "exchange-partial-fixed",
    exchangeStatus: "FILLED",
    filledBaseQty: 0.25,
    filledQuoteQty: 28.125,
    averageFillPrice: 112.5,
    submittedAt: instant("11.123"),
    reconciledAt: instant("12.123"),
    createdAt: instant("10.123"),
    updatedAt: instant("12.123"),
  }});
  await prisma.partialClose.create({ data: {
    id: "partial-close-fixture",
    tradeId: strategyTradeId,
    pct: 25,
    quantity: 0.25,
    revenue: 28.125,
    pnlUsdt: 3.125,
    avgPrice: 112.5,
    exchangeOrderId: "exchange-partial-fixed",
    strategyIntentId: partialIntentId,
    createdAt: instant("12.123"),
  }});
  await prisma.strategyOrderIntent.create({ data: {
    id: pendingIntentId,
    sourceKey: `${botId}:BTCUSDT:buy:L-pending-fixed`,
    botId,
    botName: bot.name,
    exchangeAccountId: accountId,
    clientOrderId: "client-strategy-pending-fixed",
    symbol: "BTCUSDT",
    side: "BUY",
    requestedQuoteQty: 42.25,
    status: "submitted",
    submittedAt: instant("14.123"),
    createdAt: instant("13.123"),
    updatedAt: instant("14.123"),
  }});

  await prisma.manualOrder.create({ data: {
    id: manualOrderId,
    requestId: "manual-request-fixed",
    exchangeAccountId: accountId,
    symbol: "ETHUSDT",
    side: "BUY",
    orderType: "LIMIT",
    quantityType: "quote",
    requestedQuoteQty: 200,
    limitPrice: 2000,
    takeProfitPrice: 2200,
    stopLossPrice: 1800,
    protectionType: "bot-managed",
    protectionState: "active",
    status: "canceled",
    exchangeOrderId: "exchange-manual-fixed",
    clientOrderId: "client-manual-fixed",
    filledBaseQty: 0.05,
    filledQuoteQty: 100,
    averageFillPrice: 2000,
    submittedAt: instant("16.123"),
    completedAt: instant("17.123"),
    createdAt: instant("15.123"),
    updatedAt: instant("17.123"),
  }});
  await prisma.smartTrade.create({ data: {
    id: manualTradeId,
    botName: "Manual",
    pair: "ETHUSDT",
    status: "active",
    entryPrice: 2000,
    currentPrice: 2050,
    quantity: 0.05,
    quoteSpent: 100,
    buyPrice: 2000,
    exchangeOrderId: "exchange-manual-fixed",
    clientOrderId: "client-manual-fixed",
    source: "manual",
    exchangeAccountId: accountId,
    manualOrderId,
    manualTpPrice: 2200,
    manualSlPrice: 1800,
    protectionType: "bot-managed",
    protectionState: "active",
    createdAt: instant("18.123"),
    updatedAt: instant("19.123"),
  }});
  await prisma.manualCommand.create({ data: {
    id: "manual-command-fixture",
    requestId: "manual-command-request-fixed",
    kind: "cancel_order",
    status: "succeeded",
    result: JSON.stringify({ id: manualOrderId, requestId: "manual-request-fixed" }),
    createdAt: instant("20.123"),
    updatedAt: instant("21.123"),
  }});
  await prisma.manualNonce.create({ data: {
    nonce: "manual-nonce-fixture",
    expiresAt: new Date("2035-09-02T12:00:00.123Z"),
    createdAt: instant("22.123"),
  }});
  const receiptIdentity = `caller:${botId}:BTCUSDT:buy:${webhookDedupeKey}`;
  await prisma.webhookReceipt.create({ data: {
    id: "webhook-receipt-fixture",
    keyHash: createHash("sha256").update(receiptIdentity).digest("hex"),
    expiresAt: new Date("2035-09-02T12:00:00.123Z"),
    createdAt: instant("23.123"),
  }});
  await prisma.pairCloseMark.create({ data: {
    id: "pair-close-fixture",
    botId,
    pair: "BTCUSDT",
    closedAt: instant("24.123"),
    createdAt: instant("25.123"),
  }});
  await prisma.riskControl.upsert({
    where: { id: "global" },
    create: {
      id: "global",
      tradingHalted: true,
      haltedReason: "disposable recovery fixture",
      haltedBy: "operator",
      haltedAt: instant("26.123"),
      maxTotalExposureQuote: 500,
      maxConcurrentTrades: 4,
      maxDailyLossQuote: 50,
      dailyLossWindowHours: 12,
      updatedAt: instant("27.123"),
    },
    update: {
      tradingHalted: true,
      haltedReason: "disposable recovery fixture",
      haltedBy: "operator",
      haltedAt: instant("26.123"),
      maxTotalExposureQuote: 500,
      maxConcurrentTrades: 4,
      maxDailyLossQuote: 50,
      dailyLossWindowHours: 12,
      updatedAt: instant("27.123"),
    },
  });
}

async function snapshot() {
  const migrations = await prisma.$queryRawUnsafe(
    'SELECT migration_name AS migrationName FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
  );
  return {
    migrations,
    exchangeAccounts: await prisma.exchangeAccount.findMany({ orderBy: { id: "asc" } }),
    signalBots: await prisma.signalBot.findMany({ orderBy: { id: "asc" } }),
    smartTrades: await prisma.smartTrade.findMany({ orderBy: { id: "asc" } }),
    manualOrders: await prisma.manualOrder.findMany({ orderBy: { id: "asc" } }),
    manualCommands: await prisma.manualCommand.findMany({ orderBy: { id: "asc" } }),
    manualNonces: await prisma.manualNonce.findMany({ orderBy: { nonce: "asc" } }),
    partialCloses: await prisma.partialClose.findMany({ orderBy: { id: "asc" } }),
    strategyOrderIntents: await prisma.strategyOrderIntent.findMany({ orderBy: { id: "asc" } }),
    webhookLogs: await prisma.webhookLog.findMany({ orderBy: { id: "asc" } }),
    webhookReceipts: await prisma.webhookReceipt.findMany({ orderBy: { id: "asc" } }),
    pairCloseMarks: await prisma.pairCloseMark.findMany({ orderBy: { id: "asc" } }),
    riskControls: await prisma.riskControl.findMany({ orderBy: { id: "asc" } }),
    users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
    refreshTokens: await prisma.refreshToken.findMany({ orderBy: { id: "asc" } }),
    pushSubscriptions: await prisma.pushSubscription.findMany({ orderBy: { id: "asc" } }),
  };
}

async function verifyRecoveryBehavior() {
  const bot = await prisma.signalBot.findUniqueOrThrow({ where: { id: botId } });
  const existing = await reserveStrategyIntent({
    sourceKey: `${botId}:BTCUSDT:sell:X-fixed`,
    webhookLogId: "webhook-log-fixture",
    bot,
    clientOrderId: "client-strategy-partial-fixed",
    symbol: "BTCUSDT",
    side: "SELL",
    requestedBaseQty: 0.25,
    sellPercent: 25,
    exitLeg: "tp1",
    smartTradeId: strategyTradeId,
  });
  let reconciledSubmitCalls = 0;
  let reconciledQueryCalls = 0;
  const alreadyReconciled = await reconcileStrategyIntent(existing.id, {
    submit: async () => { reconciledSubmitCalls++; throw new Error("submission forbidden"); },
    query: async () => { reconciledQueryCalls++; throw new Error("query unnecessary"); },
  });

  let pendingSubmitCalls = 0;
  let pendingQueryCalls = 0;
  const pending = await reconcileStrategyIntent(pendingIntentId, {
    submit: async () => { pendingSubmitCalls++; throw new Error("resubmission forbidden"); },
    query: async () => { pendingQueryCalls++; return null; },
  });

  let commandActionCalls = 0;
  const commandReplay = await runIdempotentManualCommand(
    "manual-command-request-fixed",
    "cancel_order",
    async () => { commandActionCalls++; return { unexpected: true }; }
  );
  const nonceReplay = await reserveManualNonce(
    "manual-nonce-fixture",
    new Date("2035-09-02T12:00:00.123Z"),
    {
      prune: async (before) => { await prisma.manualNonce.deleteMany({ where: { expiresAt: { lt: before } } }); },
      create: async (nonce, expiresAt) => { await prisma.manualNonce.create({ data: { nonce, expiresAt } }); },
    }
  );
  let webhookClientCalls = 0;
  const webhookReplay = await processWebhook({
    secret: webhookSecret,
    action: "buy",
    symbol: "BTCUSDT",
    quote_order_qty: 12.34,
    dedupe_key: webhookDedupeKey,
  }, {
    clientFactory: async () => { webhookClientCalls++; throw new Error("exchange access forbidden"); },
  });

  return {
    existingIntentId: existing.id,
    strategyIntentCount: await prisma.strategyOrderIntent.count(),
    alreadyReconciled: {
      appliedNow: alreadyReconciled.appliedNow,
      pending: alreadyReconciled.pending,
      reconciledSubmitCalls,
      reconciledQueryCalls,
    },
    pendingIntent: {
      pending: pending.pending,
      pendingSubmitCalls,
      pendingQueryCalls,
      status: pending.intent.status,
    },
    commandReplay,
    commandActionCalls,
    nonceReplay,
    webhookReplay,
    webhookClientCalls,
  };
}

try {
  const mode = process.argv[2];
  if (mode === "seed") {
    await seed();
    process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
  } else if (mode === "verify") {
    const state = await snapshot();
    const recoveryBehavior = await verifyRecoveryBehavior();
    process.stdout.write(`${JSON.stringify({ state, recoveryBehavior })}\n`);
  } else {
    throw new Error("expected seed or verify mode");
  }
} finally {
  await prisma.$disconnect();
}
