-- Feature B: Archive / Hide from History replaces deleting a closed trade.
-- Presentation state only: archiving never changes P&L, totals, the
-- daily-loss window or the halt latch, which keep reading every closed trade.
-- Additive only: two nullable columns (every existing row reads NULL = not
-- archived, so historical trades stay visible) and one index for the
-- History listing (status + archived filter, newest close first).
ALTER TABLE "SmartTrade" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "SmartTrade" ADD COLUMN "archivedBy" TEXT;

CREATE INDEX "SmartTrade_status_archivedAt_closedAt_idx" ON "SmartTrade"("status", "archivedAt", "closedAt");
