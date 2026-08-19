/**
 * Dual model-service contracts for V0.5 (OpenAI-compatible + Anthropic-compatible).
 * Credentials never appear in renderer DTOs or audit payloads.
 */

import type { RagRetrieveResult } from '@soulforge/shared';

export type ModelServiceProtocol = 'openai-compatible' | 'anthropic-compatible';

export type AgentPermissionMode = 'plan' | 'normal' | 'full';

/**
 * 旧配置里的遗留档位（fast/normal/deep/extreme）。只在读路径兼容映射，
 * 写路径只写官方 effort 值（fast→low、normal→medium、deep→high、extreme→max）。
 */
export type LegacyThinkingLevel = 'fast' | 'normal' | 'deep' | 'extreme';

/**
 * 思考强度：官方 effort 档位（2026-08-19 对照 OpenAI / Anthropic 文档核实）。
 * `off` 是不下发任何 effort / thinking 字段，也是默认值。
 * `none` / `minimal` 是 OpenAI-only；`xhigh` / `max` 是官方档，禁止折成 high。
 * Anthropic 协议只有 off/low/medium/high/xhigh/max（官方没有 none/minimal）。
 */
export type ModelThinkingLevel =
  | 'off'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export function isModelThinkingLevel(value: string): value is ModelThinkingLevel {
  return value === 'off' || value === 'none' || value === 'minimal'
    || value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max';
}

/** 读路径兼容：遗留档 → 官方档；未知值回退默认档 medium。 */
export function migrateThinkingLevel(level: string): ModelThinkingLevel {
  switch (level) {
    case 'fast': return 'low';
    case 'normal': return 'medium';
    case 'deep': return 'high';
    case 'extreme': return 'max';
    default: return isModelThinkingLevel(level) ? level : 'medium';
  }
}

export type OpenAiReasoningEffort = Exclude<ModelThinkingLevel, 'off'>;

/**
 * OpenAI 兼容（chat `reasoning_effort` / responses `reasoning.effort`）映射；
 * off/未配置返回 undefined（不下发）。官方值原样下发，禁止把 max 折成 high。
 * 遗留档（fast/normal/deep/extreme）读路径兼容映射（deep→high、extreme→max）。
 */
export function resolveOpenAiReasoningEffort(
  level: ModelThinkingLevel | LegacyThinkingLevel | undefined
): OpenAiReasoningEffort | undefined {
  if (level === undefined || level === 'off') return undefined;
  switch (level) {
    case 'fast': return 'low';
    case 'normal': return 'medium';
    case 'deep': return 'high';
    case 'extreme': return 'max';
    default: return level;
  }
}

export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Anthropic `output_config.effort` 映射；off/未配置返回 undefined（不下发）。
 * none/minimal 是 OpenAI 专有档，Anthropic 不下发。遗留档读路径兼容映射。
 */
export function resolveAnthropicEffort(
  level: ModelThinkingLevel | LegacyThinkingLevel | undefined
): AnthropicEffort | undefined {
  if (level === undefined || level === 'off') return undefined;
  switch (level) {
    case 'fast': return 'low';
    case 'normal': return 'medium';
    case 'deep': return 'high';
    case 'extreme': return 'max';
    case 'none':
    case 'minimal': return undefined;
    default: return level;
  }
}

/**
 * 遗留 `thinking.budget_tokens` 映射：仅「明确仍走 manual extended thinking」的
 * 内部路径可用；**UI 与下拉不得再走这条路**（2026 的 Anthropic 用 output_config.effort，
 * budget_tokens 数字不得冒充 effort）。
 */
