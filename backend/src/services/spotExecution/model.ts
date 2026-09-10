export const SPOT_VENUES = [
  "binance", "coinbase", "bybit", "okx", "kraken", "kucoin", "gateio",
  "robinhood", "hyperliquid",
] as const;

export type SpotVenue = typeof SPOT_VENUES[number];

/** Production is deliberately not representable in the X3A execution API. */
export type SafeExecutionEnvironment = "paper" | "testnet" | "demo";
export type SpotOrderType = "MARKET" | "LIMIT" | "LIMIT_MAKER";
export type SpotTimeInForce = "GTC" | "IOC" | "FOK" | "GTD" | "POST_ONLY";
export type SpotSide = "BUY" | "SELL";
export type SpotLifecycle =
  | "REQUESTED" | "SUBMITTED" | "ACK_UNKNOWN" | "OPEN" | "PARTIALLY_FILLED"
  | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";

export interface PlatformOrderIntentIdentity {
  /** Opaque durable identity minted and persisted by Platform before delivery. */
  id: string;
  /** Stable logical identity used for retry/replay conflict detection. */
  dedupeKey: string;
  /** ISO instant persisted with the Platform intent. */
  createdAt: string;
  payloadHash: string;
}

export interface SpotOrderIntent {
  platformIntent: PlatformOrderIntentIdentity;
  accountId: string;
  venue: SpotVenue;
  environment: SafeExecutionEnvironment;
  canonicalInstrumentId: string;
  venueSymbol: string;
  side: SpotSide;
  orderType: SpotOrderType;
  timeInForce?: SpotTimeInForce;
  baseQuantity?: string;
  quoteQuantity?: string;
  limitPrice?: string;
  /** Market observation used only by the deterministic paper driver. */
  paperReferencePrice?: string;
  clientOrderId: string;
  /** Durable provider identity learned from an acknowledgement/reconciliation. */
  providerOrderId?: string;
}

export interface SpotExecutionCapabilities {
  venue: SpotVenue;
  assetClass: "crypto_spot";
  environments: readonly SafeExecutionEnvironment[];
  orderTypes: readonly SpotOrderType[];
  timeInForce: readonly SpotTimeInForce[];
  quoteMarketBuy: boolean;
  clientOrderId: { maxLength: number; pattern: string; transformedPrefix?: string };
  cancelReplace: "atomic" | "cancel_then_new" | "unsupported";
  accountIdentity: string;
  precisionSource: string;
  feeSource: string;
  externalHandshake: "UNVERIFIED_DISABLED";
  officialDocs: readonly string[];
}

export interface SpotOrderSnapshot {
  venue: SpotVenue;
  environment: SafeExecutionEnvironment;
  providerOrderId: string;
  clientOrderId: string;
  status: Exclude<SpotLifecycle, "REQUESTED" | "SUBMITTED" | "ACK_UNKNOWN">;
  filledBaseQuantity: string;
  filledQuoteQuantity: string;
  averageFillPrice: string | null;
  fee: { amount: string; asset: string } | null;
  providerTimestamp: string | null;
  acknowledgedAt: string | null;
  lastFillAt: string | null;
  rawStatus: string;
}

export interface SpotBalance {
  asset: string;
  available: string;
  locked: string;
  observedAt: string;
  stale: boolean;
}

export interface PreparedVenueRequest {
  venue: SpotVenue;
  environment: SafeExecutionEnvironment;
  method: "GET" | "POST" | "DELETE";
  baseUrl: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  /** Safe test evidence: the canonical preimage may not contain credential values. */
  signaturePreimage: string;
}

export interface VenueCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
  privateKeyPem?: string;
  walletAddress?: string;
}

export interface VenueBuildContext {
  nowMs: number;
  nonce: string;
  credentials: VenueCredentials;
}

export interface SpotVenueAdapter {
  capabilities: SpotExecutionCapabilities;
  validate(intent: SpotOrderIntent): void;
  prepareSubmit(intent: SpotOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  prepareQuery(intent: SpotOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  prepareCancel(intent: SpotOrderIntent, context: VenueBuildContext): PreparedVenueRequest;
  normalizeOrder(raw: unknown, intent: SpotOrderIntent, observedAt: string): SpotOrderSnapshot;
  normalizeBalances(raw: unknown, observedAt: string): SpotBalance[];
}

export class SpotCapabilityError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) { super(message); this.name = "SpotCapabilityError"; }
}

export class SpotExecutionError extends Error {
  constructor(message: string, readonly kind: "rejected" | "ambiguous" | "transient") {
    super(message); this.name = "SpotExecutionError";
  }
}
