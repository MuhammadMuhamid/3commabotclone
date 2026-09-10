import { createHash } from "node:crypto";
import { Prisma, type ExchangeAccount, type SpotExecutionOrder } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { canonicalJson } from "../manualAuth.js";
import { spotAdapter } from "./adapters.js";
import { spotCapabilities } from "./capabilities.js";
import {
  SPOT_VENUES, type SafeExecutionEnvironment, type SpotOrderIntent, type SpotOrderSnapshot,
  type SpotOrderType, type SpotSide, type SpotTimeInForce, type SpotVenue, SpotCapabilityError,
  SpotExecutionError,
} from "./model.js";

const ACTIVE = ["submitted", "ack_unknown", "open", "partially_filled"];
const TERMINAL = new Set(["filled", "canceled", "rejected", "expired"]);

export interface SpotExecutionCommand {
  platformIntent: SpotOrderIntent["platformIntent"];
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
  paperReferencePrice?: string;
}

export interface SpotExecutionDriver {
  submit(intent: SpotOrderIntent): Promise<SpotOrderSnapshot>;
  query(intent: SpotOrderIntent): Promise<SpotOrderSnapshot | null>;
  cancel(intent: SpotOrderIntent): Promise<SpotOrderSnapshot>;
}

export class SpotExecutionServiceError extends Error {
  constructor(message: string, readonly httpStatus = 400) {
    super(message); this.name = "SpotExecutionServiceError";
  }
}

function monetaryPayload(input: Omit<SpotExecutionCommand, "platformIntent">): object {
  return {
    accountId: input.accountId, venue: input.venue, environment: input.environment,
    canonicalInstrumentId: input.canonicalInstrumentId, venueSymbol: input.venueSymbol,
    side: input.side, orderType: input.orderType, timeInForce: input.timeInForce ?? null,
    baseQuantity: input.baseQuantity ?? null, quoteQuantity: input.quoteQuantity ?? null,
    limitPrice: input.limitPrice ?? null, paperReferencePrice: input.paperReferencePrice ?? null,
  };
}

export function spotExecutionPayloadHash(input: Omit<SpotExecutionCommand, "platformIntent">): string {
  return createHash("sha256").update(canonicalJson(monetaryPayload(input))).digest("hex");
}

function uuidFromHex(hex: string): string {
  const raw = hex.slice(0, 32); return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function venueClientOrderId(venue: SpotVenue, platformIntentId: string): string {
  const digest = createHash("sha256").update(`x3a:${venue}:${platformIntentId}`).digest("hex");
  if (venue === "hyperliquid") return `0x${digest.slice(0, 32)}`;
  if (venue === "robinhood" || venue === "kraken" || venue === "coinbase") return uuidFromHex(digest);
  if (venue === "gateio") return `t-x3a-${digest.slice(0, 18)}`;
  if (venue === "okx") return `x3a${digest.slice(0, 28)}`;
  return `x3a-${digest.slice(0, 28)}`;
}

function intentFrom(command: SpotExecutionCommand): SpotOrderIntent {
  return { ...command, clientOrderId: venueClientOrderId(command.venue, command.platformIntent.id) };
}

function intentFromRow(row: SpotExecutionOrder): SpotOrderIntent {
  return { platformIntent: { id: row.platformIntentId, dedupeKey: row.platformDedupeKey,
      createdAt: row.platformIntentCreatedAt.toISOString(), payloadHash: row.platformPayloadHash },
    accountId: row.exchangeAccountId, venue: row.venue as SpotVenue,
    environment: row.environment as SafeExecutionEnvironment,
    canonicalInstrumentId: row.canonicalInstrumentId, venueSymbol: row.venueSymbol,
    side: row.side as SpotSide, orderType: row.orderType as SpotOrderType,
    timeInForce: row.timeInForce as SpotTimeInForce | undefined,
    baseQuantity: row.requestedBaseQty ?? undefined, quoteQuantity: row.requestedQuoteQty ?? undefined,
    limitPrice: row.limitPrice ?? undefined, paperReferencePrice: row.paperReferencePrice ?? undefined,
    clientOrderId: row.clientOrderId, providerOrderId: row.providerOrderId ?? undefined };
}

function sameReservation(row: SpotExecutionOrder, command: SpotExecutionCommand): boolean {
  const intent = intentFrom(command);
  return row.platformIntentId === command.platformIntent.id
    && row.platformDedupeKey === command.platformIntent.dedupeKey
    && row.platformPayloadHash === command.platformIntent.payloadHash
    && row.exchangeAccountId === command.accountId && row.venue === command.venue
    && row.environment === command.environment && row.canonicalInstrumentId === command.canonicalInstrumentId
    && row.venueSymbol === command.venueSymbol && row.side === command.side
    && row.orderType === command.orderType && row.timeInForce === (command.timeInForce ?? null)
    && row.requestedBaseQty === (command.baseQuantity ?? null)
    && row.requestedQuoteQty === (command.quoteQuantity ?? null)
    && row.limitPrice === (command.limitPrice ?? null)
    && row.paperReferencePrice === (command.paperReferencePrice ?? null)
    && row.clientOrderId === intent.clientOrderId;
}

function assertAccount(account: ExchangeAccount | null, command: SpotExecutionCommand): asserts account is ExchangeAccount {
  if (!account) throw new SpotExecutionServiceError("execution account not found", 404);
  if (account.marketType.toLowerCase() !== "spot" || account.exchange.toLowerCase() !== command.venue) {
    throw new SpotExecutionServiceError("execution account venue/market does not match the durable intent", 422);
  }
  if (!account.testnet) {
    throw new SpotExecutionServiceError(
      "X3A accepts paper/testnet/demo accounts only; production/mainnet execution is unavailable", 403);
  }
  if (command.environment === "paper" && !command.paperReferencePrice) {
    throw new SpotExecutionServiceError("paper execution requires a Platform market reference price", 422);
  }
}

function assertPlatformIdentity(command: SpotExecutionCommand): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(command.platformIntent.id)
      || !/^[A-Za-z0-9:_-]{16,160}$/.test(command.platformIntent.dedupeKey)) {
    throw new SpotExecutionServiceError("durable Platform order-intent identity is required", 401);
  }
  if (command.platformIntent.payloadHash !== spotExecutionPayloadHash(command)) {
    throw new SpotExecutionServiceError("Platform order-intent payload hash does not match the execution request", 409);
  }
  const created = Date.parse(command.platformIntent.createdAt);
  if (!Number.isFinite(created) || created > Date.now() + 60_000) {
    throw new SpotExecutionServiceError("Platform order-intent timestamp is invalid", 401);
  }
}

