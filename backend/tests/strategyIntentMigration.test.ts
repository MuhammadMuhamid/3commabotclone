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

/*
 * The v5 replay column, applied to a database that already holds order intents.
 *
 * This is the only structurally risky step in the single-use-authorisation
 * change: adding a UNIQUE index to a populated table. Two things have to hold
 * and neither is safe to merely assume.
 *
 * First, every historical row gets NULL — no intent admitted before this
 * feature existed may be reclassified, and none may be made to look like it
 * spent an authorisation.
 *
 * Second, those NULLs must not collide with each other. SQLite treats NULLs as
 * distinct in a unique index, which is the entire reason this column can live
 * on a table where the overwhelming majority of rows — every SELL, every manual
 * order, everything admitted while enforcement is off — will never carry one.
 * If that were not true, the second such row in the installation's history
 * would fail to insert, and it would fail at the admission boundary of a live
 * order.
 */
test("the authorisation-nonce column is additive over a populated intent table", async () => {
  const scratch2 = fs.mkdtempSync(path.join(os.tmpdir(), "authorisation-nonce-migration-"));
  const prisma2 = path.join(scratch2, "prisma");
  const db2 = path.join(scratch2, "populated.db");
  const url2 = `file:${db2}`;
  const target = "20260903000000_shariah_authorization_nonce";

  const deploy2 = () => execFileSync(process.execPath, [
    path.join(backendRoot, "node_modules", "prisma", "build", "index.js"),
    "migrate", "deploy", "--schema", path.join(prisma2, "schema.prisma"),
  ], { cwd: scratch2, env: { ...process.env, DATABASE_URL: url2 }, stdio: "pipe" });

  try {
    fs.mkdirSync(path.join(prisma2, "migrations"), { recursive: true });
    fs.copyFileSync(path.join(backendRoot, "prisma", "schema.prisma"),
      path.join(prisma2, "schema.prisma"));
    fs.copyFileSync(path.join(backendRoot, "prisma", "migrations", "migration_lock.toml"),
      path.join(prisma2, "migrations", "migration_lock.toml"));
    // Everything EXCEPT the migration under test: this is the pre-v5 database.
    for (const entry of fs.readdirSync(path.join(backendRoot, "prisma", "migrations"),
      { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === target) continue;
      fs.cpSync(path.join(backendRoot, "prisma", "migrations", entry.name),
        path.join(prisma2, "migrations", entry.name), { recursive: true });
    }
    deploy2();

    const before = new PrismaClient({ datasourceUrl: url2 });
    await before.$executeRawUnsafe(`INSERT INTO SignalBot
      (id, name, pairs, webhookSecret, createdAt, updatedAt)
      VALUES ('bot-v4', 'Pre-v5 bot', '["APTUSDT"]', 'pre-v5-secret', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    for (const n of [1, 2, 3]) {
      await before.$executeRawUnsafe(`INSERT INTO StrategyOrderIntent
        (id, sourceKey, botId, botName, clientOrderId, symbol, side, orderType,
         status, filledBaseQty, filledQuoteQty, simulated, skipExitCheck, createdAt, updatedAt)
        VALUES ('intent-v4-${n}', 'scope-v4-${n}', 'bot-v4', 'Pre-v5 bot', 'coid-v4-${n}',
         'APTUSDT', 'BUY', 'MARKET', 'reconciled', 1, 100, 0, 0,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    }
    await before.$disconnect();

    // Apply the migration under test.
    fs.cpSync(path.join(backendRoot, "prisma", "migrations", target),
      path.join(prisma2, "migrations", target), { recursive: true });
    deploy2();

    const after2 = new PrismaClient({ datasourceUrl: url2 });
    const rows = await after2.$queryRawUnsafe<
      Array<{ id: string; authorizationNonceHash: string | null }>>(
      "SELECT id, authorizationNonceHash FROM StrategyOrderIntent ORDER BY id");
    assert.deepEqual(rows, [
      { id: "intent-v4-1", authorizationNonceHash: null },
      { id: "intent-v4-2", authorizationNonceHash: null },
      { id: "intent-v4-3", authorizationNonceHash: null },
    ], "no historical intent may be reclassified as having spent an authorisation");

    // A fourth NULL still inserts: the unique index does not collapse them.
    await after2.$executeRawUnsafe(`INSERT INTO StrategyOrderIntent
      (id, sourceKey, botId, botName, clientOrderId, symbol, side, orderType,
       status, filledBaseQty, filledQuoteQty, simulated, skipExitCheck, createdAt, updatedAt)
      VALUES ('intent-v5-null', 'scope-v5-null', 'bot-v4', 'Pre-v5 bot', 'coid-v5-null',
       'APTUSDT', 'SELL', 'MARKET', 'requested', 0, 0, 0, 0,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    // And a real authorisation is genuinely unique.
    const insertClaim = (id: string) => after2.$executeRawUnsafe(`INSERT INTO StrategyOrderIntent
      (id, sourceKey, botId, botName, clientOrderId, symbol, side, orderType,
       status, filledBaseQty, filledQuoteQty, simulated, skipExitCheck,
       authorizationNonceHash, createdAt, updatedAt)
      VALUES ('${id}', 'scope-${id}', 'bot-v4', 'Pre-v5 bot', 'coid-${id}',
       'APTUSDT', 'BUY', 'MARKET', 'requested', 0, 0, 0, 0,
       'the-same-authorisation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await insertClaim("intent-v5-a");
    await assert.rejects(() => insertClaim("intent-v5-b"),
      "the unique index must refuse a second claim on one authorisation");

    await after2.$disconnect();
  } finally {
    fs.rmSync(scratch2, { recursive: true, force: true });
  }
});
