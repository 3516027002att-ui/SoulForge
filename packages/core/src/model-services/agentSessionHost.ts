/**
 * Agent session host: runs one agent session end-to-end — file rollout
 * recording, event emission, cancellation — around runAgentToolLoop.
 * Host-agnostic (no Electron imports): callers inject the sessions base dir,
 * the model adapter and the tool surface. Desktop wires it to userData +
 * credential vault + workspace tool registry.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { runAgentToolLoop, redactSecrets } from './agentLoop.js';
import { FileRolloutStorage, newRolloutFilePath } from './fileRolloutStorage.js';
import { RolloutRecorder } from './rolloutRecorder.js';
import type { ResumedRollout } from './rolloutRecorder.js';
import { estimateContextTokens } from './contextCompactor.js';
import { createTaskModel } from '../semantic/taskModel.js';
import type { CompletionEvidence } from '../semantic/types.js';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentRunResult,
  ApprovalDiff,
  ApprovalRequest,
  ApprovalResponse,
  ChatMessage,
  ChatMessageImage,
  CompactionOptions,
  ContextBroker,
  ContextBrokerOptions,
  ModelServiceAdapter,
  ModelServiceConfig,
  ProviderUsageSample,
  ModelSamplingOptions,
  RetryPolicyOptions,
  ToolCall,
  ToolDefinition
} from './types.js';

export interface AgentSessionRunParams {
  /** Base directory for rollout files (desktop: userData/agent). */
  sessionsDir: string;
  /** Pre-generated session id; defaults to a fresh UUID. */
  sessionId?: string;
  adapter: ModelServiceAdapter;
  config: ModelServiceConfig;
  /** Main-process only — never forwarded to events or renderer payloads. */
  apiKey: string;
  prompt: string;
  /**
   * Current system prompt for this run. Resume strips prior system messages and
   * installs this prompt so an old system contract cannot survive silently.
   */
  systemPrompt?: string;
  permissionMode: AgentPermissionMode;
  tools: ToolDefinition[];
  executeTool: (call: ToolCall, contextOverride?: Record<string, unknown>) => Promise<{
    ok: boolean;
    content: string;
    code?: string;
    completionEvidence?: CompletionEvidence[];
  }>;
  signal?: AbortSignal;
  streaming?: boolean;
  /**
   * Approval gate forwarded to the loop. Absent means no user checkpoint —
   * the mode and registry gates still apply.
   */
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResponse>;
  /** Resolve a unified diff for a pending change; needs filesystem access. */
  resolveApprovalDiff?: (input: {
    toolName: string;
    argumentsJson: string;
  }) => Promise<ApprovalDiff | null>;
  approvalRequiredLevels?: readonly string[];
  /** Workspace evidence assembler injected before each model call. */
  contextBroker?: ContextBroker;
  contextBrokerOptions?: ContextBrokerOptions;
  retryPolicy?: RetryPolicyOptions;
  streamMaxRetries?: number;
  compaction?: CompactionOptions;
  maxSteps?: number;
  timeoutMs?: number;
  maxTotalOutputTokens?: number;
  /** Sampling / capability parameters applied to every model call in this run. */
  sampling?: ModelSamplingOptions;
  /** RAG auto-search hook forwarded to the loop; absent means no auto-injection. */
  ragSearch?: NonNullable<import('./types.js').AgentRunRequest['ragSearch']>;
  /** Prior rollout to continue from; its messages seed the new run. */
  resumeFrom?: ResumedRollout;
  /** Persist every real provider request (including retry/compaction calls). */
  recordProviderUsage?: (sample: ProviderUsageSample) => Promise<void>;
  /**
   * 用户随本条 prompt 提交的图像（多模态）。只挂在本轮 user 消息上下发给
   * 模型，不写入 rollout（rollout 保持文本形态）。
   */
  userImages?: readonly ChatMessageImage[];
  onEvent?: (event: AgentEvent) => void;
  externalTaskGoal?: string;
  currentSubgoal?: string;
  completionContract?: import('./types.js').AgentRunRequest['completionContract'];
  providerCapabilities?: import('./types.js').ModelProviderCapabilities;
  appCommitSha?: string;
  systemPromptVersion?: string;
  toolRegistryVersion?: string;
  resolverVersion?: string;
  semanticIndexRevision?: string;
  ragRevision?: string;
  workspaceRevision?: string;
}

