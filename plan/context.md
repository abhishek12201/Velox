# Velox · product context
Velox (Latin: swift). Say a trip; Velox searches four separate services in parallel, holds the best combination, and books everything on ONE confirmation, rolling back safely if any booking fails.
Event: Build, Ship, Shape: Amazon Developer Hackathon (Devpost). Track: Alexa+ (simulated Alexa+-style console + real self-hosted MCP servers). Mini challenges: AWS Builder, Open Source. Official close: Oct 23 12:00 PT (= Oct 24 00:30 IST). We submit Oct 21-22.

## Why this wins (equal-weight criteria)
| Criterion | Our answer |
|---|---|
| Tech | 4 real MCP servers (spec 2025-11-25, Streamable HTTP); parallel tool use; two-phase hold/confirm saga; HMAC consent token; idempotency; conformance CLI (veloxcheck); Claude on Bedrock Converse tool use |
| Design | Voice-first, glanceable device UI: cards, carousel ("say second one"), live MCP trace, memory chips, calm tone |
| Impact | Kills the six-tab trip chore. The pattern (hold -> explicit consent -> commit, rollback on failure) is the template for any agent that spends money. veloxcheck helps every Alexa+ entrant |
| Idea | Hits the judges' "creative" list: autonomous multi-service orchestration, state across sessions, purchasing, cards/carousels, proactive behaviour |
| Bonus | Friction log (up to +10%): log real friction as we build |

## Hard facts from the rules (live Rules page wins; recheck Oct 15 and Oct 20)
- Alexa+ track: working self-hosted MCP server (spec 2025-11-25 or later, Streamable HTTP) or Agent Skill. A simulated Alexa+ experience in a web app is allowed. Official Alexa+ dev tools are gated; not needed. Local-runnable public repo + video is enough; hosting not required.
- Submit: text description; GitHub repo (public + open-source LICENSE recommended); demo video <3:00, public YouTube/Vimeo, English, no third-party trademarks or copyrighted music; product feedback for every tool/API/SDK used; tracks and mini challenges entered. Optional: feature requests, friction log.
- AWS Builder: describe which AWS services were used and how, inside Product Feedback. Open Source: contribution URL, repo URL, GitHub username, what/how/why.
- One track prize + one mini-challenge prize max. AWS credits ($150) request form closes Oct 21 12:00 PT.

## Open Source mini challenge plan
`packages/veloxcheck`: standalone MCP conformance/lint CLI for Streamable HTTP servers (spec 2025-11-25). Built in this repo, published as its own public repo with its own LICENSE at the end (see buildplan). Every Alexa+ entrant needs to test an MCP server without the gated tools.

## Non-goals
Real bookings or payments, real airline/hotel brands or data, auth/accounts, multi-user, mobile app, hosting, a generic agent framework.

## Demo storyboard (<=2:50; payoff in first 15 s)
1. 0:00-0:15 Type/say "Weekend in Goa under 20k". Trace lights up: 4 servers called in parallel. Itinerary card appears with total vs budget. (S1)
2. 0:15-0:50 First plan is over budget; Velox visibly swaps (cheaper stay, later flight) and re-proposes under budget. (S2)
3. 0:50-1:25 Carousel of 3 stays; "second one" works. Memory chip: "avoids flights before 07:00". (S5)
4. 1:25-2:00 Tap Confirm all. Toggle "Break a booking": one leg fails, others roll back, Velox re-plans, confirms. (S3, S4)
5. 2:00-2:30 New session, "same as last Goa trip, my sister is coming". Fast-forward the clock to Friday: rain nudge, one-tap swap. (S5, S6)
6. 2:30-2:50 Show `veloxcheck` passing on all 4 servers, repo, Bedrock, open source. One-line impact.

## Voice and UI tone
Sentence case, verb-first buttons, no exclamation marks. Assistant speech <=2 short sentences; the screen carries the detail. Palette: deep ink background, saffron accent, teal = held, green = confirmed, amber = expiring, red = failed. Status always shown with icon + text, never colour alone. UI says "Velox"; the wake phrase is "Hey Velox". Label the data "synthetic".
