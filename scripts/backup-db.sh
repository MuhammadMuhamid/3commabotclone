#!/usr/bin/env bash
# Create a consistent SQLite backup of the Bot database.
#
# The artifact contains the entire database, including encrypted exchange-key
# blobs, webhook credentials and authentication state. Treat it as sensitive.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/sqlite-db-common.sh
source scripts/sqlite-db-common.sh

usage() {
  echo "usage: $0 (--source <bot.db> | --container <backend-container>) --output <backup.db>" >&2
  exit 2
}

SOURCE=""
CONTAINER=""
OUTPUT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) [ "$#" -ge 2 ] || usage; SOURCE="$2"; shift 2 ;;
    --container) [ "$#" -ge 2 ] || usage; CONTAINER="$2"; shift 2 ;;
    --output) [ "$#" -ge 2 ] || usage; OUTPUT="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$OUTPUT" ] || usage
if { [ -n "$SOURCE" ] && [ -n "$CONTAINER" ]; } ||
   { [ -z "$SOURCE" ] && [ -z "$CONTAINER" ]; }; then
  usage
fi
[ ! -e "$OUTPUT" ] && [ ! -L "$OUTPUT" ] || {
  echo "refusing to overwrite existing backup: $OUTPUT" >&2
  exit 1
}
OUTPUT_DIR="$(dirname "$OUTPUT")"
[ -d "$OUTPUT_DIR" ] || {
  echo "backup output directory does not exist: $OUTPUT_DIR" >&2
  exit 1
}

require_sqlite3
if command -v sha256sum >/dev/null 2>&1; then
  HASH_TOOL=sha256sum
elif command -v shasum >/dev/null 2>&1; then
  HASH_TOOL=shasum
else
  echo "a SHA-256 tool (sha256sum or shasum) is required" >&2
  exit 1
fi
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/trading-scene-bot-backup.XXXXXX")"
STAGED="$SCRATCH/backup.db"
REMOTE=""
cleanup() {
  if [ -n "$REMOTE" ] && [ -n "$CONTAINER" ]; then
    docker exec "$CONTAINER" rm -f "$REMOTE" >/dev/null 2>&1 || true
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT HUP INT TERM

if [ -n "$SOURCE" ]; then
  [ -f "$SOURCE" ] || {
    echo "source database is not a regular file: $SOURCE" >&2
    exit 1
  }
  sqlite3 "$SOURCE" ".backup '$STAGED'"
else
  command -v docker >/dev/null 2>&1 || {
    echo "docker is required for --container" >&2
    exit 1
  }
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
  [ "$running" = "true" ] || {
    echo "container backup requires the explicitly named backend container to be running" >&2
    exit 1
  }
  REMOTE="/tmp/trading-scene-bot-backup-${RANDOM}-$$.db"
  docker exec "$CONTAINER" sh -c \
    "set -eu; command -v sqlite3 >/dev/null; test ! -e '$REMOTE'; sqlite3 /app/data/bot.db \".backup '$REMOTE'\"; chmod 600 '$REMOTE'"
  docker cp "$CONTAINER:$REMOTE" "$STAGED" >/dev/null
  docker exec "$CONTAINER" rm -f "$REMOTE"
  REMOTE=""
fi

validate_bot_database "$STAGED" "backup"
chmod 600 "$STAGED"
bytes="$(wc -c <"$STAGED" | tr -d ' ')"
if [ "$HASH_TOOL" = "sha256sum" ]; then
  hash="$(sha256sum "$STAGED" | awk '{print $1}')"
else
  hash="$(shasum -a 256 "$STAGED" | awk '{print $1}')"
fi
version="$(sqlite3 --version | awk '{print $1}')"
mv "$STAGED" "$OUTPUT"
chmod 600 "$OUTPUT"

echo "wrote $OUTPUT ($bytes bytes)"
echo "SHA-256 $hash"
echo "SQLite $version; Prisma migration compatibility verified"
