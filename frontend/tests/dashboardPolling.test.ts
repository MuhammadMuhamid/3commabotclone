import { test } from "node:test";
import assert from "node:assert/strict";
import { startDashboardPolling, type PollTimers } from "../src/dashboardPolling";

test("dashboard polling refreshes current state and cleans its interval exactly once", async () => {
  let scheduled: (() => void) | null = null;
  let delay = 0;
  let clears = 0;
  const handle = { timer: "dashboard" };
  const timers: PollTimers = {
    setInterval(callback, delayMs) {
      scheduled = callback;
      delay = delayMs;
      return handle;
    },
    clearInterval(received) {
      assert.equal(received, handle);
      clears += 1;
    },
  };
  let currentTab = "active";
  const refreshed: string[] = [];
  const cleanup = startDashboardPolling(
    async () => { refreshed.push(currentTab); },
    timers,
  );

  assert.equal(delay, 15_000);
  assert.ok(scheduled);
  scheduled();
  await Promise.resolve();
  currentTab = "history";
  scheduled();
  await Promise.resolve();
  assert.deepEqual(refreshed, ["active", "history"]);

  cleanup();
  cleanup();
  assert.equal(clears, 1);
});
