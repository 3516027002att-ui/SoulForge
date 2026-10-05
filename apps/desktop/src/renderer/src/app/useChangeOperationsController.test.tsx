import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { RendererPatchHistoryEntry, RendererSaveResult } from '../../../main/rendererDto.js';
import type { CandidateChange, ProposeInput } from '../staging/changeControl.js';
import { useChangeOperationsController, type ChangeOperationsController, type ChangeOperationsOptions } from './useChangeOperationsController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => { while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const receipt: RendererSaveResult = { ok: true, changedFiles: ['resource://mod-a/item'], diagnostics: [],
  opId: 'native-committed', sourceHash: 'native-new-hash', sourceRevision: 7 };
function history(opId: string): RendererPatchHistoryEntry[] {
  return [{ opId, title: opId, author: 'user', mode: 'normal', status: 'committed', createdAt: 'now', fileCount: 1, changedPaths: ['resource://mod-a/item'] }];
}
function candidate(kind: ProposeInput['kind'] = 'text', target = 'item'): ProposeInput {
  return { kind, sourceUri: 'resource://mod-a/item', target, summary: 'old → new', oldValue: 'old', newValue: 'new',
    payload: kind === 'fmg' ? { op: 'upsert', id: 8, text: 'new', tableId: 'opaque-native-table' }
      : kind === 'param-row' ? { op: 'upsert', id: 9, dataBase64: 'AQID' }
      : kind === 'param-field' ? { rowId: 9, identity: { rowIndex: 13, id: 9, dataHash: 'physical-row-hash' },
        fieldId: 'field.native', value: 0, rowDataBase64: 'AQID', definition: { type: 'u8', native: true } }
      : {} };
}
function staged(input = candidate()): CandidateChange {
  return { ...input, id: `${input.kind}:${input.sourceUri}:${input.target}`, status: 'staged', diagnostics: [], createdAt: 1, updatedAt: 1 };
}
function ports() {
  const statuses: string[] = [], toasts: Array<[string, 'ok' | 'warn' | undefined]> = [], announcements: string[] = [];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const options: ChangeOperationsOptions = {
    bridge: {
      listOperations: async () => { calls.push({ name: 'history', args: [] }); return history('native-committed'); },
      rollbackOperation: async (...args) => { calls.push({ name: 'rollback', args }); return { ok: true, opId: args[0], restoredFiles: ['resource://mod-a/item'], diagnostics: [] }; },
      rollbackFile: async (...args) => { calls.push({ name: 'rollback-file', args }); return { ok: true, opId: args[0], restoredFiles: ['resource://mod-a/item'], diagnostics: [] }; },
      applyParamMutation: async (...args) => { calls.push({ name: 'param-row', args }); return receipt; }
    }, workspace: { workspaceSessionId: 'workspace-a' }, selectedFile: { sourceUri: 'resource://mod-a/item' },
    editDirty: false, fmgSourceHash: 'native-fmg-hash', paramSourceHash: 'native-param-hash',
    applyTextResourceAndReload: async (...args) => { calls.push({ name: 'text', args }); return receipt; },
    applyFmgMutationAndReload: async (...args) => { calls.push({ name: 'fmg', args }); return receipt; },
    applyParamFieldMutationFromPanel: async input => { calls.push({ name: 'param-field', args: [input] }); return receipt; },
    reloadParamRowsFromSource: async () => { calls.push({ name: 'param-reload', args: [] }); },
    onRollbackCommitted: async () => { calls.push({ name: 'resource-reload', args: [] }); },
    setStatus: value => statuses.push(value), pushToast: (message, kind) => toasts.push([message, kind]),
    announceDesktopOnly: operation => announcements.push(operation), describeBridgeAbsence: operation => `missing:${operation}`
  };
  return { options, calls, statuses, toasts, announcements };
}
async function mount(options: ChangeOperationsOptions, strict = false) {
  let current!: ChangeOperationsController;
  function Host({ options }: { options: ChangeOperationsOptions }) {
    current = useChangeOperationsController(options);
    return <span>{current.pendingChangeCount}:{current.rollbackInFlight}:{current.operationHistory[0]?.opId}</span>;
  }
  const element = (value: ChangeOperationsOptions) => strict ? <React.StrictMode><Host options={value} /></React.StrictMode> : <Host options={value} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); }); mounted.push(renderer);
  return { current: () => current, update: async (value: ChangeOperationsOptions) => act(async () => renderer.update(element(value))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); },
    propose: async (input = candidate()) => { let item!: CandidateChange | null; await act(async () => { item = current.proposeChange(input); }); return item!; },
    stage: async (input = candidate()) => { let item!: CandidateChange | null; await act(async () => { item = current.proposeChange(input); if (item) current.approveChange(item.id); }); return item!; }
  };
}

