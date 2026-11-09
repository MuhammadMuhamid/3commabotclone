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
 *    over-sell shows up as a drained wallet;
 *  - OD-1 cancels: scripted `cancelFailures` (optionally "accepted then
 *    thrown": the cancel — and a last fill — lands in the book while the
 *    caller sees an error), a one-shot `fillBeforeCancel` race, and a
 *    `myTradesFails` switch for the commission lookup (X7).
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

/** A scripted failure for one `cancelOrder()` call. */
export interface ScriptedCancelFailure {
  error: Error;
  /** Apply the cancel in the book (after `fillTo`, when given) before throwing. */
  accepted?: boolean;
  /** The cumulative fill the order reached before an accepted cancel took effect. */
  fillTo?: { executedQty: string; quote: string };
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
  /** Base-asset commission as a fraction of each BUY order's executed quantity (`myTrades`). */
  buyCommissionRate?: number;
  /** Failures for successive `cancelOrder()` calls; `undefined` entries succeed. */
  cancelFailures?: (ScriptedCancelFailure | undefined)[];
  /** `myTrades` throws while true (the commission lookup failed). */
  myTradesFails?: boolean;
  /** The asset `myTrades` reports commission in. Defaults to the base asset (netted). */
  commissionAsset?: string;
}

export interface FakeBinance {
  client: BinanceClient;
  book: Map<string, FakeOrder>;
  /** Every `order()` call, accepted or not. */
  submissions: Record<string, unknown>[];
  lookups: string[];
  cancels: string[];
  /** Every exchange call in order: `order:<side>:<cid>`, `get:<cid>`, `cancel:<cid>`. */
  events: string[];
  wallet: { free: number; locked: number; quote: number };
  setPrice(price: string): void;
  /** Queue a scripted outcome for the next `cancelOrder()` call(s). */
  scriptCancel(...failures: (ScriptedCancelFailure | undefined)[]): void;
  /** One-shot race: the next `cancelOrder()` first fills the order to this cumulative figure. */
  fillBeforeCancel(fill: { executedQty: string; quote: string; status?: string }): void;
  setMyTradesFails(fails: boolean): void;
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
  const events: string[] = [];
  const orderFailures = [...(opts.orderFailures ?? [])];
  const lookupFailures = [...(opts.lookupFailures ?? [])];
  const fills = [...(opts.fills ?? [])];
  const cancelFailures = [...(opts.cancelFailures ?? [])];
  let raceFill: { executedQty: string; quote: string; status?: string } | undefined;
  let myTradesFails = opts.myTradesFails ?? false;
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

  /** A cumulative fill of a resting order, as the matching engine would apply it. */
  const fillTo = (order: FakeOrder, executedQty: string, quote: string, status: string) => {
    const previous = Number(order.executedQty);
    order.executedQty = executedQty;
    order.cummulativeQuoteQty = quote;
    order.status = status;
    if (order.side === "BUY") wallet.free += Number(executedQty) - previous;
    else wallet.free -= Number(executedQty) - previous;
  };
  const working = (order: FakeOrder | undefined) =>
    order !== undefined && ["NEW", "PARTIALLY_FILLED"].includes(order.status);

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
      events.push(`order:${String(payload.side)}:${String(payload.newClientOrderId ?? "")}`);
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
      events.push(`get:${origClientOrderId}`);
      const scripted = lookupFailures.shift();
      if (scripted) throw scripted;
      const order = book.get(origClientOrderId);
      if (!order) throw binanceError("Order does not exist.", -2013);
      return { ...order };
    },
    cancelOrder: async ({ origClientOrderId }: { origClientOrderId: string }) => {
      cancels.push(origClientOrderId);
      events.push(`cancel:${origClientOrderId}`);
      const order = book.get(origClientOrderId);
      const race = raceFill;
      raceFill = undefined;
      if (order && race && working(order)) {
        fillTo(order, race.executedQty, race.quote, race.status ?? "PARTIALLY_FILLED");
      }
      const scripted = cancelFailures.shift();
      if (scripted) {
        if (scripted.accepted && order && working(order)) {
          if (scripted.fillTo) {
            fillTo(order, scripted.fillTo.executedQty, scripted.fillTo.quote, "PARTIALLY_FILLED");
          }
          order.status = "CANCELED";
        }
        throw scripted.error;
      }
      if (!order || !working(order)) {
        throw binanceError("Unknown order sent.", -2011);
      }
      order.status = "CANCELED";
      return { ...order };
    },
    myTrades: async ({ orderId }: { orderId?: number | string } = {}) => {
      if (myTradesFails) throw binanceError("Internal error; unable to process your request.", -1001);
      if (opts.buyCommissionRate !== undefined) {
        const order = [...book.values()].find((o) => o.orderId === String(orderId));
        return order ? [{ commission: String(Number(order.executedQty) * opts.buyCommissionRate),
          commissionAsset: opts.commissionAsset ?? base }] : [];
      }
      return opts.buyCommission ? [{ commission: opts.buyCommission, commissionAsset: base }] : [];
    },
    allOrders: async () => [],
  } as unknown as BinanceClient;

  return {
    client, book, submissions, lookups, cancels, events, wallet,
    setPrice(next) { price = next; },
    scriptCancel(...failures) { cancelFailures.push(...failures); },
    fillBeforeCancel(fill) { raceFill = fill; },
    setMyTradesFails(fails) { myTradesFails = fails; },
    seed(order) {
      book.set(order.clientOrderId, { orderId: order.orderId ?? `seed-${order.clientOrderId}`,
        side: order.side ?? "BUY", type: order.type ?? "LIMIT", status: order.status ?? "NEW",
        executedQty: order.executedQty ?? "0", cummulativeQuoteQty: order.cummulativeQuoteQty ?? "0",
        clientOrderId: order.clientOrderId });
    },
    fill(clientOrderId, executedQty, quote, status) {
      const order = book.get(clientOrderId);
      if (!order) throw new Error(`fake: no order ${clientOrderId}`);
      fillTo(order, executedQty, quote, status);
    },
    accepted(side) {
      return side ? acceptedOrders.filter((o) => o.side === side) : [...acceptedOrders];
    },
  };
}
