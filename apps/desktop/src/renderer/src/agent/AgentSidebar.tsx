import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react';
import type {
  AiPermissionMode,
  AiProvider,
  AiSidebarDraft,
  AiThinkingLevel,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';
import type {
  AgentMessageDto,
  AgentResourceReference,
  CiteHit,
  EditorSelectionContext
} from '@soulforge/shared';
import { AgentTaskPanelProps } from './AgentTaskPanel.js';
import {
  AGENT_TOOL_CALL_LIMIT,
  describeAgentTaskStatus,
  isAgentTaskActive
} from './agentTaskState.js';
import { modelServiceLabel } from './agentLabels.js';
import { AgentDockResizer } from './AgentDockResizer.js';
import { AgentDockHeader } from './AgentDockHeader.js';
import { AgentConversationViewport } from './AgentConversationViewport.js';
import { AgentComposer, type AgentInteractionMode } from './AgentComposer.js';
import { AgentContextPicker } from './AgentContextPicker.js';
import { AgentResourceReferencePicker } from './AgentResourceReferencePicker.js';
import {
  createCitationFlow,
  createInitialResourceReferenceDraft,
  createResourceReferenceFlow,
  reduceAgentResourceReferenceDraft
} from './agentResourceReferences.js';
import { getRendererBridge } from '../runtime/rendererRuntime.js';
import {
  AgentSecondaryDrawer,
  type AgentSecondaryDrawerView
} from './AgentSecondaryDrawer.js';

/** 交互模式类型由 AgentComposer（→ AgentParticipantBar）承载，这里仅为既有引用方保留导出。 */
export type { AgentInteractionMode } from './AgentComposer.js';

export interface AgentSidebarProps {
  open: boolean;
  style?: CSSProperties;
  expanded?: boolean;
  /** dock 当前宽度与范围，交给 AgentDockResizer 做拖拽/键盘 resize。 */
  agentWidth: number;
  agentMinWidth: number;
  agentMaxWidth: number;
  onAgentWidthChange: (width: number) => void;
  busy: boolean;
  provider: AiProvider;
  thinking: AiThinkingLevel;
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
  goal: string | null;
  /** T6：无模型服务等「未发起任务」的对话区说明；有值就渲染为 system 消息。 */
  idleNotice?: string | null;
  draft: AiSidebarDraft | null;
  prompt: string;
  contextLabel: string;
  selectedFilePath: string | null;
  /**
   * §12.8 当前编辑器语义选区（发送时冻结快照，切换编辑器不改变已发送目标）。
   * 缺省时由 selectedFilePath/contextLabel 投影一个 'files' 域选区作为过渡。
   */
  selection?: EditorSelectionContext | null;
  /** §12.11 已装配消息流（bounded pages）；非空时视口渲染 AgentMessageList。 */
  messages?: readonly AgentMessageDto[];
  /** 消息流「加载更早消息」的真实回调（透传给 AgentMessageList）。 */
  onLoadOlderMessages?: () => void;
  /** main 已签发的 opaque 资源引用。 */
  resources?: readonly AgentResourceReference[];
  /** 把当前语义选区作为资源引用加入（main 侧签发 opaque token）。 */
  onCreateResource?: (selection: EditorSelectionContext) => void;
  /** 移除一条资源引用。 */
  onRemoveResource?: (token: string) => void;
  /**
   * §12.11 资源引用草稿的变化通知（AGENT-60D 提交期消费点：App 在 runAgentTask
   * 里把 resources 随 runAiAgent 提交，main 按 agentReferenceRegistry 校验）。
   * 可选；不传则草稿仍是 AgentSidebar 内部私有态。
   */
  onResourcesChange?: (resources: readonly AgentResourceReference[]) => void;
  /** 清除当前 Agent 上下文。 */
  onClearContext?: () => void;
  tools: ToolDescriptor[];
  toolOutput: ToolResult | null;
  task: Omit<AgentTaskPanelProps, 'tools' | 'permissionLockReason'>;
  eventUri: string;
  onEventUriChange: (uri: string) => void;
  onProviderChange: (provider: AiProvider) => void;
  onThinkingChange: (thinking: AiThinkingLevel) => void;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  /**
   * S10 引用框选：当前是否处于框选模式（中央编辑区暗幕在 App 渲染，这里只做
   * Composer「引用」钮的按下态与开关转发）。
   */
  citeSelecting?: boolean;
  onToggleCiteSelect?: () => void;
  /**
   * S10 引用框选待签发命中：App 在暗幕结算后把命中集合交给面板，面板经
   * agent.citation.create 换 main 签发的 opaque token 写进资源引用草稿；消费后
   * 回调 onCiteHitsConsumed（App 清空，避免重复签发）。
   */
  pendingCiteHits?: readonly CiteHit[] | null;
  onCiteHitsConsumed?: () => void;
  onNewTask?: () => void;
  onToggleExpand?: () => void;
  interactionMode?: AgentInteractionMode;
  onInteractionModeChange?: (mode: AgentInteractionMode) => void;
  onClose: () => void;
  onRunToolSearch: (query: string) => void;
  onExplainEvent: (uri: string) => void;
}

function isTaskSurfaceVisible(
  busy: boolean,
  goal: string | null,
  draft: AiSidebarDraft | null,
  task: AgentSidebarProps['task']
): boolean {
  return busy
    || goal !== null
    || draft !== null
    || task.task.phase !== 'idle'
    || task.task.pendingApprovals.length > 0
    || task.task.toolCalls.length > 0
    || task.task.approvalDecisions.length > 0;
}

/**
 * 60C 过渡投影：AgentSidebar 未收到 §12.8 语义选区时，从旧 production props
 * （selectedFilePath/contextLabel）投影一个 'files' 域选区，保证新上下文组件
 * 与旧 composer chip 展示一致。相对路径不构成路径泄漏（白名单只拒绝对路径）。
 */
function legacySelectionFromProps(
  selectedFilePath: string | null,
  _contextLabel: string
): EditorSelectionContext | null {
  if (selectedFilePath === null) return null;
  return {
    domain: 'files',
    libraryId: null,
    bankId: null,
    documentId: selectedFilePath,
    paramTableId: null,
    rowId: null,
    fieldId: null,
    fmgEntryId: null,
    eventId: null,
    cursor: null,
    revision: null
  };
}

/**
 * Agent 固定右 dock。
 *
 * 这里保留主进程任务面板的受控状态与审批入口，但把旧的“工具库存 / 示例教程 /
 * header 设置齿轮”移出默认路径；Agent 的消息流只承载任务状态，真实文件路径仍由
 * 主进程审批卡片按安全边界提供，不在普通聊天消息里回显。
 */
export function AgentSidebar(props: AgentSidebarProps): ReactElement {
  const {
    open,
    style,
    expanded = false,
    agentWidth,
    agentMinWidth,
    agentMaxWidth,
    onAgentWidthChange,
    busy,
    provider,
    thinking,
    permissionMode,
    permissionLockReason,
    goal,
    idleNotice,
    draft,
    prompt,
    contextLabel,
    selectedFilePath,
    selection = null,
    messages = [],
    onLoadOlderMessages,
    resources = [],
    onCreateResource,
    onRemoveResource,
    onResourcesChange,
    onClearContext,
    tools,
    toolOutput,
    task,
    eventUri,
    onEventUriChange,
    onProviderChange,
    onThinkingChange,
    onPromptChange,
    onSend,
    citeSelecting = false,
    onToggleCiteSelect = () => undefined,
    pendingCiteHits = null,
    onCiteHitsConsumed,
    onNewTask,
    onToggleExpand,
    interactionMode = 'ask',
    onInteractionModeChange,
    onClose,
    onRunToolSearch,
    onExplainEvent
  } = props;
  const effectiveSelection = selection ?? legacySelectionFromProps(selectedFilePath, contextLabel);
  const [drawerView, setDrawerView] = useState<AgentSecondaryDrawerView | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // §12.11 资源引用草稿：本地 state 持有已添加的 opaque 引用（props.resources 作
  // 初始种子，兼容既有受控入口；App 尚未传 selection 时由 legacy 投影补齐）。
  const [resourceDraft, dispatchResourceDraft] = useReducer(
    reduceAgentResourceReferenceDraft,
    resources,
    createInitialResourceReferenceDraft
  );
  // AGENT-60D 提交期消费点：草稿变化时冒泡给 App（runAgentTask 把 resources 随
  // runAiAgent 提交；main 按 agentReferenceRegistry 校验跨 sender）。不传回调时
  // 草稿仍是面板内部私有态，既有行为不变。
  useEffect(() => {
    onResourcesChange?.(resourceDraft.resources);
  }, [resourceDraft.resources, onResourcesChange]);
  // renderer 不伪造 token、不提交路径：只把 §12.8 选区交给 main 的
  // 'agent.resourceReference.create'（root 校验 + 白名单，token 不携带路径）。
  const rendererBridge = getRendererBridge();
  const bridgeCreateResourceReference = rendererBridge !== null
    ? rendererBridge.createAgentResourceReference
    : null;
  const resourceCreateCapable = onCreateResource !== undefined || bridgeCreateResourceReference !== null;
  const taskSurfaceVisible = isTaskSurfaceVisible(busy, goal, draft, task);
  const taskState = task.task;
  const awaitingApproval = taskState.pendingApprovals.length > 0;
  const taskActive = isAgentTaskActive(taskState);
  const taskRunning = busy || taskActive;
  // awaitingApproval ⊆ taskSurfaceVisible，所以空闲 = 没有任何任务表面内容。
  const emptyWelcome = !taskSurfaceVisible;
  // IPC 返回值来自边界外部；旧版 fixture/历史会话可能只有 steps 字段。
  // 归一化为数组后再渲染，避免一次不完整草稿把整个 Agent dock 卸载。
  const draftNextActions = draft !== null && Array.isArray(draft.nextActions)
    ? draft.nextActions
    : [];

  // 这些回调仍由 App 持有，供后续工具 picker / settings route 接线；普通 Agent
  // 聊天面板不再把手动工具台混进消息流，也不为它制造伪入口。
  void eventUri;
  void onEventUriChange;
  void onRunToolSearch;
  void onExplainEvent;
  void toolOutput;

  function openDrawer(kind: AgentSecondaryDrawerView): void {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setDrawerView(kind);
  }

  function closeDrawer(): void {
    setDrawerView(null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target !== null && document.contains(target)) window.setTimeout(() => target.focus(), 0);
  }

  /**
   * §12.11 添加资源引用：把当前 §12.8 选区交给 main 签发 opaque token，成功后写进
   * 草稿，失败显示诊断。外部 onCreateResource 存在时优先走外部（App 未来受控入口）；
   * 缺省走内部 bridge 流程 —— renderer 不伪造 token、不提交路径。
   */
  function handleCreateResource(selection: EditorSelectionContext): void {
    if (onCreateResource !== undefined) {
      onCreateResource(selection);
      return;
    }
    if (bridgeCreateResourceReference === null) {
      dispatchResourceDraft({
        type: 'create-failed',
        message: '创建资源引用需要桌面桥接能力（Electron 桌面版）。'
      });
      return;
    }
    void createResourceReferenceFlow(bridgeCreateResourceReference, selection, dispatchResourceDraft);
  }

  /** 移除一条资源引用（外部回调优先，否则从本地草稿移除）。 */
  function handleRemoveResource(token: string): void {
    if (onRemoveResource !== undefined) {
      onRemoveResource(token);
      return;
    }
    dispatchResourceDraft({ type: 'remove', token });
  }

  // S10 引用框选签发：App 结算后把命中交过来（一次性），本面板经 main 换 opaque
  // token 写进与资源引用同一个草稿（chip 去重 / 上限 / 诊断共用）。成功或失败都
  // 立即回调 onCiteHitsConsumed——命中只处理一次，重复签发由 main 的 tokenId
  // 与 registry 兜底，不靠 renderer 计数。
  useEffect(() => {
    if (pendingCiteHits === undefined || pendingCiteHits === null) return;
    const rendererBridgeNow = getRendererBridge();
    if (rendererBridgeNow === null || rendererBridgeNow.createAgentCitation === undefined) {
      dispatchResourceDraft({
        type: 'create-failed',
        message: '创建引用需要桌面桥接能力（Electron 桌面版）。'
      });
    } else {
      void createCitationFlow(rendererBridgeNow.createAgentCitation, pendingCiteHits, dispatchResourceDraft);
    }
    onCiteHitsConsumed?.();
    // pendingCiteHits 只消费一次：App 在 onCiteHitsConsumed 里清空，命中数组本身
    // 不参与依赖（消费后立即回调，避免同一数组触发第二次签发）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCiteHits, onCiteHitsConsumed]);

  /** 从任务态派生 §12.5 工具活动行（单行折叠）。 */
  const toolActivities = taskState.toolCalls.slice(-AGENT_TOOL_CALL_LIMIT).map((call) => ({
    id: call.callId,
    summary: call.name,
    status: call.status === 'ok' ? 'succeeded' as const : call.status === 'failed' ? 'failed' as const : 'running' as const,
    detail: call.argumentsJson ?? null,
    step: call.step
  }));

  /**
   * 从任务态派生 §12.9 Change Review 卡。批准/拒绝走真实 IPC：task.onRespondApproval
   * 由 App 接线到 bridge.respondAiAgentApproval（main 的 ai.agent.approval.respond）。
   * submitting 由「正在回答该 callId」驱动，防重复提交。
   */
  const approvals = taskState.pendingApprovals.map((entry) => {
    const submitting = task.respondingApprovalCallId === entry.callId;
    const respondFailed = !submitting && task.approvalError !== null;
    return {
      id: entry.callId,
      toolName: entry.toolName,
      permissionLevel: entry.permissionLevel,
      step: entry.step,
      argumentsJson: entry.argumentsJson,
      diff: entry.diff,
      preview: entry.preview,
      onApprove: () => task.onRespondApproval(entry.callId, 'once'),
      onReject: () => task.onRespondApproval(entry.callId, 'reject'),
      submitting,
      commitFailure: respondFailed
        ? {
            stage: 'respond',
            rolledBack: false,
            message: task.approvalError ?? '审批回答提交失败。'
          }
        : null
    };
  });

  const failure = taskState.phase === 'error' && taskState.error !== null
    ? { code: taskState.error.code, message: taskState.error.message }
    : null;
  const statusText = taskState.phase !== 'idle'
    ? describeAgentTaskStatus(taskState)
    : null;

  const selectedService = task.services.find((service) => service.id === task.selectedServiceId);
  const modelLabel = selectedService?.displayName ?? modelServiceLabel(provider);
  const headerState = awaitingApproval ? '等待批准' : taskRunning ? '执行中' : undefined;

  return (
    <aside
      className={open ? 'agent' : 'agent is-collapsed'}
      style={style}
      aria-label="AI Agent 面板"
      data-agent-expanded={expanded ? 'true' : 'false'}
    >
      {/* resizer 是 dock 左缘的 4px 手柄；收起时隐藏。宽度状态在 App，这里只回报新宽度。 */}
      <AgentDockResizer
        overlay={!open}
        currentWidth={agentWidth}
        minWidth={agentMinWidth}
        maxWidth={agentMaxWidth}
        onWidthChange={onAgentWidthChange}
      />
      {drawerView === null && (
        <AgentDockHeader
          busy={taskRunning || awaitingApproval}
          statusText={headerState ?? ''}
          historyOpen={false}
          expanded={expanded}
          onToggleHistory={() => openDrawer('history')}
          onNewTask={onNewTask ?? (() => undefined)}
          onToggleExpand={onToggleExpand ?? (() => undefined)}
          onClose={onClose}
        />
      )}
      {/* S11：抽屉打开时整列换页——欢迎/对话、资源引用、composer 全部卸掉，
          禁止半透明抽屉盖在欢迎 + composer 上（旧 .agent-secondary-drawer
          用 position:absolute 叠一层，浅色主题 --forge-0 只有 8% 白，欢迎三勾
          与发送框全部透出来）。关闭恢复原来的面。 */}
      {drawerView === null ? (
        <>
          <AgentConversationViewport
            idle={emptyWelcome}
            messages={messages}
            {...(onLoadOlderMessages !== undefined ? { onLoadOlder: onLoadOlderMessages } : {})}
            toolActivities={toolActivities}
            approvals={approvals}
            failure={failure}
            status={statusText}
          >
            {goal !== null && (
              <article className="agent-message agent-message--user">
                <div className="agent-message__meta">你</div>
                <p>{goal}</p>
              </article>
            )}
            {idleNotice !== null && (
              <div className="agent-message agent-message--system" role="status" data-testid="agent-idle-notice">
                <span>{idleNotice}</span>
              </div>
            )}
            {busy && (
              <div className="agent-message agent-message--system" role="status">
                <span className="spinner" aria-hidden="true"></span>
                <span>正在准备计划草稿…</span>
              </div>
            )}
            {draft !== null && (
              <article className="agent-message agent-message--agent">
                <div className="agent-message__meta">Agent · 计划草稿</div>
                <strong>{draft.title}</strong>
                <p>{draft.summary}</p>
                {draftNextActions.length > 0 && (
                  <ul className="agent-message__actions">
                    {draftNextActions.map((action) => <li key={action}>{action}</li>)}
                  </ul>
                )}
              </article>
            )}
            {taskState.rolloutFileName !== null && (
              <p className="muted" data-testid="agent-rollout-file">会话记录：{taskState.rolloutFileName}</p>
            )}
          </AgentConversationViewport>

          {/* §12.10 组件树：上下文选择 + 资源引用选择（opaque token，不泄漏绝对路径）。 */}
          <div className="agent-composer-context" data-testid="agent-composer-context">
            <AgentContextPicker
              selection={effectiveSelection}
              {...(onClearContext !== undefined ? { onClear: onClearContext } : {})}
            />
            <AgentResourceReferencePicker
              resources={resourceDraft.resources}
              selection={effectiveSelection}
              creating={resourceDraft.creating}
              error={resourceDraft.error}
              {...(resourceCreateCapable ? { onCreate: handleCreateResource } : {})}
              onRemove={handleRemoveResource}
            />
          </div>

          <AgentComposer
            prompt={prompt}
            onPromptChange={onPromptChange}
            onSend={onSend}
            onStop={task.onCancel}
            streaming={taskRunning}
            awaitingApproval={awaitingApproval}
            permissionMode={permissionMode}
            permissionLockReason={permissionLockReason}
            interactionMode={interactionMode}
            onInteractionModeChange={onInteractionModeChange ?? (() => undefined)}
            modelLabel={modelLabel}
            onOpenModelSettings={() => openDrawer('settings')}
            thinking={thinking}
            onThinkingChange={onThinkingChange}
            citeSelecting={citeSelecting}
            onToggleCiteSelect={onToggleCiteSelect}
            contextLabel={contextLabel}
          />
        </>
      ) : (
        <AgentSecondaryDrawer
          open
          view={drawerView}
          onClose={closeDrawer}
          onSwitchView={setDrawerView}
          task={task}
          tools={tools}
          permissionLockReason={permissionLockReason}
          settings={{
            provider,
            thinking,
            permissionMode,
            permissionLockReason,
            onProviderChange,
            onThinkingChange
          }}
        />
      )}
    </aside>
  );
}
