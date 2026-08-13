import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
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
  EditorSelectionContext
} from '@soulforge/shared';
import { ModelServiceSettingsPanel } from '../editors/ModelServiceSettingsPanel.js';
import {
  FOCUSABLE_SELECTOR,
  isTrappableElement,
  nextTrappedFocusIndex
} from '../a11y/focusTrap.js';
import { AgentSessionControls } from './AgentSessionControls.js';
import { AgentTaskPanel, type AgentTaskPanelProps } from './AgentTaskPanel.js';
import { AGENT_SESSION_PAGE_SIZE, isAgentTaskActive } from './agentTaskState.js';
import { modelServiceLabel } from './agentLabels.js';
import { formatPageRange } from '../format/uiText.js';
import { AgentDockResizer } from './AgentDockResizer.js';
import { AgentDockHeader } from './AgentDockHeader.js';
import { AgentConversationViewport } from './AgentConversationViewport.js';
import { AgentComposer, type AgentInteractionMode } from './AgentComposer.js';
import { AgentContextPicker } from './AgentContextPicker.js';
import { AgentResourceReferencePicker } from './AgentResourceReferencePicker.js';

/** 交互模式类型由 AgentComposer（→ AgentParticipantBar）承载，这里仅为既有引用方保留导出。 */
export type { AgentInteractionMode } from './AgentComposer.js';

