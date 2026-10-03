import type { ReactElement, ReactNode } from 'react';
import { ChangeQueuePanel } from '../staging/ChangeQueuePanel.js';
import { WorkbenchOpsPanel } from '../editors/WorkbenchOpsPanel.js';
import { operationStatusLabel, shortenPath } from '../format/uiText.js';
import type { ChangeOperationsController } from './useChangeOperationsController.js';
import type { ResourceDocumentController } from './useResourceDocumentController.js';
import type { NavigationController } from './useNavigationController.js';

export function ChangeOperationsSidebarViews({ operations, sidebarView, hasWorkspace: workspace, closeButton }: {
  operations: Pick<ChangeOperationsController, 'pendingChangeCount' | 'changeState' | 'approveChange' | 'rejectChange' | 'undoChangeToDraft' | 'discardChange' | 'clearTerminalChanges' | 'commitStagedChanges' | 'operationHistory' | 'rollbackInFlight' | 'rollbackOp' | 'rollbackFileOp' | 'refreshOperationHistory'>;
  sidebarView: NavigationController['sidebarView']; hasWorkspace: boolean; closeButton: ReactNode;
}): ReactElement {
  const { pendingChangeCount, changeState, approveChange, rejectChange, undoChangeToDraft, discardChange, clearTerminalChanges, commitStagedChanges, operationHistory, rollbackInFlight, rollbackOp, rollbackFileOp, refreshOperationHistory } = operations;
  return <>
<section className={sidebarView === 'staging' ? 'panel is-active' : 'panel'} data-panel-id="staging" aria-label="暂存区">
            <div className="panel__header">
              <h2 className="panel__title">暂存区</h2>
              <span className={pendingChangeCount > 0 ? 'pill pill--warn' : 'pill'}>
                {pendingChangeCount > 0 ? `${pendingChangeCount} 项待处理` : '暂存为空'}
              </span>
              {closeButton}
            </div>
            <div className="panel__body panel__body--pad">
              <ChangeQueuePanel
                state={changeState}
                actions={{
                  approve: (id) => { approveChange(id); },
                  reject: (id) => { rejectChange(id); },
                  undoToDraft: (id) => { undoChangeToDraft(id); },
                  discard: (id) => { discardChange(id); },
                  clearTerminal: () => { clearTerminalChanges(); },
                  commit: () => { void commitStagedChanges(); }
                }}
              />
            </div>
          </section>
<section className={sidebarView === 'audit' ? 'panel is-active' : 'panel'} data-panel-id="audit" aria-label="审计与回滚">
            <div className="panel__header">
              <h2 className="panel__title">审计与回滚</h2>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!workspace} onClick={() => void refreshOperationHistory()}>
                刷新
              </button>
              {closeButton}
            </div>
            <div className="panel__body panel__body--pad">
              {!workspace && <p className="empty-hint">打开工作区并完成至少一次补丁提交后可在此回滚。</p>}
              {workspace && operationHistory.length === 0 && (
                <p className="empty-hint">尚无已记录操作。写入暂存变更后会记录到持久操作日志。</p>
              )}
              <div className="audit-timeline">
                {operationHistory.map((entry) => (
                  <div
                    key={entry.opId}
                    className={
                      entry.status === 'rolled_back'
                        ? 'audit-entry audit-entry--rollback'
                        : entry.status === 'failed'
                          ? 'audit-entry audit-entry--failed'
                          : 'audit-entry audit-entry--commit'
                    }
                  >
                    <div className="audit-entry__title">{entry.title}</div>
                    <div className="audit-entry__meta">
                      <span className={`op-status op-status-${entry.status}`}>{operationStatusLabel(entry.status)}</span>
                      <span>{entry.fileCount} 个文件 · {entry.committedAt ?? entry.createdAt}</span>
                    </div>
                    <div className="audit-entry__meta" title={entry.changedPaths.join('\n')}>
                      <span>
                        {entry.changedPaths[0] ? shortenPath(entry.changedPaths[0]) : '—'}
                        {entry.changedPaths.length > 1 ? ` +${entry.changedPaths.length - 1}` : ''}
                      </span>
                    </div>
                    {entry.status === 'committed' && (
                      <div className="audit-entry__actions">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={rollbackInFlight === `operation:${entry.opId}`}
                          onClick={() => void rollbackOp(entry.opId)}
                        >
                          {rollbackInFlight === `operation:${entry.opId}` ? '回滚中…' : '回滚'}
                        </button>
                        <details className="audit-entry__files">
                          <summary>文件级回滚（{entry.fileCount}）</summary>
                          {entry.changedPaths.map((path) => (
                            <div key={`${entry.opId}:${path}`} className="audit-entry__file">
                              <span className="audit-entry__file-path" title={path}>{shortenPath(path)}</span>
                              {path === '[本机路径已隐藏]' ? null : (
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--sm"
                                  disabled={rollbackInFlight === `file:${entry.opId}:${path}`}
                                  onClick={() => void rollbackFileOp(entry.opId, path)}
                                >
                                  {rollbackInFlight === `file:${entry.opId}:${path}` ? '回滚中…' : '回滚此文件'}
                                </button>
                              )}
                            </div>
                          ))}
                        </details>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </section>
  </>;
}

export function OperationsWorkbenchView({ operations, preview, onCancelJob }: {
  operations: Pick<ChangeOperationsController, 'operationHistory' | 'rollbackInFlight' | 'rollbackOp'>;
  preview: ResourceDocumentController['preview']; onCancelJob(): void;
}): ReactElement {
  const { operationHistory, rollbackInFlight, rollbackOp } = operations;
  return <WorkbenchOpsPanel
              jobs={[]}
              history={operationHistory.map((entry) => ({
                opId: entry.opId,
                status: entry.status,
                mode: entry.mode,
                summary: entry.title,
                createdAt: entry.createdAt,
                fileCount: entry.fileCount,
                canRollback: entry.status === 'committed'
              }))}
              rollbackBusyOpId={rollbackInFlight?.startsWith('operation:')
                ? rollbackInFlight.slice('operation:'.length)
                : null}
              diagnostics={(preview?.diagnostics ?? []).map((d) => ({
                severity: d.severity,
                code: d.code,
                message: d.message,
                ...(d.sourceUri ? { resourceUri: d.sourceUri } : {})
              }))}
              patchImpact={null}
              onCancelJob={onCancelJob}
              onRollback={(opId) => { void rollbackOp(opId); }}
            />;
}
