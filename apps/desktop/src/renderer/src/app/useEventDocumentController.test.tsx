import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import {
  useEventDocumentController,
  type EventDocumentController,
  type EventDocumentOptions,
  type EventDocumentOpenFailure,
  type EventDocumentBridge
} from './useEventDocumentController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    await act(async () => renderer.unmount());
  }
});

type FullDocument = Awaited<ReturnType<EventDocumentBridge['readEmevdFullDocument']>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name: string): NonNullable<EventDocumentOptions['selectedFile']> {
  return {
    sourceUri: `resource://owned/${name}`,
    relativePath: `event/${name}.emevd.dcx`,
    resourceKind: 'event',
    formatKind: 'emevd',
    compoundExtension: '.emevd.dcx'
  };
}
function opened(name: string, overrides: Partial<FullDocument> = {}): FullDocument {
  return {
    ok: true,
    sourceHash: `hash-${name}`,
    documentInstanceId: `document-${name}`,
    revision: 4,
    sourcePrefix: '$Event(10, Default, function() {\n});',
    sourceToken: `source-${name}`,
    sourceTotalLines: 70000,
    sourceStyle: 'dark-script',
    authority: 'candidate',
    outline: {
      schemaVersion: 1,
      resourceUri: file(name).sourceUri,
      eventCount: 5000,
      instructionTotal: 33000,
      truncated: true,
      limit: 4096,
      events: [{ eventUri: 'event://10', eventId: 10, restBehavior: 0, layer: 0, instructionCount: 30, unknownCount: 2 }]
    },
    ...overrides
  };
}
function ports() {
  const reads: unknown[][] = [];
  const cancellations: unknown[][] = [];
  const statuses: string[] = [];
  const failures: Array<EventDocumentOpenFailure | null> = [];
  const bridge: EventDocumentBridge = {
    readEmevdFullDocument: async (...args) => {
      reads.push(args);
      return opened(args[0].endsWith('/b') ? 'b' : 'a');
    },
    cancelEmevdFullDocument: async (...args) => {
      cancellations.push(args);
      return { ok: true, cancelled: true };
    },
    readEmevdSourceSlice: async () => { throw new Error('Opening must never materialize source slices'); },
    submitEmevdDslPlan: async () => ({ ok: true, changedFiles: [], diagnostics: [] })
  };
  const options: EventDocumentOptions = {
    bridge,
    selectedFile: file('a'),
    setStatus: message => statuses.push(message),
    onEventOpenFailure: failure => failures.push(failure),
    describeBridgeAbsence: operation => `unavailable:${operation}`
  };
  return { options, reads, cancellations, statuses, failures };
}
async function mount(options: EventDocumentOptions, strict = false) {
  let current!: EventDocumentController;
  function Host({ options }: { options: EventDocumentOptions }) {
    current = useEventDocumentController(options);
    return <span>{current.eventPendingTab?.title}</span>;
  }
  const element = (options: EventDocumentOptions) => strict
    ? <React.StrictMode><Host options={options} /></React.StrictMode>
    : <Host options={options} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); });
  mounted.push(renderer);
  return {
    current: () => current,
    update: async (options: EventDocumentOptions) => act(async () => renderer.update(element(options))),
    unmount: async () => {
      mounted.splice(mounted.indexOf(renderer), 1);
      await act(async () => renderer.unmount());
    }
  };
}

