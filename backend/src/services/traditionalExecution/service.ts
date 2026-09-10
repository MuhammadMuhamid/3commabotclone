import { createHash } from "node:crypto";
import { prepareOandaPracticeOrder, submitIbkrPaperOrder, type IbkrPaperTransport } from "./adapters.js";
import { TraditionalCapabilityError, validateTraditionalIntent, type TraditionalPaperOrderIntent } from "./model.js";

type Command = Omit<TraditionalPaperOrderIntent, "clientOrderId">;
export interface TraditionalTransport { submitOanda?(prepared: ReturnType<typeof prepareOandaPracticeOrder>): Promise<unknown>; ibkr?: IbkrPaperTransport }
export async function submitTraditionalPaperOrder(command: Command, transport: TraditionalTransport = {}, now = Date.now()): Promise<unknown> {
  const intent = { ...command, clientOrderId: `x5_${createHash("sha256").update(command.platformIntent.id).digest("hex").slice(0, 32)}` };
  validateTraditionalIntent(intent, now);
  if (intent.environment === "OANDA_PRACTICE") {
    const prepared = prepareOandaPracticeOrder(intent, undefined, now);
    if (!transport.submitOanda) {
      const response = await fetch(`${prepared.baseUrl}${prepared.path}`, { method: prepared.method, headers: prepared.headers, body: prepared.body });
      if (!response.ok) throw new TraditionalCapabilityError(`OANDA practice rejected order (${response.status})`);
      return response.json();
    }
    return transport.submitOanda(prepared);
  }
  return submitIbkrPaperOrder(intent, transport.ibkr, now);
}
