import type { ReactElement } from 'react';

export interface ProjectOverviewPanelProps {
  workspaceLabel: string | null;
  indexedFiles: number;
  pendingChanges: number;
  diagnostics: number;
  browserPreview: boolean;
  onOpenWorkspace: () => void;
}

/** 项目工作域的单一落点：状态优先，避免把欢迎页与资源编辑器叠加。 */
export function ProjectOverviewPanel({
  workspaceLabel,
  indexedFiles,
  pendingChanges,
  diagnostics,
  browserPreview,
  onOpenWorkspace
}: ProjectOverviewPanelProps): ReactElement {
  return (
    <section className="project-overview" aria-label="项目概览">
      <div className="project-overview__eyebrow">SOULFORGE / PROJECT</div>
      <h1>{workspaceLabel ?? '未打开工作区'}</h1>
      <p className="project-overview__summary">
        {workspaceLabel
          ? '从工作域导航进入具体资源；每个资源只挂载一个语义编辑器。'
          : '打开一个 Mod 工作区后，PARAM、文本、事件与资产会按工作域组织。'}
      </p>
      {!workspaceLabel && (
        <button
          type="button"
          className="btn btn--primary"
          onClick={onOpenWorkspace}
          aria-disabled={browserPreview || undefined}
        >
          打开 Mod 工作区
        </button>
      )}
      <div className="project-overview__facts" aria-label="项目状态">
        <div><span>已索引</span><strong>{indexedFiles}</strong><small>文件</small></div>
        <div><span>待处理</span><strong>{pendingChanges}</strong><small>项变更</small></div>
        <div><span>诊断</span><strong>{diagnostics}</strong><small>条</small></div>
      </div>
      {browserPreview && (
        <p className="runtime-notice" role="note">浏览器预览只展示界面；打开目录与写入功能需在 SoulForge 桌面版完成。</p>
      )}
    </section>
  );
}

