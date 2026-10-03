import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import {
  useTextDocumentController,
  type TextDocumentBridge,
  type TextDocumentController,
  type TextDocumentOptions,
  type TextDocumentReadResult
} from './useTextDocumentController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  while (mounted.length) await act(async () => mounted.pop()!.unmount());
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name: string): NonNullable<TextDocumentOptions['selectedFile']> {
  return { sourceUri: `resource://owned/${name}`, relativePath: `msg/engus/${name}.msgbnd.dcx`,
    resourceKind: 'msg', formatKind: 'bnd', compoundExtension: '.msgbnd.dcx' };
}
function opened(name: string): TextDocumentReadResult {
  return { ok: true, data: { sourceHash: `hash-${name}`, entries: [{ id: 0, text: `text-${name}` }],
    entryCount: 20000, authority: 'native-verified' } };
}
function ports() {
  const reads: string[] = [], statuses: string[] = [], toasts: Array<[string, string | undefined]> = [];
  const bridge: TextDocumentBridge = {
    readFmgDocument: async source => { reads.push(source); return opened(source.endsWith('/b') ? 'b' : 'a'); },
    applyFmgMutation: async () => ({ ok: true, changedFiles: [], diagnostics: [] })
  };
  const options: TextDocumentOptions = { bridge, selectedFile: file('a'), setStatus: message => statuses.push(message), pushToast: (text, kind) => toasts.push([text, kind]) };
  return { options, reads, statuses, toasts };
}
async function mount(options: TextDocumentOptions, strict = false) {
  let current!: TextDocumentController;
  function Host({ options }: { options: TextDocumentOptions }) {
    current = useTextDocumentController(options);
    return <span>{current.fmgEntries[0]?.text}</span>;
  }
  const element = (options: TextDocumentOptions) => strict
    ? <React.StrictMode><Host options={options} /></React.StrictMode> : <Host options={options} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); });
  mounted.push(renderer);
  return { current: () => current,
    update: async (options: TextDocumentOptions) => act(async () => renderer.update(element(options))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}
function assertEmpty(controller: TextDocumentController) {
  assert.deepEqual(controller.fmgEntries, []);
  assert.equal(controller.fmgSourceHash, null);
  assert.equal(controller.fmgLive, false);
}

it('loads only the selected logical FMG and preserves native source authority and count feedback', async () => {
  const p = ports(), h = await mount(p.options);
  assert.deepEqual(p.reads, [file('a').sourceUri]);
  assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: 'text-a' }]);
  assert.equal(h.current().fmgSourceHash, 'hash-a');
  assert.equal(h.current().fmgLive, true);
  assert.deepEqual(p.statuses, ['正在读取 FMG：msg/engus/a.msgbnd.dcx', '已加载 FMG：20000 条 · 读取级别：原生读取已验证']);
});

it('a lawful empty native table remains live when a source hash is present', async () => {
  for (const data of [{ sourceHash: 'empty-table', entries: [], entryCount: 0 }, { sourceHash: 'empty-container' }]) {
    const p = ports();
    p.options.bridge!.readFmgDocument = async () => ({ ok: true, data });
    const h = await mount(p.options);
    assert.deepEqual(h.current().fmgEntries, []);
    assert.equal(h.current().fmgLive, true);
    assert.equal(h.current().fmgSourceHash, data.sourceHash);
    assert.equal(p.statuses.at(-1), '已加载 FMG：0 条');
  }
});

it('native failures and missing hashes clear the projection without inventing live authority', async () => {
  for (const result of [{ ok: false }, { ok: true }, { ok: true, data: { entries: [{ id: 1, text: 'unverified' }] } },
    { ok: true, data: { sourceHash: '', entries: [] } }]) {
    const p = ports(), h = await mount(p.options);
    p.options.bridge!.readFmgDocument = async () => result;
    await h.update({ ...p.options, selectedFile: file('b') });
    assertEmpty(h.current());
    assert.equal(p.statuses.at(-1), '这个文本资源读不出来。');
  }
});