export interface AgentSessionRunResult {
  sessionId: string;
  rolloutPath: string;
  run: AgentRunResult;
}

export async function runAgentSession(params: AgentSessionRunParams): Promise<AgentSessionRunResult> {
  const sessionId = params.sessionId ?? randomUUID();
  const taskModel = createTaskModel(params.externalTaskGoal ?? params.prompt);
  const completionContract = params.completionContract
    ?? taskModel.completionContract;
  const startedAt = new Date();
  const rolloutPath = newRolloutFilePath(params.sessionsDir, sessionId, startedAt);
  const storage = new FileRolloutStorage(rolloutPath);
  const recorder = new RolloutRecorder(storage, {
    sessionId,
    startedAt: startedAt.toISOString(),
    configId: params.config.id,
    protocol: params.config.protocol,
    permissionMode: params.permissionMode,
    ...(params.config.model ? { model: params.config.model } : {})
    ,...(params.appCommitSha ? { appCommitSha: params.appCommitSha } : {})
    ,...(params.systemPromptVersion ? { systemPromptVersion: params.systemPromptVersion } : {})
    ,...(params.systemPrompt ? { systemPromptHash: createHash('sha256').update(params.systemPrompt).digest('hex') } : {})
    ,...(params.toolRegistryVersion ? { toolRegistryVersion: params.toolRegistryVersion } : {})
    ,...(params.resolverVersion ? { resolverVersion: params.resolverVersion } : {})
    ,...(params.semanticIndexRevision ? { semanticIndexRevision: params.semanticIndexRevision } : {})
    ,...(params.ragRevision ? { ragRevision: params.ragRevision } : {})
    ,...(params.workspaceRevision ? { workspaceRevision: params.workspaceRevision } : {})
    ,taskType: taskModel.kind
    ,...(params.providerCapabilities ?? params.config.capabilities
      ? { providerCapabilities: params.providerCapabilities ?? params.config.capabilities } : {})
    ,...(params.adapter.capabilityState
      ? { providerCapabilityState: params.adapter.capabilityState } : {})
    ,...(params.sampling ? { reasoningConfig: params.sampling } : {})
  });
  let providerCallIndex = 0;
  const usagePersistenceErrors: string[] = [];

  const persistUsage = async (
    callIndex: number,
    estimatedContextTokens: number,
    usage?: { inputTokens?: number; outputTokens?: number }
  ): Promise<void> => {
    const providerReported = usage?.inputTokens !== undefined || usage?.outputTokens !== undefined;
    const sample: ProviderUsageSample = {
      callIndex,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      currentContextTokens: usage?.inputTokens ?? estimatedContextTokens,
      contextSource: usage?.inputTokens !== undefined ? 'provider' : 'estimated',
      providerReported,
      recordedAt: new Date().toISOString()
    };
    // The session rollout is the per-session durable audit source.  The
    // desktop callback additionally indexes the same idempotent sample in
    // app.db for fast historical totals in Settings.
    recorder.enqueue({ type: 'provider-usage', ...sample });
    if (!params.recordProviderUsage) return;
    try {
      await params.recordProviderUsage(sample);
    } catch (error) {
      usagePersistenceErrors.push(error instanceof Error ? error.message : String(error));
    }
  };

  const trackedAdapter: ModelServiceAdapter = {
    protocol: params.adapter.protocol,
    listModels: (options) => params.adapter.listModels(options),
    complete: async (request) => {
      const callIndex = ++providerCallIndex;
      const estimated = estimateContextTokens(request.messages);
      const result = await params.adapter.complete(request);
      await persistUsage(callIndex, estimated, result.usage);
      return result;
    },
    stream: async function* (request) {
      const callIndex = ++providerCallIndex;
      const estimated = estimateContextTokens(request.messages);
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        for await (const event of params.adapter.stream(request)) {
          if (event.type === 'usage') {
            if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
            if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
          }
          yield event;
        }
      } finally {
        await persistUsage(callIndex, estimated, {
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {})
        });
      }
    }
  };

  // The loop records only messages it appends; seed the durable record with
  // any prior messages from a resumed session plus this run's user prompt so
  // resume chains stay complete across multiple turns.
  if (params.resumeFrom?.messages && params.resumeFrom.messages.length > 0) {
    for (const message of params.resumeFrom.messages) {
      recorder.enqueue({ type: 'message', step: 0, message });
    }
  }
  recorder.enqueue({ type: 'message', step: 0, message: { role: 'user', content: params.prompt } });

  const messages: ChatMessage[] = [];
  const systemPrompt = params.systemPrompt;
  const resumedMessages = params.resumeFrom ? params.resumeFrom.messages.filter((message) => message.role !== 'system') : [];
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    messages.push({ role: 'system', content: systemPrompt });
    messages.push(...resumedMessages);
  } else {
    messages.push(...resumedMessages);
  }
  messages.push({
    role: 'user',
    content: params.prompt,
    ...(params.userImages && params.userImages.length > 0 ? { images: params.userImages } : {})
  });

  // Deltas are transient UI payloads but still cross a process boundary —
  // redact secret-shaped text before emission, matching the durable policy.
  const emit = (event: AgentEvent): void => {
    if (!params.onEvent) return;
    params.onEvent(
      event.type === 'agent-message-delta' || event.type === 'agent-thinking-delta'
        ? { ...event, text: redactSecrets(event.text) }
        : event
    );
  };

  const run = await runAgentToolLoop(trackedAdapter, {
    config: params.config,
    apiKey: params.apiKey,
    messages,
    tools: params.tools,
    permissionMode: params.permissionMode,
    executeTool: params.executeTool,
    ...(params.maxSteps != null ? { maxSteps: params.maxSteps } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.maxTotalOutputTokens != null ? { maxTotalOutputTokens: params.maxTotalOutputTokens } : {}),
    ...(params.retryPolicy ? { retryPolicy: params.retryPolicy } : {}),
    ...(params.streamMaxRetries != null ? { streamMaxRetries: params.streamMaxRetries } : {}),
    ...(params.streaming != null ? { streaming: params.streaming } : {}),
    ...(params.compaction ? { compaction: params.compaction } : {}),
    ...(params.sampling ? { sampling: params.sampling } : {}),
    ...(params.ragSearch ? { ragSearch: params.ragSearch } : {}),
    externalTaskGoal: params.externalTaskGoal ?? params.prompt,
    ...(params.currentSubgoal ? { currentSubgoal: params.currentSubgoal } : {}),
    ...(params.workspaceRevision ? { workspaceRevision: params.workspaceRevision } : {}),
    ...(completionContract ? { completionContract } : {}),
    ...(params.providerCapabilities ?? params.config.capabilities
      ? { providerCapabilities: params.providerCapabilities ?? params.config.capabilities } : {}),
    ...(params.requestApproval ? { requestApproval: params.requestApproval } : {}),
    ...(params.resolveApprovalDiff ? { resolveApprovalDiff: params.resolveApprovalDiff } : {}),
    ...(params.approvalRequiredLevels
      ? { approvalRequiredLevels: params.approvalRequiredLevels }
      : {}),
    ...(params.contextBroker ? { contextBroker: params.contextBroker } : {}),
    ...(params.contextBrokerOptions
      ? { contextBrokerOptions: params.contextBrokerOptions }
      : {}),
    onEvent: emit,
    rollout: recorder
  });

  if (usagePersistenceErrors.length > 0) {
    run.diagnostics.push({
      severity: 'warning',
      code: 'PROVIDER_USAGE_INDEX_PERSIST_FAILED',
      message: `provider usage 已写入会话 rollout，但 app.db 索引失败 ${usagePersistenceErrors.length} 次。`
    });
  }

  await recorder.close();
  return { sessionId, rolloutPath, run };
}
