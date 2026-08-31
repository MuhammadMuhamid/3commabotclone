-- Manual Spot trading remains linked to the existing credential and SmartTrade
-- models. No Binance secret is copied into this schema.
ALTER TABLE "SmartTrade" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'strategy';
ALTER TABLE "SmartTrade" ADD COLUMN "exchangeAccountId" TEXT;
ALTER TABLE "SmartTrade" ADD COLUMN "manualOrderId" TEXT;
ALTER TABLE "SmartTrade" ADD COLUMN "manualTpPrice" REAL;
ALTER TABLE "SmartTrade" ADD COLUMN "manualSlPrice" REAL;
ALTER TABLE "SmartTrade" ADD COLUMN "protectionType" TEXT;
ALTER TABLE "SmartTrade" ADD COLUMN "protectionState" TEXT;

CREATE UNIQUE INDEX "SmartTrade_manualOrderId_key" ON "SmartTrade"("manualOrderId");
CREATE INDEX "SmartTrade_exchangeAccountId_status_idx" ON "SmartTrade"("exchangeAccountId", "status");

CREATE TABLE "ManualOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "exchangeAccountId" TEXT NOT NULL,
  "linkedPositionId" TEXT,
  "symbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "orderType" TEXT NOT NULL,
  "quantityType" TEXT NOT NULL,
  "requestedBaseQty" REAL,
  "requestedQuoteQty" REAL,
  "limitPrice" REAL,
  "takeProfitPrice" REAL,
  "stopLossPrice" REAL,
  "protectionType" TEXT,
  "protectionState" TEXT,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "exchangeOrderId" TEXT,
  "clientOrderId" TEXT NOT NULL,
  "filledBaseQty" REAL NOT NULL DEFAULT 0,
  "filledQuoteQty" REAL NOT NULL DEFAULT 0,
  "averageFillPrice" REAL,
  "error" TEXT,
  "submittedAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ManualOrder_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManualOrder_requestId_key" ON "ManualOrder"("requestId");
CREATE UNIQUE INDEX "ManualOrder_clientOrderId_key" ON "ManualOrder"("clientOrderId");
CREATE INDEX "ManualOrder_status_createdAt_idx" ON "ManualOrder"("status", "createdAt");
CREATE INDEX "ManualOrder_exchangeAccountId_symbol_createdAt_idx" ON "ManualOrder"("exchangeAccountId", "symbol", "createdAt");

CREATE TABLE "ManualCommand" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "result" TEXT,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ManualCommand_requestId_key" ON "ManualCommand"("requestId");

CREATE TABLE "ManualNonce" (
  "nonce" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ManualNonce_expiresAt_idx" ON "ManualNonce"("expiresAt");

-- SQLite cannot add these foreign keys to SmartTrade without rebuilding the
-- table. Prisma still enforces the relations for new writes, while the indexed
-- ids preserve existing rows and avoid a risky table rewrite in this migration.
