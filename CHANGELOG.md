# Changelog

## 2026-11-09 — Trading Scene control routes, uncertain outcomes, late fills, dashboard truth

### Added: signed control routes for Trading Scene's `/bot`

`/api/manual-trading/control/*` (`routes/manualControl.ts`) lets the Platform
administrator operate this Bot from Trading Scene. The routes cover status,
halt, resume, risk limits, target-state bot start/stop, Close and Partial for
strategy trades, and command status. Key custody, the ledger and the 24/7
TP/SL poll stay here.

- The routes are mounted after `requireManualAuth`, with the same HMAC, ±60 s
  window and single-use nonce as a manual order.
- The prefix is control plane, so it works with manual trading disabled. It has
  its own rate limiters, so polling cannot starve a halt.
- Close and Partial reuse the dashboard's money path (`services/tradeExit.ts`).
  They do not re-implement it.
- `BotControlCommand` (migration `20261109130000_bot_control_command`) claims
  each request id once, replays a finished result, and never runs a command
  twice. It records the order it placed before the wire.
- Bot create/edit/delete and exchange keys are not exposed.

### Fixed: uncertain exchange answers are never rejections (D2)

- `classifyExchangeFailure` is the one classifier on every submit path.
  `-1006`/`-1007`, 5xx and code-less errors stay pending and are reconciled by
  the original client order id. They used to be booked as rejected, and a fresh
  signal then placed a second BUY.
- A definitive not-found 60 s after submission closes an order off as ABSENT. A
  failed lookup never closes one.
- An unresolved BUY blocks a fresh BUY for that bot and pair.
- A reused manual request id must carry the same body (migration
  `20261109120000_manual_command_body_hash`), and a stored command is never
  re-run.

### Fixed: no resurrected or oversold manual positions (D1, policy-neutral)

- A closed trade is never reopened, and snapshots apply as deltas.
- An exit never sells more than the position or the free balance net of other
  tracked positions. The entry is refreshed before an automated exit.
- A late fill becomes a separate `late_fill_unprotected` position, with no
  TP/SL.
- Cancel-first versus track-late-fills is an open owner decision (OD-1), not
  implemented.
- Under `DRY_RUN`, cancelling a manual LIMIT with a real exchange id is refused
  (409 `live_order_in_dry_run`).

### Fixed: dashboard and API truth

- A re-halt keeps the existing halt. It used to overwrite a daily-loss latch,
  and resume then skipped the loss re-check.
- The halt and its controls are shown in `DRY_RUN`. The halt prompt states the
  real policy.
