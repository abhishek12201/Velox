# STATE (opencode keeps this <=40 lines; replace stale lines, no history)
done: P8
next: none
license: Apache-2.0 (file added by human)
llm_default: mock
sdk_protocol_2025-11-25: 2025-11-25
sdk_version: 1.32.1
avg_tokens_per_canned_prompt: unknown (live smoke skipped: AccessDeniedException; AWS account verification)
decisions:
- Agent uses per-instance Streamable HTTP clients and session-local offers, holds, plans, and messages.
- MCP URLs and the API port use VELOX_URL_* and VELOX_PORT_AGENT with local defaults.
- Tool calls always inject the session as_of; results are compacted for the provider while full records remain in the ledger.
- App-only MCP tools are marked and excluded from the provider tool list.
- Agent tests use isolated database files, ephemeral ports, fixed as_of values, and close all clients and listeners.
- Air, stay, local, and vault server ports are independently configurable with VELOX_PORT_AIR, VELOX_PORT_STAY, VELOX_PORT_LOCAL, and VELOX_PORT_VAULT.
- Vault stores stated/inferred profile preferences and saved trips in its own SQLite database; veloxcheck is an independent MCP SDK CLI.
- Bedrock Converse uses VELOX_MODEL_ID, AWS_REGION, explicit bearer-token auth when configured, and bounded output/retry limits.
- Mock itineraries use next-Friday-to-Sunday dates, round-trip air holds, a two-night stay, food, and activity.
- Budget replanning releases comfort holds before switching to a cheaper feasible itinerary.
- Confirmation uses allSettled, signed per-hold tokens, compensation, up to two recoveries, and vault persistence.
- Expired holds are reacquired for the same offers before alternative replanning.
- Vault profile context is refreshed each model turn and byte-capped below 300 tokens.
- Stated and inferred preferences retain their evidence; remembered flight limits emit a chip.
- Same-trip mock memory loads the profile and latest trip, scales party size and budget, and honors departure limits.
- seed:demo creates synthetic history; reset clears workspace and configured data directories.
open_issues:
