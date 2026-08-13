import type { ReactElement } from 'react';
import type { AiPermissionMode } from '@soulforge/core';
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
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
  interactionMode: AgentInteractionMode;
  onInteractionModeChange?: (mode: AgentInteractionMode) => void;
  /** 当前模型服务展示名（真实已配置服务）。 */
  modelLabel: string;
  onOpenModelSettings: () => void;
  /** 已选中的逻辑资源相对路径（'#' 上下文与 chip 的数据源）。 */
  selectedFilePath: string | null;
  contextLabel: string;
}

/**
 * 三层 Composer（§12.6）：
 *   第一层 participant —— AgentParticipantBar
 *   第二层 prompt+chips —— AgentContextChipList + AgentPromptEditor
 *   第三层 toolbar —— AgentComposerToolbar（@ | # | 附件 | 模型 | Plan | 发送/停止）
 *
 * 输入状态机（发送/停止/等待、IME composing 守卫、grow cap、空输入 disabled）
 * 在 AgentPromptEditor.tsx 里做成纯函数，由 agentComposerState.test.ts 直接覆盖；
 * 本组件只做数据拼接与事件转发。未打通真实链路的项（附件、# 无选区、模型选择
 * 只开既有设置抽屉）给诚实 disabled / 真实回调，不编造「已接通」状态。
 */
export function AgentComposer(props: AgentComposerProps): ReactElement {
  const {
    prompt,
    onPromptChange,
    onSend,
    onStop,
    streaming,
    awaitingApproval,
    permissionMode,
    permissionLockReason,
    interactionMode,
    onInteractionModeChange,
    modelLabel,
    onOpenModelSettings,
    selectedFilePath,
    contextLabel
  } = props;

  const action = composerActionState({ prompt, streaming, awaitingApproval });
  const sendDisabled = action === 'send' && isComposerSendDisabled(prompt);

  const chips: AgentContextChip[] = [];
  if (selectedFilePath !== null) {
    chips.push({ kind: '#', label: selectedFilePath, title: selectedFilePath });
  }
  if (contextLabel !== '') {
    chips.push({ kind: '#', label: contextLabel });
  }

  /** '@' 的真实回调：把参与者标记写进 prompt（60C 才会升级为语义实体选择）。 */
  function insertMention(): void {
    onPromptChange(prompt.trim() === '' ? '@Agent' : `${prompt.trimEnd()} @Agent`);
  }

  /** '#' 的真实回调：把当前文件上下文标记写进 prompt。 */
  function insertContext(): void {
    if (selectedFilePath === null) return;
    const token = `#${selectedFilePath}`;
    onPromptChange(prompt.trim() === '' ? token : `${prompt.trimEnd()} ${token}`);
  }

  return (
    <div className="agent__composer" data-testid="agent-composer" aria-label="Agent 输入区">
      <AgentParticipantBar
        mode={interactionMode}
        onModeChange={(mode) => onInteractionModeChange?.(mode)}
        permissionMode={permissionMode}
        permissionLockReason={permissionLockReason}
      />
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
        onInsertMention={insertMention}
        onInsertContext={insertContext}
        contextDisabled={selectedFilePath === null}
        attachmentReason="附件需要 main 下发的 renderer-safe 引用 token，尚未接通（60C 接线）；不会假装可用。"
        modelLabel={modelLabel}
        onOpenModelSettings={onOpenModelSettings}
        planLabel={interactionModeLabel(interactionMode)}
      />
    </div>
  );
}
