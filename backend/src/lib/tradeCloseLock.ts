/**
 * The per-trade close lock.
 *
 * `BOT-005`: there were four paths that close a trade, and only ONE of them
 * took the lock — `smartTrade.ts`'s TP/SL monitor. The other three
 * (`webhook.ts`'s sell path, `trades.ts`'s manual close, `trades.ts`'s partial
 * close) called `isTradeClosing` read-only, which tells you whether someone
 * else holds it but does not stop you proceeding.
 *
 * So a TP trigger coinciding with a SELL webhook issued two market sells for
 * the same position, and because `binance.ts` caps a sell against the shared
 * WALLET balance rather than the trade's own holding, the second sell could eat
 * a different bot's position in the same asset.
 *
 * The lock lives here, separate from `smartTrade.ts`, so every path acquires it
 * the same way and none of them has to import the TP/SL monitor to do it.
 *
 * In-process only. That is sufficient because the bot runs as a single Node
 * process — the same assumption `webhook.ts`'s `botBuyLocks` already makes —
 * and the durable guard against duplicates is `WebhookReceipt`. A multi-process
 * deployment would need a database lock, and that is recorded rather than
 * assumed away.
 */
const closing = new Set<string>();

/** True when some path currently holds the lock for this trade. */
export function isTradeClosing(tradeId: string): boolean {
  return closing.has(tradeId);
}

/**
 * Take the lock, or return false if another path already holds it.
 *
 * ALWAYS pair with `releaseTradeClose` in a `finally`. A lock leaked by an
 * exception makes the trade permanently uncloseable, which is a worse failure
 * than the double sell it exists to prevent.
 */
export function acquireTradeClose(tradeId: string): boolean {
  if (closing.has(tradeId)) return false;
  closing.add(tradeId);
  return true;
}

export function releaseTradeClose(tradeId: string): void {
  closing.delete(tradeId);
}

/**
 * Run `fn` holding the lock, releasing it however `fn` ends.
 *
 * Returns `{ ran: false }` when the lock was already held, so the caller can
 * answer 409 rather than silently doing nothing — the read-only
 * `isTradeClosing` check made "someone else is closing this" and "nothing
 * happened" indistinguishable.
 */
export async function withTradeCloseLock<T>(
  tradeId: string,
  fn: () => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (!acquireTradeClose(tradeId)) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } finally {
    releaseTradeClose(tradeId);
  }
}

/** Test-only: assert no lock leaked. Never call this from production code. */
export function heldLockCount(): number {
  return closing.size;
}
