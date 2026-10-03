import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import React, { act } from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';
import {
  useMapDocumentController,
  type MapDocumentController,
  type MapDocumentOptions,
  type MapDocumentReadResult,
  type MapDocumentOpenFailure,
  type MapDocumentBridge
} from './useMapDocumentController.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: ReactTestRenderer[] = [];
afterEach(async () => {
  while (mounted.length) {
    const renderer = mounted.pop()!;
    await act(async () => renderer.unmount());
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function file(name: string): NonNullable<MapDocumentOptions['selectedFile']> {
  return { sourceUri: `resource://owned/${name}`, relativePath: `map/${name}.msb.dcx`,
    resourceKind: 'map', formatKind: 'msb', compoundExtension: '.msb.dcx' };
}
function opened(name: string): MapDocumentReadResult {
  return { ok: true, data: {
    sourceHash: `hash-${name}`, authority: 'native-verified',
    models: [{ name: `model-${name}`, nativeOffset: 0, offset: 999, typeId: 1, sibPath: 'model\\map\\asset.flver' }],
    parts: [{ name: `part-${name}`, offset: 64, modelIndex: 0, posX: 1, posY: 2, posZ: 3 }],
    regions: [{ name: `region-${name}`, nativeOffset: 128, typeId: 2, posX: 4, posY: 5, posZ: 6 }],
    events: [{ name: `event-${name}`, nativeOffset: 192, typeId: 3 }],
    routes: [{ name: `route-${name}`, nativeOffset: 256, typeId: 4, id: 0 }],
    modelCount: 120, partCount: 50000, regionCount: 600, eventCount: 700, routeCount: 800
  } };
}
function ports() {
  const reads: string[] = [], statuses: string[] = [];
  const failures: Array<MapDocumentOpenFailure | null> = [];
  const bridge: MapDocumentBridge = {
    readMsbDocument: async source => { reads.push(source); return opened(source.endsWith('/b') ? 'b' : 'a'); }
  };
  const options: MapDocumentOptions = { bridge, selectedFile: file('a'),
    setStatus: message => statuses.push(message), onMapOpenFailure: failure => failures.push(failure) };
  return { options, reads, statuses, failures };
}
async function mount(options: MapDocumentOptions, strict = false) {
  let current!: MapDocumentController;
  function Host({ options }: { options: MapDocumentOptions }) {
    current = useMapDocumentController(options);
    return <span>{current.msbParts[0]?.name}</span>;
  }
  const element = (options: MapDocumentOptions) => strict
    ? <React.StrictMode><Host options={options} /></React.StrictMode> : <Host options={options} />;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(element(options)); });
  mounted.push(renderer);
  return { current: () => current,
    update: async (options: MapDocumentOptions) => act(async () => renderer.update(element(options))),
    unmount: async () => { mounted.splice(mounted.indexOf(renderer), 1); await act(async () => renderer.unmount()); } };
}
function assertEmpty(controller: MapDocumentController) {
  assert.deepEqual(controller.msbModels, []);
  assert.deepEqual(controller.msbParts, []);
  assert.deepEqual(controller.msbRegions, []);
  assert.deepEqual(controller.msbEvents, []);
  assert.deepEqual(controller.msbRoutes, []);
  assert.deepEqual(controller.msbSourceCounts, { models: 0, parts: 0, regions: 0, events: 0, routes: 0 });
  assert.equal(controller.msbSourceHash, null);
  assert.equal(controller.msbLive, false);
}

it('reads only the selected logical map and preserves native counts, identities and source authority', async () => {
  const p = ports(), h = await mount(p.options);
  assert.deepEqual(p.reads, [file('a').sourceUri]);
  assert.deepEqual(h.current().msbModels, [{ name: 'model-a', nativeOffset: 0, typeId: 1, sibPath: 'asset.flver' }]);
  assert.deepEqual(h.current().msbParts, [{ name: 'part-a', nativeOffset: 64, modelIndex: 0,
    posX: 1, posY: 2, posZ: 3, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }]);
  assert.deepEqual(h.current().msbRegions, [{ name: 'region-a', nativeOffset: 128, typeId: 2,
    posX: 4, posY: 5, posZ: 6, rotX: 0, rotY: 0, rotZ: 0, scaleX: 1, scaleY: 1, scaleZ: 1 }]);
  assert.deepEqual(h.current().msbEvents, [{ name: 'event-a', nativeOffset: 192, typeId: 3 }]);
  assert.deepEqual(h.current().msbRoutes, [{ name: 'route-a', nativeOffset: 256, typeId: 4, id: 0 }]);
  assert.deepEqual(h.current().msbSourceCounts, { models: 120, parts: 50000, regions: 600, events: 700, routes: 800 });
  assert.equal(h.current().msbSourceHash, 'hash-a');
  assert.equal(h.current().msbLive, true);
  assert.deepEqual(p.failures, [null]);
  assert.equal(p.statuses.at(-1), '已加载 MSB：50000 parts / 600 regions / 800 routes · 读取级别：原生读取已验证');
});

it('missing optional native tables fall back to projected counts without inventing offsets or authority', async () => {
  const p = ports();
  p.options.bridge!.readMsbDocument = async () => ({ ok: true, data: {
    parts: [{ name: 'only part', posX: 0, posY: 0, posZ: 0, rotX: 5, scaleX: 0 }]
  } });
  const h = await mount(p.options);
  assert.deepEqual(h.current().msbSourceCounts, { models: 0, parts: 1, regions: 0, events: 0, routes: 0 });
  assert.equal(h.current().msbSourceHash, null);
  assert.equal(h.current().msbLive, true);
  assert.equal(h.current().msbParts[0]?.nativeOffset, undefined);
  assert.equal(h.current().msbParts[0]?.modelIndex, undefined);
  assert.equal(h.current().msbParts[0]?.rotX, 5);
  assert.equal(h.current().msbParts[0]?.scaleX, 0);
  assert.equal(p.statuses.at(-1), '已加载 MSB：1 parts');
});

it('native failure clears all projection authority and retains sanitized logical-document failure feedback', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.readMsbDocument = async () => ({ ok: false, diagnostics: [{
    code: 'MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE', message: '选择原版目录后再打开。'
  }] });
  await h.update({ ...p.options, selectedFile: file('b') });
  assertEmpty(h.current());
  assert.deepEqual(p.failures.at(-1), { kind: 'msb-open-failed', document: file('b').relativePath,
    code: 'MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE', message: '选择原版目录后再打开。' });
  assert.equal(p.statuses.at(-1), '这张地图读不出来。');
});

