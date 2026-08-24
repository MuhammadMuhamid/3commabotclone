-- ════════════════════════════════════════════════════════════════════════════
-- Live-trading safety for the execution bot
-- ════════════════════════════════════════════════════════════════════════════
--
-- BACK UP FIRST. `scripts/backup-db.sh` takes a verified SQLite backup; this
-- migration rebuilds the SignalBot table (SQLite's only way to change a column
-- default) and that table holds the per-bot webhook secrets.
--
-- What changes, and why:
--
--  * SignalBot defaults become survivable (BOT-003, BOT-015). `maxInvestmentPct`
--    100 -> 5, `stopLossEnabled` false -> true with a 3 % distance,
--    `exitEnabled` false -> true. EXISTING ROWS ARE COPIED UNCHANGED: this
--    alters what a NEW bot starts as, never what a running one does.
--
--  * SmartTrade gains `clientOrderId`, UNIQUE — the deterministic id sent to
--    Binance as `newClientOrderId`, so an order that succeeded at the exchange
--    but threw locally can be found instead of becoming an untracked live
--    position (BOT-007). `exchangeOrderId` gains a plain index rather than a
--    unique one, because a unique index could fail to build against a live
--    database that already holds a duplicate, and a migration that refuses to
--    apply blocks startup (BOT-025).
--
--  * SmartTrade gains `protectiveOrderId`, for the exchange-side stop that is
--    DISABLED BY DEFAULT and awaiting testnet validation (BOT-017).
--
--  * Indexes on SmartTrade(status), (botId,status), (pair,status), (closedAt)
--    and PartialClose(tradeId). The last one existed and was dropped by
--    20260712224627_web_push_security and never recreated; every final close
--    reads a trade's partial closes (BOT-024).
--
--  * PairCloseMark makes the stale-sell guard durable. It was an in-memory Map
--    that evaporated on restart, while the idempotency guard beside it was
--    deliberately persistent (BOT-019).
--
--  * RiskControl is the account-level kill switch and limits. Seeded halted =
--    false with every limit NULL, so this changes no behaviour until an
--    operator sets a number (BOT-011).

-- AlterTable
ALTER TABLE "SmartTrade" ADD COLUMN "clientOrderId" TEXT;
ALTER TABLE "SmartTrade" ADD COLUMN "protectiveOrderId" TEXT;

-- CreateTable
CREATE TABLE "PairCloseMark" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "pair" TEXT NOT NULL,
    "closedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RiskControl" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "tradingHalted" BOOLEAN NOT NULL DEFAULT false,
    "haltedReason" TEXT,
    "haltedBy" TEXT,
    "haltedAt" DATETIME,
    "maxTotalExposureQuote" REAL,
    "maxConcurrentTrades" INTEGER,
    "maxDailyLossQuote" REAL,
    "dailyLossWindowHours" INTEGER NOT NULL DEFAULT 24,
    "updatedAt" DATETIME NOT NULL
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
    "maxInvestmentPct" REAL NOT NULL DEFAULT 5,
    "maxInvestmentUnit" TEXT NOT NULL DEFAULT 'pct_bot',
    "status" TEXT NOT NULL DEFAULT 'active',
    "webhookSecret" TEXT NOT NULL,
    "entryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "entryVolumePct" REAL NOT NULL DEFAULT 100,
    "entryOrderType" TEXT NOT NULL DEFAULT 'market',
    "exitEnabled" BOOLEAN NOT NULL DEFAULT true,
    "takeProfitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "takeProfitPct" REAL,
    "stopLossEnabled" BOOLEAN NOT NULL DEFAULT true,
    "stopLossPct" REAL DEFAULT 3,
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
CREATE INDEX "PairCloseMark_closedAt_idx" ON "PairCloseMark"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PairCloseMark_botId_pair_key" ON "PairCloseMark"("botId", "pair");

-- CreateIndex
CREATE INDEX "PartialClose_tradeId_idx" ON "PartialClose"("tradeId");

-- CreateIndex
CREATE UNIQUE INDEX "SmartTrade_clientOrderId_key" ON "SmartTrade"("clientOrderId");

-- CreateIndex
CREATE INDEX "SmartTrade_status_idx" ON "SmartTrade"("status");

-- CreateIndex
CREATE INDEX "SmartTrade_botId_status_idx" ON "SmartTrade"("botId", "status");

-- CreateIndex
CREATE INDEX "SmartTrade_pair_status_idx" ON "SmartTrade"("pair", "status");

-- CreateIndex
CREATE INDEX "SmartTrade_closedAt_idx" ON "SmartTrade"("closedAt");

-- CreateIndex
CREATE INDEX "SmartTrade_exchangeOrderId_idx" ON "SmartTrade"("exchangeOrderId");


-- Seed the risk-control singleton with everything disabled.
INSERT OR IGNORE INTO "RiskControl" ("id", "updatedAt") VALUES ('global', CURRENT_TIMESTAMP);
