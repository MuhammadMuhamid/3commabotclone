import { createHash } from "node:crypto";
import BinanceImport from "binance-api-node";
import type { ExchangeAccount } from "@prisma/client";
import { decrypt } from "../lib/crypto.js";
import { config } from "../config.js";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";
import { assertClearedForSymbol, type ShariahClearance } from "./shariah.js";

/** binance-api-node is CJS; under Node ESM the factory lives on `.default` */
const Binance =
  typeof BinanceImport === "function"
    ? BinanceImport
    : (BinanceImport as { default: typeof BinanceImport }).default;

export type BinanceClient = ReturnType<typeof Binance>;

/**
 * Floor a quote amount to the two decimals Binance accepts.
 *
 * BOT-014: this was `quoteUsdt.toFixed(2)`, which rounds to NEAREST. Since
 * `calcOrderQuoteUsdt` already clamps the amount to the free USDT balance,
 * rounding UP takes it past the balance — `1234.56789` became `"1234.57"` —
 * and Binance answered `-2010 Insufficient balance`, which the route then
 * discarded as a generic 503. Flooring can only ever ask for less than is
 * available.
 */
export function floorQuote(quoteUsdt: number): number {
  if (!Number.isFinite(quoteUsdt) || quoteUsdt <= 0) return 0;
  return Math.floor(quoteUsdt * 100) / 100;
}

/**
 * Net the commission out of a filled quantity.
 *
 * BOT-006: `executedQty` is GROSS. Binance charges spot BUY commission in the
 * BASE asset, so the wallet receives less than `executedQty` — and storing the
 * gross figure meant a later "full close" asked to sell more than the position
 * held. `resolveSellQuantity` then silently capped it to the real free balance
 * and the trade was marked `closed` regardless, leaving dust behind and a fee
 * that `smartTrade.ts` counted a second time through `BUY_FEE = 1.001`.
 *
 * Only fills whose commission is denominated in the base asset are deducted; a
 * BNB-paid or quote-paid fee does not reduce the base received.
 */
export function netBaseQty(
  executedQty: number,
  fills: { commission?: string; commissionAsset?: string }[] | undefined,
  baseAsset: string
): number {
  if (!fills || fills.length === 0) return executedQty;
  let commission = 0;
  for (const fill of fills) {
    if (!fill.commissionAsset || fill.commissionAsset.toUpperCase() !== baseAsset.toUpperCase()) continue;
    const c = parseFloat(fill.commission ?? "0");
    if (Number.isFinite(c) && c > 0) commission += c;
  }
  return Math.max(0, executedQty - commission);
}

/**
 * A deterministic client order id, so an order that succeeded at Binance but
 * threw locally afterwards can be found again.
 *
 * BOT-007: no `newClientOrderId` was sent, so an exception between
 * `marketBuyQuote` and `smartTrade.create` left a real, untracked position and
 * no way to look it up. `detectManualCloses` could not help — it only notices
 * balances LOWER than expected.
 *
 * Binance allows up to 36 characters, alphanumeric plus `-_`. The dedupe key
 * already identifies one logical order, so hashing it gives an id that is
 * stable across a retry of the SAME logical order and distinct across others.
 */
export function clientOrderId(scope: string): string {
  const hash = createHash("sha256").update(scope).digest("base64url").slice(0, 26);
  return `bot-${hash}`;
}

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

export interface OrderResult {
  orderId: string;
  /** NET of base-asset commission — this is what the wallet actually received. */
  executedQty: number;
  cummulativeQuoteQty: number;
  avgPrice: number;
  /** True when nothing was sent to the exchange. */
  simulated: boolean;
  /**
   * The order status Binance actually reported (`FILLED`, `PARTIALLY_FILLED`,
   * `EXPIRED`, ...).
   *
   * BOT-P1-3: a successful MARKET submission is not a fill. `manualExchange`
   * recorded every MARKET order as `FILLED` because this was the only thing an
   * `OrderResult` did not carry, so a zero-fill or partial-fill response became
   * terminal locally while the position stayed open. Carrying the real status
   * is what lets the manual lifecycle tell those apart.
   */
  exchangeStatus?: string;
}

