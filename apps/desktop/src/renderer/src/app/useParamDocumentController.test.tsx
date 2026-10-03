import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { OpenParamSessionSuccess, ParamPhysicalRowIdentity, ParamRowPayloadBatch } from '@soulforge/shared';
import type { RendererIndexedFile } from '../../../main/rendererDto.js';
import { useParamDocumentController, type ParamDocumentController, type ParamDocumentOptions } from './useParamDocumentController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => { while (mounted.length) { const renderer = mounted.pop()!; await act(async () => renderer.unmount()); } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
function file(name: string): RendererIndexedFile {
  return { sourceUri: `resource://owned/${name}`, relativePath: `param/${name}.param`, game: 'sekiro', resourceKind: 'param',
    parseStatus: 'parsed', diagnostics: [], extension: '.param', compoundExtension: '.param', formatKind: 'param', formatLabel: 'PARAM', size: 1, mtimeMs: 0 };
}
const identity = (name: string): ParamPhysicalRowIdentity => ({ rowIndex: 0, id: 10, dataHash: `row-${name}` });
function opened(name: string): OpenParamSessionSuccess {
  return { ok: true, sessionToken: `session-${name}`, workspaceSessionId: 'owned', sourceHash: `hash-${name}`, pathSourceGeneration: 1,
    rowCount: 1, metadata: { typeName: name, rowDataSize: 1, fieldDefs: [{ id: 'priority', name: 'Priority', type: 's8', size: 1, offset: 0 }],
      fieldEnums: null, fieldDefsDiagnostic: null, fieldDefsOrigin: 'first-party', fieldDefsTrusted: true }, nativeTelemetry: null,
    firstPage: { page: 0, pageSize: 1000, rows: [{ ...identity(name), name: null }] }, diagnostics: [] };
}
function ports() {
  const statuses: string[] = [], toasts: string[] = [], reads: unknown[] = [], saves: unknown[][] = [];
  let histories = 0;
  const options: ParamDocumentOptions = { selectedFile: file('a'),
    bridge: { openParamSession: async request => opened(request.sourceUri.endsWith('/b') ? 'b' : 'a'),
      readParamIndexPage: async () => { throw new Error('unexpected extra page'); },
      readParamRows: async request => { reads.push(request); return { ok: true, sessionToken: request.sessionToken,
        rows: request.rows.map(identity => ({ identity, dataBase64: 'Bw==' })), nativeTelemetry: null, diagnostics: [] }; },
      applyParamFieldMutation: async (...args) => { saves.push(args); return { ok: true, changedFiles: [], diagnostics: [] }; } },
    setStatus: status => statuses.push(status), pushToast: text => toasts.push(text),
    refreshOperationHistory: async () => { histories++; }, describeBridgeAbsence: operation => `unavailable:${operation}` };
  return { options, statuses, toasts, reads, saves, histories: () => histories };
}
async function mount(options: ParamDocumentOptions) {
  let current!: ParamDocumentController;
  function Host({ options }: { options: ParamDocumentOptions }) { current = useParamDocumentController(options); return <span>{current.paramTypeName}</span>; }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Host options={options} />); }); mounted.push(renderer);
  return { current: () => current, update: async (options: ParamDocumentOptions) => act(async () => renderer.update(<Host options={options} />)),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}

