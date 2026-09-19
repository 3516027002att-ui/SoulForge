import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventExport, SymbolBundle } from '@soulforge/shared';
import {
  createManagedReferenceCursorStore,
  createReferenceCursorStore
} from '../references/referenceCursorStore.js';
import { createReferenceQueryService } from '../references/referenceQueryService.js';
import { projectReferenceSearchPage, serializeReferenceEnvelope } from '../references/referencePageProjection.js';

const sourceUri = 'workspace://reference-content-smoke/events/test.emevd.dcx';
const event = (eventId: number, nextEventId?: number): EventExport['events'][number] => ({
  uri: `${sourceUri}#event/${eventId}`,
  sourceUri,
  eventId,
  instructions: nextEventId === undefined ? [] : [{
    uri: `${sourceUri}#event/${eventId}#instruction/0`,
    index: 0,
    bank: 2000,
    id: 6,
    name: 'InitializeEvent',
    args: [
      { name: 'slotNumber', value: 0, argIndex: 0, role: 'unknown', roleSource: 'registry' },
      { name: 'eventId', value: nextEventId, argIndex: 1, role: 'eventId', roleSource: 'registry' },
      { name: 'arg', value: 0, argIndex: 2, role: 'unknown', roleSource: 'registry' }
    ]
  }]
});
const bundle: SymbolBundle = {
  events: [{
    sourceHash: 'content-smoke-source',
    outerFileHash: 'content-smoke-outer',
    events: [event(1, 2), event(2, 3), event(3)]
  }]
};

const registry = {
  schemaVersion: 1,
  game: 'sekiro',
  origin: 'fixture',
  instructions: [{
    bank: 2000,
    id: 6,
    name: 'InitializeEvent',
    args: [
      { name: 'slotNumber', type: 's32' },
      { name: 'eventId', type: 's32' },
      { name: 'arg', type: 's32' }
    ]
  }]
} as never;

const store = createReferenceCursorStore({ maxEntries: 8 });
const firstService = createReferenceQueryService({
  bundle,
  workspaceId: 'reference-content-smoke',
  registry,
  cursorStore: store
});
const first = await firstService.query({
  target: { domain: 'emevd', sourceUri, eventId: 1 },
  direction: 'from',
  depth: 3,
  detail: 'context',
  limit: 1
});
assert.equal(first.resolution, 'resolved');
assert.equal(first.relations.length, 1);
assert.ok((first.relations[0]?.path.length ?? 0) >= 1);
const firstCursor = first.page.nextCursor;
assert.ok(firstCursor);

// A fresh service instance must continue through the shared host store, and
// the stored scope must retain direction/depth/detail instead of defaulting.
const secondService = createReferenceQueryService({
  bundle,
  workspaceId: 'reference-content-smoke',
  registry,
  cursorStore: store
});
const second = await secondService.query({ cursor: firstCursor });
assert.equal(second.resolution, 'resolved');
assert.ok(second.relations.every((item) => item.path.length >= 1));
assert.ok((second.relations[0]?.path.length ?? 0) >= 2);
assert.notEqual(second.relations[0]?.to.eventId, first.relations[0]?.to.eventId);
assert.notDeepEqual(first.context?.statements, second.context?.statements);
const depthBounded = await firstService.query({
  target: { domain: 'emevd', sourceUri, eventId: 1 },
  direction: 'from',
  depth: 1,
  detail: 'edges'
});
assert.equal(depthBounded.coverage.status, 'partial');

const scriptSource = 'workspace://reference-content-smoke/scripts/test.luabnd.dcx';
const scriptChildren = Array.from({ length: 40 }, (_, index) => ({
  uri: `${scriptSource}!/child-${index}.lua`,
  sourceUri: scriptSource,
  childChain: [`child-${index}.lua`],
  entryIndex: index,
  entryName: `child-${index}.lua`,
  contentKind: 'catalog-only' as const
}));
const scriptService = createReferenceQueryService({
  bundle: { scripts: [{ sourceUri: scriptSource, containerKind: 'luabnd', catalogComplete: true, scripts: scriptChildren }] },
  workspaceId: 'reference-content-smoke',
  cursorStore: store
});
const scriptPage = await scriptService.query({
  target: { domain: 'script', sourceUri: scriptSource, childChain: ['child-0.lua'] },
  depth: 4,
  limit: 32
});
assert.ok(scriptPage.relations.every((relation) => relation.to.sourceUri !== scriptSource || relation.to.childChain?.join('/') === 'child-0.lua'));

