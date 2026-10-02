/** Logical renderer DTOs. No main-process or Electron imports. */
import type {
  AgentResourceReference,
  BridgeResult,
  Diagnostic,
  IndexedFile,
  PatchHistoryEntry,
  ResourceKind,
  ResourcePreview,
  SaveTextResourceResult
} from '@soulforge/shared';
import type {
  AgentEvent,
  ApprovalDecision,
  ChatMessage,
  RolloutSessionMeta,
  ToolDescriptor
} from '@soulforge/core';

export interface AnalyzeWorkspaceSummary {
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
  diagnostics: Diagnostic[];
  events: Array<{ uri: string; eventId: number; name?: string }>;
  tools: ToolDescriptor[];
}

export interface RendererWorkspaceSession {
  workspaceSessionId: string;
  workspaceLabel: string;
  game: string;
  openedAt: string;
  baseMounted: boolean;
  baseLabel?: string;
}

export interface WorkspaceIndexingStatus {
  workspaceSessionId: string | null;
  phase: 'idle' | 'hashing' | 'persisting' | 'rag' | 'ready' | 'failed';
  current: number;
  total: number;
  message: string;
  elapsedMs?: number;
}

export interface RendererWorkspaceScanResult {
  workspaceSessionId: string;
  workspaceLabel: string;
  files: RendererIndexedFile[];
  countsByKind: Record<ResourceKind, number>;
  diagnostics: Diagnostic[];
  session: RendererWorkspaceSession;
  indexingStatus: WorkspaceIndexingStatus;
}

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
  knowledgeRefresh?: NonNullable<SaveTextResourceResult['knowledgeRefresh']>;
}

/* ------------------------------------------------------------------ */
/*  AI agent session IPC contract (Codex-derived kernel).             */
/*  Keys never cross the bridge; events are redacted by the host.     */
/* ------------------------------------------------------------------ */

export interface AiAgentRunRequest {
  configId: string;
  prompt: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  permissionGrantId?: string;
  streaming?: boolean;
  /** Session-relative rollout path as returned by ai.agent.sessions. */
  resumeSessionPath?: string;
  /** Optional per-run ceiling; omitted uses the core's safe default. */
  maxSteps?: number;
  /**
   * Per-model-call timeout. Before this was exposed, the loop ran with no
   * timeout at all: a provider that accepted the connection and then stalled
   * left the session running until the user cancelled it by hand.
   */
  timeoutMs?: number;
  /** Total output token budget across all steps; the loop stops when exceeded. */
  maxTotalOutputTokens?: number;
  /**
   * Auto-compaction trigger in estimated context tokens. Compaction is
   * implemented but never fired in production, because reaching it requires
   * this value and nothing supplied one.
   */
  autoCompactTokenLimit?: number;
  /** Retry attempts for model calls; the loop defaults to 4 when unset. */
  retryMaxAttempts?: number;
  /** Assemble workspace evidence into bounded context before each model call. */
  useContextBroker?: boolean;
  /** Byte ceiling for Context Broker output; ignored unless useContextBroker. */
  contextMaxBytes?: number;
  /**
   * 2-A：本次任务的思考强度（官方 effort 档：off/none/minimal/low/medium/high/xhigh/max），
   * 优先于服务级默认。作用于下一次 runAgentTask，不要求用户进设置页。
   */
  thinkingLevel?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * RAG auto-search: once per run, retrieve workspace evidence from the fixed
   * external prompt and inject a [rag-evidence] system message. The cached
   * candidate is re-injected after compaction without repeating provider/DB
   * work. Default false; requires an analyzed workspace (activeRag corpus).
   */
  useRagSearch?: boolean;
  /** Cap on injected rag-evidence hits per turn (1..8). */
  ragSearchMaxHits?: number;
  /**
   * Legacy compatibility field. Main ignores renderer-supplied values; the
   * effective approval policy comes from the main-issued permission grant.
   */
  approvalRequiredLevels?: string[];
  /**
   * main-issued opaque resource references (§12.11 SubmitAgentRunRequest)。
   *
   * AGENT-60D 提交期消费点：每个 token 必须已在 agentReferenceRegistry 签发，
   * 且 ownerId 与当前 sender 一致（跨 sender 拒绝）。未传或空数组 = 无引用。
   */
  resources?: readonly AgentResourceReference[];
  /**
   * 当前选区（可选元数据，T6）：逻辑名 + 资源 kind。作为系统提示的一部分给模型
   * 参考，**不是**默认任务对象，renderer 不把 `#路径` 自动写进 prompt 文本。
   * main 装配（appends to systemPrompt）；未选中时不传。
   */
  selection?: {
    label: string;
    resourceKind: ResourceKind;
  };
  /**
   * 最近一次资源打开失败（可选元数据，S15/S19 失败面）：打开 KRAK / 读取失败的
   * 资源时，renderer 把结构化失败随下一次任务提交。main 校验后附进系统提示，
   * 让 Agent 直接解释原因与下一步，而不是等用户复制日志。
   *
   * 只允许逻辑名（相对路径 / basename），不含绝对路径；main 对每个字符串做
   * 失败关闭校验（命中盘符 / UNC / file:/// 一律拒绝整次请求）。
   */
  openFailure?: {
    kind:
      | 'event-open-failed'
      | 'msb-open-failed'
      | 'fmg-open-failed'
      | 'param-open-failed'
      | 'script-open-failed'
      | 'tae-open-failed';
    document: string;
    code: string;
    message: string;
  };
}

/** Renderer's answer to one approval request (ai.agent.approval.respond). */
export interface AiAgentApprovalResponseRequest {
  sessionId: string;
  callId: string;
  decision: ApprovalDecision;
  note?: string;
}