it('loaded index metadata and selected-row payload retain physical identity and session scope', async () => {
  const p = ports(), h = await mount(p.options);
  assert.equal(h.current().paramLive, true); assert.equal(h.current().paramSourceHash, 'hash-a');
  assert.equal(h.current().paramFieldDefinition?.origin, 'first-party'); assert.equal(h.current().paramRows[0]?.dataBase64, undefined);
  await act(async () => h.current().readParamRowsForPanel([identity('a')]));
  assert.deepEqual(p.reads, [{ sourceUri: file('a').sourceUri, sessionToken: 'session-a', rows: [identity('a')] }]);
  assert.equal(h.current().paramRows[0]?.dataBase64, 'Bw=='); assert.equal(h.current().paramRows[0]?.dataHexPreview, '07');
});
it('switching selection and unmount discard late open-session success and errors', async () => {
  const p = ports(), old = deferred<OpenParamSessionSuccess>();
  p.options.bridge!.openParamSession = request => request.sourceUri.endsWith('/a') ? old.promise : Promise.resolve(opened('b'));
  const h = await mount(p.options); await h.update({ ...p.options, selectedFile: file('b') });
  await act(async () => old.resolve(opened('a'))); assert.equal(h.current().paramSourceHash, 'hash-b');
  const late = deferred<OpenParamSessionSuccess>(); const bridge = { ...p.options.bridge!, openParamSession: () => late.promise };
  await h.update({ ...p.options, bridge, selectedFile: file('a') }); const count = p.statuses.length;
  await h.unmount(); await act(async () => late.reject(new Error('late failure'))); assert.equal(p.statuses.length, count);
});
it('reset clears metadata, payload and reveal state and invalidates an in-flight open even before selection changes', async () => {
  const p = ports(), pending = deferred<OpenParamSessionSuccess>(); p.options.bridge!.openParamSession = () => pending.promise;
  const h = await mount(p.options); await act(async () => h.current().setParamRevealRowId(10));
  await act(async () => h.current().resetParamDocument());
  await act(async () => pending.resolve(opened('a')));
  assert.equal(h.current().paramLive, false); assert.equal(h.current().paramSourceHash, null);
  assert.deepEqual(h.current().paramRows, []); assert.equal(h.current().paramRevealRowId, null);
  assert.equal(h.current().paramFieldDefsOrigin, 'fixture'); assert.equal(h.current().paramRowPayloads.size, 0);
});
it('an old selected-row payload result cannot populate the next document cache', async () => {
  const p = ports(), pending = deferred<ParamRowPayloadBatch>(); p.options.bridge!.readParamRows = () => pending.promise;
  const h = await mount(p.options); let reading!: ReturnType<ParamDocumentController['readParamRowsForPanel']>;
  await act(async () => { reading = h.current().readParamRowsForPanel([identity('a')]); });
  await h.update({ ...p.options, selectedFile: file('b') });
  await act(async () => { pending.resolve({ ok: true, sessionToken: 'session-a', rows: [{ identity: identity('a'), dataBase64: 'Bw==' }], nativeTelemetry: null, diagnostics: [] }); await reading; });
  assert.equal(h.current().paramSourceHash, 'hash-b'); assert.equal(h.current().paramRowPayloads.size, 0);
  assert.equal(h.current().paramRows[0]?.dataBase64, undefined);
});
it('an old explicit reload cannot overwrite a newly selected document', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<OpenParamSessionSuccess>();
  p.options.bridge!.openParamSession = request => request.sourceUri.endsWith('/a') ? pending.promise : Promise.resolve(opened('b'));
  let reloading!: ReturnType<ParamDocumentController['reloadParamRowsFromSource']>; await act(async () => { reloading = h.current().reloadParamRowsFromSource(); });
  await h.update({ ...p.options, selectedFile: file('b') });
  await act(async () => { pending.resolve(opened('a')); await reloading; });
  assert.equal(h.current().paramSourceHash, 'hash-b'); assert.equal(h.current().paramTypeName, 'b');
});
it('normal field save forwards existing hash/identity and preserves committed result and reload behavior', async () => {
  const p = ports(), h = await mount(p.options); const definition = h.current().paramFieldDefinition;
  let result!: Awaited<ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>>;
  await act(async () => { result = await h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition }); });
  assert.equal(result.ok, true); assert.equal(p.histories(), 1); assert.deepEqual(p.toasts, ['已保存']);
  assert.deepEqual(p.saves[0], [file('a').sourceUri, 'hash-a', { rowId: 10, rowIndex: 0, expectedDataHash: 'row-a', fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition }]);
});

