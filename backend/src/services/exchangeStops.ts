/**
 * ════════════════════════════════════════════════════════════════════════════
 *  EXCHANGE-NATIVE PROTECTIVE ORDERS — DISABLED BY DEFAULT
 *  REQUIRES BINANCE TESTNET VALIDATION BEFORE IT MAY BE ENABLED
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `BOT-017` / `BOT-A`: `services/binance.ts` places `type: "MARKET"` orders
 * exclusively — a repository-wide search finds no `STOP_LOSS`,
 * `STOP_LOSS_LIMIT`, `TAKE_PROFIT` or OCO order anywhere. Protection is a
 * `setInterval(…, 30_000)` poll in the same process, so:
 *
 *   * a position is COMPLETELY unprotected during any downtime, and the
 *     repository's own CHANGELOG records `RestartCount=13` in production with
 *     "any position near a trigger was unmonitored in that window";
 *   * a gap through the stop is not honoured at the stop level but re-evaluated
 *     at the next tick, at whatever the market has moved to;
 *   * granularity is up to 30 seconds plus the loop's own sequential latency.
 *
 * ── Why this is off ────────────────────────────────────────────────────────
 *
 * A resting order is the only protection that survives the process dying, so
 * this is the highest-value fix available. It is also the highest-RISK one,
 * because it changes what exists at the exchange, and it cannot be validated
 * from this workspace: no Binance credentials, mainnet or testnet, are
 * available here, and none may be used.
 *
 * So the adapter is complete, the arithmetic is unit-tested against mocked
 * exchange responses, and `EXCHANGE_STOPS_ENABLED` defaults to false. Nothing
 * in the live path calls it while that flag is off.
 *
 * ── What Mahamid must verify on testnet before enabling ────────────────────
 *
 *  1. A `STOP_LOSS_LIMIT` placed immediately after an entry fills is accepted,
 *     and its `stopPrice`/`price` pass the PERCENT_PRICE_BY_SIDE filter for the
 *     symbols actually traded.
 *  2. **Sequencing against BOT-006.** A resting SELL LOCKS the base balance it
 *     is for. `resolveSellQuantity` caps against the FREE balance, so with a
 *     resting order in place a manual or signal close would see almost nothing
 *     free and sell almost nothing. The resting order must therefore be
 *     CANCELLED before any other exit path runs — `cancelProtection` exists for
 *     that, and the ordering is the single most important thing to check.
 *  3. A partial take-profit reduces the position, so the resting stop quantity
 *     must be amended (cancel and re-place). Verify the replacement is accepted
 *     against LOT_SIZE and NOTIONAL for the reduced size.
 *  4. Behaviour when the stop fills while the poller is mid-cycle: the poller
 *     must observe the trade already closed and not issue a second sell.
 *  5. That cancelling a non-existent order (already filled) is tolerated rather
 *     than treated as a failure.
 *
 * Until every one of those is confirmed on testnet, this must not be described
 * as production-ready, and the flag must stay off.
 */
import type { BinanceClient } from "./binance.js";
import { floorToStep } from "./binance.js";
import { toBinanceSymbol } from "../lib/symbols.js";

/**
 * OFF unless explicitly enabled. Reading it as `=== "true"` rather than
 * `!== "false"` is deliberate: an unset or misspelled value must never arm
 * exchange-side order placement.
 */
export const exchangeStopsEnabled = (): boolean =>
  process.env.EXCHANGE_STOPS_ENABLED === "true";

/** Human-readable state, for the operator surface and every log line. */
export const EXCHANGE_STOPS_STATUS = "disabled by default — requires Binance testnet validation";

export interface ProtectiveOrderPlan {
  symbol: string;
  side: "SELL";
  type: "STOP_LOSS_LIMIT";
  quantity: number;
  /** The trigger. */
  stopPrice: number;
  /** The limit the triggered order is placed at, below the trigger. */
  price: number;
  timeInForce: "GTC";
  newClientOrderId: string;
}

export interface SymbolPrecision {
  /** LOT_SIZE stepSize. */
  stepSize: number;
  /** PRICE_FILTER tickSize. */
  tickSize: number;
  /** LOT_SIZE minQty. */
  minQty: number;
  /** NOTIONAL minNotional, or 0 when absent. */
  minNotional: number;
}

export class ProtectiveOrderRejected extends Error {
  constructor(readonly code: "below_min_qty" | "below_min_notional" | "invalid_prices", message: string) {
    super(message);
    this.name = "ProtectiveOrderRejected";
  }
}

/**
 * How far below the trigger the limit price sits, as a fraction.
 *
 * A `STOP_LOSS_LIMIT` whose limit equals its trigger will not fill in a fast
 * move — the very case a stop exists for — so the limit is placed below it. Too
 * wide and the fill is worse than necessary; too tight and it does not fill at
 * all. Half a percent is a starting point, and it is a parameter precisely
 * because the right value is an empirical question for the symbols traded.
 */
export const DEFAULT_LIMIT_OFFSET_FRACTION = 0.005;

/**
 * Build the protective order for a filled position. Pure: no network, no
 * clock, no randomness — every quantity and price is derived from its inputs,
 * which is what makes this testable without an exchange.
 */
