import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react';
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
import { modelServiceLabel, permissionModeLabel, thinkingLabel } from './agentLabels.js';

export interface AgentSidebarProps {
  open: boolean;
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
  /**
   * AI 任务面板的全套受控 props（运行 / 取消 / 会话历史）。
   *
   * 用一个整体对象而不是把十几个字段平铺进本接口：这些字段只服务任务面板，
   * 平铺会让 AgentSidebar 的 props 表变成两块能力的混合体，且每加一个任务字段
   * 都要改三处签名。`tools` 保持在外层——工具清单同时喂给既有的「安全工具」区。
   */
  task: Omit<AgentTaskPanelProps, 'tools' | 'permissionLockReason'>;
  eventUri: string;
  onEventUriChange: (uri: string) => void;
  onProviderChange: (provider: AiProvider) => void;
  onThinkingChange: (thinking: AiThinkingLevel) => void;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  onClose: () => void;
  onRunToolSearch: (query: string) => void;
  onExplainEvent: (uri: string) => void;
}

function groupToolsByPermission(tools: ToolDescriptor[]): Record<'read' | 'plan' | 'write', ToolDescriptor[]> {
  const levelOf = (tool: ToolDescriptor): string => tool.permissionLevel ?? tool.permission;
  return {
    read: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'read' || level === 'analyze';
    }),
    plan: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'propose' || level === 'stage' || level === 'validate' || level === 'plan';
    }),
    write: tools.filter((tool) => {
      const level = levelOf(tool);
      return level === 'commit' || level === 'rollback' || level === 'write';
    })
  };
}

/**
 * 右侧 Agent 面板：会话配置、计划/工具调用日志、模型服务抽屉与底部输入区。
 * 全部状态由 App 以受控 props 下发；本组件不持有全局状态。
 */