export class DeterministicPaperDriver implements SpotExecutionDriver {
  async submit(intent: SpotOrderIntent): Promise<SpotOrderSnapshot> {
    const price = Number(intent.paperReferencePrice);
    if (!(Number.isFinite(price) && price > 0)) {
      throw new SpotExecutionError("paper reference price is invalid", "rejected");
    }
    const base = Number(intent.baseQuantity ?? 0) || Number(intent.quoteQuantity ?? 0) / price;
    const crossed = intent.orderType === "MARKET"
      || (intent.side === "BUY" && Number(intent.limitPrice) >= price)
      || (intent.side === "SELL" && Number(intent.limitPrice) <= price);
    const filledBase = crossed ? String(base) : "0";
    const filledQuote = crossed ? String(base * price) : "0";
    const now = new Date().toISOString();
    return { venue: intent.venue, environment: "paper", providerOrderId: `paper-${intent.clientOrderId}`,
      clientOrderId: intent.clientOrderId, status: crossed ? "FILLED" : "OPEN",
      filledBaseQuantity: filledBase, filledQuoteQuantity: filledQuote,
      averageFillPrice: crossed ? String(price) : null, fee: crossed
        ? { amount: String(Number(filledQuote) * 0.001), asset: intent.venueSymbol.includes("-")
          ? intent.venueSymbol.split("-").at(-1)! : "QUOTE" } : null,
      providerTimestamp: now, acknowledgedAt: now, lastFillAt: crossed ? now : null,
      rawStatus: crossed ? "PAPER_FILLED" : "PAPER_OPEN" };
  }
  async query(intent: SpotOrderIntent): Promise<SpotOrderSnapshot | null> {
    if (intent.orderType === "MARKET") return this.submit(intent);
    const submitted = await this.submit(intent);
    return submitted;
  }
  async cancel(intent: SpotOrderIntent): Promise<SpotOrderSnapshot> {
    const now = new Date().toISOString();
    return { venue: intent.venue, environment: "paper", providerOrderId: `paper-${intent.clientOrderId}`,
      clientOrderId: intent.clientOrderId, status: "CANCELED", filledBaseQuantity: "0",
      filledQuoteQuantity: "0", averageFillPrice: null, fee: null, providerTimestamp: now,
      acknowledgedAt: now, lastFillAt: null, rawStatus: "PAPER_CANCELED" };
  }
}

