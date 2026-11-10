-- P-81 (execution notifications): an append-only feed of confirmed executions
-- and the order-level environment of manual orders and exit attempts.
-- Additive only: two nullable columns (older rows stay NULL = UNKNOWN) and one
-- new table. Rollback: the previous Bot build ignores all three.
ALTER TABLE "ManualOrder" ADD COLUMN "executionEnvironment" TEXT;
ALTER TABLE "ExchangeOrderAttempt" ADD COLUMN "executionEnvironment" TEXT;

CREATE TABLE "ExecutionEvent" (
  "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "id" TEXT NOT NULL,
  "payload" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ExecutionEvent_id_key" ON "ExecutionEvent"("id");
CREATE INDEX "ExecutionEvent_createdAt_idx" ON "ExecutionEvent"("createdAt");
