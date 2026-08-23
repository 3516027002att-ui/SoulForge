import type { ReactElement } from 'react';
import type { AgentResourceReference, EditorSelectionContext } from '@soulforge/shared';
import { AGENT_RESOURCE_REFERENCE_MAX } from './agentResourceReferences.js';

export interface AgentResourceReferencePickerProps {
  /** main 已签发的 opaque 资源引用（label 为逻辑摘要，token 不展示、不带路径）。 */
  resources: readonly AgentResourceReference[];
  /** 当前选区；null 时「添加资源引用」disabled。 */
  selection: EditorSelectionContext | null;
  /** 真实回调：向 main 申请 opaque token 后把引用加入列表。缺省 = 诚实 disabled。 */
  onCreate?: (selection: EditorSelectionContext) => void;
  /** 移除一条资源引用。 */
  onRemove?: (token: string) => void;
  /** §12.11 正在向 main 申请 opaque token：true 时按钮禁用防重复提交。 */
  creating?: boolean;
  /** 最近一次创建失败的结构化诊断（main 返回值，不携带路径；null = 无）。 */
  error?: string | null;
}

/**
 * §12.10 组件树里的 AgentResourceReferencePicker：资源引用选择。
 *
 * 只展示 main 签发的 opaque 引用（§12.11 AgentResourceReference）的 label；
 * token 只作为 React key 使用，绝不渲染到 DOM。没有真实 onCreate 回调或没有
 * 选区时，「添加资源引用」诚实 disabled，不伪造可用能力。创建中禁用按钮防
 * 重复提交；失败把 main 的结构化诊断渲染出来，不吞异常。
 */
export function AgentResourceReferencePicker(props: AgentResourceReferencePickerProps): ReactElement {
  const { resources, selection, onCreate, onRemove, creating = false, error = null } = props;
  const atCapacity = resources.length >= AGENT_RESOURCE_REFERENCE_MAX;
  const canCreate = selection !== null && onCreate !== undefined && !creating && !atCapacity;

  const title = creating
    ? '正在向主进程申请 opaque 引用 token…'
    : atCapacity
      ? `资源引用最多 ${AGENT_RESOURCE_REFERENCE_MAX} 个（§12.11）。`
      : selection === null
        ? '没有可引用的语义选区（先打开一个逻辑资源）'
        : onCreate === undefined
          ? '引用能力尚未接线'
          : '把当前语义选区作为 opaque 资源引用加入（main 签发 token）';

  return (
    <div
      className="agent-resource-refs"
      data-testid="agent-resource-references"
      aria-label="Agent 资源引用"
    >
      <div className="composer-context" aria-label="已引用的资源">
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
        title={title}
      >
        {creating ? '创建中…' : '+ 资源引用'}
      </button>
      {error !== null && (
        <p className="diag-error" role="alert" data-testid="agent-resource-ref-error">
          {error}
        </p>
      )}
    </div>
  );
}
