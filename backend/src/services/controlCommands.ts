/**
 * Idempotency and typed outcomes for the Platform's signed control commands
 * (`/api/manual-trading/control/*`, contract v1.2 §4 and §10 F6/F11).
 *
 * Deliberately NOT `runIdempotentManualCommand`: that helper runs an action
 * again once its row has been `processing` for 30 seconds and never compares
 * request bodies (scout-4 finding 0.11). For a command that can sell, neither
 * is acceptable. Here:
 *
 *   - the row is CLAIMED first — `create` on a unique `requestId`; the loser
 *     of a race gets P2002, reads the row and is answered from it;
 *   - the same request id with a different `{kind, target, params}` hash is
 *     409 `request_id_reused`;
 *   - a `processing` row is 409 `command_in_progress`, whatever its age. The
 *     action is never run a second time; a crash that strands a row leaves it
 *     for the operator to read (C0/C8) and re-issue under a new request id;
 *   - the terminal state is written before the response is sent;
 *   - an order whose outcome is unknown is stored `pending` with the durable
 *     intent or attempt id, and is reported from that record's live state;
 *   - X2: a command whose live answer carries a secret (a new webhook secret,
 *     an enrollment ticket) stores and replays only `persistResult(body)`, a
 *     non-secret projection. The secret exists in exactly one place: the one
 *     live response. A lost response is recovered by a new command, never by
 *     a replay or a C8 read.
 */
import { createHash } from "node:crypto";
import { Prisma, type BotControlCommand } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { canonicalJson } from "./manualAuth.js";

/**
 * A business refusal: the command was understood and deliberately not
 * executed. Only these messages are passed to the Platform verbatim (F11);
 * every other error is a masked 500.
 *
 * `detail` is extra operator context for the Bot's own JWT dashboard (it can
 * embed exchange text), and is never sent over the control channel.
 */
export class ControlRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = "ControlRefusal";
  }
}

/** An exchange order was submitted and its outcome is not yet known (F6 c/d). */
export class ControlPending extends Error {
  constructor(
    readonly ref: { intentId: string } | { attemptId: string },
    message: string
  ) {
    super(message);
    this.name = "ControlPending";
  }
}

export type ControlKind =
  | "halt" | "resume" | "risk_limits" | "bot_status" | "trade_close" | "trade_partial_close"
  // OD-3 C9: pause / resume new entries (target state).
  | "entries"
  // Slice 2 (contract v2.0, C10–C17)
  | "bot_create" | "bot_update" | "bot_delete" | "bot_rotate_secret"
  | "account_delete" | "enrollment_create";

export interface ControlActor {
  platformUserId: string;
  stepUp: { method: "totp" | "password"; at: string };
}

/** sha256 over {kind, target, params}; the actor is excluded on purpose (§4). */
export function controlCommandHash(kind: ControlKind, target: string, params: unknown): string {
  return createHash("sha256").update(canonicalJson({ kind, target, params })).digest("hex");
}

export interface ControlResponse {
  httpStatus: number;
  body: unknown;
  /** True when this answer was replayed from an earlier execution. */
  replayed: boolean;
}

interface Terminal {
  status: "succeeded" | "failed" | "pending";
  httpStatus: number;
  body: unknown;
  error?: string;
  code?: string;
  intentId?: string;
  attemptId?: string;
}

