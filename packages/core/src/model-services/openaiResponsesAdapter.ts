/**
 * OpenAI Responses API adapter (`POST /v1/responses`).
 * Distinct from Chat Completions compatible adapter; both normalize to StreamEvent.
 * Credentials never appear in diagnostics or returned DTOs.
 */

import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelServiceAdapter,
  StreamEvent,
  ToolCall,
  ToolDefinition
} from './types.js';

export interface OpenAiResponsesAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiResponsesAdapter implements ModelServiceAdapter {
  /** Uses openai-compatible protocol tag for agent audit isolation until dedicated enum lands. */
  readonly protocol = 'openai-compatible' as const;
  readonly transport = 'openai-responses' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const body = buildResponsesBody(this.model, request, false);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
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
          message: `OpenAI Responses 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`
        }]
      };
    }
    const json = await response.json() as ResponsesPayload;
    return parseResponsesPayload(json);
  }

  async *stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const body = buildResponsesBody(this.model, request, true);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      ...(request.signal ? { signal: request.signal } : {})
    });
    if (!response.ok || !response.body) {
      yield {
        type: 'error',
        code: 'MODEL_SERVICE_HTTP_ERROR',
        message: `OpenAI Responses 流式请求失败：HTTP ${response.status}`
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAcc = new Map<string, { id: string; name: string; args: string }>();
    let sawTool = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') {
            if (data === '[DONE]') {
              for (const tool of toolAcc.values()) {
                yield {
                  type: 'tool-call',
                  toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
                };
              }
              yield { type: 'message-stop', finishReason: sawTool ? 'tool_use' : 'stop' };
              return;
            }
            continue;
          }
          let event: ResponsesStreamEvent;
          try {
            event = JSON.parse(data) as ResponsesStreamEvent;
          } catch {
            continue;
          }
          const eventType = event.type ?? '';
          if (eventType === 'response.output_text.delta' && typeof event.delta === 'string') {
            yield { type: 'text-delta', text: event.delta };
            continue;
          }
          if (eventType === 'response.function_call_arguments.delta') {
            const key = event.item_id ?? event.output_index?.toString() ?? '0';
            const current = toolAcc.get(key) ?? {
              id: event.item_id ?? key,
              name: event.name ?? '',
              args: ''
            };
            if (event.name) current.name = event.name;
            if (typeof event.delta === 'string') current.args += event.delta;
            toolAcc.set(key, current);
            sawTool = true;
            continue;
          }
          if (eventType === 'response.output_item.done' && event.item) {
            const item = event.item;
            if (item.type === 'function_call') {
              const id = item.call_id ?? item.id ?? 'call';
              toolAcc.set(id, {
                id,
                name: item.name ?? '',
                args: item.arguments ?? ''
              });
              sawTool = true;
            }
            continue;
          }
          if (eventType === 'response.completed' || eventType === 'response.incomplete') {
            for (const tool of toolAcc.values()) {
              yield {
                type: 'tool-call',
                toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
              };
            }
            if (event.response?.usage) {
              yield {
                type: 'usage',
                ...(event.response.usage.input_tokens !== undefined
                  ? { inputTokens: event.response.usage.input_tokens }
                  : {}),
                ...(event.response.usage.output_tokens !== undefined
                  ? { outputTokens: event.response.usage.output_tokens }
                  : {})
              };
            }
            yield {
              type: 'message-stop',
              finishReason: sawTool ? 'tool_use' : 'stop'
            };
            return;
          }
          if (eventType === 'error' || eventType === 'response.failed') {
            yield {
              type: 'error',
              code: 'MODEL_SERVICE_STREAM_FAILED',
              message: event.message ?? event.error?.message ?? 'Responses 流失败。'
            };
            return;
          }
        }
      }
      for (const tool of toolAcc.values()) {
        yield {
          type: 'tool-call',
          toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
        };
      }
      yield { type: 'message-stop', finishReason: sawTool ? 'tool_use' : 'stop' };
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield {
        type: 'error',
        code: 'MODEL_SERVICE_STREAM_FAILED',
        message: error instanceof Error ? error.message : 'Responses 流式读取失败。'
      };
    }
  }
}

interface ResponsesPayload {
  status?: string;
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  item_id?: string;
  output_index?: number;
  name?: string;
  message?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

function buildResponsesBody(
  model: string,
  request: ModelCompleteRequest,
  stream: boolean
): Record<string, unknown> {
  return {
    model,
    stream,
    input: request.messages.map(toResponsesInputItem),
    ...(request.tools?.length
      ? { tools: request.tools.map(toResponsesTool) }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {})
  };
}

function toResponsesInputItem(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      type: 'function_call_output',
      call_id: message.toolCallId ?? 'unknown',
      output: message.content
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    // Expand assistant tool calls as function_call items for multi-turn continuity.
    return {
      type: 'message',
      role: 'assistant',
      content: [
        ...(message.content
          ? [{ type: 'output_text', text: message.content }]
          : []),
        ...message.toolCalls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.argumentsJson
        }))
      ]
    };
  }
  return {
    type: 'message',
    role: message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content
  };
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersJsonSchema
  };
}

function parseResponsesPayload(json: ResponsesPayload): ModelCompleteResult {
  if (json.error?.message) {
    return {
      message: { role: 'assistant', content: '' },
      finishReason: 'error',
      diagnostics: [{
        severity: 'error',
        code: 'MODEL_SERVICE_HTTP_ERROR',
        message: json.error.message.slice(0, 200)
      }]
    };
  }
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of json.output ?? []) {
    if (item.type === 'message' || item.type === 'output_text') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) texts.push(part.text);
        if (part.type === 'text' && part.text) texts.push(part.text);
      }
      // Some payloads put text directly on content strings — handled above.
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        name: item.name ?? '',
        argumentsJson: item.arguments ?? '{}'
      });
    }
    // Flat text item variants
    if (item.type === 'output_text' && typeof (item as { text?: string }).text === 'string') {
      texts.push((item as { text: string }).text);
    }
  }
  // Fallback: gather any content[].text
  if (texts.length === 0) {
    for (const item of json.output ?? []) {
      for (const part of item.content ?? []) {
        if (part.text) texts.push(part.text);
      }
    }
  }
  const finishReason: ModelCompleteResult['finishReason'] =
    toolCalls.length > 0 ? 'tool_use' : json.status === 'incomplete' ? 'length' : 'stop';
  return {
    message: {
      role: 'assistant',
      content: texts.join(''),
      ...(toolCalls.length ? { toolCalls } : {})
    },
    finishReason,
    usage: {
      ...(json.usage?.input_tokens !== undefined ? { inputTokens: json.usage.input_tokens } : {}),
      ...(json.usage?.output_tokens !== undefined ? { outputTokens: json.usage.output_tokens } : {})
    },
    diagnostics: []
  };
}
