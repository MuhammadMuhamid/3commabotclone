-- ─────────────────────────────────────────────────────────────────────────────
-- Feature 4: PartialClose table
-- Feature 5: SmartTrade.botId → nullable (SetNull on bot delete) + botName field
-- ─────────────────────────────────────────────────────────────────────────────

-- F4: Partial close history
CREATE TABLE "PartialClose" (
    "id"              TEXT    NOT NULL PRIMARY KEY,
    "tradeId"         TEXT    NOT NULL,
    "pct"             REAL    NOT NULL,
    "quantity"        REAL    NOT NULL,
    "revenue"         REAL    NOT NULL,
    "pnlUsdt"         REAL    NOT NULL,
    "avgPrice"        REAL    NOT NULL,
    "exchangeOrderId" TEXT,
    "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PartialClose_tradeId_fkey"
        FOREIGN KEY ("tradeId") REFERENCES "SmartTrade" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PartialClose_tradeId_idx" ON "PartialClose"("tradeId");

-- F5: Recreate SmartTrade so botId is nullable (SQLite cannot ALTER COLUMN).
--     botName is denormalised from SignalBot.name so history survives bot deletion.
PRAGMA foreign_keys=OFF;

CREATE TABLE "SmartTrade_new" (
    "id"              TEXT    NOT NULL PRIMARY KEY,
    "botId"           TEXT,                          -- was NOT NULL, now nullable
    "botName"         TEXT    NOT NULL DEFAULT '',   -- new column
    "pair"            TEXT    NOT NULL,
    "direction"       TEXT    NOT NULL DEFAULT 'long',
    "status"          TEXT    NOT NULL DEFAULT 'active',
    "entryPrice"      REAL,
    "currentPrice"    REAL,
    "quantity"        REAL    NOT NULL DEFAULT 0,
    "quoteSpent"      REAL    NOT NULL DEFAULT 0,
    "pnlUsdt"         REAL    NOT NULL DEFAULT 0,
    "pnlPct"          REAL    NOT NULL DEFAULT 0,
    "buyPrice"        REAL,
    "exchangeOrderId" TEXT,
    "closedReason"    TEXT,
    "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt"        DATETIME,
    "updatedAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SmartTrade_botId_fkey"
        FOREIGN KEY ("botId") REFERENCES "SignalBot" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- Copy existing rows, backfilling botName from SignalBot
INSERT INTO "SmartTrade_new" (
    "id","botId","botName","pair","direction","status",
    "entryPrice","currentPrice","quantity","quoteSpent",
    "pnlUsdt","pnlPct","buyPrice","exchangeOrderId",
    "closedReason","createdAt","closedAt","updatedAt"
)
SELECT
    st."id",
    st."botId",
    COALESCE(sb."name", '') AS "botName",
    st."pair", st."direction", st."status",
    st."entryPrice", st."currentPrice", st."quantity", st."quoteSpent",
    st."pnlUsdt", st."pnlPct", st."buyPrice", st."exchangeOrderId",
    st."closedReason", st."createdAt", st."closedAt", st."updatedAt"
FROM "SmartTrade" st
LEFT JOIN "SignalBot" sb ON sb."id" = st."botId";

DROP TABLE "SmartTrade";
ALTER TABLE "SmartTrade_new" RENAME TO "SmartTrade";

PRAGMA foreign_keys=ON;
