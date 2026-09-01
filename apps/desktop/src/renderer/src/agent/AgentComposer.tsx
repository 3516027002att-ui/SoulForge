import type { ReactElement } from 'react';
import type { ModelThinkingLevel } from '@soulforge/core';
import { type AgentInteractionMode } from './AgentParticipantBar.js';
import { AgentContextChipList, type AgentContextChip } from './AgentContextChipList.js';
import {
  AgentPromptEditor,
  composerActionState,
  isComposerSendDisabled,
  COMPOSER_PLACEHOLDER
} from './AgentPromptEditor.js';
import { AgentComposerToolbar } from './AgentComposerToolbar.js';
import type { AgentAttachmentChip } from './agentAttachments.js';
import { MutterBanner } from './MutterBanner.js';

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
  attachments?: readonly AgentAttachmentChip[];
  attachmentCreating?: boolean;
  attachmentError?: string | null;
  onAttach?: () => void;
  onRemoveAttachment?: (token: string) => void;
  /** 2-A：思考强度（官方 effort 档），与模型拆成两个控件。 */
  thinking: ModelThinkingLevel;
  onThinkingChange: (thinking: ModelThinkingLevel) => void;
  /** 8-A：当前服务协议（OpenAI Chat/Responses / Anthropic effort 表），透传给工具栏换表。 */
  protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
  /** 是否已激活 test 免配置模式 */
  testActive?: boolean | undefined;
  placeholder?: string | undefined;
}

/**
 * 三层 Composer（§12.6）：
 *   第一层 participant —— AgentParticipantBar（Ask/Plan/Edit 模式选择）
 *   第二层 prompt+chips —— AgentContextChipList + AgentPromptEditor
 *   第三层 toolbar —— AgentComposerToolbar（引用 | 附件 | 模式 | effort | 发送/停止）
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
    attachments = [],
    attachmentCreating = false,
    attachmentError = null,
    onAttach,
    onRemoveAttachment,
    thinking,
    onThinkingChange,
    protocol,
    testActive = false,
    placeholder
  } = props;

  const action = composerActionState({ prompt, streaming, awaitingApproval });
  const sendDisabled = action === 'send' && isComposerSendDisabled(prompt);

  const effectivePlaceholder = placeholder
    ?? (testActive ? '已加载test，无需设置api即可使用' : COMPOSER_PLACEHOLDER);

  const chips: AgentContextChip[] = attachments.map((attachment) => ({
    kind: 'attachment',
    label: attachment.label,
    title: `${attachment.label} · ${attachment.byteLength} 字节`,
    token: attachment.token
  }));

  return (
    <div className="agent__composer" data-testid="agent-composer" aria-label="Agent 输入区">
      <MutterBanner />
      <div className="agent-composer__body">
        <AgentContextChipList
          chips={chips}
          {...(onRemoveAttachment !== undefined ? { onRemove: onRemoveAttachment } : {})}
        />
        <AgentPromptEditor
          prompt={prompt}
          onPromptChange={onPromptChange}
          onSend={onSend}
          streaming={streaming}
          placeholder={effectivePlaceholder}
          ariaLabel="向 Agent 对话"
        />
        {attachmentError !== null && (
          <p className="diag-error" role="alert" data-testid="agent-attachment-error">
            {attachmentError}
          </p>
        )}
      </div>
      <AgentComposerToolbar
        action={action}
        sendDisabled={sendDisabled}
        onSend={onSend}
        onStop={onStop}
        onToggleCiteSelect={onToggleCiteSelect}
        citeSelecting={citeSelecting}
        {...(onAttach !== undefined ? { onAttach } : {})}
        attachmentDisabled={onAttach === undefined || attachmentCreating}
        attachmentReason={
          onAttach === undefined
            ? '添加附件仅在 SoulForge 桌面版可用。'
            : attachmentCreating
              ? '正在添加附件…'
              : '添加图片或文本附件（由主进程签发 opaque 引用，不暴露路径）'
        }
        interactionMode={interactionMode}
        onInteractionModeChange={onInteractionModeChange ?? (() => undefined)}
        thinking={thinking}
        onThinkingChange={onThinkingChange}
        protocol={protocol}
      />
    </div>
  );
}
