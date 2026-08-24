/**
 * BOT-033 — the TP/SL monitor's schedule.
 *
 * It ran under `setInterval(…, 30_000)` and walked every open position
 * sequentially, at least one Binance call each. `setInterval` fires on the
 * clock regardless of whether the previous run finished, so a cycle that
 * overran its interval — which needs only a handful of trades on a slow API —
 * had a second cycle start on top of it: two concurrent passes over the same
 * open positions, each able to decide to close one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency, startInterval } from "../src/lib/scheduler.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a cycle that overruns its interval NEVER overlaps the next one", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let cycles = 0;
  const warnings: string[] = [];

  const handle = startInterval("slow", 10, async () => {
    cycles += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(40);          // four times the interval
    inFlight -= 1;
  }, (m) => warnings.push(m));

  await sleep(300);
  handle.stop();

  assert.ok(cycles >= 3, `expected several cycles, got ${cycles}`);
  assert.equal(maxInFlight, 1, "two cycles ran at once — this is the defect BOT-033 describes");
  assert.ok(handle.overruns >= 3, `overruns should be reported, got ${handle.overruns}`);
  assert.match(warnings[0]!, /longer than its 10ms interval/);
});

test("a cycle that throws does not stop the schedule", async () => {
  let cycles = 0;
  const handle = startInterval("failing", 5, async () => {
    cycles += 1;
    throw new Error("boom");
  }, () => {});
  await sleep(60);
  handle.stop();
  assert.ok(cycles >= 3, `a trading monitor must keep running after a failure, got ${cycles} cycles`);
});

test("stop() ends the schedule", async () => {
  let cycles = 0;
  const handle = startInterval("stoppable", 5, async () => { cycles += 1; }, () => {});
  await sleep(40);
  handle.stop();
  const atStop = cycles;
  await sleep(40);
  assert.equal(cycles, atStop);
});

test("a cycle inside its interval is not reported as an overrun", async () => {
  const warnings: string[] = [];
  const handle = startInterval("fast", 30, async () => { await sleep(1); }, (m) => warnings.push(m));
  await sleep(100);
  handle.stop();
  assert.deepEqual(warnings, []);
  assert.equal(handle.overruns, 0);
});

// ── bounded concurrency ─────────────────────────────────────────────────────

test("mapWithConcurrency runs at most `limit` tasks at once, in order", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 4, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await sleep(2);
    inFlight -= 1;
    return n * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(out, items.map((n) => n * 2));
});

test("mapWithConcurrency handles an empty list and a limit above the item count", async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (n) => n), [1, 2]);
});

test("it is faster than sequential — the point of the change", async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const started = Date.now();
  await mapWithConcurrency(items, 4, async () => { await sleep(20); });
  const concurrent = Date.now() - started;
  // 12 items × 20ms sequential is 240ms; at 4-way concurrency it is ~60ms.
  assert.ok(concurrent < 180, `expected concurrency to help, took ${concurrent}ms`);
});
