import { config } from "../config.js";
import {
  type BinanceClient, clientFromAccount, floorToStep, getTickerPrice,
  getBaseTotalBalance,
  marketBuyQuote, marketSellBase, MinNotionalError,
  ExchangeError,
} from "./binance.js";
import type { ExchangeAccount } from "@prisma/client";
import { parsePair, toBinanceSymbol } from "../lib/symbols.js";

export type ManualExchangeStatus =
  | "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export interface ManualOrderIntent {
  symbol: string;
  side: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT";
  quoteQuantity?: number;
  baseQuantity?: number;
  limitPrice?: number;
  clientOrderId: string;
}

export interface ManualOrderSnapshot {
  exchangeOrderId: string;
  clientOrderId: string;
  status: ManualExchangeStatus;
  executedBaseQuantity: number;
  executedQuoteQuantity: number;
  averagePrice: number | null;
  simulated: boolean;
}

export class ManualOrderValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ManualOrderValidationError"; }
}

export interface ManualExchangeAdapter {
  submit(intent: ManualOrderIntent): Promise<ManualOrderSnapshot>;
  query(symbol: string, clientOrderId: string): Promise<ManualOrderSnapshot | null>;
  cancel(symbol: string, clientOrderId: string): Promise<ManualOrderSnapshot>;
  ticker(symbol: string): Promise<number>;
  baseTotal(symbol: string): Promise<number>;
}

interface SymbolRules {
  lotStep: number;
  minQty: number;
  priceTick: number;
  minNotional: number;
}

function decimal(value: number): string {
  return value.toFixed(16).replace(/\.?0+$/, "") || "0";
}

/** SELL limits round up so precision handling never lowers the user's ask. */
export function ceilToStep(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return value;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  const units = value / step;
  const tolerance = Math.max(1e-9, Math.abs(units) * 1e-12);
  const roundedUnits = Math.abs(units - Math.round(units)) < tolerance
    ? Math.round(units) : Math.ceil(units);
  return Number((roundedUnits * step).toFixed(decimals));
}

async function symbolRules(client: BinanceClient, symbol: string): Promise<SymbolRules> {
  const sym = toBinanceSymbol(symbol);
  const info = await client.exchangeInfo({ symbol: sym });
  const filters = info.symbols[0]?.filters ?? [];
  let lotStep = 0, minQty = 0, priceTick = 0, minNotional = 0;
  for (const raw of filters) {
    const f = raw as unknown as Record<string, string>;
    if (f.filterType === "LOT_SIZE") {
      lotStep = Number(f.stepSize ?? 0);
      minQty = Number(f.minQty ?? 0);
    } else if (f.filterType === "PRICE_FILTER") {
      priceTick = Number(f.tickSize ?? 0);
    } else if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") {
      minNotional = Number(f.minNotional ?? 0);
    }
  }
  return { lotStep, minQty, priceTick, minNotional };
}

function mapStatus(status: string): ManualExchangeStatus {
  if (["NEW", "PARTIALLY_FILLED", "FILLED", "CANCELED", "REJECTED", "EXPIRED"].includes(status)) {
    return status as ManualExchangeStatus;
  }
  return status === "EXPIRED_IN_MATCH" ? "EXPIRED" : "REJECTED";
}

async function fromBinanceOrder(
  client: BinanceClient,
  symbol: string,
  order: Record<string, unknown>,
  simulated = false
): Promise<ManualOrderSnapshot> {
  const grossBase = Number(order.executedQty ?? 0);
  let netBase = grossBase;
  const side = String(order.side ?? "");
  const orderId = String(order.orderId ?? "");
  if (!simulated && side === "BUY" && grossBase > 0 && orderId) {
    try {
      const trades = await client.myTrades({
        symbol: toBinanceSymbol(symbol),
        orderId: Number(orderId),
      } as Parameters<BinanceClient["myTrades"]>[0]);
      const base = parsePair(symbol).base;
      const commission = trades.reduce((sum, trade) =>
        trade.commissionAsset === base ? sum + Number(trade.commission) : sum, 0);
      netBase = Math.max(0, grossBase - commission);
    } catch {
      // A just-submitted order can be visible before its fills endpoint. The
      // next bounded reconciliation pass corrects the net quantity.
    }
  }
  const quote = Number(order.cummulativeQuoteQty ?? 0);
  return {
    exchangeOrderId: orderId,
    clientOrderId: String(order.clientOrderId ?? order.origClientOrderId ?? ""),
    status: mapStatus(String(order.status ?? "REJECTED")),
    executedBaseQuantity: netBase,
    executedQuoteQuantity: quote,
    averagePrice: grossBase > 0 ? quote / grossBase : null,
    simulated,
  };
}

