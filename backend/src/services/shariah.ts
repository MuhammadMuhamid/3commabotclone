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
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  isShariahSignatureShaped, isShariahTimestampShaped, shariahBlockCodeFor,
  shariahEvidenceCanonical, shariahStatusPermitsEntry, SHARIAH_EVIDENCE_MAX_AGE_MS,
  validateShariahContext,
  type ContractAction, type ShariahContext, type ShariahMode, type ShariahRejectionCode,
  type ShariahStatus,
} from "../contract/webhookContract.js";
import { config } from "../config.js";
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
 * The installation-wide floor, and the reason a webhook BUY cannot outrun the
 * operator.
 *
 * Per-sender scopes alone left a hole. A scope is latched by a request that
 * carries a decision, and the senders that could carry one were never on the
 * webhook scope — so a receiver whose operator had turned Shariah mode ON still
 * admitted every direct webhook BUY ungated, because `bot:<id>` had no row.
 *
 * This scope is written ONLY by the sender's HMAC control channel
 * (`setInstallationShariahMode`), never by an order body. Enforcement is the
 * strictest of it and the per-sender scope, so a floor of `enforce` cannot be
 * shadowed by a scope row, and turning it back off is an authenticated act.
 */
export const SHARIAH_INSTALLATION_SCOPE = "installation";

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

/** The mode stored against one exact scope key, with no floor applied. */
async function storedShariahMode(scope: string): Promise<ShariahMode> {
  const row = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  return row?.mode === "enforce" ? "enforce" : "off";
}

/**
 * The mode that actually governs a sender: the STRICTEST of the installation
 * floor and the sender's own scope.
 *
 * Strictest-wins is what makes the floor unshadowable. A scope row saying `off`
 * cannot lower an installation that says `enforce`, so there is no order in
 * which requests can arrive that reopens the gate.
 */
export async function readShariahMode(scope: string): Promise<ShariahMode> {
  if (scope !== SHARIAH_INSTALLATION_SCOPE &&
      await storedShariahMode(SHARIAH_INSTALLATION_SCOPE) === "enforce") {
    return "enforce";
  }
  return storedShariahMode(scope);
}

async function writeShariahMode(
  scope: string, mode: ShariahMode, policyVersion: string | null
): Promise<void> {
  const existing = await prisma.shariahEnforcement.findUnique({ where: { scope } });
  if (existing?.mode === mode && existing.policyVersion === policyVersion) return;
  await prisma.shariahEnforcement.upsert({
    where: { scope },
    create: { scope, mode, policyVersion },
    update: { mode, policyVersion },
  });
}

/**
 * Latch a per-sender scope from an AUTHENTICATED order body.
 *
 * Monotone on purpose: a request body may raise a scope to `enforce`, never
 * lower it back to `off`. The scope latch is a side effect of an order, and an
 * order is not where policy is decided — lowering is reserved for the control
 * channel, which is the only caller that can prove it speaks for the operator.
 * The module comment has always claimed this property; before v4 the webhook
 * path did not actually have it.
 */
async function recordShariahMode(scope: string, context: ShariahContext): Promise<void> {
  if (context.mode !== "enforce") return;
  await writeShariahMode(scope, "enforce", context.policyVersion ?? null);
}

/**
 * Set the installation floor. The ONLY way enforcement is turned off, and the
 * only writer of `SHARIAH_INSTALLATION_SCOPE`.
 *
 * Callable only from a route behind `requireManualAuth`, whose HMAC covers the
 * whole body — the same authentication that already authorises a real order.
 */
export async function setInstallationShariahMode(
  mode: ShariahMode, policyVersion: string | null
): Promise<ShariahMode> {
  await withScopeAdmission(SHARIAH_INSTALLATION_SCOPE, () =>
    writeShariahMode(SHARIAH_INSTALLATION_SCOPE, mode, mode === "enforce" ? policyVersion : null));
  return mode;
}

