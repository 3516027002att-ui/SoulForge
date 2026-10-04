import assert from 'node:assert/strict';
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { it } from 'node:test';
import { ChangeOperationsSidebarViews, OperationsWorkbenchView } from './ChangeOperationsViews.js';
import { ChangeQueuePanel } from '../staging/ChangeQueuePanel.js';
import { WorkbenchOpsPanel } from '../editors/WorkbenchOpsPanel.js';
function elements(node: ReactNode): ReactElement[] {
  const all: ReactElement[] = []; Children.forEach(node, child => { if (isValidElement<{children?:ReactNode}>(child)) { all.push(child); all.push(...elements(child.props.children)); } }); return all;
}
function ports() {
  const calls: unknown[] = [];
  const operations: ComponentProps<typeof ChangeOperationsSidebarViews>['operations'] = {
    pendingChangeCount: 0, changeState: { items: [], committing: false }, operationHistory: [], rollbackInFlight: null,
    approveChange: id => { calls.push(['approve', id]); return true; }, rejectChange: id => { calls.push(['reject', id]); return true; },
    undoChangeToDraft: id => { calls.push(['undo', id]); return true; }, discardChange: id => { calls.push(['discard', id]); },
    clearTerminalChanges: () => { calls.push(['clear']); }, commitStagedChanges: async () => { calls.push(['commit']); },
    refreshOperationHistory: async () => { calls.push(['history']); }, rollbackOp: async id => { calls.push(['rollback', id]); },
    rollbackFileOp: async (id, file) => { calls.push(['file', id, file]); }
  };
  return { operations, calls };
}
it('staging forwards actual owner state and every command without creating another store', async () => {
  const p = ports(), element = ChangeOperationsSidebarViews({ operations: p.operations, sidebarView: 'staging', hasWorkspace: true, closeButton: <button>close</button> });
  const queue = elements(element).find(node => node.type === ChangeQueuePanel); assert.ok(queue && isValidElement<ComponentProps<typeof ChangeQueuePanel>>(queue));
  assert.equal(queue.props.state, p.operations.changeState);
  queue.props.actions.approve('one'); queue.props.actions.reject('two'); queue.props.actions.undoToDraft('three'); queue.props.actions.discard('four'); queue.props.actions.clearTerminal(); await queue.props.actions.commit();
  assert.deepEqual(p.calls, [['approve','one'],['reject','two'],['undo','three'],['discard','four'],['clear'],['commit']]);
});
it('audit keeps per-entry busy locks, hides private paths and forwards native rollback identifiers', async () => {
  const p = ports(); p.operations.operationHistory = [{ opId: 'owned-op', title: 'Owned operation', mode: 'normal', status: 'committed',
    author: 'user', createdAt: 'owned-time', fileCount: 2, changedPaths: ['resource://owned/file', '[本机路径已隐藏]'] }];
  p.operations.rollbackInFlight = 'operation:owned-op';
  const props: ComponentProps<typeof ChangeOperationsSidebarViews> = { operations: p.operations, sidebarView: 'audit', hasWorkspace: true, closeButton: null };
  const html = renderToStaticMarkup(<ChangeOperationsSidebarViews {...props} />); assert.match(html, /Owned operation/); assert.match(html, /回滚中…/); assert.match(html, /文件级回滚/);
  const buttons = elements(ChangeOperationsSidebarViews(props)).filter(n => n.type === 'button');
  const rollback = buttons.find(n => isValidElement<{disabled?:boolean;children?:ReactNode}>(n) && n.props.disabled && n.props.children === '回滚中…');
  assert.ok(rollback && isValidElement<{onClick():void}>(rollback)); await rollback.props.onClick();
  const file = buttons.find(n => isValidElement<{children?:ReactNode}>(n) && n.props.children === '回滚此文件');
  assert.ok(file && isValidElement<{onClick():void}>(file)); await file.props.onClick();
  assert.equal(buttons.filter(n => isValidElement<{children?:ReactNode}>(n) && n.props.children === '回滚此文件').length, 1);
  assert.deepEqual(p.calls, [['rollback','owned-op'],['file','owned-op','resource://owned/file']]);
});
it('operations workbench projects logical receipts and keeps diagnostics/source identities and callback behavior', async () => {
  const p = ports(); p.operations.operationHistory = [{ opId: 'owned-op', title: 'Owned operation', mode: 'normal', status: 'committed',
    author: 'user', createdAt: 'owned-time', fileCount: 1, changedPaths: ['resource://owned/file'] }];
  p.operations.rollbackInFlight = 'operation:owned-op'; const cancel = () => { p.calls.push(['cancel']); };
  const element = OperationsWorkbenchView({ operations: p.operations, preview: null, onCancelJob: cancel });
  assert.ok(isValidElement<ComponentProps<typeof WorkbenchOpsPanel>>(element)); assert.equal(element.type, WorkbenchOpsPanel);
  assert.deepEqual(element.props.history, [{ opId:'owned-op', status:'committed', mode:'normal', summary:'Owned operation', createdAt:'owned-time', fileCount:1, canRollback:true }]);
  assert.equal(element.props.rollbackBusyOpId, 'owned-op'); assert.deepEqual(element.props.jobs, []); assert.deepEqual(element.props.diagnostics, []);
  assert.equal(element.props.onCancelJob, cancel); await element.props.onRollback?.('owned-op'); assert.deepEqual(p.calls, [['rollback','owned-op']]);
});
it('partial rollback keeps only the remaining file actionable and preserves the original audit paths', async () => {
  const p = ports();
  p.operations.operationHistory = [{ opId: 'owned-op', title: 'Two-file operation', mode: 'normal', status: 'committed',
    author: 'user', createdAt: 'owned-time', fileCount: 2, changedPaths: ['file://first.txt', 'file://second.txt'],
    partialRollback: { rolledBackPaths: ['file://first.txt'] } }];
  const props: ComponentProps<typeof ChangeOperationsSidebarViews> = { operations: p.operations, sidebarView: 'audit', hasWorkspace: true, closeButton: null };
  const html = renderToStaticMarkup(<ChangeOperationsSidebarViews {...props} />);
  assert.match(html, /部分回滚/); assert.match(html, /已回滚/);
  assert.match(html, /无法再整项回滚。请回滚剩余文件/);
  assert.match(html, /file:\/\/first.txt/); assert.match(html, /file:\/\/second.txt/);
  const buttons = elements(ChangeOperationsSidebarViews(props)).filter(n => n.type === 'button');
  assert.equal(buttons.length, 2, 'refresh and remaining-file rollback only; whole-operation and restored-file controls stay hidden');
  assert.ok(isValidElement<{onClick():void}>(buttons[1]));
  await buttons[1].props.onClick();
  assert.deepEqual(p.calls, [['file', 'owned-op', 'file://second.txt']]);
});
it('operations workbench does not offer a whole rollback after a partial inverse', () => {
  const p = ports();
  p.operations.operationHistory = [{ opId: 'owned-op', title: 'Partial operation', mode: 'normal', status: 'committed',
    author: 'user', createdAt: 'owned-time', fileCount: 2, changedPaths: ['file://first.txt', 'file://second.txt'],
    partialRollback: { rolledBackPaths: ['file://first.txt'] } }];
  const element = OperationsWorkbenchView({ operations: p.operations, preview: null, onCancelJob() {} });
  assert.ok(isValidElement<ComponentProps<typeof WorkbenchOpsPanel>>(element));
  const entry = element.props.history[0]; assert.ok(entry);
  assert.equal(entry.canRollback, false);
  assert.match(entry.summary, /请在审计面板回滚剩余文件/);
});
