#!/usr/bin/env bash
# Start-of-prompt gate. Prints one `GO` line or the reason to stop.
set -uo pipefail
cd "$(dirname "$0")/../.."
FREEZE="2026-10-18T18:29:00Z"    # Oct 18 23:59 IST: feature prompts (P0-P12) end here
DEADLINE="2026-10-23T18:00:00Z"  # official close is 19:00Z (12:00 PT); we stop 1h earlier
[[ "${1:-}" =~ ^P([0-9]+)$ ]] || { echo "usage: gate.sh P<N>"; exit 1; }
N="${BASH_REMATCH[1]}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
bash plan/tools/verify.sh || exit 1
[[ "$NOW" > "$DEADLINE" ]] && { echo "CLOSED: past $DEADLINE. Do not commit. Tell the human."; exit 1; }
if (( N <= 12 )) && [[ "$NOW" > "$FREEZE" ]]; then echo "FREEZE: past $FREEZE; only P13 may run. Tell the human."; exit 1; fi
[[ -f "plan/prompts/P$N.md" ]] || { echo "no such prompt P$N"; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "DIRTY tree: human must commit or stash first"; exit 1; }
git rev-parse -q --verify "refs/tags/p$N" >/dev/null && { echo "p$N already exists; P$N is done"; exit 1; }
if (( N == 0 )); then req="plan-lock"; elif (( N == 13 )); then req="p11"; else req="p$((N-1))"; fi
git rev-parse -q --verify "refs/tags/$req" >/dev/null || { echo "MISSING prerequisite tag $req"; exit 1; }
echo "GO P$N | now=$NOW | read plan/prompts/P$N.md and STATE.md"
