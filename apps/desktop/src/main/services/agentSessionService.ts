import { BoundedEventHistory } from '../../../../../packages/agent/src/eventHistory.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { createAgentToolBridge, createConfirmationReceipt, createUnifiedDiff, CoreToolSession, openAgentCoreToolSession, createAgentToolContextProvider, createAgentRagSearch, listRolloutSessions, loadRolloutSession, createAgentRunAssembly, type AgentEvent, type ApprovalDecision, type ApprovalDiff, type ResumedRollout, type AgentSessionRunParams, type ToolContext, type ToolRegistry, type WorkspaceIndex, type WorkspaceSession } from '@soulforge/core';
import type { ConfirmationReceipt } from '@soulforge/shared';
import type { AiAgentRunRequest, AiAgentRunIpcResult, AiAgentCancelIpcResult, AiAgentEventEnvelope, AiAgentSessionLifecycleEvent, AiAgentEventReplayIpcResult, AiAgentSessionListIpcResult, AiAgentSessionLoadIpcResult } from '../../ipc/publicTypes.js';
import type { MemoryManager } from '../memoryManager.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { AgentEvidenceService } from './agentEvidenceService.js';
import { sanitizeRendererValue } from '../rendererDto.js';
import { agentSessionOutcomeEvents } from '../agentSessionOutcome.js';
import { createAgentBridgeBaseContext } from '../ipc/agentBridgeContext.js';
import { countGeneratedTextDiffLines } from '../ipc/generatedTextDiffCounts.js';

