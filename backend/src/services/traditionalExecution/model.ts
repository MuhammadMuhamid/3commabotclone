import type { PlatformOrderIntentIdentity } from "../spotExecution/model.js";

export interface TraditionalPaperOrderIntent {
  platformIntent: PlatformOrderIntentIdentity;
  environment: "OANDA_PRACTICE" | "IBKR_PAPER";
  canonicalInstrumentId: string;
  providerId: "oanda-v20-fx-practice" | "ibkr-tws-futures-paper";
  providerSymbol: string;
  instrumentType: "FX_PAIR" | "FUTURE";
  side: "BUY" | "SELL";
  positionDirection: "LONG" | "SHORT";
  quantity: string;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: string;
  priceBasis: "ASK" | "BID" | "EXCHANGE_ORDER";
  session: { open: true; observedAt: string; calendarId: "OANDA_FX_WEEK" | "CME_GLOBEX" };
  contract?: { root: string; contractCode: string; expiry: string; multiplier: number; tickSize: number; tickValue: number };
  clientOrderId: string;
}

export class TraditionalCapabilityError extends Error {
  readonly httpStatus = 422;
  constructor(message: string) { super(message); this.name = "TraditionalCapabilityError"; }
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export function validateTraditionalIntent(intent: TraditionalPaperOrderIntent, now = Date.now()): void {
  if (!DECIMAL.test(intent.quantity) || Number(intent.quantity) <= 0) throw new TraditionalCapabilityError("quantity must be positive");
  const observed = Date.parse(intent.session.observedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > 30_000) throw new TraditionalCapabilityError("session observation is stale");
  if ((intent.orderType === "LIMIT") !== Boolean(intent.limitPrice)) throw new TraditionalCapabilityError("LIMIT requires limitPrice and MARKET forbids it");
  if (intent.limitPrice && (!DECIMAL.test(intent.limitPrice) || Number(intent.limitPrice) <= 0)) throw new TraditionalCapabilityError("limitPrice must be positive");
  if (intent.side === "BUY" && intent.positionDirection !== "LONG" || intent.side === "SELL" && intent.positionDirection !== "SHORT") {
    throw new TraditionalCapabilityError("side and position direction disagree");
  }
  if (intent.instrumentType === "FX_PAIR") {
    if (intent.environment !== "OANDA_PRACTICE" || intent.providerId !== "oanda-v20-fx-practice" ||
      !/^instrument:v1:OANDA:fx_pair:[A-Z]{3}:[A-Z]{3}:[A-Z]{3}:cash$/.test(intent.canonicalInstrumentId) ||
      !/^[A-Z]{3}_[A-Z]{3}$/.test(intent.providerSymbol)) throw new TraditionalCapabilityError("FX identity/provider/environment mismatch");
    if (intent.priceBasis !== (intent.side === "BUY" ? "ASK" : "BID")) throw new TraditionalCapabilityError("FX buys use ask and sells use bid; mid fills are forbidden");
    if (intent.session.calendarId !== "OANDA_FX_WEEK" || intent.contract) throw new TraditionalCapabilityError("FX session/contract semantics mismatch");
  } else {
    if (intent.environment !== "IBKR_PAPER" || intent.providerId !== "ibkr-tws-futures-paper" ||
      !/^instrument:v1:(CME|NYMEX|COMEX|CBOT):future:[A-Z0-9]+:USD:USD:dated-\d{8}$/.test(intent.canonicalInstrumentId)) {
      throw new TraditionalCapabilityError("futures identity/provider/environment mismatch");
    }
    if (intent.priceBasis !== "EXCHANGE_ORDER" || intent.session.calendarId !== "CME_GLOBEX" || !intent.contract) {
      throw new TraditionalCapabilityError("futures contract/session semantics are required");
    }
    if (!Number.isInteger(Number(intent.quantity))) throw new TraditionalCapabilityError("futures quantity must be whole contracts");
    if (Date.parse(`${intent.contract.expiry}T23:59:59Z`) <= now) throw new TraditionalCapabilityError("futures contract is expired");
    if (intent.contract.multiplier <= 0 || intent.contract.tickSize <= 0 ||
      Math.abs(intent.contract.tickValue - intent.contract.multiplier * intent.contract.tickSize) > 1e-8) {
      throw new TraditionalCapabilityError("futures multiplier/tick value is inconsistent");
    }
    if (intent.limitPrice) {
      const ticks = Number(intent.limitPrice) / intent.contract.tickSize;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-8) throw new TraditionalCapabilityError("futures limitPrice is off tick");
    }
  }
}