export type AiAgentRunIpcResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentPermissionRequestResult =
  | { ok: true; grantId: string; mode: 'plan' | 'normal' | 'fullPermission'; expiresAt: string }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentCancelIpcResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

export interface AiAgentSessionSummaryIpc {
  /** Path relative to the agent sessions dir; opaque to the renderer. */
  sessionPath: string;
  fileName: string;
  sessionId: string | null;
  startedAt: string | null;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  sizeBytes: number;
  modifiedAt: string;
}

export type AiAgentSessionListIpcResult =
  | { ok: true; sessions: AiAgentSessionSummaryIpc[] }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLoadIpcResult =
  | {
      ok: true;
      meta: RolloutSessionMeta | null;
      messageCount: number;
      parseErrors: number;
      interrupted: boolean;
      compactedWindows: number;
      /** Bounded tail page (hard constraint 17). */
      messagesPage: ChatMessage[];
    }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLifecycleEvent =
  | { type: 'session-accepted'; mode: 'plan' | 'normal' | 'fullPermission' }
  | { type: 'session-mode-switched'; mode: 'plan' | 'normal' | 'fullPermission' }
  | { type: 'session-done'; finishReason: string; steps: number; rolloutFileName: string }
  | { type: 'session-error'; code: string; message: string };

/** Envelope pushed on the 'ai:agent:event' channel. */
export interface AiAgentEventEnvelope {
  sessionId: string;
  /**
   * §12.11 严格递增 seq：同一 session 的推送必须严格递增。main 侧按 session 单调
   * 盖章，renderer 侧对重复 / 倒序 seq 丢弃并记诊断（见 shared agent-ui 的
   * applyAgentStreamSeq / reduceAgentStreamToMessages）。
   */
  seq: number;
  event: AgentEvent | AiAgentSessionLifecycleEvent;
}

/**
 * 补取 run 返回前已经产生的 agent 事件。推送仍是实时通道，回放只是
 * 为 renderer 建立 session 状态前的短竞态提供可靠补偿；调用方按 seq 去重。
 */
export type AiAgentEventReplayIpcResult =
  | { ok: true; events: AiAgentEventEnvelope[]; truncated?:boolean; firstAvailableSeq?:number|null }
  | { ok: false; error: { code: string; message: string } };

/** §12.11 资源引用 token 校验结果（agent 通道专用；不是 param/format 读取）。 */
export type AgentResourceReferenceCreateIpcResult =
  | { ok: true; reference: AgentResourceReference }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        diagnostics?: readonly { code: string; path: string; message: string }[];
      };
    };

export type AgentAttachmentCreateIpcResult =
  | {
      ok: true;
      reference: {
        token: string;
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain';
        byteLength: number;
        expiresAt: string;
      };
      label: string;
    }
  | {
      ok: false;
      cancelled?: boolean;
      error: { code: string; message: string };
    };

export interface DirectorySelection {
  selectionId: string;
  label: string;
}

export interface OpenWorkspaceScanOptions {
  overlaySelectionId: string;
  baseSelectionId?: string;
  /** 显式卸掉原版：不带 base，并忘掉最近一次原版目录。 */
  clearBase?: boolean;
}

export type RendererIndexedFile = Omit<
  IndexedFile,
  'id' | 'workspaceId' | 'sourcePath' | 'absolutePath'
>;

export type RendererBridgeResult<T = unknown> = Omit<BridgeResult<T>, 'sourcePath'>;

export type RendererResourcePreview = Omit<
  ResourcePreview,
  'file' | 'nativeInspection' | 'diagnostics'
> & {
  file: RendererIndexedFile;
  nativeInspection?: RendererBridgeResult<unknown>;
  diagnostics: Diagnostic[];
};

export type RendererSaveResult = Omit<
  SaveTextResourceResult,
  'backupRoot' | 'changedFiles' | 'diagnostics'
> & {
  changedFiles: string[];
  diagnostics: Diagnostic[];
  /** 成功 native 写回后的新 revision，供 renderer 失效旧文档状态。 */
  sourceHash?: string;
  sourceRevision?: number;
};

export type RendererPatchHistoryEntry = Omit<
  PatchHistoryEntry,
  'workspaceId' | 'changedPaths'
> & {
  changedPaths: string[];
};

export type NativeWindowThemeMode = 'opal' | 'obsidian';

export type NativeWindowThemeResult =
  | { ok: true }
  | { ok: false; code: 'WINDOW_THEME_MODE_INVALID' | 'WINDOW_THEME_WINDOW_UNAVAILABLE' | 'WINDOW_THEME_APPLY_FAILED' | 'WINDOW_THEME_OVERLAY_UNAVAILABLE' };

export interface TextContainerNode {
  containerId: string;
  containerKind: string;
  sourceUri: string;
  relativePath: string;
  parseStatus: 'confirmed' | 'failed';
  tableCount: number;
  tables: Array<{
    tableId: string;
    entryName: string;
    entryCount: number;
    /** S30：非空文本条数；Bridge 未上报时缺省（renderer 回落「N 条」）。 */
    filledCount?: number;
    sourceUri: string;
    entryIndex: number;
  }>;
  diagnostics: Diagnostic[];
}

export interface TextCatalogResponse {
  ok: boolean;
  libraryId: 'game-text';
  title: string;
  languages: Array<{
    languageId: string;
    containers: TextContainerNode[];
  }>;
  diagnostics: Diagnostic[];
}

export interface MapReadCancellationResult {
  ok: boolean;
  cancelled?: boolean;
  status?: 'cancelled' | 'already-cancelled' | 'not-found';
  requestId?: string;
  diagnostics?: Array<{ severity?: string; code?: string; message?: string; details?: unknown }>;
}