const projected = projectReferenceSearchPage(first);
const serialized = serializeReferenceEnvelope(first);
assert.ok(Buffer.byteLength(serialized, 'utf8') <= 8192);
const projectedText = JSON.stringify(projected);
assert.equal(projectedText.includes('evidence'), false);
assert.equal(projectedText.includes('sourceVersion'), false);
assert.equal(projectedText.includes('payloadHash'), false);
const longRecord = {
  ...first,
  relations: first.relations.map((relation) => ({
    ...relation,
    evidence: [{
      sourceUri,
      statement: { kind: 'native-rendered' as const, text: '非常长的原生指令片段'.repeat(2000) }
    }]
  }))
};
const longProjected = projectReferenceSearchPage(longRecord);
assert.equal(longProjected.relations[0]?.content?.truncated, true);
assert.ok(longProjected.relations[0]?.readAction);

// The public projection must never drop a relation after its offset is signed.
const fanRoot = event(100);
fanRoot.instructions = Array.from({ length: 30 }, (_, index) => ({
  ...event(100, 200 + index).instructions[0]!,
  index,
  uri: `${sourceUri}#event/100#instruction/${index}`,
  name: `InitializeEvent_${'中文上下文'.repeat(100)}`
}));
const fanBundle: SymbolBundle = { events: [{ events: [fanRoot, ...Array.from({ length: 30 }, (_, index) => event(200 + index))] }] };
const deliveredIds: number[] = [];
let fanCursor: string | undefined;
do {
  const service = createReferenceQueryService({ bundle: fanBundle, workspaceId: 'reference-content-smoke', cursorStore: store,
    scan: { remaining: true, sourceCursor: 'rf2_scan', nextAction: { tool: 'find_references', args: { uri: fanRoot.uri, sourceCursor: 'rf2_scan' }, reason: '继续扫描来源' } } });
  const record = await service.query(fanCursor ? { cursor: fanCursor } : { uri: fanRoot.uri, direction: 'from', depth: 1, limit: 32, detail: 'context' });
  const publicPage = projectReferenceSearchPage(record);
  assert.equal(publicPage.relations.length, record.relations.length);
  assert.ok(publicPage.relations.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(publicPage), 'utf8') <= 8192);
  deliveredIds.push(...publicPage.relations.map((relation) => relation.to.eventId!));
  fanCursor = publicPage.page.nextCursor;
  assert.ok(deliveredIds.length <= 30);
} while (fanCursor);
assert.deepEqual(deliveredIds.sort((a, b) => a - b), Array.from({ length: 30 }, (_, index) => 200 + index));

// Managed stores survive a new store object and process boundary simulation.
const dir = mkdtempSync(join(tmpdir(), 'soulforge-reference-cursor-'));
try {
  const managedA = createManagedReferenceCursorStore(dir);
  const token = managedA.issue({
    workspaceId: 'reference-content-smoke',
    scope: { target: { domain: 'emevd', sourceUri, eventId: 1 }, direction: 'from', detail: 'context', depth: 3, limit: 1, includeHypotheses: false },
    rootUri: `${sourceUri}#event/1`,
    relationOffset: 1,
    sourceVersionKey: 'sha256:source-v1',
    dependencySummary: { catalogGeneration: 1, entries: [] }
  });
  const managedB = createManagedReferenceCursorStore(dir);
  assert.equal(managedB.get(token)?.relationOffset, 1);
  const scanToken = managedB.issue({
    workspaceId: 'reference-content-smoke',
    scope: { target: { domain: 'emevd', sourceUri, eventId: 1 }, direction: 'from', detail: 'context', depth: 3, limit: 1, includeHypotheses: false },
    rootUri: 'reference-source-scan://',
    relationOffset: 0,
    sourceVersionKey: 'sha256:source-v1',
    sourceScanState: { completedSourceKeys: ['source-a'], scriptChildOffsets: { a: 1 } },
    dependencySummary: { catalogGeneration: 1, entries: [] }
  });
  assert.deepEqual(managedB.get(scanToken)?.sourceScanState, { completedSourceKeys: ['source-a'], scriptChildOffsets: { a: 1 } });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, message: 'reference content query smoke passed' }));
