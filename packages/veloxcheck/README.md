# veloxcheck

Standalone MCP Streamable HTTP contract checker for Velox servers.

## Usage

```sh
npx tsx packages/veloxcheck/src/cli.ts http://127.0.0.1:7101/mcp
npx tsx packages/veloxcheck/src/cli.ts http://127.0.0.1:7101/mcp --json --strict
```

The checker initializes an MCP session, verifies protocol and tool metadata,
probes unknown tools and invalid arguments, checks foreign-Origin rejection,
and terminates the session. It does not verify business correctness, persistence,
authorization beyond the listed probes, or real third-party connectivity.

The package imports no `@velox/*` workspace modules.
