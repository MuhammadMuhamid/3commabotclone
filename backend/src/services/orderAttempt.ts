import { Prisma, type ExchangeOrderAttempt } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { clientOrderId } from "./binance.js";

/**
 * The durable attempt identity that BOT-P1-1 found missing.
 *
 * Three paths place exchange orders without reserving a `StrategyOrderIntent`:
 * the dashboard partial close, the TP/SL monitor, and the manual protection
 * poller. Each derived its client order id from a scope naming only the
 * position and a non-unique discriminator, so two genuinely distinct orders
 * presented the SAME id to Binance — and the duplicate-rejection recovery in
 * `marketSellBase`, which is correct for a true retry, then resolved the new
 * order to the earlier order's fill.
 *
 * `intentKey` is the logical order slot. Within it, exactly one attempt is
 * `open`:
 *
 *   - a retry or crash recovery of the SAME logical order finds that open row
 *     and reuses its client order id, so query-first recovery still resolves
 *     against the one exchange order that belongs to this intent;
 *   - a genuinely NEW logical order can only be opened after the previous
 *     attempt was settled, and settlement is what applying its fill does, so
 *     the new order necessarily carries a different id.
 *
 * The counter is durable and monotonic. It is deliberately not a clock: a
 * restart must not change the id of an order that is already admitted, and a
 * random or time-based component would make crash recovery impossible.
 */
export interface OpenAttemptInput {
  /** Stable identity of the logical order slot, e.g. `partial:<tradeId>:<pct>`. */
  intentKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  /**
   * BOT-P1-5: the position this exit belongs to, and which authority owns it.
   *
   * `intentKey` names the trade, but only inside a string — it is not a query.
   * Close admission had no way to ask "does this position hold an exit that may
   * already have reached the exchange?", so after a restart, with the
   * in-process close lock gone, a durable TP/SL/partial-close attempt was
   * invisible to it and a second overlapping SELL could be sent.
   */
  smartTradeId?: string;
  origin?: ExitAttemptOrigin;
  /** Requested base quantity. Intent only — it is never accounting evidence. */
  requestedBaseQty?: number;
  /** Partial-close percentage, so a recovery can write the `PartialClose` row. */
  sellPercent?: number;
  /** What to stamp on the trade if this exit ends up covering the position. */
  closedReason?: string;
}

/**
 * Which exit authority owns an attempt.
 *
 * Recovery dispatches on this: `tpsl` and `partial` settle through the shared
 * position-accounting authority in `exitSettlement.ts`, while
 * `manual-protection` is booked by the manual `ManualOrder` lifecycle and must
 * never be applied twice by a second resolver.
 */
export type ExitAttemptOrigin = "tpsl" | "partial" | "manual-protection";

/**
 * The attempt that currently owns `intentKey`, creating the next one when the
 * previous attempt has been settled.
 */
export async function openOrderAttempt(input: OpenAttemptInput): Promise<ExchangeOrderAttempt> {
  const existing = await prisma.exchangeOrderAttempt.findFirst({
    where: { intentKey: input.intentKey, status: "open" },
    orderBy: { attempt: "desc" },
  });
  if (existing) return existing;

  // `attempt` is derived from what is already on file rather than from a
  // counter held in memory, so a process restart continues the same sequence
  // instead of colliding with it.
  for (let retry = 0; retry < 5; retry += 1) {
    const last = await prisma.exchangeOrderAttempt.findFirst({
      where: { intentKey: input.intentKey },
      orderBy: { attempt: "desc" },
      select: { attempt: true },
    });
    const attempt = (last?.attempt ?? 0) + 1;
    try {
      return await prisma.exchangeOrderAttempt.create({ data: {
        intentKey: input.intentKey,
        attempt,
        clientOrderId: clientOrderId(`${input.intentKey}#${attempt}`),
        symbol: input.symbol,
        side: input.side,
        smartTradeId: input.smartTradeId,
        origin: input.origin,
        requestedBaseQty: input.requestedBaseQty,
        sellPercent: input.sellPercent,
        closedReason: input.closedReason,
      }});
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
        throw error;
      }
      // Another worker claimed this attempt number between the read and the
      // write. Whatever it claimed is now the open attempt for this slot, so
      // adopt it rather than racing past it with a second live order.
      const claimed = await prisma.exchangeOrderAttempt.findFirst({
        where: { intentKey: input.intentKey, status: "open" },
        orderBy: { attempt: "desc" },
      });
      if (claimed) return claimed;
    }
  }
  throw new Error(`Could not reserve an order attempt for ${input.intentKey}`);
}

