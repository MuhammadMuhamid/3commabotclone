/**
 * The Platform's signed Slice 2 commands — contract v2.0: bots (C10–C14),
 * exchange accounts (C15, C16, C19) and key enrollment tickets (C17, C18).
 *
 * Mounted at `/control` on `manualTradingRouter` AFTER `requireManualAuth`
 * (and after the C0–C8 router), so every request here carries the HMAC over
 * method, path, timestamp, nonce, request id and body, the ±60 s window and
 * the single-use nonce, and spends from the control limiters (F9). The
 * Caddy rule restricting `/api/manual-trading/*` to the Platform IP covers it.
 *
 * Rules every route keeps (as C0–C8):
 *   - bodies are zod `.strict()` and carry `actor`;
 *   - path ids are validated before any lookup;
 *   - every mutation runs through `runControlCommand` — claimed once per
 *     request id, never re-run, replayed from its stored result;
 *   - X2: a command whose live answer carries a secret (C10/C14 webhook
 *     secret, C17 ticket URL) stores and replays only a non-secret
 *     projection;
 *   - refusals are typed `ControlRefusal`s; anything else is a masked 500;
 *   - no request body is ever logged.
 *
 * The bot and account logic is the Classic dashboard's own, shared through
 * `services/botAdmin.ts` and `services/exchangeAccounts.ts`.
 */
import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { ControlRefusal } from "../services/controlCommands.js";
import {
  botBaseSchema, createBot, deleteBotGuarded, getBotConfigView, rotateWebhookSecret, updateBot,
  type BotConfigView,
} from "../services/botAdmin.js";
import {
  deleteExchangeAccountGuarded, listExchangeAccounts, readAccountBalance,
} from "../services/exchangeAccounts.js";
import {
  mintAnswerForStorage, mintEnrollment, readEnrollmentStatus,
} from "../services/enrollment.js";
import { accountNameSchema } from "../services/exchangeAccounts.js";
import { actorSchema, parseBody, pathId, refuse, runAndSend } from "./manualControl.js";

export const manualControlManageRouter = Router();

/** A typed refusal from a READ (reads do not go through `runControlCommand`). */
function sendReadRefusal(res: Response, error: unknown): boolean {
  if (!(error instanceof ControlRefusal)) return false;
  refuse(res, error.status, error.code, error.message);
  return true;
}

async function viewOrRefuse(id: string): Promise<BotConfigView> {
  const view = await getBotConfigView(id);
  if (!view) throw new ControlRefusal(404, "bot_not_found", "Bot not found.");
  return view;
}

/** X2: the stored and replayed form of an answer carrying `webhookSecret`. */
export function withoutWebhookSecret(body: unknown): unknown {
  const { webhookSecret: _secret, ...rest } = body as Record<string, unknown>;
  return { ...rest, secretIssued: true };
}

// ── C10 POST /bots ──────────────────────────────────────────────────────────

const createSchema = botBaseSchema.extend({ actor: actorSchema }).strict();

manualControlManageRouter.post("/bots", asyncHandler(async (req, res) => {
  const body = parseBody(createSchema, req, res);
  if (!body) return;
  const { actor, ...fields } = body;
  await runAndSend(req, res, {
    kind: "bot_create", target: "bot:new", params: fields, actor,
    persistResult: withoutWebhookSecret,
  }, async () => {
    const bot = await createBot(fields);
    console.warn(`[audit] bot ${bot.id} created by the Platform control channel; webhook secret issued once`);
    return { httpStatus: 201, body: { bot: await viewOrRefuse(bot.id), webhookSecret: bot.webhookSecret } };
  });
}));

// ── C11 GET /bots/:id ───────────────────────────────────────────────────────

manualControlManageRouter.get("/bots/:id", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  try {
    res.json({ bot: await viewOrRefuse(id) });
  } catch (error) {
    if (sendReadRefusal(res, error)) return;
    throw error;
  }
}));

// ── C12 PATCH /bots/:id ─────────────────────────────────────────────────────

const patchSchema = botBaseSchema.partial().extend({ actor: actorSchema }).strict()
  .refine((b) => Object.keys(b).some((k) => k !== "actor" && (b as Record<string, unknown>)[k] !== undefined), {
    message: "provide at least one field to change",
  });

manualControlManageRouter.patch("/bots/:id", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(patchSchema, req, res);
  if (!body) return;
  const { actor, ...fields } = body;
  await runAndSend(req, res, { kind: "bot_update", target: `bot:${id}`, params: fields, actor },
    async () => {
      await updateBot(id, fields);
      return { body: { bot: await viewOrRefuse(id) } };
    });
}));

// ── C13 POST /bots/:id/delete ───────────────────────────────────────────────

const actorOnlySchema = z.object({ actor: actorSchema }).strict();

manualControlManageRouter.post("/bots/:id/delete", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(actorOnlySchema, req, res);
  if (!body) return;
  await runAndSend(req, res, { kind: "bot_delete", target: `bot:${id}`, params: {}, actor: body.actor },
    async () => {
      const outcome = await deleteBotGuarded(id);
      if (!outcome.deleted) throw new ControlRefusal(outcome.status, outcome.code, outcome.error);
      return { body: { deleted: true } };
    });
}));

