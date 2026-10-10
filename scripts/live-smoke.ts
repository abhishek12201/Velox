import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BedrockProvider } from '../packages/agent/src/llm/bedrock.js';
import type { ServerName } from '../packages/agent/src/mcp/registry.js';
import { createAgentApp } from '../packages/agent/src/api.js';
import { start } from '../packages/servers/src/main.js';

const cannedPrompts = [
  'Weekend in Goa under 20k',
  'Plan a weekend in Goa under INR 20,000',
  'Find a Goa weekend trip within INR 20,000',
];
const serverNames: ServerName[] = ['air', 'stay', 'local', 'vault'];
const asOf = new Date().toISOString();

async function waitForPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke server did not bind to a TCP port');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body.split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
    if (!data) return [];
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent returned an invalid SSE event');
    return [value as Record<string, unknown>];
  });
}

async function runSmoke(): Promise<void> {
  if (!process.env.VELOX_MODEL_ID?.trim()) throw new Error('VELOX_MODEL_ID is required for the live smoke test');
  if (!process.env.AWS_REGION?.trim()) throw new Error('AWS_REGION is required for the live smoke test');
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
    console.log('SKIPPED: AWS credentials are missing (set AWS_BEARER_TOKEN_BEDROCK or configure the AWS credential chain)');
    return;
  }

  const dataDir = await mkdtemp(join(tmpdir(), `velox-live-${randomUUID()}-`));
  const servers: Server[] = [];
  let agent: Awaited<ReturnType<typeof createAgentApp>> | undefined;
  let apiServer: Server | undefined;
  let activeUsage: { inputTokens: number; outputTokens: number } | undefined;
  const provider = new BedrockProvider(undefined, (usage) => {
    if (!activeUsage) return;
    activeUsage.inputTokens += usage.inputTokens;
    activeUsage.outputTokens += usage.outputTokens;
  });

  try {
    const serverUrls: Partial<Record<ServerName, string>> = {};
    for (const name of serverNames) {
      const { server } = start(name, { port: 0, dbPath: join(dataDir, `${name}.db`) });
      servers.push(server);
      serverUrls[name] = `http://127.0.0.1:${await waitForPort(server)}/mcp`;
    }
    agent = await createAgentApp({ serverUrls, provider, asOf });
    apiServer = createHttpServer(agent.app);
    apiServer.listen(0, '127.0.0.1');
    const port = await waitForPort(apiServer);
    const baseUrl = `http://127.0.0.1:${port}`;
    const totals: number[] = [];
    const tokenTotals: number[] = [];

    for (const [index, text] of cannedPrompts.entries()) {
      const usage = { inputTokens: 0, outputTokens: 0 };
      activeUsage = usage;
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: `live-smoke-${index + 1}`, text }),
      });
      if (!response.ok) throw new Error(`Agent chat returned HTTP ${response.status}`);
      const events = parseEvents(await response.text());
      const error = events.find((event) => event.type === 'error');
      if (error) throw new Error(String(error.message ?? 'Agent returned an error'));
      const calls = events
        .filter((event) => event.type === 'call')
        .map((event) => `${String(event.server)}.${String(event.tool)}`);
      const cards = events
        .filter((event) => event.type === 'card')
        .map((event) => event.card)
        .filter((card): card is Record<string, unknown> => Boolean(card) && typeof card === 'object');
      const finalTotal = cards.reduce<number | undefined>((total, card) =>
        typeof card.total === 'number' ? card.total : total, undefined);
      if (finalTotal === undefined) throw new Error(`Prompt ${index + 1} produced no card with a final total`);
      totals.push(finalTotal);
      tokenTotals.push(usage.inputTokens + usage.outputTokens);
      console.log(JSON.stringify({
        prompt: index + 1,
        tool_sequence: calls,
        final_card_total: finalTotal,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
      }));
    }
    const avgTokens = Math.round(tokenTotals.reduce((sum, tokens) => sum + tokens, 0) / tokenTotals.length);
    console.log(`Completed ${totals.length} live prompts; final card totals: ${totals.join(', ')} INR`);
    console.log(`avg_tokens_per_canned_prompt=${avgTokens}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live smoke failed';
    if (message.includes('AccessDeniedException')) {
      console.log('SKIPPED: AccessDeniedException (AWS account is still being verified)');
      return;
    }
    console.error(message);
    process.exitCode = 1;
  } finally {
    activeUsage = undefined;
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
    for (const server of servers) await cleanup(() => closeServer(server));
    provider.close();
    await cleanup(() => rm(dataDir, { recursive: true, force: true }));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Live smoke cleanup failed');
  }
}

runSmoke().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Live smoke failed';
  if (message.includes('AccessDeniedException')) {
    console.log('SKIPPED: AccessDeniedException (AWS account is still being verified)');
    return;
  }
  console.error(message);
  process.exitCode = 1;
});
