import BinanceImport from "binance-api-node";
import type { ExchangeAccount } from "@prisma/client";
import { decrypt } from "../lib/crypto.js";
import { config } from "../config.js";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";

/** binance-api-node is CJS; under Node ESM the factory lives on `.default` */
const Binance =
  typeof BinanceImport === "function"
    ? BinanceImport
    : (BinanceImport as { default: typeof BinanceImport }).default;

export type BinanceClient = ReturnType<typeof Binance>;

export function clientFromAccount(account: ExchangeAccount): BinanceClient {
  return Binance({
    apiKey: decrypt(account.apiKeyEnc),
    apiSecret: decrypt(account.apiSecretEnc),
    httpBase: account.testnet
      ? "https://testnet.binance.vision"
      : undefined,
  });
}

export function clientFromEnv(): BinanceClient | null {
  if (!config.binanceApiKey || !config.binanceApiSecret) return null;
  return Binance({
    apiKey: config.binanceApiKey,
    apiSecret: config.binanceApiSecret,
    httpBase: config.binanceTestnet ? "https://testnet.binance.vision" : undefined,
  });
}

export async function getUsdtBalance(client: BinanceClient): Promise<number> {
  const info = await client.accountInfo();
  const usdt = info.balances.find((b) => b.asset === "USDT");
  return parseFloat(usdt?.free ?? "0");
}

export async function getTickerPrice(client: BinanceClient, symbol: string): Promise<number> {
  const sym = toBinanceSymbol(symbol);
  const t = await client.prices({ symbol: sym });
  return parseFloat(t[sym]);
}

export async function marketBuyQuote(
  client: BinanceClient,
  symbol: string,
  quoteUsdt: number
): Promise<{ orderId: string; executedQty: number; cummulativeQuoteQty: number; avgPrice: number }> {
  const sym = toBinanceSymbol(symbol);
  if (config.dryRun) {
    const price = await getTickerPrice(client, sym);
    const qty = quoteUsdt / price;
    return {
      orderId: `dry-${Date.now()}`,
      executedQty: qty,
      cummulativeQuoteQty: quoteUsdt,
      avgPrice: price,
    };
  }
  const order = await client.order({
    symbol: sym,
    side: "BUY",
    type: "MARKET",
    quoteOrderQty: quoteUsdt.toFixed(2),
  } as Parameters<BinanceClient["order"]>[0]);
  const executedQty = parseFloat(order.executedQty);
  const quote = parseFloat(order.cummulativeQuoteQty ?? "0");
  return {
    orderId: String(order.orderId),
    executedQty,
    cummulativeQuoteQty: quote,
    avgPrice: executedQty > 0 ? quote / executedQty : 0,
  };
}

function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const floored = Math.floor(qty / step) * step;
  return parseFloat(floored.toFixed(decimals));
}

/** Sell qty capped to free base balance and rounded down to LOT_SIZE step */
export async function resolveSellQuantity(
  client: BinanceClient,
  symbol: string,
  requestedQty: number
): Promise<number> {
  const sym = toBinanceSymbol(symbol);
  const free = await getBaseFreeBalance(client, sym);
  let qty = Math.min(requestedQty, free);
  const info = await client.exchangeInfo({ symbol: sym });
  const lot = info.symbols[0]?.filters.find((f) => f.filterType === "LOT_SIZE");
  if (lot && "stepSize" in lot) {
    const step = parseFloat(lot.stepSize);
    const minQty = "minQty" in lot ? parseFloat(lot.minQty) : step;
    qty = floorToStep(qty, step);
    if (qty < minQty) {
      throw new Error(
        `Sell quantity ${qty} below minimum ${minQty} ${parsePair(sym).base} (free: ${free})`
      );
    }
  }
  return qty;
}

export async function marketSellBase(
  client: BinanceClient,
  symbol: string,
  quantity: number
): Promise<{ orderId: string; executedQty: number; cummulativeQuoteQty: number; avgPrice: number }> {
  const sym = toBinanceSymbol(symbol);
  const qty = await resolveSellQuantity(client, sym, quantity);
  if (config.dryRun) {
    const price = await getTickerPrice(client, sym);
    return {
      orderId: `dry-${Date.now()}`,
      executedQty: qty,
      cummulativeQuoteQty: qty * price,
      avgPrice: price,
    };
  }
  const order = await client.order({
    symbol: sym,
    side: "SELL",
    type: "MARKET",
    quantity: qty.toFixed(8).replace(/\.?0+$/, "") || "0",
  } as Parameters<BinanceClient["order"]>[0]);
  const executedQty = parseFloat(order.executedQty);
  const quote = parseFloat(order.cummulativeQuoteQty ?? "0");
  return {
    orderId: String(order.orderId),
    executedQty,
    cummulativeQuoteQty: quote,
    avgPrice: executedQty > 0 ? quote / executedQty : 0,
  };
}

export async function getBaseFreeBalance(
  client: BinanceClient,
  symbol: string
): Promise<number> {
  const { base } = parsePair(symbol);
  const info = await client.accountInfo();
  const bal = info.balances.find((b) => b.asset === base);
  return parseFloat(bal?.free ?? "0");
}

/** Returns free + locked balance for the base asset of a symbol. */
export async function getBaseTotalBalance(
  client: BinanceClient,
  symbol: string
): Promise<number> {
  const { base } = parsePair(toBinanceSymbol(symbol));
  const info = await client.accountInfo();
  const bal = info.balances.find((b) => b.asset === base);
  return parseFloat(bal?.free ?? "0") + parseFloat(bal?.locked ?? "0");
}

/**
 * F1: Aggregate total account value in USDT.
 * Fetches all balances and all ticker prices in two parallel calls to stay
 * within Binance weight limits (weight 20 + 2 = 22 total).
 */
export async function getTotalBalanceUsdt(
  client: BinanceClient
): Promise<{ totalUsdt: number; breakdown: { asset: string; qty: number; valueUsdt: number }[] }> {
  const [info, allPrices] = await Promise.all([
    client.accountInfo(),
    client.prices() as Promise<Record<string, string>>,
  ]);

  const breakdown: { asset: string; qty: number; valueUsdt: number }[] = [];
  let totalUsdt = 0;

  for (const b of info.balances) {
    const qty = parseFloat(b.free) + parseFloat(b.locked);
    if (qty <= 0) continue;

    let valueUsdt: number;
    if (b.asset === "USDT" || b.asset === "USDC" || b.asset === "BUSD" || b.asset === "TUSD") {
      valueUsdt = qty;
    } else {
      const price = allPrices[`${b.asset}USDT`];
      if (!price) continue; // no USDT pair — skip dust tokens
      valueUsdt = qty * parseFloat(price);
    }

    if (valueUsdt < 0.01) continue; // skip sub-cent dust
    breakdown.push({ asset: b.asset, qty, valueUsdt });
    totalUsdt += valueUsdt;
  }

  return { totalUsdt, breakdown };
}
