import type { Dispatch, ReactElement, SetStateAction } from 'react';
import type { WorkspaceController } from './useWorkspaceController.js';
import type { ChangeOperationsController } from './useChangeOperationsController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { NavigationController } from './useNavigationController.js';

export interface WorkspaceSummaryViewProps {
  workspace: Pick<WorkspaceController, 'workspace' | 'sessionMeta'>;
  operations: Pick<ChangeOperationsController, 'draftChanges' | 'lastOperation'>;
  document: Pick<ResourceDocumentController, 'openTabs' | 'selectFile'>;
  navigation: Pick<NavigationController, 'showSidebarView'>;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  showEditorWelcome: boolean;
  welcomeStats: string;
  iconUrl: string;
}

export function WorkspaceSummaryView({ workspace: owner, operations, document, navigation,
  setSidebarCollapsed, showEditorWelcome, welcomeStats, iconUrl: SOULFORGE_ICON_URL }: WorkspaceSummaryViewProps): ReactElement {
  const { workspace, sessionMeta } = owner;
  const { draftChanges, lastOperation } = operations;
  const { openTabs, selectFile } = document;
  const { showSidebarView } = navigation;
  return (
            <div className={`editor-welcome${showEditorWelcome ? '' : ' is-hidden'}`}>
              <div className="welcome">
                <div className="welcome__head">
                  <img src={SOULFORGE_ICON_URL} width="26" height="26" className="welcome-mark" alt="" aria-hidden="true" />
                  <h1>SoulForge</h1>
                  <span className="welcome__ws">{workspace?.workspaceLabel ?? '未打开工作区'} · {sessionMeta?.game ?? 'sekiro'}</span>
                </div>
                <p className="welcome__stats">{welcomeStats}</p>

                <section className="welcome__section" aria-label="待审查变更">
                  <div className="welcome-quick__label">待审查变更</div>
                  {draftChanges.length === 0 ? (
                    <p className="empty-hint welcome-empty">没有待审查的变更。</p>
                  ) : (
                    draftChanges.map((item) => (
                        <div className="review-row" key={item.id}>
                          <span className="review-row__target" title={item.sourceUri}>{item.target}</span>
                          <span className="review-row__delta">{item.summary}</span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => {
                              setSidebarCollapsed(false);
                              showSidebarView('staging');
                            }}
                          >
                            审查
                          </button>
                        </div>
                      ))
                  )}
                </section>

                <section className="welcome__section" aria-label="最近打开">
                  <div className="welcome-quick__label">最近打开</div>
                  {openTabs.length === 0 ? (
                    <p className="empty-hint welcome-empty">暂无最近打开。从左侧资源树选择资源，或按 Ctrl K 搜索。</p>
                  ) : (
                    <div className="welcome-quick__grid">
                      {openTabs.slice(-6).reverse().map((tab) => (
                        <button type="button" key={tab.sourceUri} className="quick-item" onClick={() => void selectFile(tab)}>
                          <span className="quick-item__body">
                            <span className="quick-item__name">{tab.relativePath}</span>
                            <span className="quick-item__desc">{tab.resourceKind} · {tab.formatLabel}</span>
                          </span>
                          <span className="quick-item__ext">{tab.formatLabel}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>

                <div className="welcome-meta">
                  <span>
                    {lastOperation
                      ? `最近写入 ${lastOperation.title} · ${lastOperation.committedAt ?? lastOperation.createdAt}`
                      : '本工作区尚无写入记录'}
                  </span>
                  <div className="welcome-shortcuts">
                    <span><kbd>Ctrl K</kbd> 命令面板</span>
                    <span><kbd>Ctrl J</kbd> AI Agent</span>
                    <span><kbd>Ctrl B</kbd> 侧栏</span>
                  </div>
                </div>
              </div>
            </div>
  );
}
