#!/usr/bin/env bash
# Paired Bot release/rollback discipline: read/report only. Never mutates Git
# history, never touches a database beyond read-only queries this script
# itself opens, never starts/stops production.
#
# Usage:
#   scripts/release.sh identity
#   scripts/release.sh gate [--peer-platform-root <path>]
#   scripts/release.sh rollback-check --since <git-ref> [--database <sqlite-file>]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
BACKEND="backend"
MIGRATIONS_DIR="$BACKEND/prisma/migrations"
CONTRACT_DIR="$BACKEND/src/contract"

sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

migration_dirs() { find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort; }
migration_set_sha256() { migration_dirs | tr '\n' ',' | sha256_text; }

realization_contract_version() {
  grep -m1 'REALIZATION_CONTRACT_VERSION *=' "$CONTRACT_DIR/realizationEventContract.ts" | grep -oE '[0-9]+' | head -1
}
webhook_contract_version() {
  grep -m1 '^export const CONTRACT_VERSION' "$CONTRACT_DIR/webhookContract.ts" | grep -oE '[0-9]+' | head -1
}
webhook_contract_fingerprint() {
  grep -m1 'sha256:v' "$CONTRACT_DIR/webhookContract.ts" | sed -E 's/.*"(sha256:v[^"]+)".*/\1/'
}

print_identity() {
  echo "bot_commit=$(git rev-parse HEAD)"
  if [ -z "$(git status --short)" ]; then echo "bot_worktree=clean"; else echo "bot_worktree=dirty"; fi
  echo "bot_migration_head=$(migration_dirs | tail -1)"
  echo "bot_migration_count=$(migration_dirs | wc -l | tr -d ' ')"
  echo "bot_migration_set_sha256=$(migration_set_sha256)"
  echo "bot_realization_contract_version=$(realization_contract_version)"
  echo "bot_webhook_contract_version=$(webhook_contract_version)"
  echo "bot_webhook_contract_fingerprint=$(webhook_contract_fingerprint)"
  echo "bot_node_version=$(node --version 2>/dev/null || echo unavailable)"
}

cmd="${1:-}"
[ -n "$cmd" ] || { echo "usage: $0 identity|gate|rollback-check ..." >&2; exit 2; }
shift

