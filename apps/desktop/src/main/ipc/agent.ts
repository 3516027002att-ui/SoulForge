import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { app } from 'electron';
import type { WebContents, IpcMainInvokeEvent } from 'electron';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  buildAiSidebarDraft,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  createConfirmationReceipt,
  createContextBroker,
  createUnifiedDiff,
  getRagStaleChunkMaskCached,
  retrieveEvidence,
  retrieveEvidenceHybrid,
  createRagCorpus,
  listRolloutSessions,
  loadRolloutSession,
  runAgentSession,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalDiff,
  type ChatMessage,
  type RolloutSessionMeta,
  type ResumedRollout
} from '@soulforge/core';
import type {
  RagCorpus,
  ToolContext,
  ToolDescriptor,
  ToolResult,
  WorkspaceIndex,
  WorkspaceSession,
  AiSidebarDraft,
  AiSidebarDraftRequest
} from '@soulforge/core';
import type { ConfirmationReceipt, RagChunkFamily, RagRetrieveResult, ResourceKind } from '@soulforge/shared';
import {
  agentReferenceExpiresAt,
  agentSelectionSummary,
  decodeDecideAgentApprovalRequest,
  decodeEditorSelectionContext,
  mintAgentReferenceToken,
  selectionRendererSafetyIssues,
  validateAgentReferenceScope,
  type AgentResourceReference,
  type DecideAgentApprovalRequest,
  type EditorSelectionContext,
  decodeCiteHits,
  formatCitationLabel,
  mergeCiteHits,
  type Citation
} from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';
import type { TrustedIpcHandle } from './registration.js';
import type { MemoryManager } from '../memoryManager.js';
import type { ModelServiceCredentialVault } from '../modelServiceCredentials.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import { createAgentTaskRecordGateway } from '../agentTaskRecord.js';
import { InternalRagEmbeddingService } from '../ragEmbedding.js';