export function planProtectiveOrder(input: {
  symbol: string;
  quantity: number;
  stopPrice: number;
  precision: SymbolPrecision;
  clientOrderId: string;
  limitOffsetFraction?: number;
}): ProtectiveOrderPlan {
  const symbol = toBinanceSymbol(input.symbol);
  const offset = input.limitOffsetFraction ?? DEFAULT_LIMIT_OFFSET_FRACTION;

  if (!Number.isFinite(input.stopPrice) || input.stopPrice <= 0) {
    throw new ProtectiveOrderRejected("invalid_prices", `${symbol}: stop price must be positive`);
  }

  // Quantity DOWN to the lot step: a resting order for more base asset than is
  // held is rejected, and rounding up is how that happens.
  const quantity = floorToStep(input.quantity, input.precision.stepSize);
  if (quantity <= 0 || quantity < input.precision.minQty) {
    throw new ProtectiveOrderRejected(
      "below_min_qty",
      `${symbol}: protective quantity ${quantity} is below the minimum ${input.precision.minQty}`
    );
  }

  // Trigger DOWN to the tick, and the limit DOWN from the trigger. Rounding the
  // trigger up would place the stop tighter than the strategy asked for.
  const stopPrice = floorToStep(input.stopPrice, input.precision.tickSize);
  const rawLimit = stopPrice * (1 - offset);
  const price = floorToStep(rawLimit, input.precision.tickSize);

  if (stopPrice <= 0 || price <= 0 || price > stopPrice) {
    throw new ProtectiveOrderRejected(
      "invalid_prices",
      `${symbol}: computed stopPrice=${stopPrice} price=${price} is not a valid stop-limit pair`
    );
  }

  const notional = quantity * price;
  if (input.precision.minNotional > 0 && notional < input.precision.minNotional) {
    throw new ProtectiveOrderRejected(
      "below_min_notional",
      `${symbol}: protective notional ${notional.toFixed(2)} is below the minimum ` +
      `${input.precision.minNotional.toFixed(2)}`
    );
  }

  return {
    symbol,
    side: "SELL",
    type: "STOP_LOSS_LIMIT",
    quantity,
    stopPrice,
    price,
    timeInForce: "GTC",
    newClientOrderId: input.clientOrderId,
  };
}

/** Read the LOT_SIZE, PRICE_FILTER and NOTIONAL filters for one symbol. */
export async function readPrecision(
  client: BinanceClient,
  symbol: string
): Promise<SymbolPrecision> {
  const sym = toBinanceSymbol(symbol);
  const info = await client.exchangeInfo({ symbol: sym });
  const filters = (info.symbols[0]?.filters ?? []) as { filterType: string }[];
  const find = (type: string): Record<string, string> | undefined =>
    filters.find((f) => f.filterType === type) as Record<string, string> | undefined;

  const lot = find("LOT_SIZE");
  const price = find("PRICE_FILTER");
  const notional = find("NOTIONAL") ?? find("MIN_NOTIONAL");

  return {
    stepSize: parseFloat(lot?.stepSize ?? "0"),
    minQty: parseFloat(lot?.minQty ?? "0"),
    tickSize: parseFloat(price?.tickSize ?? "0"),
    minNotional: parseFloat(notional?.minNotional ?? "0"),
  };
}

export interface PlacedProtection {
  exchangeOrderId: string;
  clientOrderId: string;
  plan: ProtectiveOrderPlan;
}

/**
 * Place the protective order.
 *
 * Refuses unless the flag is on. In DRY_RUN it returns a simulated placement
 * without contacting the exchange, so the surrounding logic can be exercised.
 */
export async function placeProtection(
  client: BinanceClient,
  plan: ProtectiveOrderPlan,
  opts: { dryRun: boolean }
): Promise<PlacedProtection> {
  if (!exchangeStopsEnabled()) {
    throw new Error(
      `exchange-native protective orders are ${EXCHANGE_STOPS_STATUS}. ` +
      "Set EXCHANGE_STOPS_ENABLED=true only after the testnet checks in " +
      "services/exchangeStops.ts have been completed."
    );
  }
  if (opts.dryRun) {
    return {
      exchangeOrderId: `dry-${plan.newClientOrderId}`,
      clientOrderId: plan.newClientOrderId,
      plan,
    };
  }
  const order = await client.order(plan as unknown as Parameters<BinanceClient["order"]>[0]);
  return {
    exchangeOrderId: String(order.orderId),
    clientOrderId: plan.newClientOrderId,
    plan,
  };
}

/**
 * Cancel a resting protective order.
 *
 * MUST run before any other exit path. A resting SELL locks the base balance it
 * covers, and `resolveSellQuantity` caps against the FREE balance — so with the
 * stop still resting, a manual or signal close would find almost nothing free
 * and sell almost nothing. This is the sequencing hazard the audit flagged
 * between BOT-017 and BOT-006.
 *
 * An order that has already filled or been cancelled is NOT an error: that is
 * the ordinary race between the stop triggering and an exit being requested.
 */
export async function cancelProtection(
  client: BinanceClient,
  symbol: string,
  clientOrderId: string,
  opts: { dryRun: boolean }
): Promise<{ cancelled: boolean; alreadyGone: boolean }> {
  if (opts.dryRun) return { cancelled: true, alreadyGone: false };
  try {
    await client.cancelOrder({
      symbol: toBinanceSymbol(symbol),
      origClientOrderId: clientOrderId,
    } as Parameters<BinanceClient["cancelOrder"]>[0]);
    return { cancelled: true, alreadyGone: false };
  } catch (err) {
    const code = (err as { code?: number }).code;
    // -2011 UNKNOWN_ORDER: already filled or already cancelled.
    if (code === -2011) return { cancelled: false, alreadyGone: true };
    throw err;
  }
}