it('a committed field write remains successful after selection changes without refreshing or reporting the old document', async () => {
  const p = ports(), h = await mount(p.options);
  const pending = deferred<{ ok: true; changedFiles: string[]; diagnostics: []; opId: string }>();
  p.options.bridge!.applyParamFieldMutation = () => pending.promise;
  let saving!: ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>;
  await act(async () => { saving = h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition: h.current().paramFieldDefinition }); });
  await h.update({ ...p.options, selectedFile: file('b') });
  let result!: Awaited<typeof saving>;
  const receipt = { ok: true as const, changedFiles: ['resource://owned/a'], diagnostics: [] as [], opId: 'owned-commit' };
  await act(async () => { pending.resolve(receipt); result = await saving; });
  assert.equal(result, receipt, 'Selection invalidation must preserve the original committed receipt and operation facts');
  assert.equal(result.ok, true); assert.equal(h.current().paramSourceHash, 'hash-b');
  assert.equal(p.histories(), 0); assert.deepEqual(p.toasts, []);
  assert.equal(p.statuses.some(value => value.endsWith('priority 已保存。')), false);
});

it('a disposed selected-row read returns its original response without reviving controller state', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<ParamRowPayloadBatch>();
  p.options.bridge!.readParamRows = () => pending.promise;
  let reading!: ReturnType<ParamDocumentController['readParamRowsForPanel']>;
  await act(async () => { reading = h.current().readParamRowsForPanel([identity('a')]); });
  await h.unmount(); const rows = [{ identity: identity('a'), dataBase64: 'Bw==' }];
  let result!: Awaited<typeof reading>;
  await act(async () => { pending.resolve({ ok: true, sessionToken: 'session-a', rows, nativeTelemetry: null, diagnostics: [] }); result = await reading; });
  assert.deepEqual(result, rows); assert.equal(h.current().paramRowPayloads.size, 0);
});

it('a retained submission callback cannot dispatch after selection, reset, bridge change, round trip or unmount', async () => {
  for (const change of ['selection', 'reset', 'bridge', 'round-trip', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options);
    const submit = h.current().applyParamFieldMutationFromPanel;
    const definition = h.current().paramFieldDefinition;
    if (change === 'selection') await h.update({ ...p.options, selectedFile: file('b') });
    else if (change === 'reset') await act(async () => h.current().resetParamDocument());
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else if (change === 'round-trip') {
      await h.update({ ...p.options, selectedFile: file('b') });
      await h.update(p.options);
    } else await h.unmount();
    let result!: Awaited<ReturnType<typeof submit>>;
    await act(async () => { result = await submit({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition }); });
    assert.equal(result.ok, false); assert.equal(p.saves.length, 0);
    assert.equal(result.diagnostics?.[0]?.code, 'PARAM_FIELD_DOCUMENT_CHANGED');
  }
});

for (const phase of ['reload','history'] as const) {
  it(`committed field ${phase} rejection preserves receipt facts with a warning and no write replay`, async () => {
    const p = ports(), h = await mount(p.options);
    const receipt = { ok: true as const, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' };
    let saves = 0;
    p.options.bridge!.applyParamFieldMutation = async () => { saves++; return receipt; };
    if (phase === 'reload') p.options.bridge!.openParamSession = async () => { throw new Error('owned reload failure'); };
    else p.options.refreshOperationHistory = async () => { throw new Error('owned history failure'); };
    // Re-render to supply the changed history callback without changing ownership.
    await h.update({ ...p.options });
    let result!: Awaited<ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>>;
    await act(async () => { result = await h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition: h.current().paramFieldDefinition }); });
    assert.equal(result.ok, true); assert.equal(saves, 1);
    assert.equal((result as typeof receipt).opId, 'owned-commit');
    assert.deepEqual((result as typeof receipt).changedFiles, receipt.changedFiles);
    assert.ok(result.diagnostics?.some(diagnostic => diagnostic.code === (phase === 'reload' ? 'POSTCOMMIT_PARAM_RELOAD_FAILED' : 'POSTCOMMIT_HISTORY_REFRESH_FAILED')));
    assert.equal(p.toasts.length, 1);
    assert.match(p.toasts[0]!, /已保存，但/);
  });
}

