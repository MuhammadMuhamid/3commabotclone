-- OD-3: a persisted "Pause new entries" switch on the Bot, independent of the
-- halt and of the daily-loss latch. Additive only: defaulted or nullable
-- columns on the RiskControl singleton; an existing row reads "not paused".
ALTER TABLE "RiskControl" ADD COLUMN "entriesPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RiskControl" ADD COLUMN "entriesPausedAt" DATETIME;
ALTER TABLE "RiskControl" ADD COLUMN "entriesPausedBy" TEXT;
ALTER TABLE "RiskControl" ADD COLUMN "entriesPausedReason" TEXT;