- Close and Partial refuse manual trades (409 `trade_manual`, pointing to
  Trading Scene's Trade panel).
- The empty entry-JSON block is gone, and Reveal shows the secret and the exit
  message.
- Testnet is pre-ticked, the API requires an explicit `testnet`, and mainnet
  needs a typed `MAINNET`.
- A bot with active trades or unresolved intents cannot be deleted.
- `listManualState` now says whether manual TP/SL is really being checked
  (`tradingHalted`, `protection.polling`, `protection.haltedBy`,
  `protection.mainnetPositionsChecked`, `protection.note`).

**Unchanged:** halt semantics (automation stops in both directions, including
both TP/SL pollers; operator SELL/Close/Partial pass), Spot-only execution,
the Shariah floor, and the exit-only TradingView path.

## 2026-09-02 — Shariah exposure enforcement (Trading Scene Shariah V1)

### Added: a final new-exposure gate, and nothing else

The Platform screens assets and decides; this Bot now refuses to **create** new
Spot exposure against an authenticated decision that does not say `ELIGIBLE`.

No screening engine was added. The Bot does no research, no browsing, no model
call, and stores no Shariah registry — `services/shariah.ts` makes no network
call and is never reached from a scheduler.

**Wire contract.** `contract/webhookContract.ts` goes to v3 with an optional
`shariah` block (`mode`, `policyVersion`, `assetId`, `baseAsset`,
`effectiveStatus`, `publicationId`) and a `shariah_blocked` receiver outcome
(HTTP 409, `mayAdvanceLocalState` false). The file is vendored byte-for-byte
into the Platform, so its fingerprint test fails on both sides until both copies
match — which is the point.

**Signature coverage is inherited.** The manual HMAC already hashes a canonical
serialisation of the whole body, so the block is signed by the same signature as
`side` and `symbol`; flipping the status, the mode, or the base asset — or
removing the block — invalidates the request with a 401. No second crypto scheme
was introduced.

**The rule.** Mode `off`, or no block at all, is exactly the previous behaviour.
Under `enforce` a BUY is placed only for `ELIGIBLE`, and is refused for `REVIEW`,
`EXCLUDED`, a policy version this build cannot apply, a malformed context, or a
base asset that is not the base of the symbol traded. Refusals carry their own
codes so they are never confused with an auth failure, a risk refusal, or a
Binance failure.

**SELL is never refused, and nothing is liquidated.** Signal exits, TP, SL,
partial closes, dashboard closes, manual sells and every recovery of those all
proceed whatever the status says. This is structural: `marketSellBase` has no
clearance parameter. The Bot does not poll the Platform, does not watch for
status changes, and creates no order when a classification moves.

**Where it runs.** At request admission — before the per-bot entry checks,
before any credential or balance read, before the deterministic client order ID,
and before the durable reservation. The admitting decision is persisted on the
intent, and recovery re-reads *that* decision rather than a fresher status; the
re-check sits before the `requested → submitted` compare-and-set so a refusal
leaves the intent abandonable rather than stranded. `marketBuyQuote` then
requires a symbol-bound clearance only the enforcement module can produce, so a
proof for one asset cannot authorise a BUY of another.

**Omission is not a downgrade.** `ShariahEnforcement` remembers the last mode a
sender scope authenticated. After an `enforce`, a BUY that leaves the block out
is refused rather than silently reverting to pre-Shariah behaviour; turning it
off again takes an explicit authenticated `mode: "off"`. It stores a mode and a
policy identity only, per scope — never an asset, a status, or any screening
input.

**Unchanged:** Spot-only execution, no futures/leverage/margin/short, HMAC with
timestamp/nonce/replay protection, durable request and client order IDs,
query-first recovery with no blind resubmit, the BUY `dedupe_key` requirement,
the global halt, shared risk limits, automated TP/SL halt handling, and the
existing idempotency and accounting protections.

## 2026-08-24 — Session stability

### Fixed: users logged out every few minutes, backend crashing

**Symptom.** The dashboard signed you out a few minutes into every session.

**Root cause.** A refresh-token rotation race. Rotation is single-use — presenting a
refresh token deletes it and issues a replacement — but `Dashboard.tsx` fires five
parallel requests every 15 seconds. When the 15-minute access token expired, all
five returned 401 simultaneously and each independently tried to rotate the *same*
refresh cookie, because the browser had not yet received the replacement.

The winner rotated the token. The losers called `prisma.refreshToken.delete()` on a
row that no longer existed, throwing **Prisma P2025** as an *unhandled rejection* —
which terminated the Node process. Production had reached `RestartCount=13`.

Each crash therefore did three things: logged the user out, cleared the freshly
issued cookies, and took the 30s TP/SL monitor and 60s manual-close sync offline
until the container restarted. Any position near a trigger was unmonitored in that
window.

**Fixes.**

| Change | File | Effect |
|--------|------|--------|
| Single-flight refresh | `frontend/src/api.ts` | Concurrent 401s share one refresh promise — one rotation per expiry |
| 60s rotation grace window | `backend/src/routes/auth.ts` | A late duplicate is replayed the replacement instead of losing its session |
| `delete` → `deleteMany` | `backend/src/routes/auth.ts` | Returns `count: 0` rather than throwing P2025; stops the crash at its source |
| Dedicated refresh rate limiter | `backend/src/index.ts` | 120/15min, split from the 20/15min credential limiter that was locking out live sessions |
| Proactive 10-min refresh | `frontend/src/context/AuthContext.tsx` | Token never lapses under an active user |
| `unhandledRejection` guard | `backend/src/index.ts` | A stray rejection logs instead of killing a process holding real positions |

**Operational note.** The crash guard means restart count is no longer the signal
that something threw. Audit with:

```bash
docker logs --since 24h tradingbot-backend-1 2>&1 | grep -c 'stayed up'
```

Anything above `0` is a real bug that would previously have caused an outage.

### Deploy tooling

- `finish-on-server.sh`, `remote-deploy.sh`, `BOT_COMPLETE_GUIDE.md` — corrected a
  dead hardcoded IP (`13.239.200.14`) and the wrong key name; now reference the
  DNS hostname so they do not rot when the instance is replaced.
- `cloudshell-launch.sh` — `KEY_NAME` now matches the real keypair. Fixed a latent
  bug where a pre-existing key left a **0-byte `.pem`** behind (the shell created
  the redirect target before the command failed) while the summary told you to
  download it — which would have destroyed the only local copy of the key. AWS
  returns a private key exactly once, so this was unrecoverable.
- All 15 `aws ec2` calls now pass `--region "$REGION"` explicitly instead of
  inheriting CloudShell's ambient region.

### Documentation

- Documented the previously undocumented `authRouter` and `notificationsRouter`,
  plus the `partial-close` and `DELETE` trade endpoints.
- Added the complete environment variable reference — `JWT_SECRET`, `SCRYPT_SALT`,
  `SECURE_COOKIES`, `CORS_ORIGIN`, `VAPID_*` were all missing.
- Added guide section 6.7 covering the token model and the concurrency hazard.
- Corrected `/health`, which returns only `{ status: "ok" }`, not `{ status, dryRun }`.