it('missing native data uses the existing fallback diagnostics without rereading', async () => {
  const p = ports();
  p.options.bridge!.readMsbDocument = async source => { p.reads.push(source); return { ok: true }; };
  const h = await mount(p.options);
  assertEmpty(h.current());
  assert.deepEqual(p.failures, [{ kind: 'msb-open-failed', document: file('a').relativePath,
    code: 'MSB_READ_FAILED', message: '这张地图读不出来，请检查文件状态后重试。' }]);
  assert.equal(p.reads.length, 1);
});

it('KRAK failure without a native message retains the existing actionable fallback', async () => {
  const p = ports();
  p.options.bridge!.readMsbDocument = async () => ({ ok: false, diagnostics: [{ code: 'MSB_DOCUMENT_KRAK_OODLE_UNAVAILABLE' }] });
  const h = await mount(p.options);
  assertEmpty(h.current());
  assert.equal(p.failures[0]?.message, '这份地图是 KRAK 压缩，到「开始」页选择含 sekiro.exe 的原版目录后再打开。');
});

it('current read exceptions clear all eight projection states with existing exception feedback', async () => {
  const p = ports(), h = await mount(p.options);
  p.options.bridge!.readMsbDocument = async () => { throw 'synthetic failure'; };
  await h.update({ ...p.options, selectedFile: file('b') });
  assertEmpty(h.current());
  assert.equal(p.statuses.at(-1), 'MSB 读取异常');
  assert.deepEqual(p.failures, [null]);
});

