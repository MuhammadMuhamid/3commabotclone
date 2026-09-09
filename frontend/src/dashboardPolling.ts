export interface PollTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTimers: PollTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: (handle) =>
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
};

/** Start one dashboard refresh loop and return its exact one-shot cleanup. */
export function startDashboardPolling(
  refresh: () => void | Promise<void>,
  timers: PollTimers = browserTimers,
  delayMs = 15_000,
): () => void {
  const handle = timers.setInterval(() => void refresh(), delayMs);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    timers.clearInterval(handle);
  };
}
