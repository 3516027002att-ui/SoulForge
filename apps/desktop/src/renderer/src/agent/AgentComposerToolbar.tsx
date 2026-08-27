import type { ReactElement } from 'react';
import type { ModelThinkingLevel } from '@soulforge/core';
import {
  convergeThinkingLevel,
  thinkingLevelsForProtocol,
  thinkingLevelLabel,
  type ThinkingProtocol
} from './agentThinking.js';
import { AgentParticipantBar, type AgentInteractionMode } from './AgentParticipantBar.js';
import type { ComposerAction } from './AgentPromptEditor.js';
import { LiquidPressable } from '../components/motion/index.js';

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
  /** 附件点击；缺省或 attachmentDisabled 时按钮诚实 disabled。 */
  onAttach?: () => void;
  attachmentDisabled?: boolean;
  /**
   * 附件禁用原因（title）。桌面版接通后说明「添加图片或文本」；
   * 浏览器预览说明仅桌面可用。
   */
  attachmentReason: string;
  /** 当前交互模式（Ask/Plan/Edit）——S32 作为权限下拉进底栏。 */
  interactionMode: AgentInteractionMode;
  onInteractionModeChange?: (mode: AgentInteractionMode) => void;
  /** 2-A：思考强度（官方 effort 档）——下拉控件，off/none/minimal/low/medium/high/xhigh/max。 */
  thinking: ModelThinkingLevel;
  onThinkingChange: (thinking: ModelThinkingLevel) => void;
  /**
   * 8-A：当前选中模型服务的协议；决定思考强度表（OpenAI effort / Anthropic
   * effort）。没有服务时上层传 'openai-compatible'。
   */
  protocol: ThinkingProtocol;
}

/**
 * 三层 Composer 的第三层「底部工具栏」（§12.6）。
 *
 * 固定五项顺序：`引用 | 附件 | Ask/Plan/Edit | effort | 发送/停止`。
 * 2-B：删掉了「权限：计划模式（主进程锁定）」说明段与相关 props；2-C：删掉了
 * @Agent 占位 span；2-D：思考强度标签从 Think 改成 effort（全小写，aria-label 同步）；
 * 2-E：删掉了底栏「模型服务」按钮（设置入口移到 AgentDockHeader 右上角齿轮），
 * modelLabel / onOpenModelSettings 随之摘掉。
 *
 * S10 把 `@`（插入 Agent 参与者）与 `#`（插入当前文件上下文）合成一个「引用」
 * 框选钮——引用是语义实体（data-cite 矩形相交），不是文本 token。附件走 main
 * 签发的 opaque token；无 onAttach 时诚实 disabled。
 */
export function AgentComposerToolbar(props: AgentComposerToolbarProps): ReactElement {
  const {
    action,
    sendDisabled,
    onSend,
    onStop,
    onToggleCiteSelect,
    citeSelecting,
    onAttach,
    attachmentDisabled = true,
    attachmentReason,
    interactionMode,
    onInteractionModeChange,
    thinking,
    onThinkingChange,
    protocol
  } = props;

  // 2-A/8-C：按协议选表，并把不在表里的当前值收敛掉，<select> 不许出现
  // 一个不在 option 里的 value。
  const thinkingOptions = thinkingLevelsForProtocol(protocol);
  const effectiveThinking = convergeThinkingLevel(thinking, protocol);

  return (
    <div className="agent-composer__toolbar" role="toolbar" aria-label="Composer 工具栏">
      <LiquidPressable
        type="button"
        className={`composer-tool-btn${citeSelecting ? ' is-active' : ''}`}
        onClick={onToggleCiteSelect}
        aria-pressed={citeSelecting}
        aria-label="引用框选"
        title={citeSelecting
          ? '框选模式已开启：在中央编辑区拖拽框住要引用的行或字段（Esc 或再次点击取消）'
          : '在中央编辑区拖拽框住要引用的行或字段，生成一条引用'}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M3.5 3.5h9v9h-9z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeDasharray="2.6 1.8"
            strokeLinecap="round"
          />
          <path
            d="M6.4 8h3.2M8 6.4v3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </LiquidPressable>
      <LiquidPressable
        type="button"
        className="composer-tool-btn"
        disabled={attachmentDisabled || onAttach === undefined}
        onClick={() => onAttach?.()}
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
      </LiquidPressable>
      <AgentParticipantBar
        mode={interactionMode}
        onModeChange={(mode) => onInteractionModeChange?.(mode)}
      />
      <span className="composer-spacer"></span>
      <label className="composer-thinking" title="effort（作用于下一次任务）">
        <span className="composer-tool-label">effort</span>
        <select
          aria-label="effort"
          value={effectiveThinking}
          onChange={(event) => onThinkingChange(event.target.value as ModelThinkingLevel)}
        >
          {thinkingOptions.map((level) => (
            <option key={level} value={level}>{thinkingLevelLabel(level, protocol)}</option>
          ))}
        </select>
      </label>
      {action === 'awaiting' ? (
        <span className="composer-awaiting" data-testid="composer-awaiting">等待你在上方批准</span>
      ) : action === 'stop' ? (
        <LiquidPressable
          type="button"
          className="btn btn--danger btn--sm"
          data-testid="composer-stop"
          onClick={onStop}
        >
          停止
        </LiquidPressable>
      ) : (
        <LiquidPressable
          type="button"
          className="btn btn--primary btn--sm"
          disabled={sendDisabled}
          onClick={onSend}
        >
          发送
        </LiquidPressable>
      )}
    </div>
  );
}
