import type { ReactElement } from 'react';
import type { AiPermissionMode, AiProvider, AiThinkingLevel } from '@soulforge/core';

export interface AgentSessionControlsProps {
  provider: AiProvider;
  thinking: AiThinkingLevel;
  permissionMode: AiPermissionMode;
  /** P0 期间权限模式由主进程锁定；锁定原因必须显示在控件旁。 */
  permissionLockReason: string;
  onProviderChange: (provider: AiProvider) => void;
  onThinkingChange: (thinking: AiThinkingLevel) => void;
}

/**
 * Agent 会话配置：模型、思考强度、权限模式。受控组件——
 * 状态仍由 App 持有，本组件不引入新的全局状态。
 */
export function AgentSessionControls({
  provider,
  thinking,
  permissionMode,
  permissionLockReason,
  onProviderChange,
  onThinkingChange
}: AgentSessionControlsProps): ReactElement {
  return (
    <div className="agent-controls">
      <div className="agent-controls__row">
        <label className="agent-controls__label" htmlFor="agent-provider">模型服务</label>
        <select
          id="agent-provider"
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          aria-label="模型服务"
        >
          <option value="mock">离线计划（不调用模型）</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
        {provider === 'mock' && (
          <p className="agent-controls__hint">离线规则计划器：不运行任何本地或远程模型。</p>
        )}
      </div>
      <div className="agent-controls__row">
        <label className="agent-controls__label" htmlFor="agent-thinking">思考强度</label>
        <select
          id="agent-thinking"
          value={thinking}
          onChange={(event) => onThinkingChange(event.target.value as AiThinkingLevel)}
          aria-label="思考强度"
        >
          <option value="fast">快速</option>
          <option value="normal">普通</option>
          <option value="deep">深入</option>
          <option value="extreme">极致</option>
        </select>
      </div>
      <div className="agent-controls__row">
        <label className="agent-controls__label" htmlFor="agent-permission">运行 / 权限模式</label>
        <select
          id="agent-permission"
          value={permissionMode}
          disabled
          title={permissionLockReason}
          aria-label="运行 / 权限模式"
        >
          <option value="plan">计划模式</option>
        </select>
        <p className="agent-controls__lock">{permissionLockReason}</p>
      </div>
    </div>
  );
}