it('opens the selected logical source once and retains a bounded native outline and opaque incremental source', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async (...args) => {
    p.reads.push(args);
    return opened('a', { dslTemplate: 'full text must stay out of the incremental first frame' });
  };
  const h = await mount(p.options);
  assert.equal(p.reads.length, 1);
  assert.equal(p.reads[0]?.length, 2, 'Opening must not opt into full DSL materialization');
  assert.equal(p.reads[0]?.[0], file('a').sourceUri);
  assert.match(p.reads[0]?.[1] as string, /^renderer-resource:\/\/owned\/a-\d+$/);
  const tab = h.current().eventPendingTab!;
  assert.equal(tab.tabId, file('a').sourceUri);
  assert.equal(tab.title, 'a');
  assert.equal(tab.resourceUri, file('a').sourceUri);
  assert.equal(tab.sourceHash, 'hash-a');
  assert.equal(tab.live, true);
  assert.equal(tab.dslTemplate, null);
  assert.equal(tab.sourceToken, 'source-a');
  assert.equal(tab.sourcePrefix, opened('a').sourcePrefix);
  assert.equal(tab.sourceTotalLines, 70000);
  assert.equal(tab.dslTemplateTotalLines, 70000);
  assert.equal(tab.document.documentInstanceId, 'document-a');
  assert.equal(tab.document.revision, 4);
  assert.equal(tab.document.bytesBase64, '');
  assert.deepEqual(tab.document.events, []);
  assert.deepEqual(tab.eventWarnings, [{ eventId: 10, warnings: 2 }]);
  assert.deepEqual(tab.document.diagnostics.map(diagnostic => diagnostic.code), [
    'EMEVD_INSTRUCTION_BODIES_STAY_IN_MAIN', 'EMEVD_OUTLINE_TRUNCATED'
  ]);
  assert.equal(h.current().eventOpening, false);
  assert.equal(h.current().eventSourcePreview, null);
  assert.deepEqual(p.failures, [null]);
  assert.equal(p.statuses.at(-1), '已加载 EMEVD：5000 事件 / 33000 指令（读取级别：候选读取）');
});

it('legacy template responses preserve source style inference, line counts, hash and title', async () => {
  const p = ports();
  p.options.selectedFile = { ...file('a'), relativePath: 'event\\common_func.emevd.dcx' };
  p.options.bridge!.readEmevdFullDocument = async () => ({
    ok: true, sourceHash: 'legacy-hash', dslTemplate: '$Event(1, Default, function() {\n});',
    dslTemplateTruncated: true, sourceStyle: 'none', authority: 'native-verified',
    eventCount: 1, instructionCount: 5
  });
  const h = await mount(p.options);
  const tab = h.current().eventPendingTab!;
  assert.equal(tab.title, 'common_func');
  assert.equal(tab.sourceStyle, 'dark-script');
  assert.equal(tab.dslTemplateTotalLines, 2);
  assert.equal(tab.dslTemplateTruncated, true);
  assert.equal(tab.sourceHash, 'legacy-hash');
  assert.equal(tab.sourceToken, undefined);
  assert.equal(p.statuses.at(-1), '已加载 EMEVD：1 事件 / 5 指令（读取级别：原生读取已验证）');
});

it('empty incremental prefixes remain valid and EMEDF source-none responses stay fail closed', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async () => opened('a', { sourcePrefix: '' });
  const h = await mount(p.options);
  assert.equal(h.current().eventPendingTab?.sourcePrefix, '');
  assert.equal(h.current().eventPendingTab?.dslTemplate, null);
  await h.update({ ...p.options, selectedFile: file('b'), bridge: {
    ...p.options.bridge!, readEmevdFullDocument: async () => ({ ok: true, sourceStyle: 'none', sourceHash: 'hash-b' })
  } });
  assert.equal(h.current().eventPendingTab?.sourceStyle, 'none');
  assert.equal(h.current().eventPendingTab?.dslTemplate, null);
  assert.equal(h.current().eventPendingTab?.live, true);
});

it('native read failures retain sanitized logical-document diagnostics and a non-live failure tab', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async () => ({ ok: false, diagnostics: [{
    severity: 'error', code: 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE', message: '选择原版目录后再打开。'
  }] });
  const h = await mount(p.options);
  assert.deepEqual(p.failures, [{ kind: 'event-open-failed', document: file('a').relativePath,
    code: 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE', message: '选择原版目录后再打开。' }]);
  const tab = h.current().eventPendingTab!;
  assert.equal(tab.live, false);
  assert.equal(tab.sourceHash, null);
  assert.equal(tab.sourceStyle, 'none');
  assert.equal(tab.dslTemplate, null);
  assert.deepEqual(tab.document.diagnostics, [{ severity: 'error',
    code: 'EMEVD_DOCUMENT_KRAK_OODLE_UNAVAILABLE', message: '选择原版目录后再打开。' }]);
  assert.equal(h.current().eventOpening, false);
  assert.equal(p.statuses.at(-1), '这个事件脚本读不出来。');
});

it('missing native diagnostics use the existing fallback failure code and message without retry', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async (...args) => { p.reads.push(args); return { ok: false }; };
  const h = await mount(p.options);
  assert.deepEqual(p.failures, [{ kind: 'event-open-failed', document: file('a').relativePath,
    code: 'EMEVD_LIVE_READ_FAILED', message: '这个事件脚本读不出来。' }]);
  assert.equal(h.current().eventPendingTab?.live, false);
  assert.equal(p.reads.length, 1);
});

it('native cancellation is silent and does not replay the open', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async (...args) => { p.reads.push(args); return { ok: false, cancelled: true }; };
  const h = await mount(p.options);
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventOpening, false);
  assert.deepEqual(p.failures, []);
  assert.deepEqual(p.statuses, [`正在读取 EMEVD：${file('a').relativePath}`]);
  assert.equal(p.reads.length, 1);
});

