-- WS-BOTCMD: durable, replay-safe record of each signed Platform control
-- command. Additive only: a new table, no change to any existing table.
CREATE TABLE "BotControlCommand" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "commandHash" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "stepUpMethod" TEXT NOT NULL,
  "stepUpAt" DATETIME,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "httpStatus" INTEGER,
  "result" TEXT,
  "error" TEXT,
  "code" TEXT,
  "intentId" TEXT,
  "attemptId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "BotControlCommand_requestId_key" ON "BotControlCommand"("requestId");
CREATE INDEX "BotControlCommand_createdAt_idx" ON "BotControlCommand"("createdAt");