it('read exceptions clear previous entries and hash as well as live status', async () => {
  for (const error of [new Error('sanitized native error'), 'synthetic failure']) {
    const p = ports(), h = await mount(p.options);
    p.options.bridge!.readFmgDocument = async () => { throw error; };
    await h.update({ ...p.options, selectedFile: file('b') });
    assertEmpty(h.current());
    assert.equal(p.statuses.at(-1), error instanceof Error ? error.message : 'FMG 读取异常');
  }
});

it('no selection, another format, or unavailable bridge clears FMG without a fallback read', async () => {
  const other: NonNullable<TextDocumentOptions['selectedFile']> = {
    ...file('b'), relativePath: 'param/b.param', formatKind: 'param', compoundExtension: '.param'
  };
  for (const override of [{ selectedFile: null }, { selectedFile: other }, { bridge: null },
    { bridge: {} as TextDocumentBridge }]) {
    const p = ports(), h = await mount(p.options);
    await h.update({ ...p.options, ...override });
    assertEmpty(h.current());
    assert.equal(p.reads.length, 1);
  }
});

it('selecting another FMG clears the old projection before its deferred read finishes', async () => {
  const p = ports(), h = await mount(p.options), next = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = () => next.promise;
  await h.update({ ...p.options, selectedFile: file('b') });
  assertEmpty(h.current());
  await act(async () => next.resolve(opened('b')));
  assert.equal(h.current().fmgSourceHash, 'hash-b');
});

it('late old success or error cannot replace a newer selection or publish status', async () => {
  for (const rejects of [false, true]) {
    const p = ports(), old = deferred<TextDocumentReadResult>();
    p.options.bridge!.readFmgDocument = source => source.endsWith('/a') ? old.promise : Promise.resolve(opened('b'));
    const h = await mount(p.options);
    await h.update({ ...p.options, selectedFile: file('b') });
    const statuses = p.statuses.length;
    await act(async () => rejects ? old.reject(new Error('obsolete error')) : old.resolve(opened('a')));
    assert.equal(h.current().fmgSourceHash, 'hash-b');
    assert.equal(p.statuses.length, statuses);
  }
});

it('reset invalidates an awaited native read immediately and does not reopen the same selection', async () => {
  const p = ports(), pending = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = source => { p.reads.push(source); return pending.promise; };
  const h = await mount(p.options), statuses = p.statuses.length;
  await act(async () => { h.current().resetTextDocument(); pending.resolve(opened('a')); });
  assertEmpty(h.current());
  assert.equal(p.reads.length, 1);
  assert.equal(p.statuses.length, statuses);
});

it('feedback-only rerenders keep native reads and the reset callback stable', async () => {
  const p = ports(), h = await mount(p.options), reset = h.current().resetTextDocument;
  await h.update({ ...p.options, setStatus: () => undefined });
  assert.equal(p.reads.length, 1);
  assert.equal(h.current().resetTextDocument, reset);
  await act(async () => reset());
  assertEmpty(h.current());
  await h.update({ ...p.options, selectedFile: file('b') });
  assert.equal(h.current().fmgSourceHash, 'hash-b');
});

it('bridge replacement invalidates the old native read', async () => {
  const p = ports(), old = deferred<TextDocumentReadResult>(), next = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = () => old.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, bridge: { ...p.options.bridge!, readFmgDocument: () => next.promise } });
  await act(async () => old.resolve(opened('a')));
  assertEmpty(h.current());
  await act(async () => next.resolve(opened('b')));
  assert.equal(h.current().fmgSourceHash, 'hash-b');
});

it('unmount suppresses late success and late rejected read feedback', async () => {
  for (const rejects of [false, true]) {
    const p = ports(), pending = deferred<TextDocumentReadResult>();
    p.options.bridge!.readFmgDocument = () => pending.promise;
    const h = await mount(p.options), statuses = p.statuses.length;
    await h.unmount();
    await act(async () => rejects ? pending.reject(new Error('unmounted failure')) : pending.resolve(opened('a')));
    assert.equal(p.statuses.length, statuses);
  }
});

