/**
 * The quote assets this bot recognises, longest-first so a greedy suffix match
 * cannot split `BTCUSDT` as base `BTCUSD` + quote `T`.
 *
 * This is the single definition of "what part of a Spot symbol is the quote",
 * so `parsePair` (fee netting, balance lookups) and the Shariah base-asset
 * binding cannot disagree about where a symbol splits.
 */
export const QUOTE_ASSETS = ["USDT", "USDC", "BUSD", "BTC", "ETH"] as const;
export type QuoteAsset = (typeof QUOTE_ASSETS)[number];

export function isQuoteAsset(value: string): value is QuoteAsset {
  return (QUOTE_ASSETS as readonly string[]).includes(value);
}

/** Normalize BTCUSDT, BINANCE:NEARUSDT, NEAR/USDT -> NEARUSDT */
export function normalizeSymbol(raw: string): string {
  let s = raw.trim().toUpperCase();
  const colon = s.lastIndexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);
  return s.replace(/[/-]/g, "");
}

/** BTCUSDT -> { base: BTC, quote: USDT } */
export function parsePair(symbol: string): { base: string; quote: string } {
  const s = normalizeSymbol(symbol);
  for (const quote of QUOTE_ASSETS) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return { base: s.slice(0, -quote.length), quote };
    }
  }
  throw new Error(`Unsupported pair format: ${symbol}`);
}

export function toBinanceSymbol(symbol: string): string {
  return normalizeSymbol(symbol);
}
