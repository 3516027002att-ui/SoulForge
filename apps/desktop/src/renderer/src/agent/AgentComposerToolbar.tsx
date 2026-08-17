import type { ReactElement } from 'react';
import type { AiPermissionMode, ModelThinkingLevel } from '@soulforge/core';
import { AGENT_THINKING_LEVELS, thinkingLevelLabel } from './agentThinking.js';
import { AgentParticipantBar, type AgentInteractionMode } from './AgentParticipantBar.js';
import type { ComposerAction } from './AgentPromptEditor.js';

export interface AgentComposerToolbarProps {
  /** send / stop / awaiting 由状态机决定（§12.6 执行中发送变为停止）。 */
  action: ComposerAction;
  /** 空文本时发送 disabled（§12.6）。 */
  sendDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  /**
   * S10 引用框选开关：`@`/`#` 合成一个「引用」钮。点开 = 中央编辑区盖半透明
   * 暗幕 + 十字框选光标；再点 / Esc 取消。真实回调：App 持有 citeSelecting。
   */
  onToggleCiteSelect: () => void;
  /** 框选模式当前是否开启（按钮按下态，e2e 用 aria-pressed 断言）。 */
  citeSelecting: boolean;
  /**
   * 附件的诚实禁用原因。附件需要 main 下发的 renderer-safe 引用 token（60C
   * 接线），60B 不渲染假装可用的假功能，只给 disabled + 说明。
   */
  attachmentReason: string;
  /** 当前模型服务的展示名（已配置服务的 displayName；无则回退 provider 标签）。 */
  modelLabel: string;
  /** 打开模型服务设置抽屉（真实既有能力：AgentSessionControls）。 */
  onOpenModelSettings: () => void;
  /** 当前交互模式（Ask/Plan/Edit）——S32 作为权限下拉进底栏。 */
  interactionMode: AgentInteractionMode;
  onInteractionModeChange?: (mode: AgentInteractionMode) => void;
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
  /** S32：思考强度（关/快/普通/深/极致）——与模型拆成两个控件。 */
  thinking: ModelThinkingLevel;
  onThinkingChange: (thinking: ModelThinkingLevel) => void;
}

/**
 * 三层 Composer 的第三层「底部工具栏」（§12.6）。
 *
 * 固定五项顺序：`引用 | 附件 | 模型选择 | 推理/Plan | 发送/停止`。
 * S10 把 `@`（插入 Agent 参与者）与 `#`（插入当前文件上下文）合成一个「引用」
 * 框选钮——引用是语义实体（data-cite 矩形相交），不是文本 token；附件仍未接通
 * 真实链路，给诚实 disabled + title 说明（§12.6「未打通真实链路的控件必须隐藏」
 * 的精神：不渲染假装可用的假功能）。
 */
export function AgentComposerToolbar(props: AgentComposerToolbarProps): ReactElement {
  const {
    action,
    sendDisabled,
    onSend,
    onStop,
    onToggleCiteSelect,
    citeSelecting,
    attachmentReason,
    modelLabel,
    onOpenModelSettings,
    interactionMode,
    onInteractionModeChange,
    permissionMode,
    permissionLockReason,
    thinking,
    onThinkingChange
  } = props;

  return (
    <div className="agent-composer__toolbar" role="toolbar" aria-label="Composer 工具栏">
      <button
        type="button"
        className={`composer-tool-btn${citeSelecting ? ' is-active' : ''}`}
        onClick={onToggleCiteSelect}
        aria-pressed={citeSelecting}
        aria-label="引用框选"
        title={citeSelecting
          ? '框选模式已开启：在中央编辑区拖拽框住要引用的行或字段（Esc 或再次点击取消）'
          : '在中央编辑区拖拽框住要引用的行或字段，生成一条引用'}
      >
        引用
      </button>
      <button
        type="button"
        className="composer-tool-btn"
        disabled
        aria-label="添加附件"
        title={attachmentReason}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M8.2 4.4v6.4a1.9 1.9 0 0 1-3.8 0V5.4a3.3 3.3 0 0 1 6.6 0v6.3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <AgentParticipantBar
        mode={interactionMode}
        onModeChange={(mode) => onInteractionModeChange?.(mode)}
        permissionMode={permissionMode}
        permissionLockReason={permissionLockReason}
      />
      <span className="composer-spacer"></span>
      <button
        type="button"
        className="composer-model-btn"
        onClick={onOpenModelSettings}
        aria-label="模型服务设置"
        title="打开模型服务设置"
      >
        <span className="composer-model-label">{modelLabel}</span>
      </button>
      <label className="composer-thinking" title="思考强度（作用于下一次任务）">
        <span className="composer-tool-label">思考</span>
        <select
          aria-label="思考强度"
          value={thinking}
          onChange={(event) => onThinkingChange(event.target.value as ModelThinkingLevel)}
        >
          {AGENT_THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>{thinkingLevelLabel(level)}</option>
          ))}
        </select>
      </label>
      {action === 'awaiting' ? (
        <span className="composer-awaiting" data-testid="composer-awaiting">等待你在上方批准</span>
      ) : action === 'stop' ? (
        <button
          type="button"
          className="btn btn--danger btn--sm"
          data-testid="composer-stop"
          onClick={onStop}
        >
          停止
        </button>
      ) : (
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={sendDisabled}
          onClick={onSend}
        >
          发送
        </button>
      )}
    </div>
  );
}
