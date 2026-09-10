CREATE TABLE "SpotExecutionOrder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "platformIntentId" TEXT NOT NULL,
  "platformDedupeKey" TEXT NOT NULL,
  "platformPayloadHash" TEXT NOT NULL,
  "platformIntentCreatedAt" DATETIME NOT NULL,
  "exchangeAccountId" TEXT NOT NULL,
  "venue" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "canonicalInstrumentId" TEXT NOT NULL,
  "venueSymbol" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "orderType" TEXT NOT NULL,
  "timeInForce" TEXT,
  "requestedBaseQty" TEXT,
  "requestedQuoteQty" TEXT,
  "limitPrice" TEXT,
  "paperReferencePrice" TEXT,
  "clientOrderId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "providerOrderId" TEXT,
  "providerStatus" TEXT,
  "filledBaseQty" TEXT NOT NULL DEFAULT '0',
  "filledQuoteQty" TEXT NOT NULL DEFAULT '0',
  "averageFillPrice" TEXT,
  "feeAmount" TEXT,
  "feeAsset" TEXT,
  "error" TEXT,
  "submittedAt" DATETIME,
  "acknowledgedAt" DATETIME,
  "lastFillAt" DATETIME,
  "reconciledAt" DATETIME,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SpotExecutionOrder_exchangeAccountId_fkey"
    FOREIGN KEY ("exchangeAccountId") REFERENCES "ExchangeAccount" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SpotExecutionOrder_platformIntentId_key" ON "SpotExecutionOrder"("platformIntentId");
CREATE UNIQUE INDEX "SpotExecutionOrder_platformDedupeKey_key" ON "SpotExecutionOrder"("platformDedupeKey");
CREATE UNIQUE INDEX "SpotExecutionOrder_clientOrderId_key" ON "SpotExecutionOrder"("clientOrderId");
CREATE INDEX "SpotExecutionOrder_status_createdAt_idx" ON "SpotExecutionOrder"("status", "createdAt");
CREATE INDEX "SpotExecutionOrder_exchangeAccountId_venueSymbol_createdAt_idx"
  ON "SpotExecutionOrder"("exchangeAccountId", "venueSymbol", "createdAt");
