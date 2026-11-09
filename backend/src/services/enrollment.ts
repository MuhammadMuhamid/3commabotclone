/**
 * OD-4: exchange-key enrollment and webhook-secret reveal on the Bot origin.
 *
 *   1. The Platform mints a ticket over the signed control channel (C17),
 *      after a fresh step-up. 32 random bytes; only its SHA-256 is stored; it
 *      lives five minutes and is good for one exchange. The Platform hands
 *      the browser `https://<bot>/enroll#t=<ticket>`; the fragment never
 *      reaches a server or a Referer.
 *   2. The page exchanges the ticket for an `enroll_session` cookie
 *      (compare-and-set: issued -> opened). The session token is another 32
 *      random bytes, stored hashed, five minutes.
 *   3. The page posts the keys (create / replace) or asks for the secret
 *      (reveal_webhook). Purpose, network, account, bot and name come from
 *      the stored row only.
 *
 * Nothing here logs a ticket, a token, a key or a secret.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ExchangeEnrollment } from "@prisma/client";
import { config, botPublicOrigin } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { ControlRefusal, type ControlActor } from "./controlCommands.js";
import {
  assertCanStoreSecrets, assertMainnetConfirmed, createExchangeAccount, keyHintOf,
  replaceExchangeAccountKeys,
} from "./exchangeAccounts.js";
import { probeExchangeKeys } from "./enrollmentProbe.js";
import { WEBHOOK_PATH } from "./botAdmin.js";

export const ENROLLMENT_TICKET_TTL_MS = 5 * 60_000;
export const ENROLLMENT_SESSION_TTL_MS = 5 * 60_000;
/** Refused key submissions before the session is failed for good. */
export const ENROLLMENT_MAX_KEY_ATTEMPTS = 3;
export const ENROLL_SESSION_COOKIE = "enroll_session";
export const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

export type EnrollmentPurpose = "create" | "replace" | "reveal_webhook";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function disabled(): ControlRefusal {
  return new ControlRefusal(409, "enrollment_disabled",
    "Key enrollment is not enabled on this Bot (ENROLLMENT_ENABLED is false).");
}

// ── C17: mint ───────────────────────────────────────────────────────────────

export interface MintInput {
  purpose: EnrollmentPurpose;
  accountId?: string;
  botId?: string;
  testnet?: boolean;
  name?: string;
  mainnetConfirmation?: string;
}

export interface MintAnswer {
  enrollmentId: string;
  /** Carries the ticket. Live answer only — never stored, logged or replayed (X2). */
  enrollUrl: string;
  expiresAt: string;
}

export async function mintEnrollment(input: MintInput, actor: ControlActor, now = new Date()): Promise<MintAnswer> {
  if (!config.enrollmentEnabled) throw disabled();
  let testnet: boolean | null = null;
  let name: string | null = null;
  let accountId: string | null = null;
  let botId: string | null = null;

  if (input.purpose === "create") {
    if (typeof input.testnet !== "boolean" || !input.name) {
      throw new ControlRefusal(400, "invalid_request", "create needs testnet and name");
    }
    testnet = input.testnet;
    name = input.name;
    assertMainnetConfirmed(testnet, input.mainnetConfirmation);
  } else if (input.purpose === "replace") {
    const account = input.accountId
      ? await prisma.exchangeAccount.findUnique({ where: { id: input.accountId }, select: { id: true, testnet: true } })
      : null;
    if (!account) throw new ControlRefusal(404, "account_not_found", "That exchange account does not exist.");
    // A replacement keeps the account's network; a different network is a new account.
    if (input.testnet !== undefined && input.testnet !== account.testnet) {
      throw new ControlRefusal(409, "network_mismatch",
        "A key replacement keeps the account's network. Create a new account for the other network.");
    }
    testnet = account.testnet;
    accountId = account.id;
    assertMainnetConfirmed(testnet, input.mainnetConfirmation);
  } else {
    const bot = input.botId
      ? await prisma.signalBot.findUnique({ where: { id: input.botId }, select: { id: true } })
      : null;
    if (!bot) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
    botId = bot.id;
  }

  const origin = botPublicOrigin();
  if (!origin) throw new ControlRefusal(503, "enrollment_misconfigured", "PUBLIC_URL is not a valid origin.");
  const ticket = token();
  const expiresAt = new Date(now.getTime() + ENROLLMENT_TICKET_TTL_MS);
  const row = await prisma.exchangeEnrollment.create({ data: {
    ticketHash: sha256(ticket),
    purpose: input.purpose,
    accountId, botId, testnet, name,
    actorUserId: actor.platformUserId,
    stepUpMethod: actor.stepUp.method,
    expiresAt,
  } });
  return { enrollmentId: row.id, enrollUrl: `${origin}/enroll#t=${ticket}`, expiresAt: expiresAt.toISOString() };
}

