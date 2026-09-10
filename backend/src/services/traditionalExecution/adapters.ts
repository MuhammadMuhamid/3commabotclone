import { config } from "../../config.js";
import { TraditionalCapabilityError, validateTraditionalIntent, type TraditionalPaperOrderIntent } from "./model.js";

export const TRADITIONAL_PAPER_CAPABILITIES = Object.freeze({
  environments: ["OANDA_PRACTICE", "IBKR_PAPER"] as const, productionAvailable: false as const,
  oandaOrigin: "https://api-fxpractice.oanda.com" as const, ibkrTransport: "local authenticated TWS/Gateway paper session" as const,
  externalHandshake: "UNVERIFIED_DISABLED" as const,
  officialDocs: ["https://developer.oanda.com/rest-live-v20/order-ep/",
    "https://www.interactivebrokers.com/campus/ibkr-api-page/twsapi-doc/",
    "https://www.ibkrguides.com/clientportal/aboutpapertradingaccounts.htm"],
});

export interface PreparedOandaPracticeRequest { method: "POST"; baseUrl: "https://api-fxpractice.oanda.com";
  path: string; headers: { Authorization: string; "Content-Type": "application/json" }; body: string }

export function prepareOandaPracticeOrder(intent: TraditionalPaperOrderIntent,
  credentials = { accountId: config.oandaPracticeAccountId, token: config.oandaPracticeToken }, now = Date.now()): PreparedOandaPracticeRequest {
  validateTraditionalIntent(intent, now);
  if (intent.instrumentType !== "FX_PAIR") throw new TraditionalCapabilityError("OANDA adapter accepts FX pairs only");
  if (!/^[A-Za-z0-9-]{1,80}$/.test(credentials.accountId) || !credentials.token) throw new TraditionalCapabilityError("OANDA practice credentials are unavailable");
  return { method: "POST", baseUrl: "https://api-fxpractice.oanda.com",
    path: `/v3/accounts/${credentials.accountId}/orders`, headers: { Authorization: `Bearer ${credentials.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ order: { instrument: intent.providerSymbol,
      units: `${intent.side === "SELL" ? "-" : ""}${intent.quantity}`, type: intent.orderType,
      ...(intent.limitPrice ? { price: intent.limitPrice } : {}), timeInForce: intent.orderType === "MARKET" ? "FOK" : "GTC",
      positionFill: "DEFAULT", clientExtensions: { id: intent.clientOrderId } } }) };
}

/** IBKR uses a stateful local TWS/Gateway API, so transport is explicitly injected and fixture-tested. */
export interface IbkrPaperTransport { submit(intent: TraditionalPaperOrderIntent): Promise<unknown> }
export async function submitIbkrPaperOrder(intent: TraditionalPaperOrderIntent, transport?: IbkrPaperTransport, now = Date.now()): Promise<unknown> {
  validateTraditionalIntent(intent, now);
  if (intent.instrumentType !== "FUTURE") throw new TraditionalCapabilityError("IBKR adapter accepts exchange futures only");
  if (!config.ibkrPaperGatewayEnabled || !transport) throw new TraditionalCapabilityError("IBKR paper TWS/Gateway handshake is UNVERIFIED_DISABLED");
  return transport.submit(intent);
}
