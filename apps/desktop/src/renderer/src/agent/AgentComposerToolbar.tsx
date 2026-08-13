import type { ReactElement } from 'react';
import type { ComposerAction } from './AgentPromptEditor.js';

export interface AgentComposerToolbarProps {
  /** send / stop / awaiting 由状态机决定（§12.6 执行中发送变为停止）。 */
  action: ComposerAction;
  /** 空文本时发送 disabled（§12.6）。 */
  sendDisabled: boolean;
  onSend: () => void;
  onStop: () => void;
  /** '@' 插入 Agent 参与者标记——真实回调：直接写入 prompt。 */
  onInsertMention: () => void;
  /** '#' 插入当前文件上下文标记——真实回调：写入 prompt；无选区时 disabled。 */
  onInsertContext: () => void;
  contextDisabled: boolean;
  /**
   * 附件的诚实禁用原因。附件需要 main 下发的 renderer-safe 引用 token（60C
   * 接线），60B 不渲染假装可用的假功能，只给 disabled + 说明。
   */
  attachmentReason: string;
  /** 当前模型服务的展示名（已配置服务的 displayName；无则回退 provider 标签）。 */
  modelLabel: string;
  /** 打开模型服务设置抽屉（真实既有能力：AgentSessionControls）。 */
  onOpenModelSettings: () => void;
  /** 当前交互模式（Ask/Plan/Edit）——「推理/Plan 显示真实运行模式」。 */
  planLabel: string;
}

/**
 * 三层 Composer 的第三层「底部工具栏」（§12.6）。
 *
 * 固定六项顺序：`@ | # | 附件 | 模型选择 | 推理/Plan | 发送/停止`。
 * 未打通真实链路的项给诚实 disabled + title 说明（附件、无选区时的 #），
 * 不伪造「已接通」状态（§12.6「未打通真实链路的控件必须隐藏」的精神）。
 */
export function AgentComposerToolbar(props: AgentComposerToolbarProps): ReactElement {
  const {
    action,
    sendDisabled,
    onSend,
    onStop,
    onInsertMention,
    onInsertContext,
    contextDisabled,
    attachmentReason,
    modelLabel,
    onOpenModelSettings,
    planLabel
  } = props;

  return (
    <div className="agent-composer__toolbar" role="toolbar" aria-label="Composer 工具栏">
      <button
        type="button"
        className="composer-tool-btn"
        onClick={onInsertMention}
        aria-label="添加 Agent 参与者"
        title="在输入中插入 @Agent 参与者标记"
      >
        @
      </button>
      <button
        type="button"
        className="composer-tool-btn"
        onClick={onInsertContext}
        disabled={contextDisabled}
        aria-label="添加当前文件上下文"
        title={contextDisabled ? '没有已选中的逻辑资源' : '在输入中插入当前文件上下文标记'}
      >
        #
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
      <button
        type="button"
        className="composer-model-btn"
        onClick={onOpenModelSettings}
        aria-label="模型服务设置"
        title="打开模型服务设置"
      >
        <span className="composer-model-label">{modelLabel}</span>
      </button>
      <span className="composer-mode" data-testid="composer-plan-mode" title="当前交互模式">
        {planLabel}
      </span>
      <span className="composer-spacer"></span>
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
