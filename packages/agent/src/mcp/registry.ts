import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition } from '../llm/types.js';

export const serverNames = ['air', 'stay', 'local', 'vault'] as const;
export type ServerName = typeof serverNames[number];

const defaultUrls: Record<ServerName, string> = {
  air: 'http://127.0.0.1:7101/mcp',
  stay: 'http://127.0.0.1:7102/mcp',
  local: 'http://127.0.0.1:7103/mcp',
  vault: 'http://127.0.0.1:7104/mcp',
};

export type RegistryTool = ToolDefinition & {
  server: ServerName;
  remoteName: string;
  audience: 'llm' | 'app';
};

interface RegistryClient {
  server: ServerName;
  client: Client;
  tools: RegistryTool[];
}

export interface Registry {
  tools: RegistryTool[];
  invoke(name: string, args: Record<string, unknown>, asOf: string): Promise<Record<string, unknown>>;
  invokeApp(name: string, args: Record<string, unknown>, asOf: string): Promise<Record<string, unknown>>;
  setChaos(server: ServerName | null): Promise<void>;
  close(): Promise<void>;
}

function serverUrl(name: ServerName, urls: Partial<Record<ServerName, string>>): string {
  return urls[name] ?? process.env[`VELOX_URL_${name.toUpperCase()}`] ?? defaultUrls[name];
}

function publicSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema };
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const properties = { ...(schema.properties as Record<string, unknown>) };
    delete properties.as_of;
    result.properties = properties;
  }
  if (Array.isArray(schema.required)) {
    result.required = schema.required.filter((field) => field !== 'as_of');
  }
  return result;
}

function structuredResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const value = result as Record<string, unknown>;
    if (value.structuredContent && typeof value.structuredContent === 'object' && !Array.isArray(value.structuredContent)) {
      return value.structuredContent as Record<string, unknown>;
    }
    const text = Array.isArray(value.content)
      ? value.content.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).type === 'text')
      : undefined;
    if (text && typeof (text as Record<string, unknown>).text === 'string') {
      const textValue = (text as Record<string, unknown>).text as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(textValue);
      } catch (error) {
        if (value.isError !== true) throw error;
        const code = textValue.match(/\b(NOT_FOUND|SOLD_OUT|HOLD_EXPIRED|FORBIDDEN|INVALID)\b/)?.[1] ?? 'INVALID';
        return { isError: true, code, message: textValue, retryable: code === 'SOLD_OUT' || code === 'HOLD_EXPIRED' };
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    }
  }
  throw new Error('MCP tool returned no structured result');
}

export async function createRegistry(urls: Partial<Record<ServerName, string>> = {}): Promise<Registry> {
  const connected: RegistryClient[] = [];
  try {
    for (const server of serverNames) {
      const client = new Client({ name: 'velox-agent', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl(server, urls)));
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        const tools = listed.tools.map((tool) => {
          const metadata = tool._meta;
          const audience = metadata?.['velox/audience'] === 'app' ? 'app' : 'llm';
          return {
            name: `${server}__${tool.name}`,
            remoteName: tool.name,
            server,
            description: tool.description ?? '',
            inputSchema: publicSchema(tool.inputSchema as Record<string, unknown>),
            audience,
          } satisfies RegistryTool;
        });
        connected.push({ server, client, tools });
      } catch (error) {
        await client.close();
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(connected.map(({ client }) => client.close()));
    throw error;
  }

  const clients = new Map<ServerName, RegistryClient>();
  for (const entry of connected) {
    clients.set(entry.server, entry);
  }
  const tools = connected.flatMap((entry) => entry.tools);
  async function invokeTool(name: string, args: Record<string, unknown>, asOf: string, appOnly: boolean) {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    if ((tool.audience === 'app') !== appOnly) {
      throw new Error(appOnly
        ? `Model-visible MCP tool cannot be invoked by the app saga: ${name}`
        : `App-only MCP tool is unavailable to the agent: ${name}`);
    }
    const entry = clients.get(tool.server);
    if (!entry) throw new Error(`MCP server is not connected: ${tool.server}`);
    const result = await entry.client.callTool({
      name: tool.remoteName,
      arguments: { ...args, as_of: asOf },
    });
    return structuredResult(result);
  }
  return {
    tools,
    invoke(name, args, asOf) {
      return invokeTool(name, args, asOf, false);
    },
    invokeApp(name, args, asOf) {
      return invokeTool(name, args, asOf, true);
    },
    async setChaos(server) {
      const targets = server ? [server] : serverNames;
      await Promise.all(targets.map(async (target) => {
        const url = new URL(serverUrl(target, urls));
        url.pathname = '/admin/chaos';
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'SOLD_OUT', once: true }),
        });
        if (!response.ok) throw new Error(`Could not enable chaos on ${target}: HTTP ${response.status}`);
        const result: unknown = await response.json();
        if (!result || typeof result !== 'object' || (result as { active?: unknown }).active !== true) {
          throw new Error(`Could not enable chaos on ${target}: server has no active hold store`);
        }
      }));
    },
    async close() {
      await Promise.all([...clients.values()].map(({ client }) => client.close()));
      clients.clear();
    },
  };
}