export function resolveAnthropicThinkingBudget(
  level: ModelThinkingLevel | LegacyThinkingLevel | undefined
): number | undefined {
  switch (level) {
    case 'fast': return 2048;
    case 'normal': return 4096;
    case 'deep': return 8192;
    case 'extreme': return 16384;
    default: return undefined;
  }
}

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
  /**
   * Permission level this tool requires, carried through from the registry.
   * The loop needs it to decide which calls hit the approval gate; without it
   * the gate would have to re-derive severity from the tool name, which is
   * exactly the kind of second source that drifts.
   */
  permissionLevel?: string;
  /**
   * When true, consecutive calls of this tool in one model turn may execute
   * concurrently; results are still recorded in model emission order.
   * Default false — exclusive, serialized execution (Codex
   * supports_parallel_tool_calls semantics).
   */
  supportsParallel?: boolean;
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
  /** top-p 采样；0..1，未配置不下发。 */
  topP?: number;
  /** top-k 采样；仅 Anthropic 协议生效（OpenAI Chat Completions 无此字段）。 */
  topK?: number;
  /** 思考强度；off/未配置不下发。 */
  thinkingLevel?: ModelThinkingLevel;
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

/** 一个可用模型的目录条目（GET /v1/models 的 data[].id 投影）。 */
export interface ModelListEntry {
  id: string;
  displayName?: string;
}

export type ModelListResult =
  | { ok: true; models: ModelListEntry[] }
  | { ok: false; error: { code: string; message: string } };

export interface ModelServiceAdapter {
  readonly protocol: ModelServiceProtocol;
  complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>;
  stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined>;
  /**
   * 拉取该服务可用模型列表（GET /v1/models）。失败返回结构化诊断，
   * 绝不吞异常 —— 调用方用它决定「显示错误」还是「退回手填模型名」。
   */
  listModels(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ModelListResult>;
}

/**
 * 每次模型调用的采样/能力参数。全部可选：未配置时用 provider 默认值，
 * 任何字段都不作请求层之外的强约束。
 */
export interface ModelSamplingOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  thinkingLevel?: ModelThinkingLevel;
}

export interface RetryPolicyOptions {
  /** Total attempts including the first. Default 4, capped at 100. */
  maxAttempts?: number;
  /** Initial backoff delay in milliseconds. Default 200. */
  baseDelayMs?: number;
  /** Exponential backoff factor. Default 2. */
  backoffFactor?: number;
  /** Symmetric jitter ratio applied to each delay. Default 0.1 (±10%). */
  jitterRatio?: number;
  /** Upper bound for any single computed delay. Default 30000. */
  maxDelayMs?: number;
}

/**
 * Agent-level events emitted during a run (Codex EventMsg subset). Deltas are
 * transient — rollout persistence decides separately which items are durable.
 */
/**
 * Approval decision for one tool call (Codex approval-request semantics).
 *
 * `once` / `reject` apply to this call only. `always` / `never` additionally
 * seed a session-scoped memory keyed by tool name, so the same tool is not
 * re-asked in this session. The memory is deliberately session-scoped and
 * in-memory: persisting "always allow" across sessions would let a decision
 * made in one workspace silently authorize another.
 */
export type ApprovalDecision =
  | 'once'
  | 'always'
  | 'reject'
  | 'never'
  /**
   * 无人回答，由宿主按超时结算。
   *
   * 独立于 `reject` 而不是并入它：审计里「用户拒绝了这次写入」与「没人回答、
   * 超时后按拒绝处理」是两个不同事实。并成一个会让「审批通道没人看」在事后
   * 看起来像「用户认真拒绝过」，而这两种情况的后续动作不同——前者要改方案，
   * 后者要看是不是没人在场。
   *
   * 与 Codex 的 ReviewDecision 对齐：那里 `timed_out` 也是与 `denied` 平级的
   * 独立取值（codex-rs/app-server-protocol/schema/typescript/ReviewDecision.ts）。
   */
  | 'timed_out'
  /**
   * 放弃整个任务，不只是拒绝这一次调用。
   *
   * 同样取自 Codex 的 ReviewDecision。`reject` 之后 loop 会带着拒绝结果继续
   * 下一步，模型可能换个方式再试；`abort` 表示用户不想让这轮继续下去。
   */
  | 'abort';

/** 会进入会话记忆的决定：只有这两个跨调用生效。 */
export const APPROVAL_DECISIONS_WITH_MEMORY: readonly ApprovalDecision[] =
  Object.freeze(['always', 'never']);

/** 阻止本次调用执行的决定。 */
export const APPROVAL_DECISIONS_DENYING: readonly ApprovalDecision[] =
  Object.freeze(['reject', 'never', 'timed_out', 'abort']);

