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
import {
  classifyFetchError,
  classifyHttpError,
  classifyParseError,
  createRequestSignal,
  errorResult,
  errorStreamEvent
} from './errorClassification.js';

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
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      cleanup();
      return errorResult(classifyFetchError(error, 'Anthropic-compatible', signal));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return errorResult(classifyHttpError(
        response.status, text, 'Anthropic-compatible',
        response.headers.get('retry-after')
      ));
    }
    let json: {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      cleanup();
      return errorResult(classifyParseError(error, 'Anthropic-compatible'));
    }
    cleanup();
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
        const diag = result.diagnostics[0];
        yield errorStreamEvent({
          severity: 'error',
          code: diag?.code ?? 'MODEL_SERVICE_HTTP_ERROR',
          message: diag?.message ?? 'Anthropic-compatible 请求失败。'
        });
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
      yield errorStreamEvent(classifyFetchError(error, 'Anthropic-compatible', request.signal));
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
