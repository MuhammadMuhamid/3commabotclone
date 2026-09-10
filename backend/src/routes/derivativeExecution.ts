import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireManualAuth } from "../services/manualAuth.js";
import { DerivativeCapabilityError } from "../services/derivativeExecution/model.js";
import { cancelDerivativeExecution, DerivativeExecutionServiceError, readDerivativeExecutionState,
  submitDerivativeExecution } from "../services/derivativeExecution/service.js";
import { ShariahEnforcementError } from "../services/shariah.js";

export const derivativeExecutionRouter = Router();
derivativeExecutionRouter.use(requireManualAuth);

const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);
const platformIntent = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  dedupeKey: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/), createdAt: z.string().datetime(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const instrument = z.object({ kind: z.enum(["LINEAR", "INVERSE"]), contractSize: decimal,
  baseCurrency: z.string().regex(/^[A-Z0-9]{2,16}$/), quoteCurrency: z.string().regex(/^[A-Z0-9]{2,16}$/),
  settlementCurrency: z.string().regex(/^[A-Z0-9]{2,16}$/), marginCurrency: z.string().regex(/^[A-Z0-9]{2,16}$/),
  expiry: z.string().datetime().optional() }).strict();
const position = z.object({ direction: z.enum(["LONG", "SHORT"]), contracts: decimal,
  entryPrice: decimal, markPrice: decimal, observedAt: z.string().datetime(),
  version: z.string().regex(/^[A-Za-z0-9:_-]{8,160}$/), liquidationPrice: decimal.optional(),
  maintenanceMargin: decimal.optional() }).strict();
const protective = z.object({ kind: z.enum(["STOP_LOSS", "TAKE_PROFIT"]), triggerPrice: decimal,
  triggerPriceRole: z.enum(["MARK", "INDEX", "LAST"]),
  paperTriggerModel: z.literal("COMPLETED_CANDLE_MARKET_AFTER_CLOSE") }).strict();
const shariah = z.object({ mode: z.enum(["off", "enforce"]), policyVersion: z.string().nullable().optional(),
  assetId: z.string().nullable().optional(), baseAsset: z.string().nullable().optional(),
  effectiveStatus: z.enum(["ELIGIBLE", "REVIEW", "EXCLUDED"]).nullable().optional(),
  publicationId: z.string().nullable().optional() }).strict();
const command = z.object({ platformIntent, accountId: z.string().uuid(),
  venue: z.enum(["binance", "bybit", "okx", "kucoin", "gateio", "kraken", "hyperliquid", "coinbase"]),
  environment: z.enum(["paper", "testnet", "demo"]), canonicalInstrumentId: z.string().min(8).max(240),
  venueSymbol: z.string().regex(/^[A-Za-z0-9:/_.-]{2,50}$/), instrument,
  positionDirection: z.enum(["LONG", "SHORT"]), actionSide: z.enum(["BUY", "SELL"]),
  quantityUnit: z.enum(["CONTRACTS", "BASE"]), quantity: decimal.optional(),
  marginMode: z.enum(["ISOLATED", "CROSS"]), leverage: decimal.optional(),
  positionMode: z.enum(["ONE_WAY", "HEDGE"]), reduceOnly: z.boolean(), closePosition: z.boolean(),
  orderType: z.enum(["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]),
  timeInForce: z.enum(["GTC", "IOC", "FOK", "GTD", "POST_ONLY"]).optional(),
  limitPrice: decimal.optional(), protective: protective.optional(), paperReferencePrice: decimal.optional(),
  position: position.optional(), shariah: shariah.optional() }).strict();

derivativeExecutionRouter.get("/state", asyncHandler(async (_req, res) => {
  res.json({ enabled: config.derivativeExecutionEnabled, ...await readDerivativeExecutionState() });
}));

derivativeExecutionRouter.post("/orders", asyncHandler(async (req, res) => {
  if (!config.derivativeExecutionEnabled) {
    res.status(404).json({ error: "paper/testnet derivatives execution is disabled" }); return;
  }
  const parsed = command.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid derivatives execution command" }); return;
  }
  res.status(202).json(await submitDerivativeExecution(parsed.data));
}));

derivativeExecutionRouter.post("/orders/:id/cancel", asyncHandler(async (req, res) => {
  if (!config.derivativeExecutionEnabled) {
    res.status(404).json({ error: "paper/testnet derivatives execution is disabled" }); return;
  }
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!z.string().uuid().safeParse(id).success) { res.status(400).json({ error: "invalid order id" }); return; }
  res.json(await cancelDerivativeExecution(id!));
}));

derivativeExecutionRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof DerivativeExecutionServiceError || error instanceof DerivativeCapabilityError
      || error instanceof ShariahEnforcementError) {
    res.status(error.httpStatus).json({ error: error.message }); return;
  }
  next(error);
});
