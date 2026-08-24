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
  StreamEvent,
  ToolCall,
  ToolDefinition
} from './types.js';
import { resolveOpenAiReasoningEffort } from './types.js';
import {
  createModelProviderCapabilityState,
  resolveModelProviderCapabilityState,
  type ModelProviderCapabilityPolicy,
  type ModelProviderCapabilityState
} from './providerCapabilities.js';
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
  capabilities?: import('./types.js').ModelProviderCapabilities;
  capabilityPolicy?: ModelProviderCapabilityPolicy;
}

export class OpenAiResponsesAdapter implements ModelServiceAdapter {
  readonly protocol = 'openai-responses' as const;
  readonly transport = 'openai-responses' as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly configuredCapabilities: import('./types.js').ModelProviderCapabilities | undefined;
  private readonly capabilityPolicy: ModelProviderCapabilityPolicy;
  readonly capabilityState: ModelProviderCapabilityState;

  constructor(options: OpenAiResponsesAdapterOptions) {
    this.baseUrl = normalizeServiceBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.configuredCapabilities = options.capabilities;
    this.capabilityPolicy = options.capabilityPolicy ?? 'legacy-defaults';
    this.capabilityState = createModelProviderCapabilityState({
      ...(options.capabilities ? { configured: options.capabilities } : {}),
      policy: this.capabilityPolicy
    });
  }

  async complete(request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    const capabilities = resolveModelProviderCapabilityState({
      ...(request.capabilities ? { request: request.capabilities } : {}),
      ...(this.configuredCapabilities ? { configured: this.configuredCapabilities } : {}),
      policy: this.capabilityPolicy
    });
    const body = buildResponsesBody(this.model, request, false, capabilities.capabilities);
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
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
      return errorResult(classifyFetchError(error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      cleanup();
      return errorResult(classifyHttpError(
        response.status, text, 'OpenAI Responses',
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
    const capabilities = resolveModelProviderCapabilityState({
      ...(request.capabilities ? { request: request.capabilities } : {}),
      ...(this.configuredCapabilities ? { configured: this.configuredCapabilities } : {}),
      policy: this.capabilityPolicy
    });
    const body = buildResponsesBody(this.model, request, true, capabilities.capabilities);
    const { signal, cleanup } = createRequestSignal(request.signal, request.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/responses`, {
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
      yield errorStreamEvent(classifyFetchError(error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
      return;
    }
    if (!response.ok || !response.body) {
      cleanup();
      yield errorStreamEvent(classifyHttpError(
        response.status, '', 'OpenAI Responses',
        response.headers.get('retry-after')
      ));
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
      cleanup();
      if (request.signal?.aborted) {
        yield { type: 'message-stop', finishReason: 'cancelled' };
        return;
      }
      yield errorStreamEvent(classifyFetchError(error, 'OpenAI Responses', signal, { callerSignal: request.signal }));
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
  stream: boolean,
  capabilities: ModelProviderCapabilityState['capabilities']
): Record<string, unknown> {
  const reasoningEffort = capabilities.reasoningEffort === false
    ? undefined
    : resolveOpenAiReasoningEffort(request.thinkingLevel);
  return {
    model,
    stream,
    input: request.messages.map((message) => toResponsesInputItem(message, capabilities.vision)),
    ...(request.tools?.length && capabilities.tools
      ? { tools: request.tools.map(toResponsesTool) }
      : {}),
    ...(request.temperature !== undefined && capabilities.temperature ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined && capabilities.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.topP !== undefined && capabilities.topP ? { top_p: request.topP } : {}),
    // Responses API 的思考档位走 reasoning.effort；要可见的思考摘要时带 summary=auto。
    // topK 协议无此字段不下发。
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort, summary: 'auto' } } : {})
  };
}

function listModelsError(diagnostic: {
  severity: string;
  code: string;
  message: string;
}): ModelListResult {
  return { ok: false, error: { code: diagnostic.code, message: diagnostic.message } };
}

function toResponsesInputItem(message: ChatMessage, visionAllowed: boolean): Record<string, unknown> {
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
  // 多模态：user 消息带图像时 content 用 input_* parts（data URL 内联）。
  if (message.role === 'user' && message.images && message.images.length > 0 && visionAllowed) {
    return {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: message.content },
        ...message.images.map((image) => ({
          type: 'input_image',
          image_url: `data:${image.mediaType};base64,${image.dataBase64}`
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
