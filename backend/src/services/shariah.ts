/**
 * Final Shariah exposure enforcement.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────
 *
 * It is not a screening engine. This bot never researches an asset, never
 * browses, never calls a model, never stores a Shariah registry, and never
 * applies a screening methodology of its own. The Platform owns all of that.
 *
 * ── What this module IS ─────────────────────────────────────────────────────
 *
 * The last gate before Binance. The Platform transmits an authenticated
 * DECISION alongside an execution intent; this module verifies that decision is
 * well formed, binds it to the exact Spot symbol being traded, and refuses to
 * CREATE new exposure unless it says ELIGIBLE.
 *
 * ── The two rules that must never drift ─────────────────────────────────────
 *
 *  1. Only BUY is gated. A SELL — signal exit, TP, SL, partial close, manual
 *     close, recovery of any of them — is never refused here. There is
 *     deliberately no function in this file that a sell path could call.
 *  2. Nothing here creates an order. A status change produces no liquidation,
 *     no polling, and no outbound request. The bot reacts only to authenticated
 *     execution intents that arrive on their own.
 */
import {
  shariahBlockCodeFor, shariahStatusPermitsEntry, validateShariahContext,
  type ShariahContext, type ShariahMode, type ShariahRejectionCode, type ShariahStatus,
} from "../contract/webhookContract.js";
import { prisma } from "../lib/prisma.js";
import { isQuoteAsset, normalizeSymbol } from "../lib/symbols.js";

export class ShariahEnforcementError extends Error {
  /**
   * 409, matching the operator halt and the risk refusal: a policy state
   * refused an otherwise well-formed command. It is not a 4xx about the request
   * being malformed, and it is deliberately not the 401 an auth failure gives,
   * so the three stay distinguishable in logs and to the sender.
   */
  readonly httpStatus = 409;

  constructor(readonly code: ShariahRejectionCode, message: string) {
    super(message);
    this.name = "ShariahEnforcementError";
  }
}

/**
 * Proof that a BUY passed the gate, for the exact symbol it names.
 *
 * The brand is a module-private symbol, so no other file can fabricate one:
 * reaching `marketBuyQuote` at all requires having been through this module.
 * The `symbol` field is what stops an ELIGIBLE proof for one asset authorising
 * a BUY of another — the exchange wrapper re-checks it against the symbol it is
 * about to send.
 */
const CLEARED = Symbol("shariah.clearance");

export interface ShariahClearance {
  readonly [CLEARED]: true;
  /** Normalised Spot symbol this clearance authorises, and only this one. */
  readonly symbol: string;
  readonly mode: ShariahMode;
  readonly effectiveStatus: ShariahStatus | null;
}

function clearance(
  symbol: string, mode: ShariahMode, effectiveStatus: ShariahStatus | null
): ShariahClearance {
  return { [CLEARED]: true, symbol: normalizeSymbol(symbol), mode, effectiveStatus };
}

/**
 * Assert a clearance authorises this exact symbol.
 *
 * Called at the exchange boundary, where `symbol` is the string that is about
 * to reach Binance. Anything that reached here without a clearance for that
 * symbol is a bypass, so it fails closed rather than warning.
 */
export function assertClearedForSymbol(
  proof: ShariahClearance | undefined, symbol: string
): void {
  const sym = normalizeSymbol(symbol);
  if (!proof || proof[CLEARED] !== true) {
    throw new ShariahEnforcementError(
      "SHARIAH_CONTEXT_REQUIRED",
      `${sym}: a BUY reached the exchange boundary without Shariah clearance`);
  }
  if (proof.symbol !== sym) {
    throw new ShariahEnforcementError(
      "SHARIAH_ASSET_MISMATCH",
      `${sym}: Shariah clearance was issued for ${proof.symbol}`);
  }
}

// ── Enforcement scopes ──────────────────────────────────────────────────────

/**
 * Enforcement is remembered per sender scope, never globally: enabling Shariah
 * mode for one bot must not switch it on for a user who never asked for it.
 */
export const shariahScopeForBot = (botId: string): string => `bot:${botId}`;
export const shariahScopeForManualAccount = (accountId: string): string =>
  `manual-account:${accountId}`;

