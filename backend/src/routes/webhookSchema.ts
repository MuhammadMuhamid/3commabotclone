/**
 * Request schemas for the signal-bot webhook endpoints.
 *
 * Extracted from the route so the contract tests validate exactly what the
 * running server validates. The platform emits against this shape; there is no
 * shared package between the two repositories yet (root cause of X-01/X-02).
 */
import { z } from "zod";

export const positionStatusSchema = z.object({
  secret: z.string().min(32).max(256),
  symbols: z.array(z.string().min(3).max(40)).min(1).max(100),
}).strict();

/** Account-level read-only status, authenticated by an existing bot secret. */
export const operationalStatusSchema = z.object({
  secret: z.string().min(32).max(256),
}).strict();

export const webhookSchema = z.object({
  secret: z.string().min(32).max(256),
  action: z.string().min(1).max(40),
  symbol: z.string().min(3).max(40).optional(),
  tv_instrument: z.string().min(3).max(40).optional(),
  quote_order_qty: z.number().finite().positive().max(1_000_000).nullable().optional(),
  quantity: z.number().finite().positive().max(1_000_000_000).nullable().optional(),
  /*
   * X-01: this was `.lt(100)` — strictly less than. The sender clamps to 100
   * whenever `rrTp1Size + rrTp2Size >= 100` (a 50/50 take-profit split makes
   * the TP2 leg exactly 100), so an exact-100 leg was a terminal 400: the
   * take-profit never reached the exchange while the platform marked the tier
   * done and the position ran on unmanaged.
   *
   * The bound is now `<= 100`, matching `LIMITS.sellPercentMax` in the shared
   * contract. Senders SHOULD still express a full close by omitting the field.
   */
  sell_percent: z.number().finite().positive().max(100).nullable().optional(),
  exit_leg: z.enum(["tp1", "tp2", "runner", "stop", "signal"]).optional(),
  dedupe_key: z.string().min(1).max(256).optional(),
}).strict()
  .refine((b) => Boolean(b.symbol || b.tv_instrument), {
    message: "symbol or tv_instrument required",
  })
  .refine((b) => !(b.sell_percent != null && b.quantity != null), {
    message: "Use either sell_percent or quantity, not both",
  })
  .refine((b) => b.sell_percent == null || b.action.toLowerCase().includes("sell") || b.action.toLowerCase().includes("exit") || b.action.toLowerCase().includes("close"), {
    message: "sell_percent is valid only for sell/exit actions",
  });
