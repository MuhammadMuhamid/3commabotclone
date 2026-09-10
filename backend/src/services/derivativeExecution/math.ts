import type { ContractKind, DerivativeInstrument, PositionDirection, PriceRole,
  ProtectiveIntent } from "./model.js";

const DECIMAL_PLACES = 18;
const SCALE = 1_000_000_000_000_000_000n;

function fixed(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`invalid decimal: ${value}`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  if (fraction.length > DECIMAL_PLACES) throw new Error(`decimal exceeds ${DECIMAL_PLACES} places: ${value}`);
  const result = BigInt(whole!) * SCALE + BigInt((fraction + "0".repeat(DECIMAL_PLACES)).slice(0, DECIMAL_PLACES));
  return negative ? -result : result;
}

function decimal(value: bigint): string {
  const negative = value < 0n; const absolute = negative ? -value : value;
  const whole = absolute / SCALE; const fraction = (absolute % SCALE).toString().padStart(DECIMAL_PLACES, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function mul(a: bigint, b: bigint): bigint { return a * b / SCALE; }
function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("division by zero"); return a * SCALE / b;
}

export function decimalProduct(left: string, right: string): string {
  return decimal(mul(fixed(left), fixed(right)));
}

export interface DerivativeSizing {
  contracts: string;
  baseQuantity: string;
  quoteNotional: string;
}

export function derivativeSizing(instrument: DerivativeInstrument, quantityUnit: "CONTRACTS" | "BASE",
  quantity: string, price: string): DerivativeSizing {
  const size = fixed(instrument.contractSize), qty = fixed(quantity), px = fixed(price);
  if (size <= 0n || qty < 0n || px <= 0n) throw new Error("sizing inputs must be non-negative with positive size/price");
  if (instrument.kind === "LINEAR") {
    const contracts = quantityUnit === "CONTRACTS" ? qty : div(qty, size);
    const base = mul(contracts, size);
    return { contracts: decimal(contracts), baseQuantity: decimal(base), quoteNotional: decimal(mul(base, px)) };
  }
  const contracts = quantityUnit === "CONTRACTS" ? qty : div(mul(qty, px), size);
  const quote = mul(contracts, size);
  return { contracts: decimal(contracts), baseQuantity: decimal(div(quote, px)), quoteNotional: decimal(quote) };
}

/** Linear PnL settles in quote; inverse PnL settles in base. */
export function derivativePnl(kind: ContractKind, direction: PositionDirection, contracts: string,
  contractSize: string, entryPrice: string, exitPrice: string): string {
  const sign = direction === "LONG" ? 1n : -1n;
  const count = fixed(contracts), size = fixed(contractSize), entry = fixed(entryPrice), exit = fixed(exitPrice);
  if (count < 0n || size <= 0n || entry <= 0n || exit <= 0n) throw new Error("PnL inputs are invalid");
  const notional = mul(count, size);
  const pnl = kind === "LINEAR" ? mul(notional, exit - entry)
    : mul(notional, div(SCALE, entry) - div(SCALE, exit));
  return decimal(sign * pnl);
}

/** Positive funding means the position receives; negative means it pays. */
export function fundingPayment(direction: PositionDirection, kind: ContractKind, contracts: string,
  contractSize: string, markPrice: string, fundingRate: string): string {
  const rate = fixed(fundingRate); const directionSign = direction === "LONG" ? -1n : 1n;
  const sizing = derivativeSizing({ kind, contractSize, baseCurrency: "BASE", quoteCurrency: "QUOTE",
    settlementCurrency: kind === "LINEAR" ? "QUOTE" : "BASE", marginCurrency: "MARGIN" },
  "CONTRACTS", contracts, markPrice);
  const basis = fixed(kind === "LINEAR" ? sizing.quoteNotional : sizing.baseQuantity);
  return decimal(directionSign * mul(basis, rate));
}

export interface FundingLedger {
  balance: string;
  currency: string;
  appliedEventIds: readonly string[];
}

export function applyFundingEvent(ledger: FundingLedger, event: { id: string; amount: string;
  currency: string }): FundingLedger {
  if (!/^[A-Za-z0-9:_-]{8,160}$/.test(event.id)) throw new Error("funding event identity is invalid");
  if (event.currency !== ledger.currency) throw new Error("funding currency does not match settlement ledger");
  if (ledger.appliedEventIds.includes(event.id)) return ledger;
  return { balance: decimal(fixed(ledger.balance) + fixed(event.amount)), currency: ledger.currency,
    appliedEventIds: [...ledger.appliedEventIds, event.id] };
}

export interface CompletedCandle {
  closeTime: string;
  complete: boolean;
  mark: string;
  index: string;
  last: string;
}

/**
 * Truthful paper protection: decide only after a completed candle and execute
 * at the next market observation. The trigger price is never returned as a
 * fill and no intrabar parity is implied.
 */
export function evaluateCompletedCandleProtection(protective: ProtectiveIntent,
  direction: PositionDirection, candle: CompletedCandle): { triggered: boolean; execute: "NEXT_MARKET_OBSERVATION" | null } {
  if (!candle.complete) return { triggered: false, execute: null };
  const observed = fixed(candle[protective.triggerPriceRole.toLowerCase() as Lowercase<PriceRole>]);
  const trigger = fixed(protective.triggerPrice);
  const lowerTrigger = protective.kind === "STOP_LOSS" ? direction === "LONG" : direction === "SHORT";
  const triggered = lowerTrigger ? observed <= trigger : observed >= trigger;
  return { triggered, execute: triggered ? "NEXT_MARKET_OBSERVATION" : null };
}

export function expiryTransition(expiry: string | undefined, now: string,
  openContracts: string): "PERPETUAL" | "TRADING" | "DELIVERY_PENDING" | "DELIVERED" {
  if (!expiry) return "PERPETUAL";
  const expiryMs = Date.parse(expiry), nowMs = Date.parse(now);
  if (!Number.isFinite(expiryMs) || !Number.isFinite(nowMs)) throw new Error("invalid expiry instant");
  if (nowMs < expiryMs) return "TRADING";
  return fixed(openContracts) > 0n ? "DELIVERY_PENDING" : "DELIVERED";
}
