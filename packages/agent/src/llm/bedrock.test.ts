import {
  ConverseCommand,
  type BedrockRuntimeClientConfig,
  type ConverseCommandOutput,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { afterEach, expect, test, vi } from 'vitest';
import { BedrockProvider } from './bedrock.js';
import type { LlmMessage, ToolDefinition } from './types.js';

const tools: ToolDefinition[] = [{
  name: 'search_flights',
  description: 'Search available synthetic flights',
  inputSchema: { type: 'object', properties: { origin: { type: 'string' } } },
}];

function output(content: ContentBlock[]): ConverseCommandOutput {
  return {
    $metadata: {},
    output: { message: { role: 'assistant', content } },
    stopReason: 'end_turn',
    usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 },
    metrics: undefined,
  };
}

function fakeClient(send: (command: ConverseCommand) => Promise<ConverseCommandOutput>) {
  return { send, destroy: vi.fn() };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('maps Converse requests and converts parallel tool use and results', async () => {
  vi.stubEnv('VELOX_MODEL_ID', 'synthetic-test-model');
  vi.stubEnv('AWS_REGION', 'us-west-2');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');
  const messages: LlmMessage[] = [
    { role: 'user', content: 'Find a flight' },
    {
      role: 'assistant',
      content: JSON.stringify({
        tool_calls: [
          { id: 'flight-1', name: 'search_flights', input: { origin: 'BLR' } },
          { id: 'flight-2', name: 'search_flights', input: { origin: 'GOX' } },
        ],
      }),
    },
    { role: 'tool', name: 'search_flights', tool_call_id: 'flight-1', content: '{"offers":[]}' },
    { role: 'tool', name: 'search_flights', tool_call_id: 'flight-2', content: '{"offers":[]}' },
  ];
  let request: ConverseCommand['input'] | undefined;
  const client = fakeClient(async (command) => {
    request = command.input;
    return output([
      { text: 'Results received.' },
      { toolUse: { toolUseId: 'next-1', name: 'search_flights', input: { origin: 'BLR' } } },
      { toolUse: { toolUseId: 'next-2', name: 'search_flights', input: { origin: 'GOX' } } },
    ]);
  });
  const provider = new BedrockProvider(() => client);
  const result = await provider.converse({
    system: 'Plan a synthetic trip',
    messages,
    tools,
    maxTokens: 10_000,
  });

  expect(request?.modelId).toBe('synthetic-test-model');
  expect(request?.system).toEqual([{ text: 'Plan a synthetic trip' }]);
  expect(request?.inferenceConfig?.maxTokens).toBe(4096);
  expect(request?.toolConfig?.tools).toEqual([{
    toolSpec: { name: 'search_flights', description: tools[0]?.description, inputSchema: { json: tools[0]?.inputSchema } },
  }]);
  expect(request?.messages?.[1]?.content).toEqual([
    { toolUse: { toolUseId: 'flight-1', name: 'search_flights', input: { origin: 'BLR' } } },
    { toolUse: { toolUseId: 'flight-2', name: 'search_flights', input: { origin: 'GOX' } } },
  ]);
  expect(request?.messages?.[2]?.role).toBe('user');
  expect(request?.messages?.[2]?.content).toEqual([
    { toolResult: { toolUseId: 'flight-1', content: [{ text: '{"offers":[]}' }] } },
    { toolResult: { toolUseId: 'flight-2', content: [{ text: '{"offers":[]}' }] } },
  ]);
  expect(result.blocks).toEqual([
    { type: 'text', text: 'Results received.' },
    { type: 'tool_use', id: 'next-1', name: 'search_flights', input: { origin: 'BLR' } },
    { type: 'tool_use', id: 'next-2', name: 'search_flights', input: { origin: 'GOX' } },
  ]);
  expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  provider.close();
});

test('passes explicit bearer token and region to the SDK client', () => {
  vi.stubEnv('VELOX_MODEL_ID', 'synthetic-test-model');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', 'dummy-bedrock-token');
  let config: BedrockRuntimeClientConfig | undefined;
  const client = fakeClient(async () => output([]));

  const provider = new BedrockProvider((clientConfig) => {
    config = clientConfig;
    return client;
  });

  expect(config?.region).toBe('eu-west-1');
  expect(config?.token).toEqual({ token: 'dummy-bedrock-token' });
  expect(config?.authSchemePreference).toEqual(['httpBearerAuth']);
  provider.close();
  expect(client.destroy).toHaveBeenCalledOnce();
});

test('retries throttling with bounded backoff', async () => {
  vi.stubEnv('VELOX_MODEL_ID', 'synthetic-test-model');
  vi.stubEnv('AWS_REGION', 'us-west-2');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');
  vi.useFakeTimers();
  const throttled = Object.assign(new Error('try again'), { name: 'ThrottlingException' });
  const send = vi.fn()
    .mockRejectedValueOnce(throttled)
    .mockRejectedValueOnce(throttled)
    .mockResolvedValue(output([{ text: 'Recovered.' }]));
  const provider = new BedrockProvider(() => fakeClient(send));
  const pending = provider.converse({ system: '', messages: [], tools, maxTokens: 20 });

  await vi.runAllTimersAsync();

  await expect(pending).resolves.toMatchObject({ blocks: [{ type: 'text', text: 'Recovered.' }] });
  expect(send).toHaveBeenCalledTimes(3);
  provider.close();
});

test('fails clearly when the configured model is missing', () => {
  vi.stubEnv('VELOX_MODEL_ID', ' ');
  vi.stubEnv('AWS_REGION', 'us-west-2');
  vi.stubEnv('AWS_BEARER_TOKEN_BEDROCK', '');

  expect(() => new BedrockProvider()).toThrow('VELOX_MODEL_ID is required when VELOX_LLM=bedrock');
});
