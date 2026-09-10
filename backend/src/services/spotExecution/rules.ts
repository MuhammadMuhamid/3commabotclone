import { type SpotOrderIntent, type SpotVenue, SpotCapabilityError } from "./model.js";

export interface SpotInstrumentRules {
  baseIncrement: string;
  quoteIncrement: string;
  priceIncrement: string;
  minimumBaseQuantity: string | null;
  minimumQuoteNotional: string | null;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value)
  ? value as Json : {};
const value = (input: unknown, fallback = "0"): string => input == null || input === "" ? fallback : String(input);
const first = (input: unknown): Json => record(Array.isArray(input) ? input[0] : input);

/** Provider-specific rule payloads stop here; the execution service consumes one exact model. */
export function normalizeSpotInstrumentRules(venue: SpotVenue, raw: unknown): SpotInstrumentRules {
  const root = record(raw);
  switch (venue) {
    case "binance": { const symbol = first(root.symbols); const filters = (symbol.filters as unknown[]) ?? [];
      const filter = (kind: string) => record(filters.find((item) => record(item).filterType === kind));
      const lot = filter("LOT_SIZE"), price = filter("PRICE_FILTER");
      const notional = Object.keys(filter("NOTIONAL")).length ? filter("NOTIONAL") : filter("MIN_NOTIONAL");
      return { baseIncrement: value(lot.stepSize), quoteIncrement: "0",
        priceIncrement: value(price.tickSize), minimumBaseQuantity: value(lot.minQty, "") || null,
        minimumQuoteNotional: value(notional.minNotional, "") || null }; }
    case "coinbase": { const r = record(root.product ?? root); return { baseIncrement: value(r.base_increment),
      quoteIncrement: value(r.quote_increment), priceIncrement: value(r.quote_increment),
      minimumBaseQuantity: value(r.base_min_size, "") || null,
      minimumQuoteNotional: value(r.quote_min_size, "") || null }; }
    case "bybit": { const r = first(record(root.result ?? root).list); const lot = record(r.lotSizeFilter), price = record(r.priceFilter);
      return { baseIncrement: value(lot.qtyStep), quoteIncrement: value(lot.quotePrecision),
        priceIncrement: value(price.tickSize), minimumBaseQuantity: value(lot.minOrderQty, "") || null,
        minimumQuoteNotional: value(lot.minOrderAmt, "") || null }; }
    case "okx": { const r = first(root.data); return { baseIncrement: value(r.lotSz), quoteIncrement: "0",
      priceIncrement: value(r.tickSz), minimumBaseQuantity: value(r.minSz, "") || null,
      minimumQuoteNotional: null }; }
    case "kraken": { const result = record(root.result ?? root); const r = first(Object.values(result));
      return { baseIncrement: `1e-${value(r.lot_decimals, "8")}`, quoteIncrement: "0",
        priceIncrement: `1e-${value(r.pair_decimals, "8")}`, minimumBaseQuantity: value(r.ordermin, "") || null,
        minimumQuoteNotional: value(r.costmin, "") || null }; }
    case "kucoin": { const r = first(root.data ?? root); return { baseIncrement: value(r.baseIncrement),
      quoteIncrement: value(r.quoteIncrement), priceIncrement: value(r.priceIncrement),
      minimumBaseQuantity: value(r.baseMinSize, "") || null,
      minimumQuoteNotional: value(r.minFunds, "") || null }; }
    case "gateio": { const r = first(raw); const basePrecision = Number(r.amount_precision ?? 8), pricePrecision = Number(r.precision ?? 8);
      return { baseIncrement: `1e-${basePrecision}`, quoteIncrement: "0", priceIncrement: `1e-${pricePrecision}`,
        minimumBaseQuantity: value(r.min_base_amount, "") || null,
        minimumQuoteNotional: value(r.min_quote_amount, "") || null }; }
    case "robinhood": { const r = first(root.results ?? root); return { baseIncrement: value(r.asset_increment),
      quoteIncrement: value(r.quote_increment), priceIncrement: value(r.price_increment),
      minimumBaseQuantity: value(r.min_order_size, "") || null,
      minimumQuoteNotional: value(r.min_order_value, "") || null }; }
    case "hyperliquid": { const universe = (root.universe as unknown[]) ?? []; const r = first(universe);
      const decimals = Number(r.szDecimals ?? 0); return { baseIncrement: `1e-${decimals}`,
        quoteIncrement: "0", priceIncrement: "significant-figures:5",
        minimumBaseQuantity: null, minimumQuoteNotional: "10" }; }
  }
}

function aligned(valueText: string, incrementText: string): boolean {
  if (incrementText === "0" || incrementText.startsWith("significant-figures:")) return true;
  const quantity = Number(valueText), increment = Number(incrementText);
  if (!(quantity > 0) || !(increment > 0)) return false;
  const units = quantity / increment;
  return Math.abs(units - Math.round(units)) <= Math.max(1e-9, Math.abs(units) * 1e-12);
}

/** Exact pre-submission precision/minimum gate; no adapter rounds monetary intent silently. */
export function assertSpotInstrumentRules(intent: SpotOrderIntent, rules: SpotInstrumentRules): void {
  if (intent.baseQuantity) {
    if (!aligned(intent.baseQuantity, rules.baseIncrement)) throw new SpotCapabilityError(
      `${intent.venueSymbol} base quantity is not aligned to ${rules.baseIncrement}`);
    if (rules.minimumBaseQuantity && Number(intent.baseQuantity) < Number(rules.minimumBaseQuantity)) {
      throw new SpotCapabilityError(`${intent.venueSymbol} base quantity is below ${rules.minimumBaseQuantity}`);
    }
  }
  if (intent.limitPrice && !aligned(intent.limitPrice, rules.priceIncrement)) {
    throw new SpotCapabilityError(`${intent.venueSymbol} limit price is not aligned to ${rules.priceIncrement}`);
  }
  const notional = Number(intent.quoteQuantity ?? 0)
    || Number(intent.baseQuantity ?? 0) * Number(intent.limitPrice ?? intent.paperReferencePrice ?? 0);
  if (rules.minimumQuoteNotional && notional < Number(rules.minimumQuoteNotional)) {
    throw new SpotCapabilityError(`${intent.venueSymbol} order value is below ${rules.minimumQuoteNotional}`);
  }
}
