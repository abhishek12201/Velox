# Velox web console

Start the console with `npm run dev -w @velox/web`. It connects to
`VITE_AGENT_URL` (default `http://127.0.0.1:7100`); a URL query parameter
`?agent=https://<forwarded-agent-url>` overrides it for this browser session.
In Codespaces, set agent port **7100** to **Public** in the **Ports** tab and
use its forwarded URL as the `agent` query parameter. Set `VELOX_WEB_ORIGIN`
on the agent to the exact web page origin when it differs from
`http://localhost:5173`.
