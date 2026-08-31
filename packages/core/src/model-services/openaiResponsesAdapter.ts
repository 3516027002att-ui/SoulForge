/**
 * OpenAI Responses API adapter (`POST /v1/responses`).
 * Distinct from Chat Completions compatible adapter; both normalize to StreamEvent.
 * Credentials never appear in diagnostics or returned DTOs.
 */

import type {
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelListResult,
  ModelServiceAdapter,
  OpenAiReasoningEffort,
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

export interface OpenAiResponsesAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export class OpenAiResponsesAdapter implements ModelServiceAdapter {
  readonly protocol = 'openai-responses' as const;
  readonly transport = 'openai-responses' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesAdapterOptions) {
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const body = buildResponsesBody(this.model, request, false);
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    const attempt = await fetchResponsesWithReasoningFallback({
      fetchResponse: (nextBody) => this.fetchResponses(nextBody, signal),
      model: this.model,
      request,
      stream: false,
      body
    });
    if ('error' in attempt) {
      cleanup();
      return errorResult(classifyFetchError(attempt.error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
    }
    const response = attempt.response;
    if (!response.ok) {
      cleanup();
      return errorResult(classifyHttpError(
        response.status, attempt.errorBody, 'OpenAI Responses',
        response.headers.get('retry-after')
      ));
    }
    let json: ResponsesPayload;
    try {
      json = await response.json() as ResponsesPayload;
    } catch (error) {
      cleanup();
      return errorResult(classifyParseError(error, 'OpenAI Responses'));
    }
    cleanup();
    return parseResponsesPayload(json);
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
      return listModelsError(classifyFetchError(error, 'OpenAI Responses', signal, { callerSignal: options?.signal }));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return listModelsError(classifyHttpError(
        response.status, text, 'OpenAI Responses',
        response.headers.get('retry-after')
      ));
    }
    let json: { data?: Array<{ id?: unknown; display_name?: unknown }> };
    try {
      json = await response.json() as typeof json;
    } catch (error) {
      cleanup();
      return listModelsError(classifyParseError(error, 'OpenAI Responses'));
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
    const body = buildResponsesBody(this.model, request, true);
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    const attempt = await fetchResponsesWithReasoningFallback({
      fetchResponse: (nextBody) => this.fetchResponses(nextBody, signal),
      model: this.model,
      request,
      stream: true,
      body
    });
    if ('error' in attempt) {
      cleanup();
      yield errorStreamEvent(classifyFetchError(attempt.error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
      return;
    }
    const response = attempt.response;
    if (!response.ok || !response.body) {
      cleanup();
      yield errorStreamEvent(classifyHttpError(
        response.status, attempt.errorBody, 'OpenAI Responses',
        response.headers.get('retry-after')
      ));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAcc = new Map<string, { id: string; name: string; args: string }>();
    const toolAliases = new Map<string, string>();
    let sawTool = false;
    const collectToolCalls = (): ToolCall[] => [...toolAcc.values()]
      .filter((tool) => tool.name.trim().length > 0)
      .map((tool) => ({ id: tool.id, name: tool.name, argumentsJson: tool.args }));

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
              for (const toolCall of collectToolCalls()) {
                yield { type: 'tool-call', toolCall };
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
          if (
            (eventType === 'response.reasoning_summary_text.delta'
              || eventType === 'response.reasoning_text.delta'
              || eventType === 'response.reasoning.delta')
            && typeof event.delta === 'string'
            && event.delta.length > 0
          ) {
            yield { type: 'thinking-delta', text: event.delta };
            continue;
          }
          if (eventType === 'response.output_text.delta' && typeof event.delta === 'string') {
            yield { type: 'text-delta', text: event.delta };
            continue;
          }
          if (eventType === 'response.function_call_arguments.delta') {
            const rawKey = event.item_id ?? event.output_index?.toString() ?? '0';
            const key = toolAliases.get(rawKey) ?? rawKey;
            const current = toolAcc.get(key) ?? {
              id: rawKey,
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
              // The Responses stream commonly uses the output item's `id`
              // for argument deltas and the function's `call_id` on the
              // completed item. They describe one call, not two calls.
              const itemId = item.id;
              const callId = item.call_id;
              const candidateKeys = [itemId, callId]
                .filter((value): value is string => typeof value === 'string' && value.length > 0)
                .map((value) => toolAliases.get(value) ?? value);
              let existingKey: string | undefined;
              for (const candidate of candidateKeys) {
                if (toolAcc.has(candidate)) {
                  existingKey = candidate;
                  break;
                }
              }
              if (existingKey === undefined) {
                const matching = [...toolAcc.entries()].find(([, tool]) =>
                  candidateKeys.includes(tool.id)
                );
                existingKey = matching?.[0];
              }
              const previous = existingKey === undefined ? undefined : toolAcc.get(existingKey);
              const id = callId ?? itemId ?? previous?.id ?? 'call';
              if (existingKey !== undefined && existingKey !== id) toolAcc.delete(existingKey);
              toolAcc.set(id, {
                id,
                name: item.name?.trim() ? item.name : previous?.name ?? '',
                args: item.arguments?.length ? item.arguments : previous?.args ?? ''
              });
              for (const candidate of [itemId, callId]) {
                if (candidate) toolAliases.set(candidate, id);
              }
              sawTool = true;
            }
            continue;
          }
          if (eventType === 'response.completed' || eventType === 'response.incomplete') {
            for (const toolCall of collectToolCalls()) {
              yield { type: 'tool-call', toolCall };
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
      for (const toolCall of collectToolCalls()) {
        yield { type: 'tool-call', toolCall };
      }
      yield { type: 'message-stop', finishReason: sawTool ? 'tool_use' : 'stop' };
    } catch (error) {
      cleanup();
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield errorStreamEvent(classifyFetchError(error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
    }
  }

  private fetchResponses(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
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
  stream: boolean,
  reasoningEffortOverride?: OpenAiReasoningEffort
): Record<string, unknown> {
  const reasoningEffort = reasoningEffortOverride ?? resolveOpenAiReasoningEffort(request.thinkingLevel);
  return {
    model,
    stream,
    // function_call / function_call_output 必须是 Responses input 的顶层项；
    // 一个 assistant 消息可能展开为文本消息加一个或多个 function_call。
    input: request.messages.flatMap(toResponsesInputItems),
    ...(request.tools?.length
      ? { tools: request.tools.map(toResponsesTool) }
      : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    // Responses API 的思考档位走 reasoning.effort；要可见的思考摘要时带 summary=auto。
    // topK 协议无此字段不下发。
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort, summary: 'auto' } } : {})
  };
}

type ResponsesFetchAttempt =
  | { response: Response; errorBody: string }
  | { error: unknown };

/**
 * Some gateways expose a Responses endpoint while advertising a narrower
 * reasoning-effort enum for an individual model. Keep the product-level
 * `max` option intact, but recover when the server explicitly tells us which
 * values it accepts. This is deliberately a one-shot, evidence-based retry:
 * unrelated 400s must remain visible to the user and must not be retried.
 */
async function fetchResponsesWithReasoningFallback(options: {
  fetchResponse: (body: Record<string, unknown>) => Promise<Response>;
  model: string;
  request: ModelCompleteRequest;
  stream: boolean;
  body: Record<string, unknown>;
}): Promise<ResponsesFetchAttempt> {
  let response: Response;
  try {
    response = await options.fetchResponse(options.body);
  } catch (error) {
    return { error };
  }
  if (response.ok) return { response, errorBody: '' };

  const firstErrorBody = await response.text().catch(() => '');
  const fallbackEffort = resolveUnsupportedReasoningEffort(options.request, firstErrorBody);
  if (fallbackEffort === undefined) {
    return { response, errorBody: firstErrorBody };
  }

  try {
    response = await options.fetchResponse(
      buildResponsesBody(options.model, options.request, options.stream, fallbackEffort)
    );
  } catch (error) {
    return { error };
  }
  if (response.ok) return { response, errorBody: '' };
  return {
    response,
    errorBody: await response.text().catch(() => '')
  };
}

/**
 * Extract the highest supported fallback from a provider's explicit enum
 * error. The server's list is authoritative for this request; no provider is
 * assumed to support `xhigh` or `max` merely because another one does.
 */
function resolveUnsupportedReasoningEffort(
  request: ModelCompleteRequest,
  bodyText: string
): OpenAiReasoningEffort | undefined {
  if (request.thinkingLevel !== 'max') return undefined;
  if (!/reasoning[.\s_-]*effort/i.test(bodyText)) return undefined;
  const rejectsMax = /unknown variant\s*[`'\"]?max[`'\"]?/i.test(bodyText)
    || /reasoning[.\s_-]*effort[\s\S]{0,160}\bmax\b[\s\S]{0,160}(?:unsupported|not supported|invalid|expected)/i.test(bodyText);
  if (!rejectsMax) return undefined;

  const expectedSection = bodyText.match(/expected\s+one\s+of\s+([\s\S]+)/i)?.[1] ?? '';
  const supported = new Set(
    (expectedSection.match(/\b(?:none|minimal|low|medium|high|xhigh|max)\b/gi) ?? [])
      .map((value) => value.toLowerCase())
  );
  const fallbacks: OpenAiReasoningEffort[] = ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
  return fallbacks.find((effort) => supported.has(effort));
}

function listModelsError(diagnostic: {
  severity: string;
  code: string;
  message: string;
}): ModelListResult {
  return { ok: false, error: { code: diagnostic.code, message: diagnostic.message } };
}

function toResponsesInputItems(message: ChatMessage): Array<Record<string, unknown>> {
  if (message.role === 'tool') {
    return [{
      type: 'function_call_output',
      call_id: message.toolCallId ?? 'unknown',
      output: message.content
    }];
  }
  if (message.role === 'assistant' && message.toolCalls?.length) {
    // Responses API 的 function_call 是 input 顶层 item，不能嵌在
    // assistant message.content 中，否则第二轮请求会被拒绝为 input[n].content 400。
    return [
      ...(message.content
        ? [{
            type: 'message',
            role: 'assistant',
            content: message.content
          }]
        : []),
      ...message.toolCalls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.argumentsJson
      }))
    ];
  }
  // 多模态：user 消息带图像时 content 用 input_* parts（data URL 内联）。
  if (message.role === 'user' && message.images && message.images.length > 0) {
    return [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: message.content },
        ...message.images.map((image) => ({
          type: 'input_image',
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`
        }))
      ]
    }];
  }
  return [{
    type: 'message',
    role: message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content
  }];
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
