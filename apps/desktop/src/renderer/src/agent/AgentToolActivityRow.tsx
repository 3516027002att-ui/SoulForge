import { useState, type ReactElement } from 'react';

export type AgentToolActivityStatus = 'running' | 'succeeded' | 'failed';

export interface AgentToolActivityRowProps {
  /** 活动 id（callId / 消息 id），用作 key 与 data-testid。 */
  id: string;
  /** 单行摘要：工具名。§12.5 要求工具调用默认折叠为单行摘要。 */
  summary: string;
  status: AgentToolActivityStatus;
  /** 展开后显示的详情（参数 / 错误码）。缺省不渲染详情区。 */
  detail?: string | null;
  /** 详情区标题（默认「参数」）。 */
  detailLabel?: string;
  /** 展开态默认值。默认 false —— 折叠是唯一默认，见 §12.5。 */
  defaultOpen?: boolean;
  /** 步骤号（可选）。 */
  step?: number;
}

function statusLabel(status: AgentToolActivityStatus): string {
  return ({ running: '进行中', succeeded: '成功', failed: '失败' } as const)[status];
}

/**
 * §12.10 组件树里的 AgentToolActivityRow：消息流中的工具调用行。
 *
 * 默认单行折叠（`<details>` 不带 open，§12.5「工具调用默认折叠为单行摘要」）；
 * 展开后才显示参数/错误码详情。status 与状态徽标分离成独立元素，
 * 便于单元测试与 e2e 断言「折叠态只看到单行摘要」。
 */
export function AgentToolActivityRow(props: AgentToolActivityRowProps): ReactElement {
  const {
    id,
    summary,
    status,
    detail = null,
    detailLabel = '参数',
    defaultOpen = false,
    step
  } = props;
  // 内部状态承载展开态：`open` 受控但 onToggle 回写，用户可自由展开/收起；
  // SSR 初始渲染按 defaultOpen 决定是否带 open 属性（默认折叠）。
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div
      className={`agent-tool-activity is-${status}`}
      data-testid={`agent-tool-activity-${id}`}
      data-status={status}
    >
      <details
        className="agent-tool-activity__details"
        open={isOpen}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary className="agent-tool-activity__summary">
          <span className={`agent-tool-activity__dot is-${status}`} aria-hidden="true"></span>
          {step !== undefined && (
            <span className="agent-tool-activity__step">第 {step} 步</span>
          )}
          <span className="agent-tool-activity__name">{summary}</span>
          <span className={`agent-tool-status agent-tool-status--${status}`} data-testid={`agent-tool-status-${id}`}>
            {statusLabel(status)}
          </span>
        </summary>
        {detail !== null && (
          <div className="agent-tool-activity__detail">
            <div className="agent-tool-activity__detail-label">{detailLabel}</div>
            <pre className="tool-output" data-testid={`agent-tool-detail-${id}`}>{detail}</pre>
          </div>
        )}
      </details>
    </div>
  );
}