it('a late postcommit reload failure after disposal retains the original receipt without warning the next document', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<OpenParamSessionSuccess>();
  const receipt = { ok: true as const, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' };
  p.options.bridge!.applyParamFieldMutation = async () => receipt;
  p.options.bridge!.openParamSession = () => pending.promise;
  let saving!: ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>;
  await act(async () => { saving = h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition: h.current().paramFieldDefinition }); });
  await h.unmount();
  let result!: Awaited<typeof saving>;
  await act(async () => { pending.reject(new Error('owned disposed reload failure')); result = await saving; });
  assert.equal(result, receipt); assert.deepEqual(p.toasts, []); assert.equal(p.histories(), 0);
});

it('shared PARAM command ownership follows the actual reset lifetime and cannot revive a retained closure', async () => {
  for (const boundary of ['selection', 'reset', 'bridge', 'round-trip', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options);
    const owns = h.current().ownsParamDocument;
    assert.equal(owns(), true);
    if (boundary === 'selection') await h.update({ ...p.options, selectedFile: file('b') });
    else if (boundary === 'reset') await act(async () => h.current().resetParamDocument());
    else if (boundary === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else if (boundary === 'round-trip') { await h.update({ ...p.options, selectedFile: file('b') }); await h.update(p.options); }
    else await h.unmount();
    assert.equal(owns(), false, `${boundary} invalidates the old command owner`);
    if (boundary !== 'unmount') assert.equal(h.current().ownsParamDocument(), true);
    assert.deepEqual(p.saves, []);
  }
});

for (const phase of ['open', 'index'] as const) {
  it(`committed field structured ${phase} readback failure returns its receipt with a fixed warning`, async () => {
    const p = ports(), h = await mount(p.options);
    const receipt = { ok: true as const, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' };
    const diagnostic = { severity: 'error' as const, code: 'OWNED_READBACK_FAILED', message: 'synthetic read failure' };
    let saves = 0;
    p.options.bridge!.applyParamFieldMutation = async () => { saves++; return receipt; };
    if (phase === 'open') p.options.bridge!.openParamSession = async () => ({ ok: false, diagnostics: [diagnostic] });
    else {
      p.options.bridge!.openParamSession = async () => ({ ...opened('a'), rowCount: 2 });
      p.options.bridge!.readParamIndexPage = async () => ({ ok: false, diagnostics: [diagnostic] });
    }
    let result!: Awaited<ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>>;
    await act(async () => { result = await h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition: h.current().paramFieldDefinition }); });
    assert.equal(result.ok, true); assert.equal(saves, 1);
    assert.equal((result as typeof receipt).opId, receipt.opId);
    assert.deepEqual((result as typeof receipt).changedFiles, receipt.changedFiles);
    assert.ok(result.diagnostics?.some(d => d.code === 'POSTCOMMIT_PARAM_RELOAD_FAILED'));
    assert.deepEqual(p.toasts, ['PARAM 字段 priority 已保存，但文档重读失败。']);
    assert.equal(p.histories(), 0);
  });
}

it('a structured history failure preserves committed field facts and warning feedback', async () => {
  const p = ports(), h = await mount(p.options);
  const receipt = { ok: true as const, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' };
  p.options.bridge!.applyParamFieldMutation = async (...args) => { p.saves.push(args); return receipt; };
  p.options.refreshOperationHistory = async () => ({ ok: false }); await h.update(p.options);
  let result!: Awaited<ReturnType<ParamDocumentController['applyParamFieldMutationFromPanel']>>;
  await act(async () => { result = await h.current().applyParamFieldMutationFromPanel({ rowId: 10, identity: identity('a'), fieldId: 'priority', value: 7, rowDataBase64: 'AA==', definition: h.current().paramFieldDefinition }); });
  assert.equal(result.ok, true); assert.equal((result as typeof receipt).opId, receipt.opId);
  assert.deepEqual((result as typeof receipt).changedFiles, receipt.changedFiles);
  assert.ok(result.diagnostics?.some(d => d.code === 'POSTCOMMIT_HISTORY_REFRESH_FAILED'));
  assert.deepEqual(p.toasts, ['PARAM 字段 priority 已保存，但操作历史刷新失败。']);
  assert.equal(p.saves.length, 1);
});