case "$cmd" in
  identity)
    print_identity
    ;;

  gate)
    PEER_PLATFORM_ROOT=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --peer-platform-root) PEER_PLATFORM_ROOT="$2"; shift 2 ;;
        *) echo "gate: unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    fail=0
    echo "=== identity ==="
    print_identity
    echo "=== worktree ==="
    if [ -z "$(git status --short)" ]; then
      echo "clean"
    else
      echo "FAIL: worktree is not clean" >&2
      git status --short >&2
      fail=1
    fi
    echo "=== runtime/dependency availability ==="
    for tool in node npm sqlite3; do
      if command -v "$tool" >/dev/null 2>&1; then
        echo "$tool: $(command -v "$tool")"
      else
        echo "FAIL: required tool not found: $tool" >&2
        fail=1
      fi
    done
    [ -d "$BACKEND/node_modules" ] || { echo "FAIL: $BACKEND/node_modules missing; run npm ci" >&2; fail=1; }
    echo "=== cross-repo contract identity ==="
    if [ -n "$PEER_PLATFORM_ROOT" ]; then
      for f in webhookContract.ts realizationEventContract.ts; do
        if diff -q "$CONTRACT_DIR/$f" "$PEER_PLATFORM_ROOT/backend/src/contract/$f" >/dev/null 2>&1; then
          echo "$f: identical to $PEER_PLATFORM_ROOT"
        else
          echo "FAIL: $f differs from $PEER_PLATFORM_ROOT/backend/src/contract/$f" >&2
          fail=1
        fi
      done
    else
      echo "skipped (no --peer-platform-root given)"
    fi
    echo "=== focused typecheck ==="
    if ! (cd "$BACKEND" && npm run --silent typecheck); then
      echo "FAIL: typecheck" >&2
      fail=1
    fi
    echo "=== focused realization tests ==="
    test_files=("tests/strategyIntentMigration.test.ts" "tests/spotExecutionReliability.test.ts" "tests/backupRestore.test.ts")
    if ! (cd "$BACKEND" && node --env-file=tests/test.env --import tsx --test "${test_files[@]}"); then
      echo "FAIL: focused realization tests" >&2
      fail=1
    fi
    if [ -n "$PEER_PLATFORM_ROOT" ]; then
      echo "=== cross-repository loopback test (run from Platform) ==="
      echo "run: (cd '$PEER_PLATFORM_ROOT/backend' && TRADING_SCENE_BOT_ROOT='$PWD' node --env-file=tests/test.env --import tsx --test tests/crossRepositoryRealization.test.ts)"
    fi
    echo "=== gate result ==="
    if [ "$fail" -eq 0 ]; then echo "PASS"; else echo "FAIL"; exit 1; fi
    ;;

  rollback-check)
    SINCE=""
    DB_ARG=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --since) SINCE="$2"; shift 2 ;;
        --database) DB_ARG="$2"; shift 2 ;;
        *) echo "rollback-check: unknown argument: $1" >&2; exit 2 ;;
      esac
    done
    [ -n "$SINCE" ] || { echo "usage: $0 rollback-check --since <git-ref> [--database <sqlite-file>]" >&2; exit 2; }

    BASELINE_DIRS="$(git ls-tree -r --name-only "$SINCE" -- "$MIGRATIONS_DIR" 2>/dev/null | grep 'migration\.sql$' | xargs -n1 dirname 2>/dev/null | xargs -n1 basename 2>/dev/null | sort || true)"
    CURRENT_DIRS="$(migration_dirs)"
    NEW_DIRS="$(comm -13 <(printf '%s\n' "$BASELINE_DIRS") <(printf '%s\n' "$CURRENT_DIRS"))"

    echo "=== rollback-check: Bot current state -> code at $SINCE ==="
    schema_verdict=BACKWARD_COMPATIBLE
    if [ -z "$NEW_DIRS" ]; then
      echo "no migrations were added since $SINCE"
    else
      echo "migrations introduced since $SINCE:"
      echo "$NEW_DIRS" | sed 's/^/  /'
      while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        path="$MIGRATIONS_DIR/$dir/migration.sql"
        [ -f "$path" ] || { echo "UNKNOWN: migration file missing on disk: $dir" >&2; schema_verdict=UNKNOWN; continue; }
        if grep -qiE 'drop +table|drop +column|alter +table.*rename|rename +column' "$path"; then
          echo "ROLLBACK_INCOMPATIBLE: $dir contains a structural/destructive statement" >&2
          schema_verdict=ROLLBACK_INCOMPATIBLE
        fi
        if grep -iE 'add +column' "$path" | grep -qiE 'not +null' && \
           ! grep -iE 'add +column' "$path" | grep -qiE 'default'; then
          echo "ROLLBACK_INCOMPATIBLE: $dir adds a NOT NULL column without a default" >&2
          schema_verdict=ROLLBACK_INCOMPATIBLE
        fi
      done <<< "$NEW_DIRS"
    fi
    echo "schema classification=$schema_verdict"

    outbox_verdict=BACKWARD_COMPATIBLE
    if [ -n "$DB_ARG" ]; then
      echo "=== pending realization outbox evidence ==="
      [ -f "$DB_ARG" ] || { echo "UNKNOWN: database file not found: $DB_ARG" >&2; outbox_verdict=UNKNOWN; }
      if [ "$outbox_verdict" != "UNKNOWN" ]; then
        if ! table_exists="$(sqlite3 "$DB_ARG" "SELECT name FROM sqlite_master WHERE type='table' AND name='RealizationEvent';" 2>&1)"; then
          echo "UNKNOWN: could not query $DB_ARG: $table_exists" >&2
          outbox_verdict=UNKNOWN
        elif [ -z "$table_exists" ]; then
          echo "RealizationEvent table not present (database predates the current pair; nothing to strand)"
        else
          counts="$(sqlite3 "$DB_ARG" "SELECT deliveryStatus, COUNT(*) FROM RealizationEvent GROUP BY deliveryStatus;" 2>&1)" || {
            echo "UNKNOWN: could not read RealizationEvent: $counts" >&2
            outbox_verdict=UNKNOWN
          }
          echo "delivery status counts:"
          echo "${counts:-<none>}" | sed 's/^/  /'
          pending="$(sqlite3 "$DB_ARG" "SELECT COUNT(*) FROM RealizationEvent WHERE deliveryStatus NOT IN ('delivered');" 2>/dev/null || echo unknown)"
          if [ "$pending" = "unknown" ]; then
            outbox_verdict=UNKNOWN
          elif [ "$pending" -gt 0 ]; then
            echo "$pending event(s) are not yet delivered" >&2
            outbox_verdict=ROLLBACK_INCOMPATIBLE
          fi
        fi
      fi
    else
      echo "(no --database given; cannot assess pending realization outbox state)"
      outbox_verdict=UNKNOWN
    fi
    echo "pending-outbox classification=$outbox_verdict"

    verdict=BACKWARD_COMPATIBLE
    for v in "$schema_verdict" "$outbox_verdict"; do
      case "$v" in
        ROLLBACK_INCOMPATIBLE) verdict=ROLLBACK_INCOMPATIBLE ;;
        UNKNOWN) [ "$verdict" = "BACKWARD_COMPATIBLE" ] && verdict=UNKNOWN ;;
      esac
    done

    echo "classification=$verdict"
    case "$verdict" in
      BACKWARD_COMPATIBLE)
        echo "next_step=Old Bot code may be started directly against this database. No restore required. It will not deliver any future realization event (matches the accepted OLD BOT + NEW PLATFORM state), but nothing pending is stranded."
        exit 0
        ;;
      ROLLBACK_INCOMPATIBLE)
        echo "next_step=Do not roll back Bot code yet. Either (a) wait for deliverPendingRealizations to drain to zero pending/integrity_error rows and re-run this check, or (b) restore Platform+Bot to the pre-release backups instead of a code-only rollback." >&2
        exit 1
        ;;
      *)
        echo "next_step=Insufficient evidence to classify. Pass --database <sqlite-file> and re-run before rolling back." >&2
        exit 1
        ;;
    esac
    ;;

  *)
    echo "usage: $0 identity|gate|rollback-check ..." >&2
    exit 2
    ;;
esac
