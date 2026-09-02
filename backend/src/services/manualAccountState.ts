/**
 * A bounded, read-only view of what an account can actually trade right now.
 *
 * ── Why this exists, and why it is this small ───────────────────────────────
 *
 * The trading ticket had no idea what the account held. An operator could size
 * an order against nothing but a chart price, submit it, and learn the balance
 * only from a Binance rejection relayed back as an error string. The fix is not
 * to move credentials to the Platform — they stay here, and only here — but to
 * answer one narrow question over the channel that already exists:
 *
 *   for THIS account and THIS symbol, what is free, what is locked, and what
 *   are the exchange's own size and price rules?
 *
 * ── What it deliberately is not ─────────────────────────────────────────────
 *
 * Not a portfolio service: it returns two assets, the ones this symbol trades.
 * Not an order book: no depth, no DOM, no aggregation. Not authoritative for
 * execution: everything here is advisory context for a human, and the real
 * checks — risk limits, Shariah admission, Binance's own filters — all still
 * run on submission exactly as before. Nothing in this file can authorise
 * anything.
 */
import type { ExchangeAccount } from "@prisma/client";
import { clientFromAccount, type BinanceClient } from "./binance.js";
import { normalizeSymbol, parsePair } from "../lib/symbols.js";
import { prisma } from "../lib/prisma.js";
import { ManualTradingError } from "./manualTrading.js";

export interface AssetBalance {
  asset: string;
  /** Spendable right now. */
  free: number;
  /** Reserved by resting orders. Present so a shortfall is explicable. */
  locked: number;
}

export interface ManualAccountState {
  symbol: string;
  base: AssetBalance;
  quote: AssetBalance;
  /** The exchange's own constraints, so the UI rounds the way Binance will. */
  rules: { lotStep: number; minQty: number; priceTick: number; minNotional: number };
  /**
   * True when this reading came from a simulated account rather than a live
   * one, so the Platform can say so instead of implying real funds.
   */
  simulated: boolean;
}

type ClientFactory = (account: ExchangeAccount) => BinanceClient;

function balanceOf(
  balances: ReadonlyArray<{ asset: string; free: string; locked: string }>, asset: string
): AssetBalance {
  const row = balances.find((b) => b.asset.toUpperCase() === asset.toUpperCase());
  return {
    asset: asset.toUpperCase(),
    free: Number(row?.free ?? 0) || 0,
    locked: Number(row?.locked ?? 0) || 0,
  };
}

export async function readManualAccountState(
  input: { accountId: string; symbol: string },
  clientFactory: ClientFactory = clientFromAccount
): Promise<ManualAccountState> {
  const symbol = normalizeSymbol(input.symbol);
  let split: { base: string; quote: string };
  try {
    split = parsePair(symbol);
  } catch {
    throw new ManualTradingError(`unsupported spot symbol: ${symbol}`, 422);
  }

  const account = await prisma.exchangeAccount.findUnique({ where: { id: input.accountId } });
  if (!account) throw new ManualTradingError("exchange account not found", 404);

  const client = clientFactory(account);
  // Two reads, both public-to-the-key and neither of them a write. `accountInfo`
  // is the same call the balance dashboard already makes.
  const [info, exchange] = await Promise.all([
    client.accountInfo(),
    client.exchangeInfo({ symbol }),
  ]);

  const balances = (info.balances ?? []) as ReadonlyArray<
    { asset: string; free: string; locked: string }>;
  const filters = (exchange.symbols?.[0]?.filters ?? []) as unknown as
    ReadonlyArray<Record<string, string>>;
  let lotStep = 0, minQty = 0, priceTick = 0, minNotional = 0;
  for (const filter of filters) {
    if (filter.filterType === "LOT_SIZE") {
      lotStep = Number(filter.stepSize ?? 0) || 0;
      minQty = Number(filter.minQty ?? 0) || 0;
    } else if (filter.filterType === "PRICE_FILTER") {
      priceTick = Number(filter.tickSize ?? 0) || 0;
    } else if (filter.filterType === "NOTIONAL" || filter.filterType === "MIN_NOTIONAL") {
      minNotional = Number(filter.minNotional ?? 0) || 0;
    }
  }

  return {
    symbol,
    base: balanceOf(balances, split.base),
    quote: balanceOf(balances, split.quote),
    rules: { lotStep, minQty, priceTick, minNotional },
    simulated: account.testnet,
  };
}