it('late old success cannot replace a newer selected map or publish its status', async () => {
  const p = ports(), a = deferred<MapDocumentReadResult>(), b = deferred<MapDocumentReadResult>();
  p.options.bridge!.readMsbDocument = source => source.endsWith('/a') ? a.promise : b.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, selectedFile: file('b') });
  const statusCount = p.statuses.length;
  await act(async () => a.resolve(opened('a')));
  assertEmpty(h.current());
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.failures, []);
  await act(async () => b.resolve(opened('b')));
  assert.equal(h.current().msbParts[0]?.name, 'part-b');
  assert.equal(h.current().msbSourceHash, 'hash-b');
});

it('late old native failure cannot replace the current map failure', async () => {
  const p = ports(), pending = deferred<MapDocumentReadResult>();
  p.options.bridge!.readMsbDocument = source => source.endsWith('/a') ? pending.promise
    : Promise.resolve({ ok: false, diagnostics: [{ code: 'NEW', message: 'new failure' }] });
  const h = await mount(p.options);
  await h.update({ ...p.options, selectedFile: file('b') });
  const statusCount = p.statuses.length;
  await act(async () => pending.resolve({ ok: false, diagnostics: [{ code: 'OLD', message: 'old failure' }] }));
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.failures, [{ kind: 'msb-open-failed', document: file('b').relativePath, code: 'NEW', message: 'new failure' }]);
});

it('reset invalidates an awaited native read immediately without starting a replacement read', async () => {
  const p = ports(), pending = deferred<MapDocumentReadResult>();
  p.options.bridge!.readMsbDocument = source => { p.reads.push(source); return pending.promise; };
  const h = await mount(p.options);
  await act(async () => h.current().resetMapDocument());
  const statusCount = p.statuses.length;
  await act(async () => pending.resolve(opened('a')));
  assertEmpty(h.current());
  assert.equal(p.statuses.length, statusCount);
  assert.deepEqual(p.failures, []);
  assert.equal(p.reads.length, 1);
});

it('reset clears every loaded projection including source counts and revision', async () => {
  const p = ports(), h = await mount(p.options);
  await act(async () => h.current().resetMapDocument());
  assertEmpty(h.current());
  assert.equal(p.reads.length, 1);
});

it('switching away clears map authority and failure feedback while ignoring a late rejection', async () => {
  const p = ports(), pending = deferred<MapDocumentReadResult>();
  p.options.bridge!.readMsbDocument = () => pending.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, selectedFile: { ...file('b'), relativePath: 'param/b.param' } });
  const statusCount = p.statuses.length;
  await act(async () => pending.reject(new Error('obsolete map failure')));
  assertEmpty(h.current());
  assert.deepEqual(p.failures, [null]);
  assert.equal(p.statuses.length, statusCount);
});

it('missing bridge removes loaded map authority without fabricating a native failure', async () => {
  const p = ports(), h = await mount(p.options);
  await h.update({ ...p.options, bridge: null });
  assertEmpty(h.current());
  assert.equal(p.reads.length, 1);
  assert.deepEqual(p.failures, [null]);
});

it('bridge replacement invalidates the old read and keeps the new response authoritative', async () => {
  const p = ports(), old = deferred<MapDocumentReadResult>(), next = deferred<MapDocumentReadResult>();
  p.options.bridge!.readMsbDocument = () => old.promise;
  const h = await mount(p.options);
  await h.update({ ...p.options, bridge: { readMsbDocument: () => next.promise } });
  await act(async () => old.reject(new Error('obsolete bridge failure')));
  assertEmpty(h.current());
  assert.deepEqual(p.failures, []);
  await act(async () => next.resolve(opened('b')));
  assert.equal(h.current().msbSourceHash, 'hash-b');
});

it('unmount suppresses late successful read and late rejected read feedback', async () => {
  for (const reject of [false, true]) {
    const p = ports(), pending = deferred<MapDocumentReadResult>();
    p.options.bridge!.readMsbDocument = () => pending.promise;
    const h = await mount(p.options), statusCount = p.statuses.length;
    await h.unmount();
    await act(async () => reject ? pending.reject(new Error('late unmounted failure')) : pending.resolve(opened('a')));
    assert.equal(p.statuses.length, statusCount);
    assert.deepEqual(p.failures, []);
  }
});

