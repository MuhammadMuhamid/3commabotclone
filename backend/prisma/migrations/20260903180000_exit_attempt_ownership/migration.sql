-- Owner and domain metadata for a durable exit attempt (BOT-P1-5).
--
-- `ExchangeOrderAttempt` already gave TP, SL and partial-close SELLs a durable,
-- unique client order id. What it did not give them was a way to be FOUND: the
-- owning position lived only inside the `intentKey` string, and close admission
-- reasons about `StrategyOrderIntent`. After a crash between the exchange
-- submission and the local settlement the in-process close lock is gone and the
-- attempt row is the only surviving evidence that an exit may already be live —
-- so a webhook or dashboard close could send a second, overlapping SELL.
--
-- These columns are what let the existing query-first recovery cover those
-- attempts: `smartTradeId` makes them findable, `submittedAt` distinguishes
-- "reserved but never sent" from "sent, fate unknown", and the rest carries the
-- accounting metadata a recovery needs to apply the fill exactly as the
-- synchronous path would have.
--
-- Purely additive: every column is nullable with no default backfill, so
-- existing rows keep reading exactly as they did.
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "smartTradeId" TEXT;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "origin" TEXT;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "requestedBaseQty" REAL;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "sellPercent" REAL;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "submittedAt" DATETIME;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "exchangeStatus" TEXT;

CREATE INDEX "ExchangeOrderAttempt_smartTradeId_status_idx"
  ON "ExchangeOrderAttempt"("smartTradeId", "status");
