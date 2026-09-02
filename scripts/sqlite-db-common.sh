#!/usr/bin/env bash

# Shared validation for Bot SQLite backup/restore scripts. This file is sourced;
# callers own `set -euo pipefail` and user-facing error handling.

BOT_REQUIRED_TABLES=(
  _prisma_migrations
  ExchangeAccount
  SignalBot
  SmartTrade
  ManualOrder
  ManualCommand
  ManualNonce
  PartialClose
  StrategyOrderIntent
  WebhookLog
  User
  PushSubscription
  WebhookReceipt
  RefreshToken
  PairCloseMark
  RiskControl
)

require_sqlite3() {
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "sqlite3 is required; refusing an unsafe file-copy fallback" >&2
    return 1
  }
}

validate_bot_database() {
  local database="$1"
  local label="$2"
  local integrity foreign_keys table migration applied

  [ -f "$database" ] || {
    echo "$label is not a regular file: $database" >&2
    return 1
  }

  if ! integrity="$(sqlite3 "$database" 'PRAGMA integrity_check;' 2>&1)" ||
      [ "$integrity" != "ok" ]; then
    echo "$label failed SQLite integrity_check" >&2
    return 1
  fi

  if ! foreign_keys="$(sqlite3 "$database" 'PRAGMA foreign_key_check;' 2>&1)"; then
    echo "$label failed SQLite foreign_key_check" >&2
    return 1
  fi
  if [ -n "$foreign_keys" ]; then
    echo "$label contains foreign-key violations" >&2
    return 1
  fi

  for table in "${BOT_REQUIRED_TABLES[@]}"; do
    if ! sqlite3 "$database" "SELECT 1 FROM \"$table\" LIMIT 0;" >/dev/null 2>&1; then
      echo "$label is missing required current Bot table: $table" >&2
      return 1
    fi
  done

  for migration in backend/prisma/migrations/*; do
    [ -d "$migration" ] || continue
    migration="${migration##*/}"
    case "$migration" in
      *[!0-9A-Za-z_-]*)
        echo "unsafe migration name in repository: $migration" >&2
        return 1
        ;;
    esac
    applied="$(sqlite3 "$database" "SELECT COUNT(*) FROM \"_prisma_migrations\" WHERE migration_name = '$migration' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;" 2>&1)" || {
      echo "$label migration history is unreadable" >&2
      return 1
    }
    if [ "$applied" != "1" ]; then
      echo "$label is not compatible with this checkout; migration is not applied: $migration" >&2
      return 1
    fi
  done

  echo "$label: integrity ok; foreign keys ok; current Bot schema present"
}