export class BinanceManualExchange implements ManualExchangeAdapter {
  readonly client: BinanceClient;
  readonly dryRun: boolean;

  constructor(account: ExchangeAccount, opts: { client?: BinanceClient; dryRun?: boolean } = {}) {
    this.client = opts.client ?? clientFromAccount(account);
    this.dryRun = opts.dryRun ?? config.dryRun;
  }

  ticker(symbol: string): Promise<number> {
    return getTickerPrice(this.client, symbol);
  }

  baseTotal(symbol: string): Promise<number> {
    return getBaseTotalBalance(this.client, symbol);
  }

  async submit(intent: ManualOrderIntent): Promise<ManualOrderSnapshot> {
    if (intent.orderType === "MARKET") {
      const result = intent.side === "BUY"
          ? await marketBuyQuote(this.client, intent.symbol, intent.quoteQuantity ?? 0, {
            explicitClientOrderId: intent.clientOrderId, dryRun: this.dryRun,
          })
        : await marketSellBase(this.client, intent.symbol, intent.baseQuantity ?? 0, {
            explicitClientOrderId: intent.clientOrderId, dryRun: this.dryRun,
          });
      return {
        exchangeOrderId: result.orderId,
        clientOrderId: intent.clientOrderId,
        status: "FILLED",
        executedBaseQuantity: result.executedQty,
        executedQuoteQuantity: result.cummulativeQuoteQty,
        averagePrice: result.avgPrice,
        simulated: result.simulated,
      };
    }

    const sym = toBinanceSymbol(intent.symbol);
    const rawPrice = intent.limitPrice ?? 0;
    const rules = this.dryRun
      ? { lotStep: 0, minQty: 0, priceTick: 0, minNotional: 0 }
      : await symbolRules(this.client, sym);
    const price = intent.side === "SELL"
      ? ceilToStep(rawPrice, rules.priceTick)
      : floorToStep(rawPrice, rules.priceTick);
    let qty = intent.baseQuantity ?? ((intent.quoteQuantity ?? 0) / price);
    qty = floorToStep(qty, rules.lotStep);
    if (!(price > 0) || !(qty > 0) || qty < rules.minQty) {
      throw new ManualOrderValidationError(`${sym}: limit price or quantity is below the exchange filter`);
    }
    const notional = price * qty;
    if (rules.minNotional > 0 && notional < rules.minNotional) {
      throw new MinNotionalError(rules.minNotional, notional, sym);
    }
    if (this.dryRun) {
      return {
        exchangeOrderId: `dry-${intent.clientOrderId}`,
        clientOrderId: intent.clientOrderId,
        status: "NEW",
        executedBaseQuantity: 0,
        executedQuoteQuantity: 0,
        averagePrice: null,
        simulated: true,
      };
    }
    let order;
    try {
      order = await this.client.order({
        symbol: sym,
        side: intent.side,
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: decimal(qty),
        price: decimal(price),
        newClientOrderId: intent.clientOrderId,
        newOrderRespType: "FULL",
      } as Parameters<BinanceClient["order"]>[0]);
    } catch (error) {
      const detail = error as { code?: number; message?: string };
      throw new ExchangeError(detail.message ?? "Binance limit order failed", detail.code, sym);
    }
    return fromBinanceOrder(this.client, sym, order as unknown as Record<string, unknown>);
  }

  async query(symbol: string, clientOrderId: string): Promise<ManualOrderSnapshot | null> {
    if (this.dryRun) return null;
    try {
      const order = await this.client.getOrder({
        symbol: toBinanceSymbol(symbol), origClientOrderId: clientOrderId,
      } as Parameters<BinanceClient["getOrder"]>[0]);
      return fromBinanceOrder(this.client, symbol, order as unknown as Record<string, unknown>);
    } catch (error) {
      if ((error as { code?: number }).code === -2013) return null;
      throw error;
    }
  }

  async cancel(symbol: string, clientOrderId: string): Promise<ManualOrderSnapshot> {
    if (this.dryRun) {
      return {
        exchangeOrderId: `dry-${clientOrderId}`, clientOrderId, status: "CANCELED",
        executedBaseQuantity: 0, executedQuoteQuantity: 0, averagePrice: null, simulated: true,
      };
    }
    try {
      const order = await this.client.cancelOrder({
        symbol: toBinanceSymbol(symbol), origClientOrderId: clientOrderId,
      } as Parameters<BinanceClient["cancelOrder"]>[0]);
      return fromBinanceOrder(this.client, symbol, order as unknown as Record<string, unknown>);
    } catch (error) {
      if ((error as { code?: number }).code === -2011) {
        const current = await this.query(symbol, clientOrderId);
        if (current) return current;
      }
      throw error;
    }
  }
}
