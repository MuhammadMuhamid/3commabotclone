import { createHash } from "node:crypto";
import BinanceImport from "binance-api-node";
import type { ExchangeAccount } from "@prisma/client";
import { decrypt } from "../lib/crypto.js";
import { config } from "../config.js";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";
import { assertClearedForSymbol, ShariahEnforcementError, type ShariahClearance } from "./shariah.js";

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

/**
 * A client from keys that are NOT stored — the OD-4 enrollment probe checks
 * submitted keys with it (read-only calls) before anything is encrypted.
 */
export function clientFromKeys(keys: { apiKey: string; apiSecret: string }, testnet: boolean): BinanceClient {
  return Binance({
    apiKey: keys.apiKey,
    apiSecret: keys.apiSecret,
    httpBase: testnet ? "https://testnet.binance.vision" : undefined,
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

/**
 * A refusal this process raised itself, BEFORE any exchange request was sent.
 *
 * Nothing exists at the exchange under the order's client id, so it is a
 * definite rejection for `classifyExchangeFailure`, whatever its message.
 */
export class PreWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreWireError";
  }
}

/**
 * F9: run a read that happens BEFORE any order request (exchange rules, a
 * balance, the minimum notional). Whatever it throws, no order was sent, so
 * the failure is a `PreWireError` — a definite "not executed" — rather than a
 * plain error the classifier would have to treat as uncertain.
 */
export async function beforeTheWire<T>(symbol: string, what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PreWireError) throw error;
    throw new PreWireError(`${symbol}: ${what} failed before any order was sent: ${
      error instanceof Error ? error.message : String(error)}`);
  }
}

/** Binance rejects an order below the symbol's NOTIONAL filter. */
export class MinNotionalError extends PreWireError {
  constructor(readonly required: number, readonly requested: number, symbol: string) {
    super(
      `${symbol}: order notional ${requested.toFixed(2)} is below the exchange minimum ` +
      `${required.toFixed(2)}`
    );
    this.name = "MinNotionalError";
  }
}

/**
 * D2: what a failed order submission proves about the order.
 *
 *   `rejected`  — the exchange (or this process, before the wire) definitely did
 *                 not execute it. Terminal.
 *   `duplicate` — Binance already holds an order under this client order id
 *                 ("Duplicate order sent."). Resolve it by querying that id.
 *   `uncertain` — anything else. It MAY have executed: keep the order pending and
 *                 reconcile it by its original client order id. Never `rejected`.
 */
export type ExchangeFailureOutcome = "rejected" | "duplicate" | "uncertain";

export interface ExchangeFailureClassification {
  outcome: ExchangeFailureOutcome;
  /** The numeric Binance code, when the error carries one. */
  code?: number;
  /** The HTTP status, when the library exposes it (non-JSON bodies only). */
  httpStatus?: number;
  message: string;
}

/**
 * Binance codes that mean "this request was not executed".
 *
 * A whitelist on purpose: misclassifying "not executed" as uncertain costs a
 * lookup by client id and a short pending window, while misclassifying "maybe
 * executed" as rejected costs untracked exposure and a duplicate entry (D2).
 * Any code not listed here — including -1006/-1007 ("execution status
 * unknown"), -1000/-1001/-1008 and every future code — is uncertain.
 *
 *   -1002 unauthorized · -1003 request weight / 429 / 418 · -1013 filter failure
 *   -1015 too many new orders · -1021 timestamp outside recvWindow
 *   -1022 invalid signature · -1100…-1131 request validation
 *   -2014 bad API-key format · -2015 invalid key, IP or permissions
 *   -2010 NEW_ORDER_REJECTED, EXCEPT "Duplicate order sent." (an order exists)
 */
const DEFINITE_REJECTION_CODES = new Set([-1002, -1003, -1013, -1015, -1021, -1022, -2014, -2015]);
const NEW_ORDER_REJECTED = -2010;
const DUPLICATE_ORDER = /duplicate order/i;
/** HTTP statuses whose meaning is "refused by the rate limiter before processing". */
const RATE_LIMIT_HTTP_STATUSES = new Set([429, 418]);

function isDefiniteRejectionCode(code: number): boolean {
  return DEFINITE_REJECTION_CODES.has(code) || (code <= -1100 && code >= -1131);
}

function classifyRaw(code: number | undefined, httpStatus: number | undefined,
  message: string): ExchangeFailureOutcome {
  if (code === NEW_ORDER_REJECTED) return DUPLICATE_ORDER.test(message) ? "duplicate" : "rejected";
  if (code !== undefined) return isDefiniteRejectionCode(code) ? "rejected" : "uncertain";
  if (httpStatus !== undefined && RATE_LIMIT_HTTP_STATUSES.has(httpStatus)) return "rejected";
  return "uncertain";
}

/** Only a numeric code from a Binance JSON body counts as a Binance code. */
function binanceCode(err: { code?: unknown; name?: unknown }): number | undefined {
  // A DOMException (AbortError 20, TimeoutError 23) also carries a numeric
  // `code`; it is a transport outcome, never a Binance answer.
  if (err.name === "AbortError" || err.name === "TimeoutError") return undefined;
  return typeof err.code === "number" && Number.isInteger(err.code) ? err.code : undefined;
}

