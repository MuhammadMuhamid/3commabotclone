import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireManualAuth } from "../services/manualAuth.js";
import { TRADITIONAL_PAPER_CAPABILITIES } from "../services/traditionalExecution/adapters.js";
import { TraditionalCapabilityError } from "../services/traditionalExecution/model.js";
import { submitTraditionalPaperOrder } from "../services/traditionalExecution/service.js";
import { asyncHandler } from "../middleware/errors.js";

const decimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);
/*
 * `z.unknown().optional()`, matching `webhookSchema.ts`, and for its reason.
 *
 * A strict `z.object` here gives a malformed block the power to reject the
 * whole request with a 400 — and that request might be a reduceOnly close.
 * "A Shariah block must never be able to stand between a position and its
 * exit" is the rule the webhook schema states, and these four routes were
 * validating it at the wrong layer: the parse happens before the service
 * reaches its entry/exit branch, so an unknown key or a lowercase `mode`
 * refused an exit.
 *
 * D-8: nothing on this route interprets the block. Unlike the derivative
 * route, whose service calls `admitSpotEntry` / `noteSpotExit`, the
 * traditional execution service never reads `shariah`: a block is accepted,
 * so it cannot 400 the request, and then ignored. That is tolerable only
 * because this route is practice/paper only (OANDA practice, IBKR paper) and
 * the Shariah decision for these orders is the PLATFORM's gate, applied
 * before it signs the command. Do not read the absence of a refusal here as
 * Bot-side enforcement, and do not take this route live without wiring
 * those helpers into the service.
 * The parent schema stays `.strict()`, so no other unknown field gets in.
 */
const shariah = z.unknown().optional();
const schema = z.object({ platformIntent: z.object({ id: z.string(), dedupeKey: z.string(), createdAt: z.string().datetime(), payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  environment: z.enum(["OANDA_PRACTICE", "IBKR_PAPER"]), canonicalInstrumentId: z.string(),
  providerId: z.enum(["oanda-v20-fx-practice", "ibkr-tws-futures-paper"]), providerSymbol: z.string(),
  instrumentType: z.enum(["FX_PAIR", "FUTURE"]), side: z.enum(["BUY", "SELL"]), positionDirection: z.enum(["LONG", "SHORT"]),
  quantity: decimal, orderType: z.enum(["MARKET", "LIMIT"]), limitPrice: decimal.optional(),
  priceBasis: z.enum(["ASK", "BID", "EXCHANGE_ORDER"]), session: z.object({ open: z.literal(true), observedAt: z.string().datetime(),
    calendarId: z.enum(["OANDA_FX_WEEK", "CME_GLOBEX"]) }).strict(), contract: z.object({ root: z.string(), contractCode: z.string(),
    expiry: z.string().date(), multiplier: z.number().positive(), tickSize: z.number().positive(), tickValue: z.number().positive() }).strict().optional(),
  shariah }).strict();

export const traditionalExecutionRouter = Router(); traditionalExecutionRouter.use(requireManualAuth);
traditionalExecutionRouter.get("/state", (_req, res) => res.json({ enabled: config.traditionalPaperExecutionEnabled,
  oandaCredentialsPresent: Boolean(config.oandaPracticeAccountId && config.oandaPracticeToken),
  ibkrPaperGatewayEnabled: config.ibkrPaperGatewayEnabled, capabilities: TRADITIONAL_PAPER_CAPABILITIES }));
traditionalExecutionRouter.post("/orders", asyncHandler(async (req, res) => {
  if (!config.traditionalPaperExecutionEnabled) { res.status(404).json({ error: "traditional paper/practice execution disabled (UNVERIFIED)" }); return; }
  const parsed = schema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid X5 order" }); return; }
  res.status(202).json(await submitTraditionalPaperOrder(parsed.data) as object);
}));
traditionalExecutionRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof TraditionalCapabilityError) { res.status(error.httpStatus).json({ error: error.message }); return; } next(error);
});

