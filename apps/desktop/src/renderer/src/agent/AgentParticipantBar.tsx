import { useState, type ReactElement } from 'react';
import type { AiPermissionMode } from '@soulforge/core';
import { permissionModeLabel } from './agentLabels.js';

export type AgentInteractionMode = 'ask' | 'plan' | 'edit';

export const AGENT_INTERACTION_MODES: ReadonlyArray<{
  id: AgentInteractionMode;
  label: string;
  description: string;
}> = [
  { id: 'ask', label: 'Ask', description: '只读问答与解释' },
  { id: 'plan', label: 'Plan', description: '形成提案，不直接写入' },
  { id: 'edit', label: 'Edit', description: '在权限约束内提出编辑' }
];

export function interactionModeLabel(mode: AgentInteractionMode): string {
  return AGENT_INTERACTION_MODES.find((item) => item.id === mode)?.label ?? 'Ask';
}

export interface AgentParticipantBarProps {
  mode: AgentInteractionMode;
  /** 真实回调：交互模式（Ask/Plan/Edit）由 App 持有，这里是 mode 菜单的入口。 */
  onModeChange: (mode: AgentInteractionMode) => void;
  permissionMode: AiPermissionMode;
  permissionLockReason: string;
}

/**
 * 三层 Composer 的第一层「参与者条」（§12.6）：`[Agent icon] @Agent [Ask / Plan / Edit]`。
 * 模式选择只做本地开合状态；选中的模式回传给 App（60B 只保证按钮按真实 callback
 * 存在，真实能力接线由后续卡片承担）。右侧常驻权限锁定说明，与交互意图分开显示。
 */
export function AgentParticipantBar(props: AgentParticipantBarProps): ReactElement {
  const { mode, onModeChange, permissionMode, permissionLockReason } = props;
  const [modeOpen, setModeOpen] = useState(false);

  return (
    <div className="agent-composer__participant">
      <span className="agent-participant">@Agent</span>
      <div className="agent-mode-select">
        <button
          type="button"
          className="agent-mode-trigger"
          aria-haspopup="listbox"
          aria-expanded={modeOpen}
          onClick={() => setModeOpen((open) => !open)}
        >
          {interactionModeLabel(mode)}
          <span aria-hidden="true">⌄</span>
        </button>
        {modeOpen && (
          <div className="agent-mode-menu" role="listbox" aria-label="Agent 交互模式">
            {AGENT_INTERACTION_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={mode === item.id}
                onClick={() => {
                  onModeChange(item.id);
                  setModeOpen(false);
                }}
              >
                <strong>{item.label}</strong><span>{item.description}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="composer-spacer"></span>
      <span className="composer-permission" title={permissionLockReason}>
        权限：{permissionModeLabel(permissionMode)}（主进程锁定）
      </span>
    </div>
  );
}
