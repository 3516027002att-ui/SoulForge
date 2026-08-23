import type { ReactElement } from 'react';

export type AgentContextChipKind = '@' | '#' | 'attachment';

export interface AgentContextChip {
  kind: AgentContextChipKind;
  label: string;
  /** hover 时的完整内容；缺省时用 label。 */
  title?: string;
  /** 附件移除用；不渲染进 DOM。 */
  token?: string;
}

export interface AgentContextChipListProps {
  chips: AgentContextChip[];
  onRemove?: (token: string) => void;
}

/**
 * 三层 Composer 的第二层「上下文 chips」（§12.6 输入区的 context chips）。
 *
 * 只做展示，不承担选择/删除：60B 的真实语义实体选择、EditorCatalog 资源搜索、
 * 附件引用 token 都由 60C 的 picker 接线，这里先把「当前上下文」以只读 chip
 * 形式稳定展示，避免在未打通真实链路前伪造可交互能力。
 */
export function AgentContextChipList(props: AgentContextChipListProps): ReactElement {
  const { chips, onRemove } = props;
  return (
    <div
      className="composer-context"
      aria-label="当前上下文"
      data-testid="agent-context-chips"
    >
      {chips.map((chip, index) => (
        <span
          className="ctx-chip"
          key={`${chip.kind}:${chip.token ?? index}`}
          title={chip.title ?? chip.label}
        >
          <span className="ctx-chip__label">{chip.label}</span>
          {onRemove !== undefined && chip.token !== undefined && (
            <button
              type="button"
              className="ctx-chip__remove"
              onClick={() => onRemove(chip.token as string)}
              aria-label={`移除附件 ${chip.label}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
