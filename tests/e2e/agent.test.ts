import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './llm/types.js';
import { ScenarioProvider } from '../../packages/agent/src/llm/mock.js';
import { createAgentApp } from '../../packages/agent/src/api.js';
import { start } from '../../packages/servers/src/main.js';

async function waitForListening(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function sseEvents(text: string): Array<Record<string, unknown>> {
  return text.split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return [];
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSE event');
    return [value as Record<string, unknown>];
  });
}

test('S1 streams parallel searches, holds, and a code-computed itinerary without app-only tools', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const dataDir = await mkdtemp(join(tmpdir(), `velox-agent-${randomUUID()}-`));
  const serverNames = ['air', 'stay', 'local', 'vault'] as const;
  const asOf = '2026-06-01T00:00:00.000Z';
  const servers: Array<{ name: string; server: Server }> = [];
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;

  try {
    const serverUrls: Partial<Record<typeof serverNames[number], string>> = {};
    for (const name of serverNames) {
      const started = start(name, { port: 0, dbPath: join(dataDir, `${name}.db`) });
      servers.push({ name, server: started.server });
      const port = await waitForListening(started.server);
      serverUrls[name] = `http://127.0.0.1:${port}/mcp`;
    }

    const delegate = new ScenarioProvider();
    const providerInputs: Array<{ messages: LlmMessage[]; tools: ToolDefinition[] }> = [];
    const provider: LlmProvider = {
      async converse(input) {
        providerInputs.push({
          messages: input.messages.map((message) => ({ ...message })),
          tools: input.tools.map((tool) => ({ ...tool })),
        });
        const answer = await delegate.converse(input);
        return {
          ...answer,
          blocks: answer.blocks.map((block) => {
            if (block.type !== 'tool_use' || block.name !== 'internal__propose_itinerary') return block;
            return { ...block, input: { ...block.input, total: 1 } } satisfies ToolUseBlock;
          }),
        };
      },
    };
    agent = await createAgentApp({ serverUrls, provider, asOf });
    apiServer = agent.app.listen(0, '127.0.0.1');
    const apiPort = await waitForListening(apiServer);
    const baseUrl = `http://127.0.0.1:${apiPort}`;

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's1', text: 'Weekend in Goa under 20k' }),
    });
    expect(response.status).toBe(200);
    const events = sseEvents(await response.text());
    const calls = events.filter((event) => event.type === 'call');
    const results = events.filter((event) => event.type === 'result');
    const cards = events.filter((event) => event.type === 'card');
    const firstResultIndex = events.findIndex((event) => event.type === 'result');
    const firstSearchCalls = events.slice(0, firstResultIndex).filter((event) => event.type === 'call');
    expect(firstSearchCalls).toHaveLength(5);
    expect(new Set(firstSearchCalls.map((event) => event.server))).toEqual(new Set(['air', 'stay', 'local']));
    expect(calls.length).toBeGreaterThanOrEqual(12);
    expect(results.length).toBeGreaterThanOrEqual(12);
    expect(calls.filter((event) => event.server !== 'internal').every((event) => {
      const args = event.args as Record<string, unknown>;
      return args.as_of === asOf;
    })).toBe(true);
    expect(cards).toHaveLength(1);
    const itinerary = cards[0]?.card as Record<string, unknown>;
    expect(itinerary.kind).toBe('itinerary');
    expect(itinerary.total).toBeLessThanOrEqual(20_000);
    const lastResultIndex = events.reduce((last, event, index) => event.type === 'result' ? index : last, -1);
    expect(events.findIndex((event) => event.type === 'card')).toBeGreaterThan(lastResultIndex);

    const suppliedTools = providerInputs.flatMap((input) => input.tools.map((tool) => tool.name));
    expect(suppliedTools.some((name) => /confirm_|cancel_booking|save_trip/.test(name))).toBe(false);
    expect(providerInputs.some((input) => input.messages.some((message) => {
      if (message.role !== 'tool' || !/hold_(flight|stay|table)$/.test(message.name ?? '')) return false;
      const value: unknown = JSON.parse(message.content);
      return Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).amount);
    }))).toBe(true);
    const successfulHoldResults = results.filter((event) => event.ok && typeof event.summary === 'string' && event.summary.startsWith('held INR '));
    expect(successfulHoldResults).toHaveLength(6);
    expect((itinerary.days as Array<{ items: unknown[] }>)[0]?.items).toHaveLength(6);
    const finalMessages = providerInputs.at(-1)?.messages ?? [];
    const held = new Map<string, number>();
    for (const message of finalMessages) {
      if (message.role !== 'tool' || !/hold_(flight|stay|table)$/.test(message.name ?? '')) continue;
      const value: unknown = JSON.parse(message.content);
      if (
        value && typeof value === 'object' &&
        typeof (value as Record<string, unknown>).hold_id === 'string' &&
        typeof (value as Record<string, unknown>).amount === 'number'
      ) {
        held.set((value as Record<string, unknown>).hold_id as string, (value as Record<string, unknown>).amount as number);
      }
    }
    expect(itinerary.total).toBe([...held.values()].reduce((sum, amount) => sum + amount, 0));

    const reset = await fetch(`${baseUrl}/api/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'all' }),
    });
    expect(reset.status).toBe(200);
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (close: () => Promise<void>) => {
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (apiServer) await cleanup(() => closeServer(apiServer as Server));
    if (agent) await cleanup(() => agent?.close() ?? Promise.resolve());
    for (const { server } of servers) await cleanup(() => closeServer(server));
    log.mockRestore();
    await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Agent e2e cleanup failed');
  }
});
