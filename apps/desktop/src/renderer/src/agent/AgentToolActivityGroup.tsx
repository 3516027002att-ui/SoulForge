import { useEffect, useState, type ReactElement } from 'react';
import type { AgentToolCallView } from './agentTaskState.js';
import { AgentToolActivityRow } from './AgentToolActivityRow.js';

export interface AgentToolActivityGroupProps {
  groupId: string;
  calls: readonly AgentToolCallView[];
  live: boolean;
  collapsed: boolean;
}

function groupStatus(calls: readonly AgentToolCallView[]): 'running' | 'succeeded' | 'failed' {
  if (calls.some((call) => call.status === 'running')) return 'running';
  if (calls.some((call) => call.status === 'failed')) return 'failed';
  return 'succeeded';
}

function statusLabel(status: 'running' | 'succeeded' | 'failed'): string {
  return ({ running: '进行中', succeeded: '已完成', failed: '有失败' } as const)[status];
}

/** 连续工具调用的 Codex 式过程组：摘要显示工具名，详情保留每次调用参数。 */
export function AgentToolActivityGroup(props: AgentToolActivityGroupProps): ReactElement {
  const { groupId, calls, live, collapsed } = props;
  const [isOpen, setIsOpen] = useState(live && !collapsed);
  const status = groupStatus(calls);
  const names = [...new Set(calls.map((call) => call.name))];

  // 下一段模型口播或 session 终态会把组标记为 collapsed；自动关闭只
  // 改变默认状态，用户之后仍可以手动点开检查完整过程。
  useEffect(() => {
    if (collapsed) setIsOpen(false);
  }, [collapsed]);

  return (
    <details
      className={`agent-tool-group${live ? ' is-live' : ''}`}
      data-testid={`agent-tool-group-${groupId}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="agent-tool-group__summary">
        <span className="agent-tool-group__label">工具调用 · {calls.length}</span>
        <span className="agent-tool-group__names" title={names.join('、')}>
          {names.join(' · ')}
        </span>
        <span className={`agent-tool-group__status is-${status}`}>{statusLabel(status)}</span>
      </summary>
      <div className="agent-tool-group__body">
        {calls.map((call) => (
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
    </details>
  );
}
