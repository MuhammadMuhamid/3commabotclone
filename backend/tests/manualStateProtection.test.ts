/**
 * The manual state must say whether TP/SL is actually being checked.
 *
 * checkManualProtection returns early when manual trading is disabled or the
 * Bot is halted, and skips mainnet-account positions while mainnet manual
 * trading is off. Before this change `listManualState` always answered
 * "Checked by the bot poller", so the Platform showed halted positions as
 * protected. Additive fields only: `tradingHalted`, `protection.polling`,
 * `protection.haltedBy`, `protection.mainnetPositionsChecked`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const backendRoot = path.join(import.meta.dirname, "..");
const testDb = path.join(backendRoot, "prisma", "tests", ".manual-state-protection-test.db");
process.env.DATABASE_URL = "file:./tests/.manual-state-protection-test.db";
fs.rmSync(testDb, { force: true });
fs.rmSync(`${testDb}-journal`, { force: true });
execFileSync(process.execPath, ["./node_modules/prisma/build/index.js", "migrate", "deploy"],
  { cwd: backendRoot, env: process.env, stdio: "pipe" });

const { config } = await import("../src/config.js");
const { prisma } = await import("../src/lib/prisma.js");
const { listManualState } = await import("../src/services/manualTrading.js");
const { haltBotTrading, resumeBotTrading } = await import("../src/services/riskControls.js");

const previous = { manual: config.manualTradingEnabled, mainnet: config.mainnetManualTradingEnabled };
after(async () => {
  Object.assign(config, { manualTradingEnabled: previous.manual, mainnetManualTradingEnabled: previous.mainnet });
  await prisma.$disconnect();
  fs.rmSync(testDb, { force: true });
  fs.rmSync(`${testDb}-journal`, { force: true });
});

type State = { tradingHalted: boolean; protection: { polling: boolean; haltedBy: string | null;
  mainnetPositionsChecked: boolean; note: string } };

test("protection.polling is true and the note says checked only while the poller really runs", async () => {
  config.manualTradingEnabled = true;
  config.mainnetManualTradingEnabled = false;
  const running = await listManualState() as State;
  assert.equal(running.tradingHalted, false);
  assert.equal(running.protection.polling, true);
  assert.equal(running.protection.mainnetPositionsChecked, false);
  assert.match(running.protection.note, /Checked by the bot poller/);

  await haltBotTrading({ reason: "manual state test", by: "operator" });
  const halted = await listManualState() as State;
  assert.equal(halted.tradingHalted, true);
  assert.equal(halted.protection.polling, false, "a halted Bot does not check TP/SL");
  assert.equal(halted.protection.haltedBy, "operator");
  assert.match(halted.protection.note, /NOT being checked: the Bot is halted/);
  assert.doesNotMatch(halted.protection.note, /Checked by the bot poller/);

  await resumeBotTrading();
  config.manualTradingEnabled = false;
  const disabled = await listManualState() as State;
  assert.equal(disabled.protection.polling, false);
  assert.match(disabled.protection.note, /manual trading is disabled/);
});

test("positions carry their entry evidence (manualOrderId, exchangeOrderId) so a client can label dry-run positions", async () => {
  const acct = await prisma.exchangeAccount.create({ data: { name: "t", exchange: "binance", marketType: "spot",
    apiKeyEnc: "x", apiSecretEnc: "y", testnet: true } });
  const order = await prisma.manualOrder.create({ data: { requestId: "state-evidence-1", exchangeAccountId: acct.id,
    symbol: "BTCUSDT", side: "BUY", orderType: "MARKET", quantityType: "quote", requestedQuoteQty: 10,
    status: "filled", clientOrderId: "cid-state-evidence-1", exchangeOrderId: "dry-cid-state-evidence-1",
    filledBaseQty: 0.0001, filledQuoteQty: 10, averageFillPrice: 100000, protectionState: "none" } });
  await prisma.smartTrade.create({ data: { source: "manual", manualOrderId: order.id, exchangeAccountId: acct.id,
    botName: "Manual", pair: "BTCUSDT", direction: "long", status: "active", entryPrice: 100000, currentPrice: 100000,
    buyPrice: 100000, quantity: 0.0001, quoteSpent: 10, exchangeOrderId: "dry-cid-state-evidence-1",
    clientOrderId: "cid-state-evidence-1", protectionType: "bot-managed", protectionState: "none" } });
  const state = await listManualState("BTCUSDT") as { positions: { manualOrderId: string | null; exchangeOrderId: string | null }[] };
  const p = state.positions.find((x) => x.manualOrderId === order.id);
  assert.ok(p, "the position is listed with its entry order id");
  assert.equal(p.exchangeOrderId, "dry-cid-state-evidence-1");
});

