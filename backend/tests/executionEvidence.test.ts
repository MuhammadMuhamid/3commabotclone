import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ManualCommand, ManualOrder, PartialClose, StrategyOrderIntent,
} from "@prisma/client";
import {
  MAX_LINKED_MANUAL_COMMANDS, readManualExecutionEvidence,
  readStrategyExecutionEvidence, type ExecutionEvidenceStore,
} from "../src/services/executionEvidence.js";
import { manualEvidenceLookupSchema } from "../src/routes/manualTrading.js";
import { strategyExecutionEvidenceSchema } from "../src/routes/webhookSchema.js";
import { verifyManualRequest } from "../src/services/manualAuth.js";

const at = (seconds: number): Date => new Date(Date.UTC(2026, 8, 1, 12, 0, seconds));

function strategyIntent(overrides: Partial<StrategyOrderIntent> = {}): StrategyOrderIntent {
  return {
    id: "intent-1",
    sourceKey: "bot-1:BTCUSDT:buy:L-1788264000000",
    webhookLogId: "webhook-1",
    botId: "bot-1",
    botName: "Strategy bot",
    exchangeAccountId: "account-1",
    clientOrderId: "client-strategy-1",
    symbol: "BTCUSDT",
    side: "BUY",
    orderType: "MARKET",
    requestedBaseQty: null,
    requestedQuoteQty: 100,
    sellPercent: null,
    exitLeg: null,
    skipExitCheck: false,
    smartTradeId: null,
    status: "submitted",
    exchangeOrderId: null,
    exchangeStatus: null,
    filledBaseQty: 0,
    filledQuoteQty: 0,
    averageFillPrice: null,
    simulated: false,
    error: null,
    submittedAt: at(1),
    reconciledAt: null,
    createdAt: at(0),
    updatedAt: at(2),
    ...overrides,
  };
}

function manualOrder(overrides: Partial<ManualOrder> = {}): ManualOrder {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requestId: "order_request_123456",
    exchangeAccountId: "account-manual",
    linkedPositionId: null,
    symbol: "ETHUSDT",
    side: "BUY",
    orderType: "LIMIT",
    quantityType: "quote",
    requestedBaseQty: null,
    requestedQuoteQty: 200,
    limitPrice: 2000,
    takeProfitPrice: null,
    stopLossPrice: null,
    protectionType: null,
    protectionState: "none",
    status: "partially_filled",
    exchangeOrderId: "exchange-manual-1",
    clientOrderId: "client-manual-1",
    filledBaseQty: 0.05,
    filledQuoteQty: 100,
    averageFillPrice: 2000,
    error: null,
    submittedAt: at(1),
    completedAt: null,
    createdAt: at(0),
    updatedAt: at(3),
    ...overrides,
  };
}

function command(index: number, targetOrderId: string): ManualCommand {
  return {
    id: `command-${index}`,
    requestId: `cancel_request_${String(index).padStart(3, "0")}`,
    kind: "cancel_order",
    status: "succeeded",
    result: JSON.stringify({ id: targetOrderId, requestId: "order_request_123456" }),
    error: null,
    createdAt: at(10 + index),
    updatedAt: at(20 + index),
  };
}

function store(input: {
  bot?: { id: string } | null;
  intent?: StrategyOrderIntent | null;
  partialClose?: PartialClose | null;
  order?: ManualOrder | null;
  commands?: ManualCommand[];
  calls?: string[];
} = {}): ExecutionEvidenceStore {
  const calls = input.calls ?? [];
  return {
    findBotBySecret: async () => {
      calls.push("findBotBySecret");
      return input.bot === undefined ? { id: "bot-1" } : input.bot;
    },
    findStrategyIntent: async (sourceKey) => {
      calls.push(`findStrategyIntent:${sourceKey}`);
      return input.intent === undefined ? strategyIntent({ sourceKey }) : input.intent;
    },
    findPartialClose: async () => { calls.push("findPartialClose"); return input.partialClose ?? null; },
    findManualOrder: async (identity) => {
      calls.push(`findManualOrder:${identity.orderId ?? identity.orderRequestId}`);
      return input.order === undefined ? manualOrder() : input.order;
    },
    findCancelCommandCandidates: async (_orderId, take) => {
      calls.push(`findCancelCommandCandidates:${take}`);
      return (input.commands ?? []).slice(0, take);
    },
  };
}