it('an incomplete dark-script response never builds an editor from a prefix alone', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async () => ({ ok: true, sourceStyle: 'dark-script', sourcePrefix: '$Event(' });
  const h = await mount(p.options);
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventSourcePreview, null);
  assert.equal(h.current().eventOpening, false);
  assert.equal(p.statuses.at(-1), '事件源码切片未齐，未打开编辑器。');
});

it('late old success and finally cannot replace or finish a newer event open', async () => {
  const p = ports(), a = deferred<FullDocument>(), b = deferred<FullDocument>();
  p.options.bridge!.readEmevdFullDocument = source => source.endsWith('/a') ? a.promise : b.promise;
  const h = await mount(p.options);
  assert.equal(h.current().eventOpening, true);
  await h.update({ ...p.options, selectedFile: file('b') });
  const statusesBeforeOldResult = p.statuses.length;
  await act(async () => a.resolve(opened('a')));
  assert.equal(h.current().eventOpening, true);
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(p.statuses.length, statusesBeforeOldResult);
  assert.deepEqual(p.cancellations, [[]]);
  await act(async () => b.resolve(opened('b')));
  assert.equal(h.current().eventPendingTab?.sourceHash, 'hash-b');
  assert.equal(h.current().eventOpening, false);
});

it('reset invalidates an awaited open even when selection has not changed', async () => {
  const p = ports(), pending = deferred<FullDocument>();
  p.options.bridge!.readEmevdFullDocument = () => pending.promise;
  const h = await mount(p.options);
  await act(async () => h.current().resetEventDocument());
  const statusCount = p.statuses.length;
  await act(async () => pending.resolve(opened('a')));
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventSourcePreview, null);
  assert.equal(h.current().eventOpening, false);
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.failures, []);
});

it('switching away clears event state, requests legacy no-argument cancellation and ignores late rejection', async () => {
  const p = ports(), pending = deferred<FullDocument>();
  p.options.bridge!.readEmevdFullDocument = () => pending.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, selectedFile: { ...file('a'), relativePath: 'param/a.param' } });
  const statusCount = p.statuses.length;
  await act(async () => pending.reject(new Error('late old failure')));
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventOpening, false);
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.cancellations, [[]]);
  assert.deepEqual(p.failures, [null]);
});

it('bridge replacement discards old failure feedback and keeps the new opening pending', async () => {
  const p = ports(), old = deferred<FullDocument>(), next = deferred<FullDocument>();
  p.options.bridge!.readEmevdFullDocument = () => old.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, bridge: { ...p.options.bridge!, readEmevdFullDocument: () => next.promise } });
  await act(async () => old.resolve({ ok: false, diagnostics: [{ severity: 'error', code: 'OLD', message: 'old' }] }));
  assert.deepEqual(p.failures, []);
  assert.equal(h.current().eventOpening, true);
  await act(async () => next.resolve(opened('a')));
  assert.equal(h.current().eventPendingTab?.sourceHash, 'hash-a');
});

it('unmount sends cancellation and suppresses late exception feedback even if native cancellation fails', async () => {
  const p = ports(), pending = deferred<FullDocument>();
  p.options.bridge!.readEmevdFullDocument = () => pending.promise;
  p.options.bridge!.cancelEmevdFullDocument = async (...args) => {
    p.cancellations.push(args);
    throw new Error('synthetic cancellation failure');
  };
  const h = await mount(p.options), statusCount = p.statuses.length;
  await h.unmount();
  await act(async () => pending.reject(new Error('late exception')));
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.failures, []);
  assert.deepEqual(p.cancellations, [[]]);
});

it('current exceptions clear the tab and finish opening with existing fallback status', async () => {
  const p = ports();
  p.options.bridge!.readEmevdFullDocument = async () => { throw 'synthetic non-Error'; };
  const h = await mount(p.options);
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventOpening, false);
  assert.deepEqual(p.failures, []);
  assert.equal(p.statuses.at(-1), 'EMEVD 读取异常');
});

