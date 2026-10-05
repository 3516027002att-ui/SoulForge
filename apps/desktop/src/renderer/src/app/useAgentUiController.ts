import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeCiteHits } from '@soulforge/shared';
import type { AgentResourceReference, AgentAttachmentReference, CiteHit } from '@soulforge/shared';
import type { AiProvider, AiPermissionMode, AiSidebarDraft, ModelThinkingLevel, ToolResult, ToolDescriptor } from '@soulforge/core';
import type { AiAgentRunRequest } from '../../../main/ipc.js';
import type { RendererRuntime } from '../runtime/rendererRuntime.js';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { clampAgentDockWidth } from '../agent/AgentDockResizer.js';
import { toAgentAttachmentReferences, type AgentAttachmentChip } from '../agent/agentAttachments.js';
import type { AgentSessionDetail, AgentSessionRow, ModelServiceChoice } from '../agent/AgentTaskPanel.js';
import { INITIAL_AGENT_TASK_STATE, canAutoResumeAgentTask, markAgentTaskCancelling, startAgentTask, type AgentApprovalUserDecision, type AgentTaskState } from '../agent/agentTaskState.js';
import { useAgentEventController } from './useAgentEventController.js';

export type AgentUiBridge = Pick<NonNullable<RendererRuntime['bridge']>,
  'listModelServices' | 'listAiTools' | 'onAiAgentEvent' | 'getAiAgentEvents'
  | 'requestAiAgentPermission' | 'runAiAgent' | 'cancelAiAgent' | 'respondAiAgentApproval'
  | 'listAiAgentSessions' | 'loadAiAgentSession' | 'runAiTool'>;
export type AgentUiInteractionMode = 'ask' | 'plan' | 'edit' | 'bypass';
export type AgentUiOpenFailure = NonNullable<AiAgentRunRequest['openFailure']>;
export interface AgentUiOptions {
  bridge: AgentUiBridge | null;
  workspace: { workspaceSessionId: string } | null;
  selectedFile: Pick<RendererIndexedFile, 'relativePath' | 'resourceKind'> | null;
  lastOpenFailure: AgentUiOpenFailure | null;
  setStatus(message: string): void;
  pushToast(message: string, kind: 'ok' | 'warn'): void;
  announceDesktopOnly(operation: string): void;
  describeBridgeAbsence(operation: string): string;
}
export const AGENT_MIN_WIDTH = 96; // S8:下限收到约一条工具栏宽,不要 340
export const AGENT_MAX_WIDTH = 620;
export const AGENT_DEFAULT_WIDTH = 440;

function agentUiStorageKey(workspaceSessionId: string | undefined, field: 'open' | 'width'): string {
  // workspaceSessionId 是 main 发出的 opaque UI key；不把绝对路径写入 localStorage。
  const uiKey = workspaceSessionId ?? 'preview';
  return `soulforge.ui.agentDock.v1.${uiKey}.${field}`;
}

