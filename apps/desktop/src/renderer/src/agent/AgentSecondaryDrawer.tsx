import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { AiPermissionMode, AiProvider, AiThinkingLevel, ToolDescriptor } from '@soulforge/core';
import {
  FOCUSABLE_SELECTOR,
  isTrappableElement,
  nextTrappedFocusIndex
} from '../a11y/focusTrap.js';
import { ModelServiceSettingsPanel } from '../editors/ModelServiceSettingsPanel.js';
import { formatPageRange } from '../format/uiText.js';
import type { AgentTaskPanelProps } from './AgentTaskPanel.js';
import { AGENT_SESSION_PAGE_SIZE, isAgentTaskCancellable } from './agentTaskState.js';

export type AgentSecondaryDrawerView = 'history' | 'settings';

export interface AgentSecondaryDrawerSettingsProps {
  provider: AiProvider;
  thinking: AiThinkingLevel;
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
  onProviderChange: (provider: AiProvider) => void;
  onThinkingChange: (thinking: AiThinkingLevel) => void;
}

export interface AgentSecondaryDrawerProps {
  open: boolean;
  view: AgentSecondaryDrawerView;
  onClose: () => void;
  onSwitchView: (view: AgentSecondaryDrawerView) => void;
  /** 模型服务 / 会话历史 / 运行控件（AgentSidebar 的 task 透传；tools 与
      permissionLockReason 由独立 props 传入）。 */
  task: Omit<AgentTaskPanelProps, 'tools' | 'permissionLockReason'>;
  tools: ToolDescriptor[];
  permissionLockReason: string;
  settings: AgentSecondaryDrawerSettingsProps;
}

/**
 * §12.10 组件树里的 AgentSecondaryDrawer —— 二级抽屉。
 *
 * 模型服务、工具库存、会话历史和开发设置从主栏移到这里（§12.10「模型服务、
 * 工具库存、会话历史和开发设置进入 AgentSecondaryDrawer」）。主栏只保留消息流：
 * 任务进度、取消和审批进入消息流，不再由顶部常驻控制台承担。
 *
 * 保留旧抽屉的焦点困住与 Escape 关闭（AgentSidebar 原内联实现迁来）。
 * 关闭抽屉**不**取消任何 main-owned 任务：任务生命周期归主进程，隐藏只收焦点。
 */
export function AgentSecondaryDrawer(props: AgentSecondaryDrawerProps): ReactElement {
  const {
    open,
    view,
    onClose,
    onSwitchView,
    task,
    tools,
    permissionLockReason,
    settings
  } = props;

  const drawerRef = useRef<HTMLDivElement>(null);

  const historyPageCount = Math.max(1, Math.ceil(task.sessions.length / AGENT_SESSION_PAGE_SIZE));
  const historyPage = Math.min(task.sessionsPage, historyPageCount - 1);
  const pageSessions = task.sessions.slice(
    historyPage * AGENT_SESSION_PAGE_SIZE,
    historyPage * AGENT_SESSION_PAGE_SIZE + AGENT_SESSION_PAGE_SIZE
  );

  function trapTab(event: ReactKeyboardEvent): void {
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

  if (!open) return <div className="agent-secondary-drawer is-hidden" data-testid="agent-secondary-drawer" aria-hidden="true" />;

  return (
    <div
      className="agent-secondary-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={view === 'history' ? 'Agent 历史' : '模型服务设置'}
      data-testid="agent-secondary-drawer"
      ref={drawerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        trapTab(event);
      }}
    >
      <div className="agent-drawer__header">
        <strong>{view === 'history' ? 'Agent 历史' : '模型服务设置'}</strong>
        {/* S11：顶栏自足——历史/设置互相可切，标题独占一行，不再依赖主栏。
            打开设置只看见设置表单；欢迎与 composer 在 AgentSidebar 整列换页卸掉。 */}
        <div className="agent-drawer__switch" role="group" aria-label="抽屉视图">
          <button
            type="button"
            className="agent-drawer__switch-btn"
            aria-pressed={view === 'history'}
            onClick={() => onSwitchView('history')}
          >
            历史
          </button>
          <button
            type="button"
            className="agent-drawer__switch-btn"
            aria-pressed={view === 'settings'}
            onClick={() => onSwitchView('settings')}
          >
            设置
          </button>
        </div>
        <button type="button" className="agent-icon-btn" onClick={onClose} aria-label="关闭抽屉">×</button>
      </div>

      {view === 'history' ? (
        <div className="agent-history">
          <div className="agent-history__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={task.onRefreshSessions}>刷新</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSwitchView('settings')}>模型设置</button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              data-testid="agent-task-cancel"
              disabled={!isAgentTaskCancellable(task.task)}
              onClick={task.onCancel}
            >
              取消任务
            </button>
          </div>
          {task.sessionsError !== null && <p className="danger">{task.sessionsError}</p>}
          <p className="muted" data-testid="agent-sessions-range">
            {formatPageRange({
              page: historyPage,
              pageSize: AGENT_SESSION_PAGE_SIZE,
              total: task.sessions.length,
              noun: '会话'
            })}
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

          {/* 工具库存迁入抽屉（§12.10）。真实权限判定在主进程，这里只显示已注册工具。 */}
          <details data-testid="agent-tool-inventory">
            <summary>已注册工具 {tools.length} 个</summary>
            <div className="agent-log">
              {tools.length === 0
                ? <div className="agent-log__row"><span className="muted">主进程未回报任何已注册工具</span></div>
                : tools.map((tool) => (
                  <div key={tool.name} className="agent-log__row">
                    <span title={tool.description}>{tool.name} · {tool.permissionLevel ?? tool.permission}</span>
                  </div>
                ))}
            </div>
          </details>
        </div>
      ) : (
        <div className="agent-settings-drawer">
          <ModelServiceSettingsPanel />
        </div>
      )}
    </div>
  );
}
