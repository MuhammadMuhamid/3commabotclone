/**
 * In-memory tracker for recent trade closes per (botId, pair).
 *
 * Problem it solves:
 *   A SELL webhook signal is meant to close Trade A. But Trade A was already
 *   closed (manually via dashboard, TP/SL, or sync). On the same candle, a new
 *   Trade B was opened. Without this guard, the SELL signal closes Trade B —
 *   the wrong trade.
 *
 * Fix:
 *   Every time any trade closes for a (botId, pair), record the timestamp.
 *   When a SELL webhook arrives, if the active trade was created AFTER the last
 *   recorded close, the signal is stale and is ignored.
 */

const closeTimestamps = new Map<string, number>(); // `${botId}:${pair}` → ms
const TTL_MS = 5 * 60_000; // forget after 5 minutes

export function recordPairClose(botId: string, pair: string): void {
  closeTimestamps.set(`${botId}:${pair}`, Date.now());
  // Prune stale entries to keep memory clean
  const cutoff = Date.now() - TTL_MS * 2;
  for (const [k, ts] of closeTimestamps) {
    if (ts < cutoff) closeTimestamps.delete(k);
  }
}

/**
 * Returns the timestamp (ms) of the most recent close for this bot+pair,
 * or undefined if no close was recorded within TTL_MS.
 */
export function getLastCloseTs(botId: string, pair: string): number | undefined {
  const ts = closeTimestamps.get(`${botId}:${pair}`);
  return ts != null && Date.now() - ts < TTL_MS ? ts : undefined;
}
