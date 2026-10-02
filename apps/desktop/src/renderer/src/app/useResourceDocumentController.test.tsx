import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { RendererIndexedFile, RendererResourcePreview, RendererSaveResult } from '../../../main/rendererDto.js';
import { useResourceDocumentController, type ResourceDocumentController, type ResourceDocumentOptions, type ResourceNativeReadResult } from './useResourceDocumentController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => { while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name: string, extension = 'txt'): RendererIndexedFile {
  return { sourceUri: `resource://owned/${name}.${extension}`, game: 'sekiro', resourceKind: 'other', parseStatus: 'parsed',
    diagnostics: [], relativePath: `owned/${name}.${extension}`, extension: `.${extension}`, compoundExtension: `.${extension}`,
    formatKind: extension === 'txt' ? 'text' : 'unknown',
    formatLabel: extension, size: 80, mtimeMs: 1 };
}
function opened(target: RendererIndexedFile, text = `text-${target.relativePath}`): RendererResourcePreview {
  return { file: target, previewKind: 'text', text, truncated: false, bytesRead: 80, diagnostics: [],
    structuredPreview: { status: 'parsed', kind: 'other', parser: 'owned', summary: '', editable: true, diagnostics: [] } };
}
const receipt: RendererSaveResult = { ok: true, changedFiles: ['resource://owned/a.txt'], diagnostics: [],
  opId: 'native-committed', sourceHash: 'committed-source-hash', sourceRevision: 3 };
function ports() {
  const previews: string[] = [], nativeReads: Array<[string, string]> = [], textWrites: Array<[string, string]> = [], flverWrites: unknown[][] = [];
  const statuses: string[] = [], toasts: Array<[string, 'ok' | 'warn' | undefined]> = [];
  let histories = 0, selections = 0;
  const options: ResourceDocumentOptions = { bridge: {
    openResourcePreview: async source => { previews.push(source); const name = source.split('/').at(-1)!; const dot = name.lastIndexOf('.'); return opened(file(name.slice(0, dot), name.slice(dot + 1))); },
    saveTextResource: async (source, text) => { textWrites.push([source, text]); return receipt; },
    readTaeDocument: async source => { nativeReads.push(['tae', source]); return { ok: true, data: { format: 'TAE', sourceHash: `hash-${source}` } }; },
    readEsdDocument: async source => { nativeReads.push(['esd', source]); return { ok: true, data: { format: 'ESD', sourceHash: `hash-${source}` } }; },
    readFlverDocument: async source => { nativeReads.push(['flver', source]); return { ok: true, data: { format: 'FLVER', sourceHash: `hash-${source}` } }; },
    applyFlverMutation: async (...args) => { flverWrites.push(args); return receipt; }
  }, setStatus: value => statuses.push(value), pushToast: (text, kind) => toasts.push([text, kind]),
  refreshOperationHistory: async () => { histories++; }, describeBridgeAbsence: operation => `missing:${operation}`,
  onSelectionActivated: () => { selections++; } };
  return { options, previews, nativeReads, textWrites, flverWrites, statuses, toasts, histories: () => histories, selections: () => selections };
}
async function mount(options: ResourceDocumentOptions, registryResets = true, strict = false) {
  let current!: ResourceDocumentController;
  function Host({ options }: { options: ResourceDocumentOptions }) {
    current = useResourceDocumentController({ ...options, onSelectionActivated: () => {
      options.onSelectionActivated();
      if (registryResets) { current.resetTaeDocument(); current.resetEsdDocument(); current.resetFlverDocument(); }
    } });
    return <span>{current.selectedFile?.sourceUri}:{current.editText}</span>;
  }
  const element = (value: ResourceDocumentOptions) => strict ? <React.StrictMode><Host options={value} /></React.StrictMode> : <Host options={value} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); }); mounted.push(renderer);
  return { current: () => current, update: async (value: ResourceDocumentOptions) => act(async () => renderer.update(element(value))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); },
    select: async (target: RendererIndexedFile) => act(async () => current.selectFile(target)) };
}
function assertPlainEmpty(value: ResourceDocumentController) {
  assert.equal(value.preview, null); assert.equal(value.editText, ''); assert.equal(value.lastSavedText, '');
  assert.deepEqual(value.msgRows, []); assert.deepEqual(value.saveDiagnostics, []);
}