/**
 * Close an attempt, returning whether THIS caller was the one that closed it.
 *
 * Call it inside the same transaction that applies the fill. The compare-and
 * set is then the exactly-once key: a recovered fill is applied by whichever
 * caller wins the transition, and by nobody a second time — which is what stops
 * a duplicate-id recovery from reducing the position or booking P&L twice.
 */
export async function settleOrderAttempt(
  /**
   * Structural, in the idiom `persistStrategyRealization` already uses: the
   * caller passes its own interactive-transaction client, and this needs
   * exactly one write from it.
   */
  tx: {
    exchangeOrderAttempt: {
      updateMany(args: {
        where: { id: string; status: string };
        data: { status: string; settledAt: Date; exchangeOrderId?: string };
      }): Promise<{ count: number }>;
    };
  },
  attemptId: string,
  exchangeOrderId?: string
): Promise<boolean> {
  const settled = await tx.exchangeOrderAttempt.updateMany({
    where: { id: attemptId, status: "open" },
    data: { status: "settled", settledAt: new Date(), ...(exchangeOrderId ? { exchangeOrderId } : {}) },
  });
  return settled.count === 1;
}

/**
 * Record that this attempt is about to cross the submission boundary.
 *
 * Called immediately BEFORE the exchange request, never after. That ordering is
 * the whole value: an attempt still carrying a null `submittedAt` durably
 * proves no order was ever sent under its client order id, which is what lets
 * recovery read `-2013` as real absence without waiting out the uncertainty
 * window. It is the same distinction `StrategyOrderIntent` draws between
 * `requested` and `submitted`.
 *
 * Idempotent: a retry of the SAME logical order keeps the first submission's
 * timestamp, because the uncertainty window belongs to the earliest moment an
 * order could have reached the exchange, not the latest.
 */
export async function markOrderAttemptSubmitted(
  attemptId: string,
  requestedBaseQty?: number
): Promise<void> {
  await prisma.exchangeOrderAttempt.updateMany({
    where: { id: attemptId, submittedAt: null },
    data: { submittedAt: new Date(), ...(requestedBaseQty != null ? { requestedBaseQty } : {}) },
  });
}

/**
 * End an attempt that the exchange proved moved no base asset.
 *
 * Distinct from `settleOrderAttempt` on purpose: `settled` means "this fill was
 * applied", and nothing was applied here. Both free the slot — `openOrderAttempt`
 * only ever adopts a row whose status is `open` — so a later legitimate exit can
 * still be placed for whatever exposure remains.
 */
export async function abandonOrderAttempt(
  attemptId: string,
  exchangeStatus: string
): Promise<boolean> {
  const closed = await prisma.exchangeOrderAttempt.updateMany({
    // Compare-and-set on `open`, so a concurrent resolver that already applied a
    // fill always wins and this call abandons nothing.
    where: { id: attemptId, status: "open" },
    data: { status: "abandoned", settledAt: new Date(), exchangeStatus },
  });
  return closed.count === 1;
}

/** Record what the exchange last said about an attempt. Evidence, not a decision. */
export async function recordOrderAttemptObservation(
  attemptId: string,
  exchangeStatus: string
): Promise<void> {
  await prisma.exchangeOrderAttempt.updateMany({
    where: { id: attemptId, status: "open" },
    data: { exchangeStatus },
  });
}
