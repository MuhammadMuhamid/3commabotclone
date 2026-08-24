#!/bin/bash
# Run FROM YOUR MACHINE after EC2 is up:
#   chmod +x deploy/remote-deploy.sh
#   ./deploy/remote-deploy.sh bot.example.com ~/Downloads/key.pem
#
# BOT-030, two defects, both fixed below:
#
#  1. It rsynced from `/Users/<someone>/Projects/tradingbot/`, an absolute path
#     under one person's home directory. Run from any other checkout it either
#     failed or — worse — shipped whatever happened to be at that path. The
#     source is now this checkout, derived from the script's own location.
#
#  2. It rewrote the server `.env` wholesale with `DRY_RUN=false` hardcoded,
#     so a deployment ALWAYS armed live order placement, contradicting the
#     README's "start with DRY_RUN=true". The value is now taken from the
#     server's existing .env, defaults to `true` for a first deployment, and
#     going live is an explicit `DRY_RUN=false ./deploy/remote-deploy.sh ...`
#     that the script announces before it writes.

set -euo pipefail
IP="${1:?Usage: $0 <hostname-or-EC2-IP> path/to/key.pem}"
KEY="${2:?}"
HOST="ubuntu@${IP}"
ROOT="/opt/tradingbot"
# The checkout this script lives in — never another machine's home directory.
SRC="$(cd "$(dirname "$0")/.." && pwd)"

chmod 400 "$KEY"
ssh -o StrictHostKeyChecking=accept-new -i "$KEY" "$HOST" \
  "sudo mkdir -p $ROOT && sudo chown ubuntu:ubuntu $ROOT"

# ── Read all persistent secrets BEFORE rsync (never overwrite server .env) ───
read_env() {
  ssh -i "$KEY" "$HOST" \
    "grep -E \"^$1=\" $ROOT/backend/.env 2>/dev/null | cut -d= -f2-" || true
}

EXISTING_ENC_KEY=$(read_env ENCRYPTION_KEY)
EXISTING_SCRYPT_SALT=$(read_env SCRYPT_SALT)
EXISTING_JWT_SECRET=$(read_env JWT_SECRET)
EXISTING_VAPID_PUBLIC=$(read_env VAPID_PUBLIC_KEY)
EXISTING_VAPID_PRIVATE=$(read_env VAPID_PRIVATE_KEY)
EXISTING_DRY_RUN=$(read_env DRY_RUN)
EXISTING_PUBLIC_URL=$(read_env PUBLIC_URL)
EXISTING_CORS_ORIGIN=$(read_env CORS_ORIGIN)
EXISTING_VAPID_SUBJECT=$(read_env VAPID_SUBJECT)
EXISTING_BINANCE_TESTNET=$(read_env BINANCE_TESTNET)

# DRY_RUN: keep whatever the server already has; a first deployment starts in
# dry run. Arming live order placement is an explicit act by the caller.
DRY_RUN_VALUE="${DRY_RUN:-${EXISTING_DRY_RUN:-true}}"
case "$DRY_RUN_VALUE" in
  true|false) ;;
  *) echo "DRY_RUN must be true or false, got '$DRY_RUN_VALUE'" >&2; exit 1 ;;
esac
PUBLIC_URL_VALUE="${PUBLIC_URL:-${EXISTING_PUBLIC_URL:-https://$IP}}"
CORS_ORIGIN_VALUE="${CORS_ORIGIN:-${EXISTING_CORS_ORIGIN:-$PUBLIC_URL_VALUE}}"
VAPID_SUBJECT_VALUE="${VAPID_SUBJECT:-${EXISTING_VAPID_SUBJECT:-mailto:admin@$IP}}"
BINANCE_TESTNET_VALUE="${BINANCE_TESTNET:-${EXISTING_BINANCE_TESTNET:-false}}"

if [ "$DRY_RUN_VALUE" = "false" ]; then
  echo "*** DRY_RUN=false — this deployment WILL place real Binance orders. ***"
else
  echo "DRY_RUN=true — orders will be logged, not placed. Re-run with DRY_RUN=false to arm."
fi

# ── rsync source → server (never overwrites .env) ─────────────────────────
rsync -avz \
  --exclude node_modules --exclude .git \
  --exclude backend/data --exclude backend/.env \
  -e "ssh -i $KEY" \
  "$SRC/" \
  "$HOST:$ROOT/"

