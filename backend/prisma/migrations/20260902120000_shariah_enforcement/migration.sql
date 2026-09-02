-- Final Shariah exposure enforcement, additive only.
--
-- Existing orders and intents keep a NULL `shariahContext`, which the bot reads
-- as "admitted before this feature existed" and therefore leaves ungated. No
-- historical row is reclassified, and no position is liquidated by this
-- migration or by anything it enables.
ALTER TABLE "ManualOrder" ADD COLUMN "shariahContext" TEXT;
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "shariahContext" TEXT;

-- The per-scope anti-downgrade latch. Holds a mode and a policy identity only:
-- never an asset, a status, or any screening input.
CREATE TABLE "ShariahEnforcement" (
    "scope" TEXT NOT NULL PRIMARY KEY,
    "mode" TEXT NOT NULL,
    "policyVersion" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
