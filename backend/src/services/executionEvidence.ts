import type {
  ManualCommand, ManualOrder, PartialClose, StrategyOrderIntent,
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { normalizeSymbol } from "../lib/symbols.js";

export const MAX_LINKED_MANUAL_COMMANDS = 10;

export interface EvidenceEvent {
  evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT";
  type: string;
  occurredAt: string;
  state?: string;
  identifiers?: Record<string, string>;
  quantities?: Record<string, number>;
}

export interface StrategyExecutionEvidence {
  evidenceType: "STRATEGY_ORDER_INTENT";
  identity: {
    evidenceClass: "AUTHORITATIVE_LINKAGE";
    strategyOrderIntentId: string;
    sourceKey: string;
    callerDedupeKey: string;
    botId: string;
    clientOrderId: string;
    exchangeOrderId: string | null;
  };
  order: {
    symbol: string;
    side: string;
    orderType: string;
    requestedBaseQuantity: number | null;
    requestedQuoteQuantity: number | null;
    sellPercent: number | null;
    exitLeg: string | null;
    simulated: boolean;
  };
  events: EvidenceEvent[];
  currentState: {
    evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
    intentStatus: string;
    exchangeOrderStatus: string | null;
    cumulativeExecutedBaseQuantity: number;
    cumulativeExecutedQuoteQuantity: number;
    averageFillPrice: number | null;
    observedAt: string;
  };
  limitations: string[];
}

export interface ManualExecutionEvidence {
  evidenceType: "MANUAL_ORDER";
  identity: {
    evidenceClass: "AUTHORITATIVE_LINKAGE";
    manualOrderId: string;
    orderRequestId: string;
    clientOrderId: string;
    exchangeOrderId: string | null;
  };
  order: {
    symbol: string;
    side: string;
    orderType: string;
    quantityType: string;
    requestedBaseQuantity: number | null;
    requestedQuoteQuantity: number | null;
    limitPrice: number | null;
  };
  events: EvidenceEvent[];
  currentState: {
    evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
    orderStatus: string;
    cumulativeExecutedBaseQuantity: number;
    cumulativeExecutedQuoteQuantity: number;
    averageFillPrice: number | null;
    observedAt: string;
  };
  linkedCommands: Array<{
    identity: {
      evidenceClass: "AUTHORITATIVE_LINKAGE";
      manualCommandId: string;
      commandRequestId: string;
      targetManualOrderId: string;
    };
    event: EvidenceEvent;
    currentState: {
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE";
      commandStatus: string;
      observedAt: string;
    };
  }>;
  linkedCommandsTruncated: boolean;
  limitations: string[];
}

export interface ExecutionEvidenceStore {
  findBotBySecret(secret: string): Promise<{ id: string } | null>;
  findStrategyIntent(sourceKey: string): Promise<StrategyOrderIntent | null>;
  findPartialClose(strategyIntentId: string): Promise<PartialClose | null>;
  findManualOrder(input: { orderId?: string; orderRequestId?: string }): Promise<ManualOrder | null>;
  findCancelCommandCandidates(orderId: string, take: number): Promise<ManualCommand[]>;
}

const defaultStore: ExecutionEvidenceStore = {
  findBotBySecret: (secret) => prisma.signalBot.findUnique({
    where: { webhookSecret: secret }, select: { id: true },
  }),
  findStrategyIntent: (sourceKey) => prisma.strategyOrderIntent.findUnique({ where: { sourceKey } }),
  findPartialClose: (strategyIntentId) => prisma.partialClose.findUnique({
    where: { strategyIntentId },
  }),
  findManualOrder: ({ orderId, orderRequestId }) => prisma.manualOrder.findUnique({
    where: orderId ? { id: orderId } : { requestId: orderRequestId! },
  }),
  findCancelCommandCandidates: (orderId, take) => prisma.manualCommand.findMany({
    where: {
      kind: "cancel_order",
      status: "succeeded",
      result: { contains: `"id":"${orderId}"` },
    },
    orderBy: { createdAt: "asc" },
    take,
  }),
};

const iso = (value: Date): string => value.toISOString();

function partialCloseEvent(row: PartialClose): EvidenceEvent {
  return {
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "STRATEGY_PARTIAL_CLOSE_ACCOUNTING_APPLIED",
    occurredAt: iso(row.createdAt),
    identifiers: {
      partialCloseId: row.id,
      ...(row.exchangeOrderId ? { exchangeOrderId: row.exchangeOrderId } : {}),
    },
    quantities: {
      baseQuantity: row.quantity,
      quoteRevenue: row.revenue,
      averagePrice: row.avgPrice,
      realizedPnlQuote: row.pnlUsdt,
    },
  };
}

/** Exact persisted strategy lookup. Authentication is checked before order state is read. */
export async function readStrategyExecutionEvidence(input: {
  secret: string;
  symbol: string;
  side: "buy" | "sell";
  dedupeKey: string;
}, store: ExecutionEvidenceStore = defaultStore): Promise<{
  authenticated: boolean;
  evidence: StrategyExecutionEvidence | null;
}> {
  const bot = await store.findBotBySecret(input.secret);
  if (!bot) return { authenticated: false, evidence: null };
  const symbol = normalizeSymbol(input.symbol);
  const sourceKey = `${bot.id}:${symbol}:${input.side}:${input.dedupeKey}`;
  const intent = await store.findStrategyIntent(sourceKey);
  if (!intent) return { authenticated: true, evidence: null };
  const partialClose = await store.findPartialClose(intent.id);

  const events: EvidenceEvent[] = [{
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "STRATEGY_INTENT_PERSISTED",
    occurredAt: iso(intent.createdAt),
    state: "requested",
    identifiers: { strategyOrderIntentId: intent.id, sourceKey: intent.sourceKey },
  }];
  if (intent.submittedAt) events.push({
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "SUBMISSION_ATTEMPTED",
    occurredAt: iso(intent.submittedAt),
    state: "submitted",
    identifiers: { strategyOrderIntentId: intent.id, clientOrderId: intent.clientOrderId },
  });
  if (intent.reconciledAt) events.push({
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "STRATEGY_INTENT_RESOLVED",
    occurredAt: iso(intent.reconciledAt),
    state: intent.status,
    identifiers: {
      strategyOrderIntentId: intent.id,
      clientOrderId: intent.clientOrderId,
      ...(intent.exchangeOrderId ? { exchangeOrderId: intent.exchangeOrderId } : {}),
    },
    quantities: {
      cumulativeExecutedBaseQuantity: intent.filledBaseQty,
      cumulativeExecutedQuoteQuantity: intent.filledQuoteQty,
      ...(intent.averageFillPrice != null ? { averageFillPrice: intent.averageFillPrice } : {}),
    },
  });
  if (partialClose) events.push(partialCloseEvent(partialClose));

  return {
    authenticated: true,
    evidence: {
      evidenceType: "STRATEGY_ORDER_INTENT",
      identity: {
        evidenceClass: "AUTHORITATIVE_LINKAGE",
        strategyOrderIntentId: intent.id,
        sourceKey: intent.sourceKey,
        callerDedupeKey: input.dedupeKey,
        botId: intent.botId,
        clientOrderId: intent.clientOrderId,
        exchangeOrderId: intent.exchangeOrderId,
      },
      order: {
        symbol: intent.symbol,
        side: intent.side,
        orderType: intent.orderType,
        requestedBaseQuantity: intent.requestedBaseQty,
        requestedQuoteQuantity: intent.requestedQuoteQty,
        sellPercent: intent.sellPercent,
        exitLeg: intent.exitLeg,
        simulated: intent.simulated,
      },
      events,
      currentState: {
        evidenceClass: "CURRENT_AUTHORITATIVE_STATE",
        intentStatus: intent.status,
        exchangeOrderStatus: intent.exchangeStatus,
        cumulativeExecutedBaseQuantity: intent.filledBaseQty,
        cumulativeExecutedQuoteQuantity: intent.filledQuoteQty,
        averageFillPrice: intent.averageFillPrice,
        observedAt: iso(intent.updatedAt),
      },
      limitations: [
        "No individual exchange fills or prior cumulative snapshots are persisted for StrategyOrderIntent.",
        "The current-state observation does not prove unpersisted intermediate exchange transitions.",
      ],
    },
  };
}

function commandTargetsOrder(command: ManualCommand, orderId: string): boolean {
  if (!command.result) return false;
  try {
    const result = JSON.parse(command.result) as { id?: unknown };
    return result.id === orderId;
  } catch {
    return false;
  }
}

/** Exact persisted manual-order lookup. It performs no reconciliation or exchange operation. */
export async function readManualExecutionEvidence(input: {
  orderId?: string;
  orderRequestId?: string;
}, store: ExecutionEvidenceStore = defaultStore): Promise<ManualExecutionEvidence | null> {
  const order = await store.findManualOrder(input);
  if (!order) return null;
  const candidates = await store.findCancelCommandCandidates(
    order.id, MAX_LINKED_MANUAL_COMMANDS + 1);
  const linked = candidates.filter((command) => commandTargetsOrder(command, order.id));
  const linkedCommandsTruncated = linked.length > MAX_LINKED_MANUAL_COMMANDS;
  const commands = linked.slice(0, MAX_LINKED_MANUAL_COMMANDS);

  const requestIdentifiers = {
    manualOrderId: order.id,
    orderRequestId: order.requestId,
    clientOrderId: order.clientOrderId,
  };
  const events: EvidenceEvent[] = [{
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "MANUAL_ORDER_PERSISTED",
    occurredAt: iso(order.createdAt),
    state: "requested",
    identifiers: requestIdentifiers,
  }];
  if (order.submittedAt) events.push({
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "SUBMISSION_ATTEMPTED",
    occurredAt: iso(order.submittedAt),
    state: "submitted",
    identifiers: requestIdentifiers,
  });
  if (order.completedAt) events.push({
    evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
    type: "MANUAL_ORDER_COMPLETED",
    occurredAt: iso(order.completedAt),
    state: order.status,
    identifiers: {
      ...requestIdentifiers,
      ...(order.exchangeOrderId ? { exchangeOrderId: order.exchangeOrderId } : {}),
    },
    quantities: {
      cumulativeExecutedBaseQuantity: order.filledBaseQty,
      cumulativeExecutedQuoteQuantity: order.filledQuoteQty,
      ...(order.averageFillPrice != null ? { averageFillPrice: order.averageFillPrice } : {}),
    },
  });

  return {
    evidenceType: "MANUAL_ORDER",
    identity: {
      evidenceClass: "AUTHORITATIVE_LINKAGE",
      manualOrderId: order.id,
      orderRequestId: order.requestId,
      clientOrderId: order.clientOrderId,
      exchangeOrderId: order.exchangeOrderId,
    },
    order: {
      symbol: order.symbol,
      side: order.side,
      orderType: order.orderType,
      quantityType: order.quantityType,
      requestedBaseQuantity: order.requestedBaseQty,
      requestedQuoteQuantity: order.requestedQuoteQty,
      limitPrice: order.limitPrice,
    },
    events,
    currentState: {
      evidenceClass: "CURRENT_AUTHORITATIVE_STATE",
      orderStatus: order.status,
      cumulativeExecutedBaseQuantity: order.filledBaseQty,
      cumulativeExecutedQuoteQuantity: order.filledQuoteQty,
      averageFillPrice: order.averageFillPrice,
      observedAt: iso(order.updatedAt),
    },
    linkedCommands: commands.map((command) => ({
      identity: {
        evidenceClass: "AUTHORITATIVE_LINKAGE",
        manualCommandId: command.id,
        commandRequestId: command.requestId,
        targetManualOrderId: order.id,
      },
      event: {
        evidenceClass: "AUTHORITATIVE_HISTORICAL_EVENT",
        type: "MANUAL_CANCEL_COMMAND_PERSISTED",
        occurredAt: iso(command.createdAt),
        state: command.kind,
        identifiers: {
          manualCommandId: command.id,
          commandRequestId: command.requestId,
          targetManualOrderId: order.id,
        },
      },
      currentState: {
        evidenceClass: "CURRENT_AUTHORITATIVE_STATE",
        commandStatus: command.status,
        observedAt: iso(command.updatedAt),
      },
    })),
    linkedCommandsTruncated,
    limitations: [
      "No individual manual exchange fills or prior cumulative snapshots are persisted.",
      "Only successful cancel commands whose persisted result names this exact ManualOrder.id are linkable.",
      "ManualCommand.updatedAt is a current command observation, not a separately persisted completion event.",
    ],
  };
}
