#!/usr/bin/env bash
# Restore the bot's SQLite database from a backup produced by backup-db.sh.
#
# This OVERWRITES live trade history and the stored exchange credentials, so it
# refuses to run unless the backend is stopped and the operator confirms
# explicitly. It also takes a safety copy of whatever it is about to replace.
#
# Restoring does NOT restore ENCRYPTION_KEY or SCRYPT_SALT. If those have
# changed since the backup was taken, the API keys inside it cannot be
# decrypted and must be re-entered in Settings. Everything else is intact.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="${1:?usage: restore-db.sh <backup.db> [--yes]}"
CONFIRM="${2:-}"
DB="${DB_PATH:-backend/data/bot.db}"
CONTAINER="${BACKEND_CONTAINER:-}"

[ -f "$SRC" ] || { echo "no such backup: $SRC" >&2; exit 1; }

if command -v sqlite3 >/dev/null 2>&1; then
  if ! integrity="$(sqlite3 "$SRC" 'PRAGMA integrity_check;' 2>&1)" || [ "$integrity" != "ok" ]; then
    echo "refusing to restore: $SRC is not a readable SQLite database" >&2
    echo "  sqlite3 said: $integrity" >&2
    exit 1
  fi
fi

if [ "$CONFIRM" != "--yes" ]; then
  cat >&2 <<MSG
This will REPLACE the live database with $SRC.

Open trades, partial closes, webhook history and the stored exchange
credentials in the current database will be overwritten.

Stop the backend first:
    docker compose stop backend

Then re-run with --yes:
    $0 $SRC --yes
MSG
  exit 1
fi

if [ -n "$CONTAINER" ]; then
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
  if [ "$running" = "true" ]; then
    echo "refusing to restore while $CONTAINER is running — stop it first" >&2
    exit 1
  fi
  docker cp "$SRC" "$CONTAINER:/app/data/bot.db"
  echo "restored into $CONTAINER:/app/data/bot.db"
else
  if [ -f "$DB" ]; then
    safety="$DB.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$DB" "$safety"
    chmod 600 "$safety"
    echo "previous database kept at $safety"
  fi
  mkdir -p "$(dirname "$DB")"
  cp "$SRC" "$DB"
  chmod 600 "$DB"
  echo "restored $DB from $SRC"
fi

echo "Start the backend again: docker compose start backend"