it('actual store commands and derived counts keep failed drafts pending without calling native writes', async () => {
  const p = ports(), h = await mount(p.options), first = await h.propose(), second = await h.stage(candidate('fmg', 'entry'));
  assert.equal(h.current().pendingChangeCount, 2); assert.equal(h.current().hasUncommittedChanges, true);
  assert.deepEqual(h.current().draftChanges.map(item => item.id), [first.id]);
  await act(async () => h.current().undoChangeToDraft(second.id)); assert.equal(h.current().draftChanges.length, 2);
  await act(async () => h.current().rejectChange(first.id)); assert.equal(h.current().pendingChangeCount, 1);
  await act(async () => h.current().discardChange(second.id)); assert.equal(h.current().hasUncommittedChanges, false);
  await act(async () => h.current().clearTerminalChanges()); assert.deepEqual(h.current().changeState.items, []);
  assert.deepEqual(p.calls, []);
  await h.update({ ...p.options, editDirty: true }); assert.equal(h.current().hasUncommittedChanges, true);
});
it('serializes history reads and publishes only the newest requested snapshot', async () => {
  const p = ports(), first = deferred<RendererPatchHistoryEntry[]>(), second = deferred<RendererPatchHistoryEntry[]>(); let reads = 0;
  p.options.bridge!.listOperations = () => { p.calls.push({ name: 'history', args: [] }); return ++reads === 1 ? first.promise : second.promise; };
  const h = await mount(p.options); let a!: ReturnType<ChangeOperationsController['refreshOperationHistory']>, b!: ReturnType<ChangeOperationsController['refreshOperationHistory']>;
  await act(async () => { a = h.current().refreshOperationHistory(); b = h.current().refreshOperationHistory(); });
  assert.equal(reads, 1);
  await act(async () => { first.resolve(history('old')); await a; }); assert.deepEqual(h.current().operationHistory, []); assert.equal(reads, 2);
  await act(async () => { second.resolve(history('new')); await b; }); assert.equal(h.current().lastOperation?.opId, 'new');
});
it('history failures settle and the next serialized refresh still works', async () => {
  const p = ports(), h = await mount(p.options); p.options.bridge!.listOperations = async () => { throw new Error('journal unavailable'); };
  await act(async () => h.current().refreshOperationHistory());
  assert.equal(p.statuses.at(-1), '历史刷新失败：journal unavailable'); assert.deepEqual(p.toasts.at(-1), ['历史刷新失败：journal unavailable', 'warn']);
  p.options.bridge!.listOperations = async () => history('recovered'); await act(async () => h.current().refreshOperationHistory());
  assert.equal(h.current().lastOperation?.opId, 'recovered');
});
it('old history continuations cannot publish after workspace reset, replacement bridge or disposal', async () => {
  for (const boundary of ['workspace', 'reset', 'bridge', 'unmount'] as const) {
    const p = ports(), read = deferred<RendererPatchHistoryEntry[]>(), h = await mount(p.options);
    p.options.bridge!.listOperations = () => read.promise; let loading!: ReturnType<ChangeOperationsController['refreshOperationHistory']>;
    await act(async () => { loading = h.current().refreshOperationHistory(); });
    if (boundary === 'workspace') await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
    else if (boundary === 'reset') await act(async () => h.current().resetChangeWorkspaceState());
    else if (boundary === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else await h.unmount();
    const statusCount = p.statuses.length;
    await act(async () => { read.resolve(history('old-workspace')); await loading; });
    assert.deepEqual(h.current().operationHistory, []); assert.equal(p.statuses.length, statusCount);
  }
});
it('routes every native kind with exact logical source hash table physical row field and byte payload', async () => {
  const p = ports(), h = await mount(p.options);
  for (const kind of ['text', 'fmg', 'param-row', 'param-field'] as const) {
    const input = staged(candidate(kind)); let result!: Awaited<ReturnType<ChangeOperationsController['applyStagedChange']>>;
    await act(async () => { result = await h.current().applyStagedChange(input); });
    assert.equal(result.ok, true); assert.equal(result.opId, receipt.opId); assert.deepEqual(result.changedFiles, receipt.changedFiles);
  }
  assert.deepEqual(p.calls, [
    { name: 'text', args: ['resource://mod-a/item', 'new'] },
    { name: 'fmg', args: ['resource://mod-a/item', 'native-fmg-hash', { kind: 'upsert', id: 8, text: 'new' }, 'opaque-native-table'] },
    { name: 'param-row', args: ['resource://mod-a/item', 'native-param-hash', { kind: 'upsert', id: 9, dataBase64: 'AQID' }] },
    { name: 'param-reload', args: [] }, { name: 'param-field', args: [candidate('param-field').payload] }
  ]);
});
it('routes delete payloads without manufacturing text or bytes and passes empty hashes through to main', async () => {
  const p = ports(), h = await mount({ ...p.options, fmgSourceHash: null, paramSourceHash: null });
  await act(async () => { await h.current().applyStagedChange(staged({ ...candidate('fmg'), payload: { op: 'delete', id: 0, tableId: 'opaque-delete' } }));
    await h.current().applyStagedChange(staged({ ...candidate('param-row'), payload: { op: 'delete', id: 0 } })); });
  assert.deepEqual(p.calls[0], { name: 'fmg', args: ['resource://mod-a/item', '', { kind: 'delete', id: 0 }, 'opaque-delete'] });
  assert.deepEqual(p.calls[1], { name: 'param-row', args: ['resource://mod-a/item', '', { kind: 'delete', id: 0 }] });
});
it('param row routing preserves original native args and ignores extra payload properties', async () => {
  const p = ports(), h = await mount(p.options), input = candidate('param-row');
  input.payload.rowIndex = 13; input.payload.expectedDataHash = 'native-row-proof';
  await act(async () => h.current().applyStagedChange(staged(input)));
  assert.deepEqual(p.calls[0], { name: 'param-row', args: ['resource://mod-a/item', 'native-param-hash', {
    kind: 'upsert', id: 9, dataBase64: 'AQID' }] });
});
it('native confirmation requirements and semantic convergence facts survive the staging adapter unchanged', async () => {
  const p = ports(), outcome: RendererSaveResult = { ...receipt, ok: false, requiresConfirmation: true,
    knowledgeRefresh: { status: 'preserved', semanticState: 'preserved', changedSourceCount: 0, invalidatedSourceCount: 0, removedSemanticCount: 0 },
    diagnostics: [{ severity: 'warning', code: 'NATIVE_CONFIRMATION_REQUIRED', message: '请确认原生风险说明' }] };
  p.options.applyTextResourceAndReload = async () => outcome;
  const h = await mount(p.options); let result!: Awaited<ReturnType<ChangeOperationsController['applyStagedChange']>>;
  await act(async () => { result = await h.current().applyStagedChange(staged()); });
  assert.equal(result.ok, false); assert.equal(result.requiresConfirmation, true); assert.equal(result.knowledgeRefresh, outcome.knowledgeRefresh);
  assert.equal(result.opId, outcome.opId); assert.equal(result.diagnostics?.[0]?.message, outcome.diagnostics[0]!.message);
});
it('preserves native confirmation cancellation and failure diagnostics without projection reads or replay', async () => {
  const p = ports(), h = await mount(p.options), cancelled = { ok: false, changedFiles: [], diagnostics: [{ severity: 'warning' as const, code: 'CONFIRMATION_CANCELLED', message: '用户取消写入；原文件未改动。' }] };
  p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return cancelled; };
  await h.stage(); await act(async () => h.current().commitStagedChanges());
  assert.equal(h.current().changeState.items[0]?.status, 'failed'); assert.deepEqual(h.current().changeState.items[0]?.diagnostics, [{ code: 'CONFIRMATION_CANCELLED', message: cancelled.diagnostics[0]!.message }]);
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1); assert.equal(p.calls.some(call => /reload/.test(call.name)), false);
  await act(async () => h.current().commitStagedChanges()); assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
});
it('validates the real staged queue before any bridge dispatch', async () => {
  const p = ports(), h = await mount(p.options); await h.stage({ ...candidate('fmg'), payload: { op: 'upsert', id: 1.5, text: 'new' } });
  await act(async () => h.current().commitStagedChanges());
  assert.equal(h.current().changeState.items[0]?.status, 'failed'); assert.equal(h.current().changeState.items[0]?.diagnostics[0]?.code, 'FMG_ID_INVALID');
  assert.deepEqual(p.calls.map(call => call.name), ['history']); assert.equal(h.current().pendingChangeCount, 1); assert.equal(h.current().hasUncommittedChanges, false);
});
it('preserves true committed receipts when param readback fails and reports a warning', async () => {
  const p = ports(); p.options.reloadParamRowsFromSource = async () => { throw new Error('readback offline'); };
  const h = await mount(p.options);
  let result!: Awaited<ReturnType<ChangeOperationsController['applyStagedChange']>>;
  await act(async () => { result = await h.current().applyStagedChange(staged(candidate('param-row'))); });
  assert.equal(result.ok, true); assert.equal(result.opId, receipt.opId); assert.equal(result.sourceHash, receipt.sourceHash);
  assert.equal(result.diagnostics?.at(-1)?.code, 'POSTCOMMIT_PARAM_RELOAD_FAILED'); assert.equal(p.calls.filter(call => call.name === 'param-row').length, 1);
});
it('duplicate commit callbacks cannot replay already writing or written changes', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return write.promise; };
  const h = await mount(p.options); await h.stage(); let committing!: Promise<void>;
  await act(async () => { committing = h.current().commitStagedChanges(); }); assert.equal(h.current().changeState.committing, true);
  await act(async () => h.current().commitStagedChanges()); assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
  await act(async () => { write.resolve(receipt); await committing; }); assert.equal(h.current().changeState.items[0]?.status, 'written');
  await act(async () => h.current().commitStagedChanges()); assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
  assert.equal(p.toasts.some(([message]) => message === '写入完成：1 项已写入，原文件已备份，可回滚'), true);
});
it('workspace switching detaches staged old targets before committing against the next Mod', async () => {
  const p = ports(), h = await mount(p.options); await h.stage();
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' }, selectedFile: { sourceUri: 'resource://mod-b/item' } });
  await act(async () => h.current().commitStagedChanges());
  assert.equal(p.calls.filter(call => call.name === 'text').length, 0); assert.deepEqual(h.current().changeState.items, []);
});
it('workspace reset invalidates retained propose apply commit and rollback callbacks before rerender', async () => {
  const p = ports(), h = await mount(p.options), old = h.current(); await h.stage();
  await act(async () => { old.resetChangeWorkspaceState(); old.proposeChange(candidate('text', 'late')); await old.applyStagedChange(staged()); await old.commitStagedChanges(); await old.rollbackOp('old-op'); });
  assert.deepEqual(p.calls, []); assert.deepEqual(h.current().changeState.items, []);
});
it('workspace switching during a dispatched native write preserves its receipt and detaches only the unstarted queue tail', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return write.promise; };
  const h = await mount(p.options), first = await h.stage(candidate('text', 'already-dispatched')); await h.stage(candidate('text', 'not-started'));
  let committing!: Promise<void>; await act(async () => { committing = h.current().commitStagedChanges(); });
  assert.equal(h.current().changeState.items.find(item => item.id === first.id)?.status, 'writing');
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } }); const statuses = p.statuses.length;
  await act(async () => { write.resolve(receipt); await committing; });
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1); assert.equal(h.current().changeState.items.length, 1);
  assert.equal(h.current().changeState.items[0]?.status, 'written'); assert.equal(h.current().changeState.items[0]?.id, first.id); assert.equal(p.statuses.length, statuses);
});
it('retained queue commands after workspace replacement cannot inject another old target', async () => {
  const p = ports(), h = await mount(p.options), old = h.current(); await h.stage();
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  await act(async () => { old.proposeChange(candidate()); old.approveChange(staged().id); await old.applyStagedChange(staged()); await old.rollbackFileOp('old-op', 'resource://mod-a/item'); });
  assert.deepEqual(h.current().changeState.items, []); assert.deepEqual(p.calls, []);
});
it('retained committed facts cannot be reopened by old or new workspace undo approve apply and commit commands', async () => {
  const p = ports(), h = await mount(p.options), item = await h.stage();
  await act(async () => h.current().commitStagedChanges()); const old = h.current();
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } }); const count = p.calls.length;
  await act(async () => {
    old.undoChangeToDraft(item.id); old.approveChange(item.id); await old.commitStagedChanges();
    h.current().undoChangeToDraft(item.id); h.current().approveChange(item.id);
    await h.current().applyStagedChange(h.current().changeState.items[0]!); await h.current().commitStagedChanges();
  });
  assert.equal(h.current().changeState.items[0]?.status, 'written');
  assert.equal(p.calls.slice(count).some(call => call.name === 'text'), false);
});
it('new workspace cannot collide with an old dispatched target and overwrite its settling receipt', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return write.promise; };
  const h = await mount(p.options); await h.stage(); let committing!: Promise<void>;
  await act(async () => { committing = h.current().commitStagedChanges(); });
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  let next!: CandidateChange | null;
  await act(async () => { next = h.current().proposeChange(candidate()); }); assert.equal(next, null);
  await act(async () => { write.resolve(receipt); await committing; });
  assert.equal(h.current().changeState.items.length, 1); assert.equal(h.current().changeState.items[0]?.status, 'written');
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
});
it('late failed native receipt remains a fact that the next workspace cannot approve and retry', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return write.promise; };
  const h = await mount(p.options), item = await h.stage(); let committing!: Promise<void>;
  await act(async () => { committing = h.current().commitStagedChanges(); });
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  await act(async () => { write.resolve({ ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'NATIVE_UNRESOLVED', message: 'Check the existing operation journal before another attempt' }] }); await committing; });
  await act(async () => { h.current().approveChange(item.id); h.current().undoChangeToDraft(item.id); await h.current().commitStagedChanges(); });
  assert.equal(h.current().changeState.items[0]?.status, 'failed'); assert.equal(h.current().changeState.items[0]?.diagnostics[0]?.code, 'NATIVE_UNRESOLVED');
  assert.equal(h.current().pendingChangeCount, 0); assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
});
it('already returned native failure remains owned by its original workspace while unstarted validation failure detaches', async () => {
  const p = ports(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return {
    ok: false, changedFiles: [], opId: 'native-failed-attempt', diagnostics: [{ severity: 'error', code: 'NATIVE_UNRESOLVED', message: 'Lookup native journal before retry' }] }; };
  const h = await mount(p.options), native = await h.stage(), invalid = await h.stage({ ...candidate('fmg', 'validation-only'), payload: { op: 'upsert', id: -1, text: 'new' } });
  await act(async () => h.current().commitStagedChanges());
  assert.equal(h.current().changeState.items.length, 2);
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  assert.equal(h.current().changeState.items.length, 1); assert.equal(h.current().changeState.items[0]?.id, native.id);
  assert.equal(h.current().changeState.items.some(item => item.id === invalid.id), false);
  await act(async () => { h.current().approveChange(native.id); await h.current().commitStagedChanges(); });
  assert.equal(h.current().changeState.items[0]?.diagnostics[0]?.code, 'NATIVE_UNRESOLVED');
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
});
it('detached old snapshot IDs cannot be reused by a new workspace until its native batch has settled', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.applyTextResourceAndReload = async (...args) => { p.calls.push({ name: 'text', args }); return write.promise; };
  const h = await mount(p.options); await h.stage(candidate('text', 'dispatched')); await h.stage(candidate('text', 'tail'));
  let committing!: Promise<void>; await act(async () => { committing = h.current().commitStagedChanges(); });
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } }); let next!: CandidateChange | null;
  await act(async () => { next = h.current().proposeChange(candidate('text', 'tail')); }); assert.equal(next, null);
  await act(async () => { write.resolve(receipt); await committing; });
  await act(async () => { next = h.current().proposeChange(candidate('text', 'tail')); }); assert.notEqual(next, null);
  assert.equal(h.current().changeState.items.find(item => item.target === 'tail')?.status, 'draft');
});
it('a committed batch keeps written state and warns when journal projection refresh fails', async () => {
  const p = ports(); p.options.bridge!.listOperations = async () => { throw new Error('journal projection offline'); };
  const h = await mount(p.options); await h.stage(); await act(async () => h.current().commitStagedChanges());
  assert.equal(h.current().changeState.items[0]?.status, 'written');
  assert.deepEqual(p.toasts.at(-1), ['已写入，但操作历史刷新失败：journal projection offline', 'warn']);
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1);
});
it('selection switching during param row commit keeps its native facts and skips the old document readback', async () => {
  const p = ports(), write = deferred<RendererSaveResult>(); p.options.bridge!.applyParamMutation = async (...args) => { p.calls.push({ name: 'param-row', args }); return write.promise; };
  const h = await mount(p.options); let applying!: ReturnType<ChangeOperationsController['applyStagedChange']>;
  await act(async () => { applying = h.current().applyStagedChange(staged(candidate('param-row'))); });
  await h.update({ ...p.options, selectedFile: { sourceUri: 'resource://mod-a/other' } });
  await act(async () => { write.resolve(receipt); assert.equal((await applying).opId, receipt.opId); });
  assert.deepEqual(p.calls.map(call => call.name), ['param-row']);
});
it('rollback uses one lock across operation and file commands and refreshes history before selected resource reload', async () => {
  const p = ports(), rollback = deferred<Awaited<ReturnType<NonNullable<ChangeOperationsOptions['bridge']>['rollbackOperation']>>>();
  p.options.bridge!.rollbackOperation = async (...args) => { p.calls.push({ name: 'rollback', args }); return rollback.promise; };
  const h = await mount(p.options); let rolling!: Promise<void>;
  await act(async () => { rolling = h.current().rollbackOp('native-operation-full-id'); }); assert.equal(h.current().rollbackInFlight, 'operation:native-operation-full-id');
  await act(async () => h.current().rollbackFileOp('other-op', 'resource://mod-a/other'));
  assert.deepEqual(p.toasts.at(-1), ['已有回滚正在处理中，请等待当前操作完成。', 'warn']);
  await act(async () => { rollback.resolve({ ok: true, opId: 'native-operation-full-id', restoredFiles: ['one', 'two'], diagnostics: [] }); await rolling; });
  assert.deepEqual(p.calls.map(call => call.name), ['rollback', 'history', 'resource-reload']); assert.equal(h.current().rollbackInFlight, null);
  assert.deepEqual(p.calls[0]?.args, ['native-operation-full-id']); assert.equal(p.statuses.at(-1), '已回滚 2 个文件');
  await act(async () => h.current().rollbackFileOp('exact-op', 'resource://mod-a/exact-target'));
  assert.deepEqual(p.calls.at(-3), { name: 'rollback-file', args: ['exact-op', 'resource://mod-a/exact-target'] });
  assert.equal(p.toasts.at(-1)?.[0], '已回滚文件（1 个）');
});
it('failed and cancelled rollback refreshes journal without reloading or retrying its native command', async () => {
  const p = ports(), h = await mount(p.options); p.options.bridge!.rollbackOperation = async (...args) => { p.calls.push({ name: 'rollback', args }); return { ok: false, opId: args[0], restoredFiles: [], diagnostics: [{ severity: 'warning', code: 'CANCELLED', message: '用户取消回滚' }] }; };
  await act(async () => h.current().rollbackOp('native-op'));
  assert.deepEqual(p.calls.map(call => call.name), ['rollback', 'history']); assert.equal(p.toasts.at(-1)?.[0], '回滚失败：用户取消回滚'); assert.equal(h.current().rollbackInFlight, null);
});
it('committed rollback readback failure keeps the restore fact and does not replay it', async () => {
  const p = ports(), h = await mount(p.options); p.options.onRollbackCommitted = async () => { throw new Error('resource readback offline'); };
  await act(async () => h.current().rollbackFileOp('native-op', 'resource://mod-a/item'));
  assert.equal(p.calls.filter(call => call.name === 'rollback-file').length, 1); assert.equal(p.toasts.at(-1)?.[0], '文件已回滚，但资源界面重载失败：resource readback offline');
  assert.equal(h.current().rollbackInFlight, null);
});
it('workspace switch while rollback is dispatched retains the busy lock until receipt settles and suppresses old projection work', async () => {
  const p = ports(), rollback = deferred<Awaited<ReturnType<NonNullable<ChangeOperationsOptions['bridge']>['rollbackOperation']>>>();
  p.options.bridge!.rollbackOperation = async (...args) => { p.calls.push({ name: 'rollback', args }); return rollback.promise; };
  const h = await mount(p.options); let rolling!: Promise<void>; await act(async () => { rolling = h.current().rollbackOp('old-native-op'); });
  await h.update({ ...p.options, workspace: { workspaceSessionId: 'workspace-b' } });
  assert.equal(h.current().rollbackInFlight, 'operation:old-native-op');
  await act(async () => h.current().rollbackOp('new-op'));
  const statuses = p.statuses.length;
  await act(async () => { rollback.resolve({ ok: true, opId: 'old-native-op', restoredFiles: ['resource://mod-a/item'], diagnostics: [] }); await rolling; });
  assert.deepEqual(p.calls.map(call => call.name), ['rollback']); assert.equal(p.statuses.length, statuses); assert.equal(h.current().rollbackInFlight, null);
});
it('bridge absence and missing file rollback preserve desktop-only messages with no writes', async () => {
  const p = ports(), h = await mount({ ...p.options, bridge: null }); let result!: Awaited<ReturnType<ChangeOperationsController['applyStagedChange']>>;
  await act(async () => { result = await h.current().applyStagedChange(staged()); await h.current().rollbackOp('op'); await h.current().rollbackFileOp('op', 'logical'); });
  assert.equal(result.diagnostics?.[0]?.message, 'missing:写入暂存变更'); assert.deepEqual(p.announcements, ['回滚操作', '文件回滚']);
  assert.deepEqual(p.calls, []); assert.equal(h.current().rollbackInFlight, null);
});
it('missing preload file rollback settles its lock with the existing warning and no native dispatch', async () => {
  const p = ports(); delete (p.options.bridge as Partial<NonNullable<ChangeOperationsOptions['bridge']>>).rollbackFile;
  const h = await mount(p.options); await act(async () => h.current().rollbackFileOp('op', 'resource://mod-a/item'));
  assert.deepEqual(p.toasts.at(-1), ['当前预加载未暴露文件级回滚。', 'warn']);
  assert.equal(h.current().rollbackInFlight, null); assert.deepEqual(p.calls, []);
});
it('strict lifecycle replay creates no native operation or history command', async () => {
  const p = ports(), h = await mount(p.options, true); await h.stage(); await act(async () => h.current().commitStagedChanges());
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1); assert.equal(h.current().changeState.items[0]?.status, 'written');
  await h.unmount(); const old = h.current(); await old.applyStagedChange(staged()); await old.rollbackOp('after-disposal'); await old.refreshOperationHistory();
  assert.equal(p.calls.filter(call => call.name === 'text').length, 1); assert.equal(p.calls.some(call => call.name === 'rollback'), false);
});