/**
 * The last mode the Platform asserted for a scope.
 *
 * This is the anti-downgrade latch, and it is the reason omission is not a
 * bypass. Once a scope has been told `enforce` under authentication, a later
 * BUY that simply leaves the block out is refused rather than silently falling
 * back to pre-Shariah behaviour. Turning enforcement back off requires an
 * explicit, equally authenticated `mode: "off"`.
 *
 * It stores a mode and a policy identity. It is not a registry: no asset, no
 * status, and no screening input is kept here.
 */
/**
 * Serializes admission per scope.
 *
 * Reading the latch and writing it are two round trips, so without this a BUY
 * that OMITS the block could read "off" in the window between an `enforce`
 * request starting and its latch write landing — and be admitted ungated. That
 * is not a momentary gap: the intent is persisted with a null decision, and a
 * null decision stays ungated through every later recovery. The anti-downgrade
 * guarantee has to hold against concurrent requests, not just sequential ones.
 *
 * In-process, matching how `botBuyLocks` and `accountSubmitLocks` already
 * serialize this bot — it runs as a single Node process. A second process would
 * need the check moved into one serializable transaction.
 */
const admissionChain = new Map<string, Promise<void>>();

function withScopeAdmission<T>(scope: string, run: () => Promise<T>): Promise<T> {
  const previous = admissionChain.get(scope) ?? Promise.resolve();
  const result = previous.then(run);
  // A refused admission must not poison the next request for the same scope, so
  // the chain link never carries the rejection.
  const tail = result.then(() => undefined, () => undefined);
  admissionChain.set(scope, tail);
  void tail.then(() => {
    // Only the current tail clears the entry, so a queued waiter is not dropped
    // and the map cannot grow without bound.
    if (admissionChain.get(scope) === tail) admissionChain.delete(scope);
  });
  return result;
}

export async function readShariahMode(scope: string): Promise<ShariahMode> {
  const row = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  return row?.mode === "enforce" ? "enforce" : "off";
}

async function recordShariahMode(scope: string, context: ShariahContext): Promise<void> {
  const policyVersion = context.policyVersion ?? null;
  const existing = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  if (existing?.mode === context.mode && existing.policyVersion === policyVersion) return;
  await prisma.shariahEnforcement.upsert({
    where: { scope },
    create: { scope, mode: context.mode, policyVersion },
    update: { mode: context.mode, policyVersion },
  });
}

// ── Context handling ────────────────────────────────────────────────────────

/** Parse and strictly validate an inbound block. Absent stays absent. */
export function readShariahContext(raw: unknown): ShariahContext | undefined {
  if (raw === undefined || raw === null) return undefined;
  const checked = validateShariahContext(raw);
  if (!checked.ok) throw new ShariahEnforcementError(checked.code, checked.message);
  return checked.context;
}

/**
 * The exact authenticated decision, stored beside the durable intent.
 *
 * Recovery re-reads this and never substitutes a fresher status: reconciling an
 * existing intent is not a new exposure decision. Only the fields the contract
 * defines are kept — this is evidence of what was asserted, not a cache of
 * anyone's screening state.
 */
export function serializeShariahContext(context: ShariahContext | undefined): string | null {
  return context ? JSON.stringify(context) : null;
}

/**
 * Bind an authenticated decision to the symbol actually being traded.
 *
 * The bot cannot map the Platform's `assetId` to a symbol without duplicating
 * the registry, so the authenticated `baseAsset` is what carries the identity,
 * and this is the check that makes a proof non-transferable: the symbol must be
 * exactly that base asset followed by a quote asset this bot recognises.
 * Deriving the base by stripping a suffix would let `BTCUSDT` satisfy a proof
 * for `BTCUSD`; requiring the remainder to BE a quote asset does not.
 */
function assertBaseAssetBinding(symbol: string, baseAsset: string): void {
  const sym = normalizeSymbol(symbol);
  const remainder = sym.startsWith(baseAsset) ? sym.slice(baseAsset.length) : null;
  if (remainder === null || !isQuoteAsset(remainder)) {
    throw new ShariahEnforcementError(
      "SHARIAH_ASSET_MISMATCH",
      `${sym}: the Shariah decision names base asset ${baseAsset}, which is not the base of this symbol`);
  }
}

