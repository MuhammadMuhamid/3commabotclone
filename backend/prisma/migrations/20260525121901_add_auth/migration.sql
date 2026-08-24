-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SignalBot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "alertType" TEXT NOT NULL DEFAULT 'custom',
    "direction" TEXT NOT NULL DEFAULT 'long',
    "pairs" TEXT NOT NULL,
    "maxInvestmentPct" REAL NOT NULL DEFAULT 100,
    "maxInvestmentUnit" TEXT NOT NULL DEFAULT 'pct_bot',
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
    "maxActiveSmartTradesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxActiveSmartTrades" INTEGER,
    "exchangeAccountId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SignalBot_exchangeAccountId_fkey" FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SignalBot" ("alertType", "createdAt", "direction", "entryEnabled", "entryOrderType", "entryVolumePct", "exchangeAccountId", "exitEnabled", "id", "maxActiveSmartTrades", "maxActiveSmartTradesEnabled", "maxEntryOrders", "maxInvestmentPct", "maxInvestmentUnit", "name", "pairs", "status", "stopLossEnabled", "stopLossPct", "takeProfitEnabled", "takeProfitPct", "updatedAt", "webhookSecret") SELECT "alertType", "createdAt", "direction", "entryEnabled", "entryOrderType", "entryVolumePct", "exchangeAccountId", "exitEnabled", "id", "maxActiveSmartTrades", "maxActiveSmartTradesEnabled", "maxEntryOrders", "maxInvestmentPct", "maxInvestmentUnit", "name", "pairs", "status", "stopLossEnabled", "stopLossPct", "takeProfitEnabled", "takeProfitPct", "updatedAt", "webhookSecret" FROM "SignalBot";
DROP TABLE "SignalBot";
ALTER TABLE "new_SignalBot" RENAME TO "SignalBot";
CREATE UNIQUE INDEX "SignalBot_webhookSecret_key" ON "SignalBot"("webhookSecret");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
