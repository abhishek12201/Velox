#!/usr/bin/env bash
# End-of-prompt: lock check -> invariants -> npm run check -> commit -> tag. Prints compact verdict lines.
set -uo pipefail
cd "$(dirname "$0")/../.."
[[ "${1:-}" =~ ^P([0-9]+)$ ]] || { echo "usage: done.sh P<N> \"msg\""; exit 1; }
P="$1"; N="${BASH_REMATCH[1]}"; MSG="${2:-$P}"
bash plan/tools/verify.sh || exit 1
bash plan/tools/invariants.sh || { echo "DONE $P FAIL (invariants)"; exit 1; }
[[ -f package.json ]] || { echo "DONE $P FAIL (no package.json)"; exit 1; }
mkdir -p .velox
if npm run check --silent > .velox/check.log 2>&1; then echo "PASS npm run check"; else
  tail -n 25 .velox/check.log; echo "DONE $P FAIL (npm run check)"; exit 1; fi
git add -A
git commit -qm "$P: $MSG" || { echo "DONE $P FAIL (commit)"; exit 1; }
git tag "p$N"
echo "DONE $P PASS tag=p$N"