class DisabledExternalDriver implements SpotExecutionDriver {
  private refusal(intent: SpotOrderIntent): never {
    throw new SpotExecutionError(
      `${intent.venue} ${intent.environment} handshake is UNVERIFIED and disabled; no request was sent`, "rejected");
  }
  submit(intent: SpotOrderIntent): Promise<SpotOrderSnapshot> { return Promise.reject(this.refusal(intent)); }
  query(intent: SpotOrderIntent): Promise<SpotOrderSnapshot | null> { return Promise.reject(this.refusal(intent)); }
  cancel(intent: SpotOrderIntent): Promise<SpotOrderSnapshot> { return Promise.reject(this.refusal(intent)); }
}

const defaultDriver = (intent: SpotOrderIntent): SpotExecutionDriver =>
  intent.environment === "paper" ? new DeterministicPaperDriver() : new DisabledExternalDriver();

async function reserve(command: SpotExecutionCommand): Promise<{ order: SpotExecutionOrder; created: boolean }> {
  const intent = intentFrom(command);
  try {
    const order = await prisma.spotExecutionOrder.create({ data: {
      platformIntentId: command.platformIntent.id, platformDedupeKey: command.platformIntent.dedupeKey,
      platformPayloadHash: command.platformIntent.payloadHash,
      platformIntentCreatedAt: new Date(command.platformIntent.createdAt), exchangeAccountId: command.accountId,
      venue: command.venue, environment: command.environment, canonicalInstrumentId: command.canonicalInstrumentId,
      venueSymbol: command.venueSymbol, side: command.side, orderType: command.orderType,
      timeInForce: command.timeInForce, requestedBaseQty: command.baseQuantity,
      requestedQuoteQty: command.quoteQuantity, limitPrice: command.limitPrice,
      paperReferencePrice: command.paperReferencePrice, clientOrderId: intent.clientOrderId,
    }});
    return { order, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.spotExecutionOrder.findFirst({ where: { OR: [
      { platformIntentId: command.platformIntent.id }, { platformDedupeKey: command.platformIntent.dedupeKey },
      { clientOrderId: intent.clientOrderId },
    ] }});
    if (!existing || !sameReservation(existing, command)) {
      throw new SpotExecutionServiceError("Platform intent, dedupe key, or client order id was replayed with different terms", 409);
    }
    return { order: existing, created: false };
  }
}

function date(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function terminal(status: string): boolean { return TERMINAL.has(status); }

export async function applySpotSnapshot(orderId: string, next: SpotOrderSnapshot): Promise<SpotExecutionOrder> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.spotExecutionOrder.findUnique({ where: { id: orderId } });
    if (!before) throw new SpotExecutionServiceError("spot execution order not found", 404);
    if (next.clientOrderId !== before.clientOrderId || next.venue !== before.venue
        || next.environment !== before.environment) {
      throw new SpotExecutionServiceError("provider acknowledgement identity does not match durable intent", 409);
    }
    if (before.providerOrderId && next.providerOrderId
        && before.providerOrderId !== next.providerOrderId) {
      throw new SpotExecutionServiceError("provider order id changed for one durable intent", 409);
    }
    const nextBase = Number(next.filledBaseQuantity), beforeBase = Number(before.filledBaseQty);
    const nextQuote = Number(next.filledQuoteQuantity), beforeQuote = Number(before.filledQuoteQty);
    if (!Number.isFinite(nextBase) || !Number.isFinite(nextQuote) || nextBase < beforeBase || nextQuote < beforeQuote) {
      return before;
    }
    const status = next.status.toLowerCase();
    // Provider snapshots may arrive duplicated or out of order. Never regress a
    // partial fill to OPEN, and only let a late fill overtake CANCELED when its
    // cumulative fill actually increased (the canonical cancel/fill race).
    if (before.status === "partially_filled" && status === "open") return before;
    if (terminal(before.status)) {
      const lateCancelRaceFill = before.status === "canceled" && status === "filled"
        && (nextBase > beforeBase || nextQuote > beforeQuote);
      if (!lateCancelRaceFill) return before;
    }
    return tx.spotExecutionOrder.update({ where: { id: orderId }, data: {
      status, providerOrderId: next.providerOrderId || before.providerOrderId,
      providerStatus: next.rawStatus, filledBaseQty: next.filledBaseQuantity,
      filledQuoteQty: next.filledQuoteQuantity, averageFillPrice: next.averageFillPrice,
      feeAmount: next.fee?.amount ?? before.feeAmount, feeAsset: next.fee?.asset ?? before.feeAsset,
      error: null, acknowledgedAt: date(next.acknowledgedAt) ?? before.acknowledgedAt,
      lastFillAt: date(next.lastFillAt) ?? before.lastFillAt, reconciledAt: new Date(),
      completedAt: terminal(status) ? new Date() : null,
    }});
  });
}

