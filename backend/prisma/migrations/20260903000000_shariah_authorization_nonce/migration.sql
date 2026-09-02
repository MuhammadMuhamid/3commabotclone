-- Single-use Shariah authorisation evidence on the direct-webhook path.
--
-- The detached signature introduced in contract v4 proved WHO made a screening
-- decision but not WHICH ORDER it authorised, so a signed payload observed in
-- flight could be presented again under a fresh `dedupe_key` and buy a second
-- time. Contract v5 puts a per-authorisation nonce inside the signed bytes;
-- this column is where the receiver spends it.
--
-- It lives on StrategyOrderIntent rather than in a table of its own so that
-- claiming the authorisation and admitting the durable intent are the SAME
-- write. There is then no window in which a nonce has been consumed but no
-- recoverable intent exists, and no way for cleanup to remove the evidence
-- while the order it authorised is still on file.
--
-- Additive only: ADD COLUMN plus CREATE UNIQUE INDEX. SQLite performs neither
-- as a table rebuild, so this is safe against a populated database. Every
-- existing row gets NULL, and NULLs are distinct in a SQLite unique index, so
-- no historical intent is reclassified or made to collide.
ALTER TABLE "StrategyOrderIntent" ADD COLUMN "authorizationNonceHash" TEXT;

CREATE UNIQUE INDEX "StrategyOrderIntent_authorizationNonceHash_key"
  ON "StrategyOrderIntent"("authorizationNonceHash");
