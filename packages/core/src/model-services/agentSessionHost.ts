/**
 * Agent session host: runs one agent session end-to-end — file rollout
 * recording, event emission, cancellation — around runAgentToolLoop.
 * Host-agnostic (no Electron imports): callers inject the sessions base dir,
 * the model adapter and the tool surface. Desktop wires it to userData +
 * credential vault + workspace tool registry.
 */

import { randomUUID } from 'node:crypto';
import { runAgentToolLoop, redactSecrets } from './agentLoop.js';
import { FileRolloutStorage, newRolloutFilePath } from './fileRolloutStorage.js';
import { RolloutRecorder } from './rolloutRecorder.js';
import type { ResumedRollout } from './rolloutRecorder.js';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentRunResult,
  ApprovalDiff,
  ApprovalRequest,
  ApprovalResponse,
  ChatMessage,
  CompactionOptions,
  ContextBroker,
  ContextBrokerOptions,
  ModelServiceAdapter,
  ModelServiceConfig,
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
   * Optional system prompt prepended ahead of every message in this run. Only
   * injected when no `role === 'system'` message already exists (a resumed
   * session may carry one from an earlier run).
   */
  systemPrompt?: string;
  permissionMode: AgentPermissionMode;
  tools: ToolDefinition[];
  executeTool: (call: ToolCall) => Promise<{ ok: boolean; content: string; code?: string }>;
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
  /** Prior rollout to continue from; its messages seed the new run. */
  resumeFrom?: ResumedRollout;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentSessionRunResult {
  sessionId: string;
  rolloutPath: string;
  run: AgentRunResult;
}

export async function runAgentSession(params: AgentSessionRunParams): Promise<AgentSessionRunResult> {
  const sessionId = params.sessionId ?? randomUUID();
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
  });

  // The loop records only messages it appends; seed the durable record with
  // this run's user prompt so resume chains stay complete.
  recorder.enqueue({ type: 'message', step: 0, message: { role: 'user', content: params.prompt } });

  const messages: ChatMessage[] = [];
  const systemPrompt = params.systemPrompt;
  if (systemPrompt !== undefined && systemPrompt.length > 0) {
    const resumedMessages = params.resumeFrom ? params.resumeFrom.messages : [];
    const alreadyHasSystem = resumedMessages.some((message) => message.role === 'system');
    if (!alreadyHasSystem) {
      messages.push({ role: 'system', content: systemPrompt });
    }
  }
  messages.push(...(params.resumeFrom ? params.resumeFrom.messages : []), { role: 'user', content: params.prompt });

  // Deltas are transient UI payloads but still cross a process boundary —
  // redact secret-shaped text before emission, matching the durable policy.
  const emit = (event: AgentEvent): void => {
    if (!params.onEvent) return;
    params.onEvent(
      event.type === 'agent-message-delta'
        ? { ...event, text: redactSecrets(event.text) }
        : event
    );
  };

  const run = await runAgentToolLoop(params.adapter, {
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

  await recorder.close();
  return { sessionId, rolloutPath, run };
}