it('missing bridge clears state without native reads or failure feedback', async () => {
  const p = ports();
  const h = await mount(p.options);
  await h.update({ ...p.options, bridge: null });
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventSourcePreview, null);
  assert.equal(h.current().eventOpening, false);
  assert.equal(p.reads.length, 1);
  assert.deepEqual(p.failures, [null]);
});

it('unrelated feedback rerenders do not reopen the selected document and reset is stable', async () => {
  const p = ports(), h = await mount(p.options);
  const reset = h.current().resetEventDocument;
  await h.update({ ...p.options, setStatus: () => undefined, onEventOpenFailure: () => undefined });
  assert.equal(p.reads.length, 1);
  assert.equal(h.current().resetEventDocument, reset);
  await act(async () => h.current().resetEventDocument());
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventOpening, false);
  assert.equal(h.current().eventSourcePreview, null);
});

it('strict lifecycle cleanup suppresses the obsolete first open and keeps the second authoritative', async () => {
  const p = ports(), obsolete = deferred<FullDocument>(), active = deferred<FullDocument>();
  let count = 0;
  p.options.bridge!.readEmevdFullDocument = () => ++count === 1 ? obsolete.promise : active.promise;
  const h = await mount(p.options, true);
  assert.equal(count, 2);
  assert.deepEqual(p.cancellations, [[]]);
  await act(async () => obsolete.resolve(opened('a', { sourceHash: 'obsolete' })));
  assert.equal(h.current().eventOpening, true);
  assert.equal(h.current().eventPendingTab, null);
  await act(async () => active.resolve(opened('a')));
  assert.equal(h.current().eventPendingTab?.sourceHash, 'hash-a');
  assert.equal(h.current().eventOpening, false);
});

it('explicit post-submit reload forwards the source and opaque slice coordinates then accepts the refreshed native projection', async () => {
  const p = ports(), h = await mount(p.options), slices: unknown[][] = [];
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  p.options.bridge!.readEmevdFullDocument = async (...args) => {
    p.reads.push(args);
    return opened('a', { sourceHash: 'hash-after-submit', revision: 5, sourceTotalLines: 4 });
  };
  p.options.bridge!.readEmevdSourceSlice = async (...args) => {
    slices.push(args);
    return { ok: true, sliceText: '// line 3\n// line 4', lineCount: 2, eof: true };
  };
  let text!: string | null;
  await act(async () => { text = await reload(); });
  assert.equal(p.reads.length, 2);
  assert.equal(p.reads[1]?.length, 2);
  assert.equal(p.reads[1]?.[0], file('a').sourceUri);
  assert.match(p.reads[1]?.[1] as string, /^renderer-resource:\/\/owned\/a-\d+$/);
  assert.deepEqual(slices, [['source-a', 2, 1200]]);
  assert.equal(text, '$Event(10, Default, function() {\n});\n// line 3\n// line 4');
  const tab = h.current().eventPendingTab!;
  assert.equal(tab.dslTemplate, text);
  assert.equal(tab.sourceHash, 'hash-after-submit');
  assert.equal(tab.document.revision, 5);
  assert.equal(tab.sourceToken, undefined);
  assert.equal(tab.sourcePrefix, undefined);
  assert.deepEqual(tab.document.events, []);
  assert.equal(tab.dslTemplateTotalLines, 4);
});

it('a reload captured before submit cannot read the old source after a changed selection, while the committed receipt stays successful', async () => {
  const p = ports(), h = await mount(p.options), submission = deferred<{ ok: true; opId: string }>();
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  const completed = (async () => {
    const receipt = await submission.promise;
    const text = await reload();
    return text ? { ...receipt, nextDslTemplate: text } : receipt;
  })();
  await h.update({ ...p.options, selectedFile: file('b') });
  const receipt = { ok: true as const, opId: 'owned-native-commit' };
  let result!: Awaited<typeof completed>;
  await act(async () => { submission.resolve(receipt); result = await completed; });
  assert.equal(result, receipt, 'Lifetime invalidation must preserve the exact native committed receipt');
  assert.equal(p.reads.length, 2, 'No stale post-submit read may start after invalidation');
  assert.equal(h.current().eventPendingTab?.sourceHash, 'hash-b');
});

