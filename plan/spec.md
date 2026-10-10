# Velox · spec (contracts; prompts cite sections by number)

## 1 Stack and layout
Node >=22, TypeScript strict, ESM, npm workspaces, Express 5, zod, vitest, tsx, better-sqlite3, Vite+React+TS (plain CSS, no UI/CSS framework).
```
packages/core/       zod types, money, virtual clock, confirm token, seed generators
packages/servers/    src/kit/ (serve, store, errors) + air/ stay/ local/ vault/ ; run: tsx src/main.ts <air|stay|local|vault>
packages/agent/      llm/{types,mock,bedrock}.ts, mcp/registry.ts, loop.ts, internal.ts, saga.ts, scheduler.ts, prompt.ts, api.ts
packages/web/        Velox Console
packages/veloxcheck/ standalone CLI; imports NOTHING from @velox/*; own LICENSE + README
tests/e2e/           scenario tests (mock LLM, servers in-process on random ports)
scripts/             sdk-check.mjs, seed-demo.ts, live-smoke.ts, reset.ts, gen-tools-doc.ts
docs/                DEMO_SCRIPT.md DEVPOST.md VIDEO_SCRIPT.md QNA.md (P11-P13)
```
Root scripts: `check` (tsc typecheck + `vitest run --reporter=dot`), `dev:all`, `demo`, `reset`, `seed:demo`.

## 2 Env and ports (.env.example mirrors this)
`VELOX_LLM=mock|bedrock` (default mock) · `AWS_REGION` · `VELOX_MODEL_ID` (no default; required for bedrock) · `VELOX_MAX_TOKENS=1500` · `VELOX_MAX_STEPS=12` · `VELOX_CONFIRM_SECRET` (dev default allowed only if NODE_ENV!=production) · `VELOX_HOLD_TTL_SEC=600` · `VELOX_DATA_DIR=./data`
Ports: agent 7100 · air 7101 · stay 7102 · local 7103 · vault 7104 · web 5173. Servers bind 127.0.0.1 and reject non-local Origin/Host headers (MCP security guidance). Tests override ports with 0/random.

## 3 Domain (zod schemas in core). Money = integer INR. Dates ISO. All data synthetic; fictional names only.
- FlightOffer {id, kind:"flight", from, to, depart, arrive, carrier, flight_no, price_per_pax, stops:0}
- StayOffer {id, kind:"stay", name, area:"north"|"south"|"central", price_per_night, rating, tags[]}
- PlaceOffer {id, kind:"food"|"activity", name, area, price_per_head, tags[], outdoor:boolean}
- Hold {hold_id, server, offer_id, amount, qty, expires_at, state:"held"|"confirmed"|"released"|"expired"|"cancelled"}
- Plan {plan_id, session_id, kind:"trip"|"swap", hold_ids[], total, budget, created}
- Card = Carousel {id,title,items:[{id,title,subtitle,price,badges[],offer_id}],speech}
       | Itinerary {plan_id,title,days:[{label,items:[{time?,title,kind,amount,hold_id,status}]}],total,budget,remaining,expires_at,status:"proposed"|"confirmed"|"failed"|"rolled_back",speech}
       | Nudge {id,text,action_label,plan_id?,speech}
- Error result (isError:true, structuredContent): {code:"NOT_FOUND"|"SOLD_OUT"|"HOLD_EXPIRED"|"FORBIDDEN"|"INVALID", message, retryable}

## 4 MCP servers and tools (names are server-local; orchestrator namespaces as `<server>__<tool>`)
Every tool: description >=20 chars, zod inputSchema AND outputSchema, structuredContent + JSON text content, annotations (readOnlyHint/destructiveHint/idempotentHint). `_meta["velox/audience"]="app"` marks app-only tools (never shown to the LLM). Hidden arg `as_of` (ISO, injected by orchestrator, stripped from the LLM schema).
| Server | Model-visible tools | App-only tools |
|---|---|---|
| air | `search_flights{origin,destination,date,pax=1,max_price?,depart_after?,depart_before?}` -> <=8 offers asc by price · `hold_flight{offer_id,pax,idem_key?}` · `release_hold{hold_id}` | `confirm_flight{hold_id,token,idem_key}` · `cancel_booking{hold_id}` |
| stay | `search_stays{area?,checkin,checkout,guests=1,max_per_night?,tags?}` · `hold_stay{offer_id,checkin,checkout,guests,idem_key?}` · `release_hold` | `confirm_stay` · `cancel_booking` |
| local | `search_places{area?,kind,max_per_head?,outdoor?,tags?}` · `get_forecast{area,date_from,date_to}` · `hold_table{offer_id,when,party,idem_key?}` (also used for activities) · `release_hold` | `confirm_table` · `cancel_booking` |
| vault | `get_profile{}` · `remember{key,value,source:"stated"|"inferred",evidence}` · `list_trips{limit=5}` | `save_trip{plan_json,title}` |
Airports BLR -> GOX (north, Mopa) and GOI (south, Dabolim), both directions.

## 5 Hold/confirm protocol
States: held -> confirmed | released | expired ; confirmed -> cancelled. Expiry evaluated lazily on read (wall clock, `VELOX_HOLD_TTL_SEC`).
- `confirm_*` requires state held, unexpired, and `token = HMAC_SHA256(VELOX_CONFIRM_SECRET, hold_id + ":" + plan_id)`. Only the `/api/confirm` handler mints tokens (after a human click). Missing/wrong token -> FORBIDDEN.
- `idem_key`: same key returns the original result (holds, confirms). `release_hold` and `cancel_booking` are idempotent.
- Chaos: `POST /admin/chaos {code:"SOLD_OUT", once:true}` on a server makes its next `confirm_*` fail. Agent proxies as `POST /api/chaos {server|null}`.
- Each server persists to SQLite at `$VELOX_DATA_DIR/<server>.db`.

