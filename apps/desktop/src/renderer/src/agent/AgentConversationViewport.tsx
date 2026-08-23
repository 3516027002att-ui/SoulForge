import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { shouldAgentAutoScroll, type AgentMessageDto } from '@soulforge/shared';
import type { AgentApprovalDiffView, AgentApprovalPreview, AgentConversationItem } from './agentTaskState.js';
import { AgentWelcome } from './AgentWelcome.js';
import { AgentMessageList } from './AgentMessageList.js';
import { AgentToolActivityRow } from './AgentToolActivityRow.js';
import {
  AgentApprovalCard,
  type AgentApprovalCommitFailure
} from './AgentApprovalCard.js';
import { AgentScrollToBottom } from './AgentScrollToBottom.js';

/** 任务态派生的工具活动行（AgentToolActivityRow 的输入）。 */
export interface AgentConversationToolActivity {
  id: string;
  summary: string;
  status: 'running' | 'succeeded' | 'failed';
  detail: string | null;
  step: number;
}

/** 待审批（AgentApprovalCard 的输入；onApprove/onReject 走真实 IPC）。 */
export interface AgentConversationApproval {
  id: string;
  toolName: string;
  permissionLevel: string;
  step: number;
  argumentsJson: string;
  diff: AgentApprovalDiffView | null;
  preview: AgentApprovalPreview | null;
  onApprove: () => void;
  onReject: () => void;
  submitting: boolean;
  commitFailure: AgentApprovalCommitFailure | null;
}

/** 失败态结构化诊断（有界展示，不替换整个 dock）。 */
export interface AgentConversationFailure {
  code: string;
  message: string;
}

export interface AgentConversationViewportProps {
  /** 空闲欢迎态（无消息且无活动任务）是否显示。 */
  idle: boolean;
  /** 是否已激活 test 模型免配置状态 */
  testActive?: boolean | undefined;
  /** §12.11 已装配消息流；非空时优先渲染 AgentMessageList（全量渲染）。 */
  messages?: readonly AgentMessageDto[];
  /** 任务态派生的对话时间线（口播与工具按步交织）。 */
  conversationItems?: readonly AgentConversationItem[];
  /** 待审批（Change Review 是消息流唯一强边界卡）。 */
  approvals?: readonly AgentConversationApproval[];
  /** 失败态诊断；null 表示无失败。 */
  failure?: AgentConversationFailure | null;
  /** 任务进行中的状态文案（describeAgentTaskStatus 产出）。 */
  status?: string | null;
  children?: ReactNode;
}

function renderConversationItem(item: AgentConversationItem, index: number): ReactElement {
  switch (item.kind) {
    case 'user':
      return (
        <article className="agent-message agent-message--user" key={`user-${index}`}>
          <div className="agent-message__meta">你</div>
          <p>{item.text}</p>
        </article>
      );
    case 'notice':
      return (
        <div className="agent-message agent-message--system" role="status" key={`notice-${index}`}>
          <span>{item.text}</span>
        </div>
      );
    case 'thinking':
      if (item.live && item.text === '') {
        return (
          <div className="agent-thinking is-live" key={`thinking-${index}`} data-testid="agent-thinking">
            <span className="spinner" aria-hidden="true"></span>
            <span>{item.label}</span>
          </div>
        );
      }
      if (!item.live && item.text === '') {
        return (
          <div className="agent-thinking" key={`thinking-${index}`} data-testid="agent-thinking">
            {item.label}
          </div>
        );
      }
      return (
        <details
          className={`agent-thinking${item.live ? ' is-live' : ''}`}
          key={`thinking-${index}`}
          data-testid="agent-thinking"
          open={item.live ? true : undefined}
        >
          <summary>{item.label}</summary>
          <div className="agent-thinking__body">{item.text}</div>
        </details>
      );
    case 'assistant':
      return (
        <article className="agent-message agent-message--agent" key={`assistant-${item.step}-${index}`}>
          <p className="agent-message__markdown">{item.text}</p>
        </article>
      );
    case 'tools':
      return (
        <div className="agent-tool-chip-row" key={`tools-${item.step}`}>
          {item.calls.map((call) => (
            <AgentToolActivityRow
              key={call.callId}
              id={call.callId}
              summary={call.name}
              status={call.status === 'ok' ? 'succeeded' : call.status === 'failed' ? 'failed' : 'running'}
              detail={call.argumentsJson ?? null}
              step={call.step}
            />
          ))}
        </div>
      );
    case 'compacted':
      return (
        <div className="agent-compact-summary" key={`compacted-${index}`} data-testid="agent-context-compacted">
          上下文已自动压缩 {item.windows} 次
        </div>
      );
    case 'draft':
      return (
        <article className="agent-message agent-message--agent" key={`draft-${index}`}>
          <div className="agent-message__meta">Agent · 计划草稿</div>
          <strong>{item.title}</strong>
          <p>{item.summary}</p>
          {item.nextActions.length > 0 && (
            <ul className="agent-message__actions">
              {item.nextActions.map((action) => <li key={action}>{action}</li>)}
            </ul>
          )}
        </article>
      );
  }
}