it('an in-flight reload cannot project an old native response after selection changes or start its slices', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<FullDocument>();
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  p.options.bridge!.readEmevdFullDocument = source => source.endsWith('/a') ? pending.promise : Promise.resolve(opened('b'));
  let reading!: Promise<string | null>;
  await act(async () => { reading = reload(); });
  await h.update({ ...p.options, selectedFile: file('b') });
  let text!: string | null;
  await act(async () => { pending.resolve(opened('a')); text = await reading; });
  assert.equal(text, null);
  assert.equal(h.current().eventPendingTab?.sourceHash, 'hash-b');
});

it('reset during post-submit slice assembly discards its late text and stops further slices', async () => {
  const p = ports(), h = await mount(p.options), slice = deferred<Awaited<ReturnType<EventDocumentBridge['readEmevdSourceSlice']>>>();
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  p.options.bridge!.readEmevdFullDocument = async () => opened('a', { sourceTotalLines: 10 });
  let sliceCount = 0;
  p.options.bridge!.readEmevdSourceSlice = () => { sliceCount++; return slice.promise; };
  let reading!: Promise<string | null>;
  await act(async () => { reading = reload(); });
  assert.equal(sliceCount, 1);
  await act(async () => h.current().resetEventDocument());
  let text!: string | null;
  await act(async () => { slice.resolve({ ok: true, sliceText: '// late', lineCount: 1, eof: false }); text = await reading; });
  assert.equal(text, null);
  assert.equal(sliceCount, 1);
  assert.equal(h.current().eventPendingTab, null);
  assert.equal(h.current().eventOpening, false);
});

it('a prepared reload is invalidated by reset and by bridge replacement before it starts', async () => {
  const p = ports(), h = await mount(p.options);
  const resetReload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  await act(async () => h.current().resetEventDocument());
  assert.equal(await resetReload(), null);
  assert.equal(p.reads.length, 1);
  await h.update({ ...p.options, selectedFile: file('b') });
  const replacedReload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
  assert.equal(await replacedReload(), null);
  assert.equal(p.reads.length, 3);
});

it('a prepare callback retained across bridge replacement cannot begin a read through its obsolete owner', async () => {
  const p = ports(), h = await mount(p.options);
  const prepare = h.current().prepareEventDocumentReload, tab = h.current().eventPendingTab!;
  await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
  const count = p.reads.length;
  assert.equal(await prepare(tab)(), null);
  assert.equal(p.reads.length, count);
  await h.update(p.options);
  assert.equal(await prepare(tab)(), null, 'Returning to bridge A must not revive its old callback owner');
  assert.equal(p.reads.length, count + 1);
});

it('DSL submission forwards the existing native arguments then reloads the committed source once', async () => {
  const p = ports(), h = await mount(p.options), writes: unknown[][] = [];
  p.options.bridge!.submitEmevdDslPlan = async (...args) => {
    writes.push(args); return { ok: true, changedFiles: [], diagnostics: [] };
  };
  p.options.bridge!.readEmevdFullDocument = async (...args) => {
    p.reads.push(args); return opened('a', { sourcePrefix: null, sourceToken: null, dslTemplate: 'saved source' });
  };
  let result!: Awaited<ReturnType<EventDocumentController['submitEventDsl']>>;
  await act(async () => { result = await h.current().submitEventDsl(h.current().eventPendingTab!, 'original source\n'); });
  assert.deepEqual(writes, [[file('a').sourceUri, 'original source\n', 'dark-script']]);
  assert.equal(result.ok, true); assert.equal(result.nextDslTemplate, 'saved source');
  assert.equal(p.reads.length, 2); assert.equal(h.current().eventPendingTab?.dslTemplate, 'saved source');
});

it('a failed DSL native submit retains its diagnostics and does not reread', async () => {
  const p = ports(), h = await mount(p.options);
  const diagnostics = [{ severity: 'error' as const, code: 'OWNED_WRITE_REJECTED', message: 'owned rejection' }];
  p.options.bridge!.submitEmevdDslPlan = async () => ({ ok: false, changedFiles: [], diagnostics });
  const result = await h.current().submitEventDsl(h.current().eventPendingTab!, 'source');
  assert.equal(result.ok, false); assert.deepEqual(result.diagnostics, diagnostics); assert.equal(p.reads.length, 1);
});

