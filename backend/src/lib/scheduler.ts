/**
 * Non-overlapping background schedules.
 *
 * `BOT-033`: the TP/SL monitor ran under `setInterval(…, 30_000)` and walked
 * every active trade sequentially, making at least one Binance call per trade.
 * `setInterval` fires on the clock regardless of whether the previous run has
 * finished, so once a cycle took longer than 30 seconds — which needs only a
 * handful of trades on a slow API — a second cycle started on top of the first.
 * Two concurrent passes over the same open positions is how one position gets
 * evaluated, and potentially closed, twice.
 *
 * `startInterval` schedules the next run only after the previous one settles,
 * and says so out loud when a cycle overruns its own interval, because that is
 * the signal that the interval is too short for the work.
 */

export interface IntervalHandle {
  stop(): void;
  /** True while a cycle is executing. */
  readonly running: boolean;
  /** Cycles that took longer than the interval. */
  readonly overruns: number;
}

export function startInterval(
  name: string,
  intervalMs: number,
  task: () => Promise<void>,
  log: (message: string) => void = console.warn
): IntervalHandle {
  let stopped = false;
  let running = false;
  let overruns = 0;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { void cycle(); }, intervalMs);
    // A background schedule must not be the reason the process stays alive.
    timer.unref?.();
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    running = true;
    const started = Date.now();
    try {
      await task();
    } catch (err) {
      // A failing cycle must not stop the schedule: this is a trading daemon,
      // and a monitor that quits silently is worse than one that errors loudly.
      console.error(`[${name}] cycle failed`, err);
    } finally {
      running = false;
      const elapsed = Date.now() - started;
      if (elapsed > intervalMs) {
        overruns += 1;
        log(
          `[${name}] cycle took ${elapsed}ms, longer than its ${intervalMs}ms interval ` +
          `(overrun ${overruns}). The next cycle starts now rather than overlapping this one.`
        );
      }
      schedule();
    }
  };

  schedule();

  return {
    stop() { stopped = true; if (timer) clearTimeout(timer); },
    get running() { return running; },
    get overruns() { return overruns; },
  };
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Used for the read half of a monitor cycle — refreshing prices and P&L — so
 * the cycle's duration stops scaling linearly with the number of open trades.
 * The half that PLACES ORDERS stays sequential on purpose.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await task(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
