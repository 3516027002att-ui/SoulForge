import { useRef, type ReactElement, type ReactNode } from 'react';
import type { AgentMessageDto } from '@soulforge/shared';
import type { AgentApprovalDiffView, AgentApprovalPreview } from './agentTaskState.js';
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
  /** §12.11 已装配消息流；非空时优先渲染 AgentMessageList（全量渲染）。 */
  messages?: readonly AgentMessageDto[];
  /** 任务态派生的工具活动（§12.5 默认单行折叠）。 */
  toolActivities?: readonly AgentConversationToolActivity[];
  /** 待审批（Change Review 是消息流唯一强边界卡）。 */
  approvals?: readonly AgentConversationApproval[];
  /** 失败态诊断；null 表示无失败。 */
  failure?: AgentConversationFailure | null;
  /** 任务进行中的状态文案（describeAgentTaskStatus 产出）。 */
  status?: string | null;
  children?: ReactNode;
}

/**
 * dock 中段滚动区（§12.1 的 `minmax(0, 1fr)` 行）—— 四态渲染的汇聚点：
 *
 *  1. conversation：AgentMessageList（60C bounded pages）或 legacy children；
 *  2. tool-running：AgentToolActivityRow（单行折叠）；
 *  3. approval：AgentApprovalCard（七要素 Change Review，唯一强边界卡）；
 *  4. failure：有界失败诊断（折叠/限高，不替换整个 dock）。
 *
 * 滚动容器唯一（.agent-conversation），AgentScrollToBottom 按 60C 的 scroll
 * threshold 决定是否显示「回到底部」。
 */
export function AgentConversationViewport(props: AgentConversationViewportProps): ReactElement {
  const {
    idle,
    messages = [],
    toolActivities = [],
    approvals = [],
    failure = null,
    status = null,
    children
  } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;

  return (
    <div
      className="agent-conversation"
      role="log"
      aria-live="polite"
      aria-label="Agent 会话记录"
      ref={scrollRef}
    >
      {failure !== null && (
        <section className="agent-failure-card" data-testid="agent-failure" role="alert">
          <strong>任务失败</strong>
          <p data-testid="agent-failure-code">错误码：{failure.code}</p>
          <p className="muted">{failure.message}</p>
          <p className="muted">失败只影响本次运行，不会替换整个面板；请检查 Problems 诊断后重试。</p>
        </section>
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

      {toolActivities.map((activity) => (
        <AgentToolActivityRow
          key={activity.id}
          id={activity.id}
          summary={activity.summary}
          status={activity.status}
          detail={activity.detail}
          step={activity.step}
        />
      ))}

      {status !== null && (
        <div className="agent-log" role="status" aria-live="polite">
          <div className="agent-log__row" data-testid="agent-task-status">
            <span>{status}</span>
          </div>
        </div>
      )}

      {hasMessages ? (
        <AgentMessageList messages={messages} />
      ) : idle ? (
        <AgentWelcome />
      ) : (
        children
      )}

      <AgentScrollToBottom scrollRef={scrollRef} />
    </div>
  );
}
