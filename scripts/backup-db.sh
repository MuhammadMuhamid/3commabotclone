#!/usr/bin/env bash
# Back up the bot's SQLite database.
#
# `backend/data/bot.db` holds the AES-256-GCM-encrypted Binance API keys, every
# SmartTrade, every partial close and the whole webhook log. Nothing in this
# repository backed it up, and `docker compose down -v` destroys the volume
# irrecoverably (finding BOT-029).
#
# The backup is a real SQLite backup, not a file copy: `.backup` is safe against
# a live writer, whereas `cp` of a database with a hot WAL produces a file that
# may not open.
#
# The output is STILL SENSITIVE. It contains the encrypted key blobs, which are
# decryptable by anyone who also has ENCRYPTION_KEY and SCRYPT_SALT. Store it
# where you would store the keys themselves. `backups/` is gitignored.
set -euo pipefail

cd "$(dirname "$0")/.."

DB="${DB_PATH:-backend/data/bot.db}"
OUT_DIR="${BACKUP_DIR:-backups}"
KEEP="${BACKUP_KEEP:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$OUT_DIR/bot-$STAMP.db"

# In the deployed setup the database lives in a Docker volume, not on the host.
CONTAINER="${BACKEND_CONTAINER:-}"

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

if [ -n "$CONTAINER" ]; then
  echo "backing up from container $CONTAINER"
  docker exec "$CONTAINER" sh -c \
    "command -v sqlite3 >/dev/null || { echo 'sqlite3 not installed in the container' >&2; exit 1; }
     sqlite3 /app/data/bot.db \".backup '/tmp/backup.db'\""
  docker cp "$CONTAINER:/tmp/backup.db" "$DEST"
  docker exec "$CONTAINER" rm -f /tmp/backup.db
else
  [ -f "$DB" ] || { echo "no database at $DB (set DB_PATH or BACKEND_CONTAINER)" >&2; exit 1; }
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB" ".backup '$DEST'"
  else
    echo "sqlite3 not found — falling back to a file copy." >&2
    echo "Stop the backend first, or the copy may be unreadable." >&2
    cp "$DB" "$DEST"
  fi
fi

chmod 600 "$DEST"

# Verify the backup actually opens and carries the tables that matter, so a
# silently truncated file is not mistaken for a backup.
if command -v sqlite3 >/dev/null 2>&1; then
  integrity="$(sqlite3 "$DEST" 'PRAGMA integrity_check;')"
  [ "$integrity" = "ok" ] || { echo "backup failed integrity_check: $integrity" >&2; exit 1; }
  for table in ExchangeAccount SignalBot SmartTrade; do
    sqlite3 "$DEST" "SELECT 1 FROM $table LIMIT 1;" >/dev/null 2>&1 || {
      echo "backup is missing table $table" >&2; exit 1; }
  done
  echo "integrity_check ok; core tables present"
fi

echo "wrote $DEST ($(wc -c <"$DEST" | tr -d ' ') bytes)"

# Retention: keep the newest $KEEP files, delete the rest.
count="$(find "$OUT_DIR" -maxdepth 1 -name 'bot-*.db' | wc -l | tr -d ' ')"
if [ "$count" -gt "$KEEP" ]; then
  find "$OUT_DIR" -maxdepth 1 -name 'bot-*.db' -print0 \
    | xargs -0 ls -1t \
    | tail -n +"$((KEEP + 1))" \
    | while read -r old; do echo "pruning $old"; rm -f "$old"; done
fi
