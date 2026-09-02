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
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  isShariahNonceShaped, isShariahSignatureShaped, isShariahTimestampShaped,
  shariahBlockCodeFor,
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
 * Latch a per-sender scope from an AUTHENTICATED decision.
 *
 * It records whatever the decision says, including `off` — but only a decision
 * that PROVED it came from the Platform ever reaches here. That is the change
 * v4 makes, and it is where the anti-downgrade guarantee now lives:
 *
 *   * an unproven block is dropped before this point (`authenticatedDecision`),
 *     so the holder of a webhook secret can no longer switch a scope off by
 *     asserting `mode: "off"` in the body of an order;
 *   * and the installation floor, which no order body can write at all, wins
 *     over this row whenever it is stricter.
 *
 * Making this function itself refuse to lower would be redundant against those
 * two, and worse than redundant: it would leave a scope latched to `enforce`
 * after the Platform had authentically said it is not enforcing, so an order
 * admitted under `mode: "off"` would then be refused at submission.
 */
async function recordShariahMode(scope: string, context: ShariahContext): Promise<void> {
  await writeShariahMode(scope, context.mode,
    context.mode === "enforce" ? context.policyVersion ?? null : null);
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
  | {
    kind: "detached";
    side: ContractAction;
    signature?: unknown;
    timestamp?: unknown;
    /** The one-shot authorisation identity, inside the signed bytes since v5. */
    nonce?: unknown;
  };

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
  nonce: unknown;
  now?: number;
}): { ok: true; nonce: string } | { ok: false; reason: string } {
  const secret = config.manualTradingHmacSecret;
  if (!secret) return { ok: false, reason: "this bot holds no Platform signing secret" };
  if (!isShariahSignatureShaped(input.signature)) {
    return { ok: false, reason: "the Shariah decision carries no usable signature" };
  }
  if (!isShariahTimestampShaped(input.timestamp)) {
    return { ok: false, reason: "the Shariah decision carries no usable timestamp" };
  }
  /*
   * Fails CLOSED on a missing or malformed nonce, before the MAC is computed.
   *
   * The nonce is inside the signed bytes, so an absent one would produce a
   * canonical string with an empty line where the authorisation identity
   * belongs — which no Platform signature covers, so this would fail anyway.
   * Checking it explicitly turns "your signature does not verify" into a reason
   * an operator can act on, and makes it impossible to reach the claim below
   * holding something that is not a usable key.
   */
  if (!isShariahNonceShaped(input.nonce)) {
    return {
      ok: false,
      reason: "the Shariah decision carries no usable single-use authorisation identifier",
    };
  }
  const age = (input.now ?? Date.now()) - Number(input.timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > SHARIAH_EVIDENCE_MAX_AGE_MS) {
    return { ok: false, reason: "the Shariah decision signature is outside its freshness window" };
  }
  const canonical = shariahEvidenceCanonical({
    symbol: input.symbol, side: input.side,
    timestamp: input.timestamp, nonce: input.nonce, context: input.context,
  });
  const expected = `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`;
  if (!constantTimeEquals(expected, input.signature)) {
    return { ok: false, reason: "the Shariah decision signature does not verify" };
  }
  return { ok: true, nonce: input.nonce };
}

/**
 * The at-rest identity of one authorisation.
 *
 * Hashed, and deliberately not reversible to the value on the wire: the claim
 * record is a permanent row beside an order intent, while the nonce itself is a
 * live credential for the seconds it remains fresh. Nothing needs the original
 * — the only questions ever asked of it are "is this the same one" and "has it
 * been spent" — so the original is never written down. This is the same reason
 * `WebhookReceipt` stores `keyHash` rather than the key.
 *
 * NOT namespaced by bot or by scope. The signing key is shared across the whole
 * installation, so evidence minted for one bot verifies against another; a
 * per-bot namespace would let one authorisation buy once per bot. One
 * authorisation, one entry, installation-wide.
 */