it('workspace installation reset clears displayed history and rejects a pending old snapshot', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().refreshOperationHistory());
  assert.equal(h.current().operationHistory[0]?.opId, 'native-committed');
  const old = deferred<RendererPatchHistoryEntry[]>();
  p.options.bridge!.listOperations = () => old.promise;
  let reading!: ReturnType<ChangeOperationsController['refreshOperationHistory']>;
  await act(async () => { reading = h.current().refreshOperationHistory(); });
  await act(async () => h.current().resetChangeWorkspaceState());
  assert.deepEqual(h.current().operationHistory, [], 'Original workspace installation clears the displayed history');
  await act(async () => { old.resolve(history('old')); await reading; });
  assert.deepEqual(h.current().operationHistory, []);
});

for (const phase of ['writing', 'written'] as const) {
  it(`same-target new draft stays separate from a ${phase} receipt and commits only after its own approval`, async () => {
    const p = ports(), firstWrite = deferred<RendererSaveResult>(), writes: string[] = [];
    p.options.applyTextResourceAndReload = async (_uri, text) => { writes.push(text); return writes.length === 1 ? firstWrite.promise : receipt; };
    const h = await mount(p.options), first = await h.stage();
    let committing!: Promise<void>;
    await act(async () => { committing = h.current().commitStagedChanges(); });
    if (phase === 'written') await act(async () => { firstWrite.resolve(receipt); await committing; });
    const second = await h.propose({ ...candidate(), newValue: 'newer draft' });
    assert.notEqual(second.id, first.id, 'A new proposal must not share the native writer/receipt identity');
    const updated = await h.propose({ ...candidate(), newValue: 'latest draft' });
    assert.equal(updated.id, second.id, 'Unsubmitted edits replace the one pending candidate');
    assert.equal(h.current().changeState.items.length, 2);
    if (phase === 'writing') await act(async () => { firstWrite.resolve(receipt); await committing; });
    assert.equal(h.current().changeState.items.find(item => item.id === first.id)?.status, 'written');
    assert.equal(h.current().changeState.items.find(item => item.id === second.id)?.status, 'draft');
    assert.deepEqual(writes, ['new']);
    await act(async () => h.current().approveChange(second.id));
    await act(async () => h.current().commitStagedChanges());
    assert.deepEqual(writes, ['new', 'latest draft']);
    assert.deepEqual(h.current().changeState.items.map(item => item.status), ['written', 'written']);
  });
}

