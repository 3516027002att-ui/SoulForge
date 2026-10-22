import type { ReactElement, ReactNode } from 'react';
import { DomainLibraryList } from '../navigation/DomainLibraryList.js';
import { domainLabel } from '../navigation/domainNavigation.js';
import { formatFilesCount } from '../format/uiText.js';
import type { RendererWorkspaceScanResult } from '../../../main/ipc.js';
import type { NavigationController } from './useNavigationController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { ShellInteractionController } from './useShellInteractionController.js';

export interface NavigationSidebarViewsProps {
  navigation: Pick<NavigationController, 'sidebarView' | 'activeDomain' | 'query' | 'setQuery'
    | 'physicalBrowseFiles' | 'domainLibraries' | 'domainGroups' | 'indexedFiles' | 'searchHits' | 'search'>;
  resource: Pick<ResourceDocumentController, 'selectedFile' | 'selectFile'>;
  workspace: Pick<RendererWorkspaceScanResult, 'workspaceSessionId'> | null;
  isBrowserPreview: boolean;
  closeButton: ReactNode;
  searchInputRef: ShellInteractionController['searchInputRef'];
}

/** Existing navigation facts and commands only; document and shell owners retain their lifecycle. */
export function NavigationSidebarViews({ navigation, resource, workspace, isBrowserPreview, closeButton,
  searchInputRef }: NavigationSidebarViewsProps): ReactElement {
  const { sidebarView, activeDomain, query, setQuery, physicalBrowseFiles, domainLibraries, domainGroups,
    indexedFiles, searchHits, search } = navigation;
  const { selectedFile, selectFile } = resource;
  return (
    <>
          <section className={sidebarView === 'explorer' ? 'panel is-active' : 'panel'} data-panel-id="explorer" aria-label="资源浏览器">
            <div className="panel__header">
              <h2 className="panel__title">资源浏览器</h2>
              {/* SHELL-09：数量只在 Files 物理浏览内出现且带语义单位（§3.3）；
                 语义领域不显示任何文件数。12-E：语义领域不再拼「XX 逻辑库」，
                 hint 为空时不渲染空 span；project 的「开始」按问题 6 处理。 */}
              {activeDomain === 'files' ? (
                <span className="panel__hint">
                  {formatFilesCount(physicalBrowseFiles.length)}
                </span>
              ) : activeDomain === 'project' ? (
                <span className="panel__hint">开始</span>
              ) : null}
              {closeButton}
            </div>
            <div className="panel__body panel__body--pad">
              {isBrowserPreview && (
                <div className="runtime-notice" role="note">
                  浏览器预览：文件系统功能仅在 SoulForge 桌面版可用
                </div>
              )}
              {activeDomain === 'files' ? (
                <>
                  <div className="search-box">
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="过滤路径 / 类型"
                      aria-label="过滤资源列表"
                    />
                  </div>
                  {/* SHELL-09：物理 taxonomy 只出现在 Files 领域（§16 resourceFamilies
                      从领域栏 production 依赖中移除）。资源族过滤条已断开：Files 物理
                      浏览由搜索框（路径/类型子串）+ .file-list 承载。显示不设限：
                      过滤后的完整集合一次 map，由 .file-list 自身滚动。 */}
                  <div className="file-list">
                    {physicalBrowseFiles.map((file) => (
                      <button
                        type="button"
                        key={file.sourceUri}
                        className={selectedFile?.sourceUri === file.sourceUri ? 'file-item selected' : 'file-item'}
                        onClick={() => void selectFile(file)}
                      >
                        <span className="file-item__name">{file.relativePath}</span>
                        <small className="file-item__meta">{file.resourceKind} | {file.formatLabel} | {(file.size / 1024).toFixed(1)} KB</small>
                      </button>
                    ))}
                    {physicalBrowseFiles.length === 0 && (
                      <p className="empty-hint">当前目录没有匹配资源。可切换到 all 或调整路径过滤。</p>
                    )}
                  </div>
                </>
              ) : activeDomain === 'project' ? (
                /* 开始态侧栏已拆。有工作区后点「开始」只折资源栏、不把
                   activeDomain 写成 project，所以这段只在无工作区的首次冷启动
                   命中——中央 StartWorkspacePanel 是大入口，侧栏只留一行引导文案。
                   暂存区 / 审计与回滚入口在活动栏 ab-item，搜索走 Ctrl+K。 */
                <p className="empty-hint">
                  打开 Mod 工作区后，这里会列出该领域的可打开资源。
                </p>
              ) : (
                <DomainLibraryList
                  files={domainLibraries}
                  {...(domainGroups ? { groups: domainGroups } : {})}
                  selectedUri={selectedFile?.sourceUri ?? null}
                  emptyHint={
                    workspace
                      ? `${domainLabel(activeDomain)} 工作区里还没有可打开的文件。可到「文件」领域按路径浏览。`
                      : '打开 Mod 工作区后，这里会列出该领域可打开的资源。'
                  }
                  onSelect={(file) => {
                    const match = indexedFiles.find((item) => item.sourceUri === file.sourceUri);
                    if (match) void selectFile(match);
                  }}
                />
              )}
            </div>
          </section>

          {/* ── 搜索 ── */}
          <section className={sidebarView === 'search' ? 'panel is-active' : 'panel'} data-panel-id="search" aria-label="搜索">
            <div className="panel__header">
              <h2 className="panel__title">搜索</h2>
              {closeButton}
            </div>
            <div className="panel__body panel__body--pad">
              <div className="search-box search-box--with-action">
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void search();
                    }
                  }}
                  placeholder="在资源中搜索…"
                  autoComplete="off"
                  aria-label="在资源中搜索"
                />
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void search()}>搜索</button>
              </div>
              <div className="search-results">
                {query.trim() === '' && (
                  <p className="empty-hint">输入关键字，按路径 / 类型检索工作区资源；回车调用资源搜索。</p>
                )}
                {query.trim() !== '' && searchHits.length === 0 && <p className="empty-hint">无匹配结果。</p>}
                {query.trim() !== '' && searchHits.map((file) => (
                  <button type="button" key={file.sourceUri} className="search-hit" onClick={() => void selectFile(file)}>
                    <div className="search-hit__path">{file.relativePath}</div>
                    <div className="search-hit__line">{file.resourceKind} · {file.formatLabel} · {(file.size / 1024).toFixed(1)} KB</div>
                  </button>
                ))}
              </div>
            </div>
          </section>
    </>
  );
}
