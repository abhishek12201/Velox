#!/usr/bin/env bash
# HUMAN ONLY. bash plan/tools/lock.sh [--hard | --unlock | --unlock-hard]
# Locks AGENTS.md, opencode.json, plan/, .githooks/ : read-only + hash stored outside the repo (+ optional OS immutability).
set -euo pipefail
cd "$(dirname "$0")/../.."
HASHFILE="${VELOX_HASH_FILE:-$HOME/.velox_plan_hash}"
ITEMS=(AGENTS.md opencode.json plan .githooks)
mode="${1:-}"

unlock() {
  if [[ "$mode" == "--unlock-hard" ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then sudo chflags -R noschg "${ITEMS[@]}" "$HASHFILE" 2>/dev/null || true
    else sudo chattr -R -i "${ITEMS[@]}" "$HASHFILE" 2>/dev/null || true; fi
    sudo chown -R "$(id -un)" "${ITEMS[@]}" "$HASHFILE" 2>/dev/null || true
  fi
  chmod -R u+w "${ITEMS[@]}" 2>/dev/null || true
  rm -f "$HASHFILE"
  echo "UNLOCKED. Edit the plan, then run lock.sh again."
}
if [[ "$mode" == --unlock* ]]; then unlock; exit 0; fi

[[ -f .gitignore ]] || { echo "need .gitignore first"; exit 1; }
git rev-parse --git-dir >/dev/null 2>&1 || git init -q
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit plan/tools/*.sh
[[ -f LICENSE ]] || echo "WARN: LICENSE missing (add it before P0; P0 checks for it)"

rm -f "$HASHFILE"
HASH="$(bash plan/tools/verify.sh --print)"
( umask 077; printf '%s' "$HASH" > "$HASHFILE" ); chmod 444 "$HASHFILE"
chmod -R a-w "${ITEMS[@]}"

if [[ "$mode" == "--hard" ]]; then
  sudo chown -R root "${ITEMS[@]}" "$HASHFILE"
  if [[ "$(uname)" == "Darwin" ]]; then sudo chflags -R schg "${ITEMS[@]}" "$HASHFILE"
  else sudo chattr -R +i "${ITEMS[@]}" "$HASHFILE"; fi
  echo "HARD lock applied (root-owned + immutable). Undo with: bash plan/tools/lock.sh --unlock-hard"
fi

git add -A
git diff --cached --quiet || git commit -qm "Add locked plan (Velox)"
git tag -f plan-lock >/dev/null
echo "LOCKED. hash=$HASH"
echo "Independent check (no trust in these scripts):"
echo "  find AGENTS.md opencode.json plan .githooks -type f ! -name .DS_Store | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1   # must equal: cat $HASHFILE"
echo "Also: git diff --stat plan-lock -- AGENTS.md opencode.json plan .githooks   # must be empty"
