import type { ReactElement, ReactNode } from 'react';
import type { AgentMessageDto } from '@soulforge/shared';
import { AgentWelcome } from './AgentWelcome.js';
import { AgentMessageList } from './AgentMessageList.js';

export interface AgentConversationViewportProps {
  /** 空闲欢迎态（无消息且无活动任务）是否显示。 */
  idle: boolean;
  /** §12.11 已装配消息流；非空时优先渲染 AgentMessageList（bounded pages）。 */
  messages?: readonly AgentMessageDto[];
  /** 「加载更早消息」回调（透传给 AgentMessageList）。 */
  onLoadOlder?: () => void;
  children: ReactNode;
}

/**
 * dock 中段滚动区（§12.1 的 `minmax(0, 1fr)` 行）。
 *
 * 空闲时只渲染 §12.4 固定欢迎态；有消息流时渲染 AgentMessageList（bounded
 * message pages，硬约束 17）；否则渲染消息/任务内容（60A–60B 的 legacy 路径，
 * 待 60D 整体迁到消息流）。
 */
export function AgentConversationViewport(props: AgentConversationViewportProps): ReactElement {
  const { idle, messages = [], onLoadOlder, children } = props;
  const hasMessages = messages.length > 0;
  return (
    <div className="agent-conversation" role="log" aria-live="polite" aria-label="Agent 会话记录">
      {hasMessages ? (
        <AgentMessageList
          messages={messages}
          {...(onLoadOlder !== undefined ? { onLoadOlder } : {})}
        />
      ) : idle ? (
        <AgentWelcome />
      ) : children}
    </div>
  );
}
