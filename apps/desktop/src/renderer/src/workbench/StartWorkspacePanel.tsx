import type { ReactElement } from 'react';

export interface StartWorkspacePanelProps {
  /** 当前 Mod 工作区显示名；null = 未打开。 */
  workspaceLabel: string | null;
  /** 已选原版目录的显示名；null = 未选择。 */
  baseRootChoiceLabel: string | null;
  /** 原版目录是否已挂载（只读）。未挂载但有选择时显示「待打开生效」。 */
  baseMounted: boolean;
  browserPreview: boolean;
  onOpenWorkspace: () => void;
  onChooseBaseDirectory: () => void;
  onClearBaseDirectory: () => void;
}

/**
 * 「开始」工作域的单一落点（T2：项目 → 开始）。
 *
 * 挂载入口全部离开侧栏，只保留打开/更换 Mod、选择/更换/清除原版、工作区名与
 * 原版挂载状态四件事。不做统计卡、域快捷与欢迎文案 —— 高频入口走顶部领域栏。
 *
 * class 沿用 `.project-overview`（中央占位宽度与排版），aria-label 已是「开始」。
 */
export function StartWorkspacePanel({
  workspaceLabel,
  baseRootChoiceLabel,
  baseMounted,
  browserPreview,
  onOpenWorkspace,
  onChooseBaseDirectory,
  onClearBaseDirectory
}: StartWorkspacePanelProps): ReactElement {
  return (
    <section className="project-overview" aria-label="开始">
      <h1>{workspaceLabel ?? '未打开工作区'}</h1>
      <div className="start-workspace__actions">
        <button
          type="button"
          className={workspaceLabel ? 'btn btn--ghost btn--block' : 'btn btn--primary btn--block'}
          data-testid="open-workspace"
          onClick={onOpenWorkspace}
          {...(browserPreview ? {
            'aria-disabled': true,
            title: '浏览器预览：「打开 Mod 工作区」仅在 SoulForge 桌面版可用'
          } : {})}
        >
          {workspaceLabel ? '更换 Mod 工作区' : '打开 Mod 工作区'}
        </button>
        <div className="row gap">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            data-testid="choose-base-directory"
            onClick={onChooseBaseDirectory}
            {...(browserPreview ? {
              'aria-disabled': true,
              title: '浏览器预览：「选择原版目录」仅在 SoulForge 桌面版可用'
            } : {})}
          >
            {baseRootChoiceLabel ? '更换原版目录' : '选择原版目录'}
          </button>
          {baseRootChoiceLabel && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClearBaseDirectory}>清除</button>
          )}
        </div>
      </div>
      <div className="start-workspace__status" aria-label="工作区状态">
        <span className="explorer-mount__item" title={workspaceLabel ?? '未打开 Mod 工作区'}>
          工作区：{workspaceLabel ?? '未打开'}
        </span>
        <span className={baseMounted ? 'pill pill--ok' : 'pill'}>
          原版：{baseMounted ? '已挂载（只读）' : baseRootChoiceLabel ? '待打开生效' : '未挂载'}
        </span>
        {baseRootChoiceLabel && !baseMounted && (
          <p className="explorer-base-note" title={baseRootChoiceLabel}>
            原版（下次打开生效）：{baseRootChoiceLabel}
          </p>
        )}
      </div>
    </section>
  );
}
