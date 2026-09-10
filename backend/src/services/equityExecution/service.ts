import { createHash } from "node:crypto";
import { config } from "../../config.js";
import type { VenueCredentials } from "../spotExecution/model.js";
import { alpacaPaperAdapter } from "./alpaca.js";
import type { EquityPaperOrderIntent, EquityPaperOrderSnapshot } from "./model.js";

export type EquityPaperCommand = Omit<EquityPaperOrderIntent, "clientOrderId">;

export interface EquityPaperTransport {
  submit(intent: EquityPaperOrderIntent): Promise<EquityPaperOrderSnapshot>;
}

export function alpacaClientOrderId(platformIntentId: string): string {
  return `x4_${createHash("sha256").update(platformIntentId).digest("hex").slice(0, 32)}`;
}

export function createAlpacaPaperHttpTransport(credentials: VenueCredentials,
  request: typeof fetch = fetch): EquityPaperTransport {
  return { submit: async (intent) => {
    const prepared = alpacaPaperAdapter.prepareSubmit(intent, credentials);
    const response = await request(`${prepared.baseUrl}${prepared.path}`, {
      method: prepared.method, headers: prepared.headers, body: prepared.body,
    });
    const raw = await response.json() as unknown;
    if (!response.ok) throw new EquityExecutionServiceError(`Alpaca paper rejected the order (${response.status})`, 502);
    return alpacaPaperAdapter.normalizeOrder(raw, intent);
  } };
}

export class EquityExecutionServiceError extends Error {
  constructor(message: string, readonly httpStatus = 400) { super(message); this.name = "EquityExecutionServiceError"; }
}

export async function submitEquityPaperOrder(command: EquityPaperCommand,
  transport: EquityPaperTransport = createAlpacaPaperHttpTransport({
    apiKey: config.alpacaPaperApiKey, apiSecret: config.alpacaPaperApiSecret,
  })): Promise<EquityPaperOrderSnapshot> {
  const intent: EquityPaperOrderIntent = { ...command, clientOrderId: alpacaClientOrderId(command.platformIntent.id) };
  alpacaPaperAdapter.validate(intent);
  return transport.submit(intent);
}

