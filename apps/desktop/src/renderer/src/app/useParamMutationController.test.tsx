import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act, useRef } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import type { OpenParamSessionSuccess, ParamDefDocument, ParamPhysicalRowIdentity } from '@soulforge/shared';
import type { RendererIndexedFile, RendererSaveResult } from '../../../main/rendererDto.js';
import type { ParamWorkbenchProps } from '../workbench/ParamWorkbench.js';
import { useParamDocumentController, type ParamDocumentController, type ParamDocumentOptions } from './useParamDocumentController.js';
import { useParamMutationController, type ParamMutationController, type ParamMutationOptions } from './useParamMutationController.js';
import { useChangeOperationsController, type ChangeOperationsController, type OperationHistoryRefreshOutcome } from './useChangeOperationsController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name: string): RendererIndexedFile {
  return { sourceUri: `resource://owned/${name}`, relativePath: `param/${name}.param`, game: 'sekiro', resourceKind: 'param',
    parseStatus: 'parsed', diagnostics: [], extension: '.param', compoundExtension: '.param', formatKind: 'param', formatLabel: 'PARAM', size: 1, mtimeMs: 0 };
}
const firstIdentity: ParamPhysicalRowIdentity = { rowIndex: 0, id: 10, dataHash: 'first-row-hash' };
const secondIdentity: ParamPhysicalRowIdentity = { rowIndex: 1, id: 10, dataHash: 'second-row-hash' };
const definition: ParamDefDocument = { schemaVersion: 1, typeName: 'Equip', version: 0, rowDataSize: 3,
  origin: 'first-party', fields: [{ id: 'priority', name: 'Priority', type: 's8', size: 1, offset: 0 }] };
const fieldInput: Parameters<NonNullable<ParamWorkbenchProps['onApplyFieldMutation']>>[0] = {
  paramName: 'Equip.param', entryIndex: 4, expectedContainerHash: 'container-hash', expectedChildHash: 'child-hash',
  rowIndex: 1, rowId: 10, expectedDataHash: secondIdentity.dataHash, expectedRowDataSize: 3,
  fieldId: 'priority', value: 7, rowDataBase64: 'AQID', definition
};
const nameInput: Parameters<NonNullable<ParamWorkbenchProps['onApplyRowNameMutation']>>[0] = {
  paramName: 'Equip.param', entryIndex: 4, expectedContainerHash: 'container-hash', expectedChildHash: 'child-hash',
  rowIndex: 1, rowId: 10, expectedDataHash: secondIdentity.dataHash, expectedRowDataSize: 3, name: '', rowDataBase64: 'AQID'
};
const rowInput: Parameters<NonNullable<ParamWorkbenchProps['onApplyRowMutation']>>[0] = {
  paramName: 'Equip.param', entryIndex: 4, expectedContainerHash: 'container-hash', expectedChildHash: 'child-hash',
  kind: 'copy', rowId: 11, rowDataBase64: 'AQID'
};
function opened(sourceUri: string): OpenParamSessionSuccess {
  return { ok: true, sessionToken: `session:${sourceUri}`, workspaceSessionId: 'owned', sourceHash: 'native-file-hash', pathSourceGeneration: 1,
    rowCount: 2, metadata: { typeName: 'Equip', rowDataSize: 3, fieldDefs: definition.fields, fieldEnums: null,
      fieldDefsDiagnostic: null, fieldDefsOrigin: 'first-party', fieldDefsTrusted: true }, nativeTelemetry: null,
    firstPage: { page: 0, pageSize: 1000, rows: [{ ...firstIdentity, name: null }, { ...secondIdentity, name: null }] }, diagnostics: [] };
}
type HarnessOptions = Omit<ParamMutationOptions,
  'paramLive' | 'paramSourceHash' | 'paramRowPayloads' | 'reloadParamRowsFromSource' | 'ownsParamDocument' | 'bridge'> & {
  bridge: (NonNullable<ParamMutationOptions['bridge']> & NonNullable<ParamDocumentOptions['bridge']>) | null;
  reloadParamRowsFromSource?: ParamDocumentController['reloadParamRowsFromSource'];
};
function ports() {
  const calls: Array<{ method: string; args: unknown[] }> = [], statuses: string[] = [], toasts: Array<[string, 'ok' | 'warn' | undefined]> = [];
  const reloads: string[] = [];
  let histories = 0;
  const receipt: RendererSaveResult = { ok: true, changedFiles: ['resource://owned/a'], diagnostics: [
    { severity: 'info', code: 'NATIVE_READBACK_VERIFIED', message: 'native receipt' }
  ], opId: 'native-commit', sourceHash: 'written-hash', sourceRevision: 12 };
  const record = (method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return receipt; };
  const options: HarnessOptions = {
    selectedFile: file('a'), paramWorkbenchFile: file('container-a'),
    bridge: {
      applyContainerParamFieldMutation: record('field'), applyContainerParamRowNameMutation: record('name'),
      applyContainerParamRowMutations: record('row'), applyParamMutation: record('raw'), applyParamFieldMutation: record('bare-field'),
      openParamSession: async request => { reloads.push(request.sourceUri); return opened(request.sourceUri); },
      readParamIndexPage: async () => { throw new Error('unexpected extra index page'); },
      readParamRows: async request => ({ ok: true, sessionToken: request.sessionToken,
        rows: request.rows.map(identity => ({ identity, dataBase64: identity.rowIndex === 0 ? 'AAAA' : 'AQID' })), nativeTelemetry: null, diagnostics: [] })
    },
    setStatus: value => { statuses.push(value); }, pushToast: (value, kind) => { toasts.push([value, kind]); },
    refreshOperationHistory: async () => { histories++; }, describeBridgeAbsence: operation => `unavailable:${operation}`
  };
  return { options, calls, receipt, statuses, toasts, reloads, histories: () => histories };
}
async function mount(options: HarnessOptions) {
  let current!: ParamMutationController, document!: ParamDocumentController;
  function Host({ options }: { options: HarnessOptions }) {
    document = useParamDocumentController(options);
    current = useParamMutationController({ ...options, paramLive: document.paramLive, paramSourceHash: document.paramSourceHash,
      paramRowPayloads: document.paramRowPayloads, reloadParamRowsFromSource: options.reloadParamRowsFromSource ?? document.reloadParamRowsFromSource,
      ownsParamDocument: document.ownsParamDocument });
    return <span>{document.paramTypeName}</span>;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Host options={options} />); });
  mounted.push(renderer);
  return { current: () => current, document: () => document,
    update: async (next: HarnessOptions) => act(async () => renderer.update(<Host options={next} />)),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}

