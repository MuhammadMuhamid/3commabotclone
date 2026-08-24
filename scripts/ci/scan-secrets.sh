#!/usr/bin/env bash
# Value-free secret scan over tracked source.
#
# It never prints a matched value — only the file and line — so a real finding
# does not leak the credential into a CI log.
#
# This repository is the one that holds exchange credentials at runtime. No
# credential value belongs in tracked source at any time: the webhook secret,
# the Binance API key/secret, the JWT secret, the encryption key and the VAPID
# private key all live in the untracked .env.
set -uo pipefail
cd "$(dirname "$0")/../.."

fail=0
report() { echo "::error file=$1,line=$2::$3"; fail=1; }

is_allowed() {
  case "$1" in
    */package-lock.json|package-lock.json) return 0 ;;   # npm integrity hashes
    # CONTRACT_FINGERPRINT is a sha256 digest of this file's own source, used to
    # detect drift between the two repositories' vendored copies. The module is
    # import-free and holds no configuration.
    */contract/webhookContract.ts) return 0 ;;
    *.png|*.jpg|*.jpeg|*.pdf|*.zip|*.gz) return 0 ;;
  esac
  return 1
}

scan() {
  local pattern="$1" message="$2"
  while IFS=: read -r file line _; do
    [ -z "${file:-}" ] && continue
    is_allowed "$file" && continue
    report "$file" "$line" "$message"
  done < <(git grep -InE "$pattern" -- \
      ':!*.png' ':!*.jpg' ':!*.jpeg' ':!*.pdf' ':!*.zip' 2>/dev/null || true)
}

# `git grep -E` is POSIX ERE: it has no \b, so boundaries are spelled out.
scan '[0-9a-f]{40,}' 'credential-shaped hex literal in tracked source'
scan 'AKIA[0-9A-Z]{16}' 'AWS access key id in tracked source'
scan 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' 'private key material in tracked source'
scan 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' 'JWT literal in tracked source'
scan 'curl[^|]*\|[[:space:]]*(sudo[[:space:]]+)?(ba)?sh' 'remote script piped into a shell'

if [ "$fail" -ne 0 ]; then
  echo "secret scan failed — see the annotations above (values are never printed)" >&2
  exit 1
fi
echo "secret scan clean"
