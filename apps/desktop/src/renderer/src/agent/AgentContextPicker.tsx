import type { ReactElement } from 'react';
import type { EditorSelectionContext } from '@soulforge/shared';
import {
  AGENT_NO_SELECTION_LABEL,
  agentSelectionSummary,
  isSelectionRendererSafe
} from '@soulforge/shared';

export interface AgentContextPickerProps {
  /** §12.8 当前编辑器语义选区；null = 无选区。 */
  selection: EditorSelectionContext | null;
  /** 选区摘要覆盖（opaque）；缺省由 agentSelectionSummary 生成，不携带路径。 */
  summary?: string;
  /** 清除上下文（真实回调；缺省不渲染清除按钮，避免伪造可用能力）。 */
  onClear?: () => void;
}

/**
 * §12.10 组件树里的 AgentContextPicker：把当前 §12.8 语义选区以 opaque 摘要
 * 形式展示。
 *
 * 安全边界：选区先过 renderer 安全白名单（绝对路径 / raw parser / Hex dump），
 * 不合格的选区一律回退「未选择逻辑资源」，绝不让泄漏内容进 DOM（§19.5）。
 * 已发送快照由 freezeAgentSelectionSnapshot 在发送时冻结，这里只读当前选区，
 * 切换编辑器不会改写已发送快照。
 */
export function AgentContextPicker(props: AgentContextPickerProps): ReactElement {
  const { selection, summary, onClear } = props;
  const safeSelection = selection !== null && isSelectionRendererSafe(selection) ? selection : null;
  const label = safeSelection === null
    ? AGENT_NO_SELECTION_LABEL
    : (summary ?? agentSelectionSummary(safeSelection));

  return (
    <div
      className="agent-context-picker"
      data-testid="agent-context-picker"
      aria-label="Agent 上下文选择"
    >
      <span className="ctx-chip" title={label} data-testid="agent-context-selection">
        <span aria-hidden="true">#</span>
        {label}
      </span>
      {safeSelection !== null && onClear !== undefined && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onClear}
          aria-label="清除上下文"
          title="清除当前 Agent 上下文"
        >
          ×
        </button>
      )}
    </div>
  );
}