type AgentAssembly = ReturnType<typeof createAgentRunAssembly>;
type AdmittedInvocation = Pick<AgentSessionRunParams, 'sessionsDir' | 'sessionId' | 'prompt' | 'systemPrompt' | 'permissionMode' | 'signal' | 'requestApproval' | 'resolveApprovalDiff' | 'approvalRequiredLevels' | 'resumeFrom' | 'onEvent'>;
type AgentConfirmationRequest = { resourceLabel: string; sourceUri: string; actionLabel: string; payloadHash: string; extraSubjects?: string[] };
export interface AdmittedAgentRun {
  ownerId: number;
  sessionId: string;
  mode: ToolContext['mode'];
  request: AiAgentRunRequest;
  citationLines: readonly string[];
  resumeFrom?: ResumedRollout;
  authorization: {
    serviceId: string;
    model: string;
    sampling: NonNullable<AgentSessionRunParams['sampling']>;
    contextWindowTokens?: number;
    bindTarget(): void;
    requestWriteConfirmation(input: AgentConfirmationRequest): Promise<ConfirmationReceipt | null>;
    execute(assembly: AgentAssembly, invocation: AdmittedInvocation): ReturnType<AgentAssembly['run']>;
  };
}
export interface AgentSessionServiceDeps {
  sessionsDir: string;
  toolRegistry: ToolRegistry;
  memoryManager: Pick<MemoryManager, 'getFullMemoryForSystemPrompt'>;
  operationLogUtility: OperationLogUtilityClient;
  getActiveIndex(): WorkspaceIndex | null;
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
  waitForWorkspaceIndexing(signal?: AbortSignal): Promise<void>;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  durableStoragePaths(workspaceId: string): { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  currentToolContext(): ToolContext;
  readSystemPrompt(): string | null;
  ownerAvailable(ownerId: number): boolean;
  publishEvent(ownerId: number | undefined, envelope: AiAgentEventEnvelope): void;
  sessionRunner: NonNullable<NonNullable<Parameters<typeof createAgentRunAssembly>[1]>['sessionRunner']>;
  evidence: AgentEvidenceService;
}

/** Application-owned run/session/approval/replay coordination. Trusted adapters
 * supply admitted owners and one execution capability per accepted request. */
export function createAgentSessionService(input: AgentSessionServiceDeps) {
  const deps = Object.freeze({ ...input });
  const agentSessionsBaseDir = deps.sessionsDir;
  const APPROVAL_TIMEOUT_MS = 600_000;

  const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
  const DEFAULT_REQUEST_MAX_STEPS = 200;

  const AGENT_EVENT_HISTORY_LIMIT = 4_096;

  const AGENT_EVENT_HISTORY_TTL_MS = 5 * 60_000;

  const activeAgentRuns = new Map<string, { controller: AbortController; ownerId: number; serviceId: string; model: string; }>();

  const pendingApprovals = new Map<string, { resolve: (response: { decision: ApprovalDecision; note?: string }) => void; timer: NodeJS.Timeout }>();

  const agentSessionSeqs = new Map<string, number>();

  const agentSessionOwners = new Map<string, number>();

  const agentEventHistory = new Map<string, BoundedEventHistory<AiAgentEventEnvelope>>();

  const agentEventHistoryCleanup = new Map<string, NodeJS.Timeout>();

  function forbiddenAgentSession(): { ok: false; error: { code: string; message: string } } {
    return {
      ok: false,
      error: { code: 'AGENT_SESSION_FORBIDDEN', message: '无权操作该 Agent 会话。' }
    };
  }

  function sessionOwnerMatches(sessionId: string, senderId: number): boolean {
    return agentSessionOwners.get(sessionId) === senderId;
  }

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

  function freezeOwnedEvent(value: unknown): void {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freezeOwnedEvent(child);
    Object.freeze(value);
  }

  const sendAgentEvent = (sessionId: string, event: AgentEvent | AiAgentSessionLifecycleEvent): void => {
    const seq = (agentSessionSeqs.get(sessionId) ?? 0) + 1;
    agentSessionSeqs.set(sessionId, seq);
    const envelope = sanitizeRendererValue({ sessionId, seq, event }) as AiAgentEventEnvelope;
    // The sanitized snapshot is owned here. Replay/publish callers must not
    // mutate it after the bounded history measured its serialized size.
    freezeOwnedEvent(envelope);
    const history = agentEventHistory.get(sessionId) ?? new BoundedEventHistory<AiAgentEventEnvelope>({maxEntries:AGENT_EVENT_HISTORY_LIMIT,maxBytes:2_097_152});
    history.append(envelope);
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
    const ownerId = agentSessionOwners.get(sessionId);
    deps.publishEvent(ownerId, envelope);
  };

  function clearState(): void {
    for (const key of [...pendingApprovals.keys()]) {
      const p = pendingApprovals.get(key);
      if (p) { clearTimeout(p.timer); p.resolve({ decision: 'reject', note: '状态已重置，未回答的审批按拒绝处理。' }); }
    }
    pendingApprovals.clear();
    for (const timer of agentEventHistoryCleanup.values()) clearTimeout(timer);
    agentEventHistoryCleanup.clear();
    agentEventHistory.clear();
    agentSessionOwners.clear();
    agentSessionSeqs.clear();
  }

  async function loadResume(sessionPath: string): Promise<ResumedRollout | undefined> {
        let resumeFrom: ResumedRollout | undefined;
        if (sessionPath !== undefined) {
          const resolved = resolveSessionPath(sessionPath);
          if (resolved.ok) {
            const loaded = await loadRolloutSession(resolved.absolute);
            if (loaded.ok) {
              const { ok: _ok, path: _path, ...resumed } = loaded;
              resumeFrom = resumed;
            } else {
              console.warn(`[SoulForge Agent] 尝试承接会话未找到或读取失败（${loaded.code}：${loaded.message}），平滑降级为新会话启动。`);
            }
          } else {
            console.warn(`[SoulForge Agent] 尝试承接会话路径非法（${resolved.error.code}：${resolved.error.message}），平滑降级为新会话启动。`);
          }
        }


    return resumeFrom;
  }

  async function run(input: AdmittedAgentRun): Promise<AiAgentRunIpcResult> {
    const { ownerId, sessionId, mode, request, citationLines, resumeFrom, authorization } = input;
    const { sampling, contextWindowTokens } = authorization;
        // One CoreToolSession owns the native edit handles, snapshot cache,
        // source watcher and automatic NativeReadProof store for this Agent
        // subject. It is intentionally per-run, so proofs cannot cross Agent
        // identities or a later workspace session.
        const activeWorkspaceSession = deps.getActiveSession();
        const activeWorkspaceIndex = deps.getActiveIndex();
        let coreSession: CoreToolSession | undefined;
        if (activeWorkspaceSession) {
          const storage = deps.durableStoragePaths(activeWorkspaceSession.meta.workspaceId);
          coreSession = await openAgentCoreToolSession({
            principal: `agent:${sessionId}`,
            workspaceSession: activeWorkspaceSession,
            ...(activeWorkspaceIndex ? { workspaceIndex: activeWorkspaceIndex } : {}),
            getWorkspaceSession: () => deps.getActiveSession(),
            getOperationLog: (session) => deps.ensureActiveOperationLog(session),
            storage,
            modeCeiling: mode
          });
        }
        const currentAgentContext = createAgentToolContextProvider({
          ...(coreSession ? { coreSession } : {}),
          ...(activeWorkspaceSession ? { workspaceSession: activeWorkspaceSession } : {}),
          getWorkspaceSession: () => deps.getActiveSession(),
          getWorkspaceIndex: () => deps.getActiveIndex(),
          getToolContext: () => deps.currentToolContext()
        });
        // 无工作区时 deps.getActiveIndex() 为 null：工具层按工具守卫（WORKSPACE_REQUIRED），
        // 需要工作区的工具干净失败，不整次拒绝（T6）。
        const bridge = createAgentToolBridge({
          registry: deps.toolRegistry,
          contextProvider: currentAgentContext,
          // Agent 可以读取记忆来恢复项目上下文，但不能把未经用户明确整理的
          // 运行时对话或测试内容写入长期记忆；记忆写入只保留给显式宿主流程。
          context: createAgentBridgeBaseContext(mode),
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
              // The run's mode is stable for its lifetime; all workspace/RAG/
              // session state is refreshed per tool call by currentAgentContext.
              mode: currentRunMode,
              modeCeiling: mode,
              allowMemoryWrite: false,
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
            if (deps.toolRegistry.list().some(tool => tool.name === call.name && tool.effect === 'write')) {
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
            const confirmation = await authorization.requestWriteConfirmation({
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
          ownerId: ownerId,
          serviceId: authorization.serviceId,
          model: authorization.model
        });
        agentSessionOwners.set(sessionId, ownerId);
        authorization.bindTarget();
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
            if (!deps.ownerAvailable(ownerId)) {
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
          const { addedLines, removedLines } = countGeneratedTextDiffLines(lines);

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

        const ragSearchAvailable = request.useRagSearch === true ? await deps.evidence.hasRagSearchCorpus() : false;

        const ragWorkspace = activeWorkspaceSession ?? deps.getActiveSession();
        const ragSearch = ragSearchAvailable && ragWorkspace ? createAgentRagSearch({
          workspaceSession: ragWorkspace,
          getWorkspaceSession: () => deps.getActiveSession(),
          signal: controller.signal,
          waitForIndexing: (signal) => deps.waitForWorkspaceIndexing(signal),
          retrieve: (query, signal) => deps.evidence.searchWorkspaceEvidence(
            deps.operationLogUtility.forWorkspace(ragWorkspace.meta.workspaceId), query, { signal }
          )
        }) : undefined;
        const assembly = createAgentRunAssembly(bridge, {
          sessionRunner: deps.sessionRunner,
          ...(coreSession ? { coreSession } : {}),
          composition: {
            // Desktop defaults bound steps and total time without a monetary ceiling.
            controls: { ...request, maxSteps: request.maxSteps ?? DEFAULT_REQUEST_MAX_STEPS },
            defaultTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            maxStepsCeiling: DEFAULT_REQUEST_MAX_STEPS,
            autoCompaction: true,
            ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
            sampling,
            ...(ragSearch ? { ragSearch } : {})
          }
        });
        void authorization.execute(assembly, {
          sessionsDir: agentSessionsBaseDir,
          sessionId,
          prompt: request.prompt,
          ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
          permissionMode,
          signal: controller.signal,
          requestApproval,
          resolveApprovalDiff,
          // Renderer-supplied approvalRequiredLevels are never an authority.
          // Only an explicitly main-granted fullPermission session may disable
          // the core loop's default approval levels.
          ...(mode === 'fullPermission' ? { approvalRequiredLevels: [] } : {}),
          ...(resumeFrom ? { resumeFrom } : {}),
          onEvent: (event) => sendAgentEvent(sessionId, event)
        }).then((result) => {
          activeAgentRuns.delete(sessionId);
          rejectSessionApprovals(sessionId, '会话已结束，未回答的审批按拒绝处理。');
          const relativeRolloutPath = relative(agentSessionsBaseDir, result.rolloutPath).replace(/\\/g, '/');
          for(const terminalEvent of agentSessionOutcomeEvents(result,relativeRolloutPath))sendAgentEvent(sessionId,terminalEvent);
        }).catch((error: unknown) => {
          activeAgentRuns.delete(sessionId);
          // Also on the failure path: a crashed run must not leave resolvers parked.
          rejectSessionApprovals(sessionId, '会话异常结束，未回答的审批按拒绝处理。');
          sendAgentEvent(sessionId, {
            type: 'session-error',
            code: 'AGENT_SESSION_FAILED',
            message: error instanceof Error ? error.message : String(error)
          });
        }).finally(async () => {
          await assembly.waitForHostOperations();
          coreSession?.close();
        });

        return { ok: true, sessionId };

  }

  async function events(senderId: number, rawSessionId: unknown, rawAfterSeq?: unknown): Promise<AiAgentEventReplayIpcResult> {

        if (typeof rawSessionId !== 'string' || rawSessionId.trim() === '') {
          return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionId 必填。' } };
        }
        const sessionId = rawSessionId.trim();
        const ownerId = agentSessionOwners.get(sessionId);
        if (ownerId === undefined || ownerId !== senderId) {
          return { ok: false, error: { code: 'AGENT_SESSION_FORBIDDEN', message: '无权读取该 Agent 会话事件。' } };
        }
        const afterSeq = rawAfterSeq === undefined ? 0 : rawAfterSeq;
        if (typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
          return { ok: false, error: { code: 'INVALID_INPUT', message: 'afterSeq 必须是非负安全整数。' } };
        }
        return {
          ok: true,
          ...(agentEventHistory.get(sessionId)?.replay(afterSeq) ?? {events:[],truncated:false,firstAvailableSeq:null})
        };

  }

  async function cancel(ownerId: number, sessionId: string): Promise<AiAgentCancelIpcResult> {

        if (typeof sessionId !== 'string' || sessionId.trim() === '' || !sessionOwnerMatches(sessionId, ownerId)) {
          return forbiddenAgentSession();
        }
        const entry = activeAgentRuns.get(sessionId);
        if (entry) entry.controller.abort();
        // Cancel must also settle parked approvals. An abort signal does not reach
        // a promise the loop is awaiting, so without this the loop would sit in the
        // tool phase waiting for an answer the user has already walked away from.
        rejectSessionApprovals(sessionId, '任务已取消，未回答的审批按拒绝处理。');
        return { ok: true };

  }

  async function listSessions(): Promise<AiAgentSessionListIpcResult> {

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

  }

  async function loadSession(sessionPath: string): Promise<AiAgentSessionLoadIpcResult> {

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

  }

  function closeOwner(ownerId: number): void {
    for (const [sessionId, entry] of activeAgentRuns) {
      if (entry.ownerId !== ownerId) continue;
      entry.controller.abort();
      rejectSessionApprovals(sessionId, '渲染进程已关闭，未回答的审批按拒绝处理。');
    }
  }

  return Object.freeze({ run, events, cancel, loadResume, listSessions, loadSession, clearState, closeOwner,
    sessionOwnerMatches, settleApproval, isActive: (sessionId: string) => activeAgentRuns.has(sessionId),
    hasActiveRuns: () => activeAgentRuns.size > 0 });
}
export type AgentSessionService = ReturnType<typeof createAgentSessionService>;
