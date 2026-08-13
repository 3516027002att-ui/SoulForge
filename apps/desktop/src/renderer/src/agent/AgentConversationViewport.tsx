import type { ReactElement, ReactNode } from 'react';
import { AgentWelcome } from './AgentWelcome.js';

export interface AgentConversationViewportProps {
  /** 空闲欢迎态（无消息且无活动任务）是否显示。 */
  idle: boolean;
  children: ReactNode;
}

/**
 * dock 中段滚动区（§12.1 的 `minmax(0, 1fr)` 行）。
 *
 * 空闲时只渲染 §12.4 固定欢迎态；否则渲染消息/任务内容。消息分页/虚拟化是
 * 硬约束 17 的要求，由 AGENT-60C 的 AgentMessageList 承担——这里只做滚动容器，
 * 不允许一次性渲染无界消息列表。
 */
export function AgentConversationViewport(props: AgentConversationViewportProps): ReactElement {
  const { idle, children } = props;
  return (
    <div className="agent-conversation" role="log" aria-live="polite" aria-label="Agent 会话记录">
      {idle ? <AgentWelcome /> : children}
    </div>
  );
}