/** Renderer Agent UI ownership; all permissions, native tools and writes remain in main. */
export function useAgentUiController(options: AgentUiOptions) {
  const { bridge, workspace, selectedFile, lastOpenFailure, setStatus, pushToast, announceDesktopOnly, describeBridgeAbsence } = options;
  const [toolOutput, setToolOutput] = useState<ToolResult | null>(null);
  const [eventUri, setEventUri] = useState('');
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentWidth, setAgentWidth] = useState(440);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [agentInteractionMode, setAgentInteractionMode] = useState<AgentUiInteractionMode>(() => {
    try {
      const saved = window.localStorage.getItem('soulforge:agentInteractionMode');
      if (saved === 'ask' || saved === 'plan' || saved === 'edit' || saved === 'bypass') return saved;
    } catch {}
    return 'ask';
  });
  // AGENT-60D 提交期消费点：AgentSidebar 草稿里 §12.11 的 opaque 资源引用冒泡到
  // App，runAgentTask 时随 runAiAgent 提交（main 按 agentReferenceRegistry 校验）。
  const [agentResources, setAgentResources] = useState<readonly AgentResourceReference[]>([]);
  const [agentAttachments, setAgentAttachments] = useState<readonly AgentAttachmentReference[]>([]);
  const handleAgentAttachmentsChange = useCallback((chips: readonly AgentAttachmentChip[]) => {
    const next = toAgentAttachmentReferences(chips);
    setAgentAttachments((current) => {
      if (current.length !== next.length) return next;
      return current.every((item, index) => {
        const candidate = next[index];
        return candidate !== undefined
          && item.token === candidate.token
          && item.mediaType === candidate.mediaType
          && item.byteLength === candidate.byteLength
          && item.expiresAt === candidate.expiresAt;
      }) ? current : next;
    });
  }, []);

  const [citeSelecting, setCiteSelecting] = useState(false);
  const [pendingCiteHits, setPendingCiteHits] = useState<readonly CiteHit[] | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProvider>('mock');
  // 2-A：思考档用官方 effort 值（默认 medium；旧档 normal 已迁移，写路径只写官方值）。
  const [aiThinking, setAiThinking] = useState<ModelThinkingLevel>(() => {
    try {
      if (typeof window === 'undefined') return 'medium';
      const saved = window.localStorage.getItem('soulforge.ui.aiThinking');
      if (saved === 'off' || saved === 'none' || saved === 'minimal' || saved === 'low' || saved === 'medium' || saved === 'high' || saved === 'xhigh' || saved === 'max') return saved as ModelThinkingLevel;
    } catch {}
    return 'medium';
  });
  const [aiMode] = useState<AiPermissionMode>('plan');
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiDraft, setAiDraft] = useState<AiSidebarDraft | null>(null);
  // T6：无模型服务时的对话区说明（不卡输入框）。发送成功后 / 新任务 / 换工作区时清除。
  const [agentIdleNotice, setAgentIdleNotice] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [agentGoal, setAgentGoal] = useState<string | null>(null);
  /* ── AI agent 任务（REL-G 的 renderer 入口）───────────────────────────────
     任务状态全部由 agentTaskState 的纯函数折叠，本组件只持有它的当前值——
     折叠规则放在组件里就只能靠真实 Electron 才能测，而那一层抓不到规则本身的错。 */
  const [agentTask, setAgentTask] = useState<AgentTaskState>(INITIAL_AGENT_TASK_STATE);
  const agentCancelRequestedRef = useRef<boolean>(false);
  const [agentServices, setAgentServices] = useState<ModelServiceChoice[]>([]);
  const [agentServiceId, setAgentServiceId] = useState<string | null>(null);
  const [agentSessions, setAgentSessions] = useState<AgentSessionRow[]>([]);
  const [agentSessionsError, setAgentSessionsError] = useState<string | null>(null);
  const [agentSessionDetail, setAgentSessionDetail] = useState<AgentSessionDetail | null>(null);
  const [respondingApprovalCallId, setRespondingApprovalCallId] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [agentTools, setAgentTools] = useState<ToolDescriptor[]>([]);
  const lifetimeRef = useRef({ mounted: false, bridge, generation: 0 });
  const runRequestRef = useRef(0);
  const sessionListRequestRef = useRef(0);
  const sessionDetailRequestRef = useRef(0);
  const approvalRequestRef = useRef(0);
  const toolRequestRef = useRef(0);
  const workspaceSessionId = workspace?.workspaceSessionId ?? null;
  const workspaceRunOwnerRef = useRef({ sessionId: workspaceSessionId, generation: 0 });
  const pendingRunUiRef = useRef<{
    request: number;
    optimisticSessionId: string;
    previousTask: AgentTaskState;
  } | null>(null);
  const invalidatePendingWorkspaceRun = useCallback(() => {
    workspaceRunOwnerRef.current.generation++;
    const pending = pendingRunUiRef.current;
    pendingRunUiRef.current = null;
    if (!pending) return;
    // Discard only an unaccepted optimistic successor; existing native facts remain exact.
    setAgentTask(current => current.sessionId === pending.optimisticSessionId ? pending.previousTask : current);
    setAgentGoal(null);
  }, []);
  useEffect(() => {
    if (workspaceRunOwnerRef.current.sessionId === workspaceSessionId) return;
    workspaceRunOwnerRef.current.sessionId = workspaceSessionId;
    invalidatePendingWorkspaceRun();
  }, [workspaceSessionId, invalidatePendingWorkspaceRun]);
  useEffect(() => {
    const lifetime = lifetimeRef.current;
    lifetime.mounted = true;
    lifetime.bridge = bridge;
    lifetime.generation++;
    return () => { lifetime.mounted = false; lifetime.generation++; };
  }, [bridge]);
  function currentLifetime() {
    const lifetime = lifetimeRef.current;
    const generation = lifetime.generation;
    return () => lifetime.mounted && lifetime.bridge === bridge && lifetime.generation === generation;
  }
  const { resetAgentEvents, acceptAgentSession } = useAgentEventController({
    bridge, task: agentTask, setTask: setAgentTask,
    onModeSwitched: changeAgentInteractionMode, setIdleNotice: setAgentIdleNotice
  });

  useEffect(() => {
    try {
      const savedOpen = window.localStorage.getItem(agentUiStorageKey(workspace?.workspaceSessionId, 'open'));
      const savedWidth = window.localStorage.getItem(agentUiStorageKey(workspace?.workspaceSessionId, 'width'));
      if (savedOpen !== null) setAgentOpen(savedOpen === 'true');
      if (savedWidth !== null) {
        const parsed = Number(savedWidth);
        if (Number.isFinite(parsed)) setAgentWidth(clampAgentDockWidth(parsed, AGENT_MIN_WIDTH, AGENT_MAX_WIDTH));
      }
    } catch {
      // 浏览器预览或受限 WebView 可能禁用 localStorage；不影响工作台使用。
    }
  }, [workspace?.workspaceSessionId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(agentUiStorageKey(workspace?.workspaceSessionId, 'open'), String(agentOpen));
      window.localStorage.setItem(agentUiStorageKey(workspace?.workspaceSessionId, 'width'), String(agentWidth));
    } catch {
      // 持久化是增强能力，不应阻塞渲染或任务状态。
    }
  }, [agentOpen, agentWidth, workspace?.workspaceSessionId]);

  useEffect(() => {
    try {
      window.localStorage.setItem('soulforge.ui.aiThinking', aiThinking);
    } catch {}
  }, [aiThinking]);


  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void (async () => {
      try {
        const [services, toolList] = await Promise.all([
          bridge.listModelServices(),
          bridge.listAiTools()
        ]);
        if (cancelled) return;
        setAgentServices(services.map((service) => ({
          id: service.id,
          displayName: service.displayName,
          hasCredential: service.hasCredential,
          protocol: service.protocol
        })));
        setAgentTools(toolList);
        // 只选择用户已配置的服务；生产启动不扫描仓库 test 文件，也不注入测试服务。
        setAgentServiceId((current) => current
          ?? services.find((service) => service.hasCredential)?.id
          ?? services[0]?.id
          ?? null);
      } catch (error) {
        if (!cancelled) setAgentSessionsError(error instanceof Error ? error.message : '读取模型服务或工具清单失败');
      }
    })();
    return () => { cancelled = true; };
  }, [bridge]);

  function handleCiteSettle(hits: CiteHit[]): void {
    setCiteSelecting(false);
    const citation = mergeCiteHits(hits);
    if (citation === null) {
      pushToast('这块还不能引用：框选里没有可引用的行、条目或脚本文档。', 'warn');
      return;
    }
    setPendingCiteHits(hits);
  }

  async function sendAgentPrompt(): Promise<void> {
    // T6-1：Composer「发送」= 真正跑 Agent loop（现有 runAgentTask），不再只生成
    // 本地草稿。空输入 / 没配模型由 runAgentTask 自己说明，不在这里拦。
    const text = aiPrompt.trim();
    if (!text || aiBusy) return;
    await runAgentTask();
  }

  function startNewAgentTask(): void {
    agentCancelRequestedRef.current = false;
    setAgentGoal(null);
    setAiDraft(null);
    setAgentIdleNotice(null);
    setAiPrompt('');
    setAiBusy(false);
    runRequestRef.current++;
    pendingRunUiRef.current = null;
    approvalRequestRef.current++;
    toolRequestRef.current++;
    resetAgentEvents();
    setAgentTask(INITIAL_AGENT_TASK_STATE);
    setToolOutput(null);
    setApprovalError(null);
    setRespondingApprovalCallId(null);
    setStatus('已开始新的 Agent 任务');
  }

  async function refreshAgentSessions(): Promise<void> {
    if (!bridge) {
      setAgentSessionsError(describeBridgeAbsence('读取 AI 会话历史'));
      return;
    }
    const ownsLifetime = currentLifetime();
    const request = ++sessionListRequestRef.current;
    const result = await bridge.listAiAgentSessions();
    if (!ownsLifetime() || sessionListRequestRef.current !== request) return;
    if (!result.ok) {
      setAgentSessionsError(`${result.error.code}：${result.error.message}`);
      return;
    }
    setAgentSessionsError(null);
    setAgentSessions(result.sessions);
  }


  async function runAgentTask(resumeSessionPath?: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('运行 AI 任务');
      return;
    }
    const ownsLifetime = currentLifetime();
    const workspaceGeneration = workspaceRunOwnerRef.current.generation;
    const ownsWorkspace = () => workspaceRunOwnerRef.current.sessionId === workspaceSessionId
      && workspaceRunOwnerRef.current.generation === workspaceGeneration;
    if (!ownsLifetime() || !ownsWorkspace()) return;
    // 承接时输入框常为空：空 prompt 直接拦截会让「承接」点了没反应。
    // 承接的语义是继续上一轮，故空输入发一条默认继续指令。
    const prompt = resumeSessionPath !== undefined && aiPrompt.trim() === ''
      ? '请继续上一轮会话的任务。'
      : aiPrompt.trim();
    if (prompt === '') {
      setStatus('任务描述为空，未发起 AI 任务');
      return;
    }
    setAiPrompt('');
    // T6：没配模型在对话里写说明（不卡输入框以外的整栏，也不整次拒绝成
    // WORKSPACE_NOT_ANALYZED）；输入框仍可编辑，配好后可直接再发。
    if (agentServiceId === null) {
      setAgentIdleNotice('尚未配置模型服务，未发起 AI 任务。请在 Agent 历史 → 模型设置 中选择或配置模型服务。');
      setAgentGoal(prompt);
      setStatus('尚未配置模型服务');
      return;
    }
    // 只对正常 stop 终态隐式承接。partial/max_steps/length/cancelled/error
    // 必须由用户显式选择历史会话继续，否则普通发送从新任务开始。
    const effectiveResumePath = resumeSessionPath ?? (
      canAutoResumeAgentTask(agentTask) ? agentTask.rolloutFileName! : undefined
    );

    // 0ms 乐观响应：点击“发送”按钮瞬间立即切换至对话时间线，渲染用户提问气泡与等待动画，杜绝界面停留欢迎页干等
    const request = ++runRequestRef.current;
    const isCurrent = () => ownsLifetime() && ownsWorkspace() && runRequestRef.current === request;
    const settlePendingRunUi = () => {
      if (pendingRunUiRef.current?.request === request) pendingRunUiRef.current = null;
    };
    const previousTask = agentTask;
    const previousGoal = agentGoal;
    const optimisticSessionId = `optimistic-${Date.now()}`;
    pendingRunUiRef.current = { request, optimisticSessionId, previousTask };
    agentCancelRequestedRef.current = false;
    // The previous session must not change mode while the new acceptance is pending.
    resetAgentEvents();
    setAgentGoal(prompt);
    setAgentIdleNotice(null);
    setAgentTask(startAgentTask(optimisticSessionId, Date.now(), previousTask, previousGoal));
    setStatus('正在发起 AI 任务...');

    const requestedAgentMode = agentInteractionMode === 'bypass'
      ? 'fullPermission'
      : agentInteractionMode === 'edit'
        ? 'normal'
        : 'plan';
    let permissionGrantId: string | undefined;
    if (requestedAgentMode !== 'plan') {
      try {
        const permission = await bridge.requestAiAgentPermission(requestedAgentMode);
        if (!isCurrent()) return;
        if (!permission.ok) {
          settlePendingRunUi();
          const error = { code: permission.error.code, message: permission.error.message };
          setAgentTask((current) => ({ ...current, phase: 'error', error }));
          setStatus(`Agent 权限未授予：${permission.error.code}`);
          pushToast(`Agent 权限未授予：${permission.error.message}`, 'warn');
          return;
        }
        permissionGrantId = permission.grantId;
      } catch (error) {
        if (!isCurrent()) return;
        settlePendingRunUi();
        const message = error instanceof Error ? error.message : String(error);
        setAgentTask((current) => ({
          ...current,
          phase: 'error',
          error: { code: 'AGENT_PERMISSION_REQUEST_FAILED', message }
        }));
        setStatus('Agent 权限请求失败');
        return;
      }
    }

    let result: Awaited<ReturnType<NonNullable<typeof bridge>['runAiAgent']>>;
    try {
      result = await bridge.runAiAgent({
        configId: agentServiceId,
        prompt,
        ...(effectiveResumePath !== undefined ? { resumeSessionPath: effectiveResumePath } : {}),
        // T6-3：选区逻辑名/资源 kind 作为可选元数据随任务提交给模型；不自动插入
        // `#路径` chip（那会污染 prompt 文本，且选区只是参考不是默认任务对象）。
        ...(selectedFile
          ? { selection: { label: selectedFile.relativePath, resourceKind: selectedFile.resourceKind } }
          : {}),
        // S15/S19 失败面：最近一次打开失败（KRAK 缺 Oodle / 读取失败）随任务提交，
        // main 校验后进系统提示；Agent 能直接解释原因和下一步，不等用户复制日志。
        ...(lastOpenFailure ? { openFailure: lastOpenFailure } : {}),
        // AGENT-60D：已添加的 §12.11 opaque 资源引用随任务提交（main 校验
        // agentReferenceRegistry 的跨 sender；空数组 = 无引用）。
        ...(agentResources.length > 0 ? { resources: agentResources } : {}),
        ...(agentAttachments.length > 0 ? { attachments: agentAttachments } : {}),
        streaming: true,
        timeoutMs: 180_000,
        // 工作区 Agent 默认启用一次性 RAG 预检；main 会优先使用内存
        // active corpus，并等待正在进行的那一次语义分析完成，不会按查询重扫。
        useRagSearch: true,
        // S32：输入条的思考强度随任务提交（优先于服务级默认）。
        thinkingLevel: aiThinking,
        mode: requestedAgentMode,
        ...(permissionGrantId !== undefined ? { permissionGrantId } : {})
      });
    } catch (error) {
      if (!isCurrent()) return;
      settlePendingRunUi();
      setAgentTask((current) => ({
        ...current,
        phase: 'error',
        error: {
          code: 'RUN_AGENT_FAILED',
          message: error instanceof Error ? error.message : String(error)
        }
      }));
      setStatus('AI 任务发起异常');
      return;
    }

    if (!isCurrent()) return;
    settlePendingRunUi();
    if (!result.ok) {
      setAgentTask((current) => ({
        ...current,
        phase: 'error',
        error: { code: result.error.code, message: result.error.message }
      }));
      setStatus(`AI 任务未发起：${result.error.code}`);
      pushToast(`AI 任务未发起：${result.error.message}`, 'warn');
      return;
    }

    // 成功受理：更新为真实主进程 sessionId，开放事件回放与接收
    acceptAgentSession(result.sessionId);

    // 若在发起等待期间用户已点击取消，立即向主进程补发 cancel
    if (agentCancelRequestedRef.current) {
      void bridge.cancelAiAgent(result.sessionId);
      setAgentTask((current) => markAgentTaskCancelling({
        ...current,
        sessionId: result.sessionId
      }));
      setStatus('已发出取消请求，等待当前步骤让出');
      return;
    }

    setAgentTask((current) => {
      if (current.sessionId === optimisticSessionId) {
        return {
          ...current,
          sessionId: result.sessionId
        };
      }
      return current;
    });
    setStatus('AI 任务已发起，进度会在 Agent 面板更新');
  }


  async function cancelAgentTask(): Promise<void> {
    const sessionId = agentTask.sessionId;
    if (!bridge || sessionId === null) {
      announceDesktopOnly('取消 AI 任务');
      return;
    }
    agentCancelRequestedRef.current = true;
    setAgentTask((current) => markAgentTaskCancelling(current));
    setStatus('已发出取消请求，等待当前步骤让出');
    if (!sessionId.startsWith('optimistic-')) {
      await bridge.cancelAiAgent(sessionId);
    }
  }


  async function respondAgentApproval(
    callId: string,
    decision: AgentApprovalUserDecision
  ): Promise<void> {
    const sessionId = agentTask.sessionId;
    if (!bridge || sessionId === null) {
      announceDesktopOnly('回答 AI 审批');
      return;
    }
    const ownsLifetime = currentLifetime();
    const request = ++approvalRequestRef.current;
    const runRequest = runRequestRef.current;
    const isCurrent = () => ownsLifetime() && approvalRequestRef.current === request && runRequestRef.current === runRequest;
    setRespondingApprovalCallId(callId);
    setApprovalError(null);
    try {
      const result = await bridge.respondAiAgentApproval({ sessionId, callId, decision });
      if (!isCurrent()) return;
      if (!result.ok) {
        setApprovalError(`${result.error.code}——${result.error.message}`);
        return;
      }
      if (!result.matched) {
        // 主进程已结算过这条请求（会话结束或超时）。这是正常竞态，不是错误，
        // 但必须说出来：否则用户点了按钮却什么都没发生。
        setApprovalError('这条审批已失效（会话已结束或等待超时），你的回答未被采纳。');
      }
    } catch (error) {
      if (!isCurrent()) return;
      setApprovalError(`审批回答发送失败——${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (isCurrent()) setRespondingApprovalCallId(null);
    }
  }

  async function loadAgentSession(sessionPath: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('查看 AI 会话');
      return;
    }
    const ownsLifetime = currentLifetime();
    const request = ++sessionDetailRequestRef.current;
    const result = await bridge.loadAiAgentSession(sessionPath);
    if (!ownsLifetime() || sessionDetailRequestRef.current !== request) return;
    if (!result.ok) {
      setAgentSessionsError(`${result.error.code}：${result.error.message}`);
      setAgentSessionDetail(null);
      return;
    }
    setAgentSessionsError(null);
    setAgentSessionDetail({
      sessionPath,
      messageCount: result.messageCount,
      parseErrors: result.parseErrors,
      interrupted: result.interrupted,
      compactedWindows: result.compactedWindows,
      loadedMessages: result.messagesPage.length,
      permissionMode: result.meta?.permissionMode ?? null,
      protocol: result.meta?.protocol ?? null
    });
    setStatus(`已载入会话 ${sessionPath}，共 ${result.messageCount} 条消息`);
  }

  async function runToolSearch(toolQuery: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('运行安全工具');
      return;
    }
    const ownsLifetime = currentLifetime();
    const request = ++toolRequestRef.current;
    const result = await bridge.runAiTool('search_resources', { query: toolQuery, limit: 8 });
    if (ownsLifetime() && toolRequestRef.current === request) setToolOutput(result);
  }

  async function explainEvent(uri: string): Promise<void> {
    if (!bridge) {
      announceDesktopOnly('解释事件');
      return;
    }
    const ownsLifetime = currentLifetime();
    const request = ++toolRequestRef.current;
    const result = await bridge.runAiTool('explain_event', { uri });
    if (ownsLifetime() && toolRequestRef.current === request) setToolOutput(result);
  }
  function changeAgentInteractionMode(mode: AgentUiInteractionMode): void {
    setAgentInteractionMode(mode);
    try { window.localStorage.setItem('soulforge:agentInteractionMode', mode); } catch {}
  }
  const resetAgentWorkspaceState = useCallback(() => {
    invalidatePendingWorkspaceRun();
    toolRequestRef.current++;
    setAgentGoal(null);
    setToolOutput(null);
    setAiDraft(null);
    setAgentIdleNotice(null);
  }, [invalidatePendingWorkspaceRun]);
  const resetAgentSelectionState = useCallback(() => {
    setAiDraft(null);
    setAgentIdleNotice(null);
  }, []);
  return {
    agentOpen, setAgentOpen, agentWidth, setAgentWidth, agentExpanded, setAgentExpanded,
    agentInteractionMode, changeAgentInteractionMode, setAgentResources, handleAgentAttachmentsChange,
    citeSelecting, setCiteSelecting, pendingCiteHits, setPendingCiteHits, handleCiteSettle,
    aiProvider, setAiProvider, aiThinking, setAiThinking, aiMode, aiPrompt, setAiPrompt,
    aiDraft, aiBusy, agentGoal, agentIdleNotice, agentTask, agentServices, agentServiceId,
    setAgentServiceId, agentSessions, agentSessionsError, agentSessionDetail,
    respondingApprovalCallId, approvalError, agentTools, toolOutput, eventUri, setEventUri,
    sendAgentPrompt, startNewAgentTask, runAgentTask, cancelAgentTask, respondAgentApproval,
    refreshAgentSessions, loadAgentSession, runToolSearch, explainEvent,
    resetAgentWorkspaceState, resetAgentSelectionState
  };
}

export type AgentUiController = ReturnType<typeof useAgentUiController>;
