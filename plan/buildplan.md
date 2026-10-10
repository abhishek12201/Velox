# Velox · build plan (human-facing; opencode never reads this file)

## Architecture
```
[Velox Console (React): chat, cards, carousel, trace, memory chips, demo controls]
        | SSE                         ^ proactive nudges
   [Agent API :7100]  <-- Bedrock Converse (Claude) | mock scenarios
     loop + internal tools (show_options, propose_itinerary) + saga + scheduler + virtual clock
        | MCP client x4 (Streamable HTTP, spec 2025-11-25)
  [air :7101] [stay :7102] [local :7103] [vault :7104]      veloxcheck = conformance CLI over all four
```
Safety by construction: the LLM can search and HOLD. Only the human's Confirm click mints per-hold HMAC tokens, and only the saga calls confirm/cancel tools.

## Phases (one prompt per opencode session)
| P | What | Model | Target day |
|---|---|---|---|
| 0 | Scaffold, SDK protocol check | cheap | Oct 8-9 |
| 1 | Core types, clock, token, seed data | cheap | Oct 9 |
| 2 | MCP kit + air server | strong | Oct 10 |
| 3 | stay + local servers | cheap | Oct 10 |
| 4 | vault server + veloxcheck | cheap | Oct 10-11 |
| 5 | Agent core: loop, registry, mock LLM, SSE API | strong | Oct 11 |
| 6 | Bedrock provider + live smoke (needs AWS creds) | strong | Oct 11-12 |
| 7 | Budget solver, saga, chaos, expiry | strong | Oct 12-13 |
| 8 | Memory across sessions | cheap | Oct 13 |
| 9 | Clock, scheduler, rain nudge, swap | strong | Oct 13-14 |
| 10 | Console UI v1 | strong | Oct 14-15 |
| 11 | Console voice, polish, `npm run demo`, demo script | cheap | Oct 16 |
| 12 | AWS depth (optional; cut first) | strong | Oct 17 |
| 13 | Submission pack | cheap | Oct 19-20 |
Oct 18 23:59 IST = feature freeze (gate.sh refuses P0-P12 after). Oct 19: office hours 9:00 PT (21:30 IST). Oct 20: record video, finish feedback. **Oct 21: submit.** Oct 22: buffer only.

## Cut line (when behind, drop in this order)
1. P12 (AgentCore) 2. P9 weather nudge polish (keep the clock + one nudge) 3. voice I/O in P11 4. S7 expiry recovery polish 5. extra seed variety.
Never cut: P0-P8, P10, S1-S5 passing, veloxcheck, trace drawer, friction log, README, video.

## Human pre-flight (before P0)
- [ ] Request AWS credits now: form linked on the hackathon Resources page (closes Oct 21 12:00 PT).
- [ ] AWS account: enable Claude model access in Bedrock (your region), create an IAM user/role with Bedrock invoke only, run `aws configure`. Note the exact model/inference-profile ID; put in local `.env` as `VELOX_MODEL_ID`. Never commit.
- [ ] Node >=22, git, an empty GitHub repo (public). Put this folder in it.
- [ ] Add `LICENSE` (Apache-2.0 text from choosealicense.com; change plan if you prefer MIT before locking).
- [ ] Re-read the live Rules page; if anything differs from `plan/context.md`, edit the plan BEFORE locking.
- [ ] Lock: `bash plan/tools/lock.sh` (soft) or `bash plan/tools/lock.sh --hard` (root-owned + immutable; best, since opencode runs as you). Run opencode as your normal user, never root.
- [ ] Verify opencode really enforces `opencode.json` (check its permission docs; syntax can change). The hash + hook + OS lock still protect you if it doesn't.
- [ ] Optional: `cp ~/.velox_plan_hash` somewhere safe (phone note). It is the ground truth.

## Human loop for every prompt
1. New opencode session (fresh context is the biggest token saver). 2. Type exactly `Run P<N>`. 3. Read the 12-line report. 4. Run its Verify commands. 5. Optional: paste report to Claude for review. 6. `git push` yourself. 7. Failed or looping? `git reset --hard p<N-1>` and rerun.
Use the `Model:` tag in each prompt: cheap model for mechanical prompts, strong model where the prompt says strong.
If the report says FAIL for the same reason twice, stop; review the prompt and spec instead of paying for a third try.

## Token playbook (why this plan is cheap)
- AGENTS.md is ~600 tokens and is the only always-loaded file. Each run adds one ~400-token prompt file + STATE.md + cited spec sections.
- Gate/done/invariants are shell scripts: zero LLM tokens, tamper-proof.
- Seed data comes from generators; tool results shown to the Velox LLM are compacted (also cuts Bedrock cost at demo time).
- Mock LLM makes tests and UI work free; Bedrock only for P6, the live smoke, and the demo recording.

## Submission checklist (P13 produces most of it)
- [ ] Public repo + LICENSE + README with setup, architecture, tracks, credits, "synthetic data" notice
- [ ] `docs/DEVPOST.md` fields pasted into Devpost: description, track = Alexa+, mini challenges = AWS Builder + Open Source
- [ ] Demo video <3:00, public, English, no trademarks/copyrighted music; link on the form
- [ ] Product feedback for every tool/SDK used (Bedrock, MCP TS SDK, any AgentCore); AWS usage described inside it
- [ ] Open Source fields: contribution URL (veloxcheck repo), repo URL, GitHub username, description
- [ ] Friction log + feature requests from FRICTION.md (bonus up to 10%)
- [ ] If the project existed before: n/a (new project)
- [ ] Rules page re-checked Oct 20; submitted by Oct 21

## Publish veloxcheck as its own repo (human, at P13)
`git subtree split -P packages/veloxcheck -b veloxcheck-only` then push that branch to a new public repo's `main`. Confirm its LICENSE and README are present. Submit that URL as the Open Source contribution.

## Risks
| Risk | Mitigation |
|---|---|
| SDK lacks protocol 2025-11-25 | P0 detects it and stops; decide before building |
| Bedrock tool-use surprises late | P6 runs early on Oct 11-12 |
| Live LLM wanders / blows budget | Code-side guards (propose_itinerary, MAX_STEPS, token caps); mock scenarios for tests |
| UI eats the schedule | P10 spec is fixed; polish only in P11 |
| Plan tampered by an AI | Hash outside repo + hook + read-only + opencode deny + optional immutable |
