import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const backendRoot = path.join(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-intent-migration-"));
const scratchPrisma = path.join(scratch, "prisma");
const database = path.join(scratch, "populated.db");
const migrationName = "20260902000000_realization_events";
const databaseUrl = `file:${database}`;

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function deploy(): void {
  execFileSync(process.execPath, [
    path.join(backendRoot, "node_modules", "prisma", "build", "index.js"),
    "migrate", "deploy", "--schema", path.join(scratchPrisma, "schema.prisma"),
  ], { cwd: scratch, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" });
}

test("realization migration preserves history and creates no historical events", async () => {
  fs.mkdirSync(path.join(scratchPrisma, "migrations"), { recursive: true });
  fs.copyFileSync(
    path.join(backendRoot, "prisma", "schema.prisma"),
    path.join(scratchPrisma, "schema.prisma")
  );
  fs.copyFileSync(
    path.join(backendRoot, "prisma", "migrations", "migration_lock.toml"),
    path.join(scratchPrisma, "migrations", "migration_lock.toml")
  );
  for (const entry of fs.readdirSync(path.join(backendRoot, "prisma", "migrations"),
    { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === migrationName) continue;
    fs.cpSync(
      path.join(backendRoot, "prisma", "migrations", entry.name),
      path.join(scratchPrisma, "migrations", entry.name),
      { recursive: true }
    );
  }
  deploy();

  const before = new PrismaClient({ datasourceUrl: databaseUrl });
  await before.$executeRawUnsafe(`INSERT INTO SignalBot
    (id, name, pairs, webhookSecret, createdAt, updatedAt)
    VALUES ('bot-old', 'Historical bot', '["BTCUSDT"]', 'historical-secret', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await before.$executeRawUnsafe(`INSERT INTO SmartTrade
    (id, botId, botName, pair, status, direction, quantity, quoteSpent, pnlUsdt, pnlPct,
     source, createdAt, updatedAt)
    VALUES ('trade-old', 'bot-old', 'Historical bot', 'BTCUSDT', 'active', 'long', 1, 100, 0, 0,
     'strategy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
  await before.$executeRawUnsafe(`INSERT INTO PartialClose
    (id, tradeId, pct, quantity, revenue, pnlUsdt, avgPrice, exchangeOrderId, createdAt)
    VALUES
      ('partial-old-1', 'trade-old', 10, 0.1, 11, 0.89, 110, 'old-exchange-1', CURRENT_TIMESTAMP),
      ('partial-old-2', 'trade-old', 10, 0.1, 12, 1.89, 120, 'old-exchange-2', CURRENT_TIMESTAMP)`);
  await before.$disconnect();

  fs.cpSync(
    path.join(backendRoot, "prisma", "migrations", migrationName),
    path.join(scratchPrisma, "migrations", migrationName),
    { recursive: true }
  );
  deploy();

  const afterMigration = new PrismaClient({ datasourceUrl: databaseUrl });
  const trades = await afterMigration.$queryRawUnsafe<Array<{ id: string; quantity: number }>>(
    "SELECT id, quantity FROM SmartTrade WHERE id = 'trade-old'");
  const partials = await afterMigration.$queryRawUnsafe<
    Array<{ id: string; strategyIntentId: string | null }>>(
    "SELECT id, strategyIntentId FROM PartialClose ORDER BY id");
  const intents = await afterMigration.$queryRawUnsafe<Array<{ count: bigint }>>(
    "SELECT COUNT(*) AS count FROM StrategyOrderIntent");
  const events = await afterMigration.$queryRawUnsafe<Array<{ count: bigint }>>(
    "SELECT COUNT(*) AS count FROM RealizationEvent");
  await afterMigration.$disconnect();

  assert.deepEqual(trades, [{ id: "trade-old", quantity: 1 }]);
  assert.deepEqual(partials, [
    { id: "partial-old-1", strategyIntentId: null },
    { id: "partial-old-2", strategyIntentId: null },
  ]);
  assert.equal(Number(intents[0]?.count), 0);
  assert.equal(Number(events[0]?.count), 0);
});
