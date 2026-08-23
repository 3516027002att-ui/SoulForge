/**
 * Anthropic Messages API compatible adapter.
 */

import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelListResult,
  ModelServiceAdapter,
  StreamEvent,
  ToolDefinition
} from './types.js';
import { resolveAnthropicEffort } from './types.js';
import {
  classifyFetchError,
  classifyHttpError,
  classifyParseError,
  createRequestSignal,
  errorResult,
  errorStreamEvent,
  type ModelServiceDiagnostic
} from './errorClassification.js';
import { normalizeServiceBaseUrl } from './baseUrlJoin.js';

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
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
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
      return errorResult(classifyFetchError(error, 'Anthropic-compatible', signal, { callerSignal: request.signal }));
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

  async listModels(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ModelListResult> {
    const { signal, cleanup } = createRequestSignal(options?.signal, options?.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion
        },
        ...(signal ? { signal } : {})
      });
    } catch (error) {
      cleanup();
      return listModelsError(classifyFetchError(error, 'Anthropic-compatible', signal, { callerSignal: options?.signal }));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return listModelsError(classifyHttpError(
        response.status, text, 'Anthropic-compatible',
        response.headers.get('retry-after')
      ));
    }
    let json: { data?: Array<{ id?: unknown; display_name?: unknown }> };
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      cleanup();
      return listModelsError(classifyParseError(error, 'Anthropic-compatible'));
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
    // Real SSE streaming over POST /v1/messages with stream:true, mirroring the
    // OpenAI Chat Completions adapter. Events parsed: message_start, content_block_*
    // (text_delta / input_json_delta / tool_use), message_delta (stop_reason +
    // output usage), message_stop, and error. Cancellation / timeout / network
    // failures classify exactly like the non-stream path.
    const body = buildMessagesBody(this.model, request, true);
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
      yield errorStreamEvent(classifyFetchError(error, 'Anthropic-compatible', signal, { callerSignal: request.signal }));
      return;
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      cleanup();
      yield errorStreamEvent(classifyHttpError(
        response.status, text, 'Anthropic-compatible',
        response.headers.get('retry-after')
      ));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: Extract<StreamEvent, { type: 'message-stop' }>['finishReason'] = 'stop';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

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
          if (!data || data === '[DONE]') continue;
          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(data) as AnthropicStreamEvent;
          } catch {
            // ignore malformed SSE chunk
            continue;
          }
          const type = event.type;
          if (type === 'content_block_start' && event.content_block?.type === 'tool_use'
            && event.content_block.id && event.content_block.name) {
            toolAcc.set(event.index ?? 0, {
              id: event.content_block.id,
              name: event.content_block.name,
              args: ''
            });
            continue;
          }
          if (type === 'content_block_delta') {
            const delta = event.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              yield { type: 'text-delta', text: delta.text };
            } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
              yield { type: 'thinking-delta', text: delta.thinking };
            } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const index = event.index ?? 0;
              const current = toolAcc.get(index) ?? { id: '', name: '', args: '' };
              current.args += delta.partial_json;
              toolAcc.set(index, current);
            }
            continue;
          }
          if (type === 'message_start' && event.message?.usage?.input_tokens !== undefined) {
            inputTokens = event.message.usage.input_tokens;
            continue;
          }
          if (type === 'message_delta') {
            const stopReason = event.delta?.stop_reason;
            if (stopReason === 'tool_use') finishReason = 'tool_use';
            else if (stopReason === 'max_tokens') finishReason = 'length';
            else if (stopReason === 'end_turn') finishReason = 'stop';
            if (event.usage?.output_tokens !== undefined) {
              outputTokens = event.usage.output_tokens;
            }
            continue;
          }
          if (type === 'error') {
            cleanup();
            yield errorStreamEvent(classifyAnthropicStreamError(event.error));
            return;
          }
          if (type === 'message_stop') {
            cleanup();
            yield* emitFinalEvents(toolAcc, inputTokens, outputTokens, finishReason);
            return;
          }
          // ping and unknown events are ignored
        }
      }
      cleanup();
      yield* emitFinalEvents(toolAcc, inputTokens, outputTokens, finishReason);
    } catch (error) {
      cleanup();
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield errorStreamEvent(classifyFetchError(error, 'Anthropic-compatible', signal, { callerSignal: request.signal }));
    }
  }
}

/**
 * Emit the terminal events of a successful stream: accumulated tool calls, usage
 * (when the server reported it), and the message-stop with the mapped finish
 * reason. A generator so stream() can forward with yield*.
 */
function* emitFinalEvents(
  toolAcc: Map<number, { id: string; name: string; args: string }>,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  finishReason: Extract<StreamEvent, { type: 'message-stop' }>['finishReason']
): Generator<StreamEvent, void, undefined> {
  const hasTool = toolAcc.size > 0;
  for (const tool of toolAcc.values()) {
    yield {
      type: 'tool-call',
      toolCall: { id: tool.id, name: tool.name, argumentsJson: tool.args }
    };
  }
  if (inputTokens !== undefined || outputTokens !== undefined) {
    yield {
      type: 'usage',
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    };
  }
  yield { type: 'message-stop', finishReason: hasTool ? 'tool_use' : finishReason };
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

function classifyAnthropicStreamError(error: { type?: string; message?: string } | undefined): ModelServiceDiagnostic {
  const errType = error?.type;
  const message = error?.message ?? 'Anthropic-compatible 流错误。';
  if (errType === 'rate_limit_error') {
    return { severity: 'error', code: 'MODEL_SERVICE_RATE_LIMITED', message };
  }
  if (errType === 'authentication_error' || errType === 'permission_error') {
    return { severity: 'error', code: 'MODEL_SERVICE_AUTH_ERROR', message };
  }
  if (errType === 'api_error' || errType === 'overloaded_error') {
    return { severity: 'error', code: 'MODEL_SERVICE_SERVER_ERROR', message };
  }
  if (errType === 'invalid_request_error') {
    return { severity: 'error', code: 'MODEL_SERVICE_HTTP_ERROR', message };
  }
  return { severity: 'error', code: 'MODEL_SERVICE_STREAM_FAILED', message };
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
    // 多模态：user 消息带图像时 content 用 parts（base64 source）。
    if (message.role === 'user' && message.images && message.images.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: message.content },
          ...message.images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 }
          }))
        ]
      });
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }

  // 2026 官方 effort：走 output_config.effort。off/未配置 → 不下发，也不要再自动塞
  // thinking.budget_tokens（预算数字不是 effort UI）。none/minimal 是 OpenAI 专有档。
  const effort = resolveAnthropicEffort(request.thinkingLevel);

  return {
    model,
    stream,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
    ...(system ? { system } : {}),
    ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.topK !== undefined ? { top_k: request.topK } : {}),
    ...(effort !== undefined ? { output_config: { effort } } : {})
  };
}

/** Anthropic 无 max_tokens 时的端侧默认（请求层下限，防止无限输出）。 */
const DEFAULT_MAX_TOKENS = 1024;

function listModelsError(diagnostic: {
  severity: string;
  code: string;
  message: string;
}): ModelListResult {
  return { ok: false, error: { code: diagnostic.code, message: diagnostic.message } };
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