it('a committed DSL submit keeps its receipt after selection, reset, unmount or refresh rejection without replay', async () => {
  for (const change of ['selection', 'reset', 'unmount', 'reload-error'] as const) {
    const p = ports(), h = await mount(p.options);
    const pending = deferred<{ ok: true; changedFiles: []; diagnostics: []; opId: string }>();
    let writes = 0;
    p.options.bridge!.submitEmevdDslPlan = () => { writes++; return pending.promise; };
    let saving!: ReturnType<EventDocumentController['submitEventDsl']>;
    await act(async () => { saving = h.current().submitEventDsl(h.current().eventPendingTab!, 'source'); });
    if (change === 'selection') await h.update({ ...p.options, selectedFile: file('b') });
    else if (change === 'reset') await act(async () => h.current().resetEventDocument());
    else if (change === 'unmount') await h.unmount();
    else p.options.bridge!.readEmevdFullDocument = async () => { throw new Error('owned reload rejection'); };
    const receipt = { ok: true as const, changedFiles: [] as [], diagnostics: [] as [], opId: 'owned-commit' };
    let result!: Awaited<typeof saving>;
    await act(async () => { pending.resolve(receipt); result = await saving; });
    assert.equal(result, receipt); assert.equal(writes, 1);
    assert.equal(p.reads.length, change === 'selection' ? 2 : 1);
  }
});

it('a committed DSL submit preserves an empty successful source refresh', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.submitEmevdDslPlan = async () => ({ ok: true, changedFiles: [], diagnostics: [] });
  p.options.bridge!.readEmevdFullDocument = async () => opened('a', { sourcePrefix: null, sourceToken: null, dslTemplate: '' });
  let result!: Awaited<ReturnType<EventDocumentController['submitEventDsl']>>;
  await act(async () => { result = await h.current().submitEventDsl(h.current().eventPendingTab!, ''); });
  assert.equal(result.ok, true); assert.equal(result.nextDslTemplate, '');
});

it('DSL submit guards non-live tabs, unavailable ports and disposed owners before native dispatch', async () => {
  for (const reason of ['not-live', 'no-bridge', 'missing-port', 'replaced-bridge', 'reset', 'unmount'] as const) {
    const p = ports(), h = await mount(p.options), tab = h.current().eventPendingTab!;
    let writes = 0;
    p.options.bridge!.submitEmevdDslPlan = async () => { writes++; return { ok: true, changedFiles: [], diagnostics: [] }; };
    let submit = h.current().submitEventDsl;
    if (reason === 'no-bridge') { await h.update({ ...p.options, bridge: null }); submit = h.current().submitEventDsl; }
    else if (reason === 'missing-port') delete (p.options.bridge as Partial<EventDocumentBridge>).submitEmevdDslPlan;
    else if (reason === 'replaced-bridge') await h.update({ ...p.options, bridge: { ...p.options.bridge! } });
    else if (reason === 'reset') await act(async () => h.current().resetEventDocument());
    else if (reason === 'unmount') await h.unmount();
    const result = await submit(reason === 'not-live' ? { ...tab, live: false } : tab, 'source');
    assert.equal(result.ok, false); assert.equal(writes, 0);
    assert.equal(result.diagnostics[0]?.code, reason === 'not-live' ? 'EMEVD_DSL_NO_LIVE_DOCUMENT'
      : reason === 'no-bridge' ? 'BRIDGE_UNAVAILABLE' : reason === 'missing-port' ? 'PRELOAD_MISSING' : 'EMEVD_DSL_OWNER_CHANGED');
  }
});

it('DSL submit keeps an existing internal tab and patch mode without requiring the current shell selection', async () => {
  const p = ports(), h = await mount(p.options), writes: unknown[][] = [];
  const tab = { ...h.current().eventPendingTab!, tabId: 'internal-b', title: 'B', resourceUri: file('b').sourceUri, sourceStyle: 'patch-dsl' as const };
  p.options.bridge!.submitEmevdDslPlan = async (...args) => { writes.push(args); return { ok: true, changedFiles: [], diagnostics: [] }; };
  p.options.bridge!.readEmevdFullDocument = async (...args) => { p.reads.push(args); return { ok: true, sourceHash: 'b-after', dslTemplate: 'patch source' }; };
  await act(async () => { await h.current().submitEventDsl(tab, 'patch source'); });
  assert.deepEqual(writes, [[file('b').sourceUri, 'patch source', 'patch']]);
  assert.equal(h.current().eventPendingTab?.tabId, 'internal-b'); assert.equal(h.current().eventPendingTab?.sourceHash, 'b-after');
});

