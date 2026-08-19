import type { ReactElement } from 'react';

export interface AgentDockHeaderProps {
  /** 任务运行或等待审批时点亮状态点。 */
  busy: boolean;
  /** 标题栏状态文案（等待批准/执行中）；空串不显示。 */
  statusText: string;
  historyOpen: boolean;
  expanded: boolean;
  onToggleHistory: () => void;
  onNewTask: () => void;
  onToggleExpand: () => void;
  /**
   * 2-E：模型服务设置入口——右上角齿轮。AgentSidebar 接到现有
   * openDrawer('settings')（抽屉自带「历史 / 设置」切换）。
   */
  onOpenSettings: () => void;
  onClose: () => void;
}

/**
 * Agent dock 顶栏（§12.3）：左侧产品名 SoulForge，右侧固定
 * `新任务 | 历史 | 设置(齿轮) | 展开/恢复宽度 | 分隔线 | 关闭`。
 *
 * 按钮 28×28、图标 16px，默认无背景无边框；hover 只显示一级表面色，
 * focus-visible 走 2px 焦点环。历史仍是 AgentSidebar 的抽屉入口，这里只发事件。
 * 未对照 TRAE 实测：参考截图不在仓库内，视觉数值按 §12.2.1 初值。
 */
export function AgentDockHeader(props: AgentDockHeaderProps): ReactElement {
  const {
    busy,
    statusText,
    historyOpen,
    expanded,
    onToggleHistory,
    onNewTask,
    onToggleExpand,
    onOpenSettings,
    onClose
  } = props;

  return (
    <header className="agent__header">
      <div className="agent__title">
        <span className={`agent-dot${busy ? ' is-busy' : ''}`} aria-hidden="true"></span>
        <span className="agent-dock-header__product">SoulForge</span>
        <span className="agent__header-state" role="status" data-testid="agent-header-state">{statusText}</span>
      </div>
      <div className="agent__header-actions" aria-label="Agent 操作">
        <button type="button" className="agent-icon-btn" onClick={onNewTask} title="新任务" aria-label="新任务">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="agent-icon-btn"
          onClick={onToggleHistory}
          title="历史"
          aria-label="打开 Agent 历史"
          aria-expanded={historyOpen}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 4.5h10M3 8h10M3 11.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className="agent-icon-btn"
          onClick={onOpenSettings}
          title="模型服务设置"
          aria-label="模型服务设置"
        >
          {/* 16×16 齿轮，与展开/关闭同一套描边风格，不导入图片。 */}
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M8 5.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path
              d="M6.9 2.6l.3-1.1h1.6l.3 1.1a4.6 4.6 0 0 1 1.4.8l1.05-.5 1.1 1.1-.5 1a4.6 4.6 0 0 1 .8 1.4l1.1.3v1.6l-1.1.3a4.6 4.6 0 0 1-.8 1.4l.5 1-1.1 1.1-1.05-.5a4.6 4.6 0 0 1-1.4.8l-.3 1.1H6.9l-.3-1.1a4.6 4.6 0 0 1-1.4-.8l-1.05.5-1.1-1.1.5-1a4.6 4.6 0 0 1-.8-1.4l-1.1-.3V6.9l1.1-.3a4.6 4.6 0 0 1 .8-1.4l-.5-1 1.1-1.1 1.05.5a4.6 4.6 0 0 1 1.4-.8Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className="agent-icon-btn"
          onClick={onToggleExpand}
          title={expanded ? '恢复 Agent 宽度' : '展开 Agent'}
          aria-label={expanded ? '恢复 Agent 宽度' : '展开 Agent'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            {expanded
              ? <path d="M5.5 3.5v3h-3M10.5 12.5v-3h3M3 6.5a5 5 0 0 1 8.9-2M13 9.5a5 5 0 0 1-8.9 2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M3 6V3h3M13 10v3h-3M6 3a5 5 0 0 0-3 3M10 13a5 5 0 0 0 3-3" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        </button>
        <span className="agent__header-separator" aria-hidden="true"></span>
        <button type="button" className="agent-icon-btn" onClick={onClose} title="关闭" aria-label="关闭 Agent 面板">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}