export interface ApprovalRequest {
  step: number;
  callId: string;
  toolName: string;
  /** Permission level the tool declares; drives the UI's severity grouping. */
  permissionLevel: string;
  /**
   * Redacted arguments as the model emitted them. Present so the user approves
   * a concrete action rather than a bare tool name — "write a file" and
   * "write THIS file" are different decisions.
   */
  argumentsJson: string;
  /**
   * Unified diff of the pending change, when the host can resolve one.
   *
   * The host (not the loop) computes this: it needs filesystem access to read
   * the current file, which the loop deliberately does not have. Absent means
   * "the host could not produce a diff" — a distinct state from "there are no
   * changes", and the UI must say which one it is rather than showing an empty
   * diff pane.
   */
  diff?: ApprovalDiff;
}

export interface ApprovalDiff {
  /** Path shown in the diff header; workspace-relative where possible. */
  targetPath: string;
  /** Unified diff text (`--- / +++ / @@` form) produced by createUnifiedDiff. */
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  /** True when the target file does not exist yet — every line is an addition. */
  newFile: boolean;
  /** Set when the diff was shortened; names what was dropped. */
  truncatedNote?: string;
}

export interface ApprovalResponse {
  decision: ApprovalDecision;
  /** Optional user-facing note recorded in the audit trail. */
  note?: string;
}

export type AgentEvent =
  | { type: 'turn-started'; step: number }
  | { type: 'agent-message-delta'; step: number; text: string }
  | { type: 'tool-call-begin'; step: number; callId: string; name: string; argumentsJson?: string }
  | { type: 'tool-call-end'; step: number; callId: string; name: string; ok: boolean; code?: string }
  | {
      type: 'approval-requested';
      step: number;
      callId: string;
      toolName: string;
      permissionLevel: string;
      argumentsJson: string;
      /** Present when the host resolved a unified diff for this change. */
      diff?: ApprovalDiff;
    }
  | {
      type: 'approval-resolved';
      step: number;
      callId: string;
      toolName: string;
      decision: ApprovalDecision;
      /** True when answered from the session memory rather than a fresh prompt. */
      fromMemory: boolean;
    }
  | { type: 'retry-scheduled'; step: number; attempt: number; maxAttempts: number; delayMs: number; code: string }
  | { type: 'context-assembled'; step: number; sections: number; totalBytes: number }
  | { type: 'context-compacted'; step: number; reason: 'auto' | 'overflow'; tokenLimit: number }
  | { type: 'step-complete'; step: number; finishReason: string }
  | { type: 'turn-complete'; finishReason: string; steps: number };

/**
 * Durable rollout items (Codex RolloutItem subset). Append-only JSONL; the
 * storage location is injected by the caller — never the Mod workspace.
 */
export interface RolloutSessionMeta {
  sessionId: string;
  startedAt: string;
  configId: string;
  protocol: ModelServiceProtocol;
  permissionMode: AgentPermissionMode;
  model?: string;
}

export type RolloutItem =
  | { type: 'session-meta'; meta: RolloutSessionMeta }
  | { type: 'message'; step: number; message: ChatMessage }
  | {
      type: 'compacted';
      at: string;
      windowId: string;
      /**
       * 压缩后的完整替换历史（Codex RolloutItem::Compacted 的 replacement_history）。
       * resume 时用它重建压缩窗口内的历史——否则承接会话会恢复出压缩前的
       * 完整膨胀历史，压缩等于白做且可能再次溢出。旧条目（无此字段）向后兼容：
       * 只计数、不替换。
       */
      replacementHistory?: ChatMessage[];
    }
  | { type: 'interrupted'; at: string }
  | { type: 'rollback-marker'; at: string; keepLastUserTurns: number };

/** Minimal sink the agent loop needs; RolloutRecorder implements it. */
export interface RolloutSink {
  enqueue(item: RolloutItem): void;
  flush(): Promise<void>;
}