function httpStatusOf(err: { response?: unknown }): number | undefined {
  const status = (err.response as { status?: unknown } | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * D2: the ONE classification every order-submitting path uses — manual MARKET
 * and LIMIT BUY/SELL, the strategy webhook BUY/SELL (and so the dashboard
 * Close), and the manual TP/SL protection SELL.
 */
export function classifyExchangeFailure(err: unknown): ExchangeFailureClassification {
  if (err instanceof ExchangeError) {
    return { outcome: err.outcome, code: err.code, httpStatus: err.httpStatus, message: err.message };
  }
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; response?: unknown };
  const message = typeof e.message === "string" ? e.message : String(err);
  if (err instanceof PreWireError || err instanceof ShariahEnforcementError) {
    return { outcome: "rejected", message };
  }
  const code = binanceCode(e);
  const httpStatus = httpStatusOf(e);
  return { outcome: classifyRaw(code, httpStatus, message), code, httpStatus, message };
}

/** The operator-facing note for an order left pending by an uncertain answer. */
export function describeUncertainFailure(failure: ExchangeFailureClassification): string {
  const detail = failure.code !== undefined ? ` (${failure.code})`
    : failure.httpStatus !== undefined ? ` (HTTP ${failure.httpStatus})` : "";
  const head = failure.outcome === "duplicate"
    ? `the exchange already holds an order under this client order id${detail}`
    : `execution status unknown${detail}`;
  return `${head}; reconciliation by client order id is pending: ${failure.message}`;
}

/** Preserves the Binance error code, which the route used to discard. */
export class ExchangeError extends Error {
  /** D2: what this failure proves about the order. See `classifyExchangeFailure`. */
  readonly outcome: ExchangeFailureOutcome;

  constructor(message: string, readonly code: number | undefined, readonly symbol: string,
    readonly httpStatus?: number) {
    super(message);
    this.name = "ExchangeError";
    this.outcome = classifyRaw(code, httpStatus, message);
  }
}

/** Wrap a raw exchange failure, keeping only what is safe to classify on. */
export function toExchangeError(err: unknown, symbol: string): ExchangeError {
  if (err instanceof ExchangeError) return err;
  const e = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown; response?: unknown };
  const message = typeof e.message === "string" ? e.message : "Binance request failed";
  return new ExchangeError(message, binanceCode(e), symbol, httpStatusOf(e));
}

function wrapExchangeError(err: unknown, symbol: string): never {
  // BOT-014: `-2010 Insufficient balance` and `-1013 Filter failure` are
  // actionable and were previously collapsed into a generic 503.
  throw toExchangeError(err, symbol);
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
  | {
    state: "unknown"; reason: string;
    /**
     * D2: set only for a TERMINAL order (CANCELED/EXPIRED/...) that moved base
     * asset — the executed part, net of base-asset commission for a BUY. The
     * exit resolvers keep treating this as unknown (fail safe); the strategy
     * BUY reconciler books it, because an entry that partly filled is real
     * exposure that must not stay untracked.
     */
    partialFill?: OrderResult;
  };

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
      const reason = `${status} order carries a partial fill of ${grossQty}`;
      let executedQty = grossQty;
      if (side === "BUY") {
        try {
          const trades = await client.myTrades({
            symbol: sym, orderId: Number(order.orderId),
          } as Parameters<BinanceClient["myTrades"]>[0]);
          executedQty = netBaseQty(grossQty, trades, parsePair(sym).base);
        } catch {
          // Without the commission the net quantity is unknown: no evidence.
          return { state: "unknown", reason };
        }
      }
      return { state: "unknown", reason, partialFill: {
        orderId: String(order.orderId), executedQty, cummulativeQuoteQty: quote,
        avgPrice: quote / grossQty, simulated: false, exchangeStatus: status,
      }};
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
  if (quote <= 0) throw new PreWireError(`${sym}: nothing to spend after flooring ${quoteUsdt}`);

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
  const minNotional = await beforeTheWire(sym, "minimum-notional lookup", () => getMinNotional(client, sym));
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
    // D2: anything short of a definite rejection may have executed (or, for a
    // duplicate, already did) — ask by the same client id before failing.
    if (classifyExchangeFailure(err).outcome !== "rejected" && stableClientOrderId) {
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
      throw new PreWireError(
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
    qty = await beforeTheWire(sym, "sell-quantity lookup", () => resolveSellQuantity(client, sym, quantity));
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
    // An uncertain outcome (transport failure, -1006/-1007, any code outside
    // the definite-rejection whitelist) may have executed. A "duplicate
    // order" answer is just as ambiguous in the way that matters here:
    // Binance already has an order under this exact client id, which is
    // precisely the already-filled-elsewhere case this recovers. A definite
    // rejection (bad balance, filter failure, ...) is a real first-attempt
    // rejection, and a query for it would correctly find nothing (D2).
    const ambiguous = classifyExchangeFailure(err).outcome !== "rejected";
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
