#!/usr/bin/env bash
# Restore a Bot SQLite backup into one explicit local path or backend container.
# Existing destinations are refused unless --replace is supplied; replacement
# keeps a timestamped safety copy. Stop the backend before any restore.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
# shellcheck source=scripts/sqlite-db-common.sh
source scripts/sqlite-db-common.sh

usage() {
  echo "usage: $0 --backup <backup.db> (--target <new-bot.db> | --container <stopped-backend-container>) [--replace]" >&2
  exit 2
}

BACKUP=""
TARGET=""
CONTAINER=""
REPLACE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup) [ "$#" -ge 2 ] || usage; BACKUP="$2"; shift 2 ;;
    --target) [ "$#" -ge 2 ] || usage; TARGET="$2"; shift 2 ;;
    --container) [ "$#" -ge 2 ] || usage; CONTAINER="$2"; shift 2 ;;
    --replace) REPLACE=true; shift ;;
    *) usage ;;
  esac
done

[ -n "$BACKUP" ] || usage
if { [ -n "$TARGET" ] && [ -n "$CONTAINER" ]; } ||
   { [ -z "$TARGET" ] && [ -z "$CONTAINER" ]; }; then
  usage
fi
require_sqlite3
validate_bot_database "$BACKUP" "backup"

if [ -n "$TARGET" ]; then
  TARGET_DIR="$(dirname "$TARGET")"
  [ -d "$TARGET_DIR" ] || {
    echo "restore target directory does not exist: $TARGET_DIR" >&2
    exit 1
  }
  TARGET_PRESENT=false
  for existing in "$TARGET" "$TARGET-wal" "$TARGET-shm"; do
    if [ -e "$existing" ] || [ -L "$existing" ]; then
      [ -f "$existing" ] || {
        echo "restore target or SQLite sidecar is not a regular file: $existing" >&2
        exit 1
      }
      [ ! "$BACKUP" -ef "$existing" ] || {
        echo "backup and restore target are the same file" >&2
        exit 1
      }
      TARGET_PRESENT=true
    fi
  done
  if $TARGET_PRESENT && ! $REPLACE; then
    echo "refusing to overwrite existing restore target without --replace: $TARGET" >&2
    exit 1
  fi

  SCRATCH="$(mktemp -d "$TARGET_DIR/.trading-scene-bot-restore.XXXXXX")"
  STAGED="$SCRATCH/bot.db"
  cleanup() { rm -rf "$SCRATCH"; }
  trap cleanup EXIT HUP INT TERM
  cp "$BACKUP" "$STAGED"
  validate_bot_database "$STAGED" "staged restore"

  if $TARGET_PRESENT; then
    SAFETY="$TARGET.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
    for existing in "$TARGET" "$TARGET-wal" "$TARGET-shm"; do
      [ -e "$existing" ] || continue
      suffix="${existing#"$TARGET"}"
      [ ! -e "$SAFETY$suffix" ] || {
        echo "refusing to overwrite existing safety copy: $SAFETY$suffix" >&2
        exit 1
      }
    done
    for existing in "$TARGET" "$TARGET-wal" "$TARGET-shm"; do
      [ -e "$existing" ] || continue
      suffix="${existing#"$TARGET"}"
      mv "$existing" "$SAFETY$suffix"
      chmod 600 "$SAFETY$suffix"
    done
    echo "previous target and any SQLite sidecars kept at $SAFETY*"
  fi
  mv "$STAGED" "$TARGET"
  chmod 600 "$TARGET"
  validate_bot_database "$TARGET" "restored database"
  echo "restored $TARGET from $BACKUP"
  exit 0
fi

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for --container" >&2
  exit 1
}
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "false" ] || {
  echo "refusing to restore unless the explicitly named backend container exists and is stopped" >&2
  exit 1
}
image="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
backup_path="$(cd "$(dirname "$BACKUP")" && pwd -P)/$(basename "$BACKUP")"
case "$backup_path" in
  *,*)
    echo "container restore cannot bind-mount a backup path containing a comma" >&2
    exit 1
    ;;
esac
replace_flag=0
$REPLACE && replace_flag=1

docker run --rm --network none --volumes-from "$CONTAINER" \
  --mount "type=bind,src=$backup_path,dst=/restore/source.db,readonly" \
  --entrypoint sh "$image" -c '
    set -eu
    src=/restore/source.db
    target=/app/data/bot.db
    replace='"$replace_flag"'
    command -v sqlite3 >/dev/null
    [ -f "$src" ]
    [ "$(sqlite3 "$src" "PRAGMA integrity_check;")" = ok ]
    present=0
    for existing in "$target" "${target}-wal" "${target}-shm"; do
      [ ! -e "$existing" ] || present=1
    done
    if [ "$present" = 1 ] && [ "$replace" != 1 ]; then
      echo "refusing to overwrite existing container database without --replace" >&2
      exit 1
    fi
    staged=/app/data/.bot-restore-staged-$$.db
    trap '\''rm -f "$staged"'\'' EXIT HUP INT TERM
    cp "$src" "$staged"
    chmod 600 "$staged"
    [ "$(sqlite3 "$staged" "PRAGMA integrity_check;")" = ok ]
    [ -z "$(sqlite3 "$staged" "PRAGMA foreign_key_check;")" ]
    if [ "$present" = 1 ]; then
      safety="$target.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
      for existing in "$target" "${target}-wal" "${target}-shm"; do
        [ ! -e "$existing" ] || [ ! -e "$safety${existing#"$target"}" ]
      done
      for existing in "$target" "${target}-wal" "${target}-shm"; do
        [ -e "$existing" ] || continue
        destination="$safety${existing#"$target"}"
        mv "$existing" "$destination"
        chmod 600 "$destination"
      done
      echo "previous container database and any SQLite sidecars kept at $safety*"
    fi
    mv "$staged" "$target"
    trap - EXIT HUP INT TERM
  '
echo "restored $BACKUP into stopped container $CONTAINER:/app/data/bot.db"
echo "start the backend; its normal entrypoint will run prisma migrate deploy"
