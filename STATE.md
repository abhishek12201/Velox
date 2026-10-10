# STATE (opencode keeps this <=40 lines; replace stale lines, no history)
done: P2
next: none
license: Apache-2.0 (file added by human)
llm_default: mock
sdk_protocol_2025-11-25: 2025-11-25
sdk_version: 1.32.1
avg_tokens_per_canned_prompt: unknown
decisions:
- Stateful Streamable HTTP sessions are initialized by a POST /mcp initialize call, then reused by session ID.
- Holds expire lazily in SQLite; foreign-origin and host checks are enforced at the Express boundary.
- Server chaos uses a SQLite-backed hold store and per-server isolated data dirs for clean tests.
open_issues:
