/**
 * Feature B — "Archive / Hide from History", the one implementation behind the
 * Classic dashboard (`POST /api/trades/:id/archive|restore`) and the Platform's
 * signed control channel (`POST /control/trades/:id/archive`).
 *
 * It replaces deleting a closed trade. A delete erased realised P&L that feeds
 * the totals and the rolling daily-loss window, and so could lift a latched
 * daily-loss halt. Archiving is PRESENTATION STATE ONLY: it sets
 * `SmartTrade.archivedAt/archivedBy` and nothing else. No accounting or risk
 * read (riskControls, botView summaries, realization events, exports) filters
 * on these columns, and none may: an archived trade keeps every cent of its
 * P&L in every total and in the daily-loss window.
 *
 * Only a trade that is finished in every sense may be hidden: closed, with no
 * order that may still reach (or be working at) the exchange, and nothing the
 * operator still has to act on. Hiding such a trade would hide the problem, so
 * it is refused with a typed reason instead. Restoring is always allowed.
 */
import { z } from "zod";
import type { SmartTrade } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  ENTRY_WORKING_AFTER_EXIT, LATE_FILL_UNPROTECTED, PENDING_STATUSES, RACE_FILL_SWEEP,
} from "./manualTrading.js";

/** SmartTrade statuses that are terminal. `active` (and anything unknown) is not. */
export const ARCHIVABLE_TRADE_STATUSES = ["closed"] as const;

/** StrategyOrderIntent statuses whose exchange outcome is not yet resolved. */
const UNRESOLVED_INTENT_STATUSES = ["requested", "submitted"];

/** OD-1 cancel-first states in which a cancel is still owed or its outcome unknown. */
const CANCEL_OWED_STATES = ["pending", "unknown"];

/**
 * Trade-level protection states that mean the position is (or was left)
 * outside normal protection and the operator must look at it.
 */
const ATTENTION_PROTECTION_STATES = [LATE_FILL_UNPROTECTED, RACE_FILL_SWEEP, ENTRY_WORKING_AFTER_EXIT];

/**
 * Durable operator flags (manualTrading `DURABLE_FLAG_PREFIXES`) that still
 * ask for action on THIS trade. The rest are informational once the trade is
 * closed: `LATE FILL` (the late fill lives on as its own position, which is
 * the one needing attention), `DUST` (the remainder could not be sold and the
 * trade was closed deliberately), `ENTRY CANCELED AFTER EXIT` (resolved).
 */
const ATTENTION_FLAG_PREFIXES = [
  "LATE SELL FILL", "ENTRY STILL WORKING", "ENTRY REFRESH FAILED", "RACE FILL",
  "ENTRY CANCEL PENDING", "ENTRY CANCEL FAILED", "SWEEP FAILED", "NETTING UNCONFIRMED",
];

export type ArchiveBlockCode = "trade_not_closed" | "trade_has_unresolved_orders" | "trade_needs_attention";

export interface ArchiveBlock { code: ArchiveBlockCode; message: string }

export type ArchiveRefusalCode = ArchiveBlockCode | "not_found" | "invalid_id";

export class TradeArchiveRefusal extends Error {
  constructor(readonly status: number, readonly code: ArchiveRefusalCode, message: string) {
    super(message);
    this.name = "TradeArchiveRefusal";
  }
}

export interface TradeArchiveResult {
  id: string;
  archived: boolean;
  archivedAt: string | null;
  archivedBy: string | null;
  /** False when the trade was already in the requested state (idempotent). */
  changed: boolean;
}

type BlockerTrade = Pick<SmartTrade, "id" | "status" | "manualOrderId" | "protectiveOrderId" | "protectionState">;

const BLOCKER_SELECT = {
  id: true, status: true, manualOrderId: true, protectiveOrderId: true, protectionState: true,
} as const;

function hasAttentionFlag(error: string | null): boolean {
  return error != null && ATTENTION_FLAG_PREFIXES.some((prefix) => error.startsWith(prefix));
}

/**
 * Why each trade may not be archived (absent from the map = archivable).
 * Batched — three queries for any number of trades — so the History listings
 * can show the answer per row, and it is the same answer `setTradeArchived`
 * enforces.
 */