export interface AiAgentRunRequest {
  configId: string;
  prompt: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  streaming?: boolean;
  resumeSessionPath?: string;
  /** Optional per-run ceiling; omitted uses the core's safe default. */
  maxSteps?: number;
  timeoutMs?: number;
  maxTotalOutputTokens?: number;
  autoCompactTokenLimit?: number;
  retryMaxAttempts?: number;
  useContextBroker?: boolean;
  contextMaxBytes?: number;
  thinkingLevel?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  useRagSearch?: boolean;
  ragSearchMaxHits?: number;
  approvalRequiredLevels?: string[];
  resources?: readonly AgentResourceReference[];
  selection?: { label: string; resourceKind: ResourceKind; };
  openFailure?: { kind: 'event-open-failed' | 'msb-open-failed' | 'fmg-open-failed' | 'param-open-failed' | 'script-open-failed' | 'tae-open-failed'; document: string; code: string; message: string; };
}
export interface AiAgentApprovalResponseRequest { sessionId: string; callId: string; decision: ApprovalDecision; note?: string; }
export type AiAgentRunIpcResult = { ok: true; sessionId: string } | { ok: false; error: { code: string; message: string } };
export type AiAgentEventReplayIpcResult = { ok: true; events: AiAgentEventEnvelope[] } | { ok: false; error: { code: string; message: string } };
export interface AiAgentSessionSummaryIpc { sessionPath: string; fileName: string; sessionId: string | null; startedAt: string | null; messageCount: number; parseErrors: number; interrupted: boolean; compactedWindows: number; sizeBytes: number; modifiedAt: string; }
export type AiAgentSessionListIpcResult = { ok: true; sessions: AiAgentSessionSummaryIpc[] } | { ok: false; error: { code: string; message: string } };
export type AiAgentSessionLoadIpcResult = { ok: true; meta: RolloutSessionMeta | null; messageCount: number; parseErrors: number; interrupted: boolean; compactedWindows: number; messagesPage: ChatMessage[]; } | { ok: false; error: { code: string; message: string } };
export type AiAgentSessionLifecycleEvent = { type: 'session-accepted'; mode: 'plan' | 'normal' | 'fullPermission' } | { type: 'session-mode-switched'; mode: 'plan' | 'normal' | 'fullPermission' } | { type: 'session-done'; finishReason: string; steps: number; rolloutFileName: string } | { type: 'session-error'; code: string; message: string };
export interface AiAgentEventEnvelope { sessionId: string; seq: number; event: AgentEvent | AiAgentSessionLifecycleEvent; }
export type AgentResourceReferenceCreateIpcResult = { ok: true; reference: AgentResourceReference } | { ok: false; error: { code: string; message: string; diagnostics?: readonly { code: string; path: string; message: string }[]; }; };
export type AgentAttachmentCreateIpcResult = { ok: true; reference: { token: string; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain'; byteLength: number; expiresAt: string; }; label: string; } | { ok: false; cancelled?: boolean; error: { code: string; message: string }; };

const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 500_000;
const AGENT_CONTEXT_COMPACTION_RATIO = 0.8;
const APPROVAL_TIMEOUT_MS = 600_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const AGENT_EVENT_HISTORY_LIMIT = 4_096;
const AGENT_EVENT_HISTORY_TTL_MS = 5 * 60_000;

const agentSessionsBaseDir = join(app.getPath('userData'), 'agent');
const activeAgentRuns = new Map<string, { controller: AbortController; ownerId: number; serviceId: string; model: string; }>();
const internalRagEmbedding = new InternalRagEmbeddingService(join(app.getPath('userData'), 'rag', 'embedding-cache'));
const agentReferenceRegistry = new Map<string, { ownerId: string; tokenId: string; citation?: Citation }>();
const pendingApprovals = new Map<string, { resolve: (response: { decision: ApprovalDecision; note?: string }) => void; timer: NodeJS.Timeout }>();
const agentSessionSeqs = new Map<string, number>();
const agentSessionOwners = new Map<string, number>();
const agentEventHistory = new Map<string, AiAgentEventEnvelope[]>();
const agentEventHistoryCleanup = new Map<string, NodeJS.Timeout>();
let boundWebContents: WebContents | null = null;

const settleApproval = (key: string, response: { decision: ApprovalDecision; note?: string }): boolean => {
  const pending = pendingApprovals.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingApprovals.delete(key);
  pending.resolve(response);
  return true;
};
const rejectSessionApprovals = (sessionId: string, note: string): void => {
  for (const key of [...pendingApprovals.keys()]) {
    if (key.startsWith(`${sessionId}:`)) settleApproval(key, { decision: 'reject', note });
  }
};
const sendAgentEvent = (sessionId: string, event: AgentEvent | AiAgentSessionLifecycleEvent): void => {
  const seq = (agentSessionSeqs.get(sessionId) ?? 0) + 1;
  agentSessionSeqs.set(sessionId, seq);
  const envelope = sanitizeRendererValue({ sessionId, seq, event }) as AiAgentEventEnvelope;
  const history = agentEventHistory.get(sessionId) ?? [];
  history.push(envelope);
  if (history.length > AGENT_EVENT_HISTORY_LIMIT) {
    history.splice(0, history.length - AGENT_EVENT_HISTORY_LIMIT);
  }
  agentEventHistory.set(sessionId, history);
  if (event.type === 'session-done' || event.type === 'session-error') {
    const previous = agentEventHistoryCleanup.get(sessionId);
    if (previous) clearTimeout(previous);
    const cleanup = setTimeout(() => {
      agentEventHistory.delete(sessionId);
      agentEventHistoryCleanup.delete(sessionId);
      agentSessionSeqs.delete(sessionId);
      agentSessionOwners.delete(sessionId);
    }, AGENT_EVENT_HISTORY_TTL_MS);
    cleanup.unref?.();
    agentEventHistoryCleanup.set(sessionId, cleanup);
  }
  if (!boundWebContents || boundWebContents.isDestroyed()) return;
  boundWebContents.send('ai:agent:event', envelope);
};
function findRolloutInSessions(base: string, targetFileName: string): string | null {
  const root = join(base, 'sessions');
  if (!existsSync(root)) return null;
  try {
    const years = readdirSync(root);
    for (const year of years) {
      const yearPath = join(root, year);
      const months = readdirSync(yearPath);
      for (const month of months) {
        const monthPath = join(yearPath, month);
        const days = readdirSync(monthPath);
        for (const day of days) {
          const candidate = join(monthPath, day, targetFileName);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  } catch {
    // 目录并发或权限异常静默跳过
  }
  return null;
}

const resolveSessionPath = (sessionPath: string): { ok: true; absolute: string } | { ok: false; error: { code: string; message: string } } => {
  const base = resolve(agentSessionsBaseDir);
  const normalized = sessionPath.replace(/^[\\/]+/, '');
  const absolute = resolve(base, normalized);
  if (absolute !== base && !absolute.startsWith(base + sep)) {
    return { ok: false, error: { code: 'ROLLOUT_PATH_FORBIDDEN', message: '会话路径必须位于会话目录内。' } };
  }
  if (existsSync(absolute)) return { ok: true, absolute };

  // 兼容直接传入纯文件名（如 rollout-2026-09-06T...jsonl）：优先按时间戳解析 sessions/YYYY/MM/DD/ 子目录
  const fileName = basename(normalized);
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/i.exec(fileName);
  if (match) {
    const candidate = join(base, 'sessions', match[1]!, match[2]!, match[3]!, fileName);
    if (existsSync(candidate)) return { ok: true, absolute: candidate };
  }
  const candidateDirect = join(base, 'sessions', fileName);
  if (existsSync(candidateDirect)) return { ok: true, absolute: candidateDirect };

  const searched = findRolloutInSessions(base, fileName);
  if (searched && existsSync(searched)) return { ok: true, absolute: searched };

  return { ok: true, absolute };
};
export function isAgentSessionActive(sessionId: string): boolean { return activeAgentRuns.has(sessionId); }
export function hasActiveAgentRuns(): boolean { return activeAgentRuns.size > 0; }
export function clearAgentIpcState(): void {
  void internalRagEmbedding.close();
  for (const key of [...pendingApprovals.keys()]) {
    const p = pendingApprovals.get(key);
    if (p) { clearTimeout(p.timer); p.resolve({ decision: 'reject', note: '状态已重置，未回答的审批按拒绝处理。' }); }
  }
  pendingApprovals.clear();
  agentReferenceRegistry.clear();
  for (const timer of agentEventHistoryCleanup.values()) clearTimeout(timer);
  agentEventHistoryCleanup.clear();
  agentEventHistory.clear();
  agentSessionOwners.clear();
  agentSessionSeqs.clear();
}

export function scheduleInternalRagEmbedding(corpus: RagCorpus, database: OperationLogUtilityClient): void {
  internalRagEmbedding.schedule(corpus, database);
}
export interface AgentIpcDeps {
  handle: TrustedIpcHandle;
  webContents: WebContents;
  toolRegistry: import("@soulforge/core").ToolRegistry;
  memoryManager: MemoryManager;
  modelServiceVault: ModelServiceCredentialVault;
  operationLogUtility: OperationLogUtilityClient;
  getActiveIndex: () => WorkspaceIndex | null;
  getActiveSession: () => WorkspaceSession | null;
  getActiveWorkspaceSessionId: () => string | null;
  getActiveWorkspaceSessionGeneration: () => number;
  getActiveRag: () => RagCorpus | null;
  /** 等待当前一次性工作区分析；不会为每次 RAG 查询重新扫描。 */
  waitForWorkspaceIndexing: (signal?: AbortSignal) => Promise<void>;
  ensureActiveOperationLog: (session: WorkspaceSession) => Promise<OperationLogUtilityClient>;
  durableStoragePaths: (workspaceId: string) => { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  currentToolContext: () => ToolContext;
  requestWriteConfirmation: (input: { event?: IpcMainInvokeEvent; resourceLabel: string; sourceUri: string; actionLabel: string; payloadHash: string; extraSubjects?: string[] }) => Promise<ConfirmationReceipt | null>;
  taskRecordDirectory: () => string;
  readSystemPrompt: () => string | null;
}

export function registerAgentIpcHandlers(deps: AgentIpcDeps): void {
  boundWebContents = deps.webContents;
  deps.webContents.once('destroyed', () => {
    for (const [sessionId, entry] of activeAgentRuns) {
      if (entry.ownerId !== deps.webContents.id) continue;
      entry.controller.abort();
      rejectSessionApprovals(sessionId, '渲染进程已关闭，未回答的审批按拒绝处理。');
    }
    if (boundWebContents === deps.webContents) boundWebContents = null;
  });
  const activeAiMode: ToolContext['mode'] = 'plan';
  deps.handle('ai.tools', async () => deps.toolRegistry.list());
  
  deps.handle('ai.memory.list', async () => {
      try {
        return { ok: true, entries: deps.memoryManager.getStore().list() } as const;
      } catch {
        return { ok: false, error: { code: 'MEMORY_LIST_FAILED', message: '无法读取长期记忆。' } } as const;
      }
    });
  
  deps.handle('ai.memory.save', async (_event, rawEntry: unknown) => {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
        return { ok: false, error: { code: 'MEMORY_ENTRY_INVALID', message: '长期记忆条目格式无效。' } } as const;
      }
      const input = rawEntry as Record<string, unknown>;
      const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
      const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
      const details = input.details === undefined ? undefined : typeof input.details === 'string' ? input.details.trim() : null;
      const id = input.id === undefined ? undefined : typeof input.id === 'string' ? input.id.trim() : null;
      const tags = input.tags === undefined
        ? undefined
        : Array.isArray(input.tags) && input.tags.every((tag) => typeof tag === 'string')
          ? input.tags.map((tag) => tag.trim()).filter(Boolean)
          : null;
      const invalidTags = tags === null || (tags !== undefined && (tags.length > 32 || tags.some((tag) => tag.length > 128)));
      if (!topic || topic.length > 256 || !summary || summary.length > 10_000 || details === null || id === null || invalidTags) {
        return { ok: false, error: { code: 'MEMORY_ENTRY_INVALID', message: '长期记忆条目字段无效或超出长度限制。' } } as const;
      }
      try {
        const entry = deps.memoryManager.getStore().save({
          ...(id ? { id } : {}),
          topic,
          summary,
          ...(details !== undefined ? { details } : {}),
          ...(tags !== undefined ? { tags } : {})
        });
        return { ok: true, entry } as const;
      } catch {
        return { ok: false, error: { code: 'MEMORY_SAVE_FAILED', message: '无法保存长期记忆。' } } as const;
      }
    });
  
  deps.handle('ai.memory.delete', async (_event, idOrTopic: unknown) => {
      if (typeof idOrTopic !== 'string' || !idOrTopic.trim() || idOrTopic.length > 256) {
        return { ok: false, error: { code: 'MEMORY_KEY_INVALID', message: '长期记忆标识无效。' } } as const;
      }
      try {
        return { ok: true, deleted: deps.memoryManager.getStore().delete(idOrTopic.trim()) } as const;
      } catch {
        return { ok: false, error: { code: 'MEMORY_DELETE_FAILED', message: '无法删除长期记忆。' } } as const;
      }
    });
  
  deps.handle('ai.sidebarDraft', async (_event, request: AiSidebarDraftRequest): Promise<AiSidebarDraft> => {
      return buildAiSidebarDraft({
        ...request,
        settings: { ...request.settings, mode: activeAiMode },
        availableTools: request.availableTools.length > 0 ? request.availableTools : deps.toolRegistry.list()
      });
    });
  
  deps.handle(
    'ai.runTool',
    async (_event, name: string, input: unknown): Promise<ToolResult> => {
      // T6：无工作区时由工具层按工具守卫（WORKSPACE_REQUIRED），不整次拒绝。
      return deps.toolRegistry.run(name, input, deps.currentToolContext());
    }
  );

  deps.handle('rag.embed', async (_event, _input: unknown): Promise<
      | { ok: true; embedded: number; reused: number; failed: number; model: string; dim: number }
      | { ok: false; error: { code: string; message: string } }
    > => {
      if (!deps.getActiveIndex()) {
        return {
          ok: false,
          error: { code: 'WORKSPACE_REQUIRED', message: '先打开 Mod 工作区并完成分析，再生成向量索引。' }
        };
      }
      if (!deps.getActiveSession()) {
        return {
          ok: false,
          error: { code: 'WORKSPACE_REQUIRED', message: '工作区会话未就绪。' }
        };
      }
      const database = await deps.ensureActiveOperationLog(deps.getActiveSession()!);
      const corpus = deps.getActiveRag() ?? createRagCorpus({
        workspaceId: deps.getActiveIndex()!.workspaceId,
        builtAt: new Date().toISOString(),
        chunks: await database.loadRagChunks(),
        references: await database.loadReferences()
      });
      if (corpus.availability !== 'available') {
        return {
          ok: false,
          error: {
            code: 'RAG_UNAVAILABLE',
            message: corpus.diagnostics.find((diagnostic) => diagnostic.code === 'RAG_SEMANTIC_CORPUS_EMPTY')?.message
              ?? 'RAG 语义语料不可用，请先完成工作区原生分析。'
          }
        };
      }
      if (corpus.chunks.length === 0) {
        return { ok: false, error: { code: 'INSUFFICIENT_CORPUS', message: '语料为空：先扫描并分析工作区。' } };
      }
  
      const result = await internalRagEmbedding.ensure(corpus, database);
      if (!result.ok) return { ok: false, error: { code: result.code, message: result.message } };
      return { ok: true, embedded: result.embedded, reused: result.reused, failed: result.failed, model: result.model, dim: result.dim };
    });
  
  const loadWorkspaceVectorMap = async (
    corpus: RagCorpus,
    database: OperationLogUtilityClient | null
  ): Promise<Map<string, Float32Array> | null> => {
    const cached = internalRagEmbedding.getCachedVectors(corpus);
    if (cached && cached.size > 0) return cached;
    if (!database) return null;
    try {
      const model = await database.ragEmbeddingModel();
      if (!model) return null;
      const records = await database.loadRagEmbeddingRecords();
      if (records.length === 0) return null;
      const vectorMap = new Map<string, Float32Array>();
      for (const record of records) {
        if (record.vector && record.vector.length > 0) {
          vectorMap.set(record.chunkId, record.vector);
        }
      }
      return vectorMap.size > 0 ? vectorMap : null;
    } catch {
      return null;
    }
  };

  const searchWorkspaceEvidence = async (
    database: OperationLogUtilityClient | null,
    query: string,
    options: {
      limit?: number;
      families?: readonly RagChunkFamily[];
      expandReferences?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<RagRetrieveResult> => {
    const initialIndex = deps.getActiveIndex();
    const initialSession = deps.getActiveSession();
    const initialSessionId = deps.getActiveWorkspaceSessionId();
    const initialGeneration = deps.getActiveWorkspaceSessionGeneration();
    const initialRag = deps.getActiveRag();
    if (!initialIndex) {
      return { ok: false as const, code: 'WORKSPACE_REQUIRED' as const, message: '先打开 Mod 工作区。' };
    }
    const activeRag = initialRag;
    if (!activeRag && !database) {
      return {
        ok: false,
        code: 'RAG_UNAVAILABLE',
        message: '内存 RAG 语料尚未就绪；查询不会启动数据库 recovery。'
      };
    }
    const corpus = activeRag ?? createRagCorpus({
      workspaceId: initialIndex.workspaceId,
      builtAt: new Date().toISOString(),
      chunks: await database!.loadRagChunks(),
      references: await database!.loadReferences()
    });

    // 没有配置 embedding 就不启用 RAG 相关功能（静默不启用，不产生额外提示）
    const vectorMap = await loadWorkspaceVectorMap(corpus, database);
    if (!vectorMap || vectorMap.size === 0) {
      return {
        ok: false,
        code: 'RAG_UNAVAILABLE',
        message: 'RAG 检索未启用。'
      };
    }

    const queryVector = await internalRagEmbedding.embedQuery(query, options.signal);
    if (!queryVector) {
      return {
        ok: false,
        code: 'RAG_UNAVAILABLE',
        message: 'RAG 检索未启用。'
      };
    }

    // All inputs above may await database/vector/embedding work.  A remount,
    // scan replacement, or semantic RAG publication during that window must
    // not let an old workspace snapshot reach the Agent evidence preflight.
    const currentIndex = deps.getActiveIndex();
    const workspaceStillCurrent = currentIndex === initialIndex
      && deps.getActiveSession() === initialSession
      && deps.getActiveWorkspaceSessionId() === initialSessionId
      && deps.getActiveWorkspaceSessionGeneration() === initialGeneration
      && deps.getActiveRag() === initialRag;
    if (!workspaceStillCurrent || !currentIndex) {
      return {
        ok: false,
        code: 'RAG_UNAVAILABLE',
        message: '工作区会话或 RAG 语料已切换，已丢弃旧检索结果；请重试。'
      };
    }

    const staleChunkMask = getRagStaleChunkMaskCached(currentIndex, corpus);
    return retrieveEvidenceHybrid(corpus, query, {
      ...(options.limit != null && options.limit > 0 ? { limit: Math.trunc(options.limit) } : {}),
      ...(options.expandReferences === undefined ? {} : { expandReferences: options.expandReferences === true }),
      ...(options.families && options.families.length > 0 ? { families: options.families } : {}),
      ...(staleChunkMask ? { excludeChunkMask: staleChunkMask } : {}),
      vectors: {
        vectors: vectorMap,
        queryVector
      }
    });
  };

  deps.handle('rag.searchEvidence', async (_event, input: {
      query: string;
      limit?: number;
      families?: readonly RagChunkFamily[];
      expandReferences?: boolean;
    }): Promise<RagRetrieveResult> => {
      if (typeof input?.query !== 'string' || input.query.trim() === '') {
        return { ok: false, code: 'INVALID_INPUT', message: 'rag.searchEvidence 需要非空 query。' };
      }
      if (!deps.getActiveIndex() || !deps.getActiveSession()) {
        return { ok: false as const, code: 'WORKSPACE_REQUIRED' as const, message: '先打开 Mod 工作区。' };
      }
      const database = deps.getActiveRag()
        ? deps.operationLogUtility
        : await deps.ensureActiveOperationLog(deps.getActiveSession()!);
      return searchWorkspaceEvidence(database, input.query, {
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.families !== undefined ? { families: input.families } : {}),
        ...(input.expandReferences !== undefined ? { expandReferences: input.expandReferences } : {})
      });
    });
  
  deps.handle('ai.agent.run', async (_event, request: AiAgentRunRequest): Promise<AiAgentRunIpcResult> => {
      // T6：无工作区也创建会话、调模型（随时可聊）。工作区工具在工具层按工具守卫
      // 失败关闭（WORKSPACE_REQUIRED「这次工具需要先打开 Mod 工作区」），不整次拒绝。
      if (
        typeof request?.configId !== 'string' || request.configId.trim() === ''
        || typeof request?.prompt !== 'string' || request.prompt.trim() === ''
      ) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'configId 与 prompt 必填。' } };
      }
      // AGENT-60D 提交期消费点：资源引用 token 必须是 main 签发的、未过期、且
      // 属于当前 sender。跨 sender / 伪造 token 在这里被拒，不进入工具上下文。
      // 这是 agent 通道，不是 param/format 读取，**不得**返回 BACKUP_READ_FORBIDDEN。
      const resources = request.resources ?? [];
      const ownerId = String(_event.sender.id);
      // S10：引用框选（param 域）随 resources 提交；main 用注册表里自己解码合并的
      // citation 重拼系统提示行，不信任 renderer 回传的 label。
      const citationLines: string[] = [];
      for (const reference of resources) {
        const registered = agentReferenceRegistry.get(reference.token);
        if (registered === undefined || registered.tokenId === undefined) {
          return {
            ok: false,
            error: { code: 'AGENT_TOKEN_UNKNOWN', message: '资源引用 token 不在已签发注册表中，拒绝提交。' }
          };
        }
        const scope = validateAgentReferenceScope(reference.token, ownerId);
        if (!scope.ok) {
          return { ok: false, error: { code: scope.code, message: scope.message } };
        }
        if (registered.ownerId !== ownerId) {
          return {
            ok: false,
            error: { code: 'AGENT_TOKEN_SENDER_MISMATCH', message: '资源引用属于其他发送方，拒绝提交。' }
          };
        }
        if (registered.citation !== undefined) {
          citationLines.push(formatCitationLabel(registered.citation));
        }
      }
      const stored = (await deps.modelServiceVault.listConfigs()).find((config) => config.id === request.configId);
      if (!stored) {
        return { ok: false, error: { code: 'MODEL_SERVICE_CONFIG_NOT_FOUND', message: '模型服务配置不存在。' } };
      }
      if (!stored!.hasCredential) {
        return {
          ok: false,
          error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务未配置凭据；未发起网络请求。' }
        };
      }
      const apiKey = await deps.modelServiceVault.resolveApiKey(stored!.id);
      if (!apiKey) {
        return {
          ok: false,
          error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务凭据不可解密；未发起网络请求。' }
        };
      }
      const modelConfig = {
        id: stored!.id,
        displayName: stored!.displayName,
        protocol: stored!.protocol,
        baseUrl: stored!.baseUrl,
        model: stored!.model,
        hasCredential: true as const,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt
      };
      // 采样/能力参数来自服务配置（vault），renderer 无法伪造：保存时落盘，运行
      // 时由 main 读取下发。缺失字段 = 该次调用用 provider 默认值。
      const sampling = {
        ...(stored!.temperature !== undefined ? { temperature: stored!.temperature } : {}),
        ...(stored!.topP !== undefined ? { topP: stored!.topP } : {}),
        ...(stored!.topK !== undefined ? { topK: stored!.topK } : {}),
        ...(stored!.maxTokens !== undefined ? { maxTokens: stored!.maxTokens } : {}),
        // S32：请求级思考强度优先于服务级默认（输入条改了就用新的）。
        ...(request.thinkingLevel !== undefined
          ? { thinkingLevel: request.thinkingLevel }
          : stored!.thinkingLevel !== undefined
            ? { thinkingLevel: stored!.thinkingLevel }
            : {})
      };
      const contextWindowTokens = stored!.contextWindowTokens;
      const effectiveAutoCompactTokenLimit = request.autoCompactTokenLimit != null
        && request.autoCompactTokenLimit > 0
        ? Math.trunc(request.autoCompactTokenLimit)
        : Math.max(
          1,
          Math.trunc(
            (contextWindowTokens != null && contextWindowTokens > 0
              ? contextWindowTokens
              : DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS) * AGENT_CONTEXT_COMPACTION_RATIO
          )
        );

      let resumeFrom: ResumedRollout | undefined;
      let inheritTaskRecordSessionId: string | undefined;
      if (request.resumeSessionPath !== undefined) {
        const resolved = resolveSessionPath(request.resumeSessionPath);
        if (resolved.ok) {
          const loaded = await loadRolloutSession(resolved.absolute);
          if (loaded.ok) {
            const { ok: _ok, path: _path, ...resumed } = loaded;
            resumeFrom = resumed;
            const metaSessionId = resumed.meta?.sessionId;
            if (typeof metaSessionId === 'string' && metaSessionId.trim() !== '') {
              inheritTaskRecordSessionId = metaSessionId.trim();
            } else {
              const fileNameMatch = /([0-9a-fA-F-]{36})\.jsonl$/i.exec(basename(resolved.absolute));
              if (fileNameMatch) {
                inheritTaskRecordSessionId = fileNameMatch[1];
              }
            }
          } else {
            console.warn(`[SoulForge Agent] 尝试承接会话未找到或读取失败（${loaded.code}：${loaded.message}），平滑降级为新会话启动。`);
          }
        } else {
          console.warn(`[SoulForge Agent] 尝试承接会话路径非法（${resolved.error.code}：${resolved.error.message}），平滑降级为新会话启动。`);
        }
      }

      const sessionId = randomUUID();
      const adapterResult = createConfiguredModelServiceAdapter({ config: modelConfig, apiKey, sessionId });
      if (!adapterResult.ok) {
        const diagnostic = adapterResult.diagnostics[0];
        return { ok: false, error: { code: diagnostic?.code ?? 'MODEL_SERVICE_INVALID', message: diagnostic?.message ?? '模型服务配置无效。' } };
      }
      try {
        await deps.operationLogUtility.openAppDatabase(join(app.getPath('userData'), 'app.db'));
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_USAGE_STORAGE_UNAVAILABLE',
            message: `模型服务用量记录暂时不可用，因此未发起请求：${error instanceof Error ? error.message : String(error)}`
          }
        };
      }
      const mode: ToolContext['mode'] = request.mode === 'normal' || request.mode === 'fullPermission'
        ? request.mode
        : 'plan';
      const taskRecord = createAgentTaskRecordGateway(
        deps.taskRecordDirectory(),
        sessionId,
        {
          ...(inheritTaskRecordSessionId ? { inheritFromSessionId: inheritTaskRecordSessionId } : {}),
          frozenRequest: request.prompt
        }
      );
      await taskRecord.read();
      // 无工作区时 deps.getActiveIndex() 为 null：工具层按工具守卫（WORKSPACE_REQUIRED），
      // 需要工作区的工具干净失败，不整次拒绝（T6）。
      const bridge = createAgentToolBridge({
        registry: deps.toolRegistry,
        contextProvider: deps.currentToolContext,
        // Agent 可以读取记忆来恢复项目上下文，但不能把未经用户明确整理的
        // 运行时对话或测试内容写入长期记忆；记忆写入只保留给显式宿主流程。
        context: {
          ...deps.currentToolContext(),
          mode,
          modeCeiling: mode,
          allowMemoryWrite: false,
          taskRecord,
          requireTaskRecord: true
        },
        // Discovery is non-blocking: the bridge returns candidate/evidence
        // metadata, while native readers and writers enforce real authority.
      });
  
      // AI 回滚接通：rollback_operation 走与 UI 操作级回滚完全相同的通道 ——
      // main 弹原生确认对话框（subject 绑定 ROLLBACK_OPERATION:<opId>，签发的
      // ConfirmationReceipt 与 rollbackSelected 的校验一致），并把生产上下文
      // （真实 SQLite store / session / 备份与恢复目录）注入工具执行。审批卡
      // （agentLoop 的 rollback 级 gate）是「允许调这个工具」，这里的对话框是
      // 「确认这一次具体回滚」——双重防线，回滚是高危险不可逆操作。
      let agentSignal: AbortSignal | undefined;
      {
        let currentRunMode: 'plan' | 'normal' | 'fullPermission' = mode;
        const rawExecuteTool = bridge.executeTool;
        const executeLiveTool = (call: Parameters<typeof rawExecuteTool>[0], extra: Partial<ToolContext> = {}) => {
          return rawExecuteTool(call, {
            // The run's mode and task ledger are stable for its lifetime; all
            // workspace/RAG/session state must be refreshed per tool call.
            mode: currentRunMode,
            modeCeiling: mode,
            allowMemoryWrite: false,
            taskRecord,
            requireTaskRecord: true,
            ...(agentSignal ? { signal: agentSignal } : {}),
            ...extra
          });
        };
        bridge.executeTool = async (call, contextOverride = {}) => {
          if (call.name === 'switch_mode') {
            const result = await executeLiveTool(call, contextOverride);
            if (result.ok) {
              try {
                const parsed = JSON.parse(result.content);
                const record = parsed?.data?.record ?? parsed?.record ?? parsed;
                const switched = record?.switched;
                const target = record?.currentMode;
                if (switched === true && typeof target === 'string') {
                  const effective = target === 'edit' ? 'normal' : target;
                  if (effective === 'plan' || effective === 'normal' || effective === 'fullPermission') {
                    currentRunMode = effective;
                    sendAgentEvent(sessionId, {
                      type: 'session-mode-switched',
                      mode: effective
                    });
                  }
                }
              } catch {}
            }
            return result;
          }
          if (call.name === 'commit_patch' || call.name === 'mutate_param_fields'
            || call.name === 'mutate_fmg_entries' || call.name === 'apply_emevd_dsl') {
            if (!deps.getActiveSession() || !deps.operationLogUtility) return executeLiveTool(call, contextOverride);
            const storage = deps.durableStoragePaths(deps.getActiveSession()!.meta.workspaceId);
            const confirmation = createConfirmationReceipt({
              subjects: [
                'AGENT_COMMIT_APPROVED',
                'ALL_RISKS',
                ...(deps.getActiveWorkspaceSessionId() ? [`WORKSPACE_SESSION:${deps.getActiveWorkspaceSessionId()}`] : []),
                `TITLE:${call.name}`
              ],
              riskLevel: 'high',
              note: 'Agent 审批卡通过后签发的写入回执'
            });
            return executeLiveTool(call, {
              ...contextOverride,
              session: deps.getActiveSession()!,
              operationLogStore: deps.operationLogUtility,
              backupBaseDir: storage.backupBaseDir,
              recoveryDir: storage.recoveryDir,
              confirmation
            });
          }
          if (call.name !== 'rollback_operation') return executeLiveTool(call, contextOverride);
          let input: Record<string, unknown> = {};
          try {
            input = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
          } catch {
            // 参数解析交给 registry 的 INVALID_INPUT 报错，这里只需拿 opId 弹框。
          }
          const opId = typeof input.opId === 'string' ? input.opId : '';
          if (opId === '' || !deps.getActiveSession() || !deps.operationLogUtility) {
            return executeLiveTool(call, contextOverride);
          }
          const storage = deps.durableStoragePaths(deps.getActiveSession()!.meta.workspaceId);
          const sourceOperation = await deps.operationLogUtility.get(opId);
          if (!sourceOperation) {
            return executeLiveTool(call, contextOverride);
          }
          const confirmation = await deps.requestWriteConfirmation({
            resourceLabel: sourceOperation.title,
            sourceUri: sourceOperation.files[0]?.targetUri ?? `operation://${opId}`,
            actionLabel: '回滚操作',
            payloadHash: createHash('sha256').update(opId).digest('hex'),
            extraSubjects: [`ROLLBACK_OPERATION:${opId}`]
          });
          if (!confirmation) {
            return {
              ok: false,
              code: 'WRITE_CONFIRMATION_CANCELLED',
              content: JSON.stringify({
                ok: false,
                error: {
                  code: 'WRITE_CONFIRMATION_CANCELLED',
                  message: '用户在原生确认对话框中取消了回滚操作。'
                }
              })
            };
          }
          return executeLiveTool(call, {
            ...contextOverride,
            session: deps.getActiveSession()!,
            operationLogStore: deps.operationLogUtility,
            backupBaseDir: storage.backupBaseDir,
            recoveryDir: storage.recoveryDir,
            confirmation
          });
        };
      }

      // 模式指令注入：显式置顶告知模型当前所处的交互模式与操作边界，严格约束行为
      let modeInstruction: string;
      if (mode === 'plan') {
        modeInstruction = [
          '【当前运行模式：Plan 规划模式（只读方案设计）】',
          '你当前初始处于 Plan 规划模式。请遵循以下规则：',
          '1. 在此模式下，核心任务是通过搜索与原生读取工具（如 search_workspace_symbols, search_param_rows, read_param_fields, search_events, read_emevd_event 等）彻底核实所有相关资源并定位真实行号与字段，不要仅凭记忆猜测。',
          '2. 完成核实后，在回复中直接向用户输出清晰、结构完整、字段详尽的【修改栏目清单】表格（包含修改目标、目标文件/表、行号/ID、字段名称、当前值、拟改值、人话说明与推演逻辑），供用户审阅。',
          '3. Plan 轮次的授权上限是只读；switch_mode 不能自行提权。若用户要求执行，请明确告知其在宿主选择 Edit 或 Bypass 后开始或承接新一轮。'
        ].join('\n');
      } else if (mode === 'fullPermission') {
        modeInstruction = [
          '【当前运行模式：Bypass 模式（免审批全自动执行）】',
          '你当前处于免审批全自动执行模式。调用的写入工具将直接提交生效，无需用户逐项人工审批。',
          '请务必在写入前通过原生读取核实真实行号、字段名与当前值，确保修改精准安全。switch_mode 仅可在宿主已授予的 Bypass 上限内降级。'
        ].join('\n');
      } else {
        modeInstruction = [
          '【当前运行模式：Edit 模式（审批交互修改）】',
          '你当前处于编辑修改模式。在经过充分的原生读取核实后，可以调用写入工具（如 mutate_param_fields, apply_emevd_dsl 等）提出修改。',
          '在写入前必须使用原生读取工具核对真实行号、字段名与当前值，严禁臆测。',
          '你的每次写入工具调用都会自动生成变更 diff 并弹出审批卡，由用户人工确认后方可提交。switch_mode 不能把当前轮次提升到 Bypass。'
        ].join('\n');
      }

      // T6-2：系统提示由 main 读入并装配（renderer 不拼）。选区作为可选元数据
      // 附在系统提示里供模型参考，不是默认任务对象，也不自动写进 prompt 文本。
      const systemPromptParts = [modeInstruction, deps.readSystemPrompt() ?? ''];
      const fullUserMemory = deps.memoryManager.getFullMemoryForSystemPrompt(
        deps.getActiveIndex()?.workspaceId
      );
      if (fullUserMemory.trim().length > 0) {
        systemPromptParts.push(fullUserMemory);
      }
      if (request.selection) {
        systemPromptParts.push(
          `用户当前选区（仅可选元数据，不是默认任务对象）：${request.selection.label}（${request.selection.resourceKind}）。`
        );
      }
      if (request.openFailure) {
        // S15/S19 失败面：校验通过才进系统提示。命中绝对路径形态（盘符 / UNC /
        // file:///）的字符串会让整次请求失败关闭——renderer 拿不到真实路径，这条
        // 校验是防伪造的最后一层，不是起名职责。
        const failure = request.openFailure;
        const openFailureFields: ReadonlyArray<[string, string]> = [
          ['kind', failure.kind],
          ['document', failure.document],
          ['code', failure.code],
          ['message', failure.message]
        ];
        for (const [field, value] of openFailureFields) {
          if (typeof value !== 'string' || value.trim() === '' || /[A-Za-z]:[\\/]/.test(value)
            || /^\\\\/.test(value) || /file:\/\/\//.test(value)) {
            return {
              ok: false,
              error: { code: 'OPEN_FAILURE_INVALID', message: `openFailure.${field} 不合法，已拒绝提交。` }
            };
          }
        }
        systemPromptParts.push(
          `最近一次资源打开失败：${failure.kind}（${failure.code}）document=${failure.document}。`
          + `${failure.message}。用户可能正想问为什么打不开；请直接解释原因和下一步，不要要求用户复制日志。`
        );
      }
      if (citationLines.length > 0) {
        // S10：框选引用是用户显式选给模型看的行/字段（PARAM 先行），随系统提示
        // 附带；label 由 main 从注册表里的 citation 重拼，renderer 回传值不参与。
        systemPromptParts.push(
          `用户框选引用（回答时可直接引用这些行/字段）：${citationLines.join('；')}`
        );
      }
      const systemPrompt = systemPromptParts.filter((part) => part.trim().length > 0).join('\n\n');
  
      const controller = new AbortController();
      agentSignal = controller.signal;
      activeAgentRuns.set(sessionId, {
        controller,
        ownerId: _event.sender.id,
        serviceId: stored!.id,
        model: stored!.model
      });
      agentSessionOwners.set(sessionId, _event.sender.id);
      sendAgentEvent(sessionId, { type: 'session-accepted', mode });
  
      const permissionMode = mode === 'fullPermission' ? 'full' : mode;
  
      /**
       * Approval bridge. Parks a resolver keyed by callId, pushes the request to
       * the renderer, and lets ai.agent.approval.respond settle it.
       *
       * Wired unconditionally rather than only outside plan mode: plan mode
       * currently denies write tools before they reach the approval gate, so the
       * callback simply never fires there. Making it conditional would mean that
       * whether a write can happen without approval depends on a mode check
       * written in two places.
       */
      const requestApproval = (approvalRequest: {
        step: number;
        callId: string;
        toolName: string;
        permissionLevel: string;
        argumentsJson: string;
      }): Promise<{ decision: ApprovalDecision; note?: string }> =>
        new Promise((resolveApproval) => {
          const key = `${sessionId}:${approvalRequest.callId}`;
          const timer = setTimeout(() => {
            // timed_out 而不是 reject：审计里「用户拒绝了」与「没人回答」是两个
            // 不同事实，后续动作也不同（前者要改方案，后者要看是不是没人在场）。
            settleApproval(key, {
              decision: 'timed_out',
              note: `审批请求超过 ${Math.round(APPROVAL_TIMEOUT_MS / 60_000)} 分钟未回答，按未批准处理。`
            });
          }, APPROVAL_TIMEOUT_MS);
          // unref so a parked approval never keeps the process alive on quit.
          timer.unref?.();
          pendingApprovals.set(key, { resolve: resolveApproval, timer });
          if (!boundWebContents || boundWebContents.isDestroyed()) {
            // No renderer to ask. Reject rather than execute — a closed window is
            // not consent.
            settleApproval(key, { decision: 'reject', note: '渲染进程已关闭，无法请求审批。' });
          }
        });
  
      /**
       * Resolve a unified diff for a pending write.
       *
       * Lives in main because it reads the current file — the loop has no
       * filesystem access, and giving it any would soften the "tools are the only
       * way the agent touches the workspace" boundary.
       *
       * Path resolution goes through deps.getActiveSession().resolveWritablePath, so the
       * opened-workspace write gate is enforced by the existing mechanism
       * rather than a second check written here. An unresolvable path yields null
       * (no diff) rather than an error: failing to *preview* a change must never
       * decide whether it gets approved.
       */
      const resolveApprovalDiff = async (input: {
        toolName: string;
        argumentsJson: string;
      }): Promise<ApprovalDiff | null> => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(input.argumentsJson);
        } catch {
          return null;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
  
        // 两种形态都支持:propose_text_patch 的平铺字段,与 PatchProposal 的
        // changes[0]。只取第一条 —— 一次审批对应一个具体动作。
        const changes = Array.isArray(record.changes) ? record.changes : null;
        const firstChange = typeof changes?.[0] === 'object' && changes[0] !== null
          ? changes[0] as Record<string, unknown>
          : null;
        const structuredEdit = typeof firstChange?.structuredEdit === 'object'
          && firstChange.structuredEdit !== null
          ? firstChange.structuredEdit as Record<string, unknown>
          : null;
  
        const targetPath = typeof record.targetPath === 'string' && record.targetPath !== ''
          ? record.targetPath
          : typeof firstChange?.targetPath === 'string' ? firstChange.targetPath : '';
        const afterText = typeof record.newText === 'string'
          ? record.newText
          : typeof structuredEdit?.newText === 'string' ? structuredEdit.newText : null;
        if (targetPath === '' || afterText === null) return null;
        if (!deps.getActiveSession()) return null;
  
        // 用 Secure 版而不是同步版：同步 resolveWritablePath 的注释写明它只是
        // **词法预检**，权威检查是 resolveWritablePathSecure（会解析 junction 与
        // symlink）。工作区外路径由权威机制拒绝，不该因为「只是预览」就放宽。
        const _sessDiff = deps.getActiveSession();
        if (!_sessDiff) return null;
        const writable = await _sessDiff.resolveWritablePathSecure(targetPath, 'overlay');
        if (!writable.ok || typeof writable.absolutePath !== 'string') return null;
        const resolvedPath = writable.absolutePath;
  
        let beforeText = '';
        let newFile = false;
        try {
          beforeText = await readFile(resolvedPath, 'utf8');
        } catch {
          // 目标不存在:整篇都是新增。这与「读失败」在界面上必须可区分,
          // 故用 newFile 标记而不是静默当成空文件对比。
          newFile = true;
        }
  
        const unifiedDiff = createUnifiedDiff(beforeText, afterText, {
          fromFile: newFile ? '(新文件)' : targetPath,
          toFile: targetPath
        });
        const lines = unifiedDiff.split('\n');
        const addedLines = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
        const removedLines = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  
        // 上限:几千行的 diff 会把审批卡片变成读不完的墙,而读不完的 diff 等于
        // 没有 diff。截断必须显式说明截了多少,否则用户会以为改动就这么点。
        const MAX_DIFF_LINES = 400;
        const truncated = lines.length > MAX_DIFF_LINES;
  
        return {
          targetPath,
          unifiedDiff: truncated ? lines.slice(0, MAX_DIFF_LINES).join('\n') : unifiedDiff,
          addedLines,
          removedLines,
          newFile,
          ...(truncated
            ? {
                truncatedNote: `diff 共 ${lines.length} 行，此处只显示前 ${MAX_DIFF_LINES} 行；`
                  + `完整改动为 +${addedLines} / -${removedLines} 行。`
              }
            : {})
        };
      };
  
      const hasRagEmbedding = async (): Promise<boolean> => {
        if (!deps.getActiveIndex() || !deps.getActiveSession()) return false;
        const activeRag = deps.getActiveRag();
        if (activeRag) {
          const cached = internalRagEmbedding.getCachedVectors(activeRag);
          if (cached && cached.size > 0) return true;
        }
        try {
          // 只做轻量只读检查，不执行耗时的 recovery cleanup 全盘扫描
          const model = await Promise.race([
            deps.operationLogUtility.ragEmbeddingModel(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
          ]);
          if (!model) return false;
          const records = await Promise.race([
            deps.operationLogUtility.loadRagEmbeddingRecords(),
            new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), 100))
          ]);
          return records.length > 0;
        } catch {
          return false;
        }
      };
      const ragEmbeddingAvailable = request.useRagSearch === true ? await hasRagEmbedding() : false;

      void runAgentSession({
        sessionsDir: agentSessionsBaseDir,
        sessionId,
        adapter: adapterResult.adapter,
        config: modelConfig,
        apiKey,
        prompt: request.prompt,
        ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
        permissionMode,
        tools: bridge.tools,
        executeTool: bridge.executeTool,
        recordProviderUsage: async (sample) => {
          await deps.operationLogUtility.recordProviderUsage({
            eventId: `${sessionId}:${sample.callIndex}`,
            sessionId,
            serviceId: stored!.id,
            protocol: stored!.protocol,
            model: stored!.model,
            ...sample
          });
        },
        signal: controller.signal,
        requestApproval,
        resolveApprovalDiff,
        ...(Array.isArray(request.approvalRequiredLevels)
          ? { approvalRequiredLevels: request.approvalRequiredLevels }
          : { approvalRequiredLevels: [] }),
        ...(request.streaming === true ? { streaming: true } : {}),
        timeoutMs: request.timeoutMs != null && request.timeoutMs > 0
          ? Math.trunc(request.timeoutMs)
          : DEFAULT_REQUEST_TIMEOUT_MS,
        ...(request.maxTotalOutputTokens != null && request.maxTotalOutputTokens > 0
          ? { maxTotalOutputTokens: Math.trunc(request.maxTotalOutputTokens) }
          : {}),
        ...(request.maxSteps != null && request.maxSteps > 0
          ? { maxSteps: Math.min(200, Math.trunc(request.maxSteps)) }
          : {}),
        // Always arm compaction. Missing provider metadata uses the same 500K
        // default shown in settings and compacts at 80%; an explicit request
        // override remains exact for deterministic callers/tests.
        compaction: {
          autoCompactTokenLimit: request.autoCompactTokenLimit != null && request.autoCompactTokenLimit > 0
            ? Math.trunc(request.autoCompactTokenLimit)
            : effectiveAutoCompactTokenLimit
        },
        ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
        ...(ragEmbeddingAvailable
          ? {
              ragSearch: {
                ...(request.ragSearchMaxHits != null && request.ragSearchMaxHits > 0
                  ? { maxHits: Math.min(8, Math.trunc(request.ragSearchMaxHits)) }
                  : {}),
                // RAG 自动注入：仅在已就绪真实 embedding 向量时启用。
                // 每次模型调用前用最近用户消息检索工作区证据；无工作区时返回 WORKSPACE_REQUIRED。
                retrieve: async (query: string) => {
                  if (!deps.getActiveIndex() || !deps.getActiveSession()) {
                    return { ok: false as const, code: 'WORKSPACE_REQUIRED' as const, message: '先打开 Mod 工作区。' };
                  }
                  // RAG retrieval is a read-only model preflight. It uses the
                  // current in-memory corpus first; vector persistence is
                  // recovered by the background embedding task, never by this
                  // query and never by running recovery cleanup.
                  // Always join the workspace's one single-flight semantic
                  // analysis before the first lookup. The renderer starts it
                  // after the shell becomes interactive, but an Agent can be
                  // submitted in that race window; waiting only when the
                  // corpus is unavailable would accept an older partial corpus
                  // that happens to contain text/event/map rows but no PARAM.
                  // 设定有界等待超时（至多 3 秒），防止大工作区深度解析（如全量 MSB/PARAM 需数分钟）导致 Agent 对话死等挂起。
                  const indexingAbort = new AbortController();
                  const onParentAbort = () => indexingAbort.abort();
                  controller.signal.addEventListener('abort', onParentAbort, { once: true });
                  const indexingTimer = setTimeout(() => indexingAbort.abort(), 3_000);
                  try {
                    await deps.waitForWorkspaceIndexing(indexingAbort.signal);
                  } catch (error) {
                    if (controller.signal.aborted) {
                      return {
                        ok: false as const,
                        code: 'RAG_UNAVAILABLE' as const,
                        message: '等待工作区语义索引期间任务已取消。'
                      };
                    }
                    // 超时未完成则降级直接利用已有索引检索，绝不长时间挂起会话
                  } finally {
                    clearTimeout(indexingTimer);
                    controller.signal.removeEventListener('abort', onParentAbort);
                  }
                  return searchWorkspaceEvidence(deps.operationLogUtility, query, { signal: controller.signal });
                }
              }
            }
          : {}),
        // Only the attempt count is renderer-controllable, and it is clamped:
        // backoff base and jitter stay at the loop's defaults. Exposing those
        // would let the renderer configure a hot retry loop against a
        // third-party provider. Read inline so the value's origin is visible at
        // the call site rather than in a variable computed elsewhere.
        ...(request.retryMaxAttempts != null && request.retryMaxAttempts > 0
          ? { retryPolicy: { maxAttempts: Math.min(8, Math.trunc(request.retryMaxAttempts)) } }
          : {}),
        ...(request.useContextBroker === true
          ? {
              contextBroker: createContextBroker(),
              ...(request.contextMaxBytes != null && request.contextMaxBytes > 0
                ? { contextBrokerOptions: { maxBytes: Math.trunc(request.contextMaxBytes) } }
                : {})
            }
          : {}),
        ...(resumeFrom ? { resumeFrom } : {}),
        onEvent: (event) => sendAgentEvent(sessionId, event)
      }).then((result) => {
        activeAgentRuns.delete(sessionId);
        rejectSessionApprovals(sessionId, '会话已结束，未回答的审批按拒绝处理。');
        const relativeRolloutPath = relative(agentSessionsBaseDir, result.rolloutPath).replace(/\\/g, '/');
        sendAgentEvent(sessionId, {
          type: 'session-done',
          finishReason: result.run.finishReason,
          steps: result.run.steps,
          rolloutFileName: relativeRolloutPath
        });
      }).catch((error: unknown) => {
        activeAgentRuns.delete(sessionId);
        // Also on the failure path: a crashed run must not leave resolvers parked.
        rejectSessionApprovals(sessionId, '会话异常结束，未回答的审批按拒绝处理。');
        sendAgentEvent(sessionId, {
          type: 'session-error',
          code: 'AGENT_SESSION_FAILED',
          message: error instanceof Error ? error.message : String(error)
        });
      });
  
      return { ok: true, sessionId };
    });

  deps.handle(
    'ai.agent.events',
    async (
      event,
      rawSessionId: unknown,
      rawAfterSeq?: unknown
    ): Promise<AiAgentEventReplayIpcResult> => {
      if (typeof rawSessionId !== 'string' || rawSessionId.trim() === '') {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 必填。' } };
      }
      const sessionId = rawSessionId.trim();
      const ownerId = agentSessionOwners.get(sessionId);
      if (ownerId === undefined || ownerId !== event.sender.id) {
        return { ok: false, error: { code: 'AGENT_SESSION_FORBIDDEN', message: '无权读取该 Agent 会话事件。' } };
      }
      const afterSeq = rawAfterSeq === undefined ? 0 : rawAfterSeq;
      if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'afterSeq 必须是非负安全整数。' } };
      }
      return {
        ok: true,
        events: (agentEventHistory.get(sessionId) ?? []).filter((envelope) => envelope.seq > afterSeq)
      };
    }
  );
  
  deps.handle('ai.agent.cancel', async (_event, sessionId: string): Promise<{ ok: boolean }> => {
      const entry = activeAgentRuns.get(sessionId);
      if (entry) entry.controller.abort();
      // Cancel must also settle parked approvals. An abort signal does not reach
      // a promise the loop is awaiting, so without this the loop would sit in the
      // tool phase waiting for an answer the user has already walked away from.
      rejectSessionApprovals(sessionId, '任务已取消，未回答的审批按拒绝处理。');
      return { ok: true };
    });
  
  deps.handle(
      'ai.agent.approval.respond',
      async (
        _event,
        request: AiAgentApprovalResponseRequest
      ): Promise<{ ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }> => {
        if (
          typeof request?.sessionId !== 'string' || request.sessionId === ''
          || typeof request?.callId !== 'string' || request.callId === ''
        ) {
          return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 与 callId 必填。' } };
        }
        // 用户可发起的四档。`timed_out` 刻意**不在**其中：它只能由主进程的超时
        // 定时器产生。允许 renderer 自称超时会让「没人回答」这个事实可以被伪造，
        // 而审计正是靠它区分「用户拒绝」与「无人在场」。
        const allowed = ['once', 'always', 'reject', 'never', 'abort'] as const;
        if (!allowed.includes(request.decision as (typeof allowed)[number])) {
          return {
            ok: false,
            error: {
              code: 'INVALID_INPUT',
              message: `decision 取值应为 ${allowed.join(' | ')} 之一。`
            }
          };
        }
        const matched = settleApproval(`${request.sessionId}:${request.callId}`, {
          decision: request.decision,
          ...(typeof request.note === 'string' && request.note !== '' ? { note: request.note } : {})
        });
        return { ok: true, matched };
      }
    );
  
  deps.handle(
      'agent.approval.decide',
      async (_event, request: unknown): Promise<
        { ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }
      > => {
        let decoded: DecideAgentApprovalRequest;
        try {
          decoded = decodeDecideAgentApprovalRequest(request, 'DecideAgentApprovalRequest');
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'INVALID_INPUT',
              message: error instanceof Error ? error.message : '审批决定请求格式非法。'
            }
          };
        }
        const decision = decoded.decision === 'approve-and-commit' ? 'once' : 'reject';
        const matched = settleApproval(`${decoded.sessionId}:${decoded.reviewId}`, { decision });
        return { ok: true, matched };
      }
    );
  
  deps.handle('ai.agent.sessions', async (): Promise<AiAgentSessionListIpcResult> => {
      const sessions = await listRolloutSessions(agentSessionsBaseDir, 50);
      return {
        ok: true,
        sessions: sessions.map((session) => ({
          sessionPath: relative(agentSessionsBaseDir, session.path),
          fileName: session.fileName,
          sessionId: session.sessionId,
          startedAt: session.startedAt,
          messageCount: session.messageCount,
          parseErrors: session.parseErrors,
          interrupted: session.interrupted,
          compactedWindows: session.compactedWindows,
          sizeBytes: session.sizeBytes,
          modifiedAt: session.modifiedAt
        }))
      };
    });
  
  deps.handle('ai.agent.session.load', async (_event, sessionPath: string): Promise<AiAgentSessionLoadIpcResult> => {
      if (typeof sessionPath !== 'string' || sessionPath.trim() === '') {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionPath 必填。' } };
      }
      const resolved = resolveSessionPath(sessionPath);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const loaded = await loadRolloutSession(resolved.absolute);
      if (!loaded.ok) {
        return { ok: false, error: { code: loaded.code, message: loaded.message } };
      }
      return {
        ok: true,
        meta: loaded.meta,
        messageCount: loaded.messages.length,
        parseErrors: loaded.parseErrors,
        interrupted: loaded.interrupted,
        compactedWindows: loaded.compactedWindows,
        messagesPage: loaded.messages.slice(-20)
      };
    });
  
  deps.handle(
      'agent.resourceReference.create',
      async (event, request: unknown): Promise<AgentResourceReferenceCreateIpcResult> => {
        // T6：引用资源需要工作区；无工作区时干净失败（文案逐字来自产品拍死），
        // 与 ai.runTool / ai.agent.run 的工具层守卫同一语义。
        if (!deps.getActiveIndex()) {
          return { ok: false, error: { code: 'WORKSPACE_REQUIRED', message: '这次工具需要先打开 Mod 工作区。' } };
        }
        const selectionValue = typeof request === 'object' && request !== null
          ? (request as Record<string, unknown>).selection
          : undefined;
        let selection: EditorSelectionContext;
        try {
          selection = decodeEditorSelectionContext(selectionValue, 'ResourceReferenceRequest.selection');
        } catch (error) {
          return {
            ok: false,
            error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : '选区格式非法。' }
          };
        }
        const issues = selectionRendererSafetyIssues(selection);
        if (issues.length > 0) {
          return {
            ok: false,
            error: {
              code: 'AGENT_SELECTION_UNSAFE',
              message: issues.map((issue) => issue.message).join('；'),
              diagnostics: issues
            }
          };
        }
        const tokenId = randomUUID();
        const ownerId = String(event.sender.id);
        const label = agentSelectionSummary(selection);
        const token = mintAgentReferenceToken({
          kind: 'resource',
          tokenId,
          ownerId,
          domain: selection.domain,
          label
        });
        const reference: AgentResourceReference = {
          token,
          domain: selection.domain,
          label,
          expiresAt: agentReferenceExpiresAt()
        };
        agentReferenceRegistry.set(token, { ownerId, tokenId });
        return { ok: true, reference };
      }
    );
  
  deps.handle('agent.citation.create', async (event, request: unknown): Promise<AgentResourceReferenceCreateIpcResult> => {
      if (!deps.getActiveIndex()) {
        return { ok: false, error: { code: 'WORKSPACE_REQUIRED', message: '这次工具需要先打开 Mod 工作区。' } };
      }
      const hitsValue = typeof request === 'object' && request !== null
        ? (request as Record<string, unknown>).hits
        : undefined;
      let citation: Citation | null = null;
      try {
        citation = mergeCiteHits(decodeCiteHits(hitsValue));
      } catch (error) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: error instanceof Error ? error.message : '引用框选格式非法。' }
        };
      }
      if (citation === null) {
        return {
          ok: false,
          error: {
            code: 'CITATION_UNSUPPORTED',
            message: '这块还不能引用：框选命中跨了不同的表或行，或没有可引用的节点。'
          }
        };
      }
      const tokenId = randomUUID();
      const ownerId = String(event.sender.id);
      const label = formatCitationLabel(citation);
      // S10：引用领域随命中种类 —— param 行/字段、text 条目、event 脚本。
      const domain = citation.kind === 'param' ? 'param' : citation.kind;
      const token = mintAgentReferenceToken({
        kind: 'citation',
        tokenId,
        ownerId,
        domain,
        label
      });
      const reference: AgentResourceReference = {
        token,
        domain,
        label,
        expiresAt: agentReferenceExpiresAt()
      };
      agentReferenceRegistry.set(token, { ownerId, tokenId, citation });
      return { ok: true, reference };
    });
  
  deps.handle('agent.attachment.create', async (): Promise<AgentAttachmentCreateIpcResult> => {
      return { ok: false, cancelled: true, error: { code: 'ATTACHMENT_CANCELLED', message: '未选择附件文件。' } };
    });
  
}