export function authorizationNonceHash(nonce: string): string {
  return createHash("sha256").update(`shariah:v1:${nonce}`).digest("hex");
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
}): {
  trusted: boolean;
  context: ShariahContext | undefined;
  unverified: string | null;
  /*
   * The verified single-use identity, present only on the detached path and
   * only once the signature has proved it. It is never read off the payload:
   * an unsigned nonce is not an authorisation identity, it is a string an
   * attacker chose, and claiming one would let a replayer burn identities of
   * their choosing.
   */
  nonce: string | null;
} {
  if (!input.context) {
    return { trusted: true, context: undefined, unverified: null, nonce: null };
  }
  if (input.auth.kind === "request-signature") {
    // The manual channel's request HMAC already covers the whole body, so the
    // block is authenticated for free — and that channel carries its own
    // single-use nonce in `ManualNonce`, so there is nothing to claim here.
    return { trusted: true, context: input.context, unverified: null, nonce: null };
  }
  const verified = verifyShariahEvidence({
    symbol: input.symbol, side: input.auth.side, context: input.context,
    signature: input.auth.signature, timestamp: input.auth.timestamp,
    nonce: input.auth.nonce,
  });
  // A signature is what makes the block the Platform's statement rather than
  // the order sender's, so it is checked FIRST — including for `mode: "off"`,
  // which a Platform that is not enforcing legitimately sends.
  if (verified.ok) {
    return { trusted: true, context: input.context, unverified: null, nonce: verified.nonce };
  }
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
    nonce: null,
  };
}

/**
 * Refuse evidence whose authorisation has already been spent BY A DIFFERENT
 * ORDER.
 *
 * "Spent" means: some durable order intent already records this hash. That row
 * is the claim — see `reserveStrategyIntent` — so this question is answered
 * against the same fact the unique index enforces, and it keeps answering the
 * same way across a restart because the row outlives the process.
 *
 * ── Why the intent identity matters here ────────────────────────────────────
 *
 * A replay and a redelivery look identical if you only ask "has this
 * authorisation been used". The sender legitimately re-POSTs the same signed
 * payload when a delivery times out, and it may arrive after the ordinary
 * dedupe receipt has expired — at which point the authorisation IS spent, by
 * the very intent this request is trying to reconcile.
 *
 * `intentKey` is what tells the two apart. It is the durable identity the
 * caller is about to reserve under, derived from the sender's own `dedupe_key`.
 * The same logical signal always derives the same one; a replay under a fresh
 * `dedupe_key` never does — which is precisely why the replayer's freedom to
 * choose that key is what defeated every other control and cannot defeat this
 * one.
 *
 * Matching means recovery: the existing row is returned by
 * `reserveStrategyIntent`, query-first semantics take over, and nothing is
 * claimed twice because there is only ever one claim.
 *
 * The message carries no nonce, no hash and no signature. An operator needs to
 * know THAT a signed decision was presented twice, and for which symbol; the
 * identity of the credential adds nothing they can act on and would put a
 * replay token into the log of the system whose job is to refuse it.
 */
async function assertAuthorizationUnspent(
  hash: string, symbol: string, intentKey: string | null
): Promise<void> {
  const spent = await prisma.strategyOrderIntent.findUnique({
    where: { authorizationNonceHash: hash },
    select: { sourceKey: true },
  });
  if (!spent) return;
  if (intentKey && spent.sourceKey === intentKey) return;
  throw new ShariahEnforcementError(
    "SHARIAH_EVIDENCE_REPLAYED",
    `${normalizeSymbol(symbol)}: this Shariah authorisation has already been used for an ` +
    "entry; a signed decision authorises one entry and cannot be presented again"
  );
}

// ── The two gates ───────────────────────────────────────────────────────────

