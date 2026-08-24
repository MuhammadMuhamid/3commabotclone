-- CreateTable
CREATE TABLE "ExchangeAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "exchange" TEXT NOT NULL DEFAULT 'binance',
    "marketType" TEXT NOT NULL DEFAULT 'spot',
    "apiKeyEnc" TEXT NOT NULL,
    "apiSecretEnc" TEXT NOT NULL,
    "testnet" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "SignalBot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "alertType" TEXT NOT NULL DEFAULT 'custom',
    "direction" TEXT NOT NULL DEFAULT 'long',
    "pairs" TEXT NOT NULL,
    "maxInvestmentPct" REAL NOT NULL DEFAULT 100,
    "maxInvestmentUnit" TEXT NOT NULL DEFAULT '% USDT per Bot',
    "status" TEXT NOT NULL DEFAULT 'active',
    "webhookSecret" TEXT NOT NULL,
    "entryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "entryVolumePct" REAL NOT NULL DEFAULT 100,
    "entryOrderType" TEXT NOT NULL DEFAULT 'market',
    "exitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "takeProfitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "takeProfitPct" REAL,
    "stopLossEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stopLossPct" REAL,
    "maxEntryOrders" INTEGER,
    "exchangeAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SignalBot_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SignalBot_webhookSecret_key" ON "SignalBot"("webhookSecret");

CREATE TABLE "SmartTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'long',
    "status" TEXT NOT NULL DEFAULT 'active',
    "entryPrice" REAL,
    "currentPrice" REAL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "quoteSpent" REAL NOT NULL DEFAULT 0,
    "pnlUsdt" REAL NOT NULL DEFAULT 0,
    "pnlPct" REAL NOT NULL DEFAULT 0,
    "buyPrice" REAL,
    "exchangeOrderId" TEXT,
    "closedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SmartTrade_botId_fkey" FOREIGN KEY ("botId") REFERENCES "SignalBot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookLog_botId_fkey" FOREIGN KEY ("botId") REFERENCES "SignalBot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
