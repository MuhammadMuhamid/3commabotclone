import type { VenueCredentials } from "../spotExecution/model.js";
import {
  EquityCapabilityError, type EquityPaperAdapter, type EquityPaperOrderIntent,
  type EquityPaperOrderSnapshot, type PreparedAlpacaPaperRequest,
} from "./model.js";

const CANONICAL = /^instrument:v1:(NASDAQ|NYSE|ARCA|AMEX|BATS):(stock|etf):([A-Z][A-Z0-9.-]{0,14}):USD:USD:cash$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export const ALPACA_PAPER_CAPABILITIES = Object.freeze({
  provider: "alpaca" as const, assetClass: "us_equity" as const,
  environments: ["paper"] as const, productionAvailable: false as const,
  endpoint: "https://paper-api.alpaca.markets" as const,
  orderTypes: ["MARKET", "LIMIT"] as const, timeInForce: ["DAY", "GTC"] as const,
  adjustmentMode: "raw" as const,
  extendedHours: { orderType: "LIMIT" as const, timeInForce: ["DAY", "GTC"] as const },
  shortSale: { assetCheckRequired: true as const, borrowStatusRequired: true as const },
  externalHandshake: "UNVERIFIED_DISABLED" as const,
  officialDocs: [
    "https://docs.alpaca.markets/docs/paper-trading",
    "https://docs.alpaca.markets/docs/trading/orders/",
    "https://docs.alpaca.markets/reference/postorder",
    "https://docs.alpaca.markets/reference/get-v2-assets-symbol_or_asset_id",
  ],
});

function age(value: string, nowMs: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? nowMs - parsed : Number.POSITIVE_INFINITY;
}

