import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { AgentMessageDto } from '@soulforge/shared';
import {
  AGENT_MESSAGE_PAGE_SIZE,
  agentMessageTail,
  agentMessageWindow,
  agentOlderCursor,
  parseAgentMessageCursor,
  shouldAgentAutoScroll
} from '@soulforge/shared';

export interface AgentMessageListProps {
  /** 已装配的 §12.11 消息流（严格 seq 过滤在 reduceAgentStreamToMessages 层完成）。 */
  messages: readonly AgentMessageDto[];
  /** 每页条数；默认 AGENT_MESSAGE_PAGE_SIZE（50），收敛 1..100。 */
  pageSize?: number;
  /** 点击「加载更早消息」的真实回调；缺省不渲染该按钮。 */
  onLoadOlder?: () => void;
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
          {message.streaming && (
            <p className="agent-message__streaming" role="status">
              <span className="spinner" aria-hidden="true"></span>
              <span>正在生成…</span>
            </p>
          )}
          <p className="agent-message__markdown">{message.markdown}</p>
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
 * §12.10 组件树里的 AgentMessageList：bounded message pages + scroll threshold。
 *
 * - 只渲染有界窗口（agentMessageTail / agentMessageWindow，硬约束 17）；
 * - 「加载更早消息」只在前一页存在且挂载了真实回调时出现；
 * - 新消息到达时，仅当用户已贴底（shouldAgentAutoScroll）才跟随到最新尾部，
 *   向上滚动阅读历史时不被强行拉回；
 * - 严格 event seq 与消息装配在 reduceAgentStreamToMessages（shared agent-ui）
 *   完成，本组件只消费装配结果，不重复实现。
 */
export function AgentMessageList(props: AgentMessageListProps): ReactElement {
  const { messages, pageSize = AGENT_MESSAGE_PAGE_SIZE, onLoadOlder } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [startIndex, setStartIndex] = useState<number>(
    () => agentMessageTail(messages, pageSize).startIndex
  );

  // 新消息到达：用户已贴底才跟随到最新尾部，否则保留当前阅读窗口。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || typeof window === 'undefined') return;
    const nearBottom = shouldAgentAutoScroll({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight
    });
    if (nearBottom) {
      element.scrollTop = element.scrollHeight;
      setStartIndex(agentMessageTail(messages, pageSize).startIndex);
    }
  }, [messages, pageSize]);

  const window = agentMessageWindow(messages, startIndex, pageSize);
  const olderCursor = agentOlderCursor(window, pageSize);
  const hasOlder = olderCursor !== null;

  function loadOlder(): void {
    const cursor = olderCursor;
    if (cursor === null) return;
    const index = parseAgentMessageCursor(cursor);
    if (index === null) return;
    setStartIndex(index);
    onLoadOlder?.();
  }

  return (
    <div
      className="agent-message-list"
      data-testid="agent-message-list"
      role="log"
      aria-live="polite"
      aria-label="Agent 消息流"
      ref={scrollRef}
    >
      {hasOlder && onLoadOlder !== undefined && (
        <div className="agent-message-list__pager">
          <button type="button" className="btn btn--ghost btn--sm" onClick={loadOlder}>
            加载更早消息
          </button>
        </div>
      )}
      {window.items.length === 0 && (
        <p className="empty-hint" data-testid="agent-message-list-empty">暂无消息。</p>
      )}
      {window.items.map((message) => (
        <article className={messageClassName(message)} key={message.id} data-testid={`agent-message-${message.id}`}>
          {messageBody(message)}
        </article>
      ))}
      {window.hasNewer && (
        <div className="agent-message-list__pager">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setStartIndex(window.endIndex)}
          >
            查看更新消息
          </button>
        </div>
      )}
    </div>
  );
}