export interface CompactionOptions {
  /**
   * Auto-compaction trigger: when the estimated context tokens reach this
   * limit before a model call, the history is summarized and replaced.
   * Auto-compaction is off when unset.
   */
  autoCompactTokenLimit?: number;
  /** Token budget for recent user messages kept verbatim. Default 20000. */
  userMessageBudgetTokens?: number;
  /**
   * Max output tokens for the summarization request itself. Default 4096 —
   * Anthropic adapters would otherwise cap summaries at their 1024 fallback.
   */
  summaryMaxTokens?: number;
  summarizationPrompt?: string;
  summaryPrefix?: string;
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
  /**
   * Sampling / capability parameters applied to every model call in this run.
   * All fields optional; absent means the provider default. Host-level only —
   * never constructed from raw renderer input.
   */
  sampling?: ModelSamplingOptions;
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
  /**
   * Retry/backoff policy for model calls (Codex request-level semantics).
   * Defaults to 4 attempts with 200ms×2^n ±10% jitter.
   */
  retryPolicy?: RetryPolicyOptions;
  /** Retry budget for the streaming path. Default 5. */
  streamMaxRetries?: number;
  /** Consume adapter.stream() instead of complete(); requires onEvent for deltas. */
  streaming?: boolean;
  /**
   * Approval gate. When present, every tool call whose permission level is in
   * `approvalRequiredLevels` must be approved before it executes.
   *
   * Absent means no approval layer — which is the pre-existing behavior, not a
   * silent allow: without this callback the loop still enforces
   * isToolAllowedInMode plus the registry's own permission ladder. The gate
   * adds a *user* checkpoint on top of those, it does not replace them, so a
   * host that forgets to wire it cannot thereby elevate anything.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /**
   * Resolve a unified diff for a pending tool call, when one applies.
   *
   * Supplied by the host because computing it needs filesystem access to read
   * the current file — the loop has none, and giving it any would make the
   * "tools are the only way the agent touches the workspace" boundary softer.
   * Returning null means "no diff for this call" (not an error): a rollback or
   * a query has nothing to diff.
   */
  resolveApprovalDiff?: (input: {
    toolName: string;
    argumentsJson: string;
  }) => Promise<ApprovalDiff | null>;
  /**
   * Permission levels that require approval. Defaults to the write-capable
   * levels (stage/commit/rollback) when `requestApproval` is provided.
   * An empty array means "approve nothing", which disables the gate.
   */
  approvalRequiredLevels?: readonly string[];
  /** Agent-level event sink (turn lifecycle, deltas, tool spans, retries). */
  onEvent?: (event: AgentEvent) => void;
  /** Append-only session recorder; flushed before the run returns. */
  rollout?: RolloutSink;
  /** Context compaction behavior; auto-compaction requires autoCompactTokenLimit. */
  compaction?: CompactionOptions;
  /**
   * RAG auto-search hook (host-injected; the loop holds no corpus).
   *
   * When present, before each model call the loop uses the most recent user
   * message as the query, retrieves workspace evidence, and injects a
   * `[rag-evidence query=… hits=N]` system message (a separate channel from
   * contextBroker, which only assembles given tool-result evidence). No hits
   * or an empty query → nothing is injected. `maxHits` caps injected hits
   * (default 4, capped at 8).
   */
  ragSearch?: {
    retrieve: (query: string) => Promise<RagRetrieveResult>;
    maxHits?: number;
  };
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
    /** True when the run consumed adapter.stream() instead of complete(). */
    streaming?: boolean;
    /** Retry/backoff log — one entry per scheduled retry. */
    retries?: Array<{ step: number; attempt: number; code: string; delayMs: number }>;
    /** Compaction log — one entry per applied context compaction. */
    compactions?: Array<{ step: number; reason: 'auto' | 'overflow'; tokenLimit: number; summaryBytes: number }>;
    /**
     * Approval log — one entry per gated tool call, including the ones answered
     * from session memory. A denial must leave a trace: "the agent did not run
     * that tool" and "the user refused it" are different facts.
     */
    approvals?: Array<{
      name: string;
      permissionLevel: string;
      decision: ApprovalDecision;
      fromMemory: boolean;
      note?: string;
    }>;
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