it('strict lifecycle cleanup suppresses the obsolete first full read', async () => {
  const p = ports(), old = deferred<TextDocumentReadResult>(), next = deferred<TextDocumentReadResult>();
  let reads = 0;
  p.options.bridge!.readFmgDocument = () => ++reads === 1 ? old.promise : next.promise;
  const h = await mount(p.options, true);
  assert.equal(reads, 2);
  await act(async () => old.resolve(opened('a')));
  assertEmpty(h.current());
  await act(async () => next.resolve(opened('b')));
  assert.equal(h.current().fmgSourceHash, 'hash-b');
});

it('current setters publish readback entries and hash without a native write or reread', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => {
    h.current().setFmgEntries([{ id: 0, text: '' }]);
    h.current().setFmgSourceHash('committed-hash');
  });
  assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: '' }]);
  assert.equal(h.current().fmgSourceHash, 'committed-hash');
  assert.equal(h.current().fmgLive, true);
  assert.equal(p.reads.length, 1);
});

it('captured readback setters cannot replace a later selection, including a return to the same source', async () => {
  const p = ports(), h = await mount(p.options), old = h.current();
  await h.update({ ...p.options, selectedFile: file('b') });
  await h.update(p.options);
  await act(async () => { old.setFmgEntries([{ id: 88, text: 'obsolete' }]); old.setFmgSourceHash('obsolete'); });
  assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: 'text-a' }]);
  assert.equal(h.current().fmgSourceHash, 'hash-a');
});

it('reset rejects captured readback setters even before rerender', async () => {
  const p = ports(), h = await mount(p.options), old = h.current();
  await act(async () => {
    old.resetTextDocument(); old.setFmgEntries([{ id: 88, text: 'obsolete' }]); old.setFmgSourceHash('obsolete');
  });
  assertEmpty(h.current());
  assert.equal(p.reads.length, 1);
});

it('bridge replacement rejects captured readback setters', async () => {
  const p = ports(), h = await mount(p.options), old = h.current();
  await h.update({ ...p.options, bridge: { ...p.options.bridge!, readFmgDocument: async () => opened('b') } });
  await act(async () => { old.setFmgEntries([{ id: 88, text: 'obsolete' }]); old.setFmgSourceHash('obsolete'); });
  assert.equal(h.current().fmgSourceHash, 'hash-b');
  assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: 'text-b' }]);
});

it('current committed readback reloads once and publishes a lawful empty table', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.readFmgDocument = async source => { p.reads.push(source); return { ok: true, data: { sourceHash: 'committed', entries: [] } }; };
  await act(async () => { await h.current().reloadFmgDocument(file('a').sourceUri); });
  assert.deepEqual(h.current().fmgEntries, []);
  assert.equal(h.current().fmgSourceHash, 'committed');
  assert.equal(h.current().fmgLive, true);
  assert.equal(p.reads.length, 2);
});

it('a deferred native receipt can retain success while its captured setters lose publication ownership', async () => {
  const p = ports(), h = await mount(p.options), old = h.current();
  const submission = deferred<{ ok: true; operationId: string; sourceHash: string }>();
  const work = (async () => {
    const receipt = await submission.promise;
    old.setFmgEntries([{ id: 88, text: 'previous resource commit' }]);
    old.setFmgSourceHash(receipt.sourceHash);
    return receipt;
  })();
  await h.update({ ...p.options, selectedFile: file('b') });
  const receipt = { ok: true as const, operationId: 'native-commit', sourceHash: 'old-commit-hash' };
  await act(async () => { submission.resolve(receipt); assert.equal(await work, receipt); });
  assert.equal(h.current().fmgSourceHash, 'hash-b');
  assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: 'text-b' }]);
  assert.equal(p.reads.length, 2);
});

