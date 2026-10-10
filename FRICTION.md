# Friction log and product feedback (append-only by opencode; the human edits later)
Counts toward a judging bonus (up to 10%). Log REAL friction only: wrong/missing docs, SDK surprises, errors, workarounds.

## Entry format
### F<n> · <tool/API/SDK> · severity: low|med|high
- Task:
- Steps:
- Expected vs actual:
- Workaround:
- Suggestion:

## Feedback lines (one per tool/SDK used; format: tool | used for | worked | needs work | onboarding 1-5 | build again y/n + why)
- @modelcontextprotocol/sdk | stateful Streamable HTTP session setup and init lifecycle | yes | some resolver friction | 4 | y; docs were correct but the import path still needed validation in practice
- @modelcontextprotocol/sdk | connect four Streamable HTTP clients, enumerate/call tools, and inject as_of | yes | no major friction | 4 | y; consistent MCP client/server lifecycle

## Feature requests (format: request | why it matters | critical|important|nice-to-have)

## Entries
### F1 · @modelcontextprotocol/sdk · severity: medium
- Task:
  Confirm the correct stateful Streamable HTTP server/session pattern and suitable event store import in the installed v1.32.1 SDK.
- Steps:
  Followed the SDK examples and attempted the ESM dist path for the event store before verifying the package export path.
- Expected vs actual:
  Expected the documented example to resolve directly. Actual behavior: `@modelcontextprotocol/sdk/dist/esm/examples/shared/inMemoryEventStore.js` failed under the local resolver while `@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js` worked.
- Workaround:
  Use the package-export path from the SDK package, and wait for the Node listener to bind before probing the port in tests.
- Suggestion:
  Keep the example import path in a quick reference to reduce time lost debugging resolver mismatches.

### F2 · @aws-sdk/client-bedrock-runtime · severity: low
- Task:
  Configure Bedrock Converse with the environment-provided bearer API key.
- Steps:
  Verified the installed 3.1149.0 client types and exercised bearer auth configuration with an offline request handler.
- Expected vs actual:
  Expected the environment variable to be consumed automatically. Actual behavior: the SDK requires `token` and `authSchemePreference` client options to be supplied explicitly.
- Workaround:
  Pass the environment key as the SDK token identity and prefer `httpBearerAuth`; otherwise use the default credential chain.
- Suggestion:
  Document the explicit client configuration for Bedrock API-key authentication.

- @aws-sdk/client-bedrock-runtime | Converse API, bearer authentication, and tool round trips | yes | explicit bearer configuration is required | 4 | y; installed types and offline mocked requests clarified auth and Converse shapes