it('feedback-only rerenders do not reopen native documents or replace the stable reset callback', async () => {
  const p = ports(), h = await mount(p.options), reset = h.current().resetMapDocument;
  await h.update({ ...p.options, setStatus: () => undefined, onMapOpenFailure: () => undefined });
  assert.equal(p.reads.length, 1);
  assert.equal(h.current().resetMapDocument, reset);
});

it('strict lifecycle cleanup invalidates the obsolete first read', async () => {
  const p = ports(), old = deferred<MapDocumentReadResult>(), next = deferred<MapDocumentReadResult>();
  let reads = 0;
  p.options.bridge!.readMsbDocument = () => ++reads === 1 ? old.promise : next.promise;
  const h = await mount(p.options, true);
  assert.equal(reads, 2);
  await act(async () => old.resolve(opened('a')));
  assertEmpty(h.current());
  await act(async () => next.resolve(opened('b')));
  assert.equal(h.current().msbSourceHash, 'hash-b');
});

it('current committed revision readback updates only the hash without replacing native counts or replaying a read', async () => {
  const p = ports(), h = await mount(p.options), parts = h.current().msbParts, counts = h.current().msbSourceCounts;
  await act(async () => h.current().setMsbSourceHash('hash-after-commit'));
  assert.equal(h.current().msbSourceHash, 'hash-after-commit');
  assert.equal(h.current().msbParts, parts);
  assert.equal(h.current().msbSourceCounts, counts);
  assert.equal(h.current().msbLive, true);
  assert.equal(p.reads.length, 1);
});

it('a committed receipt stays successful when its late panel readback cannot replace a newly selected map', async () => {
  const p = ports(), h = await mount(p.options), submission = deferred<{ ok: true; sourceHash: string; opId: string }>();
  const publishHash = h.current().setMsbSourceHash;
  const completed = (async () => { const receipt = await submission.promise; publishHash(receipt.sourceHash); return receipt; })();
  await h.update({ ...p.options, selectedFile: file('b') });
  const receipt = { ok: true as const, sourceHash: 'old-committed-hash', opId: 'owned-native-commit' };
  let result!: Awaited<typeof completed>;
  await act(async () => { submission.resolve(receipt); result = await completed; });
  assert.equal(result, receipt);
  assert.equal(h.current().msbSourceHash, 'hash-b');
  assert.equal(p.reads.length, 2);
});

it('reset immediately invalidates a captured commit readback callback even before rerender', async () => {
  const p = ports(), h = await mount(p.options), publishHash = h.current().setMsbSourceHash;
  await act(async () => { h.current().resetMapDocument(); publishHash('obsolete committed hash'); });
  assertEmpty(h.current());
  assert.equal(p.reads.length, 1);
});

it('selection returning to the same source does not revive a previous panel readback callback', async () => {
  const p = ports(), h = await mount(p.options), publishHash = h.current().setMsbSourceHash;
  await h.update({ ...p.options, selectedFile: file('b') });
  await h.update(p.options);
  await act(async () => publishHash('obsolete same-source hash'));
  assert.equal(h.current().msbSourceHash, 'hash-a');
  assert.equal(p.reads.length, 3);
});

it('unmount and bridge replacement both invalidate captured revision readback callbacks', async () => {
  const p = ports(), h = await mount(p.options), oldHash = h.current().setMsbSourceHash;
  await h.update({ ...p.options, bridge: { readMsbDocument: async () => opened('b') } });
  await act(async () => oldHash('obsolete bridge hash'));
  assert.equal(h.current().msbSourceHash, 'hash-b');
  const unmountedHash = h.current().setMsbSourceHash, statusCount = p.statuses.length;
  await h.unmount();
  await act(async () => unmountedHash('obsolete unmounted hash'));
  assert.equal(p.statuses.length, statusCount);
});
