# Signal Bot — TradingView + Binance (3commas-style)

Full-stack signal trading bot: connect **Binance Spot**, receive **TradingView webhooks**, manage **multi-pair bots**, and trade from a **3commas-inspired** dashboard.

> **Risk:** Live trading can lose money. Start with `DRY_RUN=true` and tiny position sizes.

## What this repository is, and what it is not

This is the **execution** half of the system.

| | This repository | Platform (`MuhammadMuhamid/my-tradingview-clone`) |
|---|---|---|
| Decides when to trade | no | **yes** |
| Places exchange orders | **yes** | no |
| Holds Binance API keys | yes, AES-256-GCM encrypted at rest | **never** |

It receives buy/sell instructions over HTTP from two independent senders — the
platform's live runner, and TradingView alerts — and turns them into Binance
Spot market orders. It has no opinion about whether an instruction is a good
idea.

**Keeping exchange credentials in this process alone is the point of the split.**
Do not move credential handling into the platform, and do not merge the two
repositories.

There is a third repository,
[`MuhammadMuhamid/pythoncryptobacktesingsystems`](https://github.com/MuhammadMuhamid/pythoncryptobacktesingsystems),
which holds the optimizer trees and research. It is offline analysis: it never
sends an instruction here and this repository never reads from it. It is named
only so the name is not mistaken for the platform — it held both until the
repositories were separated on 2026-08-22.

The cross-repository payload contract is documented in the platform repository
at `docs/WEBHOOK-CONTRACT.md`. Change it on both sides, and in that document, in
one commit. Both repositories carry a contract test that mirrors the other side;
this one is `backend/tests/webhookContract.test.ts`.

### Repository status

`MuhammadMuhamid/3commabotclone` is authoritative for the bot. There is no
superseded duplicate of this repository.

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

## Spot execution reliability boundary

- Authenticated manual Spot commands bind timestamp, nonce, request ID, path,
  method and body under HMAC. Nonces and command results are durable in SQLite,
  so restart does not erase replay/idempotency identity.
- A manual order intent and deterministic Binance client order ID are persisted
  before submission. Startup and the bounded poller query that ID and apply
  cumulative open, partial, filled or canceled exchange snapshots idempotently.
- Once a manual intent is `submitted`, a not-found query does **not** authorize
  another submission: absence cannot distinguish lookup delay from a crash just
  before the wire call. It remains pending for later reconciliation/operator
  review. A never-attempted `requested` intent may submit once.
- Every strategy MARKET BUY/SELL has a durable `StrategyOrderIntent` before the
  exchange boundary. `requested` proves no submission has been attempted;
  `submitted` is persisted before the wire call and can only query the
  deterministic client ID. A query miss stays unresolved and never authorizes
  a replacement order.
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
- The operator halt gates both BUY and SELL submission paths. Numeric exposure,
  concurrency and daily-loss limits continue to permit exits according to the
  existing policy. A never-attempted strategy intent rechecks those gates, while
  an already-attempted intent still reconciles exchange truth during a later
  halt. Dry run never sends an order, and manual live execution is restricted
  to Binance Spot with the existing testnet/mainnet confirmations.

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
3. Create a **Signal Bot** with pairs, direction, entry %, TP/SL toggles.

### 5. TradingView webhook

On the **Create Signal Bot** page, copy:

- **Webhook URL:** `https://YOUR-DOMAIN/api/webhooks/signal_bots`
- **JSON message** (includes per-bot `secret`)

Paste the URL in TradingView alert → **Notifications** → **Webhook URL**.  
Paste the JSON in the alert **Message** field (or use Pine `alert()` with the same JSON).

Supported actions in JSON:

| action | Meaning |
|--------|---------|
| `BUY` / `enter_long` | Open/add long (market buy) |
| `SELL` / `exit_long` | Close long (market sell) |
| `enter_short` | Not fully supported on spot — use futures later |
| `exit_short` | Close short |

Example:

```json
{
  "secret": "your-bot-secret-from-ui",
  "action": "BUY",
  "symbol": "APTUSDT",
  "quote_order_qty": 50
}
```

Or percentage of bot max investment (omit `quote_order_qty`):

```json
{
  "secret": "your-bot-secret",
  "action": "BUY",
  "symbol": "APTUSDT"
}
```

## Deploy on AWS (EC2 + Docker)

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
| `PORT` | API port (default 4000) |
| `JWT_SECRET` | Signs session tokens (`openssl rand -hex 64`). Changing it logs you out |
| `SCRYPT_SALT` | KDF salt (`openssl rand -hex 16`). Changing it invalidates stored API keys |
| `SECURE_COOKIES` | `false` only for local HTTP dev; `true` in production |
| `CORS_ORIGIN` | Exact frontend origin, or the browser drops session cookies |
| `VAPID_*` | Optional Web Push keys (`npx web-push generate-vapid-keys`) |

With `DRY_RUN=false`, the API refuses to start unless `ENCRYPTION_KEY`,
`SCRYPT_SALT` and `JWT_SECRET` are all present and long enough.

Per-bot secrets are generated when you create a bot; Binance keys are stored per exchange account in the DB.

## Backup and restore

SQLite `bot.db` is the authoritative local recovery artifact. It includes bot
configuration and webhook secrets; exchange-account routing and encrypted API
key blobs; `SmartTrade`, `PartialClose`, `StrategyOrderIntent`, immutable
`RealizationEvent` payload/outbox state, `ManualOrder`,
`ManualCommand`, nonce/receipt dedupe records, close marks, risk/halt state,
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
