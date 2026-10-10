#!/usr/bin/env bash
# Cheap repo-wide invariants. One PASS/FAIL/SKIP line each. Non-zero exit on any FAIL.
cd "$(dirname "$0")/../.."
fail=0
ok(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }; skip(){ echo "SKIP $1"; }
has_tag(){ git rev-parse -q --verify "refs/tags/$1" >/dev/null; }
SRC=(); [[ -d packages ]] && SRC=(packages)

[[ -f LICENSE ]] && ok "LICENSE present" || bad "LICENSE missing (human adds before P0)"
git ls-files --error-unmatch .env >/dev/null 2>&1 && bad ".env is tracked" || ok ".env not tracked"
if git ls-files -z | xargs -0 grep -IlE 'AKIA[0-9A-Z]{16}|aws_secret_access_key|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null | grep -v '^plan/' | grep -q .; then bad "secret-like string tracked"; else ok "no secret-like strings"; fi
if git ls-files | grep -iE '(alexa|amazon|aws|echo|ring|fire)[-_ ]?(logo|icon|brand|mark)' | grep -q .; then bad "third-party logo asset tracked"; else ok "no brand assets"; fi
if git log --since="2026-10-23T18:00:00Z" --oneline 2>/dev/null | grep -q .; then bad "commit after our deadline"; else ok "no late commits"; fi
if (( ${#SRC[@]} )); then
  if grep -rEl --include=*.ts --include=*.tsx --include=*.mjs --exclude-dir=node_modules --exclude-dir=dist 'anthropic\.claude|amazon\.nova|(us|eu|apac|global)\.anthropic' packages 2>/dev/null | grep -q .; then bad "hardcoded model id in packages/"; else ok "no hardcoded model ids"; fi
  if [[ -d packages/veloxcheck/src ]]; then
    if grep -rEq '@velox/' packages/veloxcheck/src packages/veloxcheck/package.json 2>/dev/null; then bad "veloxcheck imports another @velox package (must stay standalone)"; else ok "veloxcheck standalone"; fi
  fi
else skip "package checks (no packages/ yet)"; fi
if has_tag p2; then
  grep -rq --include=*.ts --exclude-dir=node_modules '2025-11-25' packages/servers packages/veloxcheck 2>/dev/null && ok "spec 2025-11-25 referenced in code" || bad "2025-11-25 not referenced in servers/veloxcheck code"
else skip "protocol-version hook (before p2)"; fi
exit $fail