export function AgentSidebar({
  open,
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
  onClose,
  onRunToolSearch,
  onExplainEvent
}: AgentSidebarProps): ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  /** 抽屉打开前的焦点位置；关闭时归还，避免焦点掉回文档开头。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  function openSettings(): void {
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSettingsOpen(true);
  }

  function closeSettings(): void {
    setSettingsOpen(false);
    // 焦点归还排在卸载之后：卸载时浏览器会把焦点打回 body，先 focus 等于白做。
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target !== null && document.contains(target)) {
      window.setTimeout(() => target.focus(), 0);
    }
  }

  /** 抽屉内的 Tab 环绕。索引计算与可聚焦判定由 a11y/focusTrap 负责（有单测）。 */
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
  const [toolQuery, setToolQuery] = useState('');
  const groupedTools = groupToolsByPermission(tools);

  return (
    <aside className={`agent${open ? '' : ' is-collapsed'}`} aria-label="AI Agent 面板">
      <div className="agent__header">
        <div className="agent__title">
          <span className={`agent-dot${busy ? ' is-busy' : ''}`}></span>
          <span>Agent</span>
          <span className="agent-model">{busy ? '执行中' : modelServiceLabel(provider)}</span>
        </div>
        <div className="agent__header-actions">
          <button
            type="button"
            className="tb-btn"
            onClick={() => (settingsOpen ? closeSettings() : openSettings())}
            title="Agent 设置"
            aria-label="打开 Agent 设置"
            aria-expanded={settingsOpen}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
              <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
              <path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14 5.3L13.7 2.8h-3.4L10 5.3a7 7 0 0 0-2.5 1.24l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.5 1.24l.3 2.5h3.4l.3-2.5a7 7 0 0 0 2.5-1.24l2.36.95 2-3.46-2-1.55c.09-.46.14-.93.14-1.4Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="tb-btn" onClick={onClose} title="收起" aria-label="收起 Agent 面板">
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      </div>

      <details className="agent-settings" data-testid="agent-settings" open>
        <summary>会话配置</summary>
        <AgentSessionControls
          provider={provider}
          thinking={thinking}
          permissionMode={permissionMode}
          permissionLockReason={permissionLockReason}
          onProviderChange={onProviderChange}
          onThinkingChange={onThinkingChange}
        />
      </details>

      <div className="agent__stream" role="log" aria-live="polite" aria-label="Agent 会话记录">
        {/* 任务面板排在最前：正在跑的长任务是用户最需要先看到的状态，也是取消
            入口所在。它自带空态文案，故不受下面那个 agent-empty 分支管辖。 */}
        <AgentTaskPanel {...task} tools={tools} permissionLockReason={permissionLockReason} />
        {goal === null && !draft && !busy && (
          <div className="agent-empty">
            没有进行中的任务。在下方描述目标，Agent 会生成计划草稿；变更经你批准后才会进入暂存区。
          </div>
        )}
        {goal !== null && (
          <div className="task-goal">
            <span className="task-goal__label">目标</span>
            {goal}
          </div>
        )}
        {busy && (
          <div className="agent-block">
            <div className="agent-block__label">日志</div>
            <div className="agent-log">
              <div className="agent-log__row">
                <span className="spinner" aria-hidden="true"></span>
                <span>正在生成计划草稿…</span>
              </div>
            </div>
          </div>
        )}
        {draft && (
          <div className="agent-block">
            <div className="agent-block__label">
              计划草稿 · {modelServiceLabel(draft.provider)} / {thinkingLabel(draft.thinking)} / {permissionModeLabel(draft.mode)}
            </div>
            <div className="agent-draft">
              <strong>{draft.title}</strong>
              <p>{draft.summary}</p>
              {draft.recommendedTools.length > 0 && (
                <div className="agent-tools">
                  {draft.recommendedTools.map((tool) => (
                    <span key={tool.toolName} className="tool-chip" title={tool.reason}>{tool.toolName}</span>
                  ))}
                </div>
              )}
              {draft.nextActions.length > 0 && (
                <div className="agent-log">
                  {draft.nextActions.map((action) => (
                    <div key={action} className="agent-log__row"><span>→ {action}</span></div>
                  ))}
                </div>
              )}
              <details>
                <summary>提示词预览</summary>
                <pre className="tool-output">{draft.promptPreview}</pre>
              </details>
            </div>
          </div>
        )}

        <div className="agent-block">
          <div className="agent-block__label">安全工具</div>
          <div className="tool-panel agent-tool-panel">
            <div className="tool-group">
              <small>读取 / 分析</small>
              <div className="tool-list">
                {groupedTools.read.length > 0
                  ? groupedTools.read.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)
                  : <span className="muted">暂无已注册工具</span>}
              </div>
            </div>
            <div className="tool-group">
              <small>提案 / 验证</small>
              <div className="tool-list">
                {groupedTools.plan.length > 0
                  ? groupedTools.plan.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)
                  : <span className="muted">暂无已注册工具</span>}
              </div>
            </div>
            <div className="tool-group">
              <small>提交 / 回滚</small>
              <div className="tool-list">
                {groupedTools.write.length > 0
                  ? groupedTools.write.map((tool) => <span key={tool.name} title={tool.description}>{tool.name}</span>)
                  : <span className="muted">暂无已注册工具</span>}
              </div>
            </div>
            <div className="tool-row">
              <input
                value={toolQuery}
                onChange={(event) => setToolQuery(event.target.value)}
                placeholder="输入资源搜索条件"
                aria-label="工具资源搜索条件"
              />
              <button type="button" onClick={() => onRunToolSearch(toolQuery)}>运行</button>
            </div>
            <div className="tool-row">
              <input
                value={eventUri}
                onChange={(event) => onEventUriChange(event.target.value)}
                placeholder="event://..."
                aria-label="事件 URI"
              />
              <button type="button" onClick={() => onExplainEvent(eventUri)}>解释事件</button>
            </div>
            {toolOutput && <pre className="tool-output">{JSON.stringify(toolOutput, null, 2)}</pre>}
          </div>
        </div>
      </div>

      <div className="agent__composer">
        <div className="composer-context">
          {selectedFilePath && <span className="ctx-chip">{selectedFilePath}</span>}
          <span className="ctx-chip">{contextLabel}</span>
        </div>
        <textarea
          rows={2}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="描述修改目标，例如：把伤药葫芦的持有上限调到 12"
          aria-label="向 Agent 描述修改目标"
        ></textarea>
        <div className="composer-bar">
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          <button type="button" className="btn btn--primary btn--sm" onClick={onSend}>发送</button>
        </div>
      </div>

      {settingsOpen && (
        // aria-modal 此前缺失：辅助技术不知道背后内容已被遮挡，会继续把主界面
        // 读给用户。Tab 也不受拦，焦点能落到被遮住的元素上。
        <div
          className="agent-drawer"
          role="dialog"
          aria-modal="true"
          aria-label="模型服务管理"
          ref={drawerRef}
          onKeyDown={(event) => {
            // Escape 关闭：模态必须能用键盘退出，否则键盘用户被困在里面。
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeSettings();
              return;
            }
            trapTab(event);
          }}
        >
          <div className="agent-drawer__header">
            <strong>模型服务管理</strong>
            <button type="button" className="tb-btn" onClick={closeSettings} aria-label="关闭模型服务管理">
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          </div>
          <ModelServiceSettingsPanel />
        </div>
      )}
    </aside>
  );
}
