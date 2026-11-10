/**
 * P-81: the confirmed-execution feed the Trading Scene Platform reads to send
 * its own BUY/SELL push notifications. Contract `executions.v1`, which this Bot
 * advertises in the control capabilities.
 *
 * WHAT COUNTS AS AN EXECUTION
 * Only a fill the ledger has BOOKED. Each event is appended inside the same
 * database transaction that books the fill, at the three booking points:
 *
 *   - `applyAuthoritativeResult` (strategy BUY/SELL, also when the reconciler
 *     recovers an order after a crash or an unknown outcome);
 *   - `applyExitFill` (TP/SL and partial exits; it compare-and-sets first);
 *   - `applyManualSnapshot` (manual orders and manual TP/SL/sweep exits).
 *
 * A submitted, accepted, rejected, unknown or simulated-cancel order is never
 * an event. Booking rolls back, so does the event. A replayed booking cannot
 * append twice: these functions apply each fill once, and the event id is
 * unique.
 *
 * GRANULARITY
 * - Strategy and exit orders are MARKET orders that the ledger books once,
 *   with the whole executed amount: one event per order.
 * - Manual orders (LIMIT orders can fill in pieces) produce one event per
 *   newly booked fill increment. `orderComplete` and `cumulativeBaseQty` show
 *   where the order stands, so a later partial fill is never hidden.
 *
 * The Bot never sends anything here. It does not depend on the Platform: the
 * feed is a read the Platform polls over the signed channel. If the Platform
 * is down, nothing in trading changes.
 */
import { prisma } from "../lib/prisma.js";
import { EXECUTION_ENVIRONMENTS, type ExecutionEnvironment } from "./executionEnvironment.js";

export const EXECUTION_FEED_CAPABILITY = "executions.v1";
export const EXECUTION_FEED_MAX_LIMIT = 100;

export type ExecutionSource = "strategy" | "tpsl" | "partial" | "manual" | "manual-protection" | "manual-sweep";

export interface ExecutionEventV1 {
  contractVersion: 1;
  type: "BOT_EXECUTION";
  eventId: string;
  side: "BUY" | "SELL";
  symbol: string;
  /** Base quantity executed by THIS event (the fill increment for manual orders). */
  executedBaseQty: number;
  executedQuoteQty: number;
  /** Price of this event's quantity (quote / base). */
  averagePrice: number;
  environment: ExecutionEnvironment;
  source: ExecutionSource;
  /** True when the order has nothing more to fill. */
  orderComplete: boolean;
  /** Base quantity the order has filled in total, up to and including this event. */
  cumulativeBaseQty: number;
  botId: string | null;
  botName: string | null;
  smartTradeId: string | null;
  /** The exchange order id. A `dry-` id means simulated. */
  exchangeOrderId: string | null;
  executedAt: string;
}

const isEnvironment = (value: unknown): value is ExecutionEnvironment =>
  (EXECUTION_ENVIRONMENTS as readonly unknown[]).includes(value);

/**
 * The environment an execution declares. It is the order-level value recorded
 * when the order was created, never the current global setting. It becomes
 * UNKNOWN when:
 *   - nothing was recorded (older rows);
 *   - a simulated result or `dry-` id is recorded as TESTNET/MAINNET;
 *   - an exchange-assigned id is recorded as DRY_RUN.
 * MAINNET (shown to people as REAL) therefore always needs both a recorded
 * MAINNET route and an id the exchange assigned.
 */
export function confirmedEnvironment(
  recorded: string | null | undefined,
  evidence: { simulated?: boolean; exchangeOrderId?: string | null }
): ExecutionEnvironment {
  if (!isEnvironment(recorded) || recorded === "UNKNOWN") return "UNKNOWN";
  const simulated = evidence.simulated === true || (evidence.exchangeOrderId ?? "").startsWith("dry-");
  if (simulated) return recorded === "DRY_RUN" ? "DRY_RUN" : "UNKNOWN";
  if (recorded === "DRY_RUN") return "UNKNOWN";
  return recorded;
}

