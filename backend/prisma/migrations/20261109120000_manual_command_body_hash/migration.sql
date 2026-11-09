-- D2: a reused manual request id must carry the same body. Nullable, so every
-- existing row stays valid and is simply not compared.
ALTER TABLE "ManualCommand" ADD COLUMN "bodyHash" TEXT;
