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
  for (const quote of ["USDT", "USDC", "BUSD", "BTC", "ETH"]) {
    if (s.endsWith(quote) && s.length > quote.length) {
      return { base: s.slice(0, -quote.length), quote };
    }
  }
  throw new Error(`Unsupported pair format: ${symbol}`);
}

export function toBinanceSymbol(symbol: string): string {
  return normalizeSymbol(symbol);
}
