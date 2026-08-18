import type { ReactElement } from 'react';
import type { AiPermissionMode, AiProvider, AiThinkingLevel } from '@soulforge/core';
import {
  convergeThinkingLevel,
  thinkingLevelsForProtocol,
  thinkingLevelLabel
} from './agentThinking.js';

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
 * 计划草稿设置：草稿生成器、思考强度、权限模式回显。
 *
 * ── 为什么这里的标签不再叫「模型服务」──
 *
 * 本组件的下拉是 mock/openai/anthropic 三个**硬编码**选项，只喂给
 * `buildAiSidebarDraft`（App.tsx 的 buildAiDraft，离线规则计划器）。真实 agent
 * 任务用的是另一个下拉——AgentTaskPanel 里那个，选项来自凭据 vault
 * （ai.agent.run 按 configId 解析）。
 *
 * 两者此前都叫「模型服务」并排出现在同一个侧边栏里。用户在这里选了
 * 「Anthropic」不会影响任务实际用哪个服务，而界面上没有任何东西说明这一点——
 * 这不是措辞问题，是两个同名控件指向不同后端。区块重排的第一件事就是让这
 * 两者的名字与位置区分开：本组件属于「计划草稿」，任务运行设置属于「AI 任务」。
 *
 * 权限模式在这里是**只读回显**，与 AgentTaskPanel 的口径一致：renderer 不提供
 * 提权入口（见 AgentTaskPanel 头注）。
 *
 * 受控组件——状态仍由 App 持有，本组件不引入新的全局状态。
 */
export function AgentSessionControls({
  provider,
  thinking,
  permissionMode,
  permissionLockReason,
  onProviderChange,
  onThinkingChange
}: AgentSessionControlsProps): ReactElement {
  // 8-B：草稿生成器的思考表按 provider 换（mock 用 OpenAI 表；Anthropic →
  // token budget，OpenAI/mock → reasoning_effort）。标签用英文。
  const thinkingProtocol = provider === 'anthropic' ? 'anthropic-compatible' : 'openai-compatible';
  const thinkingOptions = thinkingLevelsForProtocol(thinkingProtocol);
  const effectiveThinking = convergeThinkingLevel(thinking, thinkingProtocol) as AiThinkingLevel;
  return (
    <div className="agent-controls">
      <div className="agent-controls__row">
        {/* 标签是「草稿生成器」而不是「模型服务」：这三个选项只作用于计划草稿，
            真实任务用哪个服务由「AI 任务」区的下拉决定。同名会让用户以为在这里
            选了就生效。 */}
        <label className="agent-controls__label" htmlFor="agent-provider">草稿生成器</label>
        <select
          id="agent-provider"
          value={provider}
          onChange={(event) => onProviderChange(event.target.value as AiProvider)}
          aria-label="计划草稿生成器"
        >
          <option value="mock">离线计划（不调用模型）</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
        </select>
        {provider === 'mock' && (
          <p className="agent-controls__hint">离线规则计划器：不运行任何本地或远程模型。</p>
        )}
        <p className="agent-controls__scope" data-testid="agent-draft-scope">
          仅用于生成计划草稿。运行任务使用的模型服务在下方「AI 任务」区选择，
          两者互不影响。
        </p>
      </div>
      <div className="agent-controls__row">
        <label className="agent-controls__label" htmlFor="agent-thinking">思考强度</label>
        <select
          id="agent-thinking"
          value={effectiveThinking}
          onChange={(event) => onThinkingChange(event.target.value as AiThinkingLevel)}
          aria-label="思考强度"
        >
          {thinkingOptions.map((level) => (
            <option key={level} value={level}>{thinkingLevelLabel(level, thinkingProtocol)}</option>
          ))}
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