export interface EntryAdmission {
  clearance: ShariahClearance;
  /** Serialized authenticated decision to persist beside the durable intent. */
  persisted: string | null;
  /**
   * The at-rest identity of the single-use authorisation this admission ran on,
   * for the caller to CLAIM as part of writing the durable intent.
   *
   * Non-null only for a trusted, enforcing, detached-evidence BUY — the exact
   * case where a signed decision is being turned into new exposure. Null
   * everywhere else, and null is not a weaker claim: it means no authorisation
   * was spent because none was needed. See `admitSpotEntry`.
   *
   * Deliberately NOT consumed here. Consuming it at admission time would spend
   * a legitimate sender's authorisation on an order the risk gate then refused,
   * and would leave a window where the nonce is gone but no recoverable intent
   * exists. The claim belongs in the same write as the intent.
   */
  authorizationNonceHash: string | null;
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
  /**
   * The durable intent identity this admission will be reserved under, when the
   * caller has one. It is what separates a redelivery of THIS order from a
   * replay presenting the same authorisation for a different one.
   *
   * Omitting it is safe and strictly stricter: without it, any prior claim on
   * the authorisation reads as a replay. The manual channel omits it because it
   * mints no detached evidence and so has nothing to claim.
   */
  intentKey?: string | null;
}): Promise<EntryAdmission> {
  return withScopeAdmission(input.scope, async () => {
    const { trusted, context, unverified, nonce } = authenticatedDecision(input);
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
      return {
        clearance: clearance(input.symbol, "off", null),
        persisted: null,
        authorizationNonceHash: null,
      };
    }
    await recordShariahMode(input.scope, context);
    const decided = decideEntry(context, input.symbol);
    const claimHash =
      context.mode === "enforce" && nonce ? authorizationNonceHash(nonce) : null;
    /*
     * An early, deliberately NON-AUTHORITATIVE replay check.
     *
     * The authority is the unique index on `StrategyOrderIntent`, which is the
     * only thing that can decide a race. This read cannot: two concurrent
     * replays both see nothing here and both proceed, and that is fine — the
     * constraint refuses the second when they try to claim.
     *
     * It earns its place by rejecting the ORDINARY replay — the sequential one,
     * arriving after the original landed — at the same point every other
     * Shariah refusal happens: before an exchange credential is read, before a
     * balance is fetched, before a client order id exists, and with a reason
     * naming what actually went wrong instead of a constraint violation
     * surfacing from three layers down.
     */
    if (claimHash) {
      await assertAuthorizationUnspent(claimHash, input.symbol, input.intentKey ?? null);
    }
    /*
     * Only an ENFORCING decision that actually authorises this entry spends an
     * authorisation. Two exclusions, both deliberate:
     *
     *   * `mode: "off"` — a signed `off` block still carries a nonce, because
     *     the nonce is inside the bytes the Platform signs and it signs every
     *     delivery the same way. But an `off` decision authorises nothing, so
     *     spending its nonce would make ordinary Mode-OFF traffic single-use
     *     for no benefit. Mode OFF keeps exactly the behaviour it had.
     *   * the manual HMAC channel — `nonce` is null there by construction, and
     *     that channel is already single-use via `ManualNonce`.
     *
     * `decideEntry` has already thrown for REVIEW, EXCLUDED and a base-asset
     * mismatch, so reaching this line means the decision permits the entry.
     */
    return {
      clearance: decided,
      persisted: serializeShariahContext(context),
      authorizationNonceHash: claimHash,
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
/**
 * Clearance for a BUY that has NOT yet reached the wire.
 *
 * ── The distinction this draws, and why it is the important one ─────────────
 *
 * `clearanceForPersistedEntry` re-reads the original decision and deliberately
 * refuses to re-judge it. That is right for reconciling an order that was
 * already SENT: the exposure exists, and a status that moved afterwards must
 * not retroactively invalidate it.
 *
 * It is wrong for an intent that never got there. A BUY admitted while nothing
 * was enforcing carries no decision at all — its stored context is null, which
 * `clearanceForPersistedEntry` reads as "admitted before this feature existed"
 * and clears unconditionally. So an intent left in `requested` by a crash could
 * sit in the reconciliation queue, the operator could then turn Shariah mode
 * ON, and the 30-second reconciler would place that BUY anyway. The exposure
 * would be created AFTER enforcement began, which is exactly what enforcement
 * exists to prevent.
 *
 * So a FIRST submission is measured against the mode in force now. An intent
 * that carries a real `enforce` decision keeps it — that decision is what it
 * was admitted under, and re-judging it is still refused. An intent that
 * carries no decision may only reach the wire while nothing is enforcing.
 *
 * There is no SELL counterpart, and there must not be: an exit that was
 * interrupted must always be able to complete.
 */
export async function clearanceForFirstSubmission(input: {
  scope: string;
  symbol: string;
  persisted: string | null | undefined;
}): Promise<ShariahClearance> {
  const proof = clearanceForPersistedEntry(input.persisted, input.symbol);
  if (proof.mode === "enforce") return proof;
  if (await readShariahMode(input.scope) === "enforce") {
    throw new ShariahEnforcementError(
      "SHARIAH_CONTEXT_REQUIRED",
      `${normalizeSymbol(input.symbol)}: this BUY was admitted before this installation ` +
      "began enforcing Shariah policy and never reached the exchange, so it carries no " +
      "decision and may not create exposure now");
  }
  return proof;
}

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
