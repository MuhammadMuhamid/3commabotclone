import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { StrategyOrderIntent } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import {
  REALIZATION_BATCH_MAX, REALIZATION_CAPABILITY_V2, REALIZATION_ENVIRONMENTS, canonicalJson, decimalFromNumber,
  normalizeRealizationEvent, type RealizationEnvironment, type RealizationEvent,
} from "../contract/realizationEventContract.js";
import { signManualRequest } from "./manualAuth.js";
import { quantize } from "../lib/money.js";

const INGEST_PATH = "/api/internal/realization-events/v1";

/**
 * OD-5: may an event persisted NOW use contract v2? Only while the operator
 * flag is on AND the Platform's last acknowledged ingest answer advertised
 * `realization.v2`. Decided at persist time because the payload is immutable
 * and hashed on both sides: a row never changes version afterwards.
 */
type CapabilityReader = { findUnique(args: { where: { name: string } }): Promise<unknown> };
type IntentEnvironmentReader = { findMany(args: {
  where: { smartTradeId: string; side: string }; select: { executionEnvironment: true };
}): Promise<Array<{ executionEnvironment: string | null }>> };

export async function realizationV2Active(
  tx: { platformCapability: CapabilityReader } = prisma
): Promise<boolean> {
  if (!config.realizationContractV2Enabled) return false;
  return (await tx.platformCapability.findUnique({ where: { name: REALIZATION_CAPABILITY_V2 } })) !== null;
}

const isEnvironment = (value: unknown): value is RealizationEnvironment =>
  (REALIZATION_ENVIRONMENTS as readonly unknown[]).includes(value);

/**
 * The environment a realization declares: the SELL intent's recorded value,
 * unless anything disagrees — then UNKNOWN (never a guess, never the current
 * global setting):
 *   - a legacy intent with no recorded environment;
 *   - a BUY intent of the same trade recorded under another environment (the
 *     bot's account changed mid-trade);
 *   - a real (non-simulated) fill on an intent recorded as DRY_RUN, or a
 *     `dry-` order id on an intent recorded as TESTNET/MAINNET.
 * Simulated realizations are never emitted at all.
 */
export async function realizationEnvironment(
  tx: { strategyOrderIntent: IntentEnvironmentReader },
  intent: Pick<StrategyOrderIntent, "executionEnvironment" | "smartTradeId">,
  exchangeOrderId: string
): Promise<RealizationEnvironment> {
  const env = intent.executionEnvironment;
  if (!isEnvironment(env) || env === "UNKNOWN") return "UNKNOWN";
  if (env === "DRY_RUN") return "UNKNOWN";
  if (exchangeOrderId.startsWith("dry-")) return "UNKNOWN";
  if (intent.smartTradeId) {
    const buys = await tx.strategyOrderIntent.findMany({
      where: { smartTradeId: intent.smartTradeId, side: "BUY" }, select: { executionEnvironment: true },
    });
    if (buys.some((buy) => buy.executionEnvironment !== env)) return "UNKNOWN";
  }
  return env;
}

