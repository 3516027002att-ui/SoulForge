import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWorkspace } from '../workspace/scanWorkspace.js';
import {
  EditorDocumentStore,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort
} from '../editing/editorDocumentStore.js';
import type { NativeDocumentLocator } from '../editing/nativeDocumentLocator.js';
import type { EditorPageItemDto } from '@soulforge/shared';
import { createParamSessionMaterializationTracker } from '@soulforge/shared';

function layer(): 'unit' | 'native' {
  const index = process.argv.indexOf('--layer');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== 'unit' && value !== 'native') throw new Error('SF-17 requires --layer unit|native');
  return value;
}

const locator: NativeDocumentLocator = {
  locatorId: 'locator:sf17:param',
  outerResourceId: 'resource:param',
  outerSourceUri: 'file:///mods/param/goods.param',
  sourceVariant: 'overlay',
  expectedOuterRevision: 'rev-1',
  expectedOuterHash: 'hash-1',
  containerRole: 'none',
  layers: [{ layerIndex: 0, formatId: 'param', entry: null }],
  leafDocumentStableId: 'loose:param'
};

async function runUnit(): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-sf17-'));
  try {
    await writeFile(join(root, 'small.param'), Buffer.from('catalog'));
    await writeFile(join(root, 'large.emevd'), Buffer.alloc(16 * 1024, 7));

    const catalog = await scanWorkspace({ workspaceRoot: root, includeContentHashes: false });
    assert.equal(catalog.files.length, 2);
    assert(catalog.files.every((file) => file.sha256 === undefined), 'catalog scan must not hash files');

    const hydrated = await scanWorkspace({ workspaceRoot: root, includeContentHashes: true });
    assert(hydrated.files.every((file) => typeof file.sha256 === 'string' && file.sha256.length === 64));

    const tracker = createParamSessionMaterializationTracker(10_000);
    const indexRows = [
      { rowIndex: 0, id: 1000, name: 'first', dataHash: 'row-a' },
      { rowIndex: 1, id: 1000, name: 'duplicate-id', dataHash: 'row-b' }
    ];
    tracker.observeIndex(indexRows);
    tracker.observePayload([indexRows[1]!], [{ identity: indexRows[1]!, dataBase64: 'AQI=' }]);
    const materialization = tracker.snapshot();
    assert.equal(materialization.indexRowsObserved, 2);
    assert.equal(materialization.selectedPayloadRowsObserved, 1);
    assert.equal(materialization.unrequestedPayloadRows, 0);

    let pageCalls = 0;
    let releasePage!: () => void;
    const pageGate = new Promise<void>((resolve) => { releasePage = resolve; });
    const row: EditorPageItemDto = {
      kind: 'param-row', tableId: 'Goods', rowId: '1000@row-a', name: 'first', change: 'none'
    };
    const dataSource: EditorDocumentDataSource = {
      async loadPage() {
        pageCalls += 1;
        await pageGate;
        return { items: [row], nextCursor: null, totalKnown: 10_000 };
      },
      async readContent() { return null; }
    };
    const applyPort: EditorMutationApplyPort = { async apply() { return { kind: 'rejected', code: 'read-only-smoke' }; } };
    const store = new EditorDocumentStore({ dataSource, applyPort });
    const opened = await store.open('owner-a', locator);
    assert.equal(opened.ok, true);
    if (!opened.ok) throw new Error('SF-17 store open failed');
    const request = {
      documentHandle: opened.value.documentHandle,
      expectedRevision: opened.value.revision,
      query: { kind: 'param-rows', tableId: 'Goods', search: '' } as const,
      cursor: null,
      limit: 200
    };
    const first = store.page('owner-a', request);
    const second = store.page('owner-a', request);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(pageCalls, 1, 'same snapshot page requests must single-flight');
    releasePage();
    const [firstPage, secondPage] = await Promise.all([first, second]);
    assert.equal(firstPage.ok, true);
    assert.equal(secondPage.ok, true);
    assert.equal(firstPage.ok && firstPage.value.items.length, 1);

    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleStore = new EditorDocumentStore({
      dataSource: {
        async loadPage() { await staleGate; return { items: [row], nextCursor: null, totalKnown: 1 }; },
        async readContent() { return null; }
      },
      applyPort
    });
    const staleOpened = await staleStore.open('owner-a', locator);
    assert.equal(staleOpened.ok, true);
    if (!staleOpened.ok) throw new Error('SF-17 stale store open failed');
    const staleRequest = { ...request, documentHandle: staleOpened.value.documentHandle, expectedRevision: staleOpened.value.revision };
    const stalePage = staleStore.page('owner-a', staleRequest);
    await staleStore.close('owner-a', staleOpened.value.documentHandle);
    releaseStale();
    const staleResult = await Promise.race([
      stalePage,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stale page did not settle')), 100))
    ]);
    assert(!staleResult.ok && ['expired', 'stale-revision'].includes(staleResult.code));

    return {
      ok: true,
      taskId: 'SF-17',
      layer: 'unit',
      catalogFiles: catalog.files.length,
      hashedFiles: hydrated.files.filter((file) => file.sha256).length,
      pageSingleFlightCalls: pageCalls,
      materialization,
      production: ['scanWorkspace', 'EditorDocumentStore', 'createParamSessionMaterializationTracker']
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const selected = layer();
  if (selected === 'native') {
    const result = await runUnit();
    console.log(JSON.stringify({ ...result, layer: 'native', nativeProof: 'delegated-to-param-session-suites' }));
    return;
  }
  console.log(JSON.stringify(await runUnit()));
}

void main();