it('a successful native receipt stays successful when a late readback belongs to an obsolete selection', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<TextDocumentReadResult>(), reload = h.current().reloadFmgDocument;
  p.options.bridge!.readFmgDocument = source => { p.reads.push(source); return source.endsWith('/a') ? pending.promise : Promise.resolve(opened('b')); };
  const receipt = { ok: true as const, operationId: 'native-commit-owned-by-main' };
  const committed = (async () => { await reload(file('a').sourceUri); return receipt; })();
  await h.update({ ...p.options, selectedFile: file('b') });
  let result!: typeof receipt;
  await act(async () => { pending.resolve(opened('obsolete-committed')); result = await committed; });
  assert.equal(result, receipt);
  assert.equal(h.current().fmgSourceHash, 'hash-b');
  assert.equal(p.reads.length, 3);
});

it('stale reload callbacks and nonselected source URIs do not dispatch native reads', async () => {
  const p = ports(), h = await mount(p.options), oldReload = h.current().reloadFmgDocument;
  await h.update({ ...p.options, selectedFile: file('b') });
  await act(async () => {
    assert.equal(await oldReload(file('a').sourceUri), null);
    assert.equal(await h.current().reloadFmgDocument(file('a').sourceUri), null);
  });
  assert.equal(p.reads.length, 2);
});

it('reset and bridge replacement suppress deferred committed readback publication', async () => {
  for (const replaceBridge of [false, true]) {
    const p = ports(), h = await mount(p.options), pending = deferred<TextDocumentReadResult>();
    p.options.bridge!.readFmgDocument = () => pending.promise;
    const work = h.current().reloadFmgDocument(file('a').sourceUri);
    if (replaceBridge) await h.update({ ...p.options, bridge: { ...p.options.bridge!, readFmgDocument: async () => opened('b') } });
    else await act(async () => h.current().resetTextDocument());
    await act(async () => { pending.resolve(opened('obsolete')); assert.equal(await work, null); });
    if (replaceBridge) assert.equal(h.current().fmgSourceHash, 'hash-b');
    else assertEmpty(h.current());
  }
});

it('unmount prevents captured setters and reloads from dispatching or publishing late readback', async () => {
  const p = ports(), h = await mount(p.options), old = h.current(), pending = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = source => { p.reads.push(source); return pending.promise; };
  const work = old.reloadFmgDocument(file('a').sourceUri);
  await h.unmount();
  await act(async () => {
    old.setFmgEntries([{ id: 88, text: 'obsolete' }]); old.setFmgSourceHash('obsolete');
    pending.resolve(opened('obsolete')); assert.equal(await work, null);
    assert.equal(await old.reloadFmgDocument(file('a').sourceUri), null);
  });
  assert.equal(p.reads.length, 2);
});

it('a newer current readback supersedes an older current readback without replaying either read', async () => {
  const p = ports(), h = await mount(p.options), old = deferred<TextDocumentReadResult>(), next = deferred<TextDocumentReadResult>();
  let reloads = 0;
  p.options.bridge!.readFmgDocument = () => ++reloads === 1 ? old.promise : next.promise;
  const first = h.current().reloadFmgDocument(file('a').sourceUri);
  const second = h.current().reloadFmgDocument(file('a').sourceUri);
  await act(async () => { next.resolve(opened('newest-commit')); await second; });
  await act(async () => { old.resolve(opened('older-commit')); assert.equal(await first, null); });
  assert.equal(h.current().fmgSourceHash, 'hash-newest-commit');
  assert.equal(reloads, 2);
});

it('unconfirmed readback results cannot replace current native authority or trigger a retry', async () => {
  for (const result of [{ ok: false }, { ok: true, data: { entries: [{ id: 88, text: 'unconfirmed' }] } }]) {
    const p = ports(), h = await mount(p.options), statuses = p.statuses.length;
    p.options.bridge!.readFmgDocument = async source => { p.reads.push(source); return result; };
    await act(async () => { assert.equal(await h.current().reloadFmgDocument(file('a').sourceUri), result); });
    assert.equal(h.current().fmgSourceHash, 'hash-a');
    assert.deepEqual(h.current().fmgEntries, [{ id: 0, text: 'text-a' }]);
    assert.equal(p.reads.length, 2);
    assert.equal(p.statuses.length, statuses);
  }
});