const finite = (value: number): number => (Number.isFinite(value) ? Number(value.toPrecision(12)) : 0);

/** Structural, in the idiom `persistStrategyRealization` uses (the client is extended). */
type EventWriter = { executionEvent: {
  findUnique(args: { where: { id: string }; select: { seq: true } }): Promise<unknown>;
  create(args: { data: { id: string; payload: string } }): Promise<unknown>;
} };

/**
 * Append one confirmed execution. Call it only inside the transaction that
 * books the fill. Returns false when this event id already exists (a replay),
 * and appends nothing.
 */
export async function recordExecutionEvent(
  tx: EventWriter,
  input: Omit<ExecutionEventV1, "contractVersion" | "type" | "executedAt"> & { executedAt?: Date }
): Promise<boolean> {
  if (!(input.executedBaseQty > 0)) return false;
  if ((await tx.executionEvent.findUnique({ where: { id: input.eventId }, select: { seq: true } })) !== null) {
    return false;
  }
  const event: ExecutionEventV1 = {
    contractVersion: 1,
    type: "BOT_EXECUTION",
    eventId: input.eventId,
    side: input.side,
    symbol: input.symbol,
    executedBaseQty: finite(input.executedBaseQty),
    executedQuoteQty: finite(input.executedQuoteQty),
    averagePrice: finite(input.averagePrice),
    environment: input.environment,
    source: input.source,
    orderComplete: input.orderComplete,
    cumulativeBaseQty: finite(input.cumulativeBaseQty),
    botId: input.botId,
    botName: input.botName,
    smartTradeId: input.smartTradeId,
    exchangeOrderId: input.exchangeOrderId,
    executedAt: (input.executedAt ?? new Date()).toISOString(),
  };
  await tx.executionEvent.create({ data: { id: event.eventId, payload: JSON.stringify(event) } });
  return true;
}

export interface ExecutionFeedPage {
  contractVersion: 1;
  /** The highest seq on file (0 when empty). A first reader starts here. */
  latestSeq: number;
  /** Pass this as `after` next time. */
  nextAfter: number;
  events: Array<ExecutionEventV1 & { seq: number }>;
}

/**
 * One page of the feed, oldest first, strictly after `after`. With no `after`,
 * only the cursor is returned: a new reader starts from now and does not
 * replay history as notifications.
 */
export async function readExecutionFeed(after: number | null, limit: number): Promise<ExecutionFeedPage> {
  const latest = await prisma.executionEvent.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } });
  const latestSeq = latest?.seq ?? 0;
  if (after === null) return { contractVersion: 1, latestSeq, nextAfter: latestSeq, events: [] };
  const rows = await prisma.executionEvent.findMany({
    where: { seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: Math.max(1, Math.min(EXECUTION_FEED_MAX_LIMIT, limit)),
  });
  const events: ExecutionFeedPage["events"] = [];
  for (const row of rows) {
    try {
      events.push({ ...(JSON.parse(row.payload) as ExecutionEventV1), seq: row.seq });
    } catch {
      // A stored row this code wrote cannot be unparseable. If one ever is,
      // skip it rather than block every later event.
      console.error(`[executions] unreadable event seq=${row.seq}`);
    }
  }
  const nextAfter = rows.length > 0 ? rows[rows.length - 1]!.seq : after;
  return { contractVersion: 1, latestSeq, nextAfter, events };
}

/** Retention: the feed is a notification source, not a ledger. */
export const EXECUTION_EVENT_RETENTION_DAYS = 30;

export async function pruneExecutionEvents(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - EXECUTION_EVENT_RETENTION_DAYS * 86_400_000);
  // The newest row always stays, so `latestSeq` never moves backwards.
  const latest = await prisma.executionEvent.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } });
  if (!latest) return 0;
  const { count } = await prisma.executionEvent.deleteMany({
    where: { createdAt: { lt: cutoff }, seq: { lt: latest.seq } },
  });
  return count;
}