# ── Generate secrets if they are missing or are placeholder values ──────────
BAD_VALS=("" "PLACEHOLDER" "change-me-to-a-long-random-string-at-least-32-chars" \
           "change-me-to-16-hex-chars" "change-me-to-a-very-long-random-string-for-jwt-signing")

contains() { local v; for v in "${BAD_VALS[@]}"; do [[ "$1" == "$v" ]] && return 0; done; return 1; }

if contains "$EXISTING_ENC_KEY";    then EXISTING_ENC_KEY=$(openssl rand -hex 32);   fi
if contains "$EXISTING_SCRYPT_SALT"; then EXISTING_SCRYPT_SALT=$(openssl rand -hex 16); fi
if contains "$EXISTING_JWT_SECRET"; then EXISTING_JWT_SECRET=$(openssl rand -hex 64);  fi
if [[ -z "$EXISTING_VAPID_PUBLIC" || -z "$EXISTING_VAPID_PRIVATE" ]]; then
  VAPID_JSON=$(cd "$SRC/backend" && npx web-push generate-vapid-keys --json)
  EXISTING_VAPID_PUBLIC=$(printf '%s' "$VAPID_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).publicKey))')
  EXISTING_VAPID_PRIVATE=$(printf '%s' "$VAPID_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).privateKey))')
fi

# ── Write the server .env ─────────────────────────────────────────────────
ssh -i "$KEY" "$HOST" "cat > $ROOT/backend/.env" << ENVEOF
PORT=4000
PUBLIC_URL=${PUBLIC_URL_VALUE}
DRY_RUN=${DRY_RUN_VALUE}
DATABASE_URL=file:/app/data/bot.db

ENCRYPTION_KEY=${EXISTING_ENC_KEY}
SCRYPT_SALT=${EXISTING_SCRYPT_SALT}
JWT_SECRET=${EXISTING_JWT_SECRET}

SECURE_COOKIES=true
CORS_ORIGIN=${CORS_ORIGIN_VALUE}

VAPID_PUBLIC_KEY=${EXISTING_VAPID_PUBLIC}
VAPID_PRIVATE_KEY=${EXISTING_VAPID_PRIVATE}
VAPID_SUBJECT=${VAPID_SUBJECT_VALUE}

BINANCE_TESTNET=${BINANCE_TESTNET_VALUE}
ENVEOF

# ── Build & start containers ──────────────────────────────────────────────
ssh -i "$KEY" "$HOST" "chmod +x $ROOT/deploy/setup-server.sh && $ROOT/deploy/setup-server.sh"

# ── nginx + TLS ───────────────────────────────────────────────────────────
echo ""
echo "=== Nginx + HTTPS ==="
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
scp -i "$KEY" "$SCRIPT_DIR/nginx-production.conf" "$HOST:/tmp/signalbot-nginx.conf"
ssh -i "$KEY" "$HOST" bash -s << 'SSLEOF'
set -e
sudo cp /tmp/signalbot-nginx.conf /etc/nginx/sites-available/signalbot
sudo ln -sf /etc/nginx/sites-available/signalbot /etc/nginx/sites-enabled/signalbot
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
if [ ! -f /etc/letsencrypt/live/bot.alphawebstudioz.com/fullchain.pem ]; then
  sudo certbot certonly --webroot -w /var/www/html -d bot.alphawebstudioz.com \
    --non-interactive --agree-tos -m admin@alphawebstudioz.com
fi
sudo cp /tmp/signalbot-nginx.conf /etc/nginx/sites-available/signalbot
sudo nginx -t && sudo systemctl reload nginx
SSLEOF

# ── Smoke tests ───────────────────────────────────────────────────────────
echo ""
echo "=== Verify ==="
curl -sf "https://bot.alphawebstudioz.com/health" && echo " health OK"
echo ""
echo "Dashboard: https://bot.alphawebstudioz.com"
echo "Webhook:   https://bot.alphawebstudioz.com/api/webhooks/signal_bots"
echo ""
echo "FIRST RUN: visit the dashboard and create your admin account."
echo "           You will be prompted to scan a TOTP QR code — do not skip it."
