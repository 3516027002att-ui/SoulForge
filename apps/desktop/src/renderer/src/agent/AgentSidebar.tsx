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
import { isAgentTaskActive } from './agentTaskState.js';
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

/**
 * 空状态里的示例提问。
 *
 * 刻意都是**只读或提案**类的任务，且贴着本项目的真实资源类型（param 行、
 * 事件、文本条目）。不放「帮我改掉所有 boss 的血量」这种一句话触发大批写操作的
 * 例子：示例会被当成推荐用法，而推荐用法不该是一次性提出几十处改动。
 */
const AGENT_PROMPT_EXAMPLES: readonly string[] = Object.freeze([
  '伤药葫芦的持有上限在哪个 param 里，字段叫什么',
  '解释 event://... 这条事件做了什么，引用了哪些文本',
  '把伤药葫芦的持有上限从 5 改到 8，先给我看改动'
]);

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
  const awaitingApproval = task.task.pendingApprovals.length > 0;

  return (
    <aside className={`agent${open ? '' : ' is-collapsed'}`} aria-label="AI Agent 面板">
      <div className="agent__header">
        <div className="agent__title">
          <span className={`agent-dot${busy || awaitingApproval ? ' is-busy' : ''}`}></span>
          <span>Agent</span>
          {/* 等待审批必须出现在标题栏：面板可能被折叠或滚开，而这是唯一一种
              「不操作就永远不会推进」的状态。它优先于「执行中」。 */}
          <span className="agent-model" data-testid="agent-header-state">
            {awaitingApproval
              ? `等待批准 ${task.task.pendingApprovals.length} 项`
              : busy
                ? '执行中'
                : modelServiceLabel(provider)}
          </span>
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

      {/* 区块顺序（Codex 形态）：待办 → 进行中 → 配置 → 参考。
          审批与任务状态在 AgentTaskPanel 内部置顶；计划草稿设置默认折叠，
          因为它只影响草稿而不影响任务运行——默认展开会让用户以为必须先配它。
          此前它是 open 的，且标题「会话配置」暗示影响整个会话。 */}
      <details className="agent-settings" data-testid="agent-settings">
        <summary>计划草稿设置</summary>
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
          // 空状态承担引导职责：此前只有一句「没有进行中的任务」，用户既不知道
          // 能问什么，也不知道自己的改动会不会被直接写盘。示例不是装饰——它把
          // 「这个 agent 能做什么」变成可点击的具体动作。
          <div className="agent-empty" data-testid="agent-empty-state">
            <p className="agent-empty__lead">
              没有进行中的任务。描述你想改什么，Agent 先读工作区证据、再提出改动。
            </p>
            <div className="agent-empty__examples" data-testid="agent-empty-examples">
              <span className="agent-empty__examples-label">可以这样问</span>
              {AGENT_PROMPT_EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => onPromptChange(example)}
                >
                  {example}
                </button>
              ))}
            </div>
            <ol className="agent-empty__steps">
              <li>Agent 用只读工具查证据（搜索资源、解释事件、查引用）。</li>
              <li>需要改动时它给出提案，不直接落盘。</li>
              <li>写类操作逐条弹审批，你看到目标文件与将写入的内容后再决定。</li>
              <li>批准后经 Patch Engine 暂存、校验、提交，全程可回滚。</li>
            </ol>
            <p className="agent-empty__note">{permissionLockReason}</p>
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

        {/* 手动工具台归入折叠的参考区。它不是 agent 会话流的一部分——用户在这里
            手动跑搜索与解释，与 agent 自己调工具是两件事。此前它常驻展开在流的
            末尾，把审批与进度挤到滚动区外。 */}
        <details className="agent-block" data-testid="agent-manual-tools">
          <summary className="agent-block__label">手动工具台 · {tools.length} 个已注册工具</summary>
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
        </details>
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
          {/* 模式在输入框旁常驻回显：模式决定 agent 能不能写盘，而它此前只出现在
              任务面板深处。发送前看不到当前模式，就等于在不知道后果的情况下提交。
              这里是只读回显——renderer 不提供提权入口（见 AgentTaskPanel 头注）。 */}
          <span className="composer-mode" data-testid="composer-mode" title={permissionLockReason}>
            {permissionModeLabel(permissionMode)}
          </span>
          {/* 运行中把发送换成停止：两个按钮同时可点会让用户在任务已经在跑时
              再发一次，而 runBlocker 只会静默拒绝。 */}
          {task.task.pendingApprovals.length > 0 ? (
            <span className="composer-awaiting" data-testid="composer-awaiting">
              等待你在上方批准
            </span>
          ) : busy || isAgentTaskActive(task.task) ? (
            <button
              type="button"
              className="btn btn--danger btn--sm"
              data-testid="composer-stop"
              onClick={task.onCancel}
            >
              停止
            </button>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={onSend}>发送</button>
          )}
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
