/**
 * Durable tracker for recent trade closes per (botId, pair).
 *
 * ── The problem it solves ─────────────────────────────────────────────────
 *
 * A SELL webhook is meant to close Trade A. But Trade A was already closed —
 * manually from the dashboard, by TP/SL, or by the manual-close sync — and on
 * the same candle a new Trade B was opened. Without this guard the SELL closes
 * Trade B: the wrong trade.
 *
 * ── Why it is no longer in memory ────────────────────────────────────────
 *
 * `BOT-019`: this was a `Map` with a five-minute TTL, so it evaporated on
 * restart — while the idempotency guard immediately beside it in `webhook.ts`
 * (`WebhookReceipt`) was deliberately made durable. The asymmetry meant that
 * for the first five minutes after every restart, and after every crash, the
 * guard was blind: a delayed SELL meant for a closed trade could close the
 * trade that had replaced it. The bot's own CHANGELOG records thirteen restarts
 * in production.
 *
 * The row now lives in the database, one per (bot, pair), upserted on close.
 * An in-process cache is kept in front of it so the hot webhook path does not
 * add a query per request, but the database is the authority and a cache miss
 * falls through to it.
 */
import { prisma } from "./prisma.js";

/** How long a recorded close keeps suppressing stale sells. */
export const CLOSE_MARK_TTL_MS = 5 * 60_000;

/** Read-through cache. Never the authority — only an optimisation. */
const cache = new Map<string, number>();
const cacheKey = (botId: string, pair: string): string => `${botId}:${pair}`;

/**
 * Record that a trade closed for this bot and pair.
 *
 * Best-effort on the write: a close must never fail because the marker could
 * not be persisted, so a failure is logged and the in-memory value still
 * applies for this process's lifetime. That is strictly better than the
 * previous behaviour, which was in-memory only by design.
 */
export async function recordPairClose(botId: string, pair: string): Promise<void> {
  const now = new Date();
  cache.set(cacheKey(botId, pair), now.getTime());
  try {
    await prisma.pairCloseMark.upsert({
      where: { botId_pair: { botId, pair } },
      create: { botId, pair, closedAt: now },
      update: { closedAt: now },
    });
  } catch (e) {
    console.error("[tradeCloseTracker] could not persist close marker", botId, pair, e);
  }
}

/**
 * Timestamp (ms) of the most recent close for this bot and pair inside the TTL,
 * or undefined.
 *
 * Async because the durable read is the point. The cache short-circuits a hit;
 * a miss consults the database, which is what makes this survive a restart.
 */
export async function getLastCloseTs(botId: string, pair: string): Promise<number | undefined> {
  const key = cacheKey(botId, pair);
  const cached = cache.get(key);
  const fresh = (ts: number): boolean => Date.now() - ts < CLOSE_MARK_TTL_MS;
  if (cached !== undefined && fresh(cached)) return cached;

  try {
    const row = await prisma.pairCloseMark.findUnique({ where: { botId_pair: { botId, pair } } });
    if (!row) return undefined;
    const ts = row.closedAt.getTime();
    cache.set(key, ts);
    return fresh(ts) ? ts : undefined;
  } catch (e) {
    console.error("[tradeCloseTracker] could not read close marker", botId, pair, e);
    // Fall back to whatever this process remembers rather than reporting "no
    // recent close", which would let a stale sell through.
    return cached !== undefined && fresh(cached) ? cached : undefined;
  }
}

/** Prune rows past the TTL. Called from the periodic cleanup in index.ts. */
export async function pruneCloseMarks(): Promise<number> {
  const cutoff = new Date(Date.now() - CLOSE_MARK_TTL_MS * 2);
  for (const [k, ts] of cache) if (ts < cutoff.getTime()) cache.delete(k);
  try {
    const { count } = await prisma.pairCloseMark.deleteMany({ where: { closedAt: { lt: cutoff } } });
    return count;
  } catch {
    return 0;
  }
}

/** Test-only: drop the in-process cache so a test can exercise the durable path. */
export function __clearCloseMarkCache(): void {
  cache.clear();
}
