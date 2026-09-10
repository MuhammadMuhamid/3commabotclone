import { createHash } from "node:crypto";
import { Prisma, type DerivativeExecutionOrder, type ExchangeAccount } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { canonicalJson } from "../manualAuth.js";
import { derivativeAdapter } from "./adapters.js";
import { derivativeCapabilities } from "./capabilities.js";
import { decimalProduct, derivativePnl, derivativeSizing, evaluateCompletedCandleProtection,
  type CompletedCandle } from "./math.js";
import { DERIVATIVE_VENUES, DerivativeCapabilityError, DerivativeExecutionError,
  type ContractKind, type DerivativeOrderIntent, type DerivativeOrderSnapshot,
  type DerivativeOrderType, type DerivativeSide, type DerivativeTimeInForce,
  type DerivativeVenue, type MarginMode, type PositionDirection, type PositionMode,
  type ProtectiveIntent, type QuantityUnit } from "./model.js";
import type { SafeExecutionEnvironment } from "../spotExecution/model.js";
import { admitSpotEntry, noteSpotExit, readShariahContext, serializeShariahContext,
  shariahScopeForManualAccount } from "../shariah.js";
import type { ShariahContext } from "../../contract/webhookContract.js";

const ACTIVE = ["submitted", "ack_unknown", "open", "partially_filled"];
const TERMINAL = new Set(["filled", "canceled", "rejected", "expired"]);

export interface DerivativeExecutionCommand {
  platformIntent: DerivativeOrderIntent["platformIntent"];
  accountId: string;
  venue: DerivativeVenue;
  environment: SafeExecutionEnvironment;
  canonicalInstrumentId: string;
  venueSymbol: string;
  instrument: DerivativeOrderIntent["instrument"];
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
  position?: DerivativeOrderIntent["position"];
  shariah?: ShariahContext;
}