/** The fixed V1 entry rule, applied to one already-validated decision. */
function decideEntry(context: ShariahContext, symbol: string): ShariahClearance {
  if (context.mode === "off") return clearance(symbol, "off", null);

  // `validateShariahContext` has already proved these are present under
  // `enforce`; the guards keep the narrowing honest rather than asserting it.
  const status = context.effectiveStatus;
  const baseAsset = context.baseAsset;
  if (!status || !baseAsset) {
    throw new ShariahEnforcementError(
      "SHARIAH_CONTEXT_INVALID", "the Shariah decision is incomplete for enforcement");
  }
  assertBaseAssetBinding(symbol, baseAsset);
  if (!shariahStatusPermitsEntry(status)) {
    throw new ShariahEnforcementError(
      shariahBlockCodeFor(status),
      `${normalizeSymbol(symbol)}: new spot exposure is not permitted while the ` +
      `authenticated Shariah status is ${status}`);
  }
  return clearance(symbol, "enforce", status);
}

// ── The two gates ───────────────────────────────────────────────────────────

export interface EntryAdmission {
  clearance: ShariahClearance;
  /** Serialized authenticated decision to persist beside the durable intent. */
  persisted: string | null;
}

/**
 * Admit — or refuse — a BUY at request time, before anything is claimed.
 *
 * Call this before any irreversible reservation, before a client order id
 * exists, and before any exchange credential is read. It performs no exchange
 * call and can only fail by throwing, so a refusal leaves no partial state.
 */
export function admitSpotEntry(input: {
  scope: string;
  symbol: string;
  context: ShariahContext | undefined;
}): Promise<EntryAdmission> {
  return withScopeAdmission(input.scope, async () => {
    if (!input.context) {
      if (await readShariahMode(input.scope) === "enforce") {
        throw new ShariahEnforcementError(
          "SHARIAH_CONTEXT_REQUIRED",
          `${normalizeSymbol(input.symbol)}: this sender is enforcing Shariah policy, ` +
          "so a BUY must carry an authenticated Shariah decision");
      }
      return { clearance: clearance(input.symbol, "off", null), persisted: null };
    }
    await recordShariahMode(input.scope, input.context);
    return {
      clearance: decideEntry(input.context, input.symbol),
      persisted: serializeShariahContext(input.context),
    };
  });
}

/**
 * Record what a SELL asserted, and admit it unconditionally.
 *
 * An exit is never gated on a Shariah status, so this returns nothing a caller
 * could refuse on and, by construction, cannot fail: a malformed block is
 * recorded as absent rather than left standing between a position and its exit.
 * It exists only so an exit keeps the enforcement latch current and leaves the
 * same audit evidence an entry does.
 */
export async function noteSpotExit(scope: string, raw: unknown): Promise<string | null> {
  try {
    const context = readShariahContext(raw);
    if (!context) return null;
    // Queued behind entry admission for the same scope, so an exit's latch
    // write cannot land in the middle of an entry's read-then-decide.
    await withScopeAdmission(scope, () => recordShariahMode(scope, context));
    return serializeShariahContext(context);
  } catch (error) {
    /*
     * Swallowed on purpose, and only here.
     *
     * Everything this function does is bookkeeping: keeping the latch current
     * and leaving audit evidence. None of it is a safety control for an exit.
     * A malformed block, or a write that fails, must not become the reason a
     * position cannot be closed — so it is logged and the exit proceeds. A
     * failed latch write simply leaves the previous mode in place, which is the
     * stricter of the two outcomes.
     */
    console.error("[shariah] exit context not recorded; the exit proceeds:",
      error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Re-derive clearance for a BUY that is about to be submitted from a durable
 * intent — a first submission, or a retry of one that never reached the wire.
 *
 * It re-reads the ORIGINAL authenticated decision. It deliberately does not
 * consult the latch and does not fetch a fresher status: recovery reconciles an
 * intent that already passed the gate, it does not take a new exposure decision.
 *
 * A null context is a pre-Shariah intent, which keeps its original ungated
 * semantics.
 */
export function clearanceForPersistedEntry(
  persisted: string | null | undefined, symbol: string
): ShariahClearance {
  if (persisted == null) return clearance(symbol, "off", null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(persisted);
  } catch {
    throw new ShariahEnforcementError(
      "SHARIAH_CONTEXT_INVALID",
      `${normalizeSymbol(symbol)}: the stored Shariah decision is unreadable`);
  }
  const checked = validateShariahContext(parsed);
  if (!checked.ok) throw new ShariahEnforcementError(checked.code, checked.message);
  return decideEntry(checked.context, symbol);
}