test("exact Platform source identity returns the linked StrategyOrderIntent", async () => {
  const evidence = await readStrategyExecutionEvidence({
    secret: "s".repeat(40), symbol: "BINANCE:BTC/USDT", side: "buy",
    dedupeKey: "L-1788264000000",
  }, store());
  assert.equal(evidence.authenticated, true);
  assert.equal(evidence.evidence?.identity.sourceKey, "bot-1:BTCUSDT:buy:L-1788264000000");
  assert.equal(evidence.evidence?.identity.strategyOrderIntentId, "intent-1");
  assert.equal(evidence.evidence?.identity.callerDedupeKey, "L-1788264000000");
});

test("invalid authentication reads no intent and an unknown exact source is safely absent", async () => {
  const invalidCalls: string[] = [];
  const invalid = await readStrategyExecutionEvidence({
    secret: "x".repeat(40), symbol: "BTCUSDT", side: "buy", dedupeKey: "L-1",
  }, store({ bot: null, calls: invalidCalls }));
  assert.deepEqual(invalid, { authenticated: false, evidence: null });
  assert.deepEqual(invalidCalls, ["findBotBySecret"]);

  const unknown = await readStrategyExecutionEvidence({
    secret: "s".repeat(40), symbol: "BTCUSDT", side: "buy", dedupeKey: "L-unknown",
  }, store({ intent: null }));
  assert.deepEqual(unknown, { authenticated: true, evidence: null });
});

test("a submitted current snapshot fabricates no accepted/open/fill lifecycle events", async () => {
  const result = await readStrategyExecutionEvidence({
    secret: "s".repeat(40), symbol: "BTCUSDT", side: "buy", dedupeKey: "L-1788264000000",
  }, store());
  const evidence = result.evidence!;
  assert.deepEqual(evidence.events.map((event) => event.type),
    ["STRATEGY_INTENT_PERSISTED", "SUBMISSION_ATTEMPTED"]);
  assert.equal(evidence.currentState.intentStatus, "submitted");
  assert.equal(evidence.currentState.observedAt, at(2).toISOString());
  assert.equal(evidence.events.some((event) => /ACCEPTED|OPEN|FILL/.test(event.type)), false);
});

test("terminal StrategyOrderIntent and exact partial-close accounting retain real timestamps", async () => {
  const partialClose: PartialClose = {
    id: "partial-1", tradeId: "trade-1", pct: 50, quantity: 0.04, revenue: 120,
    pnlUsdt: 20, avgPrice: 3000, exchangeOrderId: "exchange-strategy-1",
    strategyIntentId: "intent-1", createdAt: at(5),
  };
  const intent = strategyIntent({
    status: "reconciled", exchangeOrderId: "exchange-strategy-1", exchangeStatus: "FILLED",
    filledBaseQty: 0.04, filledQuoteQty: 120, averageFillPrice: 3000,
    reconciledAt: at(4), updatedAt: at(4), clientOrderId: "client-strategy-1",
  });
  const result = await readStrategyExecutionEvidence({
    secret: "s".repeat(40), symbol: "BTCUSDT", side: "buy", dedupeKey: "L-1788264000000",
  }, store({ intent, partialClose }));
  const evidence = result.evidence!;
  assert.deepEqual(evidence.events.map((event) => [event.type, event.occurredAt]), [
    ["STRATEGY_INTENT_PERSISTED", at(0).toISOString()],
    ["SUBMISSION_ATTEMPTED", at(1).toISOString()],
    ["STRATEGY_INTENT_RESOLVED", at(4).toISOString()],
    ["STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED", at(5).toISOString()],
  ]);
  assert.deepEqual(evidence.identity, {
    evidenceClass: "AUTHORITATIVE_LINKAGE", strategyOrderIntentId: "intent-1",
    sourceKey: intent.sourceKey, callerDedupeKey: "L-1788264000000", botId: "bot-1",
    clientOrderId: "client-strategy-1", exchangeOrderId: "exchange-strategy-1",
  });
  assert.equal(evidence.currentState.cumulativeExecutedBaseQuantity, 0.04);
});

