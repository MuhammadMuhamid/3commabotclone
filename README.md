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
- The operator halt gates both BUY and SELL submission paths. Numeric exposure,
  concurrency and daily-loss limits continue to permit exits according to the
  existing policy. A never-attempted strategy intent rechecks those gates, while
  an already-attempted intent still reconciles exchange truth during a later
  halt. Dry run never sends an order, and manual live execution is restricted
  to Binance Spot with the existing testnet/mainnet confirmations.

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
