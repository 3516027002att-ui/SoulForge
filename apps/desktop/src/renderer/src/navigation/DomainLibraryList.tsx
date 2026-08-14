import { useState, type ReactElement } from 'react';
import { libraryDisplayName, type DomainLibraryGroup } from './domainLibraries.js';

export interface DomainLibraryItem {
  sourceUri: string;
  relativePath: string;
  resourceKind: string;
  formatLabel: string;
}

export interface DomainLibraryListProps {
  files: readonly DomainLibraryItem[];
  /**
   * 分组形态（R1 裁定后的参数域两级列表）：组标题常驻，组内文件在组展开后
   * 显示；GPARAM 组默认折叠，点开才出现各 bank 子选项。传了 groups 时 files
   * 不再单独平铺渲染。
   */
  groups?: readonly DomainLibraryGroup<DomainLibraryItem>[];
  selectedUri: string | null;
  emptyHint: string;
  onSelect: (file: DomainLibraryItem) => void;
}

/** 渲染单个逻辑库项（平铺与分组共用同一行形态）。 */
function LibraryRow({
  file,
  selected,
  onSelect
}: {
  file: DomainLibraryItem;
  selected: boolean;
  onSelect: (file: DomainLibraryItem) => void;
}): ReactElement {
  return (
    <button
      key={file.sourceUri}
      type="button"
      role="listitem"
      className={selected ? 'library-item is-selected' : 'library-item'}
      title={file.relativePath}
      onClick={() => onSelect(file)}
    >
      <span className="library-item__name">{libraryDisplayName(file.relativePath)}</span>
      <small className="library-item__meta">{file.formatLabel} · {file.relativePath}</small>
    </button>
  );
}

/**
 * 语义领域侧栏：逻辑库列表。
 * 不用 .file-item —— 那个 class 是 Files 物理浏览的契约钩子。
 *
 * 分组形态：组标题是常驻的两级入口（如参数域的 PARAM / GPARAM），点击组标题
 * 展开/收起组内项；GPARAM 这类组默认折叠，点开才显示各 bank。
 */
export function DomainLibraryList({
  files,
  groups,
  selectedUri,
  emptyHint,
  onSelect
}: DomainLibraryListProps): ReactElement {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const hasAnyContent = groups
    ? groups.some((group) => group.files.length > 0)
    : files.length > 0;
  if (!hasAnyContent) {
    return (
      <div className="domain-browse-placeholder" data-testid="domain-browse-placeholder">
        <p>{emptyHint}</p>
      </div>
    );
  }

  // 平铺形态（text/event/map 等未分组域）。
  if (!groups || groups.length === 0) {
    return (
      <div className="library-list" data-testid="domain-library-list" role="list">
        {files.map((file) => (
          <LibraryRow
            key={file.sourceUri}
            file={file}
            selected={file.sourceUri === selectedUri}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="library-list library-list--grouped" data-testid="domain-library-list" role="list">
      {groups.map((group) => {
        // 未记录过展开状态时按 defaultCollapsed 取默认（组件挂载早于分组 props
        // 传入，useState 初始值算不到组；用 ?? 兜底避免 GPARAM 组意外展开）。
        const open = openGroups[group.id] ?? (group.defaultCollapsed !== true);
        return (
          <div key={group.id} className="library-group" role="listitem">
            <button
              type="button"
              className="library-group__header"
              aria-expanded={open}
              aria-controls={`library-group-${group.id}`}
              onClick={() => setOpenGroups((current) => ({ ...current, [group.id]: !open }))}
              title={open ? `收起 ${group.label}` : `展开 ${group.label}`}
            >
              <svg
                className="library-group__chevron"
                viewBox="0 0 12 12"
                width="10"
                height="10"
                aria-hidden="true"
              >
                <path d="M3 3l4 3-4 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="library-group__label">{group.label}</span>
              {group.hint && <small className="library-group__hint">{group.hint}</small>}
            </button>
            {open && (
              <div className="library-group__body" id={`library-group-${group.id}`}>
                {group.files.length === 0 ? (
                  <p className="empty-hint library-group__empty">暂无</p>
                ) : (
                  group.files.map((file) => (
                    <LibraryRow
                      key={file.sourceUri}
                      file={file}
                      selected={file.sourceUri === selectedUri}
                      onSelect={onSelect}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