it('actual history read refusal returns a typed failure while obsolete reads stay silent and the next refresh recovers', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.listOperations = async () => { throw new Error('owned history failure'); };
  let outcome!: Awaited<ReturnType<ChangeOperationsController['refreshOperationHistory']>>;
  await act(async () => { outcome = await h.current().refreshOperationHistory(); });
  assert.deepEqual(outcome, { ok: false });
  assert.deepEqual(p.toasts.at(-1), ['历史刷新失败：owned history failure', 'warn']);
  p.options.bridge!.listOperations = async () => history('recovered');
  await act(async () => { outcome = await h.current().refreshOperationHistory(); });
  assert.equal(outcome, undefined); assert.equal(h.current().lastOperation?.opId, 'recovered');
  const late = deferred<RendererPatchHistoryEntry[]>(); p.options.bridge!.listOperations = () => late.promise;
  let pending!: ReturnType<ChangeOperationsController['refreshOperationHistory']>;
  await act(async () => { pending = h.current().refreshOperationHistory(); });
  await act(async () => h.current().resetChangeWorkspaceState()); const count = p.toasts.length;
  await act(async () => { late.reject(new Error('obsolete history failure')); outcome = await pending; });
  assert.equal(outcome, undefined); assert.equal(p.toasts.length, count);
});

it('a typed PARAM readback failure remains a committed staged result with a warning', async () => {
  const p = ports(); p.options.reloadParamRowsFromSource = async () => ({ ok: false, diagnostics: [{ severity: 'error', code: 'OWNED_READBACK', message: 'synthetic failure' }] });
  const h = await mount(p.options), item = await h.stage(candidate('param-row'));
  await act(async () => h.current().commitStagedChanges());
  assert.equal(h.current().changeState.items.find(i => i.id === item.id)?.status, 'written');
  assert.equal(h.current().changeState.items.find(i => i.id === item.id)?.diagnostics.at(-1)?.code, 'POSTCOMMIT_PARAM_RELOAD_FAILED');
  assert.equal(p.calls.filter(c => c.name === 'param-row').length, 1);
  assert.deepEqual(p.toasts.at(-1), ['PARAM 已保存，但文档重读失败。', 'warn']);
});
