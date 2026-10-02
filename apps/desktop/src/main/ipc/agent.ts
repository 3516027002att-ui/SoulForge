import { runAgentUtilitySession } from '../agentUtilityClient.js';
import { randomUUID } from 'node:crypto';
import { app, dialog } from 'electron';
import type { WebContents, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import {
  buildAiSidebarDraft,
  createConfiguredModelServiceAdapter
} from '@soulforge/core';
import type {
  RagCorpus,
  ToolContext,
  ToolResult,
  WorkspaceIndex,
  WorkspaceSession,
  AiSidebarDraft,
  AiSidebarDraftRequest
} from '@soulforge/core';
import type { ConfirmationReceipt, RagChunkFamily, RagLocalModelStatus, RagRetrieveResult } from '@soulforge/shared';
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
import { maskPathFragments } from '@soulforge/shared';
import { sanitizeRendererValue } from '../rendererDto.js';
import type { TrustedIpcHandle } from './registration.js';
import type { MemoryManager } from '../memoryManager.js';
import type { ModelServiceCredentialVault } from '../modelServiceCredentials.js';
import type { OperationLogUtilityClient, WorkspaceBoundUtilityStore } from '../operationLogUtilityClient.js';
import { createAgentSessionService, type AgentSessionService } from '../services/agentSessionService.js';
import { createAgentEvidenceService, type AgentEvidenceService } from '../services/agentEvidenceService.js';
import { InternalRagEmbeddingService } from '../ragEmbedding.js';

import type {
  AiAgentRunRequest,
  AiAgentApprovalResponseRequest,
  AiAgentRunIpcResult,
  AiAgentPermissionRequestResult,
  AiAgentCancelIpcResult,
  AiAgentEventReplayIpcResult,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AgentResourceReferenceCreateIpcResult,
  AgentAttachmentCreateIpcResult
} from '../../ipc/publicTypes.js';
export type {
  AiAgentRunRequest,
  AiAgentApprovalResponseRequest,
  AiAgentRunIpcResult,
  AiAgentPermissionRequestResult,
  AiAgentCancelIpcResult,
  AiAgentEventReplayIpcResult,
  AiAgentSessionSummaryIpc,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AiAgentSessionLifecycleEvent,
  AiAgentEventEnvelope,
  AgentResourceReferenceCreateIpcResult,
  AgentAttachmentCreateIpcResult
} from '../../ipc/publicTypes.js';

const AGENT_PERMISSION_GRANT_TTL_MS = 5 * 60_000;

const agentSessionsBaseDir = join(app.getPath('userData'), 'agent');
const internalRagEmbedding = new InternalRagEmbeddingService(join(app.getPath('userData'), 'rag', 'embedding-cache'));
const agentReferenceRegistry = new Map<string, { ownerId: string; tokenId: string; citation?: Citation }>();
const agentEventTargets = new Map<number, WebContents>();
const boundAgentWindows = new WeakSet<WebContents>();
const agentPermissionGrants = new Map<string, {
  ownerId: number;
  mode: 'plan' | 'normal' | 'fullPermission';
  expiresAt: number;
}>();
let boundWebContents: WebContents | null = null;
let sessionService: AgentSessionService | null = null;
let evidenceService: AgentEvidenceService | null = null;

function bindAgentOwnerWindow(target: WebContents): void {
  if (boundAgentWindows.has(target)) return;
  boundAgentWindows.add(target);
  target.once('destroyed', () => {
    sessionService?.closeOwner(target.id);
    agentEventTargets.delete(target.id);
    boundAgentWindows.delete(target);
    if (boundWebContents === target) boundWebContents = null;
  });
}

function forbiddenAgentSession(): { ok: false; error: { code: string; message: string } } {
  return {
    ok: false,
    error: { code: 'AGENT_SESSION_FORBIDDEN', message: '无权操作该 Agent 会话。' }
  };
}

function sessionOwnerMatches(sessionId: string, senderId: number): boolean {
  return sessionService?.sessionOwnerMatches(sessionId, senderId) ?? false;
}

function consumePermissionGrant(
  event: IpcMainInvokeEvent,
  request: AiAgentRunRequest
): { ok: true; mode: 'plan' | 'normal' | 'fullPermission' } | { ok: false; error: { code: string; message: string } } {
  const requestedMode = request.mode ?? 'plan';
  const hasGrantId = typeof request.permissionGrantId === 'string' && request.permissionGrantId.trim() !== '';
  if (!hasGrantId && requestedMode === 'plan') return { ok: true, mode: 'plan' };
  if (!hasGrantId) {
    return {
      ok: false,
      error: { code: 'AGENT_PERMISSION_REQUIRED', message: '该 Agent 权限模式必须由主进程先签发一次性授权。' }
    };
  }
  const grantId = request.permissionGrantId?.trim() ?? '';
  const grant = agentPermissionGrants.get(grantId);
  agentPermissionGrants.delete(grantId);
  if (!grant || grant.ownerId !== event.sender.id || grant.expiresAt < Date.now()
    || (requestedMode !== 'plan' && grant.mode !== requestedMode)) {
    return {
      ok: false,
      error: { code: 'AGENT_PERMISSION_INVALID', message: 'Agent 权限授权无效、已过期或不属于当前窗口。' }
    };
  }
  return { ok: true, mode: grant.mode };
}
export function isAgentSessionActive(sessionId: string): boolean { return sessionService?.isActive(sessionId) ?? false; }
export function hasActiveAgentRuns(): boolean { return sessionService?.hasActiveRuns() ?? false; }
export function clearAgentIpcState(): void {
  void internalRagEmbedding.close();
  sessionService?.clearState();
  agentReferenceRegistry.clear();
  agentEventTargets.clear();
  agentPermissionGrants.clear();
}

export function scheduleInternalRagEmbedding(corpus: RagCorpus, database: WorkspaceBoundUtilityStore): void {
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
  /** 等待当前一次性工作区分析；不会为每次 RAG 查询重新扫描。 */
  waitForWorkspaceIndexing: (signal?: AbortSignal) => Promise<void>;
  ensureActiveOperationLog: (session: WorkspaceSession) => Promise<OperationLogUtilityClient>;
  durableStoragePaths: (workspaceId: string) => { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  currentToolContext: () => ToolContext;
  requestWriteConfirmation: (input: { event?: IpcMainInvokeEvent; resourceLabel: string; sourceUri: string; actionLabel: string; payloadHash: string; extraSubjects?: string[] }) => Promise<ConfirmationReceipt | null>;
  readSystemPrompt: () => string | null;
}

export function registerAgentIpcHandlers(deps: AgentIpcDeps): void {
  const evidence = evidenceService ??= createAgentEvidenceService({
    internalRagEmbedding, operationLogUtility: deps.operationLogUtility,
    getActiveIndex: deps.getActiveIndex, getActiveSession: deps.getActiveSession,
    getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId,
    getActiveWorkspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration,
    currentToolContext: deps.currentToolContext, ensureActiveOperationLog: deps.ensureActiveOperationLog
  });
  const sessions = sessionService ??= createAgentSessionService({
    sessionsDir: agentSessionsBaseDir, toolRegistry: deps.toolRegistry, memoryManager: deps.memoryManager,
    operationLogUtility: deps.operationLogUtility, getActiveIndex: deps.getActiveIndex, getActiveSession: deps.getActiveSession,
    getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId, waitForWorkspaceIndexing: deps.waitForWorkspaceIndexing,
    ensureActiveOperationLog: deps.ensureActiveOperationLog, durableStoragePaths: deps.durableStoragePaths,
    currentToolContext: deps.currentToolContext,
    readSystemPrompt: deps.readSystemPrompt, evidence, sessionRunner: runAgentUtilitySession,
    ownerAvailable: ownerId => { const target = agentEventTargets.get(ownerId); return !!target && !target.isDestroyed(); },
    publishEvent: (ownerId, envelope) => {
      const target = ownerId === undefined ? boundWebContents : agentEventTargets.get(ownerId);
      if (!target || target.isDestroyed()) return;
      target.send('ai:agent:event', envelope);
    }
  });
  boundWebContents = deps.webContents;
  bindAgentOwnerWindow(deps.webContents);
  const activeAiMode: ToolContext['mode'] = 'plan';
  deps.handle(
    'ai.agent.permission.request',
    async (event, requestedMode: unknown): Promise<AiAgentPermissionRequestResult> => {
      if (requestedMode !== 'plan' && requestedMode !== 'normal' && requestedMode !== 'fullPermission') {
        return { ok: false, error: { code: 'INVALID_INPUT', message: 'Agent 权限模式无效。' } };
      }
      let mode: 'plan' | 'normal' | 'fullPermission' = requestedMode;
      if (mode === 'fullPermission') {
        const confirmation = await dialog.showMessageBox({
          type: 'warning',
          title: '确认 Agent 完全权限',
          message: '允许本次 Agent 会话免审批提交工作区修改吗？',
          detail: '这只对下一次会话有效；工作区写入仍必须经过 Patch Engine、备份和回滚边界。',
          buttons: ['允许本次', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        if (confirmation.response !== 0) {
          return { ok: false, error: { code: 'AGENT_PERMISSION_DENIED', message: '用户未授予 Agent 完全权限。' } };
        }
      }
      const grantId = randomUUID();
      const expiresAt = Date.now() + AGENT_PERMISSION_GRANT_TTL_MS;
      agentPermissionGrants.set(grantId, { ownerId: event.sender.id, mode, expiresAt });
      return { ok: true, grantId, mode, expiresAt: new Date(expiresAt).toISOString() };
    }
  );
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
      const session = deps.getActiveSession();
      if (session) await deps.ensureActiveOperationLog(session);
      return deps.toolRegistry.run(name, input, deps.currentToolContext());
    }
  );

  deps.handle('rag.embed', async (_event, _input: unknown): Promise<
      | { ok: true; embedded: number; reused: number; failed: number; model: string; dim: number }
      | { ok: false; error: { code: string; message: string } }
    > => { return evidence.embed(); });

  deps.handle('rag.localModelStatus', async (): Promise<RagLocalModelStatus> => { return evidence.localModelStatus(); });

  deps.handle('rag.searchEvidence', async (_event, input: {
      query: string;
      limit?: number;
      families?: readonly RagChunkFamily[];
      expandReferences?: boolean;
    }): Promise<RagRetrieveResult> => { return evidence.searchEvidence(input); });
  
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

      const resumeFrom = request.resumeSessionPath === undefined ? undefined : await sessions.loadResume(request.resumeSessionPath);

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
      const permission = consumePermissionGrant(_event, request);
      if (!permission.ok) return permission;
      const mode: ToolContext['mode'] = permission.mode;
      return sessions.run({
        ownerId: _event.sender.id, sessionId, mode, request, citationLines,
        ...(resumeFrom ? { resumeFrom } : {}),
        authorization: {
          serviceId: stored.id, model: stored.model, sampling,
          ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
          bindTarget: () => {
            bindAgentOwnerWindow(_event.sender);
            agentEventTargets.set(_event.sender.id, _event.sender);
            if (_event.sender.isDestroyed()) sessions.closeOwner(_event.sender.id);
          },
          requestWriteConfirmation: input => _event.sender.isDestroyed()
            ? Promise.resolve(null)
            : deps.requestWriteConfirmation({ ...input, event: _event }),
          execute: (assembly, invocation) => assembly.run({
            ...invocation, adapter: adapterResult.adapter, config: modelConfig, apiKey,
            recordProviderUsage: async (sample) => {
              await deps.operationLogUtility.recordProviderUsage({
                eventId: `${sessionId}:${sample.callIndex}`, sessionId, serviceId: stored.id,
                protocol: stored.protocol, model: stored.model, ...sample
              });
            }
          })
        }
      });
    });

  deps.handle(
    'ai.agent.events',
    async (
      event,
      rawSessionId: unknown,
      rawAfterSeq?: unknown
    ): Promise<AiAgentEventReplayIpcResult> => { return sessions.events(event.sender.id, rawSessionId, rawAfterSeq); }
  );
  
  deps.handle('ai.agent.cancel', async (_event, sessionId: string): Promise<AiAgentCancelIpcResult> => { return sessions.cancel(_event.sender.id, sessionId); });
  
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
        if (!sessionOwnerMatches(request.sessionId, _event.sender.id)) return forbiddenAgentSession();
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
        const matched = sessions.settleApproval(`${request.sessionId}:${request.callId}`, {
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
        if (!sessionOwnerMatches(decoded.sessionId, _event.sender.id)) return forbiddenAgentSession();
        const matched = sessions.settleApproval(`${decoded.sessionId}:${decoded.reviewId}`, { decision });
        return { ok: true, matched };
      }
    );
  
  deps.handle('ai.agent.sessions', async (): Promise<AiAgentSessionListIpcResult> => { return sessions.listSessions(); });
  
  deps.handle('ai.agent.session.load', async (_event, sessionPath: string): Promise<AiAgentSessionLoadIpcResult> => { return sessions.loadSession(sessionPath); });
  
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