it('container commands forward exact original native arguments and retain every commit fact', async () => {
  const p = ports(), h = await mount(p.options);
  const statusCount = p.statuses.length;
  const commands = [
    () => h.current().applyContainerParamFieldMutation(fieldInput),
    () => h.current().applyContainerParamRowNameMutation(nameInput),
    () => h.current().applyContainerParamRowMutation(rowInput)
  ];
  for (const command of commands) {
    let result!: Awaited<ReturnType<typeof command>>;
    await act(async () => { result = await command(); });
    assert.equal(result, p.receipt);
  }
  assert.deepEqual(p.calls, [
    { method: 'field', args: [file('container-a').sourceUri, 'container-hash', { entryIndex: 4, expectedChildHash: 'child-hash',
      rowIndex: 1, rowId: 10, expectedDataHash: 'second-row-hash', expectedRowDataSize: 3, fieldId: 'priority', value: 7, rowDataBase64: 'AQID', definition }] },
    { method: 'name', args: [file('container-a').sourceUri, 'container-hash', { entryIndex: 4, expectedChildHash: 'child-hash',
      rowIndex: 1, rowId: 10, expectedDataHash: 'second-row-hash', expectedRowDataSize: 3, name: '', rowDataBase64: 'AQID' }] },
    { method: 'row', args: [file('container-a').sourceUri, 'container-hash', { kind: 'copy', entryIndex: 4,
      expectedChildHash: 'child-hash', rowId: 11, rowDataBase64: 'AQID' }] }
  ]);
  assert.deepEqual(p.statuses.slice(statusCount), [
    'PARAM 字段已写入：Equip.param 行 10 的 priority。',
    'PARAM 行名已写入：Equip.param 行 10 →「」。',
    'PARAM 复制行已保存：Equip.param 行 11。'
  ]);
  assert.equal(p.histories(), 3);
  assert.equal(p.reloads.length, 1, 'container readback remains with the mounted workbench');
});
it('empty container hash still dispatches to main and row labels preserve add/copy/delete behavior', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => { await h.current().applyContainerParamFieldMutation({ ...fieldInput, expectedContainerHash: '' }); });
  assert.equal(p.calls[0]?.args[1], '');
  for (const kind of ['add', 'copy', 'delete'] as const) {
    await act(async () => { await h.current().applyContainerParamRowMutation({ ...rowInput, kind }); });
    assert.equal(p.calls.at(-1)?.method, 'row');
    assert.equal((p.calls.at(-1)?.args[2] as { kind: string }).kind, kind);
    assert.equal(p.statuses.at(-1), `PARAM ${kind === 'add' ? '新建' : kind === 'copy' ? '复制' : '删除'}行已保存：Equip.param 行 11。`);
  }
});
it('raw delete retains physical row identity and raw copy uses supplied bytes before the identity-scoped cache', async () => {
  const p = ports(), h = await mount(p.options);
  const statusCount = p.statuses.length;
  await act(async () => h.document().readParamRowsForPanel([firstIdentity, secondIdentity]));
  let deleted!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
  await act(async () => { deleted = await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: secondIdentity }); });
  assert.equal(deleted, p.receipt);
  assert.deepEqual(p.calls[0], { method: 'raw', args: [file('a').sourceUri, 'native-file-hash',
    { kind: 'delete', id: 10, rowIndex: 1, expectedDataHash: 'second-row-hash' }] });
  // Reload clears the payload cache; refill it with two physically distinct rows sharing id 10.
  await act(async () => h.document().readParamRowsForPanel([firstIdentity, secondIdentity]));
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_upsert', id: 11, sourceId: 10, sourceIdentity: secondIdentity }); });
  assert.deepEqual(p.calls[1]?.args, [file('a').sourceUri, 'native-file-hash', { kind: 'upsert', id: 11, dataBase64: 'AQID' }]);
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_upsert', id: 12, dataBase64: 'BAUG', sourceIdentity: firstIdentity }); });
  assert.deepEqual(p.calls[2]?.args, [file('a').sourceUri, 'native-file-hash', { kind: 'upsert', id: 12, dataBase64: 'BAUG' }]);
  assert.deepEqual(p.statuses.slice(statusCount), ['PARAM 行 10 已删除并保存。', 'PARAM 行 10 已复制到 11 并保存。', 'PARAM 行 12 已保存。']);
  assert.equal(p.histories(), 3); assert.equal(p.reloads.length, 4);
  assert.deepEqual(p.toasts, [['已保存', undefined], ['已保存', undefined], ['已保存', undefined]]);
});
it('raw missing identity or payload never guesses a native write target', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10 }); });
  assert.equal(p.statuses.at(-1), '缺少物理行身份，拒绝按 id 猜测删除目标。');
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_upsert', id: 11, sourceIdentity: secondIdentity }); });
  assert.equal(p.statuses.at(-1), '缺少 row dataBase64，无法写入（截断行）。');
  assert.equal(p.calls.length, 0);
});
it('ordinary native refusals preserve original labels and diagnostics without reload or replay', async () => {
  const p = ports(), h = await mount(p.options);
  const refusal: RendererSaveResult = { ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'SOURCE_CHANGED', message: 'source changed' }] };
  p.options.bridge!.applyContainerParamFieldMutation = async () => refusal;
  p.options.bridge!.applyParamMutation = async () => refusal;
  let result!: Awaited<ReturnType<ParamMutationController['applyContainerParamFieldMutation']>>;
  await act(async () => { result = await h.current().applyContainerParamFieldMutation(fieldInput); });
  assert.equal(result.ok, false); assert.equal(result.message, 'source changed'); assert.equal(result.diagnostics, refusal.diagnostics);
  assert.equal(p.statuses.at(-1), 'PARAM 字段写入失败：source changed');
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
  assert.equal(p.statuses.at(-1), 'PARAM 行删除失败：source changed');
  assert.deepEqual(p.toasts, [['PARAM 行删除失败：source changed', 'warn']]);
  assert.equal(p.reloads.length, 1); assert.equal(p.histories(), 0);
});