it('selection reads own the generation after synchronous registry resets and keep exact text bytes', async () => {
  const p = ports(), h = await mount(p.options), target = file('a'), text = '\ufeffraw\r\n\t終\u0000';
  p.options.bridge!.openResourcePreview = async source => { p.previews.push(source); return opened(target, text); };
  await h.select(target);
  assert.equal(h.current().selectedFile, target); assert.equal(h.current().preview?.text, text);
  assert.equal(h.current().editText, text); assert.equal(h.current().lastSavedText, text);
  assert.deepEqual(h.current().openTabs, [target]); assert.deepEqual(p.previews, [target.sourceUri]);
  assert.equal(p.selections(), 1); assert.equal(h.current().canEditText, true); assert.equal(h.current().editDirty, false);
});
it('late old preview success cannot replace a newer selection or dispatch its native read', async () => {
  const p = ports(), h = await mount(p.options), old = deferred<RendererResourcePreview | null>(), a = file('a', 'tae'), b = file('b');
  p.options.bridge!.openResourcePreview = source => { p.previews.push(source); return source === a.sourceUri ? old.promise : Promise.resolve(opened(b)); };
  let opening!: Promise<void>; await act(async () => { opening = h.current().selectFile(a); });
  await h.select(b); const statuses = p.statuses.length;
  await act(async () => { old.resolve(opened(a)); await opening; });
  assert.equal(h.current().preview?.file.sourceUri, b.sourceUri); assert.equal(h.current().editText, opened(b).text);
  assert.equal(p.statuses.length, statuses); assert.deepEqual(p.nativeReads, []);
});
it('obsolete preview rejection settles quietly after selection, workspace reset, bridge replacement or disposal', async () => {
  for (const change of ['selection', 'workspace', 'bridge', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options), old = deferred<RendererResourcePreview | null>();
    p.options.bridge!.openResourcePreview = () => old.promise;
    let opening!: Promise<void>; await act(async () => { opening = h.current().selectFile(file('a')); });
    if (change === 'selection') await act(async () => h.current().switchToOpenTab(file('a')));
    else if (change === 'workspace') await act(async () => h.current().resetWorkspaceDocuments());
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else await h.unmount();
    const statuses = p.statuses.length;
    await act(async () => { old.reject(new Error('obsolete preview')); await opening; });
    assert.equal(p.statuses.length, statuses);
  }
});
it('late native TAE, ESD and FLVER reads cannot publish after a new selection', async () => {
  for (const kind of ['tae', 'esd', 'flver'] as const) {
    const p = ports(), h = await mount(p.options), old = deferred<ResourceNativeReadResult>(), target = file('a', kind);
    p.options.bridge![kind === 'tae' ? 'readTaeDocument' : kind === 'esd' ? 'readEsdDocument' : 'readFlverDocument'] = () => old.promise;
    let opening!: Promise<void>; await act(async () => { opening = h.current().selectFile(target); });
    await h.select(file('b')); const statuses = p.statuses.length;
    await act(async () => { old.resolve({ ok: true, data: { sourceHash: 'obsolete', format: kind } }); await opening; });
    assert.equal(h.current()[kind === 'tae' ? 'taeData' : kind === 'esd' ? 'esdData' : 'flverData'], null);
    assert.equal(p.statuses.length, statuses);
  }
});
it('each concrete native reset invalidates its awaited read before rerender and does not reopen selection', async () => {
  for (const kind of ['tae', 'esd', 'flver'] as const) {
    const p = ports(), h = await mount(p.options), old = deferred<ResourceNativeReadResult>();
    p.options.bridge![kind === 'tae' ? 'readTaeDocument' : kind === 'esd' ? 'readEsdDocument' : 'readFlverDocument'] = () => old.promise;
    let opening!: Promise<void>; await act(async () => { opening = h.current().selectFile(file('a', kind)); });
    const reset = h.current()[kind === 'tae' ? 'resetTaeDocument' : kind === 'esd' ? 'resetEsdDocument' : 'resetFlverDocument'];
    const statuses = p.statuses.length;
    await act(async () => { reset(); old.resolve({ ok: true, data: { format: 'obsolete' } }); await opening; });
    assert.equal(h.current()[kind === 'tae' ? 'taeData' : kind === 'esd' ? 'esdData' : 'flverData'], null);
    assert.equal(p.statuses.length, statuses); assert.equal(p.previews.length, 1);
    assert.equal(h.current()[kind === 'tae' ? 'resetTaeDocument' : kind === 'esd' ? 'resetEsdDocument' : 'resetFlverDocument'], reset);
  }
});
it('TAE failures retain the original native diagnostics and fallback projection', async () => {
  for (const throws of [false, true]) {
    const p = ports(), h = await mount(p.options), diagnostic = { severity: 'error' as const, code: 'NATIVE_TAE', message: 'native tae failure' };
    p.options.bridge!.readTaeDocument = async () => { if (throws) throw new Error('native thrown failure'); return { ok: false, diagnostics: [diagnostic] }; };
    await h.select(file('a', 'tae'));
    assert.equal(h.current().taeData?.format, 'TAE_READ_FAILED');
    assert.deepEqual(h.current().taeData?.diagnostics, [throws ? { severity: 'error', code: 'TAE_READ_FAILED', message: 'native thrown failure' } : diagnostic]);
  }
});
it('native routing forwards only the selected logical URI and does not add page options', async () => {
  for (const extension of ['tae', 'esd', 'flver'] as const) {
    const p = ports(), h = await mount(p.options), target = file('a', extension);
    await h.select(target); assert.deepEqual(p.nativeReads, [[extension, target.sourceUri]]);
    assert.equal(h.current()[extension === 'tae' ? 'taeData' : extension === 'esd' ? 'esdData' : 'flverData']?.sourceHash, `hash-${target.sourceUri}`);
  }
});
it('tab switching uses existing tabs without opening previews and closing selection opens the last fallback once', async () => {
  const p = ports(), h = await mount(p.options), a = file('a'), b = file('b');
  await h.select(a); await h.select(b); await h.select(a);
  assert.deepEqual(h.current().openTabs, [a, b]);
  await act(async () => h.current().switchToOpenTab(b)); assertPlainEmpty(h.current()); assert.equal(p.previews.length, 3);
  await act(async () => h.current().switchToOpenTab(file('unopened'))); assert.equal(h.current().selectedFile, b);
  await act(async () => h.current().closeTab(b)); assert.equal(h.current().selectedFile, a); assert.equal(p.previews.length, 4);
  await act(async () => h.current().closeTab(a)); assert.equal(h.current().selectedFile, null); assert.equal(h.current().preview, null); assert.deepEqual(h.current().openTabs, []);
});
it('preview clearing and shell deselection retain the existing draft while invalidating late reads', async () => {
  const p = ports(), h = await mount(p.options); await h.select(file('a'));
  await act(async () => h.current().setEditText('retained draft'));
  await act(async () => h.current().clearResourcePreview()); assert.equal(h.current().selectedFile?.sourceUri, file('a').sourceUri); assert.equal(h.current().editText, 'retained draft');
  await act(async () => h.current().clearResourceSelection()); assert.equal(h.current().selectedFile, null); assert.equal(h.current().editText, 'retained draft');
  await act(async () => h.current().resetWorkspaceDocuments()); assertPlainEmpty(h.current()); assert.deepEqual(h.current().openTabs, []);
});
it('message row helpers retain original ID/category and TSV escaping behavior', async () => {
  const p = ports(), h = await mount(p.options), target = file('a'), value = opened(target);
  value.structuredPreview!.msgs = [{ category: 'owned category', entries: [{ textId: 7, text: 'original' }] } as never];
  p.options.bridge!.openResourcePreview = async () => value; await h.select(target);
  assert.equal(h.current().hasMsgTable, true);
  await act(async () => h.current().updateMsgRow(0, { text: 'a\r\nb\tc' })); assert.equal(h.current().editText, '7\ta\\nb c\n');
  await act(async () => h.current().addMsgRow()); assert.deepEqual(h.current().msgRows[1], { textId: '8', text: '', category: 'owned category' });
  await act(async () => h.current().removeMsgRow(0)); assert.equal(h.current().editText, '8\t\n');
});
it('plain save forwards exact text bytes once and retains the native committed receipt', async () => {
  const p = ports(), h = await mount(p.options), target = file('a'), text = '\ufeffdraft\r\n\t終\u0000';
  await h.select(target); await act(async () => h.current().setEditText(text));
  p.options.bridge!.openResourcePreview = async source => { p.previews.push(source); return opened(target, text); };
  let result!: RendererSaveResult | null; await act(async () => { result = await h.current().saveCurrentText(); });
  assert.equal(result, receipt); assert.deepEqual(p.textWrites, [[target.sourceUri, text]]); assert.equal(p.previews.length, 2); assert.equal(p.histories(), 1);
  assert.equal(h.current().editDirty, false); assert.equal(p.statuses.at(-1), '已保存。'); assert.deepEqual(p.toasts, [['已保存', undefined]]);
});
it('late plain-save readback cannot replace another selection and keeps the true committed receipt', async () => {
  const p = ports(), h = await mount(p.options), old = deferred<RendererResourcePreview | null>(), a = file('a'), b = file('b');
  await h.select(a); await act(async () => h.current().setEditText('committed a'));
  p.options.bridge!.openResourcePreview = source => { p.previews.push(source); return source === a.sourceUri ? old.promise : Promise.resolve(opened(b)); };
  let saving!: ReturnType<ResourceDocumentController['saveCurrentText']>; await act(async () => { saving = h.current().saveCurrentText(); });
  await h.select(b); const feedback = p.statuses.length;
  await act(async () => { old.resolve(opened(a, 'committed a')); assert.equal(await saving, receipt); });
  assert.equal(h.current().preview?.file.sourceUri, b.sourceUri); assert.equal(h.current().lastSavedText, opened(b).text);
  assert.equal(p.textWrites.length, 1); assert.equal(p.histories(), 0); assert.equal(p.statuses.length, feedback); assert.deepEqual(p.toasts, []);
});
it('pending native plain commit stays committed after workspace reset and starts no stale readback', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<RendererSaveResult>(); await h.select(file('a'));
  p.options.bridge!.saveTextResource = (source, text) => { p.textWrites.push([source, text]); return pending.promise; };
  let saving!: ReturnType<ResourceDocumentController['saveCurrentText']>; await act(async () => { saving = h.current().saveCurrentText(); });
  await act(async () => h.current().resetWorkspaceDocuments());
  await act(async () => { pending.resolve(receipt); assert.equal(await saving, receipt); });
  assertPlainEmpty(h.current()); assert.equal(p.textWrites.length, 1); assert.equal(p.previews.length, 1); assert.equal(p.histories(), 0); assert.deepEqual(p.toasts, []);
});
it('retained plain save, staged text, FLVER and editor callbacks cannot start submissions after selection or reset', async () => {
  for (const change of ['selection', 'reset'] as const) {
    const p = ports(), h = await mount(p.options); await h.select(file('a', 'flver'));
    const old = h.current();
    if (change === 'selection') await h.select(file('b')); else await act(async () => h.current().resetWorkspaceDocuments());
    const text = h.current().editText;
    await act(async () => {
      assert.equal(await old.saveCurrentText(), null);
      assert.equal((await old.applyTextResourceAndReload(file('a').sourceUri, 'old bytes')).ok, false);
      assert.equal(await old.applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh-old', materialStableId: 'material-old' }), null);
      old.setEditText('old edit'); old.addMsgRow(); old.updateMsgRow(0, { text: 'old row' }); old.removeMsgRow(0);
    });
    assert.equal(p.textWrites.length, 0); assert.equal(p.flverWrites.length, 0); assert.equal(h.current().editText, text);
  }
});
it('retained native submit callbacks dispatch no write after their original selection is replaced', async () => {
  const p = ports(), h = await mount(p.options); await h.select(file('a', 'flver'));
  const save = h.current().saveCurrentText, flver = h.current().applyFlverMaterialSlotSetAndReload;
  await h.select(file('b'));
  await act(async () => { await save(); await flver({ meshStableId: 'old-mesh', materialStableId: 'old-material' }); });
  assert.equal(p.textWrites.length, 0); assert.equal(p.flverWrites.length, 0);
  assert.equal(h.current().preview?.file.sourceUri, file('b').sourceUri);
});
it('returning to the same URI does not revive an earlier document submit or edit callback', async () => {
  const p = ports(), h = await mount(p.options), target = file('a'); await h.select(target);
  const old = h.current(); await h.select(file('b')); await h.select(target);
  await act(async () => { old.setEditText('obsolete same URI'); await old.saveCurrentText(); });
  assert.equal(p.textWrites.length, 0); assert.equal(h.current().editText, opened(target).text);
});
it('committed plain writes survive preview rejection or history failure with original operation facts and no replay', async () => {
  for (const failure of ['preview', 'history'] as const) {
    const p = ports(), h = await mount(p.options); await h.select(file('a'));
    if (failure === 'preview') p.options.bridge!.openResourcePreview = async () => { throw new Error('postcommit projection failure'); };
    else { p.options.refreshOperationHistory = async () => { throw new Error('postcommit history failure'); }; await h.update(p.options); }
    let result!: RendererSaveResult | null; await act(async () => { result = await h.current().saveCurrentText(); });
    assert.equal(result?.ok, true); assert.equal(result?.opId, receipt.opId); assert.equal(result?.sourceHash, receipt.sourceHash); assert.equal(result?.sourceRevision, receipt.sourceRevision);
    assert.deepEqual(result?.changedFiles, receipt.changedFiles); assert.equal(result?.diagnostics.at(-1)?.code, failure === 'preview' ? 'POSTCOMMIT_TEXT_PREVIEW_FAILED' : 'POSTCOMMIT_TEXT_HISTORY_FAILED');
    assert.equal(p.textWrites.length, 1); assert.equal(p.toasts.at(-1)?.[1], 'warn');
  }
});
it('a staged offscreen text target preserves its URI/bytes and never publishes into current selection', async () => {
  const p = ports(), h = await mount(p.options); await h.select(file('a'));
  let result!: RendererSaveResult; await act(async () => { result = await h.current().applyTextResourceAndReload(file('b').sourceUri, 'b\r\nbytes'); });
  assert.equal(result, receipt); assert.deepEqual(p.textWrites, [[file('b').sourceUri, 'b\r\nbytes']]); assert.equal(p.previews.length, 1);
  assert.equal(h.current().preview?.file.sourceUri, file('a').sourceUri);
});
it('staged native text rejection and thrown error preserve native facts without readback or replay', async () => {
  const p = ports(), h = await mount(p.options); await h.select(file('a'));
  const rejected: RendererSaveResult = { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'NATIVE_REJECTED', message: 'native rejected' }] };
  p.options.bridge!.saveTextResource = async () => rejected;
  assert.equal(await h.current().applyTextResourceAndReload(file('a').sourceUri, 'bytes'), rejected); assert.equal(p.previews.length, 1);
  const error = new Error('unknown native outcome'); p.options.bridge!.saveTextResource = async () => { throw error; };
  await assert.rejects(h.current().applyTextResourceAndReload(file('a').sourceUri, 'bytes'), received => received === error); assert.equal(p.previews.length, 1);
});
it('FLVER submission keeps stable IDs, source hash and slot zero unchanged', async () => {
  for (const missingHash of [false, true]) {
    const p = ports(), h = await mount(p.options), target = file('a', 'flver');
    p.options.bridge!.readFlverDocument = async source => { p.nativeReads.push(['flver', source]); return { ok: true, data: { format: 'FLVER', ...(missingHash ? {} : { sourceHash: 'original-native-hash' }) } }; };
    await h.select(target); let result!: RendererSaveResult | null;
    await act(async () => { result = await h.current().applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh-stable:12', materialStableId: 'material-stable:7' }); });
    assert.equal(result, receipt); assert.deepEqual(p.flverWrites, [[target.sourceUri, missingHash ? '' : 'original-native-hash', { kind: 'material-slot-set', meshStableId: 'mesh-stable:12', slotIndex: 0, materialStableId: 'material-stable:7' }]]);
    assert.equal(p.nativeReads.length, 2); assert.equal(p.histories(), 1); assert.deepEqual(p.toasts, [['已保存', undefined]]);
  }
});
it('late FLVER readback cannot replace another selection and keeps the true committed receipt', async () => {
  const p = ports(), h = await mount(p.options), old = deferred<ResourceNativeReadResult>(); await h.select(file('a', 'flver'));
  p.options.bridge!.readFlverDocument = source => { p.nativeReads.push(['flver', source]); return old.promise; };
  let saving!: ReturnType<ResourceDocumentController['applyFlverMaterialSlotSetAndReload']>;
  await act(async () => { saving = h.current().applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh', materialStableId: 'material' }); });
  await h.select(file('b')); const statuses = p.statuses.length;
  await act(async () => { old.resolve({ ok: true, data: { sourceHash: 'obsolete-commit' } }); assert.equal(await saving, receipt); });
  assert.equal(h.current().flverData, null); assert.equal(p.statuses.length, statuses); assert.equal(p.flverWrites.length, 1); assert.equal(p.histories(), 0); assert.deepEqual(p.toasts, []);
});
it('a pending native FLVER receipt survives concrete reset without a stale reread or replay', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<RendererSaveResult>(); await h.select(file('a', 'flver'));
  p.options.bridge!.applyFlverMutation = (...args) => { p.flverWrites.push(args); return pending.promise; };
  let saving!: ReturnType<ResourceDocumentController['applyFlverMaterialSlotSetAndReload']>;
  await act(async () => { saving = h.current().applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh', materialStableId: 'material' }); });
  await act(async () => h.current().resetFlverDocument());
  await act(async () => { pending.resolve(receipt); assert.equal(await saving, receipt); });
  assert.equal(h.current().flverData, null); assert.equal(p.flverWrites.length, 1); assert.equal(p.nativeReads.length, 1); assert.equal(p.histories(), 0);
});
it('committed FLVER writes survive native readback and history rejection without replay', async () => {
  for (const failure of ['readback', 'history'] as const) {
    const p = ports(), h = await mount(p.options); await h.select(file('a', 'flver'));
    if (failure === 'readback') p.options.bridge!.readFlverDocument = async () => { throw new Error('readback failure'); };
    else { p.options.refreshOperationHistory = async () => { throw new Error('history failure'); }; await h.update(p.options); }
    let result!: RendererSaveResult | null;
    await act(async () => { result = await h.current().applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh', materialStableId: 'material' }); });
    assert.equal(result?.ok, true); assert.equal(result?.opId, receipt.opId); assert.equal(result?.sourceHash, receipt.sourceHash);
    assert.equal(result?.diagnostics.at(-1)?.code, failure === 'readback' ? 'POSTCOMMIT_FLVER_RELOAD_FAILED' : 'POSTCOMMIT_FLVER_HISTORY_FAILED');
    assert.equal(p.flverWrites.length, 1); assert.equal(p.toasts.at(-1)?.[1], 'warn');
  }
});
it('a delayed history completion cannot publish save feedback after workspace reset', async () => {
  const p = ports(), h = await mount(p.options), history = deferred<void>(); await h.select(file('a'));
  p.options.refreshOperationHistory = () => history.promise; await h.update(p.options);
  let saving!: ReturnType<ResourceDocumentController['saveCurrentText']>; await act(async () => { saving = h.current().saveCurrentText(); });
  await act(async () => h.current().resetWorkspaceDocuments()); const statuses = p.statuses.length;
  await act(async () => { history.resolve(); assert.equal(await saving, receipt); });
  assert.equal(p.statuses.length, statuses); assert.deepEqual(p.toasts, []); assertPlainEmpty(h.current()); assert.equal(p.textWrites.length, 1);
});
it('bridge replacement and disposal reject retained submits and late native projections', async () => {
  for (const change of ['bridge', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options), old = deferred<ResourceNativeReadResult>(); await h.select(file('a', 'flver'));
    p.options.bridge!.readFlverDocument = () => old.promise;
    let saving!: ReturnType<ResourceDocumentController['applyFlverMaterialSlotSetAndReload']>;
    const retained = h.current();
    await act(async () => { saving = retained.applyFlverMaterialSlotSetAndReload({ meshStableId: 'mesh', materialStableId: 'material' }); });
    if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } }); else await h.unmount();
    const statuses = p.statuses.length;
    await act(async () => {
      old.resolve({ ok: true, data: { sourceHash: 'obsolete' } }); assert.equal(await saving, receipt);
      assert.equal(await retained.saveCurrentText(), null); assert.equal((await retained.applyTextResourceAndReload(file('a').sourceUri, 'old')).ok, false);
      assert.equal(await retained.applyFlverMaterialSlotSetAndReload({ meshStableId: 'old', materialStableId: 'old' }), null);
    });
    assert.equal(p.flverWrites.length, 1); assert.equal(p.textWrites.length, 0); assert.equal(p.statuses.length, statuses);
    if (change === 'bridge') { assertPlainEmpty(h.current()); assert.equal(h.current().flverData, null); }
  }
});
it('feedback rerenders and strict lifecycle keep explicit selection reads single and reset callbacks stable', async () => {
  const p = ports(), h = await mount(p.options, true, true), reset = h.current().resetFlverDocument;
  await h.select(file('a', 'flver'));
  await h.update({ ...p.options, setStatus: () => undefined });
  assert.equal(p.previews.length, 1); assert.equal(p.nativeReads.length, 1); assert.equal(h.current().resetFlverDocument, reset);
  await act(async () => reset()); assert.equal(h.current().flverData, null); assert.equal(p.previews.length, 1);
});

for (const phase of ['native-save', 'preview'] as const) {
  for (const edit of ['text', 'row'] as const) {
    it(`a newer ${edit} draft during ${phase} remains dirty after the older save updates its loaded baseline`, async () => {
      const p = ports(), h = await mount(p.options), target = file('a');
      const initial = opened(target, edit === 'row' ? '7\toriginal\n' : 'original');
      if (edit === 'row') initial.structuredPreview!.msgs = [{ category: 'owned', entries: [{ uri: 'msg://owned/7', sourceUri: target.sourceUri, textId: 7, text: 'original' }] }];
      p.options.bridge!.openResourcePreview = async () => initial; await h.select(target);
      await act(async () => { if (edit === 'row') h.current().updateMsgRow(0, { text: 'committed' }); else h.current().setEditText('committed'); });
      const committed = opened(target, edit === 'row' ? '7\tcommitted\n' : 'committed');
      if (edit === 'row') committed.structuredPreview!.msgs = [{ category: 'owned', entries: [{ uri: 'msg://owned/7', sourceUri: target.sourceUri, textId: 7, text: 'committed' }] }];
      const native = deferred<RendererSaveResult>(), preview = deferred<RendererResourcePreview | null>();
      p.options.bridge!.saveTextResource = (uri, text) => { p.textWrites.push([uri, text]); return phase === 'native-save' ? native.promise : Promise.resolve(receipt); };
      p.options.bridge!.openResourcePreview = () => phase === 'preview' ? preview.promise : Promise.resolve(committed);
      let saving!: ReturnType<ResourceDocumentController['saveCurrentText']>;
      await act(async () => { saving = h.current().saveCurrentText(); });
      await act(async () => { if (edit === 'row') h.current().updateMsgRow(0, { text: 'newer draft' }); else h.current().setEditText('newer draft'); });
      let result!: Awaited<typeof saving>;
      await act(async () => { if (phase === 'native-save') native.resolve(receipt); else preview.resolve(committed); result = await saving; });
      assert.equal(result, receipt); assert.equal(h.current().preview, committed);
      assert.equal(h.current().lastSavedText, committed.text);
      assert.equal(h.current().editText, edit === 'row' ? '7\tnewer draft\n' : 'newer draft');
      if (edit === 'row') assert.equal(h.current().msgRows[0]?.text, 'newer draft');
      assert.equal(h.current().editDirty, true);
      assert.deepEqual(p.textWrites, [[target.sourceUri, edit === 'row' ? '7\tcommitted\n' : 'committed']]);
    });
  }
}

for (const edit of ['add', 'remove'] as const) {
  it(`message-row ${edit} during save readback retains the newer row draft and advances only its loaded baseline`, async () => {
    const p = ports(), h = await mount(p.options), target = file('a'), value = opened(target, '7\toriginal\n');
    value.structuredPreview!.msgs = [{ category: 'owned', entries: [{ uri: 'msg://owned/7', sourceUri: target.sourceUri, textId: 7, text: 'original' }] }];
    p.options.bridge!.openResourcePreview = async () => value; await h.select(target);
    const pending = deferred<RendererResourcePreview | null>(); p.options.bridge!.openResourcePreview = () => pending.promise;
    let saving!: ReturnType<ResourceDocumentController['saveCurrentText']>;
    await act(async () => { saving = h.current().saveCurrentText(); });
    await act(async () => { if (edit === 'add') h.current().addMsgRow(); else h.current().removeMsgRow(0); });
    const draft = h.current().editText, rows = h.current().msgRows;
    await act(async () => { pending.resolve(value); assert.equal(await saving, receipt); });
    assert.equal(h.current().lastSavedText, value.text); assert.equal(h.current().editText, draft);
    assert.equal(h.current().msgRows, rows); assert.equal(h.current().editDirty, true);
  });
}
