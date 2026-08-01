/**
 * Dual model-service contracts for V0.5 (OpenAI-compatible + Anthropic-compatible).
 * Credentials never appear in renderer DTOs or audit payloads.
 */

export type ModelServiceProtocol = 'openai-compatible' | 'anthropic-compatible';

export type AgentPermissionMode = 'plan' | 'normal' | 'full';

export interface ModelServiceConfig {
  id: string;
  displayName: string;
  protocol: ModelServiceProtocol;
  baseUrl: string;
  model: string;
  /** Redacted marker only — never the raw secret. */
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelServiceCredentialRef {
  configId: string;
  /** DPAPI/safeStorage ciphertext handle — opaque to renderer. */
  secretRef: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'message-stop'; finishReason: 'stop' | 'tool_use' | 'length' | 'cancelled' | 'error' }
  | { type: 'error'; code: string; message: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };

export interface ModelCompleteRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. When elapsed, the request is aborted. */
  timeoutMs?: number;
}

export interface ModelCompleteResult {
  message: ChatMessage;
  finishReason: 'stop' | 'tool_use' | 'length' | 'cancelled' | 'error';
  usage?: { inputTokens?: number; outputTokens?: number };
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
}

export interface ModelServiceAdapter {
  readonly protocol: ModelServiceProtocol;
  complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>;
  stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined>;
}

export interface AgentRunRequest {
  config: ModelServiceConfig;
  /** Resolved only in main/core — never passed to renderer. */
  apiKey: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  permissionMode: AgentPermissionMode;
  /** Tool executor returns tool result content or policy denial. */
  executeTool: (call: ToolCall) => Promise<{ ok: boolean; content: string; code?: string }>;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Per-LLM-call timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum total output tokens across all steps. When exceeded, the loop stops. */
  maxTotalOutputTokens?: number;
  /**
   * Optional Context Broker: assembles workspace evidence (readFile, resource
   * graph, diagnostics, patch-plan context, prior tool results) into bounded,
   * redacted context fragments injected before each model call. When absent,
   * the loop keeps its original behavior.
   */
  contextBroker?: ContextBroker;
  contextBrokerOptions?: ContextBrokerOptions;
}

export interface AgentRunResult {
  messages: ChatMessage[];
  steps: number;
  finishReason: string;
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
  /** Audit-safe copy with secrets redacted. */
  audit: {
    configId: string;
    protocol: ModelServiceProtocol;
    permissionMode: AgentPermissionMode;
    toolCalls: Array<{ name: string; ok: boolean; code?: string }>;
    redacted: true;
    /**
     * Context Broker assembly log — metadata only, never evidence content.
     * Populated when `contextBroker` is provided on the run request.
     */
    contextAssemblies?: Array<{
      ok: boolean;
      sections: number;
      totalBytes: number;
      code?: 'insufficient_evidence' | 'CONTEXT_LIMIT_EXCEEDED' | 'CONTEXT_CANCELLED' | 'CONTEXT_TIMEOUT';
    }>;
  };
}

// ---------------------------------------------------------------------------
// Context Broker — evidence/context assembly layer (G-AGENT / W-AI-CONFORMANCE-03).
// Assembles workspace evidence into bounded, redacted context fragments that are
// injected before each model call. Never contains raw credentials.
// ---------------------------------------------------------------------------

export type ContextEvidenceKind =
  | 'readFile'
  | 'resourceGraph'
  | 'diagnostics'
  | 'patchPlan'
  | 'toolResult';

export interface ContextEvidenceSource {
  kind: ContextEvidenceKind;
  uri?: string;
  /** Directly supplied evidence text. */
  text?: string;
  /** Structured payload; serialized at assembly time. */
  payload?: unknown;
  /**
   * Async evidence reader (e.g. readFile). When present it takes precedence;
   * cancellation/timeout can interrupt a pending read.
   */
  readText?: () => Promise<string>;
  /** Source metadata (sha256, sizeBytes, resourceKind...); recorded, not injected. */
  meta?: Record<string, unknown>;
  /** Original byte size; estimated from text length when absent. */
  sourceBytes?: number;
}

export interface ContextBrokerOptions {
  /** Hard cap on the assembled context bytes. Default 12000. */
  maxBytes?: number;
  /** Maximum evidence sections included. Default 16. */
  maxEntries?: number;
  /** Per-section excerpt length. Default 600. */
  excerptLength?: number;
  /** Assembly timeout in milliseconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ContextSectionRecord {
  kind: ContextEvidenceKind;
  uri?: string;
  excerptLength: number;
  sourceBytes: number;
  truncated: boolean;
  redacted: boolean;
}

export type ContextBrokerResult =
  | {
      ok: true;
      context: string;
      sections: ContextSectionRecord[];
      totalBytes: number;
      diagnostics: [];
    }
  | {
      ok: false;
      code: 'insufficient_evidence' | 'CONTEXT_LIMIT_EXCEEDED' | 'CONTEXT_CANCELLED' | 'CONTEXT_TIMEOUT';
      message: string;
      diagnostics: [{ severity: 'error'; code: string; message: string }];
    };

export interface ContextBroker {
  assemble(sources: ContextEvidenceSource[], options?: ContextBrokerOptions): Promise<ContextBrokerResult>;
}
