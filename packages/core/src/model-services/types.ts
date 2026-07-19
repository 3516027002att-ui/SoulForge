/**
 * Dual model-service contracts for V0.5 (OpenAI-compatible + Anthropic-compatible).
 * Credentials never appear in renderer DTOs or audit payloads.
 */

export type ModelServiceProtocol = 'openai-compatible' | 'anthropic-compatible';

export type AgentPermissionMode = 'plan' | 'normal' | 'fullPermission';
/** @deprecated Prefer fullPermission; kept for reading older app.db grants. */
export type LegacyAgentPermissionMode = 'full';
export type StoredAgentPermissionMode = AgentPermissionMode | LegacyAgentPermissionMode;

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
  /** Required for production policy enforcement; absent definitions are denied in plan mode. */
  permission?: 'read' | 'analyze' | 'propose' | 'stage' | 'validate' | 'commit' | 'rollback';
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
  };
}