// ── C14 POST /bots/:id/rotate-secret ────────────────────────────────────────

manualControlManageRouter.post("/bots/:id/rotate-secret", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(actorOnlySchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "bot_rotate_secret", target: `bot:${id}`, params: {}, actor: body.actor,
    persistResult: withoutWebhookSecret,
  }, async () => {
    const bot = await rotateWebhookSecret(id); // X6 guard inside
    console.warn(`[audit] webhook secret rotated for bot ${id} by the Platform control channel`);
    return { body: { bot: await viewOrRefuse(id), webhookSecret: bot.webhookSecret } };
  });
}));

// ── C15 GET /exchange-accounts ──────────────────────────────────────────────

manualControlManageRouter.get("/exchange-accounts", asyncHandler(async (_req, res) => {
  res.json({ accounts: await listExchangeAccounts() });
}));

// ── C16 POST /exchange-accounts/:id/delete ──────────────────────────────────

const accountDeleteSchema = z.object({
  confirmation: z.literal("REMOVE_ACCOUNT"),
  actor: actorSchema,
}).strict();

manualControlManageRouter.post("/exchange-accounts/:id/delete", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const body = parseBody(accountDeleteSchema, req, res);
  if (!body) return;
  await runAndSend(req, res, {
    kind: "account_delete", target: `account:${id}`, params: { confirmation: body.confirmation },
    actor: body.actor,
  }, async () => {
    await deleteExchangeAccountGuarded(id);
    console.warn(`[audit] exchange account ${id} deleted by the Platform control channel`);
    return { body: { deleted: true } };
  });
}));

// ── C19 GET /exchange-accounts/:id/balance ──────────────────────────────────

manualControlManageRouter.get("/exchange-accounts/:id/balance", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  try {
    res.json(await readAccountBalance(id));
  } catch (error) {
    if (sendReadRefusal(res, error)) return;
    throw error;
  }
}));

// ── C17 POST /exchange-enrollments ──────────────────────────────────────────

/**
 * Ticket minting has its own budget on top of the control write limiter:
 * 5 per 10 minutes (trace §4.2). Mutable only so tests can widen it.
 */
export const enrollmentMintLimit = { windowMs: 10 * 60_000, max: 5 };
export const enrollmentMintLimiter = rateLimit({
  windowMs: enrollmentMintLimit.windowMs,
  limit: () => enrollmentMintLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many enrollment links requested; nothing was issued. Retry shortly.",
    code: "bot_rate_limited" },
});

const mintSchema = z.object({
  purpose: z.enum(["create", "replace", "reveal_webhook"]),
  accountId: z.string().uuid().optional(),
  botId: z.string().uuid().optional(),
  testnet: z.boolean().optional(),
  name: accountNameSchema.optional(),
  mainnetConfirmation: z.literal("MAINNET").optional(),
  actor: actorSchema,
}).strict().superRefine((b, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (b.purpose === "create") {
    if (b.testnet === undefined || b.name === undefined) fail("create needs testnet and name");
    if (b.accountId !== undefined || b.botId !== undefined) fail("create takes no accountId or botId");
  } else if (b.purpose === "replace") {
    if (b.accountId === undefined) fail("replace needs accountId");
    if (b.name !== undefined || b.botId !== undefined) fail("replace takes no name or botId");
  } else {
    if (b.botId === undefined) fail("reveal_webhook needs botId");
    if (b.accountId !== undefined || b.name !== undefined || b.testnet !== undefined
        || b.mainnetConfirmation !== undefined) {
      fail("reveal_webhook takes only botId");
    }
  }
});

manualControlManageRouter.post("/exchange-enrollments", enrollmentMintLimiter, asyncHandler(async (req, res) => {
  const body = parseBody(mintSchema, req, res);
  if (!body) return;
  const { actor, ...input } = body;
  // Never cache an answer that can carry a bearer ticket.
  res.setHeader("Cache-Control", "no-store");
  await runAndSend(req, res, {
    kind: "enrollment_create",
    target: input.purpose === "reveal_webhook" ? `bot:${input.botId}`
      : input.purpose === "replace" ? `account:${input.accountId}` : "account:new",
    params: input,
    actor,
    // X2: the ticket lives only in this live answer's enrollUrl.
    persistResult: mintAnswerForStorage,
  }, async () => {
    const answer = await mintEnrollment(input, actor);
    console.warn(`[audit] enrollment ${answer.enrollmentId} (${input.purpose}) issued by the Platform control channel`);
    return { httpStatus: 201, body: answer };
  });
}));

// ── C18 GET /exchange-enrollments/:id ───────────────────────────────────────

manualControlManageRouter.get("/exchange-enrollments/:id", asyncHandler(async (req, res) => {
  const id = pathId(req, res);
  if (!id) return;
  const status = await readEnrollmentStatus(id);
  if (!status) { refuse(res, 404, "enrollment_not_found", "No enrollment with this id."); return; }
  res.json(status);
}));
