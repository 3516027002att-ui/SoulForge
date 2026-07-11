/**
 * Anthropic Messages API compatible adapter.
 */

import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelServiceAdapter,
  StreamEvent,
  ToolDefinition
} from './types.js';

export interface AnthropicCompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  apiVersion?: string;
}

export class AnthropicCompatibleAdapter implements ModelServiceAdapter {
  readonly protocol = 'anthropic-compatible' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;

  constructor(options: AnthropicCompatibleAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? '2023-06-01';
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const body = buildMessagesBody(this.model, request, false);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {})
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        message: { role: 'assistant', content: '' },
        finishReason: 'error',
        diagnostics: [{
          severity: 'error',
          code: 'MODEL_SERVICE_HTTP_ERROR',
          message: `Anthropic-compatible 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`
        }]
      };
    }
    const json = await response.json() as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const texts: string[] = [];
    const toolCalls = [];
    for (const block of json.content ?? []) {
      if (block.type === 'text' && block.text) texts.push(block.text);
      if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          argumentsJson: JSON.stringify(block.input ?? {})
        });
      }
    }
    const finish = toolCalls.length > 0 || json.stop_reason === 'tool_use'
      ? 'tool_use' as const
      : json.stop_reason === 'max_tokens'
        ? 'length' as const
        : 'stop' as const;
    return {
      message: {
        role: 'assistant',
        content: texts.join(''),
        ...(toolCalls.length ? { toolCalls } : {})
      },
      finishReason: finish,
      usage: {
        ...(json.usage?.input_tokens !== undefined ? { inputTokens: json.usage.input_tokens } : {}),
        ...(json.usage?.output_tokens !== undefined ? { outputTokens: json.usage.output_tokens } : {})
      },
      diagnostics: []
    };
  }

  async *stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined> {
    // Fake-compatible streaming: perform complete() then emit synthetic deltas.
    // Real SSE can be layered later without changing the public StreamEvent contract.
    try {
      const result = await this.complete(request);
      if (result.finishReason === 'error') {
        yield {
          type: 'error',
          code: result.diagnostics[0]?.code ?? 'MODEL_SERVICE_HTTP_ERROR',
          message: result.diagnostics[0]?.message ?? 'Anthropic 请求失败。'
        };
        return;
      }
      if (result.message.content) {
        yield { type: 'text-delta', text: result.message.content };
      }
      for (const toolCall of result.message.toolCalls ?? []) {
        yield { type: 'tool-call', toolCall };
      }
      yield { type: 'message-stop', finishReason: result.finishReason };
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield {
        type: 'error',
        code: 'MODEL_SERVICE_STREAM_FAILED',
        message: error instanceof Error ? error.message : 'Anthropic 流式失败。'
      };
    }
  }
}

function buildMessagesBody(model: string, request: ModelCompleteRequest, stream: boolean): Record<string, unknown> {
  let system: string | undefined;
  const messages: Array<Record<string, unknown>> = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      system = (system ? `${system}\n` : '') + message.content;
      continue;
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content
        }]
      });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: safeJson(call.argumentsJson)
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  return {
    model,
    stream,
    max_tokens: request.maxTokens ?? 1024,
    messages,
    ...(system ? { system } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {})
  };
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parametersJsonSchema
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