for (const change of ['selection', 'reset', 'bridge', 'container', 'round-trip', 'unmount'] as const) {
  it(`retained container and raw callbacks cannot start after ${change}`, async () => {
    const p = ports(), h = await mount(p.options), old = h.current();
    if (change === 'selection') await h.update({ ...p.options, selectedFile: file('b') });
    else if (change === 'reset') await act(async () => h.document().resetParamDocument());
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else if (change === 'container') await h.update({ ...p.options, paramWorkbenchFile: file('container-b') });
    else if (change === 'round-trip') { await h.update({ ...p.options, selectedFile: file('b') }); await h.update(p.options); }
    else await h.unmount();
    await act(async () => {
      assert.equal((await old.applyContainerParamFieldMutation(fieldInput)).ok, false);
      assert.equal((await old.applyContainerParamRowNameMutation(nameInput)).ok, false);
      assert.equal((await old.applyContainerParamRowMutation(rowInput)).ok, false);
      await old.applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity });
    });
    assert.equal(p.calls.length, 0); assert.equal(p.histories(), 0);
  });
}
it('a preferred container remains writable with no selected file, but its replaced target cannot submit', async () => {
  const p = ports(); p.options.selectedFile = null;
  const h = await mount(p.options), old = h.current().applyContainerParamFieldMutation;
  await act(async () => { assert.equal((await old(fieldInput)).ok, true); });
  await h.update({ ...p.options, paramWorkbenchFile: file('container-b') });
  await act(async () => { assert.equal((await old(fieldInput)).ok, false); });
  assert.equal(p.calls.length, 1);
  await act(async () => { assert.equal((await h.current().applyContainerParamFieldMutation(fieldInput)).ok, true); });
  assert.equal(p.calls[1]?.args[0], file('container-b').sourceUri);
});

