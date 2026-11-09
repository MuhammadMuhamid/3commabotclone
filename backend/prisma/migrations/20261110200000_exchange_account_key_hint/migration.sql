-- Slice 2 (C15): a non-secret hint of which API key an account holds — the
-- last four characters of the key, written when keys are stored or replaced.
-- Additive and nullable: accounts stored before this column show no hint
-- (nothing is decrypted to backfill it).
ALTER TABLE "ExchangeAccount" ADD COLUMN "keyHint" TEXT;
