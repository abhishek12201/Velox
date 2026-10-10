# STATE (opencode keeps this <=40 lines; replace stale lines, no history)
done: P3
next: none
license: Apache-2.0 (file added by human)
llm_default: mock
sdk_protocol_2025-11-25: 2025-11-25
sdk_version: 1.32.1
avg_tokens_per_canned_prompt: unknown
decisions:
- Stateful Streamable HTTP sessions are initialized by a POST /mcp initialize call, then reused by session ID.
- Holds expire lazily in SQLite; foreign-origin and host checks are enforced at the Express boundary.
- Each capability server uses its own SQLite hold store; tests use fresh in-memory databases and fixed as_of values.
- Air, stay, and local server ports can be set independently with AIR_PORT, STAY_PORT, and LOCAL_PORT.
open_issues:
