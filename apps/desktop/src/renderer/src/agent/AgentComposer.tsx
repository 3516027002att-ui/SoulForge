import type { ReactElement } from 'react';
import type { ModelThinkingLevel } from '@soulforge/core';
import { AgentParticipantBar, interactionModeLabel, type AgentInteractionMode } from './AgentParticipantBar.js';
import { AgentContextChipList, type AgentContextChip } from './AgentContextChipList.js';
import {
  AgentPromptEditor,
  composerActionState,
  isComposerSendDisabled,
  COMPOSER_PLACEHOLDER
} from './AgentPromptEditor.js';
import { AgentComposerToolbar } from './AgentComposerToolbar.js';

export type { AgentInteractionMode } from './AgentParticipantBar.js';

export interface AgentComposerProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSend: () => void;
  /** 主进程任务仍在跑：发送让位给停止（§12.6）。 */
  onStop: () => void;
  streaming: boolean;
  awaitingApproval: boolean;
  interactionMode: AgentInteractionMode;
  onInteractionModeChange?: (mode: AgentInteractionMode) => void;
  /** S10 引用框选开关（App 持有 citeSelecting；中央编辑区暗幕在 App 渲染）。 */
  citeSelecting: boolean;
  onToggleCiteSelect: () => void;
  /** 已选中逻辑资源的域标签（chip 展示；选区元数据随 runAiAgent 提交，不入 prompt）。 */
  contextLabel: string;
  /** 2-A：思考强度（官方 effort 档），与模型拆成两个控件。 */
  thinking: ModelThinkingLevel;
  onThinkingChange: (thinking: ModelThinkingLevel) => void;
  /** 8-A：当前服务协议（OpenAI / Anthropic effort 表），透传给工具栏换表。 */
  protocol: 'openai-compatible' | 'anthropic-compatible';
}

/**
 * 三层 Composer（§12.6）：
 *   第一层 participant —— AgentParticipantBar（Ask/Plan/Edit 模式选择）
 *   第二层 prompt+chips —— AgentContextChipList + AgentPromptEditor
 *   第三层 toolbar —— AgentComposerToolbar（引用 | 附件 | 模式 | effort | 发送/停止）
 *
 * 输入状态机（发送/停止/等待、IME composing 守卫、grow cap、空输入 disabled）
 * 在 AgentPromptEditor.tsx 里做成纯函数，由 agentComposerState.test.ts 直接覆盖；
 * 本组件只做数据拼接与事件转发。未打通真实链路的项（附件）给诚实 disabled /
 * 真实回调，不编造「已接通」状态。
 *
 * S10：`@`（插入 Agent 参与者标记）与 `#`（插入当前文件上下文标记）已从工具栏
 * 移除，合成「引用」框选钮——引用是语义实体（与 data-cite 矩形相交），不是文本
 * token；上下文 chip 仍保留域标签（T6-3：选区逻辑名作为可选元数据随 runAiAgent
 * 的 selection 字段给模型，不污染 prompt 文本）。
 */
export function AgentComposer(props: AgentComposerProps): ReactElement {
  const {
    prompt,
    onPromptChange,
    onSend,
    onStop,
    streaming,
    awaitingApproval,
    interactionMode,
    onInteractionModeChange,
    citeSelecting,
    onToggleCiteSelect,
    contextLabel,
    thinking,
    onThinkingChange,
    protocol
  } = props;

  const action = composerActionState({ prompt, streaming, awaitingApproval });
  const sendDisabled = action === 'send' && isComposerSendDisabled(prompt);

  // T6-3：不自动插入 `#路径` chip——选区逻辑名/资源 kind 作为可选元数据随
  // runAiAgent 的 selection 字段给模型（见 App.tsx runAgentTask），不污染 prompt
  // 文本。chip 只保留域标签。
  const chips: AgentContextChip[] = [];
  if (contextLabel !== '') {
    chips.push({ kind: '#', label: contextLabel });
  }

  return (
    <div className="agent__composer" data-testid="agent-composer" aria-label="Agent 输入区">
      <div className="agent-composer__body">
        <AgentContextChipList chips={chips} />
        <AgentPromptEditor
          prompt={prompt}
          onPromptChange={onPromptChange}
          onSend={onSend}
          streaming={streaming}
          placeholder={COMPOSER_PLACEHOLDER}
          ariaLabel="向 Agent 对话"
        />
      </div>
      <AgentComposerToolbar
        action={action}
        sendDisabled={sendDisabled}
        onSend={onSend}
        onStop={onStop}
        onToggleCiteSelect={onToggleCiteSelect}
        citeSelecting={citeSelecting}
        attachmentReason="文件附件尚未接通（60C 只接资源引用）；当前文件可经上方「+ 资源引用」添加 main 签发的 opaque 引用。"
        interactionMode={interactionMode}
        onInteractionModeChange={onInteractionModeChange ?? (() => undefined)}
        thinking={thinking}
        onThinkingChange={onThinkingChange}
        protocol={protocol}
      />
    </div>
  );
}
