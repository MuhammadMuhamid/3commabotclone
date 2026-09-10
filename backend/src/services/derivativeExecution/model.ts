import type { PlatformOrderIntentIdentity, PreparedVenueRequest, SafeExecutionEnvironment,
  VenueBuildContext } from "../spotExecution/model.js";
import type { ShariahContext } from "../../contract/webhookContract.js";

export const DERIVATIVE_VENUES = [
  "binance", "bybit", "okx", "kucoin", "gateio", "kraken", "hyperliquid", "coinbase",
] as const;

export type DerivativeVenue = typeof DERIVATIVE_VENUES[number];
export type ContractKind = "LINEAR" | "INVERSE";
export type PositionDirection = "LONG" | "SHORT";
export type DerivativeSide = "BUY" | "SELL";
export type QuantityUnit = "CONTRACTS" | "BASE";
export type MarginMode = "ISOLATED" | "CROSS";
export type PositionMode = "ONE_WAY" | "HEDGE";
export type PriceRole = "MARK" | "INDEX" | "LAST";
export type DerivativeOrderType = "MARKET" | "LIMIT" | "STOP_MARKET" | "TAKE_PROFIT_MARKET";
export type DerivativeTimeInForce = "GTC" | "IOC" | "FOK" | "GTD" | "POST_ONLY";
export type ProtectionKind = "STOP_LOSS" | "TAKE_PROFIT";
export type DerivativeLifecycle = "REQUESTED" | "SUBMITTED" | "ACK_UNKNOWN" | "OPEN"
  | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export interface DerivativeInstrument {
  kind: ContractKind;
  /** BASE per contract for linear; QUOTE notional per contract for inverse. */
  contractSize: string;
  baseCurrency: string;
  quoteCurrency: string;
  settlementCurrency: string;
  marginCurrency: string;
  /** Required for dated futures; absent means perpetual. */
  expiry?: string;
}

export interface PositionObservation {
  direction: PositionDirection;
  contracts: string;
  entryPrice: string;
  markPrice: string;
  observedAt: string;
  version: string;
  liquidationPrice?: string;
  maintenanceMargin?: string;
}

export interface ProtectiveIntent {
  kind: ProtectionKind;
  triggerPrice: string;
  triggerPriceRole: PriceRole;
  /** Paper protection deliberately has no intrabar/trigger-price parity claim. */
  paperTriggerModel: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE";
}

export interface DerivativeOrderIntent {
  platformIntent: PlatformOrderIntentIdentity;
  accountId: string;
  venue: DerivativeVenue;
  environment: SafeExecutionEnvironment;
  canonicalInstrumentId: string;
  venueSymbol: string;
  instrument: DerivativeInstrument;
  positionDirection: PositionDirection;
  actionSide: DerivativeSide;
  quantityUnit: QuantityUnit;
  quantity?: string;
  marginMode: MarginMode;
  leverage?: string;
  positionMode: PositionMode;
  reduceOnly: boolean;
  closePosition: boolean;
  orderType: DerivativeOrderType;
  timeInForce?: DerivativeTimeInForce;
  limitPrice?: string;
  protective?: ProtectiveIntent;
  paperReferencePrice?: string;
  position?: PositionObservation;
  /** Existing policy context for the underlying; omission fails closed when the installation floor enforces. */
  shariah?: ShariahContext;
  clientOrderId: string;
  providerOrderId?: string;
}

export interface ProtectiveCapability {
  paper: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE";
  nativeOrderTypes: readonly DerivativeOrderType[];
  nativeTriggerRoles: readonly PriceRole[];
  nativeRestingProof: "UNVERIFIED_DISABLED";
  exposure: string;
}

export interface DerivativeExecutionCapabilities {
  venue: DerivativeVenue;
  assetClass: "crypto_derivative";
  environments: readonly SafeExecutionEnvironment[];
  contractKinds: readonly ContractKind[];
  quantityUnits: readonly QuantityUnit[];
  marginModes: readonly MarginMode[];
  positionModes: readonly PositionMode[];
  orderTypes: readonly DerivativeOrderType[];
  timeInForce: readonly DerivativeTimeInForce[];
  leverage: { atOrder: boolean; maximum: string | null; source: string };
  reduceOnly: boolean;
  closePosition: boolean;
  markPrice: boolean;
  indexPrice: boolean;
  lastPrice: boolean;
  funding: boolean;
  datedExpiry: boolean;
  protective: ProtectiveCapability;
  clientOrderId: { maxLength: number; pattern: string };
  externalHandshake: "UNVERIFIED_DISABLED" | "NOT_AVAILABLE";
  officialDocs: readonly string[];
  notes: readonly string[];
}

export interface DerivativeOrderSnapshot {
  venue: DerivativeVenue;
  environment: SafeExecutionEnvironment;
  providerOrderId: string;
  clientOrderId: string;
  status: Exclude<DerivativeLifecycle, "REQUESTED" | "SUBMITTED" | "ACK_UNKNOWN">;
  filledContracts: string;
  filledBaseQuantity: string;
  filledNotional: string;
  averageFillPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  pnlCurrency: string;
  funding: { amount: string; currency: string };
  fee: { amount: string; currency: string } | null;
  prices: { mark: string | null; index: string | null; last: string | null };
  liquidationPrice: string | null;
  maintenanceMargin: string | null;
  providerTimestamp: string | null;
  acknowledgedAt: string | null;
  lastFillAt: string | null;
  rawStatus: string;
}

export interface DerivativeVenueAdapter {
  capabilities: DerivativeExecutionCapabilities;
  validate(intent: DerivativeOrderIntent, nowMs?: number): void;
  prepareSubmit(intent: DerivativeOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  prepareQuery(intent: DerivativeOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  prepareCancel(intent: DerivativeOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  normalizeOrder(raw: unknown, intent: DerivativeOrderIntent, observedAt: string): DerivativeOrderSnapshot;
}

export class DerivativeCapabilityError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) { super(message); this.name = "DerivativeCapabilityError"; }
}

export class DerivativeExecutionError extends Error {
  constructor(message: string, readonly kind: "rejected" | "ambiguous" | "transient") {
    super(message); this.name = "DerivativeExecutionError";
  }
}