/**
 * dock 中段滚动区（§12.1 的 `minmax(0, 1fr)` 行）—— 四态渲染的汇聚点：
 *
 *  1. conversation：时间线（口播与工具按步交织）或 AgentMessageList；
 *  2. tool-running：时间线里的工具行（单行折叠）；
 *  3. approval：AgentApprovalCard（七要素 Change Review，唯一强边界卡）；
 *  4. failure：有界失败诊断（折叠/限高，不替换整个 dock）。
 */
export function AgentConversationViewport(props: AgentConversationViewportProps): ReactElement {
  const {
    idle,
    messages = [],
    conversationItems = [],
    approvals = [],
    failure = null,
    status = null,
    children
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;
  const hasTimeline = conversationItems.length > 0;
  const [nowTick, setNowTick] = useState(0);

  const thinkingLive = conversationItems.some((item) => item.kind === 'thinking' && item.live);
  useEffect(() => {
    if (!thinkingLive) return undefined;
    const timer = window.setInterval(() => setNowTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [thinkingLive]);

  // 粘性滚动：贴底才跟随新内容；用户上滚阅读时不再被拽回底部（「回到底部」
  // 钮用同一 48px 阈值现身）。无条件滚底会让滚动条「往下吸」，读不了历史。
  const stickToBottomRef = useRef(true);
  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = shouldAgentAutoScroll({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    });
  }
  // 新会话（用户目标变化）时恢复跟随，保证发送后能看到最新尾部。
  const firstUserText = conversationItems.find((item) => item.kind === 'user')?.text ?? '';
  const prevUserTextRef = useRef(firstUserText);
  useEffect(() => {
    if (prevUserTextRef.current !== firstUserText) {
      prevUserTextRef.current = firstUserText;
      stickToBottomRef.current = true;
    }
  }, [firstUserText]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, conversationItems, approvals, status, failure]);

  return (
    <div
      className="agent-conversation"
      role="log"
      aria-live="polite"
      aria-label="Agent 会话记录"
      ref={scrollRef}
      onScroll={handleScroll}
    >
      {failure !== null && (
        <section className="agent-failure-card" data-testid="agent-failure" role="alert">
          <strong>任务失败</strong>
          <p data-testid="agent-failure-code">错误码：{failure.code}</p>
          <p className="muted">{failure.message}</p>
          <p className="muted">失败只影响本次运行，不会替换整个面板；请检查 Problems 诊断后重试。</p>
        </section>
      )}

      {hasMessages ? (
        <AgentMessageList messages={messages} />
      ) : idle && !hasTimeline ? (
        <AgentWelcome testActive={props.testActive} />
      ) : hasTimeline ? (
        conversationItems.map((item, index) => renderConversationItem(item, index))
      ) : (
        children
      )}

      {approvals.map((approval) => (
        <AgentApprovalCard
          key={approval.id}
          id={approval.id}
          toolName={approval.toolName}
          permissionLevel={approval.permissionLevel}
          step={approval.step}
          argumentsJson={approval.argumentsJson}
          diff={approval.diff}
          preview={approval.preview}
          onApprove={approval.onApprove}
          onReject={approval.onReject}
          submitting={approval.submitting}
          commitFailure={approval.commitFailure}
        />
      ))}

      {status !== null && (
        <div className="agent-log" role="status" aria-live="polite">
          <div className="agent-log__row" data-testid="agent-task-status">
            {thinkingLive && <span className="spinner" aria-hidden="true"></span>}
            <span>{status}</span>
          </div>
        </div>
      )}

      <AgentScrollToBottom scrollRef={scrollRef} />
    </div>
  );
}
