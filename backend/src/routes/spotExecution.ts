import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../middleware/errors.js";
import { requireManualAuth } from "../services/manualAuth.js";
import {
  cancelSpotExecution, readSpotExecutionState, SpotExecutionServiceError, submitSpotExecution,
} from "../services/spotExecution/service.js";
import { SpotCapabilityError } from "../services/spotExecution/model.js";

export const spotExecutionRouter = Router();

// Browser sessions and provider credentials are never accepted here. The only
// caller is Platform over the durable nonce/HMAC control channel.
spotExecutionRouter.use(requireManualAuth);

const decimal = z.string().max(80).regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);
const platformIntent = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  dedupeKey: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/),
  createdAt: z.string().datetime(),
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
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
const command = z.object({
  platformIntent,
  shariah: shariah.optional(),
  accountId: z.string().uuid(),
  venue: z.enum(["binance", "coinbase", "bybit", "okx", "kraken", "kucoin", "gateio", "robinhood", "hyperliquid"]),
  environment: z.enum(["paper", "testnet", "demo"]),
  canonicalInstrumentId: z.string().min(8).max(240),
  venueSymbol: z.string().regex(/^[A-Za-z0-9:/_.-]{2,40}$/),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT", "LIMIT_MAKER"]),
  timeInForce: z.enum(["GTC", "IOC", "FOK", "GTD", "POST_ONLY"]).optional(),
  baseQuantity: decimal.optional(), quoteQuantity: decimal.optional(), limitPrice: decimal.optional(),
  paperReferencePrice: decimal.optional(),
}).strict();

spotExecutionRouter.get("/state", asyncHandler(async (_req, res) => {
  res.json({ enabled: config.spotExecutionEnabled, ...await readSpotExecutionState() });
}));

spotExecutionRouter.post("/orders", asyncHandler(async (req, res) => {
  if (!config.spotExecutionEnabled) {
    res.status(404).json({ error: "paper/testnet spot execution is disabled" }); return;
  }
  const parsed = command.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid spot execution command" }); return;
  }
  res.status(202).json(await submitSpotExecution(parsed.data));
}));

spotExecutionRouter.post("/orders/:id/cancel", asyncHandler(async (req, res) => {
  if (!config.spotExecutionEnabled) {
    res.status(404).json({ error: "paper/testnet spot execution is disabled" }); return;
  }
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!z.string().uuid().safeParse(id).success) { res.status(400).json({ error: "invalid order id" }); return; }
  res.json(await cancelSpotExecution(id!));
}));

spotExecutionRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof SpotExecutionServiceError || error instanceof SpotCapabilityError) {
    res.status(error.httpStatus).json({ error: error.message }); return;
  }
  next(error);
});