for (const command of ['field', 'name', 'row', 'raw'] as const) {
  for (const change of ['selection', 'reset', 'bridge', 'container', 'round-trip', 'unmount'] as const) {
  it(`dispatched ${command} native completion retains its receipt after ${change}`, async () => {
    const p = ports(), h = await mount(p.options), pending = deferred<RendererSaveResult>();
    const method = command === 'field' ? 'applyContainerParamFieldMutation' : command === 'name' ? 'applyContainerParamRowNameMutation'
      : command === 'row' ? 'applyContainerParamRowMutations' : 'applyParamMutation';
    p.options.bridge![method] = async (...args: unknown[]) => { p.calls.push({ method: command, args }); return pending.promise; };
    let saving!: Promise<RendererSaveResult | undefined>;
    await act(async () => {
      saving = command === 'field' ? h.current().applyContainerParamFieldMutation(fieldInput)
        : command === 'name' ? h.current().applyContainerParamRowNameMutation(nameInput)
        : command === 'row' ? h.current().applyContainerParamRowMutation(rowInput)
        : h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity });
    });
    if (change === 'selection') await h.update({ ...p.options, selectedFile: file('b') });
    else if (change === 'reset') await act(async () => h.document().resetParamDocument());
    else if (change === 'bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else if (change === 'container') await h.update({ ...p.options, paramWorkbenchFile: file('container-b') });
    else if (change === 'round-trip') { await h.update({ ...p.options, selectedFile: file('b') }); await h.update(p.options); }
    else await h.unmount();
    const statusCount = p.statuses.length, reloadCount = p.reloads.length;
    let result!: Awaited<typeof saving>;
    await act(async () => { pending.resolve(p.receipt); result = await saving; });
    assert.equal(result, p.receipt); assert.equal(p.calls.length, 1);
    assert.equal(p.statuses.length, statusCount); assert.equal(p.reloads.length, reloadCount);
    assert.equal(p.histories(), 0); assert.deepEqual(p.toasts, []);
  });
  }
}
for (const phase of ['reload', 'history', 'status', 'toast'] as const) {
  it(`committed raw ${phase} rejection remains saved with a warning and one native dispatch`, async () => {
    const p = ports(), h = await mount(p.options);
    const next = { ...p.options };
    if (phase === 'reload') next.reloadParamRowsFromSource = async () => { throw new Error('readback failed'); };
    else if (phase === 'history') next.refreshOperationHistory = async () => { throw new Error('history failed'); };
    else if (phase === 'status') next.setStatus = message => { if (message.endsWith('已删除并保存。')) throw new Error('status failed'); p.statuses.push(message); };
    else next.pushToast = (message, kind) => { if (message === '已保存') throw new Error('toast failed'); p.toasts.push([message, kind]); };
    await h.update(next);
    let result!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
    await act(async () => { result = await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
    assert.equal(result?.ok, true); assert.equal(result?.opId, p.receipt.opId); assert.equal(result?.sourceRevision, 12);
    assert.deepEqual(result?.changedFiles, p.receipt.changedFiles); assert.equal(p.calls.length, 1);
    assert.equal(result?.diagnostics[0], p.receipt.diagnostics[0]);
    assert.equal(result?.diagnostics.at(-1)?.severity, 'warning');
    assert.equal(result?.diagnostics.at(-1)?.code, phase === 'reload' ? 'POSTCOMMIT_PARAM_RELOAD_FAILED'
      : phase === 'history' ? 'POSTCOMMIT_HISTORY_REFRESH_FAILED' : 'POSTCOMMIT_PARAM_UI_FAILED');
  });
}
it('a container postcommit history rejection preserves native facts as a warning', async () => {
  const p = ports(), h = await mount(p.options);
  await h.update({ ...p.options, refreshOperationHistory: async () => { throw new Error('history failed'); } });
  let result!: Awaited<ReturnType<ParamMutationController['applyContainerParamFieldMutation']>>;
  await act(async () => { result = await h.current().applyContainerParamFieldMutation(fieldInput); });
  assert.equal(result.ok, true); assert.equal(result.opId, 'native-commit'); assert.equal(p.calls.length, 1);
  assert.equal(result.diagnostics.at(-1)?.code, 'POSTCOMMIT_HISTORY_REFRESH_FAILED');
  assert.match(result.message ?? '', /已写入.*操作历史刷新失败/);
  assert.equal(p.toasts.at(-1)?.[1], 'warn');
});
it('late postcommit reload rejection after reset preserves receipt without reporting in the next ownership', async () => {
  const p = ports(), pending = deferred<void>();
  p.options.reloadParamRowsFromSource = () => pending.promise;
  const h = await mount(p.options);
  let saving!: ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>;
  await act(async () => { saving = h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
  await act(async () => h.document().resetParamDocument());
  const count = p.statuses.length;
  let result!: Awaited<typeof saving>;
  await act(async () => { pending.reject(new Error('late readback failed')); result = await saving; });
  assert.equal(result, p.receipt); assert.equal(p.calls.length, 1); assert.equal(p.histories(), 0);
  assert.equal(p.statuses.length, count); assert.deepEqual(p.toasts, []);
});

for (const phase of ['open', 'index'] as const) {
  it(`a structured postcommit ${phase} readback failure remains committed with a warning`, async () => {
    const p = ports(), h = await mount(p.options);
    const diagnostic = { severity: 'error' as const, code: 'SYNTHETIC_READBACK_FAILURE', message: 'owned readback failed' };
    if (phase === 'open') p.options.bridge!.openParamSession = async () => ({ ok: false, diagnostics: [diagnostic] });
    else {
      p.options.bridge!.openParamSession = async request => ({ ...opened(request.sourceUri), rowCount: 3 });
      p.options.bridge!.readParamIndexPage = async () => ({ ok: false, diagnostics: [diagnostic] });
    }
    let result!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
    await act(async () => { result = await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
    assert.equal(result?.ok, true); assert.equal(result?.opId, 'native-commit'); assert.equal(result?.sourceHash, 'written-hash');
    assert.equal(result?.diagnostics.at(-1)?.code, 'POSTCOMMIT_PARAM_RELOAD_FAILED');
    assert.equal(result?.diagnostics.at(-1)?.severity, 'warning');
    assert.equal(p.calls.length, 1); assert.equal(p.histories(), 0);
    assert.equal(h.document().paramIndexDiagnostic, 'owned readback failed');
    assert.equal(p.toasts.at(-1)?.[1], 'warn');
  });
}
it('raw transport failure reports unknown completion without manufacturing a failed receipt or replaying', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.applyParamMutation = async (...args) => { p.calls.push({ method: 'raw', args }); throw new Error('lost receipt'); };
  let result!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
  await act(async () => { result = await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
  assert.equal(result, undefined); assert.equal(p.calls.length, 1); assert.equal(p.histories(), 0); assert.equal(p.reloads.length, 1);
  assert.equal(p.statuses.at(-1), 'PARAM 行写入结果未知，请查看操作历史后再处理。');
  assert.deepEqual(p.toasts, [['PARAM 行写入结果未知，请查看操作历史后再处理。', 'warn']]);
});
it('the raw main boundary still owns missing source-hash fallback', async () => {
  const p = ports();
  p.options.bridge!.openParamSession = async request => ({ ...opened(request.sourceUri), sourceHash: '' });
  const h = await mount(p.options);
  await act(async () => { await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_upsert', id: 11, dataBase64: 'AQID' }); });
  assert.deepEqual(p.calls[0]?.args, [file('a').sourceUri, '', { kind: 'upsert', id: 11, dataBase64: 'AQID' }]);
});
it('reset invalidates retained submission callbacks synchronously before React rerenders', async () => {
  const p = ports(), h = await mount(p.options), old = h.current();
  await act(async () => {
    h.document().resetParamDocument();
    assert.equal((await old.applyContainerParamFieldMutation(fieldInput)).ok, false);
    assert.equal((await old.applyContainerParamRowNameMutation(nameInput)).ok, false);
    assert.equal((await old.applyContainerParamRowMutation(rowInput)).ok, false);
    await old.applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity });
  });
  assert.equal(p.calls.length, 0); assert.equal(p.histories(), 0);
});
it('container native refusals retain every original fallback and row-action error label', async () => {
  const p = ports(), h = await mount(p.options);
  const refusal: RendererSaveResult = { ok: false, changedFiles: [], diagnostics: [] };
  const refused = async () => refusal;
  p.options.bridge!.applyContainerParamFieldMutation = refused;
  p.options.bridge!.applyContainerParamRowNameMutation = refused;
  p.options.bridge!.applyContainerParamRowMutations = refused;
  await act(async () => { const result = await h.current().applyContainerParamFieldMutation(fieldInput); assert.equal(result.message, 'PARAM 字段写入失败。'); });
  assert.equal(p.statuses.at(-1), 'PARAM 字段写入失败：PARAM 字段写入失败。');
  await act(async () => { const result = await h.current().applyContainerParamRowNameMutation(nameInput); assert.equal(result.message, 'PARAM 行名写入失败。'); });
  assert.equal(p.statuses.at(-1), 'PARAM 行名写入失败：PARAM 行名写入失败。');
  for (const kind of ['add', 'copy', 'delete'] as const) {
    await act(async () => { const result = await h.current().applyContainerParamRowMutation({ ...rowInput, kind }); assert.equal(result.message, 'PARAM 行级写入失败。'); });
    assert.equal(p.statuses.at(-1), `PARAM ${kind === 'add' ? '新建' : kind === 'copy' ? '复制' : '删除'}行失败：PARAM 行级写入失败。`);
  }
  assert.equal(p.histories(), 0); assert.equal(p.reloads.length, 1);
});
it('postcommit warning remains a successful receipt even when both renderer notification ports throw', async () => {
  const p = ports(), h = await mount(p.options);
  await h.update({ ...p.options, refreshOperationHistory: async () => { throw new Error('history failed'); },
    setStatus: () => { throw new Error('status failed'); }, pushToast: () => { throw new Error('toast failed'); } });
  let result!: Awaited<ReturnType<ParamMutationController['applyContainerParamRowNameMutation']>>;
  await act(async () => { result = await h.current().applyContainerParamRowNameMutation(nameInput); });
  assert.equal(result.ok, true); assert.equal(result.opId, 'native-commit'); assert.equal(result.sourceRevision, 12);
  assert.equal(result.diagnostics.at(-1)?.code, 'POSTCOMMIT_HISTORY_REFRESH_FAILED'); assert.equal(p.calls.length, 1);
});
it('a structured history failure remains committed with a fixed warning for container and raw commands', async () => {
  const p = ports(), h = await mount(p.options);
  let histories = 0;
  await h.update({ ...p.options, refreshOperationHistory: async () => { histories++; return { ok: false as const }; } });
  let container!: Awaited<ReturnType<ParamMutationController['applyContainerParamFieldMutation']>>;
  let raw!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
  await act(async () => { container = await h.current().applyContainerParamFieldMutation(fieldInput); });
  await act(async () => { raw = await h.current().applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: firstIdentity }); });
  for (const result of [container, raw]) {
    assert.equal(result?.ok, true); assert.equal(result?.opId, 'native-commit'); assert.equal(result?.sourceRevision, 12);
    assert.deepEqual(result?.changedFiles, p.receipt.changedFiles); assert.equal(result?.diagnostics[0], p.receipt.diagnostics[0]);
    assert.equal(result?.diagnostics.at(-1)?.code, 'POSTCOMMIT_HISTORY_REFRESH_FAILED');
    assert.equal(result?.diagnostics.at(-1)?.severity, 'warning');
    assert.match(result?.message ?? '', /操作历史刷新失败/);
  }
  assert.equal(p.calls.length, 2); assert.equal(histories, 2);
  assert.equal(p.toasts.length, 2); assert.equal(p.toasts.every(([, kind]) => kind === 'warn'), true);
});
it('the actual operation-history owner passes a synthetic journal rejection into committed PARAM warnings', async () => {
  const p = ports();
  let historyReads = 0;
  const bridge = { ...p.options.bridge!,
    listOperations: async () => { historyReads++; throw new Error('synthetic private journal reason'); },
    rollbackOperation: async () => { throw new Error('unexpected rollback'); },
    rollbackFile: async () => { throw new Error('unexpected file rollback'); }
  };
  let current!: ParamMutationController, operations!: ChangeOperationsController;
  function Host() {
    const historyRef = useRef<Pick<ChangeOperationsController, 'refreshOperationHistory'> | null>(null);
    const refreshOperationHistory = async (): Promise<OperationHistoryRefreshOutcome> => historyRef.current?.refreshOperationHistory();
    const document = useParamDocumentController({ ...p.options, bridge, refreshOperationHistory });
    operations = useChangeOperationsController({ bridge, workspace: { workspaceSessionId: 'synthetic-workspace' },
      selectedFile: p.options.selectedFile, editDirty: false, fmgSourceHash: null, paramSourceHash: document.paramSourceHash,
      reloadParamRowsFromSource: document.reloadParamRowsFromSource, applyParamFieldMutationFromPanel: document.applyParamFieldMutationFromPanel,
      applyTextResourceAndReload: async () => { throw new Error('unexpected text mutation'); },
      applyFmgMutationAndReload: async () => { throw new Error('unexpected FMG mutation'); },
      setStatus: p.options.setStatus, pushToast: p.options.pushToast, describeBridgeAbsence: p.options.describeBridgeAbsence,
      announceDesktopOnly: () => { throw new Error('unexpected desktop announcement'); },
      onRollbackCommitted: async () => { throw new Error('unexpected rollback continuation'); }
    });
    historyRef.current = operations;
    current = useParamMutationController({ ...p.options, bridge, refreshOperationHistory,
      paramLive: document.paramLive, paramSourceHash: document.paramSourceHash, paramRowPayloads: document.paramRowPayloads,
      reloadParamRowsFromSource: document.reloadParamRowsFromSource, ownsParamDocument: document.ownsParamDocument });
    return <span>{document.paramTypeName}:{operations.operationHistory.length}</span>;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Host />); });
  mounted.push(renderer);
  let container!: Awaited<ReturnType<ParamMutationController['applyContainerParamFieldMutation']>>;
  let raw!: Awaited<ReturnType<ParamMutationController['applyParamRowMutationFromPanel']>>;
  await act(async () => { container = await current.applyContainerParamFieldMutation(fieldInput); });
  await act(async () => { raw = await current.applyParamRowMutationFromPanel({ kind: 'param_row_delete', id: 10, identity: secondIdentity }); });
  for (const result of [container, raw]) {
    assert.equal(result?.ok, true); assert.equal(result?.opId, p.receipt.opId);
    assert.equal(result?.changedFiles, p.receipt.changedFiles); assert.equal(result?.sourceHash, p.receipt.sourceHash);
    assert.equal(result?.sourceRevision, p.receipt.sourceRevision); assert.equal(result?.diagnostics[0], p.receipt.diagnostics[0]);
    assert.equal(result?.diagnostics.at(-1)?.code, 'POSTCOMMIT_HISTORY_REFRESH_FAILED');
    assert.equal(result?.diagnostics.at(-1)?.severity, 'warning');
    assert.match(result?.message ?? '', /操作历史刷新失败/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic private journal reason/);
  }
  assert.equal(historyReads, 2);
  assert.deepEqual(p.calls.map(call => call.method), ['field', 'raw']);
  assert.deepEqual(p.calls[1]?.args, [file('a').sourceUri, 'native-file-hash',
    { kind: 'delete', id: 10, rowIndex: 1, expectedDataHash: 'second-row-hash' }]);
  assert.deepEqual(operations.operationHistory, []); assert.deepEqual(operations.changeState.items, []);
  assert.equal(p.toasts.filter(([message, kind]) => message.includes('操作历史刷新失败') && kind === 'warn').length, 2);
});
