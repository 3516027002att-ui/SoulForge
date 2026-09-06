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
  if (!calls || !Array.isArray(calls)) return 'succeeded';
  if (calls.some((call) => call?.status === 'running')) return 'running';
  if (calls.some((call) => call?.status === 'failed')) return 'failed';
  return 'succeeded';
}

function statusLabel(status: 'running' | 'succeeded' | 'failed'): string {
  return ({ running: '进行中', succeeded: '已完成', failed: '有失败' } as const)[status] ?? '已完成';
}

/** 对照图 2：根据执行工具分类生成语义动作文本与图标。 */
function describeToolGroupAction(calls: readonly AgentToolCallView[]): { icon: string; text: string } {
  const safeCalls = Array.isArray(calls) ? calls : [];
  let hasRead = false;
  let hasWrite = false;
  let hasCommand = false;
  let hasList = false;

  for (const call of safeCalls) {
    const name = typeof call?.name === 'string' ? call.name.toLowerCase() : '';
    if (name.includes('run') || name.includes('cmd') || name.includes('command') || name.includes('bash') || name.includes('exec')) {
      hasCommand = true;
    } else if (name.includes('write') || name.includes('edit') || name.includes('update') || name.includes('mutation') || name.includes('replace') || name.includes('patch')) {
      hasWrite = true;
    } else if (name.includes('read') || name.includes('search') || name.includes('view') || name.includes('stats') || name.includes('evidence') || name.includes('find') || name.includes('query')) {
      hasRead = true;
    } else if (name.includes('list') || name.includes('get') || name.includes('load')) {
      hasList = true;
    }
  }

  const parts: string[] = [];
  if (hasRead && hasWrite) {
    parts.push('已读取并编辑文件');
  } else if (hasRead) {
    parts.push('已读取文件');
  } else if (hasWrite) {
    parts.push('已编辑文件');
  }

  if (hasCommand) {
    parts.push(parts.length > 0 ? '运行了命令' : '已运行命令');
  }

  if (hasList && parts.length === 0) {
    parts.push('已检索资源');
  }

  if (parts.length === 0) {
    return { icon: '🔧', text: '已执行工具' };
  }

  let icon = '🔧';
  if (hasRead) icon = '📖';
  else if (hasWrite) icon = '✏️';
  else if (hasCommand) icon = '⚡';

  return { icon, text: parts.join('') };
}

/** 连续工具调用的自动压缩组：默认单行紧凑折叠，包含动作摘要，点击可展开明细。 */
export function AgentToolActivityGroup(props: AgentToolActivityGroupProps): ReactElement {
  const { groupId, calls, live, collapsed } = props;
  const safeCalls = Array.isArray(calls) ? calls.filter(Boolean) : [];
  // 默认自动压缩收拢（图 2 样式）；用户点击切换展开状态
  const [isOpen, setIsOpen] = useState(false);
  const status = groupStatus(safeCalls);
  const names = [...new Set(safeCalls.map((call) => call.name || '工具'))];
  const action = describeToolGroupAction(safeCalls);

  // 下一段模型口播或 session 终态确保保持自动压缩收起
  useEffect(() => {
    if (collapsed) setIsOpen(false);
  }, [collapsed]);

  return (
    <details
      className={`agent-tool-group is-${status}${live ? ' is-live' : ''}`}
      data-testid={`agent-tool-group-${groupId}`}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary className="agent-tool-group__summary" title={names.join('、')}>
        <span className="agent-tool-group__icon" aria-hidden="true">{action.icon}</span>
        <span className="agent-tool-group__action-text">{action.text}</span>
        <span className="agent-tool-group__chevron" aria-hidden="true">{isOpen ? '⌵' : '›'}</span>
        <span className="sr-only agent-tool-group__count">· {safeCalls.length}</span>
        <span className="sr-only agent-tool-group__label">工具调用 · {safeCalls.length}</span>
        <span className="sr-only agent-tool-group__names">{names.join(' · ')}</span>
        <span className={`sr-only agent-tool-group__status is-${status}`}>{statusLabel(status)}</span>
      </summary>
      <div className="agent-tool-group__body">
        {safeCalls.map((call) => (
          <AgentToolActivityRow
            key={call.callId}
            id={call.callId}
            summary={call.name || '工具'}
            status={call.status === 'ok' ? 'succeeded' : call.status === 'failed' ? 'failed' : 'running'}
            detail={call.argumentsJson ?? null}
            step={call.step}
          />
        ))}
      </div>
    </details>
  );
}