it('a native DSL submission rejection retains the original error identity without refresh or retry', async () => {
  const p = ports(), h = await mount(p.options), error = new Error('owned dispatch rejection');
  let writes = 0;
  p.options.bridge!.submitEmevdDslPlan = async () => { writes++; throw error; };
  await assert.rejects(h.current().submitEventDsl(h.current().eventPendingTab!, 'source'), received => received === error);
  assert.equal(writes, 1); assert.equal(p.reads.length, 1);
});

it('reload permits an existing internal event tab within the same selection lifetime and retains its title and source style', async () => {
  const p = ports(), h = await mount(p.options);
  const reload = h.current().prepareEventDocumentReload({ tabId: 'existing-b', title: 'Existing B',
    resourceUri: file('b').sourceUri, sourceStyle: 'patch-dsl' });
  p.options.bridge!.readEmevdFullDocument = async (...args) => {
    p.reads.push(args);
    return { ok: true, sourceHash: 'hash-b-reloaded', dslTemplate: 'patch text' };
  };
  let text!: string | null;
  await act(async () => { text = await reload(); });
  assert.equal(text, 'patch text');
  assert.equal(p.reads[1]?.[0], file('b').sourceUri);
  assert.equal(h.current().eventPendingTab?.tabId, 'existing-b');
  assert.equal(h.current().eventPendingTab?.title, 'Existing B');
  assert.equal(h.current().eventPendingTab?.sourceStyle, 'patch-dsl');
});

it('unmount invalidates prepared and awaited reloads and suppresses late refresh exceptions', async () => {
  const p = ports(), h = await mount(p.options), pending = deferred<FullDocument>();
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  p.options.bridge!.readEmevdFullDocument = (...args) => { p.reads.push(args); return pending.promise; };
  let reading!: Promise<string | null>;
  await act(async () => { reading = reload(); });
  const statusCount = p.statuses.length;
  await h.unmount();
  let text!: string | null;
  await act(async () => { pending.reject(new Error('obsolete refresh')); text = await reading; });
  assert.equal(text, null);
  assert.equal(p.statuses.length, statusCount);
  assert.equal(await reload(), null);
  assert.equal(p.reads.length, 2);
});

it('reload failure and native cancellation preserve the current projection and never retry', async () => {
  for (const response of [{ ok: false }, { ok: false, cancelled: true }, { ok: true, dslTemplate: null }]) {
    const p = ports(), h = await mount(p.options), original = h.current().eventPendingTab;
    const reload = h.current().prepareEventDocumentReload(original!);
    p.options.bridge!.readEmevdFullDocument = async (...args) => { p.reads.push(args); return response; };
    let text!: string | null;
    await act(async () => { text = await reload(); });
    assert.equal(text, null);
    assert.equal(h.current().eventPendingTab, original);
    assert.equal(p.reads.length, 2);
    assert.equal(h.current().eventOpening, false);
    await h.unmount();
  }
});

it('a current reload exception reports only refresh feedback and leaves the successful submit receipt usable', async () => {
  const p = ports(), h = await mount(p.options), original = h.current().eventPendingTab;
  const reload = h.current().prepareEventDocumentReload(original!);
  p.options.bridge!.readEmevdFullDocument = async () => { throw new Error('synthetic refresh failure'); };
  let text!: string | null;
  await act(async () => { text = await reload(); });
  assert.equal(text, null);
  assert.equal(h.current().eventPendingTab, original);
  assert.deepEqual(p.failures, [null]);
  assert.equal(p.statuses.at(-1), 'synthetic refresh failure');
});

it('a successful empty decoded reload remains distinguishable from a stale or cancelled reload', async () => {
  const p = ports(), h = await mount(p.options);
  const reload = h.current().prepareEventDocumentReload(h.current().eventPendingTab!);
  p.options.bridge!.readEmevdFullDocument = async () => ({
    ok: true, sourceHash: 'empty-source-hash', dslTemplate: '', dslTemplateTotalLines: 0, sourceStyle: 'none'
  });
  let text!: string | null;
  await act(async () => { text = await reload(); });
  assert.equal(text, '');
  assert.equal(h.current().eventPendingTab?.dslTemplate, '');
  assert.equal(h.current().eventPendingTab?.sourceHash, 'empty-source-hash');
  assert.equal(h.current().eventPendingTab?.dslTemplateTotalLines, 0);
});
