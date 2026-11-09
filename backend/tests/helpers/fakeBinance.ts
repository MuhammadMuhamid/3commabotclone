/**
 * An in-memory Binance Spot fake for the D1/D2 regression suites.
 *
 * No network: every method is a local function over a client-order-id book.
 * It models the parts of Binance these suites depend on:
 *
 *  - an order book keyed by client order id, answered by `getOrder` (`-2013`
 *    when the id is unknown) and `cancelOrder` (`-2011` when there is nothing
 *    to cancel);
 *  - a reused `newClientOrderId` is refused with `-2010 "Duplicate order sent."`
 *    — or, with `reuseAfterFill`, ACCEPTED once the earlier order is FILLED,
 *    which is the more permissive behaviour Binance documents and the one that
 *    makes a resubmission under a reused id dangerous;
 *  - scripted failures for `order()` and `getOrder()`, optionally "accepted then
 *    thrown": the order lands in the book and the caller still sees an error,
 *    which is exactly what an uncertain response is;
 *  - free/locked balances that MARKET SELL fills actually debit, so an
 *    over-sell shows up as a drained wallet.
 */
import type { BinanceClient } from "../../src/services/binance.js";

export interface FakeOrder {
  orderId: string;
  clientOrderId: string;
  side: string;
  type: string;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  origQty?: string;
  price?: string;
}

export interface ScriptedFailure {
  error: Error;
  /** Record the order in the book (and debit/credit the wallet) before throwing. */
  accepted?: boolean;
  /** The fill an accepted-then-thrown order carries. Defaults to a full fill. */
  fill?: { status: string; executedQty: string; quote: string };
}

export interface FakeBinanceOptions {
  price?: string;
  baseAsset?: string;
  freeBase?: string;
  lockedBase?: string;
  freeQuote?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  /** Accept a reused client order id once the earlier order under it is FILLED. */
  reuseAfterFill?: boolean;
  /** Failures for successive `order()` calls; `undefined` entries succeed. */
  orderFailures?: (ScriptedFailure | undefined)[];
  /** Failures for successive `getOrder()` calls; `undefined` entries answer normally. */
  lookupFailures?: (Error | undefined)[];
  /** Scripted fills for successive successful MARKET orders. */
  fills?: { status: string; executedQty: string; quote: string }[];
  /** Base-asset commission per BUY order, reported by `myTrades`. */
  buyCommission?: string;
}

export interface FakeBinance {
  client: BinanceClient;
  book: Map<string, FakeOrder>;
  /** Every `order()` call, accepted or not. */
  submissions: Record<string, unknown>[];
  lookups: string[];
  cancels: string[];
  wallet: { free: number; locked: number; quote: number };
  setPrice(price: string): void;
  /** Put an order straight into the book, as if it had been placed earlier. */
  seed(order: Partial<FakeOrder> & { clientOrderId: string }): void;
  /** Overwrite an existing order's fill, as the matching engine would. */
  fill(clientOrderId: string, executedQty: string, quote: string, status: string): void;
  /** Wire orders actually placed (accepted), by side. */
  accepted(side?: string): FakeOrder[];
}

export function binanceError(message: string, code?: unknown): Error {
  const error = new Error(message) as Error & { code?: unknown };
  if (code !== undefined) error.code = code;
  return error;
}

/** The library's shape for a non-JSON (HTML proxy / CloudFront) 5xx body. */
export function htmlStatusError(status: number): Error {
  const error = new Error(`${status} Service Unavailable <html>gateway</html>`) as Error & {
    response?: { status: number }; responseText?: string;
  };
  error.response = { status };
  error.responseText = "<html>gateway</html>";
  return error;
}

/** Node 22's native fetch transport failure. */
export function fetchFailed(): Error {
  const error = new TypeError("fetch failed") as TypeError & { cause?: unknown };
  error.cause = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
  return error;
}

/** A timeout surfaced as a DOMException-like error with a numeric DOM code. */
export function timeoutError(): Error {
  const error = new Error("The operation was aborted due to timeout") as Error & { code?: number };
  error.name = "TimeoutError";
  error.code = 23;
  return error;
}