## 6 Orchestrator (packages/agent)
- Registry connects to all 4 servers with the SDK client over Streamable HTTP; LLM tools = every tool without audience "app". Results shown to the LLM are compacted (<=6 offers, only id/name/price/time/area/tags) to save tokens; full objects kept in the session ledger.
- Loop: system prompt (+ compact profile + clock) -> provider.converse -> run all tool calls of a step in parallel -> repeat, max `VELOX_MAX_STEPS`.
- Internal LLM-visible tools: `show_options{title, offer_ids<=5}` -> Carousel card from ledger · `propose_itinerary{title, hold_ids[], budget}` -> validates every hold exists, is held and unexpired, computes total IN CODE; total>budget -> `{ok:false, over_by}`; else creates Plan + Itinerary card. The LLM never states totals; cards carry code-computed numbers.
- Session state (in memory): messages, ledger, plans, last carousel (so "second one" maps to an offer id; pass the mapping in context).
- Saga `POST /api/confirm {session_id, plan_id}`: mint tokens -> `Promise.allSettled` confirm_* -> all ok: `vault.save_trip`, card status confirmed. Any failure: `cancel_booking` for confirmed legs, `release_hold` for the rest, emit `recovery` events, inject "Confirmation failed on <leg>: <code>. Nothing was charged. Re-plan within the same budget without <offer_id>." and rerun the loop (max 2 recoveries). Idempotency key = `${plan_id}:${hold_id}`.
- HTTP (CORS only for http://localhost:5173): `POST /api/chat {session_id,text}` (SSE) · `POST /api/confirm` (SSE) · `GET /api/events?session_id` (SSE, proactive) · `GET|POST /api/clock` · `POST /api/chaos` · `POST /api/reset {scope:"session"|"all"}` · `GET /api/health`.
- SSE events: `say{text,speech?}` `call{id,server,tool,args,ts}` `result{id,ms,ok,summary}` `card{card}` `chip{text}` `recovery{step,detail}` `nudge{card}` `clock{now}` `error{message}` `done{}`.
- LlmProvider: `converse({system,messages,tools,maxTokens}) -> {blocks:(text|tool_use)[], stop, usage}`. `mock` = scenario provider (deterministic scripts chosen by regex on the user text, unknown text -> help message). `bedrock` = AWS Converse API tool use; model and region from env.

## 7 UI contract
Every card has `speech` (<=2 sentences) for text-to-speech. Carousel items numbered 1-5; "second one"/"2" selects. Itinerary shows legs with status icon+text, total vs budget meter, hold countdown, primary "Confirm all (INR total)", secondary "Change plan". Trace drawer lists calls as `server · tool · ms`, expandable JSON, parallel calls grouped. Memory chips appear inline when `remember` runs. A "Demo controls" tray holds: time travel, "Break a booking", "New session", "Reset demo".

## 8 Memory
Vault tables: profile(key,value,source,evidence,updated) and trips(id,title,party,start,end,total,plan_json,created). Profile keys in use: home_airport, avoid_departure_before, diet, pace, typical_budget. Profile (<=300 tokens) is injected into the system prompt. The LLM calls `remember` when the user states a preference or rejects an option with a reason. "Same as last time" = `list_trips` + profile. A new session keeps the vault.

## 9 Clock and proactive
Virtual clock lives in the agent; default = real now; `POST /api/clock {to}` or `{plus_hours}`. Tools receive it as `as_of`. Scheduler `tick()` runs on every clock change and every 30 s wall time. For each confirmed trip starting within 36 h with outdoor activities: `get_forecast`; if rain on such a day and no nudge yet for (trip, day, "weather") -> hold an indoor alternative (bounded loop run) -> push Nudge + a `swap` Plan. Accept = saga (confirm new, cancel old). Forecast is a pure function f(area,date,as_of): the Saturday of a trip planned >=3 days ahead is sunny when as_of is >=3 days before, rain when as_of is <=1 day before.

## 10 Seed rules (core/seed; deterministic mulberry32 seeded by hash of inputs; never hand-typed JSON)
Flights: 7-9 per route/day/direction, 2 fictional carriers, 05:30-22:30, one-way INR 2,400-9,500, earliest (<07:00) and latest departures cheapest, price rises as as_of nears. Stays: 24 (12 north, 8 south, 4 central), INR 800-9,000/night, rating 3.2-4.9. Places: 36 (20 food INR 150-1,800 pp; 16 activities INR 0-3,500 pp; ~half outdoor). Feasibility invariant (tested): for pax=1, 2 nights, a full plan <= INR 20,000 exists AND the best-rated "comfort" plan exceeds INR 20,000.

## 11 Scenarios (e2e, mock LLM) and invariants
S1 basic plan under budget · S2 over budget then re-plan · S3 confirm ok · S4 one leg fails -> rollback -> re-plan -> confirm · S5 memory ("same as last time", learned preference chip) · S6 time travel -> rain nudge -> swap · S7 hold expires -> re-hold or re-plan · S8 LLM cannot confirm.
I1 LLM tool list has no app-only tool · I2 confirm without/with wrong token -> FORBIDDEN · I3 propose_itinerary rejects total>budget · I4 card numbers computed in code, never from LLM text · I5 veloxcheck passes on all 4 servers · I6 servers/clients use the MCP SDK at runtime over Streamable HTTP, protocol 2025-11-25 negotiated.
