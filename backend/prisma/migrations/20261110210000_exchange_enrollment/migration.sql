-- OD-4: single-use enrollment tickets for exchange-key entry and webhook
-- secret reveal on the Bot's own origin. Additive only: a new table.
-- The ticket and the browser session token are stored ONLY as SHA-256 hashes.
CREATE TABLE "ExchangeEnrollment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticketHash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "accountId" TEXT,
  "botId" TEXT,
  "testnet" BOOLEAN,
  "name" TEXT,
  "actorUserId" TEXT NOT NULL,
  "stepUpMethod" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "expiresAt" DATETIME NOT NULL,
  "openedAt" DATETIME,
  "sessionHash" TEXT,
  "sessionExpiresAt" DATETIME,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "completedAt" DATETIME,
  "outcome" TEXT,
  "keyHint" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ExchangeEnrollment_ticketHash_key" ON "ExchangeEnrollment"("ticketHash");
CREATE UNIQUE INDEX "ExchangeEnrollment_sessionHash_key" ON "ExchangeEnrollment"("sessionHash");
CREATE INDEX "ExchangeEnrollment_status_expiresAt_idx" ON "ExchangeEnrollment"("status", "expiresAt");