it('current readback exceptions propagate once while obsolete readback exceptions lose publication ownership', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<TextDocumentReadResult>();
  let reloads = 0;
  p.options.bridge!.readFmgDocument = () => { reloads++; return pending.promise; };
  const current = h.current().reloadFmgDocument(file('a').sourceUri);
  const failed = assert.rejects(current, /current readback failure/);
  await act(async () => { pending.reject(new Error('current readback failure')); await failed; });
  assert.equal(reloads, 1);
  assert.equal(h.current().fmgSourceHash, 'hash-a');
  const old = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = () => { reloads++; return old.promise; };
  const work = h.current().reloadFmgDocument(file('a').sourceUri);
  await act(async () => h.current().resetTextDocument());
  await act(async () => { old.reject(new Error('obsolete readback failure')); assert.equal(await work, null); });
  assertEmpty(h.current());
  assert.equal(reloads, 2);
});

it('panel entry mutations retain exact URI/hash/table arguments and immediate successful feedback', async () => {
  for (const kind of ['fmg_entry_upsert', 'fmg_entry_add', 'fmg_entry_delete'] as const) {
    const p = ports(), h = await mount(p.options), writes: unknown[][] = [];
    p.options.bridge!.applyFmgMutation = async (...args) => { writes.push(args); return { ok: true, changedFiles: [], diagnostics: [] }; };
    await act(async () => h.current().submitFmgEntry({ kind, id: 12, text: '', tableId: 'owned-table' }));
    assert.deepEqual(writes, [[file('a').sourceUri, 'hash-a', { kind: kind === 'fmg_entry_delete' ? 'delete' : kind === 'fmg_entry_add' ? 'add' : 'upsert', id: 12, text: '' }, 'owned-table']]);
    assert.equal(p.reads.length, 2); assert.equal(p.statuses.at(-1), kind === 'fmg_entry_delete' ? '条目已删除。' : '已保存。');
  }
});
it('retained panel and staged callbacks cannot start a write after reset or selection change', async () => {
  for (const change of ['reset', 'selection'] as const) {
    const p = ports(), h = await mount(p.options); let writes = 0;
    p.options.bridge!.applyFmgMutation = async () => { writes++; return { ok: true, changedFiles: [], diagnostics: [] }; };
    const panel = h.current().submitFmgEntry, staged = h.current().applyFmgMutationAndReload;
    if (change === 'reset') await act(async () => h.current().resetTextDocument()); else await h.update({ ...p.options, selectedFile: file('b') });
    await panel({ kind: 'fmg_entry_upsert', id: 12, text: 'old' });
    const result = await staged(file('a').sourceUri, 'hash-a', { kind: 'upsert', id: 12, text: 'old' });
    assert.equal(result.ok, false); assert.equal(writes, 0);
  }
});
it('a pending committed FMG write keeps its receipt after reset and skips stale readback', async () => {
  const p = ports(), h = await mount(p.options);
  const receipt = { ok: true, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' };
  const pending = deferred<typeof receipt>(); let writes = 0;
  p.options.bridge!.applyFmgMutation = () => { writes++; return pending.promise; };
  let saving!: ReturnType<TextDocumentController['applyFmgMutationAndReload']>;
  await act(async () => { saving = h.current().applyFmgMutationAndReload(file('a').sourceUri, 'hash-a', { kind: 'upsert', id: 12, text: 'saved' }); });
  await act(async () => h.current().resetTextDocument());
  let result!: Awaited<typeof saving>; await act(async () => { pending.resolve(receipt); result = await saving; });
  assert.equal(result, receipt); assert.equal(writes, 1); assert.equal(p.reads.length, 1); assertEmpty(h.current());
});
it('a staged committed result survives reload rejection with a fixed warning and original operation facts', async () => {
  const p = ports(), h = await mount(p.options);
  const receipt = { ok: true, changedFiles: ['resource://owned/a'], diagnostics: [], opId: 'owned-commit' }; let writes = 0;
  p.options.bridge!.applyFmgMutation = async () => { writes++; return receipt; };
  p.options.bridge!.readFmgDocument = async () => { throw new Error('owned readback rejection'); };
  let result!: Awaited<ReturnType<TextDocumentController['applyFmgMutationAndReload']>>;
  await act(async () => { result = await h.current().applyFmgMutationAndReload(file('a').sourceUri, 'hash-a', { kind: 'upsert', id: 12, text: 'saved' }); });
  assert.equal(result.ok, true); assert.equal((result as typeof receipt).opId, receipt.opId); assert.deepEqual(result.changedFiles, receipt.changedFiles);
  assert.equal(result.diagnostics.at(-1)?.code, 'POSTCOMMIT_FMG_RELOAD_FAILED'); assert.equal(writes, 1);
});
it('native FMG rejection and native thrown error retain their original diagnostics/error without readback or replay', async () => {
  const p = ports(), h = await mount(p.options), diagnostics = [{ severity: 'error' as const, code: 'OWNED_REJECTED', message: 'owned rejection' }];
  p.options.bridge!.applyFmgMutation = async () => ({ ok: false, changedFiles: [], diagnostics });
  const result = await h.current().applyFmgMutationAndReload(file('a').sourceUri, 'hash-a', { kind: 'delete', id: 12 });
  assert.equal(result.ok, false); assert.deepEqual(result.diagnostics, diagnostics); assert.equal(p.reads.length, 1);
  const error = new Error('owned native rejection'); p.options.bridge!.applyFmgMutation = async () => { throw error; };
  await assert.rejects(h.current().applyFmgMutationAndReload(file('a').sourceUri, 'hash-a', { kind: 'delete', id: 12 }), received => received === error);
});

it('panel success feedback occurs before deferred readback, and a readback rejection stays a committed warning', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<TextDocumentReadResult>();
  p.options.bridge!.readFmgDocument = () => pending.promise;
  let saving!: Promise<void>;
  await act(async () => { saving = h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'saved' }); });
  assert.equal(p.statuses.at(-1), '已保存。'); assert.deepEqual(p.toasts, [['已保存', undefined]]);
  await act(async () => { pending.reject(new Error('owned readback failure')); await saving; });
  assert.equal(p.toasts.at(-1)?.[1], 'warn'); assert.equal(p.statuses.at(-1), '文本已保存，但条目重读失败。');
});
it('a stale panel commit completion cannot emit feedback or begin readback in the next document', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<TextDocumentBridge['applyFmgMutation']>>>();
  let writes = 0; p.options.bridge!.applyFmgMutation = () => { writes++; return pending.promise; };
  let saving!: Promise<void>; await act(async () => { saving = h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'saved' }); });
  await h.update({ ...p.options, selectedFile: file('b') });
  await act(async () => { pending.resolve({ ok: true, changedFiles: ['resource://owned/a'], diagnostics: [] }); await saving; });
  assert.equal(writes, 1); assert.equal(p.reads.length, 2); assert.deepEqual(p.toasts, []); assert.equal(h.current().fmgSourceHash, 'hash-b');
});
it('a current staged offscreen target retains caller hash/table routing without publishing into the selected FMG', async () => {
  const p = ports(), h = await mount(p.options), writes: unknown[][] = [];
  p.options.bridge!.applyFmgMutation = async (...args) => { writes.push(args); return { ok: true, changedFiles: ['resource://owned/b'], diagnostics: [] }; };
  const result = await h.current().applyFmgMutationAndReload(file('b').sourceUri, 'hash-b', { kind: 'delete', id: 12 }, 'table-b');
  assert.equal(result.ok, true); assert.deepEqual(writes, [[file('b').sourceUri, 'hash-b', { kind: 'delete', id: 12 }, 'table-b']]);
  assert.equal(h.current().fmgSourceHash, 'hash-a'); assert.equal(p.reads.length, 1);
});

