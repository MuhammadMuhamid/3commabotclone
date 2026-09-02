-- Going-forward immutable realization outbox. No historical SmartTrade or
-- PartialClose row is backfilled by this additive migration.
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "platformDeploymentId" TEXT;
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "platformOrderIntentId" TEXT;
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "platformDedupeKey" TEXT;
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "platformWebhookIdentity" TEXT;

CREATE TABLE "RealizationEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "strategyIntentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "eventTime" DATETIME NOT NULL,
  "payload" TEXT NOT NULL,
  "payloadSha256" TEXT NOT NULL,
  "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deliveredAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "RealizationEvent_strategyIntentId_key"
  ON "RealizationEvent"("strategyIntentId");
CREATE INDEX "RealizationEvent_deliveryStatus_nextAttemptAt_createdAt_idx"
  ON "RealizationEvent"("deliveryStatus", "nextAttemptAt", "createdAt");
