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
  return ({ running: '进行中', succeeded: '成功', failed: '失败' } as const)[status] ?? '完成';
}

export interface ToolCallSemantic {
  icon: string;
  action: string;
  target: string;
  isTag: boolean;
  fullDetail: string;
}

/** 对照图 2：将工具原始调用名与入参解析为语义动词与对象 */
export function parseToolCallSemantic(toolName: string, argumentsJson?: string | null): ToolCallSemantic {
  const name = (toolName || '').toLowerCase();
  let parsed: Record<string, unknown> = {};
  if (argumentsJson) {
    try {
      parsed = JSON.parse(argumentsJson);
    } catch {
      // 忽略无法解析的 JSON
    }
  }

  // 1. 命令行类：>_ 已运行 git status ...
  if (name.includes('run') || name.includes('cmd') || name.includes('command') || name.includes('bash') || name.includes('exec')) {
    const cmd = String(parsed.CommandLine ?? parsed.command ?? parsed.cmd ?? '').trim();
    return {
      icon: '>_',
      action: '已运行',
      target: cmd || toolName,
      isTag: false,
      fullDetail: cmd || argumentsJson || ''
    };
  }

  // 2. 读取 / 查看文件类：📖 已读取 SKILL.md
  if (name.includes('read') || name.includes('view') || name.includes('open') || name.includes('cat')) {
    const rawPath = String(parsed.AbsolutePath ?? parsed.TargetFile ?? parsed.targetPath ?? parsed.path ?? parsed.filePath ?? '').trim();
    const fileName = rawPath ? rawPath.split(/[\\/]/).pop() || rawPath : '';
    if (name.includes('task_record')) {
      return { icon: '📖', action: '已读取', target: '任务记录', isTag: true, fullDetail: rawPath };
    }
    if (name.includes('stats')) {
      return { icon: '📊', action: '已读取', target: '工作区统计', isTag: true, fullDetail: rawPath };
    }
    return {
      icon: '📖',
      action: '已读取',
      target: fileName || toolName,
      isTag: !!fileName,
      fullDetail: rawPath || argumentsJson || ''
    };
  }

  // 3. 编辑 / 写入文件类：✏️ 已编辑 x.dcx
  if (name.includes('write') || name.includes('edit') || name.includes('replace') || name.includes('mutate') || name.includes('patch')) {
    const rawPath = String(parsed.TargetFile ?? parsed.targetPath ?? parsed.path ?? parsed.filePath ?? '').trim();
    const fileName = rawPath ? rawPath.split(/[\\/]/).pop() || rawPath : '';
    if (name.includes('task_record')) {
      return { icon: '📝', action: '已更新', target: '任务记录', isTag: true, fullDetail: rawPath };
    }
    return {
      icon: '✏️',
      action: '已编辑',
      target: fileName || toolName,
      isTag: !!fileName,
      fullDetail: rawPath || argumentsJson || ''
    };
  }

  // 4. 检索 / 查询类：🔍 已检索 query
  if (name.includes('search') || name.includes('grep') || name.includes('find') || name.includes('query') || name.includes('retrieve')) {
    const query = String(parsed.Query ?? parsed.query ?? parsed.Pattern ?? parsed.pattern ?? parsed.paramName ?? parsed.keyword ?? '').trim();
    if (name.includes('map_object')) {
      return { icon: '🗺️', action: '已查询', target: '地图对象', isTag: true, fullDetail: query };
    }
    if (name.includes('references')) {
      return { icon: '🔗', action: '已查找', target: '引用关系', isTag: true, fullDetail: query };
    }
    if (name.includes('evidence')) {
      return { icon: '🔍', action: '已检索', target: '工作区证据', isTag: true, fullDetail: query };
    }
    return {
      icon: '🔍',
      action: '已检索',
      target: query || toolName,
      isTag: false,
      fullDetail: query || argumentsJson || ''
    };
  }

  // 5. 记忆类
  if (name.includes('memories') || name.includes('memory')) {
    return { icon: '🧠', action: '已读取', target: '会话记忆', isTag: true, fullDetail: argumentsJson || '' };
  }

  return {
    icon: '🔧',
    action: '已调用',
    target: toolName,
    isTag: true,
    fullDetail: argumentsJson || ''
  };
}

/**
 * §12.10 组件树里的 AgentToolActivityRow：消息流中的工具调用单行流水（图 2 样式）。
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
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const semantic = parseToolCallSemantic(summary, detail);

  return (
    <div
      className={`agent-tool-activity is-${status}`}
      data-testid={`agent-tool-activity-row-${id}`}
      data-status={status}
    >
      <details
        className="agent-tool-activity__details"
        open={isOpen}
        onToggle={(event) => setIsOpen(event.currentTarget.open)}
      >
        <summary className="agent-tool-activity__summary" title={semantic.fullDetail || summary}>
          {semantic.icon === '>_' ? (
            <span className="agent-terminal-badge" aria-hidden="true">&gt;_</span>
          ) : (
            <span className="agent-tool-activity__icon" aria-hidden="true">{semantic.icon}</span>
          )}
          <span className="agent-tool-activity__action">{semantic.action}</span>
          <span className={`agent-tool-activity__target${semantic.isTag ? ' is-tag' : ''}`}>
            {semantic.target}
          </span>
          <span className="sr-only agent-tool-activity__name">{summary}</span>
          <span className={`sr-only agent-tool-status agent-tool-status--${status}`} data-testid={`agent-tool-status-${id}`}>
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
