-- AlterTable
ALTER TABLE "SignalBot" ADD COLUMN "maxActiveSmartTradesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SignalBot" ADD COLUMN "maxActiveSmartTrades" INTEGER;
