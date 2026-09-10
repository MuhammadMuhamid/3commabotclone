import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireManualAuth } from "../services/manualAuth.js";
import { ALPACA_PAPER_CAPABILITIES } from "../services/equityExecution/alpaca.js";
import { EquityCapabilityError } from "../services/equityExecution/model.js";
import { EquityExecutionServiceError, submitEquityPaperOrder } from "../services/equityExecution/service.js";

export const equityExecutionRouter = Router();
equityExecutionRouter.use(requireManualAuth);

const decimal = z.string().max(40).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number(value) > 0);
const platformIntent = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  dedupeKey: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/), createdAt: z.string().datetime(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const command = z.object({ platformIntent, environment: z.literal("paper"),
  canonicalInstrumentId: z.string().regex(/^instrument:v1:(NASDAQ|NYSE|ARCA|AMEX|BATS):(stock|etf):[A-Z][A-Z0-9.-]{0,14}:USD:USD:cash$/),
  providerSymbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/), instrumentType: z.enum(["STOCK", "ETF"]),
  primaryVenue: z.enum(["NASDAQ", "NYSE", "ARCA", "AMEX", "BATS"]), side: z.enum(["BUY", "SELL"]),
  positionEffect: z.enum(["OPEN_LONG", "CLOSE_LONG", "OPEN_SHORT", "COVER_SHORT"]), quantity: decimal,
  orderType: z.enum(["MARKET", "LIMIT"]), timeInForce: z.enum(["DAY", "GTC"]), limitPrice: decimal.optional(),
  extendedHours: z.boolean(), adjustmentMode: z.literal("raw"),
  session: z.object({ phase: z.enum(["PRE", "REGULAR", "AFTER", "CLOSED"]),
    observedAt: z.string().datetime(), calendarDate: z.string().date() }).strict(),
  asset: z.object({ status: z.enum(["ACTIVE", "INACTIVE"]), tradable: z.boolean(), fractionable: z.boolean(),
    shortable: z.boolean().nullable(), borrowStatus: z.enum(["EASY_TO_BORROW", "HARD_TO_BORROW", "UNKNOWN"]),
    observedAt: z.string().datetime() }).strict() }).strict();

equityExecutionRouter.get("/state", (_req, res) => res.json({ enabled: config.equityPaperExecutionEnabled,
  credentialsPresent: Boolean(config.alpacaPaperApiKey && config.alpacaPaperApiSecret),
  capabilities: ALPACA_PAPER_CAPABILITIES }));

equityExecutionRouter.post("/orders", asyncHandler(async (req, res) => {
  if (!config.equityPaperExecutionEnabled) {
    res.status(404).json({ error: "Alpaca paper equities execution is disabled (UNVERIFIED)" }); return;
  }
  const parsed = command.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid equity order" }); return; }
  res.status(202).json(await submitEquityPaperOrder(parsed.data));
}));

equityExecutionRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof EquityCapabilityError || error instanceof EquityExecutionServiceError) {
    res.status(error.httpStatus).json({ error: error.message }); return;
  }
  next(error);
});

