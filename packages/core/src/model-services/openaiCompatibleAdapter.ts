/**
 * OpenAI-compatible Chat Completions adapter (also covers OpenAI Responses-style
 * chat endpoints that accept /v1/chat/completions).
 */

import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelListResult,
  ModelServiceAdapter,
  StreamEvent,
  ToolCall,
  ToolDefinition
} from './types.js';
import { resolveOpenAiReasoningEffort } from './types.js';
import {
  classifyFetchError,
  classifyHttpError,
  classifyParseError,
  createRequestSignal,
  errorResult,
  errorStreamEvent
} from './errorClassification.js';
import { normalizeServiceBaseUrl } from './baseUrlJoin.js';

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
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const body = buildChatBody(this.model, request, false);
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      cleanup();
      return errorResult(classifyFetchError(error, 'OpenAI-compatible', signal, { callerSignal: request.signal }));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return errorResult(classifyHttpError(
        response.status, text, 'OpenAI-compatible',
        response.headers.get('retry-after')
      ));
    }
    let json: {
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
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      cleanup();
      return errorResult(classifyParseError(error, 'OpenAI-compatible'));
    }
    cleanup();
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

  async listModels(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ModelListResult> {
    const { signal, cleanup } = createRequestSignal(options?.signal, options?.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiKey}`
        },
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      cleanup();
      return listModelsError(classifyFetchError(error, 'OpenAI-compatible', signal, { callerSignal: options?.signal }));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return listModelsError(classifyHttpError(
        response.status, text, 'OpenAI-compatible',
        response.headers.get('retry-after')
      ));
    }
    let json: { data?: Array<{ id?: unknown; display_name?: unknown }> };
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      cleanup();
      return listModelsError(classifyParseError(error, 'OpenAI-compatible'));
    }
    cleanup();
    const models = (json.data ?? [])
      .filter((entry): entry is { id: string; display_name?: unknown } => typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        ...(typeof entry.display_name === 'string' && entry.display_name !== ''
          ? { displayName: entry.display_name }
          : {})
      }));
    return { ok: true, models };
  }

  async *stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined> {
    const body = buildChatBody(this.model, request, true);    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      cleanup();
      yield errorStreamEvent(classifyFetchError(error, 'OpenAI-compatible', signal, { callerSignal: request.signal }));
      return;
    }
    if (!response.ok || !response.body) {
      // Keep the provider's JSON error body.  DashScope and other compatible
      // gateways put the actionable reason (for example context overflow or
      // an unsupported request field) here; dropping it makes a real Agent
      // run indistinguishable from an unexplained HTTP failure.
      const text = !response.ok
        ? await response.text().catch(() => '')
        : '';
      cleanup();
      yield errorStreamEvent(classifyHttpError(
        response.status, text, 'OpenAI-compatible',
        response.headers.get('retry-after')
      ));
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
            cleanup();
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
                  reasoning_content?: string;
                  reasoning?: string;
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
            const reasoning = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
              yield { type: 'thinking-delta', text: reasoning };
            }
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
              cleanup();
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
      cleanup();
      yield { type: 'message-stop', finishReason: 'stop' };
    } catch (error) {
      cleanup();
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield errorStreamEvent(classifyFetchError(error, 'OpenAI-compatible', signal, { callerSignal: request.signal }));
    }
  }
}

function buildChatBody(model: string, request: ModelCompleteRequest, stream: boolean): Record<string, unknown> {
  const reasoningEffort = resolveOpenAiReasoningEffort(request.thinkingLevel);
  return {
    model,
    stream,
    messages: request.messages.map(toOpenAiMessage),
    ...(request.tools?.length ? { tools: request.tools.map(toOpenAiTool) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    // topK 不下发：OpenAI Chat Completions 协议无 top_k 字段，官方 API 传了会 400；
    // 兼容服务里也只有 Anthropic 协议映射 top_k（UI 已标注「仅 Anthropic 生效」）。
    // reasoning_effort：官方值原样下发（off → undefined → 字段缺席），禁止折档。
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {})
  };
}

function listModelsError(diagnostic: {
  severity: string;
  code: string;
  message: string;
}): ModelListResult {
  return { ok: false, error: { code: diagnostic.code, message: diagnostic.message } };
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId
    };
  }
  // 多模态：user 消息带图像时 content 用 parts 数组（data URL 内联）。
  if (message.role === 'user' && message.images && message.images.length > 0) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` }
        }))
      ]
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
  if (toolCalls.length > 0) return 'tool_use';
  // A gateway can announce tool_calls while dropping the malformed/empty
  // function item from the stream. Treat that as an incomplete response so
  // the agent cannot report a successful stop without executing any tool.
  if (reason === 'tool_calls') return 'length';
  if (reason === 'length') return 'length';
  if (reason === 'stop' || !reason) return 'stop';
  return 'stop';
}