/** Binance rejects an order below the symbol's NOTIONAL filter. */
export class MinNotionalError extends Error {
  constructor(readonly required: number, readonly requested: number, symbol: string) {
    super(
      `${symbol}: order notional ${requested.toFixed(2)} is below the exchange minimum ` +
      `${required.toFixed(2)}`
    );
    this.name = "MinNotionalError";
  }
}

/** Preserves the Binance error code, which the route used to discard. */
export class ExchangeError extends Error {
  constructor(message: string, readonly code: number | undefined, readonly symbol: string) {
    super(message);
    this.name = "ExchangeError";
  }
}

function wrapExchangeError(err: unknown, symbol: string): never {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "number" ? e.code : undefined;
  const message = typeof e.message === "string" ? e.message : "Binance request failed";
  // BOT-014: `-2010 Insufficient balance` and `-1013 Filter failure` are
  // actionable and were previously collapsed into a generic 503.
  throw new ExchangeError(message, code, symbol);
}

/**
 * What the exchange currently says about ONE client order id.
 *
 * BOT-P1-2: `queryFilledMarketOrder` collapsed five very different answers into
 * `null` — "Binance has never heard of this id", "it is still working", "it
 * ended without filling", "the lookup itself failed", and "it filled but not in
 * a usable shape". A stuck `submitted` SELL intent could therefore never be
 * resolved: absence of a fill was indistinguishable from absence of evidence,
 * so the safe answer was always "stay blocked", forever.
 *
 * These states are that answer, told apart:
 *
 *   `filled`  — an authoritative, usable fill.
 *   `open`    — the order exists and may still fill. Nothing may replace it.
 *   `dead`    — the order exists, is terminal, and moved no base asset. It is
 *               resolved, and it changed nothing.
 *   `absent`  — Binance answered `-2013`: no order exists under this id.
 *   `unknown` — no evidence at all (transport failure), or evidence this model
 *               must not simplify (a terminal order carrying a partial fill).
 *               Always fail safe on this one.
 */
export type OrderProbe =
  | { state: "filled"; result: OrderResult }
  | { state: "open"; exchangeStatus: string }
  | { state: "dead"; exchangeStatus: string }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/** Binance's "Order does not exist" for a lookup by client order id. */
const ORDER_DOES_NOT_EXIST = -2013;

const TERMINAL_EXCHANGE_STATUSES = ["CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"];

/**
 * Ask the exchange what became of one deterministic client order id.
 *
 * The only source of truth about an ambiguous submission, and deliberately the
 * only place that interprets a Binance order status.
 */
export async function probeOrderByClientId(
  client: BinanceClient,
  symbol: string,
  side: "BUY" | "SELL",
  stableClientOrderId: string
): Promise<OrderProbe> {
  const sym = toBinanceSymbol(symbol);
  let order;
  try {
    order = await client.getOrder({
      symbol: sym, origClientOrderId: stableClientOrderId,
    } as Parameters<BinanceClient["getOrder"]>[0]);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === ORDER_DOES_NOT_EXIST) return { state: "absent" };
    const message = (error as { message?: unknown }).message;
    return { state: "unknown", reason: typeof message === "string" ? message : "order lookup failed" };
  }

  const status = String(order.status ?? "");
  // An id that resolves to the opposite side is not this order. Refusing to
  // interpret it is the fail-safe answer: it must never be read as absence.
  if (String(order.side) !== side) {
    return { state: "unknown", reason: `client order id resolves to a ${String(order.side)} order` };
  }
  const grossQty = Number(order.executedQty ?? 0);
  const quote = Number(order.cummulativeQuoteQty ?? 0);

  if (status === "FILLED") {
    if (!(grossQty > 0) || !(quote >= 0)) {
      return { state: "unknown", reason: "FILLED order reported no usable quantity" };
    }
    let executedQty = grossQty;
    if (side === "BUY") {
      try {
        const trades = await client.myTrades({
          symbol: sym, orderId: Number(order.orderId),
        } as Parameters<BinanceClient["myTrades"]>[0]);
        executedQty = netBaseQty(grossQty, trades, parsePair(sym).base);
      } catch (error) {
        // A gross BUY quantity would overstate what the wallet received, and
        // that overstatement is exactly what BOT-006 fixed. No evidence is
        // better than wrong evidence.
        const message = (error as { message?: unknown }).message;
        return {
          state: "unknown",
          reason: typeof message === "string" ? message : "could not net BUY commission",
        };
      }
    }
    return { state: "filled", result: {
      orderId: String(order.orderId), executedQty, cummulativeQuoteQty: quote,
      avgPrice: quote / grossQty, simulated: false, exchangeStatus: status,
    }};
  }

  if (TERMINAL_EXCHANGE_STATUSES.includes(status)) {
    // A terminal order that nevertheless moved base asset is real exposure the
    // caller has to reconcile deliberately; this model must not call it "dead".
    if (grossQty > 0) {
      return { state: "unknown", reason: `${status} order carries a partial fill of ${grossQty}` };
    }
    return { state: "dead", exchangeStatus: status };
  }

  return { state: "open", exchangeStatus: status || "NEW" };
}

