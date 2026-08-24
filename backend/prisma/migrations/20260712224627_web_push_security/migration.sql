-- DropIndex
DROP INDEX "PartialClose_tradeId_idx";

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SmartTrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT,
    "botName" TEXT NOT NULL DEFAULT '',
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
    CONSTRAINT "SmartTrade_botId_fkey" FOREIGN KEY ("botId") REFERENCES "SignalBot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SmartTrade" ("botId", "botName", "buyPrice", "closedAt", "closedReason", "createdAt", "currentPrice", "direction", "entryPrice", "exchangeOrderId", "id", "pair", "pnlPct", "pnlUsdt", "quantity", "quoteSpent", "status", "updatedAt") SELECT "botId", "botName", "buyPrice", "closedAt", "closedReason", "createdAt", "currentPrice", "direction", "entryPrice", "exchangeOrderId", "id", "pair", "pnlPct", "pnlUsdt", "quantity", "quoteSpent", "status", "updatedAt" FROM "SmartTrade";
DROP TABLE "SmartTrade";
ALTER TABLE "new_SmartTrade" RENAME TO "SmartTrade";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_keyHash_key" ON "WebhookReceipt"("keyHash");

-- CreateIndex
CREATE INDEX "WebhookReceipt_expiresAt_idx" ON "WebhookReceipt"("expiresAt");