const INTERNAL_FAILURE: Terminal = {
  status: "failed", httpStatus: 500, body: { error: "Internal server error" },
  error: "Internal server error", code: "internal_error",
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function classify(error: unknown, kind: ControlKind, requestId: string): Terminal {
  if (error instanceof ControlRefusal) {
    return {
      status: "failed", httpStatus: error.status,
      body: { error: error.message, code: error.code },
      error: error.message, code: error.code,
    };
  }
  if (error instanceof ControlPending) {
    const body = { status: "pending", ...error.ref, detail: error.message };
    return { status: "pending", httpStatus: 202, body, ...error.ref };
  }
  // Masked, as every 5xx is (`middleware/errors.ts`). X1: only the error's
  // class name is logged — a Prisma error's message embeds the query's
  // arguments, which for a bot create or rotate include the webhook secret.
  console.error(`[control] ${kind} ${requestId} failed name=${errorName(error)}`);
  return INTERNAL_FAILURE;
}

/** The live state of the order a command recorded (pending, or stranded by a crash). */
export async function readLiveOrderState(row: Pick<BotControlCommand, "intentId" | "attemptId">) {
  if (row.intentId) {
    const intent = await prisma.strategyOrderIntent.findUnique({ where: { id: row.intentId } });
    if (!intent) return { kind: "strategy_intent", id: row.intentId, status: "missing", outcome: "unknown" };
    return {
      kind: "strategy_intent",
      id: intent.id,
      status: intent.status,
      exchangeStatus: intent.exchangeStatus,
      filledBaseQty: intent.filledBaseQty,
      filledQuoteQty: intent.filledQuoteQty,
      simulated: intent.simulated,
      outcome: intent.status === "reconciled" ? "executed"
        : intent.status === "rejected" ? "not_executed" : "pending",
      updatedAt: intent.updatedAt,
    };
  }
  if (row.attemptId) {
    const attempt = await prisma.exchangeOrderAttempt.findUnique({ where: { id: row.attemptId } });
    if (!attempt) return { kind: "exit_attempt", id: row.attemptId, status: "missing", outcome: "unknown" };
    return {
      kind: "exit_attempt",
      id: attempt.id,
      status: attempt.status,
      exchangeStatus: attempt.exchangeStatus,
      outcome: attempt.status === "settled" ? "executed"
        : attempt.status === "abandoned" ? "not_executed" : "pending",
      settledAt: attempt.settledAt,
    };
  }
  return null;
}

/**
 * The live order state, whenever the command recorded an order — whatever the
 * row's status. A `processing` row stranded by a crash after its order was
 * reserved is exactly the case this must still be truthful about (R1).
 */
async function liveField(row: BotControlCommand): Promise<{ live?: unknown }> {
  return row.intentId || row.attemptId ? { live: await readLiveOrderState(row) } : {};
}

async function replay(row: BotControlCommand, commandHash: string): Promise<ControlResponse> {
  if (row.commandHash !== commandHash) {
    // A different command: nothing of the original's state is replayed to it.
    return { httpStatus: 409, replayed: true, body: {
      error: "This request id was already used for a different command. Issue a new request id.",
      code: "request_id_reused",
    } };
  }
  if (row.status === "processing") {
    return { httpStatus: 409, replayed: true, body: {
      error: "This command is still being processed. Check its status; it will not be run twice.",
      code: "command_in_progress",
      ...(await liveField(row)),
    } };
  }
  if (row.status === "failed") {
    return { httpStatus: row.httpStatus ?? 500, replayed: true, body: {
      error: row.error ?? "Internal server error", code: row.code ?? "internal_error",
      ...(await liveField(row)),
    } };
  }
  const stored = row.result ? JSON.parse(row.result) as Record<string, unknown> : {};
  return {
    httpStatus: row.status === "pending" ? 202 : row.httpStatus ?? 200,
    replayed: true,
    body: { ...stored, ...(await liveField(row)) },
  };
}

/** What an action may do with its own command row while it runs. */
export interface ControlContext {
  /**
   * Record the durable order this command reserved, BEFORE the order is sent,
   * so a crash before the terminal write still leaves C8 a pointer to the live
   * order (R1). Observation only: it never throws and never changes the flow.
   */
  recordOrderRef(ref: { intentId: string } | { attemptId: string }): Promise<void>;
}

/**
 * Run one control command at most once per request id.
 *
 * `action` returns the success body, or throws `ControlRefusal` /
 * `ControlPending`. Anything else it throws becomes a masked 500, stored as
 * `failed` with code `internal_error`.
 *
 * `persistResult` (X2) maps the live body to what is stored and replayed. It
 * must drop every secret the live body carries. If it throws, nothing is
 * stored (`result` null) — never the unprojected body.
 */
export async function runControlCommand(
  input: {
    requestId: string;
    kind: ControlKind;
    target: string;
    params: unknown;
    actor: ControlActor;
    persistResult?: (body: unknown) => unknown;
  },
  action: (ctx: ControlContext) => Promise<{ httpStatus?: number; body: unknown }>
): Promise<ControlResponse> {
  const commandHash = controlCommandHash(input.kind, input.target, input.params);
  try {
    await prisma.botControlCommand.create({ data: {
      requestId: input.requestId,
      kind: input.kind,
      target: input.target,
      commandHash,
      actorUserId: input.actor.platformUserId,
      stepUpMethod: input.actor.stepUp.method,
      stepUpAt: new Date(input.actor.stepUp.at),
      status: "processing",
    } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.botControlCommand.findUnique({ where: { requestId: input.requestId } });
    if (!existing) throw error;
    return replay(existing, commandHash);
  }

  const ctx: ControlContext = {
    async recordOrderRef(ref) {
      try {
        await prisma.botControlCommand.updateMany({
          where: { requestId: input.requestId, status: "processing" }, data: ref,
        });
      } catch (error) {
        // Losing the pointer only makes C8 less informative; it must never
        // stop or alter the order path it observes.
        console.error(`[control] ${input.kind} ${input.requestId}: order reference not recorded ` +
          `name=${errorName(error)}`);
      }
    },
  };

  let outcome: Terminal = INTERNAL_FAILURE;
  try {
    const value = await action(ctx);
    outcome = { status: "succeeded", httpStatus: value.httpStatus ?? 200, body: value.body };
  } catch (error) {
    outcome = classify(error, input.kind, input.requestId);
  } finally {
    let stored: string | null = null;
    if (outcome.status !== "failed") {
      try {
        stored = JSON.stringify(input.persistResult ? input.persistResult(outcome.body) : outcome.body);
      } catch {
        stored = null; // X2: never fall back to the unprojected (secret-bearing) body
      }
    }
    // F6(b): the terminal row is written before anything is sent. If this
    // write itself fails the row stays `processing`, which is the fail-safe
    // direction: it is never run again.
    await prisma.botControlCommand.update({
      where: { requestId: input.requestId },
      data: {
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        result: stored,
        error: outcome.error ?? null,
        code: outcome.code ?? null,
        // Never erase a reference recorded while the action ran.
        ...(outcome.intentId ? { intentId: outcome.intentId } : {}),
        ...(outcome.attemptId ? { attemptId: outcome.attemptId } : {}),
      },
    });
  }
  return { httpStatus: outcome.httpStatus, body: outcome.body, replayed: false };
}

/**
 * C8: the stored command, with the live order state whenever it recorded an
 * order — including a `processing` row a crash left behind.
 */
export async function readControlCommand(requestId: string) {
  const row = await prisma.botControlCommand.findUnique({ where: { requestId } });
  if (!row) return null;
  return {
    requestId: row.requestId,
    kind: row.kind,
    target: row.target,
    status: row.status,
    httpStatus: row.httpStatus,
    ...(row.result ? { result: JSON.parse(row.result) as unknown } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.code ? { code: row.code } : {}),
    ...(await liveField(row)),
    actorUserId: row.actorUserId,
    stepUpMethod: row.stepUpMethod,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
