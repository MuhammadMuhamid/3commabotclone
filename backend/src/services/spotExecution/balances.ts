import { type SpotBalance, SpotCapabilityError } from "./model.js";

/** Balances are advisory until re-read; stale observations can never admit an order. */
export function assertFreshSpotBalances(
  balances: readonly SpotBalance[], nowMs: number, maximumAgeMs = 15_000
): void {
  if (balances.length === 0) throw new SpotCapabilityError("no authoritative Spot balance was returned");
  for (const balance of balances) {
    const observed = Date.parse(balance.observedAt);
    if (balance.stale || !Number.isFinite(observed) || nowMs - observed > maximumAgeMs || observed > nowMs + 1_000) {
      throw new SpotCapabilityError(`${balance.asset || "Spot"} balance is stale; refresh before submission`);
    }
  }
}
