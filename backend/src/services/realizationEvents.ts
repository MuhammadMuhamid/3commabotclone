import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StrategyOrderIntent } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  REALIZATION_BATCH_MAX, canonicalJson, decimalFromNumber,
  normalizeRealizationEvent, type RealizationEventV1,
} from "../contract/realizationEventContract.js";
import { signManualRequest } from "./manualAuth.js";
import { quantize } from "../lib/money.js";

const INGEST_PATH = "/api/internal/realization-events/v1";

export async function persistStrategyRealization(
  tx: {
    realizationEvent: { create(args: { data: {
      id: string; strategyIntentId: string; kind: string; eventTime: Date;
      payload: string; payloadSha256: string;
    } }): Promise<unknown> };
  },
  input: {
    intent: StrategyOrderIntent;
    kind: "partial" | "final";
    sourceId: string;
    realizedAt: Date;
    realizedPnlQuote: number;
    realizedQuantity: number;
    exitPrice: number;
    exitRevenueQuote: number;
    exchangeOrderId: string;
    simulated: boolean;
  }
): Promise<RealizationEventV1 | null> {
  const { intent } = input;
  // A v2 Platform command supplies direct IDs. During a new-Bot/old-Platform
  // rollout the credential fingerprint + durable dedupe key remain an exact,
  // non-secret correlation that the upgraded Platform can resolve later.
  if (input.simulated || !intent.platformWebhookIdentity
      || !intent.platformDedupeKey || !intent.symbol.endsWith("USDT")) return null;
  const event = normalizeRealizationEvent({
    contractVersion: 1,
    type: "BOT_CUSTOM_REALIZATION",
    eventId: `bot-realization-v1:${input.kind}:${input.sourceId}`,
    kind: input.kind,
    realizedAt: input.realizedAt.toISOString(),
    realizedPnlQuote: decimalFromNumber(quantize(input.realizedPnlQuote)),
    realizedQuantity: decimalFromNumber(quantize(input.realizedQuantity)),
    exitPrice: decimalFromNumber(quantize(input.exitPrice)),
    exitRevenueQuote: decimalFromNumber(quantize(input.exitRevenueQuote)),
    quoteCurrency: "USDT",
    symbol: intent.symbol,
    positionDirection: "long",
    exitSide: "sell",
    strategyOrderIntentId: intent.id,
    exchangeOrderId: input.exchangeOrderId,
    platformWebhookIdentity: intent.platformWebhookIdentity,
    platformDeploymentId: intent.platformDeploymentId,
    platformOrderIntentId: intent.platformOrderIntentId,
    platformDedupeKey: intent.platformDedupeKey,
    exitLeg: intent.exitLeg,
    accounting: {
      pnlBasis: "modeled_fee_adjusted",
      feeModel: "fixed_rate_both_sides",
      buyFeeRate: "0.001",
      sellFeeRate: "0.001",
      commissionSource: "modeled_not_exchange_observed",
    },
  });
  const payload = canonicalJson(event);
  await tx.realizationEvent.create({ data: {
    id: event.eventId,
    strategyIntentId: intent.id,
    kind: event.kind,
    eventTime: input.realizedAt,
    payload,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  }});
  return event;
}

const retryDelayMs = (attempts: number): number =>
  Math.min(60 * 60_000, 30_000 * (2 ** Math.min(7, Math.max(0, attempts))));

export interface RealizationDeliveryResult {
  attempted: number;
  delivered: number;
}

/** Deliver one bounded batch; failures only defer the persisted outbox rows. */
export async function deliverPendingRealizations(
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<RealizationDeliveryResult> {
  if (!config.realizationDeliveryEnabled) return { attempted: 0, delivered: 0 };
  const rows = await prisma.realizationEvent.findMany({
    where: { deliveryStatus: "pending", nextAttemptAt: { lte: now } },
    orderBy: [{ eventTime: "asc" }, { id: "asc" }],
    take: REALIZATION_BATCH_MAX,
  });
  if (rows.length === 0) return { attempted: 0, delivered: 0 };
  const valid: Array<{ row: typeof rows[number]; event: RealizationEventV1 }> = [];
  for (const row of rows) {
    try {
      const digest = createHash("sha256").update(row.payload).digest("hex");
      if (digest !== row.payloadSha256) throw new Error("stored payload hash mismatch");
      const event = normalizeRealizationEvent(JSON.parse(row.payload));
      if (canonicalJson(event) !== row.payload) throw new Error("stored payload is not canonical");
      valid.push({ row, event });
    } catch {
      // Corrupted immutable evidence must never be published under its stable
      // event ID. Preserve it for operator recovery and fail closed.
      await prisma.realizationEvent.updateMany({ where: { id: row.id, deliveryStatus: "pending" },
        data: { deliveryStatus: "integrity_error", attempts: { increment: 1 },
          lastError: "immutable realization payload failed integrity verification" } });
    }
  }
  if (valid.length === 0) return { attempted: rows.length, delivered: 0 };
  const events = valid.map(({ event }) => event);
  const body = { contractVersion: 1, type: "BOT_CUSTOM_REALIZATION_BATCH", events };
  const timestamp = String(now.getTime());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = randomUUID();
  const signature = signManualRequest(config.realizationHmacSecret, {
    method: "POST", path: INGEST_PATH, timestamp, nonce, requestId, body,
  });
  try {
    const response = await fetchImpl(config.realizationPlatformUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realization-timestamp": timestamp,
        "x-realization-nonce": nonce, "x-realization-request-id": requestId,
        "x-realization-signature": signature },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    let accepted: string[] = [];
    if (response.ok) {
      const parsed = await response.json() as { status?: unknown; acceptedEventIds?: unknown };
      if (parsed.status === "accepted" && Array.isArray(parsed.acceptedEventIds)
          && parsed.acceptedEventIds.every((id): id is string => typeof id === "string")) {
        accepted = parsed.acceptedEventIds;
      }
    }
    const expected = valid.map(({ row }) => row.id).sort();
    if (!response.ok || accepted.slice().sort().join("\n") !== expected.join("\n")) {
      throw new Error(`Platform realization ingestion did not durably acknowledge batch (${response.status})`);
    }
    await prisma.realizationEvent.updateMany({ where: { id: { in: expected }, deliveryStatus: "pending" },
      data: { deliveryStatus: "delivered", deliveredAt: new Date(), attempts: { increment: 1 },
        lastError: null } });
    return { attempted: rows.length, delivered: valid.length };
  } catch (error) {
    // Keep operational logs to identities/status; never dump accounting bodies.
    for (const { row } of valid) {
      const attempts = row.attempts + 1;
      await prisma.realizationEvent.updateMany({ where: { id: row.id, deliveryStatus: "pending" },
        data: { attempts, nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
          lastError: error instanceof Error ? error.message.slice(0, 300) : "delivery failed" } });
    }
    return { attempted: rows.length, delivered: 0 };
  }
}
