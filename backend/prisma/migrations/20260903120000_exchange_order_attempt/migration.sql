-- Durable per-attempt order identity (BOT-P1-1).
--
-- The dashboard partial close, the TP/SL monitor and the manual protection
-- poller all derived a deterministic client order id from a scope that named
-- only the position and a non-unique discriminator. Two distinct orders could
-- therefore present the SAME id to Binance, and the duplicate-rejection
-- recovery in `marketSellBase` — which is correct for a true retry — then
-- resolved the new order to the earlier order's fill.
--
-- This table is the durable authority those paths lacked. It is purely
-- additive: a brand new table plus its indexes, so an existing database is not
-- rebuilt and no historical row is reclassified.
CREATE TABLE "ExchangeOrderAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "intentKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "clientOrderId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exchangeOrderId" TEXT,
    "settledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ExchangeOrderAttempt_clientOrderId_key"
  ON "ExchangeOrderAttempt"("clientOrderId");

CREATE UNIQUE INDEX "ExchangeOrderAttempt_intentKey_attempt_key"
  ON "ExchangeOrderAttempt"("intentKey", "attempt");

CREATE INDEX "ExchangeOrderAttempt_intentKey_status_idx"
  ON "ExchangeOrderAttempt"("intentKey", "status");
