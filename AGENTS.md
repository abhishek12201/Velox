# Velox · agent rules
LOCKED FILES (never edit, move, chmod, delete): AGENTS.md, opencode.json, plan/**, .githooks/**
Velox = Alexa+-style trip autopilot: 4 MCP servers + Bedrock orchestrator + web console. Hard hackathon deadline. Contracts live in plan/spec.md.

## Protocol (exact)
1. Human says "Run P<N>". First command: `bash plan/tools/gate.sh P<N>`. No `GO` line -> stop and show its output.
2. Read ONLY: plan/prompts/P<N>.md, STATE.md, and the plan sections/files that prompt names. Nothing else under plan/. Never read node_modules, lockfiles, dist, data/.
3. Build exactly what the prompt says. No extra features, docs, files, refactors, or "improvements".
4. Finish with `bash plan/tools/done.sh P<N> "<short commit msg>"` (checks, commits, tags). If it fails: fix, rerun. Never bypass it.
5. Update STATE.md (keep <=40 lines; replace, don't append history). Append to FRICTION.md only for real tool/doc friction you hit, plus one feedback line per new tool/SDK used.
6. Print the report below and STOP. Never start another prompt.

## Report (<=12 lines, nothing else)
P<N> PASS|FAIL tag p<N>
Built: <=3 lines
Accept: one line per check -> result
Deviations: none | list
Verify: 1-3 copy-paste commands
Know-it: 2 questions the human must be able to answer

## Token discipline
- Quiet output: `npm i --silent`, `vitest run --reporter=dot`, pipe unknown-length output through `| tail -n 25`.
- Never `cat` a file >150 lines: `rg -n` then `sed -n 'a,bp'`.
- Don't re-read files you just wrote. Don't re-run checks that already passed.
- Write several files per tool call. Generate data with scripts, never hand-typed JSON.
- No narration while working. No summaries beyond the report.
- Check library APIs in node_modules/<pkg> (README, .d.ts) via `rg`, not memory. If the real API differs from the spec -> stop and report.
- Boring code: small functions, no abstraction until used 3 times.

## Hard rules
- No secrets or .env in git. No hardcoded model IDs, regions, keys, ports (env only; see .env.example).
- Never give the LLM any tool whose `_meta["velox/audience"]` is "app" (confirm_*, cancel_booking, save_trip). Only the /api/confirm saga calls them.
- Synthetic data only, labelled synthetic in UI and docs. No real brand names, logos, Amazon/Alexa marks, third-party images or music.
- Never `git push`, `--no-verify`, `git config`, delete tags, or rewrite history.
- Ambiguity or spec conflict -> stop and ask. Do not invent.