export async function persistStrategyRealization(
  tx: {
    realizationEvent: { create(args: { data: {
      id: string; strategyIntentId: string; kind: string; eventTime: Date;
      payload: string; payloadSha256: string;
    } }): Promise<unknown> };
    /** Read inside the same transaction when given (the accounting tx passes itself). */
    platformCapability?: CapabilityReader;
    strategyOrderIntent?: IntentEnvironmentReader;
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
): Promise<RealizationEvent | null> {
  const { intent } = input;
  // A v2 Platform command supplies direct IDs. During a new-Bot/old-Platform
  // rollout the credential fingerprint + durable dedupe key remain an exact,
  // non-secret correlation that the upgraded Platform can resolve later.
  if (input.simulated || !intent.platformWebhookIdentity
      || !intent.platformDedupeKey || !intent.symbol.endsWith("USDT")) return null;
  const v2 = await realizationV2Active(
    tx.platformCapability ? { platformCapability: tx.platformCapability } : prisma);
  const environment = v2
    ? await realizationEnvironment(tx.strategyOrderIntent ? { strategyOrderIntent: tx.strategyOrderIntent } : prisma,
      intent, input.exchangeOrderId)
    : null;
  const event = normalizeRealizationEvent({
    // The event id scheme is unchanged across versions (it is an identity,
    // not a version marker); a given id is persisted once, in one version.
    contractVersion: v2 ? 2 : 1,
    ...(v2 ? { environment } : {}),
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

/**
 * OD-5: remember the capabilities of the Platform's last acknowledged ingest
 * answer. `realization.v2` present -> row upserted; absent -> row removed, so
 * new events go back to v1.
 *
 * An acknowledgement is not the only way the row goes away: a rolled-back
 * (v1-only) Platform never acknowledges a v2 batch, so a definitive refusal
 * of a v2 batch clears it too (`clearCapabilityOnRefusal`, review fix 1).
 */
export async function recordPlatformCapabilities(capabilities: unknown, now = new Date()): Promise<void> {
  const listed = Array.isArray(capabilities)
    && capabilities.some((capability) => capability === REALIZATION_CAPABILITY_V2);
  try {
    if (listed) {
      await prisma.platformCapability.upsert({
        where: { name: REALIZATION_CAPABILITY_V2 },
        create: { name: REALIZATION_CAPABILITY_V2, seenAt: now },
        update: { seenAt: now },
      });
    } else {
      await prisma.platformCapability.deleteMany({ where: { name: REALIZATION_CAPABILITY_V2 } });
    }
  } catch (error) {
    // The batch is already delivered; a lost capability note only delays v2.
    console.error(`[realization] capability note not recorded name=${error instanceof Error ? error.name : "unknown"}`);
  }
}

/**
 * Review fix 1 (OD-5 rollback): a definitive refusal of a v2 batch means the
 * Platform no longer accepts v2 — it was rolled back after advertising it.
 * Forget the capability so every event persisted from now on is v1, which
 * every Platform version accepts. "Definitive" = an HTTP 4xx answer, except
 * 401/403 (channel authentication, which says nothing about the shape) and
 * 429 (not a refusal). Transport failures and 5xx change nothing. A v2-capable
 * Platform that refused for another reason re-advertises the capability on
 * its next acknowledged answer, so the cost is at most a few v1 events.
 */
export function isDefinitiveRefusal(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && ![401, 403, 429].includes(status);
}

async function clearCapabilityOnRefusal(status: number): Promise<void> {
  try {
    await prisma.platformCapability.deleteMany({ where: { name: REALIZATION_CAPABILITY_V2 } });
    console.warn(`[realization] the Platform refused a contract v2 batch (${status}); realization.v2 cleared, ` +
      "new events use v1. Held v2 events are retried under their own backoff.");
  } catch (error) {
    console.error(`[realization] capability not cleared name=${error instanceof Error ? error.name : "unknown"}`);
  }
}

/**
 * The top-level `"contractVersion":2` of a canonical (sorted, compact) v2
 * payload. A string value cannot contain it unescaped, and no nested object
 * has that key, so it selects exactly the v2 rows. It is a scheduling hint
 * only: batching still uses the version parsed from each verified payload.
 */
export const V2_PAYLOAD_MARKER = '"contractVersion":2';

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
  /*
   * Review fix 1: while the Platform is not known to accept v2 (no
   * capability row), v2 rows are HELD ASIDE so they can never seize the
   * outbox: due v1 rows always go first; only when no v1 row is due is the
   * oldest due v2 batch tried — a bounded probe, paced by the rows' own
   * backoff (≤ 1 per hour once backed off). Stored payloads are never
   * rewritten (a Platform may already hold a v2 row's hash). Once an
   * acknowledged answer lists realization.v2 again, the held rows drain in
   * normal order.
   */
  const due = { deliveryStatus: "pending", nextAttemptAt: { lte: now } };
  const page = { orderBy: [{ eventTime: "asc" as const }, { id: "asc" as const }], take: REALIZATION_BATCH_MAX };
  const capable = await prisma.platformCapability.findUnique({ where: { name: REALIZATION_CAPABILITY_V2 } }) !== null;
  let rows = capable
    ? await prisma.realizationEvent.findMany({ where: due, ...page })
    : await prisma.realizationEvent.findMany({ where: { ...due, NOT: { payload: { contains: V2_PAYLOAD_MARKER } } }, ...page });
  if (!capable && rows.length === 0) {
    rows = await prisma.realizationEvent.findMany({ where: { ...due, payload: { contains: V2_PAYLOAD_MARKER } }, ...page });
  }
  if (rows.length === 0) return { attempted: 0, delivered: 0 };
  /*
   * A batch and every event in it share one contract version (OD-5). The
   * oldest pending row decides this batch's version; collection stops at the
   * first row of the other version, which waits for the next cycle — order
   * is preserved and nothing is re-shaped.
   */
  const valid: Array<{ row: typeof rows[number]; event: RealizationEvent }> = [];
  let batchVersion: 1 | 2 | null = null;
  for (const row of rows) {
    let event: RealizationEvent;
    try {
      const digest = createHash("sha256").update(row.payload).digest("hex");
      if (digest !== row.payloadSha256) throw new Error("stored payload hash mismatch");
      event = normalizeRealizationEvent(JSON.parse(row.payload));
      if (canonicalJson(event) !== row.payload) throw new Error("stored payload is not canonical");
    } catch {
      // Corrupted immutable evidence must never be published under its stable
      // event ID. Preserve it for operator recovery and fail closed.
      await prisma.realizationEvent.updateMany({ where: { id: row.id, deliveryStatus: "pending" },
        data: { deliveryStatus: "integrity_error", attempts: { increment: 1 },
          lastError: "immutable realization payload failed integrity verification" } });
      continue;
    }
    batchVersion ??= event.contractVersion;
    if (event.contractVersion !== batchVersion) break;
    valid.push({ row, event });
  }
  if (valid.length === 0) return { attempted: rows.length, delivered: 0 };
  const events = valid.map(({ event }) => event);
  const body = { contractVersion: batchVersion ?? 1, type: "BOT_CUSTOM_REALIZATION_BATCH", events };
  const timestamp = String(now.getTime());
  const nonce = randomBytes(24).toString("base64url");
  const requestId = randomUUID();
  const signature = signManualRequest(config.realizationHmacSecret, {
    method: "POST", path: INGEST_PATH, timestamp, nonce, requestId, body,
  });
  let answerStatus: number | null = null;
  try {
    const response = await fetchImpl(config.realizationPlatformUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realization-timestamp": timestamp,
        "x-realization-nonce": nonce, "x-realization-request-id": requestId,
        "x-realization-signature": signature },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    answerStatus = response.status;
    let accepted: string[] = [];
    let capabilities: unknown;
    if (response.ok) {
      const parsed = await response.json() as {
        status?: unknown; acceptedEventIds?: unknown; capabilities?: unknown;
      };
      if (parsed.status === "accepted" && Array.isArray(parsed.acceptedEventIds)
          && parsed.acceptedEventIds.every((id): id is string => typeof id === "string")) {
        accepted = parsed.acceptedEventIds;
      }
      capabilities = parsed.capabilities;
    }
    const expected = valid.map(({ row }) => row.id).sort();
    if (!response.ok || accepted.slice().sort().join("\n") !== expected.join("\n")) {
      throw new Error(`Platform realization ingestion did not durably acknowledge batch (${response.status})`);
    }
    // Only an ACKNOWLEDGED answer may change what the Bot believes the
    // Platform accepts (OD-5); a failure or a partial answer changes nothing.
    await recordPlatformCapabilities(capabilities, now);
    await prisma.realizationEvent.updateMany({ where: { id: { in: expected }, deliveryStatus: "pending" },
      data: { deliveryStatus: "delivered", deliveredAt: new Date(), attempts: { increment: 1 },
        lastError: null } });
    return { attempted: rows.length, delivered: valid.length };
  } catch (error) {
    if (batchVersion === 2 && isDefinitiveRefusal(answerStatus)) await clearCapabilityOnRefusal(answerStatus!);
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
