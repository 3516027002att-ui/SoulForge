import type { ReactElement } from 'react';
import type { AgentResourceReference, EditorSelectionContext } from '@soulforge/shared';

export interface AgentResourceReferencePickerProps {
  /** main 已签发的 opaque 资源引用（label 为逻辑摘要，token 不展示、不带路径）。 */
  resources: readonly AgentResourceReference[];
  /** 当前选区；null 时「添加资源引用」disabled。 */
  selection: EditorSelectionContext | null;
  /** 真实回调：向 main 申请 opaque token 后把引用加入列表。缺省 = 诚实 disabled。 */
  onCreate?: (selection: EditorSelectionContext) => void;
  /** 移除一条资源引用。 */
  onRemove?: (token: string) => void;
}

/**
 * §12.10 组件树里的 AgentResourceReferencePicker：资源引用选择。
 *
 * 只展示 main 签发的 opaque 引用（§12.11 AgentResourceReference）的 label；
 * token 只作为 React key 使用，绝不渲染到 DOM。没有真实 onCreate 回调或没有
 * 选区时，「添加资源引用」诚实 disabled，不伪造可用能力。
 */
export function AgentResourceReferencePicker(props: AgentResourceReferencePickerProps): ReactElement {
  const { resources, selection, onCreate, onRemove } = props;
  const canCreate = selection !== null && onCreate !== undefined;

  return (
    <div
      className="agent-resource-refs"
      data-testid="agent-resource-references"
      aria-label="Agent 资源引用"
    >
      <div className="composer-context" aria-label="已引用的资源">
        {resources.length === 0 && (
          <span className="muted" data-testid="agent-resource-refs-empty">未引用资源</span>
        )}
        {resources.map((reference) => (
          <span className="ctx-chip" key={reference.token} title={reference.label}>
            <span aria-hidden="true">#</span>
            {reference.label}
            {onRemove !== undefined && (
              <button
                type="button"
                className="ctx-chip__remove"
                onClick={() => onRemove(reference.token)}
                aria-label={`移除引用 ${reference.label}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        disabled={!canCreate}
        onClick={() => {
          if (selection !== null && onCreate !== undefined) onCreate(selection);
        }}
        aria-label="添加资源引用"
        title={canCreate
          ? '把当前语义选区作为 opaque 资源引用加入（main 签发 token）'
          : '没有可引用的语义选区，或引用能力尚未接线'}
      >
        + 资源引用
      </button>
    </div>
  );
}
