/**
 * Monetary precision for a SQLite/Prisma schema whose money columns are `Float`.
 *
 * `BOT-023`: every monetary value in this database is a SQLite `REAL` — an IEEE
 * 754 double. That is not exact decimal arithmetic, and the roadmap's answer is
 * integer minor units or `Decimal`. Neither is available here without migrating
 * a live SQLite database that this workspace may not touch, and Prisma's
 * `Decimal` on SQLite is not exact either — it lands back on NUMERIC.
 *
 * What IS available, and is what this module does, is to stop the error
 * COMPOUNDING:
 *
 *   - every monetary value is quantized to 8 decimal places before it is
 *     stored, so a value never drifts through repeated read → arithmetic →
 *     write cycles;
 *   - sums over many rows (a trade's partial closes, a bot's realized P&L) use
 *     a compensated sum, so adding a thousand rows does not accumulate a
 *     thousand rounding errors.
 *
 * This is a bound on the error, not exactness. 8 decimal places is Binance's
 * own maximum precision for both price and quantity, and a double represents
 * every quantity this system deals in — hundreds of USDT, not billions — to far
 * better than that. The honest statement of what remains is in `docs/`, and the
 * schema migration remains open work that needs a production data migration.
 */

/** Binance's maximum precision on both price and quantity. */
export const MONEY_DP = 8;
const SCALE = 10 ** MONEY_DP;

/**
 * Round to 8 decimal places, half away from zero.
 *
 * `Math.round` is half-UP, which biases negative values (a loss of -0.5 rounds
 * to -0, gaining money). P&L is signed here, so the sign is handled explicitly.
 */
export function quantize(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = value * SCALE;
  // `Math.round(x)` on a value that is already an exact integer multiple is a
  // no-op; the epsilon nudge only matters for a value sitting a few ULPs below
  // a .5 boundary because of an earlier multiplication.
  const rounded = value < 0
    ? -Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled))
    : Math.round(scaled + Number.EPSILON * scaled);
  return rounded / SCALE;
}

/**
 * Neumaier compensated summation, then quantized.
 *
 * A trade's final close sums every prior partial close's P&L, and the bot
 * summary sums every closed trade. A naive `reduce((a, b) => a + b)` loses a
 * little on every step and those losses accumulate in one direction.
 */
export function sumMoney(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const t = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - t) + value
      : (value - t) + sum;
    sum = t;
  }
  return quantize(sum + compensation);
}

/**
 * Every `Float` field in `schema.prisma` that holds money, a price or a
 * quantity, by model. Percentages are included: they are derived from money and
 * drift the same way, and a percentage stored to 8 dp is far finer than
 * anything displayed.
 */
export const MONEY_FIELDS: Record<string, readonly string[]> = {
  SmartTrade: ["entryPrice", "currentPrice", "quantity", "quoteSpent", "pnlUsdt", "pnlPct", "buyPrice"],
  PartialClose: ["pct", "quantity", "revenue", "pnlUsdt", "avgPrice"],
  StrategyOrderIntent: [
    "requestedBaseQty", "requestedQuoteQty", "sellPercent", "filledBaseQty",
    "filledQuoteQty", "averageFillPrice",
  ],
  SignalBot: ["maxInvestmentPct", "entryVolumePct", "takeProfitPct", "stopLossPct"],
  RiskControl: ["maxTotalExposureQuote", "maxDailyLossQuote"],
};

/**
 * Quantize the monetary fields of one Prisma `data` payload in place-safe
 * fashion, returning a new object. Handles the `{ increment: n }` / `{ set: n }`
 * update operators Prisma accepts as well as plain numbers.
 */
export function quantizeData(model: string, data: unknown): unknown {
  const fields = MONEY_FIELDS[model];
  if (!fields || typeof data !== "object" || data === null) return data;
  if (Array.isArray(data)) return data.map((item) => quantizeData(model, item));
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const field of fields) {
    const value = out[field];
    if (typeof value === "number") {
      out[field] = quantize(value);
    } else if (value && typeof value === "object") {
      const op = { ...(value as Record<string, unknown>) };
      for (const key of ["set", "increment", "decrement", "multiply", "divide"]) {
        if (typeof op[key] === "number") op[key] = quantize(op[key] as number);
      }
      out[field] = op;
    }
  }
  return out;
}
