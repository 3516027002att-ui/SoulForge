/**
 * OpenAI-compatible Chat Completions adapter (also covers OpenAI Responses-style
 * chat endpoints that accept /v1/chat/completions).
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

export interface OpenAiCompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiCompatibleAdapter implements ModelServiceAdapter {
  readonly protocol = 'openai-compatible' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const body = buildChatBody(this.model, request, false);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
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
          message: `OpenAI-compatible 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`
        }]
      };
    }
    const json = await response.json() as {
      choices?: Array<{
        message?: {
          role?: string;
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = json.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      argumentsJson: call.function.arguments
    }));
    const finish = mapFinish(choice?.finish_reason, toolCalls);
    return {
      message: {
        role: 'assistant',
        content: choice?.message?.content ?? '',
        ...(toolCalls.length ? { toolCalls } : {})
      },
      finishReason: finish,
      usage: {
        ...(json.usage?.prompt_tokens !== undefined ? { inputTokens: json.usage.prompt_tokens } : {}),
        ...(json.usage?.completion_tokens !== undefined ? { outputTokens: json.usage.completion_tokens } : {})
      },
      diagnostics: []
    };
  }

  async *stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const body = buildChatBody(this.model, request, true);
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
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
        message: `OpenAI-compatible 流式请求失败：HTTP ${response.status}`
      };
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
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
          if (data === '[DONE]') {
            for (const tool of toolAcc.values()) {
              yield {
                type: 'tool-call',
                toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
              };
            }
            yield { type: 'message-stop', finishReason: toolAcc.size ? 'tool_use' : 'stop' };
            return;
          }
          try {
            const json = JSON.parse(data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
            };
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) yield { type: 'text-delta', text: delta.content };
            for (const toolDelta of delta?.tool_calls ?? []) {
              const index = toolDelta.index ?? 0;
              const current = toolAcc.get(index) ?? { id: '', name: '', args: '' };
              if (toolDelta.id) current.id = toolDelta.id;
              if (toolDelta.function?.name) current.name = toolDelta.function.name;
              if (toolDelta.function?.arguments) current.args += toolDelta.function.arguments;
              toolAcc.set(index, current);
            }
            if (json.choices?.[0]?.finish_reason) {
              for (const tool of toolAcc.values()) {
                yield {
                  type: 'tool-call',
                  toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
                };
              }
              yield {
                type: 'message-stop',
                finishReason: mapFinish(json.choices[0].finish_reason, [...toolAcc.values()].map((t) => ({
                  id: t.id, name: t.name, argumentsJson: t.args
                })))
              };
              return;
            }
          } catch {
            // ignore malformed SSE chunk
          }
        }
      }
      yield { type: 'message-stop', finishReason: 'stop' };
    } catch (error) {
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield {
        type: 'error',
        code: 'MODEL_SERVICE_STREAM_FAILED',
        message: error instanceof Error ? error.message : '流式读取失败。'
      };
    }
  }
}

function buildChatBody(model: string, request: ModelCompleteRequest, stream: boolean): Record<string, unknown> {
  return {
    model,
    stream,
    messages: request.messages.map(toOpenAiMessage),
    ...(request.tools?.length ? { tools: request.tools.map(toOpenAiTool) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {})
  };
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId
    };
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson }
      }))
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema
    }
  };
}

function mapFinish(
  reason: string | null | undefined,
  toolCalls: ToolCall[]
): ModelCompleteResult['finishReason'] {
  if (toolCalls.length > 0 || reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'length';
  if (reason === 'stop' || !reason) return 'stop';
  return 'stop';
}