/** X2: what C17 stores and replays — never the URL (it carries the ticket). */
export function mintAnswerForStorage(body: unknown): unknown {
  const { enrollmentId, expiresAt } = body as MintAnswer;
  return { enrollmentId, expiresAt };
}

// ── C18: status ─────────────────────────────────────────────────────────────

export type EnrollmentStatus = "issued" | "opened" | "completed" | "expired" | "failed";

export function effectiveStatus(row: ExchangeEnrollment, now = new Date()): EnrollmentStatus {
  if (row.status === "issued" && row.expiresAt <= now) return "expired";
  if (row.status === "opened" && (!row.sessionExpiresAt || row.sessionExpiresAt <= now)) return "expired";
  return row.status as EnrollmentStatus;
}

export async function readEnrollmentStatus(id: string) {
  const row = await prisma.exchangeEnrollment.findUnique({ where: { id } });
  if (!row) return null;
  return {
    status: effectiveStatus(row),
    purpose: row.purpose,
    ...(row.accountId ? { accountId: row.accountId } : {}),
    ...(row.keyHint ? { keyHint: row.keyHint } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
  };
}

// ── The browser session ─────────────────────────────────────────────────────

export interface EnrollmentMeta {
  enrollmentId: string;
  purpose: string;
  testnet: boolean | null;
  name: string | null;
  account: { id: string; name: string; testnet: boolean; keyHint: string | null } | null;
  bot: { id: string; name: string } | null;
  expiresAt: string | null;
  attemptsLeft: number;
}

export async function enrollmentMeta(row: ExchangeEnrollment): Promise<EnrollmentMeta> {
  const [account, bot] = await Promise.all([
    row.purpose === "replace" && row.accountId
      ? prisma.exchangeAccount.findUnique({ where: { id: row.accountId },
        select: { id: true, name: true, testnet: true, keyHint: true } })
      : null,
    row.botId ? prisma.signalBot.findUnique({ where: { id: row.botId }, select: { id: true, name: true } }) : null,
  ]);
  return {
    enrollmentId: row.id,
    purpose: row.purpose,
    testnet: row.testnet,
    name: row.name,
    account: account ? { ...account, keyHint: account.keyHint ?? null } : null,
    bot,
    expiresAt: row.sessionExpiresAt?.toISOString() ?? null,
    attemptsLeft: Math.max(0, ENROLLMENT_MAX_KEY_ATTEMPTS - row.attempts),
  };
}

/**
 * Review fix 3: count one refused key submission, exactly once, with a
 * compare-and-set on the current count (a concurrent sibling cannot make a
 * refusal vanish). Returns true when this refusal failed the enrollment. If a
 * sibling already failed or completed the session, says so.
 */
async function countKeyRefusal(id: string, code: string, now: Date): Promise<boolean> {
  for (let tries = 0; tries < 5; tries += 1) {
    const current = await prisma.exchangeEnrollment.findUnique({ where: { id }, select: { status: true, attempts: true } });
    if (current?.status === "failed") return true;
    if (!current || current.status !== "opened") throw sessionInvalid();
    const attempts = current.attempts + 1;
    const failedNow = attempts >= ENROLLMENT_MAX_KEY_ATTEMPTS;
    const counted = await prisma.exchangeEnrollment.updateMany({
      where: { id, status: "opened", attempts: current.attempts },
      data: { attempts, outcome: `refused:${code}`, ...(failedNow ? { status: "failed", completedAt: now } : {}) },
    });
    if (counted.count === 1) return failedNow;
  }
  throw new ControlRefusal(409, "enrollment_busy",
    "Another submission for this enrollment is being checked. Wait a moment, then try again.");
}

/** A refusal that also ended the enrollment for good (the Platform sees `failed`). */
export class EnrollmentEnded extends ControlRefusal {}

export const ticketInvalid = () => new ControlRefusal(409, "ticket_invalid",
  "This link is no longer valid. Start again from Trading Scene.");
export const sessionInvalid = () => new ControlRefusal(401, "session_invalid",
  "This enrollment session has ended. Start again from Trading Scene.");

/** Exchange a ticket for a session, once (compare-and-set on the ticket's state and clock). */
export async function openEnrollmentSession(ticket: string, now = new Date()) {
  if (!config.enrollmentEnabled) throw disabled();
  if (!TICKET_RE.test(ticket)) throw ticketInvalid();
  const sessionToken = token();
  const sessionExpiresAt = new Date(now.getTime() + ENROLLMENT_SESSION_TTL_MS);
  const ticketHash = sha256(ticket);
  const claimed = await prisma.exchangeEnrollment.updateMany({
    where: { ticketHash, status: "issued", openedAt: null, expiresAt: { gt: now } },
    data: { status: "opened", openedAt: now, sessionHash: sha256(sessionToken), sessionExpiresAt },
  });
  if (claimed.count !== 1) throw ticketInvalid();
  const row = await prisma.exchangeEnrollment.findUniqueOrThrow({ where: { ticketHash } });
  return { sessionToken, sessionExpiresAt, meta: await enrollmentMeta(row) };
}

/** The live session behind a cookie value, or a typed 401. */
export async function resolveEnrollmentSession(sessionToken: unknown, now = new Date()): Promise<ExchangeEnrollment> {
  if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw sessionInvalid();
  const row = await prisma.exchangeEnrollment.findUnique({ where: { sessionHash: sha256(sessionToken) } });
  if (!row || row.status !== "opened" || !row.sessionExpiresAt || row.sessionExpiresAt <= now) {
    throw sessionInvalid();
  }
  return row;
}

export function returnUrlFor(enrollmentId: string, status: "ok" | "failed"): string | null {
  if (!config.platformReturnUrl) return null;
  const url = new URL(config.platformReturnUrl);
  url.search = new URLSearchParams({ enrollment: enrollmentId, status }).toString();
  return url.toString();
}

/** Close a session for good (completed or failed), conditional on it still being live. */
async function closeSession(row: ExchangeEnrollment, data: Record<string, unknown>, now: Date) {
  return prisma.exchangeEnrollment.updateMany({
    where: { id: row.id, status: "opened", sessionHash: row.sessionHash, sessionExpiresAt: { gt: now } },
    data: { ...data, completedAt: now },
  });
}

// ── Keys (create / replace) ─────────────────────────────────────────────────

export interface KeysBody { apiKey: string; apiSecret: string; mainnetConfirmation?: string }

export interface KeysAnswer {
  enrollmentId: string;
  accountId: string;
  name: string;
  testnet: boolean;
  keyHint: string;
  warnings: string[];
  returnUrl: string | null;
}

/**
 * Probe, then store — or refuse with nothing stored. A refusal caused by the
 * keys counts against the session; the third one fails it (the Platform then
 * sees `failed`). A transport failure does not count: nothing was learned.
 */
export async function submitEnrollmentKeys(row: ExchangeEnrollment, body: KeysBody, now = new Date()): Promise<KeysAnswer> {
  if (row.purpose !== "create" && row.purpose !== "replace") {
    throw new ControlRefusal(409, "wrong_purpose", "This enrollment does not accept keys.");
  }
  const testnet = row.testnet === true;
  assertMainnetConfirmed(testnet, body.mainnetConfirmation);
  assertCanStoreSecrets();

  const probe = await probeExchangeKeys({ apiKey: body.apiKey, apiSecret: body.apiSecret }, testnet);
  if (!probe.ok) {
    if (probe.keysAtFault) {
      const failedNow = await countKeyRefusal(row.id, probe.code, now);
      if (failedNow) {
        throw new EnrollmentEnded(probe.status, probe.code,
          `${probe.message} This enrollment has now failed; start again from Trading Scene.`);
      }
      throw new ControlRefusal(probe.status, probe.code, probe.message);
    }
    throw new ControlRefusal(probe.status, probe.code, probe.message);
  }

  const keyHint = keyHintOf(body.apiKey);
  const account = await prisma.$transaction(async (tx) => {
    // Claim the session first: a double submit stores at most one account.
    const closed = await tx.exchangeEnrollment.updateMany({
      where: { id: row.id, status: "opened", sessionHash: row.sessionHash, sessionExpiresAt: { gt: now } },
      data: { status: "completed", completedAt: now, outcome: "ok", keyHint },
    });
    if (closed.count !== 1) throw sessionInvalid();
    const stored = row.purpose === "create"
      ? await createExchangeAccount({ name: row.name ?? "Binance", apiKey: body.apiKey, apiSecret: body.apiSecret, testnet }, tx)
      : await replaceExchangeAccountKeys(row.accountId ?? "", body, testnet, tx);
    await tx.exchangeEnrollment.update({ where: { id: row.id }, data: { accountId: stored.id } });
    return stored;
  });
  console.warn(`[audit] exchange keys ${row.purpose === "create" ? "added" : "replaced"} for account ` +
    `${account.id} via enrollment ${row.id}`);
  return {
    enrollmentId: row.id, accountId: account.id, name: account.name, testnet: account.testnet, keyHint,
    warnings: probe.warnings, returnUrl: returnUrlFor(row.id, "ok"),
  };
}

// ── Reveal ──────────────────────────────────────────────────────────────────

export interface RevealAnswer {
  enrollmentId: string;
  botId: string;
  botName: string;
  webhookUrl: string;
  webhookSecret: string;
  /** The TradingView EXIT alert payload (direct BUYs are disabled). */
  exitWebhookJson: { secret: string; action: "sell"; symbol: string; dedupe_key: string };
  returnUrl: string | null;
}

/** Show a bot's webhook secret exactly once for this enrollment. */
export async function revealWebhookSecret(row: ExchangeEnrollment, now = new Date()): Promise<RevealAnswer> {
  if (row.purpose !== "reveal_webhook" || !row.botId) {
    throw new ControlRefusal(409, "wrong_purpose", "This enrollment does not reveal a secret.");
  }
  const bot = await prisma.signalBot.findUnique({ where: { id: row.botId },
    select: { id: true, name: true, webhookSecret: true } });
  if (!bot) {
    await closeSession(row, { status: "failed", outcome: "bot_not_found" }, now);
    throw new ControlRefusal(404, "bot_not_found", "That bot no longer exists.");
  }
  const closed = await closeSession(row, { status: "completed", outcome: "revealed" }, now);
  if (closed.count !== 1) throw sessionInvalid();
  console.warn(`[audit] webhook secret revealed for bot ${bot.id} via enrollment ${row.id}`);
  return {
    enrollmentId: row.id,
    botId: bot.id,
    botName: bot.name,
    webhookUrl: `${config.publicUrl}${WEBHOOK_PATH}`,
    webhookSecret: bot.webhookSecret,
    exitWebhookJson: { secret: bot.webhookSecret, action: "sell", symbol: "{{ticker}}", dedupe_key: "{{timenow}}" },
    returnUrl: returnUrlFor(row.id, "ok"),
  };
}