it('panel native rejection publishes its code and human diagnostic without readback or replay', async () => {
  const p = ports(), h = await mount(p.options);
  const diagnostics = [{ severity: 'error' as const, code: 'ORIGINAL_CHANGED_DURING_STAGING', message: '目标已被外部修改；未写入任何内容。' }];
  const receipt = { ok: false, changedFiles: [], diagnostics }; let writes = 0;
  p.options.bridge!.applyFmgMutation = async () => { writes++; return receipt; };
  await act(async () => h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'draft' }));
  assert.match(p.toasts.at(-1)?.[0] ?? '', /ORIGINAL_CHANGED_DURING_STAGING.*目标已被外部修改/);
  assert.equal(p.toasts.at(-1)?.[1], 'warn'); assert.equal(p.statuses.at(-1), p.toasts.at(-1)?.[0]);
  assert.equal(writes, 1); assert.equal(p.reads.length, 1); assert.equal(receipt.diagnostics, diagnostics);
});
it('panel native exceptions publish visible warnings without claiming a commit or starting readback', async () => {
  const p = ports(), h = await mount(p.options); let writes = 0;
  p.options.bridge!.applyFmgMutation = async () => { writes++; throw new Error('owned bridge failure'); };
  await act(async () => h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'draft' }));
  assert.match(p.toasts.at(-1)?.[0] ?? '', /FMG 写入异常.*owned bridge failure/);
  assert.equal(p.toasts.at(-1)?.[1], 'warn'); assert.equal(p.statuses.at(-1), p.toasts.at(-1)?.[0]);
  assert.equal(writes, 1); assert.equal(p.reads.length, 1);
});
it('panel unavailable-document and unavailable-writer failures are visible and do not start a write', async () => {
  for (const unavailable of ['document', 'writer'] as const) {
    const p = ports(); let writes = 0;
    if (unavailable === 'document') p.options.bridge!.readFmgDocument = async () => ({ ok: false });
    p.options.bridge!.applyFmgMutation = async () => { writes++; return { ok: true, changedFiles: [], diagnostics: [] }; };
    const h = await mount(p.options);
    if (unavailable === 'writer') delete (p.options.bridge as Partial<TextDocumentBridge>).applyFmgMutation;
    await act(async () => h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'draft' }));
    assert.match(p.toasts.at(-1)?.[0] ?? '', unavailable === 'document' ? /未实时加载/ : /写入通道不可用/);
    assert.equal(p.toasts.at(-1)?.[1], 'warn'); assert.equal(writes, 0);
  }
});
it('obsolete panel native rejections and exceptions cannot publish warnings into the next document', async () => {
  for (const failure of ['receipt', 'exception'] as const) {
    const p = ports(), h = await mount(p.options), pending = deferred<Awaited<ReturnType<TextDocumentBridge['applyFmgMutation']>>>();
    p.options.bridge!.applyFmgMutation = () => pending.promise;
    let saving!: Promise<void>; await act(async () => { saving = h.current().submitFmgEntry({ kind: 'fmg_entry_upsert', id: 12, text: 'draft' }); });
    await h.update({ ...p.options, selectedFile: file('b') });
    await act(async () => {
      if (failure === 'receipt') pending.resolve({ ok: false, changedFiles: [], diagnostics: [{ severity: 'error', code: 'STALE_FAILURE', message: 'old document failure' }] });
      else pending.reject(new Error('old document failure'));
      await saving;
    });
    assert.deepEqual(p.toasts, []); assert.equal(h.current().fmgSourceHash, 'hash-b'); assert.equal(p.reads.length, 2);
  }
});