/**
 * Resolve an ambiguous MARKET submission by its deterministic client order id.
 * Only FILLED is usable by the current SmartTrade lifecycle; NEW or partial
 * results remain uncertain rather than being recorded as a completed entry or
 * exit. BUY recovery also requires fills so base-asset commission stays net.
 */
export async function queryFilledMarketOrder(
  client: BinanceClient,
  symbol: string,
  side: "BUY" | "SELL",
  stableClientOrderId: string
): Promise<OrderResult | null> {
  const probe = await probeOrderByClientId(client, symbol, side, stableClientOrderId);
  return probe.state === "filled" ? probe.result : null;
}

/** The symbol's minimum order notional, or 0 when the filter is absent. */
export async function getMinNotional(client: BinanceClient, symbol: string): Promise<number> {
  const sym = toBinanceSymbol(symbol);
  const info = await client.exchangeInfo({ symbol: sym });
  const filters = info.symbols[0]?.filters ?? [];
  for (const f of filters) {
    // `binance-api-node`'s SymbolFilterType union predates Binance renaming
    // MIN_NOTIONAL to NOTIONAL, so the string is compared loosely.
    const filterType = (f as { filterType: string }).filterType;
    if (filterType !== "NOTIONAL" && filterType !== "MIN_NOTIONAL") continue;
    const raw = (f as { minNotional?: string }).minNotional;
    const parsed = parseFloat(raw ?? "0");
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * The single MARKET BUY chokepoint, and therefore the last place new Spot
 * exposure can be stopped.
 *
 * `shariahClearance` is REQUIRED, and only `services/shariah.ts` can produce
 * one. That makes the gate structural rather than a convention: a new caller
 * cannot reach this function without going through the enforcement module, and
 * the clearance it holds is bound to a symbol, so a proof issued for one asset
 * cannot be carried across to another.
 *
 * `marketSellBase` has no such parameter, and must never gain one — that
 * asymmetry is what guarantees no exit can be refused on Shariah grounds.
 */
export async function marketBuyQuote(
  client: BinanceClient,
  symbol: string,
  quoteUsdt: number,
  opts: {
    idempotencyScope?: string;
    explicitClientOrderId?: string;
    dryRun?: boolean;
    shariahClearance: ShariahClearance;
  }
): Promise<OrderResult> {
  const sym = toBinanceSymbol(symbol);
  // Before the dry-run branch, before the notional check, before anything: a
  // refusal here must be indistinguishable from the order never being tried.
  assertClearedForSymbol(opts.shariahClearance, sym);
  const quote = floorQuote(quoteUsdt);
  if (quote <= 0) throw new Error(`${sym}: nothing to spend after flooring ${quoteUsdt}`);

  /*
   * BOT-035: the dry-run branch comes FIRST and touches nothing but a price.
   * On the sell side the equivalent branch sat AFTER `resolveSellQuantity`, so
   * simulated exits were capped by real wallet balances and could not be
   * exercised at all — the mode recommended for pre-live validation could not
   * validate an exit.
   */
  if (opts.dryRun ?? config.dryRun) {
    const price = await getTickerPrice(client, sym);
    const qty = price > 0 ? quote / price : 0;
    return {
      orderId: `dry-${opts.explicitClientOrderId ?? clientOrderId(opts.idempotencyScope ?? `${sym}:${quote}`)}`,
      executedQty: qty,
      cummulativeQuoteQty: quote,
      avgPrice: price,
      simulated: true,
      exchangeStatus: qty > 0 ? "FILLED" : "EXPIRED",
    };
  }

  // BOT-031: refuse below the exchange minimum rather than discovering it as a
  // -1013 that the route turned into a generic 503.
  const minNotional = await getMinNotional(client, sym);
  if (minNotional > 0 && quote < minNotional) {
    throw new MinNotionalError(minNotional, quote, sym);
  }

  const stableClientOrderId = opts.explicitClientOrderId ??
    (opts.idempotencyScope ? clientOrderId(opts.idempotencyScope) : undefined);
  let order;
  try {
    order = await client.order({
      symbol: sym,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: quote.toFixed(2),
      // BOT-007: makes the order findable if the local write throws next.
      ...(stableClientOrderId ? { newClientOrderId: stableClientOrderId } : {}),
    } as Parameters<BinanceClient["order"]>[0]);
  } catch (err) {
    if ((err as { code?: unknown }).code === undefined && stableClientOrderId) {
      const recovered = await queryFilledMarketOrder(client, sym, "BUY", stableClientOrderId);
      if (recovered) return recovered;
    }
    wrapExchangeError(err, sym);
  }

  const grossQty = parseFloat(order.executedQty);
  const quoteFilled = parseFloat(order.cummulativeQuoteQty ?? "0");
  const { base } = parsePair(sym);
  // BOT-006: spot BUY commission is charged in the BASE asset, so the wallet
  // received less than executedQty.
  const netQty = netBaseQty(
    grossQty,
    (order as { fills?: { commission?: string; commissionAsset?: string }[] }).fills,
    base
  );
  return {
    orderId: String(order.orderId),
    executedQty: netQty,
    cummulativeQuoteQty: quoteFilled,
    // The average price is a property of the FILL, so it uses the gross
    // quantity: netting the fee out of the divisor would inflate it.
    avgPrice: grossQty > 0 ? quoteFilled / grossQty : 0,
    simulated: false,
    exchangeStatus: String(order.status ?? ""),
  };
}

/**
 * Round a quantity DOWN to the exchange lot step.
 *
 * BOT-032: `Math.floor(qty / step) * step` accumulates binary floating-point
 * error — `Math.floor(0.29 / 0.01) * 0.01` is `0.28000000000000003`, and the
 * subsequent `toFixed` then rounds it back up to `0.29`, above the true floor.
 * Worse, `Math.floor(2.9999999999999996 / 0.1)` is 29, not 30, so a quantity
 * that is exactly on a step boundary in decimal loses a whole step.
 *
 * Working in integer step units and snapping a within-epsilon result up to the
 * next unit removes both. The result is still never greater than the input.
 */
export function floorToStep(qty: number, step: number): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return qty;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const units = qty / step;
  // A value a hair under an integer is that integer: the shortfall is
  // representation error, not a real fraction of a step. The tolerance scales
  // with magnitude, because float spacing does.
  const tolerance = Math.max(1e-9, Math.abs(units) * 1e-12);
  const snapped = Math.abs(units - Math.round(units)) < tolerance
    ? Math.round(units)
    : Math.floor(units);
  const rounded = parseFloat((snapped * step).toFixed(decimals));
  /*
   * Never return MEANINGFULLY more than was asked for. The allowance is one
   * representation error's worth of a step, and it exists precisely for the
   * snapping above: `floorToStep(2.9999999999999996, 0.1)` should be 3, and 3
   * is a hair above its input. Without the allowance the guard would undo the
   * snap and return 2.9 — losing a whole step, which is the very bug being
   * fixed.
   */
  const allowance = Math.abs(step) * 1e-9;
  return rounded <= qty + allowance ? rounded : parseFloat((rounded - step).toFixed(decimals));
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
  quantity: number,
  opts: { idempotencyScope?: string; explicitClientOrderId?: string; dryRun?: boolean } = {}
): Promise<OrderResult> {
  const sym = toBinanceSymbol(symbol);

  /*
   * BOT-035: THE DRY-RUN BRANCH COMES FIRST.
   *
   * It used to sit after `resolveSellQuantity`, which reads the real free base
   * balance and caps against it — so a simulated exit of a simulated entry was
   * capped to zero (there is no real base asset to sell) and threw
   * "Sell quantity 0 below minimum". The one mode the README recommends for
   * pre-live validation could not exercise an exit at all.
   *
   * Dry run now simulates the exchange completely: the only real call is a
   * price lookup, and the quantity is whatever the simulated position holds.
   */
  if (opts.dryRun ?? config.dryRun) {
    const price = await getTickerPrice(client, sym);
    const qty = Math.max(0, quantity);
    return {
      orderId: `dry-${opts.explicitClientOrderId ?? clientOrderId(opts.idempotencyScope ?? `${sym}:sell:${qty}`)}`,
      executedQty: qty,
      cummulativeQuoteQty: qty * price,
      avgPrice: price,
      simulated: true,
      exchangeStatus: qty > 0 ? "FILLED" : "EXPIRED",
    };
  }

  const stableClientOrderId = opts.explicitClientOrderId ??
    (opts.idempotencyScope ? clientOrderId(opts.idempotencyScope) : undefined);

  /*
   * F-AUTO-03: a crash between this call returning FILLED and the caller's
   * local close write leaves the position looking still-open here. A retry
   * under the SAME stable client id then finds the wallet already drained by
   * the real fill — `resolveSellQuantity` reads live balance, not local state
   * — and would normally throw "below minimum" before ever reaching the
   * exchange. That is exactly the ambiguity a query by the deterministic
   * client id resolves: if Binance already filled this exact order, use that
   * authoritative result instead of a local balance check that cannot see it.
   */
  let qty: number;
  try {
    qty = await resolveSellQuantity(client, sym, quantity);
  } catch (err) {
    if (stableClientOrderId) {
      const recovered = await queryFilledMarketOrder(client, sym, "SELL", stableClientOrderId);
      if (recovered) return recovered;
    }
    throw err;
  }

  let order;
  try {
    order = await client.order({
      symbol: sym,
      side: "SELL",
      type: "MARKET",
      quantity: qty.toFixed(8).replace(/\.?0+$/, "") || "0",
      ...(stableClientOrderId ? { newClientOrderId: stableClientOrderId } : {}),
    } as Parameters<BinanceClient["order"]>[0]);
  } catch (err) {
    // The uncoded case is a transport failure of unknown outcome. A coded
    // "duplicate order" rejection is just as ambiguous in the way that
    // matters here: Binance already has an order under this exact client id,
    // which is precisely the already-filled-elsewhere case this recovers.
    // Any OTHER coded rejection (bad balance, filter failure, ...) is a real,
    // first-attempt rejection, and a query for it will correctly find nothing.
    const e = err as { code?: unknown; message?: unknown };
    const ambiguous = e.code === undefined ||
      (typeof e.message === "string" && /duplicate/i.test(e.message));
    if (ambiguous && stableClientOrderId) {
      const recovered = await queryFilledMarketOrder(client, sym, "SELL", stableClientOrderId);
      if (recovered) return recovered;
    }
    wrapExchangeError(err, sym);
  }

  const executedQty = parseFloat(order.executedQty);
  const quote = parseFloat(order.cummulativeQuoteQty ?? "0");
  return {
    orderId: String(order.orderId),
    // A SELL's commission is charged in the QUOTE asset, so the base quantity
    // sold is not reduced. `cummulativeQuoteQty` is likewise gross of the fee;
    // `calcRealizedPnl` applies SELL_FEE to it.
    executedQty,
    cummulativeQuoteQty: quote,
    avgPrice: executedQty > 0 ? quote / executedQty : 0,
    simulated: false,
    exchangeStatus: String(order.status ?? ""),
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
