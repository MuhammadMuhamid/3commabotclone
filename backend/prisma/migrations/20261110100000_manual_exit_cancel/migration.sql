-- OD-1 (cancel first, then sweep race fills) and X7 (fee netting before a sweep).
-- Additive only: nullable or defaulted columns on ManualOrder; every existing row
-- stays valid and reads as "policy not engaged" (exitCancelState NULL) with its
-- fills treated as netted, exactly as before this migration.
ALTER TABLE "ManualOrder" ADD COLUMN "exitCancelState" TEXT;
ALTER TABLE "ManualOrder" ADD COLUMN "exitCancelAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ManualOrder" ADD COLUMN "exitCancelRequestedAt" DATETIME;
ALTER TABLE "ManualOrder" ADD COLUMN "exitCancelLastError" TEXT;
ALTER TABLE "ManualOrder" ADD COLUMN "exitOrigin" TEXT;
ALTER TABLE "ManualOrder" ADD COLUMN "fillsNetted" BOOLEAN NOT NULL DEFAULT true;
