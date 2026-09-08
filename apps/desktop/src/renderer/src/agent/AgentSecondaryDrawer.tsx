import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
import type { AiPermissionMode, AiProvider, ToolDescriptor } from '@soulforge/core';
import {
  FOCUSABLE_SELECTOR,
  isTrappableElement,
  nextTrappedFocusIndex
} from '../a11y/focusTrap.js';
import { ModelServiceSettingsPanel } from '../editors/ModelServiceSettingsPanel.js';
import { AgentMemoryDrawer } from './AgentMemoryDrawer.js';
import { AgentHistoryUploadControl } from './AgentHistoryUploadControl.js';
import type { AgentTaskPanelProps } from './AgentTaskPanel.js';
import { isAgentTaskCancellable } from './agentTaskState.js';

export type AgentSecondaryDrawerView = 'history' | 'settings' | 'memory';

export interface AgentSecondaryDrawerSettingsProps {
  provider: AiProvider;
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
  onProviderChange: (provider: AiProvider) => void;
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
 * 模型服务、工具库存、会话历史、项目长期记忆和开发设置从主栏移到这里。
 */
export function AgentSecondaryDrawer(props: AgentSecondaryDrawerProps): ReactElement {
  const {
    open,
    view,
    onClose,
    onSwitchView,
    task,
    permissionLockReason,
    settings
  } = props;

  const drawerRef = useRef<HTMLDivElement>(null);

  const cancellable = isAgentTaskCancellable(task.task);

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

  const title = view === 'history' ? '任务历史' : view === 'memory' ? '长期记忆' : '模型服务设置';

  return (
    <div
      className="agent-secondary-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
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
        <strong>{title}</strong>
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
            aria-pressed={view === 'memory'}
            onClick={() => onSwitchView('memory')}
          >
            记忆
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

      {view === 'memory' ? (
        <AgentMemoryDrawer onClose={onClose} />
      ) : view === 'history' ? (
        <div className="agent-history">
          {/* S25：运行任务/取消任务/权限状态从设置页移到历史页（设置页只剩表单）。 */}
          <div className="agent-controls">
            <label className="agent-controls__label" htmlFor="agent-task-service">模型服务</label>
            <select
              id="agent-task-service"
              value={task.selectedServiceId ?? ''}
              onChange={(event) => task.onSelectService(event.target.value)}
              aria-label="运行任务使用的模型服务"
            >
              {task.services.length === 0 && <option value="">尚未添加模型服务</option>}
              {task.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.displayName}{service.hasCredential ? '' : '（未配置凭据）'}
                </option>
              ))}
            </select>
            <p className="agent-task__lock" data-testid="agent-task-permission">
              权限模式：{task.task.mode ?? '计划模式（不可直接写入）'}。{permissionLockReason}
            </p>
          </div>
          <div className="row gap">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={task.runBlocker !== null}
              title={task.runBlocker ?? '运行 AI 任务'}
              data-testid="agent-task-run"
              onClick={task.onRun}
            >
              运行任务
            </button>
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={!cancellable}
              title={cancellable ? '取消当前任务' : '没有可取消的任务'}
              data-testid="agent-task-cancel"
              onClick={task.onCancel}
            >
              取消任务
            </button>
          </div>
          {task.runBlocker !== null && (
            <p className="muted" data-testid="agent-task-blocker">{task.runBlocker}</p>
          )}
          <div className="agent-history__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={task.onRefreshSessions}>刷新</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSwitchView('settings')}>模型设置</button>
          </div>
          {task.sessionsError !== null && <p className="danger">{task.sessionsError}</p>}
          {task.sessions.length === 0 && <p className="empty-hint">暂无会话记录。</p>}
          {task.sessions.map((session) => (
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
              <div className="agent-log__row">
                <span>{task.sessionDetail.interrupted ? '该任务曾中断。' : '已载入任务记录。'}</span>
              </div>
              {task.sessionDetail.parseErrors > 0 && (
                <div className="agent-log__row is-warn">
                  <span>{task.sessionDetail.parseErrors} 行无法解析，已跳过——该会话记录不完整</span>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        // S25：设置页只放模型服务表单——运行任务/取消/草稿生成器/思考强度/
        // 权限黄条全部离开设置页（思考强度的日常入口在 S32 输入条）。
        <div className="agent-settings-drawer">
          <AgentHistoryUploadControl />
          <ModelServiceSettingsPanel onCancel={onClose} />
        </div>
      )}
    </div>
  );
}