/** What the installation floor currently says. Read-only, for the control route. */
export async function readInstallationShariahMode(): Promise<{
  mode: ShariahMode; policyVersion: string | null;
}> {
  const row = await prisma.shariahEnforcement.findUnique({
    where: { scope: SHARIAH_INSTALLATION_SCOPE } });
  return {
    mode: row?.mode === "enforce" ? "enforce" : "off",
    policyVersion: row?.policyVersion ?? null,
  };
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

// ── How a decision is authenticated on the path it arrived by ───────────────

/**
 * What proves a Shariah block on THIS request actually came from the Platform.
 *
 * `request-signature` — the whole body is covered by the manual HMAC
 *   (`requireManualAuth`). The block is authenticated for free, exactly as
 *   `side` and `symbol` are, and needs nothing further.
 *
 * `detached` — the direct-webhook path. Its only authentication is the per-bot
 *   shared secret carried INSIDE the body, which authorises placing an order,
 *   not asserting a screening decision. A block here is trusted only with a
 *   detached sender signature over `shariahEvidenceCanonical`.
 *
 * There is deliberately no third variant meaning "trust it anyway".
 */
export type ShariahEvidenceAuth =
  | { kind: "request-signature" }
  | { kind: "detached"; side: ContractAction; signature?: unknown; timestamp?: unknown };

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verify a detached signature over one decision, bound to this exact symbol,
 * side and time.
 *
 * Keyed by the manual HMAC secret, which the Platform already shares with this
 * bot and a TradingView alert does not have. That asymmetry is the whole
 * mechanism: a signal source can ask for a BUY, but it cannot certify one.
 */
export function verifyShariahEvidence(input: {
  symbol: string;
  side: ContractAction;
  context: ShariahContext;
  signature: unknown;
  timestamp: unknown;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const secret = config.manualTradingHmacSecret;
  if (!secret) return { ok: false, reason: "this bot holds no Platform signing secret" };
  if (!isShariahSignatureShaped(input.signature)) {
    return { ok: false, reason: "the Shariah decision carries no usable signature" };
  }
  if (!isShariahTimestampShaped(input.timestamp)) {
    return { ok: false, reason: "the Shariah decision carries no usable timestamp" };
  }
  const age = (input.now ?? Date.now()) - Number(input.timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > SHARIAH_EVIDENCE_MAX_AGE_MS) {
    return { ok: false, reason: "the Shariah decision signature is outside its freshness window" };
  }
  const canonical = shariahEvidenceCanonical({
    symbol: input.symbol, side: input.side,
    timestamp: input.timestamp, context: input.context,
  });
  const expected = `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
  if (!constantTimeEquals(expected, input.signature)) {
    return { ok: false, reason: "the Shariah decision signature does not verify" };
  }
  return { ok: true };
}

/**
 * Decide whether a block, on the path it arrived by, is entitled to be ACTED ON
 * as the Platform's decision.
 *
 * `trusted: false` does not mean "ignore it". An unproven block may still make
 * things stricter — see `admitSpotEntry`, which honours any refusal it produces
 * and discards only the permission. What it may never do is authorise an entry,
 * latch a scope, or be persisted as the decision a later recovery re-reads.
 */
function authenticatedDecision(input: {
  symbol: string;
  context: ShariahContext | undefined;
  auth: ShariahEvidenceAuth;
}): { trusted: boolean; context: ShariahContext | undefined; unverified: string | null } {
  if (!input.context) return { trusted: true, context: undefined, unverified: null };
  if (input.auth.kind === "request-signature") {
    return { trusted: true, context: input.context, unverified: null };
  }
  const verified = verifyShariahEvidence({
    symbol: input.symbol, side: input.auth.side, context: input.context,
    signature: input.auth.signature, timestamp: input.auth.timestamp,
  });
  // A signature is what makes the block the Platform's statement rather than
  // the order sender's, so it is checked FIRST — including for `mode: "off"`,
  // which a Platform that is not enforcing legitimately sends.
  if (verified.ok) return { trusted: true, context: input.context, unverified: null };
  /*
   * Unverified, so it is not the Platform speaking. What survives is only what
   * is safe in the strict direction:
   *
   *   `off`     — dropped entirely. Honouring it would let the sender of an
   *               order assert that policy does not apply to it.
   *   `enforce` — carried through untrusted, so it can still REFUSE an entry
   *               (see `admitSpotEntry`) but can never authorise one.
   */
  return {
    trusted: false,
    context: input.context.mode === "enforce" ? input.context : undefined,
    unverified: verified.reason,
  };
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
  /** How this path proves the block came from the Platform. Never optional. */
  auth: ShariahEvidenceAuth;
}): Promise<EntryAdmission> {
  return withScopeAdmission(input.scope, async () => {
    const { trusted, context, unverified } = authenticatedDecision(input);
    if (context && !trusted) {
      /*
       * An unproven decision may only ever make things stricter.
       *
       * Running the real rule and keeping ONLY its refusals is what stops the
       * signature requirement from becoming a safety regression: before v4 an
       * unsigned EXCLUDED block did block the BUY, and it still does. What it
       * can no longer do is the opposite — an unsigned ELIGIBLE returns a
       * clearance here, and that clearance is deliberately thrown away.
       */
      decideEntry(context, input.symbol);
    }
    if (!trusted || !context) {
      if (await readShariahMode(input.scope) === "enforce") {
        throw unverified
          ? new ShariahEnforcementError("SHARIAH_EVIDENCE_UNVERIFIED",
            `${normalizeSymbol(input.symbol)}: ${unverified}`)
          : new ShariahEnforcementError("SHARIAH_CONTEXT_REQUIRED",
            `${normalizeSymbol(input.symbol)}: this installation is enforcing Shariah policy, ` +
            "so a BUY must carry an authenticated Shariah decision");
      }
      return { clearance: clearance(input.symbol, "off", null), persisted: null };
    }
    await recordShariahMode(input.scope, context);
    return {
      clearance: decideEntry(context, input.symbol),
      persisted: serializeShariahContext(context),
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
export async function noteSpotExit(scope: string, raw: unknown, opts: {
  /** The symbol the exit names, so a detached signature verifies against it. */
  symbol?: string;
  auth?: ShariahEvidenceAuth;
} = {}): Promise<string | null> {
  try {
    // Authenticated exactly as an entry is: an exit can no more assert an
    // unproven decision than a BUY can. An unverifiable block simply records
    // nothing, which is the stricter outcome and never touches the exit.
    const decision = authenticatedDecision({
      symbol: opts.symbol ?? "",
      context: readShariahContext(raw),
      auth: opts.auth ?? { kind: "request-signature" },
    });
    // Only a proven decision is recorded. An unproven one is not evidence of
    // anything, and must not latch a scope an operator never armed.
    if (!decision.trusted || !decision.context) return null;
    const context = decision.context;
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
