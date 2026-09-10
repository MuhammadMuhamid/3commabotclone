import type { PlatformOrderIntentIdentity, VenueCredentials } from "../spotExecution/model.js";

export type EquityInstrumentType = "STOCK" | "ETF";
export type EquityOrderType = "MARKET" | "LIMIT";
export type EquityTimeInForce = "DAY" | "GTC";
export type EquityPositionEffect = "OPEN_LONG" | "CLOSE_LONG" | "OPEN_SHORT" | "COVER_SHORT";
export type EquitySessionPhase = "PRE" | "REGULAR" | "AFTER" | "CLOSED";

/** Production is intentionally not representable. */
export interface EquityPaperOrderIntent {
  platformIntent: PlatformOrderIntentIdentity;
  environment: "paper";
  canonicalInstrumentId: string;
  providerSymbol: string;
  instrumentType: EquityInstrumentType;
  primaryVenue: "NASDAQ" | "NYSE" | "ARCA" | "AMEX" | "BATS";
  side: "BUY" | "SELL";
  positionEffect: EquityPositionEffect;
  quantity: string;
  orderType: EquityOrderType;
  timeInForce: EquityTimeInForce;
  limitPrice?: string;
  extendedHours: boolean;
  adjustmentMode: "raw";
  session: { phase: EquitySessionPhase; observedAt: string; calendarDate: string };
  asset: {
    status: "ACTIVE" | "INACTIVE";
    tradable: boolean;
    fractionable: boolean;
    shortable: boolean | null;
    borrowStatus: "EASY_TO_BORROW" | "HARD_TO_BORROW" | "UNKNOWN";
    observedAt: string;
  };
  clientOrderId: string;
}

export interface EquityPaperCapabilities {
  provider: "alpaca";
  assetClass: "us_equity";
  environments: readonly ["paper"];
  productionAvailable: false;
  endpoint: "https://paper-api.alpaca.markets";
  orderTypes: readonly EquityOrderType[];
  timeInForce: readonly EquityTimeInForce[];
  adjustmentMode: "raw";
  extendedHours: { orderType: "LIMIT"; timeInForce: readonly ["DAY", "GTC"] };
  shortSale: { assetCheckRequired: true; borrowStatusRequired: true };
  externalHandshake: "UNVERIFIED_DISABLED";
  officialDocs: readonly string[];
}

export interface PreparedAlpacaPaperRequest {
  method: "POST";
  baseUrl: "https://paper-api.alpaca.markets";
  path: "/v2/orders";
  headers: { "APCA-API-KEY-ID": string; "APCA-API-SECRET-KEY": string; "Content-Type": "application/json" };
  body: string;
}

export interface EquityPaperOrderSnapshot {
  provider: "alpaca";
  environment: "paper";
  providerOrderId: string;
  clientOrderId: string;
  symbol: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED" | "UNKNOWN";
  filledQuantity: string;
  averageFillPrice: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  rawStatus: string;
}

export interface EquityPaperAdapter {
  capabilities: EquityPaperCapabilities;
  validate(intent: EquityPaperOrderIntent, nowMs?: number): void;
  prepareSubmit(intent: EquityPaperOrderIntent, credentials: VenueCredentials): PreparedAlpacaPaperRequest;
  normalizeOrder(raw: unknown, intent: EquityPaperOrderIntent): EquityPaperOrderSnapshot;
}

export class EquityCapabilityError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) { super(message); this.name = "EquityCapabilityError"; }
}