function validate(intent: EquityPaperOrderIntent, nowMs = Date.now()): void {
  const match = CANONICAL.exec(intent.canonicalInstrumentId);
  if (!match || match[1] !== intent.primaryVenue || match[2]!.toUpperCase() !== intent.instrumentType ||
      match[3] !== intent.providerSymbol) {
    throw new EquityCapabilityError("canonical stock/ETF identity does not match symbol, venue and security type");
  }
  if (intent.environment !== "paper") throw new EquityCapabilityError("only Alpaca paper execution is representable");
  if (intent.adjustmentMode !== "raw") {
    throw new EquityCapabilityError("adjusted bars are analysis data and can never be used as equity execution prices");
  }
  if (intent.asset.status !== "ACTIVE" || !intent.asset.tradable) {
    throw new EquityCapabilityError("asset is inactive or not tradable; provider was not called");
  }
  if (age(intent.asset.observedAt, nowMs) < 0 || age(intent.asset.observedAt, nowMs) > 60_000) {
    throw new EquityCapabilityError("asset capability observation is stale; provider was not called");
  }
  if (age(intent.session.observedAt, nowMs) < 0 || age(intent.session.observedAt, nowMs) > 30_000) {
    throw new EquityCapabilityError("market-session observation is stale; provider was not called");
  }
  if (intent.session.phase === "CLOSED") {
    throw new EquityCapabilityError("US equity session is closed; queuing is disabled and provider was not called");
  }
  if ((intent.session.phase === "PRE" || intent.session.phase === "AFTER")) {
    if (!intent.extendedHours) throw new EquityCapabilityError("extended-hours session requires explicit extendedHours=true");
    if (intent.orderType !== "LIMIT" || !["DAY", "GTC"].includes(intent.timeInForce)) {
      throw new EquityCapabilityError("extended-hours Alpaca orders require LIMIT with DAY or GTC");
    }
  } else if (intent.extendedHours && intent.orderType !== "LIMIT") {
    throw new EquityCapabilityError("an extended-hours-eligible order must be LIMIT");
  }
  if (!DECIMAL.test(intent.quantity) || Number(intent.quantity) <= 0) {
    throw new EquityCapabilityError("quantity must be a positive decimal string");
  }
  if (!intent.asset.fractionable && !Number.isInteger(Number(intent.quantity))) {
    throw new EquityCapabilityError("asset is not fractionable");
  }
  if (!Number.isInteger(Number(intent.quantity)) && intent.timeInForce !== "DAY") {
    throw new EquityCapabilityError("fractional equity orders require DAY time in force");
  }
  if (intent.orderType === "LIMIT") {
    if (!intent.limitPrice || !DECIMAL.test(intent.limitPrice) || Number(intent.limitPrice) <= 0) {
      throw new EquityCapabilityError("LIMIT order requires a positive limitPrice");
    }
    const decimals = intent.limitPrice.split(".")[1]?.length ?? 0;
    if ((Number(intent.limitPrice) >= 1 && decimals > 2) || (Number(intent.limitPrice) < 1 && decimals > 4)) {
      throw new EquityCapabilityError("limitPrice violates Alpaca sub-penny increment rules");
    }
  } else if (intent.limitPrice !== undefined) throw new EquityCapabilityError("MARKET order cannot include limitPrice");
  if (intent.positionEffect === "OPEN_SHORT") {
    if (intent.side !== "SELL") throw new EquityCapabilityError("OPEN_SHORT requires SELL");
    if (intent.asset.shortable !== true || intent.asset.borrowStatus === "UNKNOWN") {
      throw new EquityCapabilityError("fresh shortable and borrow_status truth is required; borrow is never assumed");
    }
  }
  if (intent.positionEffect === "COVER_SHORT" && intent.side !== "BUY") {
    throw new EquityCapabilityError("COVER_SHORT requires BUY");
  }
  if (intent.positionEffect === "OPEN_LONG" && intent.side !== "BUY") {
    throw new EquityCapabilityError("OPEN_LONG requires BUY");
  }
  if (intent.positionEffect === "CLOSE_LONG" && intent.side !== "SELL") {
    throw new EquityCapabilityError("CLOSE_LONG requires SELL");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizedStatus(value: unknown): EquityPaperOrderSnapshot["status"] {
  const status = String(value ?? "").toLowerCase();
  if (status === "new" || status === "accepted" || status === "pending_new") return "NEW";
  if (status === "partially_filled") return "PARTIALLY_FILLED";
  if (status === "filled") return "FILLED";
  if (status === "canceled") return "CANCELED";
  if (status === "rejected") return "REJECTED";
  if (status === "expired") return "EXPIRED";
  return "UNKNOWN";
}

export const alpacaPaperAdapter: EquityPaperAdapter = Object.freeze({
  capabilities: ALPACA_PAPER_CAPABILITIES,
  validate,
  prepareSubmit(intent: EquityPaperOrderIntent, credentials: VenueCredentials): PreparedAlpacaPaperRequest {
    validate(intent);
    if (!credentials.apiKey || !credentials.apiSecret) throw new EquityCapabilityError("Alpaca paper credentials are unavailable");
    const body = { symbol: intent.providerSymbol, qty: intent.quantity, side: intent.side.toLowerCase(),
      type: intent.orderType.toLowerCase(), time_in_force: intent.timeInForce.toLowerCase(),
      extended_hours: intent.extendedHours, client_order_id: intent.clientOrderId,
      ...(intent.limitPrice ? { limit_price: intent.limitPrice } : {}) };
    return { method: "POST", baseUrl: "https://paper-api.alpaca.markets", path: "/v2/orders",
      headers: { "APCA-API-KEY-ID": credentials.apiKey, "APCA-API-SECRET-KEY": credentials.apiSecret,
        "Content-Type": "application/json" }, body: JSON.stringify(body) };
  },
  normalizeOrder(raw: unknown, intent: EquityPaperOrderIntent): EquityPaperOrderSnapshot {
    const row = record(raw); const rawStatus = String(row.status ?? "unknown");
    return { provider: "alpaca", environment: "paper", providerOrderId: String(row.id ?? ""),
      clientOrderId: String(row.client_order_id ?? intent.clientOrderId), symbol: String(row.symbol ?? intent.providerSymbol),
      status: normalizedStatus(rawStatus), filledQuantity: String(row.filled_qty ?? "0"),
      averageFillPrice: row.filled_avg_price === null || row.filled_avg_price === undefined
        ? null : String(row.filled_avg_price), submittedAt: row.submitted_at ? String(row.submitted_at) : null,
      filledAt: row.filled_at ? String(row.filled_at) : null, rawStatus };
  },
});
