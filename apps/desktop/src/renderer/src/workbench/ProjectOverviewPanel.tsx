import type { ReactElement } from 'react';
import type { EditorDomainId } from '@soulforge/shared';

export interface ProjectOverviewRecentFile {
  sourceUri: string;
  relativePath: string;
  resourceKind: string;
  formatLabel: string;
}

export interface ProjectOverviewDraft {
  id: string;
  target: string;
  summary: string;
}

export interface ProjectOverviewPanelProps {
  workspaceLabel: string | null;
  indexedFiles: number;
  pendingChanges: number;
  diagnostics: number;
  browserPreview: boolean;
  onOpenWorkspace: () => void;
  draftChanges?: readonly ProjectOverviewDraft[];
  recentFiles?: readonly ProjectOverviewRecentFile[];
  onSelectFile?: (sourceUri: string) => void;
  onReviewChanges?: () => void;
  onSelectDomain?: (domain: EditorDomainId) => void;
}

const DOMAIN_SHORTCUTS: Array<{ domain: EditorDomainId; label: string }> = [
  { domain: 'param', label: 'PARAM' },
  { domain: 'text', label: '文本' },
  { domain: 'event', label: '事件' },
  { domain: 'files', label: '文件' }
];

/** 项目工作域的单一落点：状态优先，避免把欢迎页与资源编辑器叠加。 */
export function ProjectOverviewPanel({
  workspaceLabel,
  indexedFiles,
  pendingChanges,
  diagnostics,
  browserPreview,
  onOpenWorkspace,
  draftChanges = [],
  recentFiles = [],
  onSelectFile,
  onReviewChanges,
  onSelectDomain
}: ProjectOverviewPanelProps): ReactElement {
  return (
    <section className="project-overview" aria-label="项目概览">
      <div className="project-overview__eyebrow">SOULFORGE / PROJECT</div>
      <h1>{workspaceLabel ?? '未打开工作区'}</h1>
      <p className="project-overview__summary">
        {workspaceLabel
          ? '从顶部工作域进入 PARAM、文本、事件或文件；每个资源只挂载一个语义编辑器。'
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
      {workspaceLabel && onSelectDomain && (
        <div className="project-overview__shortcuts" aria-label="进入工作域">
          {DOMAIN_SHORTCUTS.map((entry) => (
            <button
              key={entry.domain}
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => onSelectDomain(entry.domain)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {workspaceLabel && (
        <section className="project-overview__section" aria-label="待审查变更">
          <div className="welcome-quick__label">待审查变更</div>
          {draftChanges.length === 0 ? (
            <p className="empty-hint welcome-empty">没有待审查的变更。</p>
          ) : (
            draftChanges.map((item) => (
              <div className="review-row" key={item.id}>
                <span className="review-row__target" title={item.target}>{item.target}</span>
                <span className="review-row__delta">{item.summary}</span>
                {onReviewChanges && (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={onReviewChanges}>
                    审查
                  </button>
                )}
              </div>
            ))
          )}
        </section>
      )}
      {workspaceLabel && (
        <section className="project-overview__section" aria-label="最近打开">
          <div className="welcome-quick__label">最近打开</div>
          {recentFiles.length === 0 ? (
            <p className="empty-hint welcome-empty">暂无最近打开。从顶部工作域进入资源，或按 Ctrl K 搜索。</p>
          ) : (
            <div className="welcome-quick__grid">
              {recentFiles.map((file) => (
                <button
                  type="button"
                  key={file.sourceUri}
                  className="quick-item"
                  onClick={() => onSelectFile?.(file.sourceUri)}
                >
                  <span className="quick-item__body">
                    <span className="quick-item__name">{file.relativePath}</span>
                    <span className="quick-item__desc">{file.resourceKind} · {file.formatLabel}</span>
                  </span>
                  <span className="quick-item__ext">{file.formatLabel}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {browserPreview && (
        <p className="runtime-notice" role="note">浏览器预览只展示界面；打开目录与写入功能需在 SoulForge 桌面版完成。</p>
      )}
    </section>
  );
}

