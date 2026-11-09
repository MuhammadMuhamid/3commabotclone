-- OD-5 (Bot emitter): the environment an order was routed to, recorded when
-- the intent is reserved (never re-derived later from mutable settings), and
-- the Platform capabilities seen in the last acknowledged ingest answer.
-- Additive only: one nullable column (legacy intents stay NULL = UNKNOWN) and
-- one new table.
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "executionEnvironment" TEXT;

CREATE TABLE "PlatformCapability" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "seenAt" DATETIME NOT NULL
);
