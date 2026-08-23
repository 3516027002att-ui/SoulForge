import { useLayoutEffect, useRef, type ReactElement } from 'react';
import type { AgentMessageDto } from '@soulforge/shared';

export interface AgentMessageListProps {
  /** 已装配的 §12.11 消息流（严格 seq 过滤在 reduceAgentStreamToMessages 层完成）。 */
  messages: readonly AgentMessageDto[];
}

function messageBody(message: AgentMessageDto): ReactElement {
  switch (message.kind) {
    case 'user':
      return (
        <>
          <div className="agent-message__meta">你</div>
          <p>{message.text}</p>
        </>
      );
    case 'assistant':
      return (
        <>
          <div className="agent-message__meta">Agent</div>
          {message.streaming && message.markdown === '' && (
            <p className="agent-message__streaming" role="status">
              <span className="spinner" aria-hidden="true"></span>
              <span>正在生成…</span>
            </p>
          )}
          {message.markdown !== '' && (
            <p className="agent-message__markdown">{message.markdown}</p>
          )}
        </>
      );
    case 'tool-activity':
      return (
        <>
          <div className="agent-message__meta">工具</div>
          <p>{message.summary}</p>
          <span className={`agent-tool-status agent-tool-status--${message.status}`}>{message.status}</span>
        </>
      );
    case 'approval':
      return (
        <>
          <div className="agent-message__meta">审批</div>
          <p>评审 {message.reviewId}</p>
          <span className={`agent-approval-status agent-approval-status--${message.status}`}>{message.status}</span>
        </>
      );
  }
}

function messageClassName(message: AgentMessageDto): string {
  switch (message.kind) {
    case 'user': return 'agent-message agent-message--user';
    case 'assistant': return 'agent-message agent-message--agent';
    case 'tool-activity': return 'agent-message agent-message--system';
    case 'approval': return 'agent-message agent-message--approval';
  }
}

/**
 * §12.10 组件树里的 AgentMessageList：消息**全量渲染**（问题 5：显示不设限）。
 *
 * - `messages.map` 全量进 DOM，由栏自身滚动；不再按 50 条一页、不再「加载更早
 *   消息」假分页；
 * - 新消息到达时，仅当用户已贴底（shouldAgentAutoScroll）才跟随滚动到底部，
 *   向上滚动阅读历史时不被强行拉回；
 * - 严格 event seq 与消息装配在 reduceAgentStreamToMessages（shared agent-ui）
 *   完成，本组件只消费装配结果，不重复实现。
 */
export function AgentMessageList({ messages }: AgentMessageListProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 新消息到达时直接滚到底部（抄 reference 的 Message 流式，结束也必回流可见）
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  return (
    <div
      className="agent-message-list"
      data-testid="agent-message-list"
      role="log"
      aria-live="polite"
      aria-label="Agent 消息流"
      ref={scrollRef}
    >
      {messages.length === 0 && (
        <p className="empty-hint" data-testid="agent-message-list-empty">暂无消息。</p>
      )}
      {messages.map((message) => (
        <article className={messageClassName(message)} key={message.id} data-testid={`agent-message-${message.id}`}>
          {messageBody(message)}
        </article>
      ))}
    </div>
  );
}
