# Signal Bot — Platform-authorized Binance Spot execution

Current documentation starts at [docs/README.md](docs/README.md).

Full-stack execution bot: connect **Binance Spot**, execute authenticated
Platform decisions, manage **multi-pair bots**, and monitor them from a
3commas-inspired dashboard. Since 2026-11-09 the administrator operates it from
Trading Scene's `/bot` page over signed control routes (below). This dashboard
remains the restricted recovery and break-glass path. Direct TradingView
traffic is exit-only.

> **Risk:** Live trading can lose money. Start with `DRY_RUN=true` and tiny position sizes.

## What this repository is, and what it is not

This is the **execution** half of the system.

| | This repository | Platform (`2ms-muzammil/trading-scene-platform`) |
|---|---|---|
| Decides when to trade | no | **yes** |
| Places exchange orders | **yes** | no |
| Holds Binance API keys | yes, AES-256-GCM encrypted at rest | **never** |

It receives canonical buy/sell decisions from the Platform and turns them into
Binance Spot market orders. Every exposure-increasing BUY must carry paired
Platform deployment/order-intent correlation plus signed, single-use durable
authority. Direct TradingView alerts cannot create exposure; they may only send
SELL exits so exposure reduction remains available if Platform delivery is
unavailable.

**Keeping exchange credentials in this process alone is the point of the split.**
Do not move credential handling into the platform, and do not merge the two
repositories.

