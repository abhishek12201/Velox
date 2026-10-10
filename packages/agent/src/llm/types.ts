export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface LlmProvider {
  converse(input: {
    system: string;
    messages: LlmMessage[];
    tools: ToolDefinition[];
    maxTokens: number;
  }): Promise<{ blocks: Array<TextBlock | ToolUseBlock>; stop: string; usage: { inputTokens: number; outputTokens: number } }>;
}
