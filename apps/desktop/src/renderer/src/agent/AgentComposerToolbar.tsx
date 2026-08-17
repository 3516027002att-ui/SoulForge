import type { ReactElement } from 'react';
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
  /** 思考强度，与模型钮拆开。 */
  thinkingLabel: string;
  onCycleThinking: () => void;
  /** 当前交互模式（Ask/Plan/Edit）。 */
  planLabel: string;
  onCyclePlan: () => void;
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
    thinkingLabel,
    onCycleThinking,
    planLabel,
    onCyclePlan
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
        +
      </button>
      <button
        type="button"
        className="composer-tool-btn"
        disabled
        aria-label="添加附件"
        title={attachmentReason}
        hidden
      >
        附件
      </button>
      <button
        type="button"
        className="composer-mode-btn"
        data-testid="composer-plan-mode"
        onClick={onCyclePlan}
        aria-label="权限模式"
        title={`权限：${planLabel}`}
      >
        {planLabel}
      </button>
      <span className="composer-spacer"></span>
      <button
        type="button"
        className="composer-model-btn"
        data-testid="composer-model-btn"
        onClick={onOpenModelSettings}
        aria-label="模型"
        title="打开模型服务设置"
      >
        <span className="composer-model-label">{modelLabel}</span>
      </button>
      <button
        type="button"
        className="composer-thinking-btn"
        data-testid="composer-thinking-btn"
        onClick={onCycleThinking}
        aria-label="思考强度"
        title="思考强度（与模型分开选择）"
      >
        {thinkingLabel}
      </button>
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