There is a third repository,
[`2ms-muzammil/trading-scene-research`](https://github.com/2ms-muzammil/trading-scene-research),
which holds the optimizer trees and research. It is offline analysis: it never
sends an instruction here and this repository never reads from it. It is named
only so the name is not mistaken for the platform — it held both until the
repositories were separated on 2026-08-22.

The cross-repository payload contract is documented in the platform repository
at `docs/WEBHOOK-CONTRACT.md`. Change it on both sides, and in that document, in
one commit. Both repositories carry a contract test that mirrors the other side;
this one is `backend/tests/webhookContract.test.ts`.

### Repository status

[`2ms-muzammil/trading-scene-bot`](https://github.com/2ms-muzammil/trading-scene-bot)
is the owner's private canonical bot repository. Mahamid's original bot
repository remains configured as `mahamid-upstream` for collaboration and
handoff.

## Local quality gates

Neither gate needs a network, an exchange, or a database with real data.

```bash
cd backend
npm ci
npx prisma generate
npm run lint        # eslint, zero warnings tolerated
npm run typecheck   # tsc --noEmit
npm test            # node:test against fixtures; DRY_RUN forced true
npm run build
npm run verify      # all of the above, in order

cd ../frontend
npm ci
npm run lint && npm run typecheck && npm test && npm run build
```

`npm test` loads `backend/tests/test.env`, which holds non-secret fixture values
only. The execution-reliability tests migrate and remove their ignored temporary
SQLite database. Never point them at a real database or a real key.

The cross-repository check lives in the Platform repository. Run it from the
Platform's `platform/backend` with this checkout installed (`npm ci` in
`backend`):

```bash
TRADING_SCENE_BOT_ROOT=/path/to/this/checkout \
  node --env-file=tests/test.env --import tsx --test tests/crossRepositoryRealization.test.ts
```

The signing vector for control commands is asserted on both sides:
`backend/tests/botControl.test.ts` here, and the Platform's
`botControlClient.test.ts`. `scripts/release.sh gate --peer-platform-root`
runs the contract diff, below.

## Spot execution reliability boundary

- Authenticated manual Spot commands bind timestamp, nonce, request ID, path,
  method and body under HMAC. Nonces and command results are durable in SQLite,
  so restart does not erase replay/idempotency identity.
- A manual order intent and deterministic Binance client order ID are persisted
  before submission. Startup and the bounded poller query that ID and apply
  cumulative open, partial, filled or canceled exchange snapshots idempotently.
- Once a manual intent is `submitted`, a not-found query does **not** authorize
  another submission: absence cannot distinguish lookup delay from a crash just
  before the wire call. Within 60 s of submission it stays pending.
  `SUBMITTED_ABSENCE_SETTLE_MS` is the same rule the strategy SELL path already
  used. After that window, a definitive "no such order" from the exchange
  closes a never-acknowledged order off as `rejected` (ABSENT): none was
  placed. A failed lookup never closes an order. A never-attempted `requested`
  intent may submit once.
- Every strategy MARKET BUY/SELL has a durable `StrategyOrderIntent` before the
  exchange boundary. `requested` proves no submission has been attempted;
  `submitted` is persisted before the wire call and can only query the
  deterministic client ID. A query miss never authorizes a replacement order.
  The same 60-second absence rule closes off a submitted intent that the
  exchange still does not know.
- **An uncertain exchange answer is never booked as a rejection (D2).**
  - `classifyExchangeFailure` in `backend/src/services/binance.ts` is the one
    classifier on every submit path: manual MARKET/LIMIT, the strategy webhook,
    the dashboard and Platform Close/Partial, and the manual TP/SL SELL.
  - Only a whitelist counts as a definite rejection: `-1002`, `-1003`,
    `-1013`, `-1015`, `-1021`, `-1022`, `-1100`…`-1131`, `-2014`, `-2015`, `-2010`
    (except "Duplicate order sent"), HTTP 429/418 without a code, and a local
    refusal before the wire.
  - Everything else stays pending and is reconciled query-first by the original
    client order id. That includes `-1006`/`-1007`, other 5xx answers and
    code-less transport errors. A lookup that keeps failing raises an alert
    after 3 cycles.
  - An unresolved strategy BUY for a bot and pair blocks a fresh BUY there
    (`risk_blocked`). The risk snapshot counts unresolved BUYs as exposure.
  - A reused manual request id must carry the same body
    (`ManualCommand.bodyHash`), and a stored manual command is never re-run.
- **A closed manual trade is never reopened (D1, policy-neutral part).**
  - Snapshots apply as deltas, so a stale or repeated snapshot changes nothing.
  - An exit never sells more than the position or the free balance net of
    other tracked positions.
  - Before an automated TP/SL exit, the Bot re-reads the entry and sells what
    was actually acquired. A manual SELL is never raised above what the
    operator asked for.
  - An entry still working when its trade closes is flagged on the order.
  - A BUY fill that lands after the trade closed becomes its own position with
    `protectionState: late_fill_unprotected`: no TP/SL, never polled, sellable
    from Trading Scene's Trade panel, with a plain warning. A late SELL fill is
    flagged, not dropped.
  - **OD-1 (cancel first, then sweep).** A full exit (TP, SL, or a manual
    full SELL, including `positionFull`) of a position whose manual LIMIT entry
    is still working first cancels that entry (query first; `-2011` is resolved
    by a lookup), re-reads the fills, and sells the fresh quantity, noted
    `RACE FILL`. A fill that lands after the trade closed becomes a
    `race_fill_sweep` position that the poller sells (at most 3 attempts, then
    `late_fill_unprotected` plus `SWEEP FAILED` and an alert). A reconciler
    finalizer retries a pending cancel (alerts at 3 and 5 attempts). A partial
    SELL never cancels. Cancels always run, under a halt or a pause; an
    automation-origin sweep waits for a halt to clear. There is no
    zero-exposure promise: an unknown cancel leaves a window until a later
    query. Legacy entries flagged `ENTRY STILL WORKING` before this release are
    **not** cancelled at deploy. Binance cancel semantics are not verified
    against a real exchange.
  - A manual full SELL takes the per-trade close lock (409 `trade_closing`).
    A SELL above the position is 409 `sell_exceeds_position`.
- Under `DRY_RUN=true` the Bot refuses to cancel a manual LIMIT whose exchange
  order id is real (409 `live_order_in_dry_run`). It never replaces a real
  exchange id with a `dry-` one, so a still-working order is not marked
  cancelled.
- Startup and a bounded poller reconstruct an authoritative `FILLED` order into
  the normal SmartTrade/partial-close ledger transactionally. BUY recovery
  requires commission trades; repeated recovery links or reuses the same local
  records and accounting markers.
- Webhook receipts are delivery/replay protection, strategy intents are monetary
  submission/recovery truth, and SmartTrade is the lifecycle/accounting ledger.
  Pre-submission failures and authoritative rejections may release a receipt;
  ambiguous/post-submission failures retain it. A released receipt never resets
  an existing intent's attempted state.
- A real dedupe-keyed custom SELL also writes one immutable
  `RealizationEvent` in the same SQLite transaction as its `PartialClose` or
  final SmartTrade accounting update. Partial events carry that slice's P&L;
  final events carry only the remaining final-leg delta, so their sum equals
  SmartTrade cumulative realized P&L. Canonical decimal strings and the
  authoritative timestamp are captured once and replayed from storage.
- Exact provenance is the Bot intent plus exchange order, Platform dedupe key,
  and a one-way webhook-credential identity. New Platform commands additionally
  carry deployment/order-intent IDs in HTTP headers old Bots safely ignore;
  events created behind an old Platform retain the exact key/credential
  correlation for resolution after Platform upgrades.
- The accounting basis is the existing modeled adjustment: 0.1% on buy cost
  and 0.1% on sell revenue. It is not exchange-observed net P&L. A bounded
  50-event HMAC-authenticated outbox batch retries with backoff; Platform
  failure never rolls back Bot accounting.
- The operator halt stops the automation in both directions. Webhook and
  Platform signals (TradingView exit alerts included), strategy intents and
  both TP/SL monitors (strategy and manual) place no BUY and no SELL while
  halted. It never refuses an OPERATOR exit: a manual SELL, and Close and
  Partial from the dashboard or from Trading Scene, stay available. A manual BUY
  is refused with 409. So a halt, including one latched by a daily-loss breach,
  can never trap an open position. A halt request while already halted keeps
  the existing halt, its reason and its source (`alreadyHalted`), so a
  daily-loss latch is never overwritten. The halt is shown and switchable in
  DRY_RUN too, because a halt gates a dry run exactly as it gates a live one.
  The Platform has its own, separate halt. Numeric exposure, concurrency and
  daily-loss limits continue to permit exits according to the existing policy. A never-attempted strategy intent rechecks those gates, while
  an already-attempted intent still reconciles exchange truth during a later
  halt. Dry run never sends an order, and manual live execution is restricted
  to Binance Spot with the existing testnet/mainnet confirmations.
- The OD-3 entries pause (and the halt) does not gate the paper/testnet X3A Spot and X3B derivative routers (`services/spotExecution`, `services/derivativeExecution`); they reach no live venue today.

### Platform's Bot section reads

`GET /api/manual-trading/bot-view/summary`, `/bots` and `/trades` serve the Bot
section on the Platform. They use the same signature as manual orders, read local
rows only and never contact an exchange. Responses are built field by field in
`backend/src/services/botView.ts`, so no webhook secret or exchange key is included.

### Platform control routes (added 2026-11-09)

`backend/src/routes/manualControl.ts` is mounted at
`/api/manual-trading/control` after `requireManualAuth`. That is the same HMAC
over method, path, timestamp, nonce, request id and body as a manual order, with
the ±60 s window and the single-use durable nonce. The `/control/` prefix is
control plane: it works while `MANUAL_TRADING_ENABLED=false`. Trading Scene's
`/bot` page is the only intended caller, and the production proxy answers
`/api/manual-trading/*` only from the Platform's address.

| # | Route | What it does |
|---|---|---|
| C0 | `GET /status` | dry run and halt as independent fields, exchange routing (testnet/mainnet/mixed/none, with account counts), risk limits, snapshot and latch, bot counts, protection (in-process poll, interval, nothing resting on the exchange), Shariah floor, manual and mainnet-manual flags |
| C1 | `POST /halt` | `{confirmation:"HALT_TRADING", reason, actor}`. Never overwrites an existing halt; answers `alreadyHalted` |
| C2 | `POST /resume` | `{confirmation:"RESUME_TRADING", actor}`. 409 `still_breached` while a latched daily-loss halt is still at its limit. Shares `resumeBotTrading()` with the dashboard |
| C3 / C4 | `GET` / `PATCH /risk-limits` | the same bounds as `/api/ops/risk-limits`. A change never clears a latch |
| C5 | `POST /bots/:id/status` | `{status:"active"|"paused", actor}`, a target state rather than a toggle. Answers `changed` and the bot's unresolved-intent count |
| C6 | `POST /trades/:id/close` | `closeStrategyTrade`, shared with the dashboard (below) |
| C7 | `POST /trades/:id/partial-close` | `{pct: 1..99, actor}`, through `partialCloseStrategyTrade`, shared with the dashboard |
| Archive | `POST /trades/:id/archive` | `{archived: boolean, actor}`, capability `tradeArchive.v1`. Presentation state only (never P&L, the daily-loss window or the halt); idempotent; refusals `trade_not_closed`, `trade_has_unresolved_orders`, `trade_needs_attention`, `not_found` |
| Executions | `GET /executions?after=<seq>&limit<=100` | P-81 confirmed-execution feed, capability `executions.v1`. Read-only; one immutable `ExecutionEvent` per fill the ledger booked (strategy, TP/SL, partial, manual incl. per-fill increments), never for submitted/rejected/unknown orders. No `after` = cursor only (no history replay). The Bot sends nothing; Trading Scene polls this |
| C8 | `GET /commands/:requestId` | the stored command, with the live intent or attempt state for a pending order; 404 `command_not_found` |
| C9 | `POST /entries` | OD-3 pause new entries: `{paused:true, reason 3..200, cancelWorkingEntries?, actor}` or `{paused:false, actor}`; target state. Blocks BUYs only (webhook 409 `risk_blocked`, manual 409 `entries_paused`, queued strategy BUY intents are closed off at once). Exits, TP/SL, cancels and sweeps are unaffected. Independent of the halt |
| C10 to C14 | `POST /bots`, `GET` / `PATCH /bots/:id`, `POST /bots/:id/delete`, `POST /bots/:id/rotate-secret` | create (the secret is in the live reply only; the stored replay holds `secretIssued:true`), read, edit, guarded delete, rotate. Guards: `bot_has_open_trades`, `pair_has_open_trades`, `bot_has_unresolved_intents`, `realizations_pending`, `bot_busy_retry`. The same shared code serves the Classic dashboard |
| C15, C16, C19 | `GET /exchange-accounts`, `POST /exchange-accounts/:id/delete`, `GET /exchange-accounts/:id/balance` | no key material; delete needs `REMOVE_ACCOUNT` and is refused with `account_in_use`; balance is numbers only |
| C17, C18 | `POST /exchange-enrollments`, `GET /exchange-enrollments/:id` | mint a single-use ticket (create, replace, reveal_webhook) and read its status. See `deploy/ENROLLMENT.md` |

**C6 and C7 refusals.** Each is a typed `{error, code}` refusal, and nothing is
sold.

- *Close* and *Partial* are **trade-id targeted** (`operatorTarget`) and work
  for a paused bot's trade, a delisted pair and a twin trade on the same pair.
  They refuse a manual trade (409 `trade_manual`) and a deleted bot's trade
  (`bot_deleted`). `bot_paused`, `pair_not_listed` and `ambiguous_trade` no
  longer exist. Capability `operatorExit.v1`.
- `processWebhook` also takes a refuse-only `expectSmartTradeId`. If the trade it
  would close is not the one asked for, it refuses before any lock or order.
- Both refuse while an earlier exit is unresolved (`exit_unresolved`).
- A recent exit that left the position open is 409 `exit_recent`, never a
  success.
- A submitted order whose outcome is not yet known answers 202 `pending`, and
  the Bot reconciles it by its client order id.

**Idempotency.** `BotControlCommand` (migration
`20261109130000_bot_control_command`) works like this:

- It claims each request id with an insert first.
- Its command hash covers kind, target and parameters, but not the actor.
- The same id and hash replays the stored result. A different hash is 409
  `request_id_reused`. A command still running is 409 `command_in_progress`,
  and it is never run again, whatever its age.
- The intent or attempt id is recorded before the order goes on the wire, so
  `C8` tells the truth after a crash.

**Other rules.**

- Every POST/PATCH carries `actor`: who stepped up on the Platform, how, and
  when. It is a claim signed by the Platform's key.
- Bodies are zod `.strict()`, and no request body is logged.
- The control routes have their own rate limits: 120 reads and 60 writes per
  minute. They are separate from the 120/min API limiter, so polling cannot
  starve a halt. A 429 carries `code: "bot_rate_limited"` and means nothing
  was executed.

C0 also reports `capabilities` (`entries.v1`, `bots.v1`, `accounts.v1`,
`enroll.v1` only when `ENROLLMENT_ENABLED`, `operatorExit.v1`,
`manualPositionFull.v1`) and `entries`; Trading Scene shows a feature only when
it is listed. Exchange keys are entered only on this Bot's `/enroll` page
(`ENROLLMENT_ENABLED`, `deploy/ENROLLMENT.md`).

**Classic dashboard changes (break-glass).** It shares the same server rules:
changing a bot's account with open trades is refused (`bot_has_open_trades`);
a mainnet account needs the server-verified `MAINNET` confirmation; a pause
control and pill (`POST /api/ops/entries`); targeted Close and Partial. The
closed-trade hard delete is gone: `DELETE /api/trades/:id` answers 410
`trade_delete_removed` and deletes nothing. **Archive** (`POST
/api/trades/:id/archive`, `/restore`) hides a closed, fully resolved trade from
History; it is presentation state only, so P&L, totals, the daily-loss window
and the halt latch still count it. It also keeps the Bot's push notifications, which
Trading Scene does not replace. Restrict the dashboard to an allow-list or VPN.

### Persisted execution evidence reads

Platform can read one exact persisted order without triggering reconciliation
or contacting Binance:

- `POST /api/webhooks/signal_bots/execution-evidence` accepts the existing
  webhook-authenticated source identity `{secret, symbol, action, dedupe_key}`.
  It resolves the same unique `StrategyOrderIntent.sourceKey` used at
  submission. The secret authenticates and selects the bot but is never echoed.
- `POST /api/manual-trading/execution-evidence/manual-orders/lookup` uses the
  existing Platform-to-Bot HMAC, freshness window, durable nonce replay check,
  and rate limit. Its signed body supplies exactly one `orderId` or
  `orderRequestId`.

Responses label immutable timestamped occurrences as
`AUTHORITATIVE_HISTORICAL_EVENT`, exact identifier relationships as
`AUTHORITATIVE_LINKAGE`, and mutable order/command snapshots as
`CURRENT_AUTHORITATIVE_STATE`. `updatedAt` is exposed only as the snapshot's
`observedAt`; it is never expanded into inferred lifecycle events. Successful
cancel commands are attached only when their persisted result names the exact
manual order ID, with at most 10 returned.

The Bot does not persist individual strategy or manual exchange fills, prior
cumulative snapshots, exchange acceptance time, or a separate command
completion timestamp. Those facts remain unavailable. The reads select only
local persisted rows; they cannot submit, cancel, reconcile, change risk/halt
state, or call an exchange.

These are local code guarantees, not Binance acceptance. Real Binance/testnet
must still confirm client-order-ID uniqueness and lookup timing, order status
and cumulative-fill fields, commission-trade availability, and cancel/fill race
responses. Local fake-exchange/SQLite tests prove durable ordering, conservative
query-miss handling and idempotent local reconstruction; they do not prove real
Binance eventual visibility, MARKET partial-fill behavior, user-data timing or
commission-trade timing.

`scripts/ci/scan-secrets.sh` runs in CI and fails the build on
credential-shaped literals in tracked source. It reports file and line only,
never the value.

## Shariah exposure enforcement

The Platform decides. The Bot enforces one rule, once, at the exchange boundary.

**There is no screening engine here.** The Bot never researches an asset, never
browses, never calls a model, never stores a Shariah registry, and applies no
screening methodology of its own. The Platform is the sole authority for what
any asset's status is. The Bot's entire role is:

> verify the authenticated Platform intent → refuse to create new Spot exposure
> against it.

### The signed context

Both Platform→Bot order paths accept one optional block alongside the order:

```json
"shariah": {
  "mode": "off" | "enforce",
  "policyVersion": "TS_SHARIAH_V1",
  "assetId": "<Platform registry identity>",
  "baseAsset": "<base asset of the exact Spot symbol>",
  "effectiveStatus": "ELIGIBLE" | "REVIEW" | "EXCLUDED",
  "publicationId": "<current publication, or null for an unresolved REVIEW>"
}
```

The Platform resolves its internal UNSCREENED and STALE states to `REVIEW`
before transmission, so the Bot never has to decide what they mean.

**Signature coverage is inherited, not added.** No second crypto scheme was
introduced. On `POST /api/manual-trading/orders` the existing HMAC is computed
over a canonical hash of the *entire* body, so the block is authenticated by the
same signature as `side` and `symbol`: flipping `ELIGIBLE` to `REVIEW`, or
`enforce` to `off`, or `baseAsset`, or removing the block, all invalidate the
request with a 401 before any handler runs. On `POST /api/webhooks/signal_bots`
the block travels inside the payload the per-bot webhook secret authenticates —
the same credential that already authorises placing real orders — and the shared
contract's strict allow-list rejects anything else.

### What the rule is

| Mode | Side | Behaviour |
| --- | --- | --- |
| block absent | any | exactly the pre-Shariah behaviour |
| `off` | any | exactly the pre-Shariah behaviour |
| `enforce` | BUY | placed **only** when `effectiveStatus` is `ELIGIBLE` |
| `enforce` | SELL | **never** refused on Shariah grounds |

A BUY is refused for `REVIEW`, `EXCLUDED`, a policy version this build cannot
apply, a missing or malformed context, or a base asset that is not the base of
the symbol being traded. Refusals carry their own bounded codes —
`SHARIAH_REVIEW_BLOCKED`, `SHARIAH_EXCLUDED_BLOCKED`, `SHARIAH_POLICY_MISMATCH`,
`SHARIAH_ASSET_MISMATCH`, `SHARIAH_CONTEXT_INVALID`, `SHARIAH_CONTEXT_REQUIRED`
— so a Shariah refusal is never mistaken for an authentication failure, a risk
refusal, or a Binance failure. The webhook outcome is `shariah_blocked` with
HTTP 409, and `mayAdvanceLocalState` is false: the sender is still flat.

### SELL is never blocked, and nothing is ever liquidated

Reducing or exiting exposure is not gated. A signal exit, take-profit,
stop-loss, partial close, dashboard close, manual sell, and every recovery of
those, all proceed whatever the status says — including an asset that has since
become `EXCLUDED`. This is structural, not a convention: `marketSellBase` has no
clearance parameter and the manual adapter derives one only for a BUY, so there
is no code path on which an exit could fail this check.

**No auto-liquidation exists.** The Bot does not poll the Platform, does not
watch for status changes, and creates no order when a classification moves. It
reacts only to authenticated execution intents that arrive on their own.

### Where the check happens, and why there

Enforcement runs at request admission, before anything is claimed: before the
per-bot entry checks, before any exchange credential or balance is read, before
a deterministic client order ID exists, and before the durable
`StrategyOrderIntent` / `ManualOrder` reservation. A refusal therefore leaves no
reservation to unwind and burns no client order ID.

The decision that admitted an order is then persisted beside it
(`shariahContext`). Recovery re-reads *that* decision and never substitutes a
fresher status: reconciling an intent that already crossed the wire is not a new
exposure decision, and a retry that has not yet reached the wire must still
satisfy the gate it was admitted under. The re-check sits before the
`requested → submitted` compare-and-set, so a refusal leaves the intent
abandonable rather than stranded.

Finally, `marketBuyQuote` — the single MARKET BUY chokepoint — *requires* a
clearance that only the enforcement module can produce, and that clearance is
bound to a symbol. An `ELIGIBLE` proof for one asset cannot authorise a BUY of
another, and a new caller cannot reach the exchange without going through the
gate.

### Omission is not a downgrade

Enforcement is remembered per sender scope (per bot, per manual account) in
`ShariahEnforcement`. Once a scope has authenticated `mode: "enforce"`, a later
BUY that simply leaves the block out is refused with
`SHARIAH_CONTEXT_REQUIRED` rather than silently falling back to pre-Shariah
behaviour. Turning enforcement off again takes an explicit, equally
authenticated `mode: "off"`.

That table holds a mode and a policy identity only — never an asset, a status,
or any screening input. It is not a registry. Enabling Shariah mode for one bot
never switches it on for a user who did not ask for it.

## Project layout

```
tradingbot/
├── backend/     # API, webhooks, Binance execution, SQLite DB
├── frontend/    # React dashboard + create-bot UI
├── deploy/      # Docker, nginx, AWS notes
└── docker-compose.yml
```

## Quick start (local)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY (32+ chars), optional BINANCE keys for global fallback
npm install
npx prisma migrate dev
npm run dev
```

API runs at `http://localhost:4000`.

> **Running the Platform on the same Mac?** It defaults to port 4000 too. Move
> the bot, not the platform: set `PORT=4001` and `PUBLIC_URL=http://localhost:4001`
> in `backend/.env`, and point the dev proxy in `frontend/vite.config.ts` at 4001.
> The platform's `MANUAL_TRADING_BOT_URL` already defaults to
> `http://localhost:4001`. Leave `PORT=4000` for the Docker deployment — the
> compose port mapping, the image's `EXPOSE` and its healthcheck all use 4000.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

UI at `http://localhost:5173` (proxies `/api` to backend).

### 3. First-run account setup

The dashboard is gated behind password + TOTP. On first visit you will be asked to
create the single admin account, then to scan a QR code with an authenticator app.

**Do not skip the QR step** — MFA is mandatory, and the account is unusable without
it. There is no password-reset flow: losing both the password and the TOTP device
means deleting the `User` row from SQLite and re-registering.

Sessions use a 15-minute access token with a rotating 30-day refresh token, both as
`httpOnly` cookies. See [the technical guide](docs/BOT_COMPLETE_GUIDE.md#67-authentication-and-sessions).

### 4. Connect Binance

1. Open the app → **Settings** (or first-run prompt).
2. Add your Binance API key + secret (withdraw disabled, IP whitelist recommended).
   **Use Binance testnet** is ticked by default. Unticking it asks you to type
   `MAINNET` before a real-money account is added. The API itself requires an
   explicit `testnet: true|false` and refuses an account that omits it. Keys are
   entered here only, never in Trading Scene.
3. Create a **Signal Bot** with pairs, direction, entry %, TP/SL toggles. Bots
   are created, edited and deleted here; Trading Scene's `/bot` can start and
   stop them. A bot with active trades, or with orders still being reconciled,
   cannot be deleted (409 `bot_has_open_trades` / `bot_has_unresolved_intents`),
   because its trades would lose TP/SL and could no longer be closed.

### 5. TradingView emergency/independent exit webhook

On the **Create Signal Bot** page, copy:

- **Webhook URL:** `https://YOUR-DOMAIN/api/webhooks/signal_bots`
- **Webhook secret**, to paste into the Trading Scene deployment (entries come
  from Trading Scene);
- optionally, the **TradingView exit (SELL) alert message**, which includes the
  per-bot `secret`.

Afterwards the secret and the exit message are shown only after an explicit
**Reveal webhook secret** on the Edit page. Paste the URL in TradingView alert
→ **Notifications** → **Webhook URL**, and only the exit message in the alert
**Message** field. The UI generates no BUY payload: a BUY without Platform
correlation headers is refused with 403 "Platform authority required for
exposure-increasing BUY".

Supported actions in JSON:

| action | Meaning |
|--------|---------|
| `BUY` / `enter_long` | Rejected unless it carries authenticated durable Platform authority |
| `SELL` / `exit_long` | Close long (market sell) |

Exit example:

```json
{
  "secret": "your-bot-secret-from-ui",
  "action": "SELL",
  "symbol": "APTUSDT",
  "dedupe_key": "{{timenow}}"
}
```

## Deploy on AWS (EC2 + Docker)

> **Production doesn't use this path.** Since 2026-11-04 the Bot is deployed from
> the Platform repository, with `platform/deployment/aws/bot-stack.sh` and
> `BOT-DEPLOY.md` beside it. That setup uses Caddy with no SSH port. The steps below
> describe the older manual deployment.

See [deploy/AWS.md](deploy/AWS.md).

Summary:

1. Provision with `deploy/cloudshell-launch.sh` from AWS CloudShell — creates the
   EC2 instance, security group (22 from your IP, 80, 443) and an Elastic IP.
2. Point DNS `bot.yourdomain.com` → Elastic IP.
3. Deploy from your Mac:

   ```bash
   ./deploy/remote-deploy.sh bot.yourdomain.com ~/Downloads/your-key.pem
   ```

   This rsyncs the source, preserves the server `.env` and the SQLite volume,
   rebuilds both containers, and renews TLS via certbot. **Open trades survive a
   redeploy** — the database lives in the `bot-data` Docker volume, and the script
   never overwrites `backend/.env`, so `JWT_SECRET` and stored API keys persist.

Host nginx config lives in `deploy/nginx-production.conf`.

> A redeploy restarts the backend, which pauses the 30s TP/SL monitor and the 60s
> manual-close sync for a few seconds. Deploy when nothing sits near a trigger.

## Environment variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | SQLite path (default `file:./data/bot.db`) |
| `ENCRYPTION_KEY` | 32+ char key to encrypt stored API secrets |
| `PUBLIC_URL` | Public HTTPS URL (webhook links in UI) |
| `DRY_RUN` | `true` = log orders, no Binance calls |
| `PORT` | API port (default 4000; use 4001 when the platform runs on the same host — see Quick start) |
| `EXCHANGE_STOPS_ENABLED` | `false` by default, and **not wired**: `placeProtection`/`cancelProtection` in `backend/src/services/exchangeStops.ts` have no call sites, so `true` changes only a status string and places no order. Protection is the 30-second in-process poll in either state. |
| `JWT_SECRET` | Signs session tokens (`openssl rand -hex 64`). Changing it logs you out |
| `SCRYPT_SALT` | KDF salt (`openssl rand -hex 16`). Changing it invalidates stored API keys |
| `SECURE_COOKIES` | `false` only for local HTTP dev; `true` in production |
| `CORS_ORIGIN` | Exact frontend origin, or the browser drops session cookies |
| `VAPID_*` | Optional Web Push keys (`npx web-push generate-vapid-keys`) |
| `BINANCE_TESTNET` | Process-wide default network for a bot **without** its own exchange account (default `false`). Each exchange account carries its own `testnet` flag, which decides where its orders go |
| `MANUAL_TRADING_ENABLED` | `true` enables Trading Scene's manual orders and the read views behind its `/bot` page. The control routes (`/api/manual-trading/control/*`) work without it |
| `MAINNET_MANUAL_TRADING_ENABLED` | `false` by default; manual orders on a mainnet account need it and a confirmation phrase |
| `MANUAL_TRADING_HMAC_SECRET` | The Platform-to-Bot control-plane key (32+ characters, the same value as the Platform's). Signs manual orders, the Shariah floor and the control routes; without it those routes refuse |
| `ENROLLMENT_ENABLED` | `false` by default. `true` turns on `/api/enroll/*` and the `enroll.v1` capability. Needs `PUBLIC_URL` to be the Bot's https origin and `PLATFORM_RETURN_URL` |
| `PLATFORM_RETURN_URL` | Exact https return page after enrollment, e.g. `https://mytradingview.alphawebstudioz.com/bot/accounts`. Never read from a request |
| `REALIZATION_CONTRACT_V2_ENABLED` | `false` by default. Set `true` only after the Platform is deployed (see "Realization contract v2"). Do not roll the Bot back past this version once v2 rows exist |

With `DRY_RUN=false`, the API refuses to start unless `ENCRYPTION_KEY`,
`SCRYPT_SALT` and `JWT_SECRET` are all present and long enough.

Per-bot secrets are generated when you create a bot; Binance keys are stored per exchange account in the DB.

## Backup and restore

SQLite `bot.db` is the authoritative local recovery artifact. It includes bot
configuration and webhook secrets; exchange-account routing and encrypted API
key blobs; `SmartTrade`, `PartialClose`, `StrategyOrderIntent`, immutable
`RealizationEvent` payload/outbox state, `ManualOrder`,
`ManualCommand`, `BotControlCommand` (Platform control commands),
nonce/receipt dedupe records, close marks, risk/halt state,
execution logs, users/sessions/push subscriptions, and Prisma migration history.
The live-price/PnL snapshots in those rows can be refreshed, but identities,
quantities, linkage and lifecycle state must be preserved.

The database does **not** include `backend/.env`. Re-provision configuration
separately. In particular, the original `ENCRYPTION_KEY` and `SCRYPT_SALT` are
needed to decrypt restored exchange credentials (otherwise re-enter those
credentials). `JWT_SECRET`, `SETUP_TOKEN`, the manual HMAC secret, VAPID private
key, and any legacy environment-based Binance credentials also remain
environment-managed; changing the JWT secret invalidates existing sessions. A
production backup is sensitive even though API keys are encrypted: it also
contains webhook/TOTP/authentication material and is decryptable with the
separate keys. Store it with permissions and retention appropriate for
credentials.

Both scripts require the native `sqlite3` CLI. The backend image includes it.
Create the destination directory yourself so an output-path typo fails closed.
For a running Docker backend:

```bash
install -d -m 700 /secure/trading-bot-backups
scripts/backup-db.sh \
  --container "$(docker compose ps -q backend)" \
  --output "/secure/trading-bot-backups/bot-$(date -u +%Y%m%dT%H%M%SZ).db"
```

For a stopped local backend, name the source and output explicitly:

```bash
scripts/backup-db.sh --source backend/data/bot.db --output /secure/trading-bot-backups/bot.db
```

Backup refuses an existing output. It uses SQLite's online backup API rather
than copying a live database, then checks SQLite integrity, foreign keys, every
current durable table, and every migration in this checkout. It prints the
artifact SHA-256, SQLite version, size and compatibility result; record that
output with the protected artifact.

Restore always requires an explicit fresh destination. Stop the backend first:

```bash
scripts/restore-db.sh --backup /secure/trading-bot-backups/bot.db \
  --target /explicit/recovery/path/bot.db
```

For Docker, build the current image, stop (or on a replacement machine create)
the backend container, and identify that stopped target explicitly:

```bash
docker compose build backend
docker compose stop backend                 # use `docker compose create backend` on a fresh target
scripts/restore-db.sh --backup /secure/trading-bot-backups/bot.db \
  --container "$(docker compose ps -aq backend)"
docker compose start backend
```

Restore refuses a running/ambiguous container and refuses any existing local
database or SQLite WAL/SHM sidecar. For an intentional replacement, add
`--replace`; the prior database and sidecars are moved to timestamped safety
copies before the validated artifact is installed. No test-only marker is
required, so the same command works for a genuine new recovery target. The
backup must match all migrations in the checkout; use the matching Bot checkout
for an older artifact, then let the normal backend entrypoint run
`prisma migrate deploy` before application startup.

The disposable regression proof is:

```bash
cd backend
node --env-file=tests/test.env --import tsx --test tests/backupRestore.test.ts
```

It migrates and seeds one task-owned source through Prisma, backs it up, removes
that source from the read path, restores a separate fresh target, reopens the
target through the Bot Prisma layer, compares recovery fields exactly, and
proves restored strategy/manual/webhook replay identities suppress resubmission
without exchange access.

## Paired Platform+Bot release and rollback

Bot and Platform ship as a pair: the durable `RealizationEvent` outbox
(`services/realizationEvents.ts`) delivers to Platform's ingestion route
using the vendored `webhookContract.ts` and `realizationEventContract.ts`
files, which must stay byte-for-byte identical between the two repositories.
`scripts/release.sh` is read/report only — it never touches Git history, the
database, or a running process:

```bash
scripts/release.sh identity
scripts/release.sh gate --peer-platform-root /path/to/platform
scripts/release.sh rollback-check --since <bot-git-ref> [--database backend/data/bot.db]
```

`identity` prints the exact commit, the Prisma migration set and its hash,
and both contract versions/fingerprints. `gate` adds a clean-worktree check,
tool availability (`sqlite3`), a byte-identical diff of both vendored
contract files against a Platform checkout, `npm run typecheck`, and the
realization-focused test files (`strategyIntentMigration.test.ts`,
`spotExecutionReliability.test.ts`, `backupRestore.test.ts`). Delivery is
opt-in: `REALIZATION_DELIVERY_ENABLED` (here) and Platform's
`REALIZATION_INGESTION_ENABLED` both default to `false`.

**Known-good pairs** (Bot commit / Platform commit):

| Pair | Bot | Platform |
|---|---|---|
| Previous known-good | `fda4d1b` | `93e7544` |
| Current accepted | `2bc543e` | `21bedb1` |

**The pending-realization-event rule.** `RealizationEvent` and the new
`StrategyOrderIntent` provenance columns are additive — the previous Bot
build's Prisma Client simply never selects them, and `prisma migrate deploy`
against a database ahead of the checkout's own migrations reports nothing
pending rather than erroring (proven directly: the previous commit's
`migrate deploy` and a raw Prisma read were run unmodified against a
disposable SQLite database seeded at the current schema). That makes
**already-`delivered`** rows, and a database with **no** `RealizationEvent`
rows at all, `BACKWARD_COMPATIBLE`: old Bot code may start directly against
either, exactly like the accepted OLD BOT + NEW PLATFORM state — it will not
publish any *future* event, but nothing already-durable is lost or touched.

A **`pending`** (or `integrity_error`) row is different: the previous build
does not run `deliverPendingRealizations` at all, so that row would sit
undelivered indefinitely — a real operational loss of authoritative
economics, not merely "ignored." `rollback-check --database <bot.db>`
classifies exactly this, per-database, and fails closed
(`ROLLBACK_INCOMPATIBLE`, non-zero exit) whenever any row is not
`delivered`, or `UNKNOWN` if no `--database` is given at all:

```bash
scripts/release.sh rollback-check --since fda4d1b --database backend/data/bot.db
```

Before a Bot code rollback: stop the process taking new closes, run the
check above, and either (a) if it reports `ROLLBACK_INCOMPATIBLE`, wait for
`deliverPendingRealizations` to drain those rows to `delivered` (it retries
automatically with bounded backoff) and re-run the check, or (b) restore
Platform and Bot to the pre-release backups (this file's Backup and restore
section; `platform/scripts/backup-platform-db.sh` on the Platform side)
instead of a code-only rollback. Never start old Bot code against a database
this check has not classified `BACKWARD_COMPATIBLE`.

**Preferred upgrade order:** Platform first, then Bot — see the Platform
`docs/OPERATIONS.md` §7 for the full reasoning and the scenario-specific
rollback order (bad Platform only / bad Bot only / full paired rollback).

### V3 migrations and deploy order (2026-11-09)

Five additive migrations: `20261110100000_manual_exit_cancel`,
`20261110110000_entries_pause`, `20261110200000_exchange_account_key_hint`,
`20261110210000_exchange_enrollment`, `20261110220000_realization_environment`.
Back up the SQLite file first, deploy the Bot with the three flags off, deploy
the Platform, enable enrollment, then `REALIZATION_CONTRACT_V2_ENABLED`, then a
testnet round trip with an operator present. The full order and checklist are in
the Platform repo's `docs/MAHAMID_FINAL_HANDOFF_2026-11-09.md`.

### Realization contract v2 (OD-5): rollout and Platform rollback

Contract v2 adds the order's `environment` (DRY_RUN | TESTNET | MAINNET |
UNKNOWN) to each realization event. Rollout is **Platform first**:

1. Deploy a Platform that accepts v2. Its acknowledged ingest answers then
   carry `capabilities: ["realization.v2"]`; the Bot records that
   (`PlatformCapability`) on the next delivered batch.
2. Set `REALIZATION_CONTRACT_V2_ENABLED=true` on the Bot. Events persisted
   from then on are v2 — only while the capability is recorded. Earlier rows
   keep their v1 payload forever (payloads are immutable and hashed).

**Rolling the Platform back to a v1-only build** needs no Bot action:

- the first v2 batch the old Platform refuses with a definitive 4xx (not
  401/403/429, not a 5xx or transport failure) clears the capability, and
  every event persisted afterwards is v1 again;
- stored v2 rows are **held aside**, never rewritten (the Platform may
  already hold their hash): due v1 rows are always delivered first, and the
  oldest due v2 batch is retried only when no v1 row is due, paced by the
  rows' own backoff (at most once an hour after a few attempts). They show
  as `pending` with the Platform's refusal in `lastError`;
- when the Platform is upgraded again, its next acknowledged answer lists
  `realization.v2` and the held rows drain in order;
- optionally set `REALIZATION_CONTRACT_V2_ENABLED=false` for the duration,
  so no new v2 row is created between the rollback and the first refusal.

Do **not** roll the *Bot* back past this version while v2 rows exist: an
older Bot's integrity check cannot read them and marks them `integrity_error`
(`scripts/release.sh rollback-check` reports any non-delivered row).

## Security notes

- **Never commit `backend/.env` or `*.db`** — both are gitignored. The database holds
  your encrypted exchange keys; the `.env` holds the key that decrypts them.
- Binance API keys should have **withdrawals disabled** and an IP allowlist.
- The dashboard requires password + TOTP; webhooks authenticate by per-bot secret
  instead, since TradingView cannot hold a session.
- Keep the repository **private**. Even without secrets, it discloses the webhook
  path structure and position-sizing logic.

## License

Use at your own risk. Not financial advice.
