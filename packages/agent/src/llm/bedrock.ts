import {
  BedrockRuntimeClient,
  ConverseCommand,
  type BedrockRuntimeClientConfig,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { LlmMessage, LlmProvider, ToolDefinition, ToolUseBlock } from './types.js';

const maxOutputTokens = 4096;
const maxThrottleAttempts = 3;

type ConverseClient = {
  send(command: ConverseCommand): Promise<ConverseCommandOutput>;
  destroy(): void;
};

type ClientFactory = (config: BedrockRuntimeClientConfig) => ConverseClient;
type JsonDocument = null | boolean | number | string | JsonDocument[] | { [key: string]: JsonDocument };
type ConverseMessage = NonNullable<ConverseCommandInput['messages']>[number];
type ConverseContent = NonNullable<ConverseMessage['content']>;

function jsonDocument(value: unknown): JsonDocument {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(jsonDocument);
  if (value && typeof value === 'object') {
    const result: { [key: string]: JsonDocument } = {};
    for (const [key, entry] of Object.entries(value)) result[key] = jsonDocument(entry);
    return result;
  }
  throw new Error('Bedrock Converse values must be JSON-compatible');
}

function modelIdFromEnvironment(): string {
  const modelId = process.env.VELOX_MODEL_ID?.trim();
  if (!modelId) throw new Error('VELOX_MODEL_ID is required when VELOX_LLM=bedrock');
  return modelId;
}

function clientConfigFromEnvironment(): BedrockRuntimeClientConfig {
  const region = process.env.AWS_REGION?.trim();
  if (!region) throw new Error('AWS_REGION is required when VELOX_LLM=bedrock');
  const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (bearerToken) {
    return {
      region,
      token: { token: bearerToken },
      authSchemePreference: ['httpBearerAuth'],
      maxAttempts: 1,
    };
  }
  return { region, maxAttempts: 1 };
}

function safeError(error: unknown, bearerToken: string | undefined): Error {
  let name = error instanceof Error ? error.name : 'BedrockError';
  let message = error instanceof Error ? error.message : 'Bedrock request failed';
  if (bearerToken) {
    name = name.replaceAll(bearerToken, '[REDACTED]');
    message = message.replaceAll(bearerToken, '[REDACTED]');
  }
  const result = new Error(`${name}: ${message}`);
  result.name = name;
  return result;
}

function isThrottlingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === 'ThrottlingException' ||
    value.name === 'TooManyRequestsException' ||
    value.$metadata?.httpStatusCode === 429;
}

function parseToolCalls(content: string): Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as { tool_calls?: unknown }).tool_calls)) {
    return undefined;
  }
  return (value as { tool_calls: unknown[] }).tool_calls.flatMap((call) => {
    if (!call || typeof call !== 'object') return [];
    const candidate = call as { id?: unknown; name?: unknown; input?: unknown };
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      !candidate.input ||
      typeof candidate.input !== 'object' ||
      Array.isArray(candidate.input)
    ) return [];
    return [{ id: candidate.id, name: candidate.name, input: candidate.input as Record<string, unknown> }];
  });
}

function converseMessages(messages: LlmMessage[]): NonNullable<ConverseCommandInput['messages']> {
  const result: NonNullable<ConverseCommandInput['messages']> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'tool') {
      const content: ConverseContent = [];
      while (index < messages.length && messages[index]?.role === 'tool') {
        const toolResult = messages[index];
        if (toolResult?.role !== 'tool' || !toolResult.tool_call_id) {
          throw new Error('Bedrock tool results require a tool_call_id');
        }
        content.push({
          toolResult: {
            toolUseId: toolResult.tool_call_id,
            content: [{ text: toolResult.content }],
          },
        });
        index += 1;
      }
      index -= 1;
      result.push({ role: 'user', content });
      continue;
    }
    if (message.role === 'assistant') {
      const toolCalls = parseToolCalls(message.content);
      if (toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: toolCalls.map(({ id, name, input }) => ({
            toolUse: { toolUseId: id, name, input: jsonDocument(input) },
          })),
        });
        continue;
      }
    }
    result.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ text: message.content }],
    });
  }
  return result;
}

export class BedrockProvider implements LlmProvider {
  private readonly modelId: string;
  private readonly client: ConverseClient;
  private readonly bearerToken: string | undefined;

  constructor(
    clientFactory: ClientFactory = (config) => new BedrockRuntimeClient(config),
    private readonly onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void,
  ) {
    this.modelId = modelIdFromEnvironment();
    this.bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
    this.client = clientFactory(clientConfigFromEnvironment());
  }

  async converse(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<Awaited<ReturnType<LlmProvider['converse']>>> {
    const maxTokens = Math.min(maxOutputTokens, Math.max(1, Math.floor(input.maxTokens)));
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: input.system }],
      messages: converseMessages(input.messages),
      inferenceConfig: { maxTokens },
      toolConfig: {
        tools: input.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: jsonDocument(tool.inputSchema) },
          },
        })),
      },
    });

    let response: ConverseCommandOutput | undefined;
    for (let attempt = 0; attempt < maxThrottleAttempts; attempt += 1) {
      try {
        response = await this.client.send(command);
        break;
      } catch (error) {
        if (!isThrottlingError(error) || attempt === maxThrottleAttempts - 1) {
          throw safeError(error, this.bearerToken);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
      }
    }
    if (!response) throw new Error('Bedrock request did not produce a response');

    const usage = {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
    console.info('Bedrock turn usage', usage);
    this.onUsage?.(usage);

    const content = response.output?.message?.content ?? [];
    const blocks: Awaited<ReturnType<LlmProvider['converse']>>['blocks'] = [];
    for (const block of content) {
      if (typeof block.text === 'string') {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.toolUse?.toolUseId && block.toolUse.name) {
        const toolInput = block.toolUse.input;
        blocks.push({
          type: 'tool_use',
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
            ? toolInput as Record<string, unknown>
            : {},
        } satisfies ToolUseBlock);
      }
    }
    return {
      blocks,
      stop: response.stopReason ?? 'end_turn',
      usage,
    };
  }

  close(): void {
    this.client.destroy();
  }
}