export function fakeBinance(opts: FakeBinanceOptions = {}): FakeBinance {
  let price = opts.price ?? "100";
  const base = opts.baseAsset ?? "BTC";
  const book = new Map<string, FakeOrder>();
  const submissions: Record<string, unknown>[] = [];
  const lookups: string[] = [];
  const cancels: string[] = [];
  const orderFailures = [...(opts.orderFailures ?? [])];
  const lookupFailures = [...(opts.lookupFailures ?? [])];
  const fills = [...(opts.fills ?? [])];
  const wallet = {
    free: Number(opts.freeBase ?? "10"),
    locked: Number(opts.lockedBase ?? "0"),
    quote: Number(opts.freeQuote ?? "100000"),
  };
  const acceptedOrders: FakeOrder[] = [];
  let seq = 0;

  const settle = (order: FakeOrder) => {
    const qty = Number(order.executedQty);
    const quote = Number(order.cummulativeQuoteQty);
    if (order.side === "SELL") { wallet.free -= qty; wallet.quote += quote; }
    else { wallet.free += qty - Number(opts.buyCommission ?? "0"); wallet.quote -= quote; }
  };

  const place = (payload: Record<string, unknown>,
    forced?: { status: string; executedQty: string; quote: string }): FakeOrder => {
    seq += 1;
    const cid = String(payload.newClientOrderId ?? `auto-${seq}`);
    const type = String(payload.type ?? "MARKET");
    const side = String(payload.side ?? "BUY");
    let fill = forced ?? (type === "MARKET" ? fills.shift() : undefined);
    if (!fill) {
      if (type === "LIMIT") fill = { status: "NEW", executedQty: "0", quote: "0" };
      else if (side === "SELL") {
        const qty = String(payload.quantity ?? "0");
        fill = { status: "FILLED", executedQty: qty, quote: String(Number(qty) * Number(price)) };
      } else {
        const quote = String(payload.quoteOrderQty ?? "0");
        fill = { status: "FILLED", executedQty: String(Number(quote) / Number(price)), quote };
      }
    }
    const order: FakeOrder = { orderId: `ex-${seq}`, clientOrderId: cid, side, type,
      status: fill.status, executedQty: fill.executedQty, cummulativeQuoteQty: fill.quote,
      origQty: String(payload.quantity ?? ""), price: String(payload.price ?? "") };
    book.set(cid, order);
    acceptedOrders.push(order);
    settle(order);
    return order;
  };

  const client = {
    prices: async ({ symbol }: { symbol: string }) => ({ [symbol]: price }),
    accountInfo: async () => ({ balances: [
      { asset: base, free: String(wallet.free), locked: String(wallet.locked) },
      { asset: "USDT", free: String(wallet.quote), locked: "0" },
    ] }),
    exchangeInfo: async () => ({ symbols: [{ filters: [
      { filterType: "LOT_SIZE", stepSize: opts.stepSize ?? "0.0001", minQty: opts.minQty ?? "0.0001" },
      { filterType: "PRICE_FILTER", tickSize: "0.01" },
      { filterType: "NOTIONAL", minNotional: opts.minNotional ?? "1" },
    ] }] }),
    order: async (payload: Record<string, unknown>) => {
      submissions.push(payload);
      const scripted = orderFailures.shift();
      if (scripted) {
        if (scripted.accepted) place(payload, scripted.fill);
        throw scripted.error;
      }
      const cid = String(payload.newClientOrderId ?? "");
      const existing = cid ? book.get(cid) : undefined;
      if (existing && !(opts.reuseAfterFill && existing.status === "FILLED")) {
        throw binanceError("Duplicate order sent.", -2010);
      }
      const order = place(payload);
      return { ...order, fills: opts.buyCommission && order.side === "BUY"
        ? [{ commission: opts.buyCommission, commissionAsset: base }] : [] };
    },
    getOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      lookups.push(origClientOrderId);
      const scripted = lookupFailures.shift();
      if (scripted) throw scripted;
      const order = book.get(origClientOrderId);
      if (!order) throw binanceError("Order does not exist.", -2013);
      return { ...order };
    },
    cancelOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      cancels.push(origClientOrderId);
      const order = book.get(origClientOrderId);
      if (!order || !["NEW", "PARTIALLY_FILLED"].includes(order.status)) {
        throw binanceError("Unknown order sent.", -2011);
      }
      order.status = "CANCELED";
      return { ...order };
    },
    myTrades: async () => opts.buyCommission
      ? [{ commission: opts.buyCommission, commissionAsset: base }] : [],
    allOrders: async () => [],
  } as unknown as BinanceClient;

  return {
    client, book, submissions, lookups, cancels, wallet,
    setPrice(next) { price = next; },
    seed(order) {
      book.set(order.clientOrderId, { orderId: order.orderId ?? `seed-${order.clientOrderId}`,
        side: order.side ?? "BUY", type: order.type ?? "LIMIT", status: order.status ?? "NEW",
        executedQty: order.executedQty ?? "0", cummulativeQuoteQty: order.cummulativeQuoteQty ?? "0",
        clientOrderId: order.clientOrderId });
    },
    fill(clientOrderId, executedQty, quote, status) {
      const order = book.get(clientOrderId);
      if (!order) throw new Error(`fake: no order ${clientOrderId}`);
      const previous = Number(order.executedQty);
      order.executedQty = executedQty;
      order.cummulativeQuoteQty = quote;
      order.status = status;
      if (order.side === "BUY") wallet.free += Number(executedQty) - previous;
      else wallet.free -= Number(executedQty) - previous;
    },
    accepted(side) {
      return side ? acceptedOrders.filter((o) => o.side === side) : [...acceptedOrders];
    },
  };
}
