#!/usr/bin/env bash
# Verifies locked files against the hash stored OUTSIDE the repo. `--print` prints the current hash.
set -euo pipefail
cd "$(dirname "$0")/../.."
HASHFILE="${VELOX_HASH_FILE:-$HOME/.velox_plan_hash}"
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
hash_now() {
  find AGENTS.md opencode.json plan .githooks -type f ! -name .DS_Store 2>/dev/null | LC_ALL=C sort |
  while IFS= read -r f; do printf '%s  %s\n' "$(sha < "$f" | cut -d' ' -f1)" "$f"; done |
  sha | cut -d' ' -f1
}
if [[ "${1:-}" == "--print" ]]; then hash_now; exit 0; fi
[[ -f "$HASHFILE" ]] || { echo "LOCK FAIL: $HASHFILE missing. Human must run: bash plan/tools/lock.sh"; exit 1; }
if [[ "$(hash_now)" == "$(cat "$HASHFILE")" ]]; then echo "LOCK OK"; else
  echo "LOCK FAIL: AGENTS.md / opencode.json / plan / .githooks changed. STOP and tell the human."; exit 1; fi