export async function submitSpotExecution(command: SpotExecutionCommand,
  driverFactory: (intent: SpotOrderIntent) => SpotExecutionDriver = defaultDriver): Promise<SpotExecutionOrder> {
  if (!SPOT_VENUES.includes(command.venue)) throw new SpotCapabilityError(`unsupported spot venue: ${command.venue}`);
  assertPlatformIdentity(command);
  const account = await prisma.exchangeAccount.findUnique({ where: { id: command.accountId } });
  assertAccount(account, command);
  const intent = intentFrom(command); spotAdapter(command.venue).validate(intent);
  const held = await reserve(command);
  if (!held.created || held.order.status !== "requested") return held.order;
  const claimed = await prisma.spotExecutionOrder.updateMany({ where: { id: held.order.id, status: "requested" },
    data: { status: "submitted", submittedAt: new Date(), error: null } });
  if (claimed.count !== 1) return prisma.spotExecutionOrder.findUniqueOrThrow({ where: { id: held.order.id } });
  try {
    return await applySpotSnapshot(held.order.id, await driverFactory(intent).submit(intent));
  } catch (error) {
    const explicit = error instanceof SpotExecutionError && error.kind === "rejected";
    return prisma.spotExecutionOrder.update({ where: { id: held.order.id }, data: {
      status: explicit ? "rejected" : "ack_unknown",
      error: error instanceof Error ? error.message : "provider acknowledgement unknown",
      completedAt: explicit ? new Date() : null,
    }});
  }
}

export async function reconcileSpotExecutionOrders(
  driverFactory: (intent: SpotOrderIntent) => SpotExecutionDriver = defaultDriver, limit = 100
): Promise<void> {
  const orders = await prisma.spotExecutionOrder.findMany({ where: { status: { in: ACTIVE } },
    orderBy: { createdAt: "asc" }, take: Math.min(100, Math.max(1, limit)) });
  for (const order of orders) {
    const intent = intentFromRow(order);
    try {
      const found = await driverFactory(intent).query(intent);
      if (found) await applySpotSnapshot(order.id, found);
      else await prisma.spotExecutionOrder.update({ where: { id: order.id }, data: {
        status: "ack_unknown", reconciledAt: new Date(),
        error: "provider lookup found no order; submission remains ambiguous and was not retried",
      }});
    } catch (error) {
      await prisma.spotExecutionOrder.update({ where: { id: order.id }, data: {
        reconciledAt: new Date(), error: `reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}`,
      }});
    }
  }
}

export async function cancelSpotExecution(orderId: string,
  driverFactory: (intent: SpotOrderIntent) => SpotExecutionDriver = defaultDriver): Promise<SpotExecutionOrder> {
  const order = await prisma.spotExecutionOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new SpotExecutionServiceError("spot execution order not found", 404);
  if (terminal(order.status)) return order;
  const intent = intentFromRow(order);
  try { return await applySpotSnapshot(order.id, await driverFactory(intent).cancel(intent)); }
  catch (error) {
    await prisma.spotExecutionOrder.update({ where: { id: order.id }, data: {
      error: `cancel outcome unknown; reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}`,
    }});
    return prisma.spotExecutionOrder.findUniqueOrThrow({ where: { id: order.id } });
  }
}

export async function readSpotExecutionState(): Promise<object> {
  const [accounts, orders] = await Promise.all([
    prisma.exchangeAccount.findMany({ where: { marketType: "spot", testnet: true },
      select: { id: true, name: true, exchange: true, marketType: true, testnet: true }, orderBy: { createdAt: "asc" } }),
    prisma.spotExecutionOrder.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  return { mode: "PAPER_TESTNET_ONLY", productionTrading: false, productionActivationAvailable: false,
    warning: "SIMULATED / TESTNET ONLY — no production or mainnet orders can be submitted",
    externalHandshakes: "UNVERIFIED_DISABLED", accounts: accounts.map((a) => ({ ...a,
      allowedEnvironments: [...new Set(["paper",
        ...(spotCapabilities().find((c) => c.venue === a.exchange)?.environments ?? [])])],
      production: false })),
    capabilities: spotCapabilities(), orders };
}
