-- Durable strategy MARKET intents close the crash window between exchange
-- acceptance and SmartTrade persistence. Existing trading/history rows are
-- preserved; no historical intents are fabricated.
CREATE TABLE "StrategyOrderIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKey" TEXT NOT NULL,
    "webhookLogId" TEXT,
    "botId" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "exchangeAccountId" TEXT,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "orderType" TEXT NOT NULL DEFAULT 'MARKET',
    "requestedBaseQty" REAL,
    "requestedQuoteQty" REAL,
    "sellPercent" REAL,
    "exitLeg" TEXT,
    "skipExitCheck" BOOLEAN NOT NULL DEFAULT false,
    "smartTradeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "exchangeOrderId" TEXT,
    "exchangeStatus" TEXT,
    "filledBaseQty" REAL NOT NULL DEFAULT 0,
    "filledQuoteQty" REAL NOT NULL DEFAULT 0,
    "averageFillPrice" REAL,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "submittedAt" DATETIME,
    "reconciledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "StrategyOrderIntent_sourceKey_key"
    ON "StrategyOrderIntent"("sourceKey");
CREATE UNIQUE INDEX "StrategyOrderIntent_clientOrderId_key"
    ON "StrategyOrderIntent"("clientOrderId");
CREATE INDEX "StrategyOrderIntent_status_createdAt_idx"
    ON "StrategyOrderIntent"("status", "createdAt");
CREATE INDEX "StrategyOrderIntent_smartTradeId_status_idx"
    ON "StrategyOrderIntent"("smartTradeId", "status");
CREATE INDEX "StrategyOrderIntent_botId_symbol_status_idx"
    ON "StrategyOrderIntent"("botId", "symbol", "status");

-- Nullable + UNIQUE is safe for populated SQLite databases: every historical
-- row receives NULL, and SQLite permits multiple NULLs in a unique index.
ALTER TABLE "PartialClose" ADD COLUMN "strategyIntentId" TEXT;
CREATE UNIQUE INDEX "PartialClose_strategyIntentId_key"
    ON "PartialClose"("strategyIntentId");
