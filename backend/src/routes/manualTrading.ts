import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { requireManualAuth } from "../services/manualAuth.js";
import {
  cancelManualOrder, listManualState, ManualTradingError,
  runIdempotentManualCommand, submitManualOrder, updateManualProtection,
} from "../services/manualTrading.js";

export const manualTradingRouter = Router();
manualTradingRouter.use(requireManualAuth);

const positive = z.number().finite().positive();
const optionalPrice = positive.nullable().optional();
const confirmation = z.string().max(64).optional();

const submitSchema = z.object({
  accountId: z.string().uuid(),
  symbol: z.string().regex(/^[A-Za-z0-9:/_-]{5,30}$/),
  side: z.enum(["BUY", "SELL"]),
  orderType: z.enum(["MARKET", "LIMIT"]),
  quoteQuantity: positive.optional(),
  baseQuantity: positive.optional(),
  limitPrice: positive.optional(),
  takeProfitPrice: optionalPrice,
  stopLossPrice: optionalPrice,
  positionId: z.string().uuid().optional(),
  mainnetConfirmation: confirmation,
}).strict();

function requestId(res: Response): string {
  return String(res.locals.manualRequestId ?? "");
}

function pathId(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? (value[0] ?? "") : value;
}

manualTradingRouter.get("/state", asyncHandler(async (req, res) => {
  const parsed = z.object({ symbol: z.string().optional() }).safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "invalid symbol" }); return; }
  res.json(await listManualState(parsed.data.symbol));
}));

manualTradingRouter.post("/orders", asyncHandler(async (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid manual order" }); return;
  }
  const id = requestId(res);
  const result = await runIdempotentManualCommand(id, "submit_order",
    () => submitManualOrder({ requestId: id, ...parsed.data }));
  res.status(201).json(result);
}));

manualTradingRouter.post("/orders/:id/cancel", asyncHandler(async (req, res) => {
  const parsed = z.object({ mainnetConfirmation: confirmation }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "invalid cancel request" }); return; }
  const result = await runIdempotentManualCommand(requestId(res), "cancel_order",
    () => cancelManualOrder(pathId(req), parsed.data.mainnetConfirmation));
  res.json(result);
}));

manualTradingRouter.patch("/positions/:id/protection", asyncHandler(async (req, res) => {
  const parsed = z.object({ takeProfitPrice: optionalPrice, stopLossPrice: optionalPrice,
    mainnetConfirmation: confirmation }).strict().safeParse(req.body);
  if (!parsed.success || (parsed.data?.takeProfitPrice === undefined && parsed.data?.stopLossPrice === undefined)) {
    res.status(400).json({ error: "provide takeProfitPrice and/or stopLossPrice; null removes a level" }); return;
  }
  const result = await runIdempotentManualCommand(requestId(res), "update_protection",
    () => updateManualProtection({ positionId: pathId(req), ...parsed.data }));
  res.json(result);
}));

manualTradingRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof ManualTradingError) { res.status(error.httpStatus).json({ error: error.message }); return; }
  next(error);
});