test("manual lookup returns only the exact order's persisted evidence and cumulative snapshot", async () => {
  const calls: string[] = [];
  const evidence = await readManualExecutionEvidence({
    orderRequestId: "order_request_123456",
  }, store({ calls }));
  assert.equal(evidence?.identity.manualOrderId, "11111111-1111-4111-8111-111111111111");
  assert.equal(evidence?.identity.orderRequestId, "order_request_123456");
  assert.equal(evidence?.identity.clientOrderId, "client-manual-1");
  assert.equal(evidence?.identity.exchangeOrderId, "exchange-manual-1");
  assert.equal(evidence?.currentState.cumulativeExecutedBaseQuantity, 0.05);
  assert.deepEqual(evidence?.events.map((event) => event.type),
    ["MANUAL_ORDER_PERSISTED", "SUBMISSION_ATTEMPTED"]);
  assert.ok(calls.includes("findCancelCommandCandidates:11"));
});

test("unknown manual order identity is safely absent", async () => {
  const evidence = await readManualExecutionEvidence({
    orderId: "33333333-3333-4333-8333-333333333333",
  }, store({ order: null }));
  assert.equal(evidence, null);
});

test("only a cancel command whose persisted result names the exact order is linked", async () => {
  const order = manualOrder({ status: "canceled", completedAt: at(8), updatedAt: at(8) });
  const linked = command(1, order.id);
  const unrelated = command(2, "22222222-2222-4222-8222-222222222222");
  const malformed = { ...command(3, order.id), id: "malformed", result: "not-json" };
  const evidence = await readManualExecutionEvidence({ orderId: order.id },
    store({ order, commands: [linked, unrelated, malformed] }));
  assert.equal(evidence?.linkedCommands.length, 1);
  assert.equal(evidence?.linkedCommands[0]?.identity.manualCommandId, "command-1");
  assert.equal(evidence?.linkedCommands[0]?.identity.commandRequestId, "cancel_request_001");
  assert.equal(evidence?.linkedCommands[0]?.event.occurredAt, at(11).toISOString());
  assert.equal(evidence?.linkedCommands[0]?.currentState.observedAt, at(21).toISOString());
  assert.equal(evidence?.events.at(-1)?.type, "MANUAL_ORDER_COMPLETED");
});

test("linked manual command results are hard-bounded", async () => {
  const order = manualOrder();
  const commands = Array.from({ length: MAX_LINKED_MANUAL_COMMANDS + 1 }, (_, i) =>
    command(i, order.id));
  const evidence = await readManualExecutionEvidence({ orderId: order.id },
    store({ order, commands }));
  assert.equal(evidence?.linkedCommands.length, MAX_LINKED_MANUAL_COMMANDS);
  assert.equal(evidence?.linkedCommandsTruncated, true);
});

test("lookup schemas preserve identifier semantics and existing authentication", () => {
  const secret = "s".repeat(40);
  assert.equal(strategyExecutionEvidenceSchema.safeParse({
    secret, symbol: "BTCUSDT", action: "buy", dedupe_key: "L-1",
  }).success, true);
  assert.equal(strategyExecutionEvidenceSchema.safeParse({
    secret, symbol: "BTCUSDT", action: "buy", dedupe_key: "L-1", clientOrderId: "wrong-kind",
  }).success, false);
  assert.equal(manualEvidenceLookupSchema.safeParse({
    orderId: "11111111-1111-4111-8111-111111111111",
  }).success, true);
  assert.equal(manualEvidenceLookupSchema.safeParse({ orderRequestId: "order_request_123456" }).success, true);
  assert.equal(manualEvidenceLookupSchema.safeParse({
    orderId: "11111111-1111-4111-8111-111111111111", orderRequestId: "order_request_123456",
  }).success, false);

  const auth = verifyManualRequest({ secret, method: "POST",
    path: "/api/manual-trading/execution-evidence/manual-orders/lookup" });
  assert.deepEqual(auth, { ok: false, status: 401, error: "manual command authentication required" });
});

test("evidence readers expose only injected persisted reads and no execution/network operation", async () => {
  const calls: string[] = [];
  const evidenceStore = store({ calls });
  await readStrategyExecutionEvidence({
    secret: "s".repeat(40), symbol: "BTCUSDT", side: "buy", dedupeKey: "L-1788264000000",
  }, evidenceStore);
  await readManualExecutionEvidence({ orderId: manualOrder().id }, evidenceStore);
  assert.deepEqual(calls, [
    "findBotBySecret",
    "findStrategyIntent:bot-1:BTCUSDT:buy:L-1788264000000",
    "findPartialClose",
    "findManualOrder:11111111-1111-4111-8111-111111111111",
    "findCancelCommandCandidates:11",
  ]);
});
