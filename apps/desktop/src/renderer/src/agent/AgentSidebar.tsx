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
      <AgentConversationViewport idle={emptyWelcome}>
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
