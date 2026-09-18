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
 * The signed Shariah decision, declared so a strict schema does not reject it.
 *
 * `derivativeExecution.ts` has always declared this; these three did not, and
 * the Platform attaches the block to every order it sends on any channel. A
 * `.strict()` schema without the field answers 400 to EVERY order — the gate
 * that exists to refuse some orders would have refused all of them, by
 * rejecting its own evidence. The shape mirrors `derivativeExecution.ts`
 * exactly; it is the same wire contract and there must not be two of them.
 */
const shariah = z.object({ mode: z.enum(["off", "enforce"]), policyVersion: z.string().nullable().optional(),
  assetId: z.string().nullable().optional(), baseAsset: z.string().nullable().optional(),
  effectiveStatus: z.enum(["ELIGIBLE", "REVIEW", "EXCLUDED"]).nullable().optional(),
  publicationId: z.string().nullable().optional() }).strict();
const schema = z.object({ platformIntent: z.object({ id: z.string(), dedupeKey: z.string(), createdAt: z.string().datetime(), payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  environment: z.enum(["OANDA_PRACTICE", "IBKR_PAPER"]), canonicalInstrumentId: z.string(),
  providerId: z.enum(["oanda-v20-fx-practice", "ibkr-tws-futures-paper"]), providerSymbol: z.string(),
  instrumentType: z.enum(["FX_PAIR", "FUTURE"]), side: z.enum(["BUY", "SELL"]), positionDirection: z.enum(["LONG", "SHORT"]),
  quantity: decimal, orderType: z.enum(["MARKET", "LIMIT"]), limitPrice: decimal.optional(),
  priceBasis: z.enum(["ASK", "BID", "EXCHANGE_ORDER"]), session: z.object({ open: z.literal(true), observedAt: z.string().datetime(),
    calendarId: z.enum(["OANDA_FX_WEEK", "CME_GLOBEX"]) }).strict(), contract: z.object({ root: z.string(), contractCode: z.string(),
    expiry: z.string().date(), multiplier: z.number().positive(), tickSize: z.number().positive(), tickValue: z.number().positive() }).strict().optional(),
  shariah: shariah.optional() }).strict();

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