export async function findArchiveBlockers(trades: BlockerTrade[]): Promise<Map<string, ArchiveBlock>> {
  const blockers = new Map<string, ArchiveBlock>();
  const closed = trades.filter((trade) => {
    if ((ARCHIVABLE_TRADE_STATUSES as readonly string[]).includes(trade.status)) return true;
    blockers.set(trade.id, {
      code: "trade_not_closed",
      message: "Only a closed trade can be archived. Close it first.",
    });
    return false;
  });
  if (closed.length === 0) return blockers;

  const ids = closed.map((trade) => trade.id);
  const entryIds = closed.flatMap((trade) => (trade.manualOrderId ? [trade.manualOrderId] : []));
  const [openAttempts, unresolvedIntents, manualOrders] = await Promise.all([
    prisma.exchangeOrderAttempt.findMany({
      where: { smartTradeId: { in: ids }, status: "open" }, select: { smartTradeId: true },
    }),
    prisma.strategyOrderIntent.findMany({
      where: { smartTradeId: { in: ids }, status: { in: UNRESOLVED_INTENT_STATUSES } },
      select: { smartTradeId: true },
    }),
    prisma.manualOrder.findMany({
      where: { OR: [{ linkedPositionId: { in: ids } }, ...(entryIds.length ? [{ id: { in: entryIds } }] : [])] },
      select: { id: true, linkedPositionId: true, status: true, exitCancelState: true, error: true },
    }),
  ]);

  const unresolved = new Set<string>();
  for (const row of [...openAttempts, ...unresolvedIntents]) if (row.smartTradeId) unresolved.add(row.smartTradeId);
  const attention = new Set<string>();
  const tradeByEntry = new Map(closed.flatMap((trade) =>
    trade.manualOrderId ? [[trade.manualOrderId, trade.id] as const] : []));
  for (const order of manualOrders) {
    const owners = new Set<string>();
    if (order.linkedPositionId && ids.includes(order.linkedPositionId)) owners.add(order.linkedPositionId);
    const entryOwner = tradeByEntry.get(order.id);
    if (entryOwner) owners.add(entryOwner);
    for (const owner of owners) {
      if (PENDING_STATUSES.includes(order.status) || CANCEL_OWED_STATES.includes(order.exitCancelState ?? "")) {
        unresolved.add(owner);
      } else if (order.exitCancelState === "failed" || hasAttentionFlag(order.error)) {
        attention.add(owner);
      }
    }
  }

  for (const trade of closed) {
    if (trade.protectiveOrderId || unresolved.has(trade.id)) {
      blockers.set(trade.id, {
        code: "trade_has_unresolved_orders",
        message: "This trade still has an order that may be working at the exchange or whose outcome " +
          "is not known yet. It can be archived once that order is resolved.",
      });
    } else if (attention.has(trade.id) ||
      ATTENTION_PROTECTION_STATES.includes(trade.protectionState ?? "")) {
      blockers.set(trade.id, {
        code: "trade_needs_attention",
        message: "This trade carries an unresolved operator flag (for example a late or race fill, or an " +
          "entry cancel that failed). Resolve it first; an archived trade must not hide a problem.",
      });
    }
  }
  return blockers;
}

const tradeIdSchema = z.string().uuid();

/** A short, bounded actor label (`classic:<userId>`, `platform:<id>`). */
function actorLabel(actor: string): string {
  return actor.trim().slice(0, 120) || "unknown";
}

function resultOf(trade: Pick<SmartTrade, "id" | "archivedAt" | "archivedBy">, changed: boolean): TradeArchiveResult {
  return {
    id: trade.id,
    archived: trade.archivedAt != null,
    archivedAt: trade.archivedAt?.toISOString() ?? null,
    archivedBy: trade.archivedBy,
    changed,
  };
}

/**
 * Archive (`archived: true`) or restore (`false`) one trade. Idempotent: a
 * trade already in the requested state answers success with `changed: false`
 * and is not written. The write is conditional on the state that was judged
 * (`archivedAt: null` / `not null`), so two concurrent requests write once.
 *
 * Touches ONLY `archivedAt` / `archivedBy`. Never P&L, status, PartialClose
 * rows, realization events or the halt.
 */
export async function setTradeArchived(tradeId: string, archived: boolean, actor: string): Promise<TradeArchiveResult> {
  if (!tradeIdSchema.safeParse(tradeId).success) {
    throw new TradeArchiveRefusal(400, "invalid_id", "The trade id is not a valid id.");
  }
  const trade = await prisma.smartTrade.findUnique({
    where: { id: tradeId }, select: { ...BLOCKER_SELECT, archivedAt: true, archivedBy: true },
  });
  if (!trade) throw new TradeArchiveRefusal(404, "not_found", "Trade not found.");

  if (!archived) {
    if (trade.archivedAt == null) return resultOf(trade, false);
    const cleared = await prisma.smartTrade.updateMany({
      where: { id: tradeId, archivedAt: { not: null } }, data: { archivedAt: null, archivedBy: null },
    });
    const fresh = await prisma.smartTrade.findUniqueOrThrow({ where: { id: tradeId } });
    return resultOf(fresh, cleared.count === 1);
  }

  if (trade.archivedAt != null) return resultOf(trade, false);
  const block = (await findArchiveBlockers([trade])).get(trade.id);
  if (block) throw new TradeArchiveRefusal(409, block.code, block.message);
  const written = await prisma.smartTrade.updateMany({
    where: { id: tradeId, archivedAt: null, status: { in: [...ARCHIVABLE_TRADE_STATUSES] } },
    data: { archivedAt: new Date(), archivedBy: actorLabel(actor) },
  });
  const fresh = await prisma.smartTrade.findUniqueOrThrow({ where: { id: tradeId } });
  if (written.count === 0 && fresh.archivedAt == null) {
    // The status changed between the check and the write (it cannot reopen
    // today, but the guard costs nothing): refuse rather than claim success.
    throw new TradeArchiveRefusal(409, "trade_not_closed", "Only a closed trade can be archived.");
  }
  return resultOf(fresh, written.count === 1);
}

/** The History listing filter: `exclude` (default) hides archived trades. */
export const archivedFilterSchema = z.enum(["exclude", "include", "only"]);
export type ArchivedFilter = z.infer<typeof archivedFilterSchema>;

/** The Prisma `where` fragment for a listing filter. Listings only — never accounting. */
export function archivedWhere(filter: ArchivedFilter): { archivedAt?: null | { not: null } } {
  if (filter === "exclude") return { archivedAt: null };
  if (filter === "only") return { archivedAt: { not: null } };
  return {};
}