export interface AgentSidebarProps {
  open: boolean;
  /** 窄窗口时右 dock 变成无 scrim 的 overlay。 */
  overlay?: boolean;
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
    overlay = false,
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
    onNewTask,
    onToggleExpand,
    interactionMode = 'ask',
    onInteractionModeChange,
    onClose,
    onRunToolSearch,
    onExplainEvent
  } = props;
  const effectiveSelection = selection ?? legacySelectionFromProps(selectedFilePath, contextLabel);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const taskSurfaceVisible = isTaskSurfaceVisible(busy, goal, draft, task);
  const awaitingApproval = task.task.pendingApprovals.length > 0;
  const taskRunning = busy || isAgentTaskActive(task.task);
  // awaitingApproval ⊆ taskSurfaceVisible，所以空闲 = 没有任何任务表面内容。
  const emptyWelcome = !taskSurfaceVisible;
  const historyPageCount = Math.max(1, Math.ceil(task.sessions.length / AGENT_SESSION_PAGE_SIZE));
  const historyPage = Math.min(task.sessionsPage, historyPageCount - 1);
  const pageSessions = task.sessions.slice(
    historyPage * AGENT_SESSION_PAGE_SIZE,
    historyPage * AGENT_SESSION_PAGE_SIZE + AGENT_SESSION_PAGE_SIZE
  );
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

  function openDrawer(kind: 'history' | 'settings'): void {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setHistoryOpen(kind === 'history');
    setSettingsOpen(kind === 'settings');
  }

  function closeDrawer(): void {
    setHistoryOpen(false);
    setSettingsOpen(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target !== null && document.contains(target)) window.setTimeout(() => target.focus(), 0);
  }

  function trapDrawerTab(event: ReactKeyboardEvent): void {
    const container = drawerRef.current;
    if (container === null || event.key !== 'Tab') return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => isTrappableElement(element));
    if (focusable.length === 0) return;
    const currentIndex = focusable.findIndex((element) => element === document.activeElement);
    const nextIndex = nextTrappedFocusIndex({
      focusableCount: focusable.length,
      currentIndex,
      shift: event.shiftKey
    });
    if (nextIndex < 0) return;
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }

  const selectedService = task.services.find((service) => service.id === task.selectedServiceId);
  const modelLabel = selectedService?.displayName ?? modelServiceLabel(provider);
  const headerState = awaitingApproval ? '等待批准' : taskRunning ? '执行中' : undefined;

  return (
    <aside
      className={`agent${open ? '' : ' is-collapsed'}${overlay ? ' is-overlay' : ''}`}
      style={style}
      aria-label="AI Agent 面板"
      data-agent-expanded={expanded ? 'true' : 'false'}
    >
      {/* resizer 是 dock 左缘的 4px 手柄；overlay 或收起时隐藏。宽度状态在 App，这里只回报新宽度。 */}
      <AgentDockResizer
        overlay={overlay || !open}
        currentWidth={agentWidth}
        minWidth={agentMinWidth}
        maxWidth={agentMaxWidth}
        onWidthChange={onAgentWidthChange}
      />
      <AgentDockHeader
        busy={taskRunning || awaitingApproval}
        statusText={headerState ?? ''}
        historyOpen={historyOpen}
        expanded={expanded}
        onToggleHistory={() => (historyOpen ? closeDrawer() : openDrawer('history'))}
        onNewTask={onNewTask ?? (() => undefined)}
        onToggleExpand={onToggleExpand ?? (() => undefined)}
        onClose={onClose}
      />
      <AgentConversationViewport
        idle={emptyWelcome}
        messages={messages}
        {...(onLoadOlderMessages !== undefined ? { onLoadOlder: onLoadOlderMessages } : {})}
      >
        {goal !== null && (
          <article className="agent-message agent-message--user">
            <div className="agent-message__meta">你</div>
            <p>{goal}</p>
          </article>
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
        {taskSurfaceVisible && (
          <AgentTaskPanel {...task} tools={tools} permissionLockReason={permissionLockReason} />
        )}
      </AgentConversationViewport>

      {/* §12.10 组件树：上下文选择 + 资源引用选择（opaque token，不泄漏绝对路径）。 */}
      <div className="agent-composer-context" data-testid="agent-composer-context">
        <AgentContextPicker
          selection={effectiveSelection}
          {...(onClearContext !== undefined ? { onClear: onClearContext } : {})}
        />
        <AgentResourceReferencePicker
          resources={resources}
          selection={effectiveSelection}
          {...(onCreateResource !== undefined ? { onCreate: onCreateResource } : {})}
          {...(onRemoveResource !== undefined ? { onRemove: onRemoveResource } : {})}
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
        onOpenModelSettings={() => {
          setHistoryOpen(false);
          setSettingsOpen(true);
        }}
        selectedFilePath={selectedFilePath}
        contextLabel={contextLabel}
      />

      {(historyOpen || settingsOpen) && (
        <div
          className="agent-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={historyOpen ? 'Agent 历史' : '模型服务设置'}
          ref={drawerRef}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeDrawer();
              return;
            }
            trapDrawerTab(event);
          }}
        >
          <div className="agent-drawer__header">
            <strong>{historyOpen ? 'Agent 历史' : '模型服务设置'}</strong>
            <button type="button" className="agent-icon-btn" onClick={closeDrawer} aria-label="关闭抽屉">×</button>
          </div>
          {historyOpen ? (
            <div className="agent-history">
              <div className="agent-history__actions">
                <button type="button" className="btn btn--ghost btn--sm" onClick={task.onRefreshSessions}>刷新</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                  setHistoryOpen(false);
                  setSettingsOpen(true);
                }}>模型设置</button>
              </div>
              {task.sessionsError && <p className="danger">{task.sessionsError}</p>}
              <p className="muted" data-testid="agent-sessions-range">
                {formatPageRange({ page: historyPage, pageSize: AGENT_SESSION_PAGE_SIZE, total: task.sessions.length, noun: '会话' })}
              </p>
              <p className="muted" data-testid="agent-sessions-source-limit">会话列表只回报最近 50 个会话文件。</p>
              <div className="row gap pager">
                <button type="button" disabled={historyPage <= 0} onClick={() => task.onSessionsPageChange(historyPage - 1)}>上一页</button>
                <span className="muted">{task.sessions.length > 0 ? historyPage + 1 : 0}/{historyPageCount}</span>
                <button type="button" disabled={historyPage >= historyPageCount - 1} onClick={() => task.onSessionsPageChange(historyPage + 1)}>下一页</button>
              </div>
              {task.sessions.length === 0 && <p className="empty-hint">暂无会话记录。</p>}
              {pageSessions.map((session) => (
                <div className="agent-history__item" key={session.sessionPath}>
                  <div>
                    <strong>{session.fileName}</strong>
                    <span>{session.startedAt ?? session.modifiedAt} · {session.messageCount} 条消息</span>
                  </div>
                  <div className="agent-history__item-actions">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => task.onLoadSession(session.sessionPath)}>查看</button>
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => task.onResumeSession(session.sessionPath)}>承接</button>
                  </div>
                </div>
              ))}
              {task.sessionDetail !== null && (
                <div className="agent-log" data-testid="agent-session-detail">
                  <div className="agent-log__row"><span>已载入会话：共 {task.sessionDetail.messageCount} 条消息，本次只取尾部 {task.sessionDetail.loadedMessages} 条</span></div>
                  <div className="agent-log__row"><span>权限模式 {task.sessionDetail.permissionMode ?? '未记录'} · 协议 {task.sessionDetail.protocol ?? '未记录'}</span></div>
                </div>
              )}
            </div>
          ) : (
            <div className="agent-settings-drawer">
              <AgentSessionControls
                provider={provider}
                thinking={thinking}
                permissionMode={permissionMode}
                permissionLockReason={permissionLockReason}
                onProviderChange={onProviderChange}
                onThinkingChange={onThinkingChange}
              />
              <ModelServiceSettingsPanel />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