export interface DerivativeExecutionDriver {
  submit(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot>;
  query(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot | null>;
  cancel(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot>;
}

export class DerivativeExecutionServiceError extends Error {
  constructor(message: string, readonly httpStatus = 400) {
    super(message); this.name = "DerivativeExecutionServiceError";
  }
}

function payload(input: Omit<DerivativeExecutionCommand, "platformIntent">): object {
  return { accountId: input.accountId, venue: input.venue, environment: input.environment,
    canonicalInstrumentId: input.canonicalInstrumentId, venueSymbol: input.venueSymbol,
    instrument: input.instrument, positionDirection: input.positionDirection, actionSide: input.actionSide,
    quantityUnit: input.quantityUnit, quantity: input.quantity ?? null, marginMode: input.marginMode,
    leverage: input.leverage ?? null, positionMode: input.positionMode, reduceOnly: input.reduceOnly,
    closePosition: input.closePosition, orderType: input.orderType, timeInForce: input.timeInForce ?? null,
    limitPrice: input.limitPrice ?? null, protective: input.protective ?? null,
    paperReferencePrice: input.paperReferencePrice ?? null, position: input.position ?? null,
    shariah: input.shariah ?? null };
}

export function derivativeExecutionPayloadHash(input: Omit<DerivativeExecutionCommand, "platformIntent">): string {
  return createHash("sha256").update(canonicalJson(payload(input))).digest("hex");
}

function uuidFromHex(hex: string): string {
  const raw = hex.slice(0, 32); return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function derivativeClientOrderId(venue: DerivativeVenue, platformIntentId: string): string {
  const digest = createHash("sha256").update(`x3b:${venue}:${platformIntentId}`).digest("hex");
  if (venue === "hyperliquid") return `0x${digest.slice(0, 32)}`;
  if (venue === "kraken" || venue === "coinbase") return uuidFromHex(digest);
  if (venue === "gateio") return `t-x3b-${digest.slice(0, 18)}`;
  if (venue === "okx") return `x3b${digest.slice(0, 28)}`;
  return `x3b-${digest.slice(0, 28)}`;
}

function intentFrom(command: DerivativeExecutionCommand): DerivativeOrderIntent {
  return { ...command, clientOrderId: derivativeClientOrderId(command.venue, command.platformIntent.id) };
}

function parsedPosition(value: string | null): DerivativeOrderIntent["position"] {
  if (!value) return undefined;
  try { return JSON.parse(value) as DerivativeOrderIntent["position"]; }
  catch { throw new DerivativeExecutionServiceError("persisted position observation is corrupt", 500); }
}

function intentFromRow(row: DerivativeExecutionOrder): DerivativeOrderIntent {
  return { platformIntent: { id: row.platformIntentId, dedupeKey: row.platformDedupeKey,
      createdAt: row.platformIntentCreatedAt.toISOString(), payloadHash: row.platformPayloadHash },
    accountId: row.exchangeAccountId, venue: row.venue as DerivativeVenue,
    environment: row.environment as SafeExecutionEnvironment, canonicalInstrumentId: row.canonicalInstrumentId,
    venueSymbol: row.venueSymbol, instrument: { kind: row.contractKind as ContractKind,
      contractSize: row.contractSize, baseCurrency: row.baseCurrency, quoteCurrency: row.quoteCurrency,
      settlementCurrency: row.settlementCurrency, marginCurrency: row.marginCurrency,
      expiry: row.expiry?.toISOString() }, positionDirection: row.positionDirection as PositionDirection,
    actionSide: row.actionSide as DerivativeSide, quantityUnit: row.quantityUnit as QuantityUnit,
    quantity: row.requestedQuantity ?? undefined, marginMode: row.marginMode as MarginMode,
    leverage: row.leverage ?? undefined, positionMode: row.positionMode as PositionMode,
    reduceOnly: row.reduceOnly, closePosition: row.closePosition, orderType: row.orderType as DerivativeOrderType,
    timeInForce: row.timeInForce as DerivativeTimeInForce | undefined, limitPrice: row.limitPrice ?? undefined,
    protective: row.protectionKind && row.triggerPrice && row.triggerPriceRole ? {
      kind: row.protectionKind as ProtectiveIntent["kind"], triggerPrice: row.triggerPrice,
      triggerPriceRole: row.triggerPriceRole as ProtectiveIntent["triggerPriceRole"],
      paperTriggerModel: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE" } : undefined,
    paperReferencePrice: row.paperReferencePrice ?? undefined, position: parsedPosition(row.positionSnapshot),
    shariah: row.shariahContext ? readShariahContext(JSON.parse(row.shariahContext)) : undefined,
    clientOrderId: row.clientOrderId, providerOrderId: row.providerOrderId ?? undefined };
}

function assertAccount(account: ExchangeAccount | null, command: DerivativeExecutionCommand): asserts account is ExchangeAccount {
  if (!account) throw new DerivativeExecutionServiceError("execution account not found", 404);
  if (!["derivative", "derivatives", "future", "futures", "perpetual"].includes(account.marketType.toLowerCase())
      || account.exchange.toLowerCase() !== command.venue) {
    throw new DerivativeExecutionServiceError("execution account venue/derivatives market does not match the durable intent", 422);
  }
  if (!account.testnet) throw new DerivativeExecutionServiceError(
    "X3B accepts paper/testnet/demo accounts only; production/mainnet execution is unavailable", 403);
  if (command.environment === "paper" && !command.paperReferencePrice) throw new DerivativeExecutionServiceError(
    "paper derivatives execution requires a Platform market reference price", 422);
}

function assertPlatformIdentity(command: DerivativeExecutionCommand): void {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(command.platformIntent.id)
      || !/^[A-Za-z0-9:_-]{16,160}$/.test(command.platformIntent.dedupeKey)) {
    throw new DerivativeExecutionServiceError("durable Platform order-intent identity is required", 401);
  }
  if (command.platformIntent.payloadHash !== derivativeExecutionPayloadHash(command)) {
    throw new DerivativeExecutionServiceError("Platform order-intent payload hash does not match the derivatives request", 409);
  }
  const created = Date.parse(command.platformIntent.createdAt);
  if (!Number.isFinite(created) || created > Date.now() + 60_000) throw new DerivativeExecutionServiceError(
    "Platform order-intent timestamp is invalid", 401);
}

function snapshot(intent: DerivativeOrderIntent, state: DerivativeOrderSnapshot["status"], price: string,
  filledContracts: string): DerivativeOrderSnapshot {
  const sizing = derivativeSizing(intent.instrument, "CONTRACTS", filledContracts, price);
  const reducing = intent.reduceOnly || intent.closePosition;
  const realized = reducing && intent.position ? derivativePnl(intent.instrument.kind, intent.positionDirection,
    filledContracts, intent.instrument.contractSize, intent.position.entryPrice, price) : "0";
  const feeBasis = intent.instrument.kind === "LINEAR" ? sizing.quoteNotional : sizing.baseQuantity;
  const now = new Date().toISOString();
  return { venue: intent.venue, environment: "paper", providerOrderId: `paper-${intent.clientOrderId}`,
    clientOrderId: intent.clientOrderId, status: state, filledContracts, filledBaseQuantity: sizing.baseQuantity,
    filledNotional: sizing.quoteNotional, averageFillPrice: Number(filledContracts) > 0 ? price : null,
    realizedPnl: realized, unrealizedPnl: "0", pnlCurrency: intent.instrument.settlementCurrency,
    funding: { amount: "0", currency: intent.instrument.settlementCurrency }, fee: Number(filledContracts) > 0
      ? { amount: decimalProduct(feeBasis, "0.0005"), currency: intent.instrument.marginCurrency } : null,
    prices: { mark: price, index: price, last: price }, liquidationPrice: intent.position?.liquidationPrice ?? null,
    maintenanceMargin: intent.position?.maintenanceMargin ?? null, providerTimestamp: now,
    acknowledgedAt: now, lastFillAt: Number(filledContracts) > 0 ? now : null,
    rawStatus: `PAPER_${state}` };
}

export class DeterministicDerivativePaperDriver implements DerivativeExecutionDriver {
  async submit(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot> {
    const price = intent.paperReferencePrice!;
    if (intent.protective) return snapshot(intent, "OPEN", price, "0");
    const crossed = intent.orderType === "MARKET"
      || (intent.actionSide === "BUY" && Number(intent.limitPrice) >= Number(price))
      || (intent.actionSide === "SELL" && Number(intent.limitPrice) <= Number(price));
    const quantity = intent.closePosition ? intent.position!.contracts : intent.quantity!;
    const contracts = intent.quantityUnit === "CONTRACTS" ? quantity
      : derivativeSizing(intent.instrument, "BASE", quantity, price).contracts;
    return snapshot(intent, crossed ? "FILLED" : "OPEN", price, crossed ? contracts : "0");
  }
  query(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot | null> { return this.submit(intent); }
  async cancel(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot> {
    return snapshot(intent, "CANCELED", intent.paperReferencePrice!, "0");
  }
}

class DisabledExternalDriver implements DerivativeExecutionDriver {
  private refusal(intent: DerivativeOrderIntent): never { throw new DerivativeExecutionError(
    `${intent.venue} ${intent.environment} derivatives handshake is UNVERIFIED and disabled; no request was sent`, "rejected"); }
  submit(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot> { return Promise.reject(this.refusal(intent)); }
  query(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot | null> { return Promise.reject(this.refusal(intent)); }
  cancel(intent: DerivativeOrderIntent): Promise<DerivativeOrderSnapshot> { return Promise.reject(this.refusal(intent)); }
}

const defaultDriver = (intent: DerivativeOrderIntent): DerivativeExecutionDriver => intent.environment === "paper"
  ? new DeterministicDerivativePaperDriver() : new DisabledExternalDriver();

function sameReservation(row: DerivativeExecutionOrder, command: DerivativeExecutionCommand): boolean {
  return row.platformIntentId === command.platformIntent.id && row.platformDedupeKey === command.platformIntent.dedupeKey
    && row.platformPayloadHash === command.platformIntent.payloadHash
    && row.clientOrderId === derivativeClientOrderId(command.venue, command.platformIntent.id);
}

async function reserve(command: DerivativeExecutionCommand): Promise<{ order: DerivativeExecutionOrder; created: boolean }> {
  const intent = intentFrom(command);
  try {
    return { created: true, order: await prisma.derivativeExecutionOrder.create({ data: {
      platformIntentId: command.platformIntent.id, platformDedupeKey: command.platformIntent.dedupeKey,
      platformPayloadHash: command.platformIntent.payloadHash, platformIntentCreatedAt: new Date(command.platformIntent.createdAt),
      exchangeAccountId: command.accountId, venue: command.venue, environment: command.environment,
      canonicalInstrumentId: command.canonicalInstrumentId, venueSymbol: command.venueSymbol,
      contractKind: command.instrument.kind, contractSize: command.instrument.contractSize,
      baseCurrency: command.instrument.baseCurrency, quoteCurrency: command.instrument.quoteCurrency,
      settlementCurrency: command.instrument.settlementCurrency, marginCurrency: command.instrument.marginCurrency,
      expiry: command.instrument.expiry ? new Date(command.instrument.expiry) : undefined,
      positionDirection: command.positionDirection, actionSide: command.actionSide, quantityUnit: command.quantityUnit,
      requestedQuantity: command.quantity, marginMode: command.marginMode, leverage: command.leverage,
      positionMode: command.positionMode, reduceOnly: command.reduceOnly, closePosition: command.closePosition,
      orderType: command.orderType, timeInForce: command.timeInForce, limitPrice: command.limitPrice,
      triggerPrice: command.protective?.triggerPrice, triggerPriceRole: command.protective?.triggerPriceRole,
      protectionKind: command.protective?.kind, paperReferencePrice: command.paperReferencePrice,
      positionSnapshot: command.position ? canonicalJson(command.position) : undefined,
      shariahContext: serializeShariahContext(command.shariah), clientOrderId: intent.clientOrderId,
    }}) };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.derivativeExecutionOrder.findFirst({ where: { OR: [
      { platformIntentId: command.platformIntent.id }, { platformDedupeKey: command.platformIntent.dedupeKey },
      { clientOrderId: intent.clientOrderId }] } });
    if (!existing || !sameReservation(existing, command)) throw new DerivativeExecutionServiceError(
      "Platform intent, dedupe key, or client order id was replayed with different derivative terms", 409);
    return { order: existing, created: false };
  }
}

const date = (value: string | null): Date | null => value && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const terminal = (status: string): boolean => TERMINAL.has(status);

export async function applyDerivativeSnapshot(orderId: string,
  next: DerivativeOrderSnapshot): Promise<DerivativeExecutionOrder> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.derivativeExecutionOrder.findUnique({ where: { id: orderId } });
    if (!before) throw new DerivativeExecutionServiceError("derivative execution order not found", 404);
    if (next.clientOrderId !== before.clientOrderId || next.venue !== before.venue
        || next.environment !== before.environment) throw new DerivativeExecutionServiceError(
      "provider acknowledgement identity does not match durable derivative intent", 409);
    if (before.providerOrderId && next.providerOrderId && before.providerOrderId !== next.providerOrderId) {
      throw new DerivativeExecutionServiceError("provider order id changed for one durable derivative intent", 409);
    }
    const nextFill = Number(next.filledContracts), beforeFill = Number(before.filledContracts);
    const nextBase = Number(next.filledBaseQuantity), beforeBase = Number(before.filledBaseQty);
    const nextNotional = Number(next.filledNotional), beforeNotional = Number(before.filledNotional);
    if (![nextFill, nextBase, nextNotional].every(Number.isFinite)
        || nextFill < beforeFill || nextBase < beforeBase || nextNotional < beforeNotional) return before;
    const heldIntent = intentFromRow(before);
    if ((heldIntent.reduceOnly || heldIntent.closePosition) && heldIntent.position
        && nextFill > Number(heldIntent.position.contracts)) {
      throw new DerivativeExecutionServiceError(
        "provider fill exceeds the observed reducible position; update was quarantined", 409);
    }
    if (!heldIntent.closePosition && heldIntent.quantityUnit === "CONTRACTS" && heldIntent.quantity
        && nextFill > Number(heldIntent.quantity)) {
      throw new DerivativeExecutionServiceError(
        "provider fill exceeds the authorized contract quantity; update was quarantined", 409);
    }
    const status = next.status.toLowerCase();
    if (before.status === "partially_filled" && status === "open") return before;
    if (terminal(before.status)) {
      const cancelRaceFill = before.status === "canceled" && status === "filled" && nextFill > beforeFill;
      if (!cancelRaceFill) return before;
    }
    return tx.derivativeExecutionOrder.update({ where: { id: orderId }, data: {
      status, providerOrderId: next.providerOrderId || before.providerOrderId, providerStatus: next.rawStatus,
      filledContracts: next.filledContracts, filledBaseQty: next.filledBaseQuantity,
      filledNotional: next.filledNotional, averageFillPrice: next.averageFillPrice,
      realizedPnl: next.realizedPnl, unrealizedPnl: next.unrealizedPnl, pnlCurrency: next.pnlCurrency,
      fundingAmount: next.funding.amount, fundingCurrency: next.funding.currency,
      feeAmount: next.fee?.amount ?? before.feeAmount, feeCurrency: next.fee?.currency ?? before.feeCurrency,
      markPrice: next.prices.mark, indexPrice: next.prices.index, lastPrice: next.prices.last,
      liquidationPrice: next.liquidationPrice, maintenanceMargin: next.maintenanceMargin, error: null,
      acknowledgedAt: date(next.acknowledgedAt) ?? before.acknowledgedAt,
      lastFillAt: date(next.lastFillAt) ?? before.lastFillAt, reconciledAt: new Date(),
      completedAt: terminal(status) ? new Date() : null } });
  });
}

export async function submitDerivativeExecution(command: DerivativeExecutionCommand,
  driverFactory: (intent: DerivativeOrderIntent) => DerivativeExecutionDriver = defaultDriver): Promise<DerivativeExecutionOrder> {
  if (!DERIVATIVE_VENUES.includes(command.venue)) throw new DerivativeCapabilityError(`unsupported derivative venue: ${command.venue}`);
  assertPlatformIdentity(command);
  const account = await prisma.exchangeAccount.findUnique({ where: { id: command.accountId } }); assertAccount(account, command);
  const intent = intentFrom(command); derivativeAdapter(command.venue).validate(intent);
  const shariah = readShariahContext(command.shariah);
  const policySymbol = `${command.instrument.baseCurrency}${command.instrument.quoteCurrency}`;
  const scope = shariahScopeForManualAccount(command.accountId);
  if (!command.reduceOnly && !command.closePosition) {
    await admitSpotEntry({ scope, symbol: policySymbol, context: shariah, auth: { kind: "request-signature" } });
  } else {
    await noteSpotExit(scope, shariah, { symbol: policySymbol, auth: { kind: "request-signature" } });
  }
  const held = await reserve(command); if (!held.created || held.order.status !== "requested") return held.order;
  const claimed = await prisma.derivativeExecutionOrder.updateMany({ where: { id: held.order.id, status: "requested" },
    data: { status: "submitted", submittedAt: new Date(), error: null } });
  if (claimed.count !== 1) return prisma.derivativeExecutionOrder.findUniqueOrThrow({ where: { id: held.order.id } });
  try { return await applyDerivativeSnapshot(held.order.id, await driverFactory(intent).submit(intent)); }
  catch (error) {
    const explicit = error instanceof DerivativeExecutionError && error.kind === "rejected";
    return prisma.derivativeExecutionOrder.update({ where: { id: held.order.id }, data: {
      status: explicit ? "rejected" : "ack_unknown",
      error: error instanceof Error ? error.message : "provider acknowledgement unknown",
      completedAt: explicit ? new Date() : null } });
  }
}

export async function reconcileDerivativeExecutionOrders(
  driverFactory: (intent: DerivativeOrderIntent) => DerivativeExecutionDriver = defaultDriver, limit = 100): Promise<void> {
  const orders = await prisma.derivativeExecutionOrder.findMany({ where: { status: { in: ACTIVE } },
    orderBy: { createdAt: "asc" }, take: Math.min(100, Math.max(1, limit)) });
  for (const order of orders) {
    const intent = intentFromRow(order);
    try {
      const found = await driverFactory(intent).query(intent);
      if (found) await applyDerivativeSnapshot(order.id, found);
      else await prisma.derivativeExecutionOrder.update({ where: { id: order.id }, data: {
        status: "ack_unknown", reconciledAt: new Date(),
        error: "provider lookup found no derivative order; submission remains ambiguous and was not retried" } });
    } catch (error) { await prisma.derivativeExecutionOrder.update({ where: { id: order.id }, data: {
      reconciledAt: new Date(), error: `reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}` } }); }
  }
}

export async function cancelDerivativeExecution(orderId: string,
  driverFactory: (intent: DerivativeOrderIntent) => DerivativeExecutionDriver = defaultDriver): Promise<DerivativeExecutionOrder> {
  const order = await prisma.derivativeExecutionOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new DerivativeExecutionServiceError("derivative execution order not found", 404);
  if (terminal(order.status)) return order;
  try { return await applyDerivativeSnapshot(order.id, await driverFactory(intentFromRow(order)).cancel(intentFromRow(order))); }
  catch (error) { return prisma.derivativeExecutionOrder.update({ where: { id: order.id }, data: {
    error: `cancel outcome unknown; reconciliation pending: ${error instanceof Error ? error.message : "unknown error"}` } }); }
}

/**
 * Advance one deterministic paper protective order from a completed candle.
 * A trigger with no subsequent market observation remains OPEN: process or
 * network loss never fabricates a trigger-price fill.
 */
export async function executeDerivativePaperProtection(orderId: string, candle: CompletedCandle,
  nextMarketPrice?: string): Promise<DerivativeExecutionOrder> {
  const order = await prisma.derivativeExecutionOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new DerivativeExecutionServiceError("derivative execution order not found", 404);
  if (terminal(order.status)) return order;
  const intent = intentFromRow(order);
  if (intent.environment !== "paper" || !intent.protective) throw new DerivativeExecutionServiceError(
    "only a resting deterministic paper protective order can consume a completed candle", 422);
  const decision = evaluateCompletedCandleProtection(intent.protective, intent.positionDirection, candle);
  if (!decision.triggered || !nextMarketPrice) return order;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(nextMarketPrice) || Number(nextMarketPrice) <= 0) {
    throw new DerivativeExecutionServiceError("next paper market observation is invalid", 422);
  }
  const quantity = intent.closePosition ? intent.position!.contracts : intent.quantity!;
  const contracts = intent.quantityUnit === "CONTRACTS" ? quantity
    : derivativeSizing(intent.instrument, "BASE", quantity, nextMarketPrice).contracts;
  return applyDerivativeSnapshot(order.id, snapshot(intent, "FILLED", nextMarketPrice, contracts));
}

export async function readDerivativeExecutionState(): Promise<object> {
  const [accounts, orders] = await Promise.all([
    prisma.exchangeAccount.findMany({ where: { marketType: { in: ["derivative", "derivatives", "future", "futures", "perpetual"] },
      testnet: true }, select: { id: true, name: true, exchange: true, marketType: true, testnet: true },
    orderBy: { createdAt: "asc" } }),
    prisma.derivativeExecutionOrder.findMany({ orderBy: { createdAt: "desc" }, take: 100 }) ]);
  return { mode: "PAPER_TESTNET_ONLY", productionTrading: false, productionActivationAvailable: false,
    warning: "SIMULATED / TESTNET / DEMO ONLY — no production or mainnet derivatives orders can be submitted",
    protectionModel: "COMPLETED_CANDLE_MARKET_AFTER_CLOSE",
    protectionExposure: "Process or network downtime leaves paper positions unprotected; trigger-price parity is not claimed",
    externalHandshakes: "UNVERIFIED_DISABLED", accounts, capabilities: derivativeCapabilities(), orders };
}
