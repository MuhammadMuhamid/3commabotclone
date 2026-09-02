import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/errors.js";
import { requireManualAuth } from "../services/manualAuth.js";
import {
  cancelManualOrder, listManualState, ManualTradingError,
  runIdempotentManualCommand, submitManualOrder, updateManualProtection,
} from "../services/manualTrading.js";
import { readManualExecutionEvidence } from "../services/executionEvidence.js";
import { readManualAccountState } from "../services/manualAccountState.js";
import { shariahContextSchema } from "./webhookSchema.js";
import {
  readInstallationShariahMode, setInstallationShariahMode, ShariahEnforcementError,
} from "../services/shariah.js";
import { SHARIAH_POLICY_VERSION } from "../contract/webhookContract.js";

export const manualTradingRouter = Router();
manualTradingRouter.use(requireManualAuth);

const positive = z.number().finite().positive();
const optionalPrice = positive.nullable().optional();
const confirmation = z.string().max(64).optional();
export const manualEvidenceLookupSchema = z.object({
  orderId: z.string().uuid().optional(),
  orderRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
}).strict().refine((value) => Number(value.orderId !== undefined) +
  Number(value.orderRequestId !== undefined) === 1, {
  message: "provide exactly one of orderId or orderRequestId",
});

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
  /*
   * Optional, and covered by the request HMAC for free: the manual signature is
   * computed over a canonical hash of the WHOLE body, so this block is
   * authenticated by the same signature as the side and the symbol. Changing
   * any field of it after signing invalidates the request.
   *
   * Interpreted by the service, not here — see `shariahContextSchema` for why a
   * malformed block must not be able to 400 a SELL.
   */
  shariah: shariahContextSchema,
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

/**
 * What this account can actually trade right now: free and locked for the two
 * assets of one symbol, plus the exchange's own size and price rules.
 *
 * Read-only, bounded to one symbol, and it returns no credential, no key, no
 * account identifier beyond the one asked for, and no other asset. It exists so
 * a human can size an order against reality instead of guessing and learning
 * the balance from a rejection — it is advisory context, and it authorises
 * nothing. Every real check still runs on submission.
 */
const accountStateSchema = z.object({
  accountId: z.string().uuid(),
  symbol: z.string().regex(/^[A-Za-z0-9:/_-]{5,30}$/),
}).strict();

manualTradingRouter.get("/account-state", asyncHandler(async (req, res) => {
  const parsed = accountStateSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid account state request" });
    return;
  }
  res.json(await readManualAccountState(parsed.data));
}));

manualTradingRouter.post("/execution-evidence/manual-orders/lookup", asyncHandler(async (req, res) => {
  const parsed = manualEvidenceLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid manual evidence lookup" });
    return;
  }
  const evidence = await readManualExecutionEvidence(parsed.data);
  if (!evidence) { res.status(404).json({ error: "manual order not found" }); return; }
  res.json(evidence);
}));

/**
 * The Shariah enforcement floor for this installation.
 *
 * This is the control channel the per-sender latch never had. Turning the floor
 * on here is what makes a DIRECT webhook BUY fail closed: the webhook path has
 * its own scope, nothing on it could ever arm that scope, and so before this
 * existed an operator could enable Shariah mode on the Platform and still have
 * every TradingView-triggered entry admitted ungated.
 *
 * It lives behind `requireManualAuth` deliberately. The floor is policy, and
 * policy may only be set by a caller that can prove it speaks for the operator
 * — the same HMAC that already authorises a real order. A webhook body cannot
 * reach this route, and cannot lower the floor by any other means.
 *
 * It carries no asset, no symbol and no classification: this receiver holds no
 * registry, and nothing here screens anything.
 */
const enforcementSchema = z.object({
  mode: z.enum(["off", "enforce"]),
  policyVersion: z.string().max(64).nullable().optional(),
}).strict().refine((v) => v.mode === "off" || v.policyVersion === SHARIAH_POLICY_VERSION, {
  message: `policyVersion must be ${SHARIAH_POLICY_VERSION} to enforce`,
});

manualTradingRouter.get("/shariah-enforcement", asyncHandler(async (_req, res) => {
  res.json({ ...(await readInstallationShariahMode()), supportedPolicyVersion: SHARIAH_POLICY_VERSION });
}));

manualTradingRouter.put("/shariah-enforcement", asyncHandler(async (req, res) => {
  const parsed = enforcementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "invalid enforcement request" });
    return;
  }
  const mode = await setInstallationShariahMode(parsed.data.mode, parsed.data.policyVersion ?? null);
  res.json({ mode, policyVersion: mode === "enforce" ? SHARIAH_POLICY_VERSION : null,
    supportedPolicyVersion: SHARIAH_POLICY_VERSION });
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
  if (error instanceof ShariahEnforcementError) {
    // Reported with its own bounded code so an operator can tell this apart
    // from an authentication failure, a risk refusal, or a Binance failure.
    res.status(error.httpStatus).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ManualTradingError) { res.status(error.httpStatus).json({ error: error.message }); return; }
  next(error);
});
