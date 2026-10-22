import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { IndexedFile, RagChunk, RagChunkFamily, RagCorpus } from '@soulforge/shared';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { buildRagCorpus } from './chunkBuilder.js';
import { diffRagCorpusBySource, loadRagCorpus, persistRagCorpus, type RagChunkDelta } from './persist.js';
import { SQLITE_MIGRATIONS } from '../storage/sqliteSchema.js';
import type { SqliteDatabase } from '../storage/sqliteDatabase.js';
import { WorkspaceDataRepository } from '../storage/workspaceDataRepository.js';

const WORKSPACE_ID = 'rag-diff-key-order';
const SOURCE_URI = 'file://param/gameparam.parambnd.dcx';
const FAMILIES: readonly RagChunkFamily[] = ['file', 'event', 'map_entity', 'map_region', 'param_row', 'text_entry', 'tae_event'];

test('same plain RagChunk values compare equal regardless of property insertion order', () => {
  const previous = makeChunk();
  const next = Object.fromEntries(Object.entries(previous).reverse()) as RagChunk;
  assert.notDeepEqual(Object.keys(previous), Object.keys(next), 'fixture must differ in key order');
  assert.deepEqual(diffRagCorpusBySource(corpus([previous]), corpus([next])), []);
});

test('every declared RagChunk field and numericIds order remains part of diff identity', () => {
  const mutations: Array<[string, (value: RagChunk) => RagChunk]> = [
    ['chunkId', value => ({ ...value, chunkId: 'rag:param_row:changed' })],
    ['workspaceId', value => ({ ...value, workspaceId: 'another-workspace' })],
    ['sourceUri', value => ({ ...value, sourceUri: 'file://param/other.parambnd.dcx' })],
    ['symbolUri', value => ({ ...value, symbolUri: 'param://NpcParam/other' })],
    ['family', value => ({ ...value, family: 'event' })],
    ['title', value => ({ ...value, title: 'changed title' })],
    ['body', value => ({ ...value, body: 'different body with same hash', contentHash: value.contentHash })],
    ['numericIds', value => ({ ...value, numericIds: [...value.numericIds].reverse() })],
    ['contentHash', value => ({ ...value, contentHash: 'different-content-hash' })],
    ['sourceRevision', value => ({ ...value, sourceRevision: 2 })],
    ['outerFileHash', value => ({ ...value, outerFileHash: 'different-outer-hash' })],
    ['sourceHash', value => ({ ...value, sourceHash: 'different-source-hash' })],
    ['relativePath', value => ({ ...value, relativePath: 'param/other.param' })],
    ['resourceKind', value => ({ ...value, resourceKind: 'event' })],
    ['confidence', value => ({ ...value, confidence: 'low' })],
    ['taeActionEventCount', value => ({ ...value, taeActionEventCount: 3 })],
    ['taeActionEventsComplete', value => ({ ...value, taeActionEventsComplete: false })]
  ];
  for (const [field, mutate] of mutations) {
    const previous = makeChunk();
    const next = mutate(makeChunk());
    const deltas = diffRagCorpusBySource(corpus([previous]), corpus([next]));
    assert.ok(deltas.some(delta => delta.upserts.some(chunk => chunk.chunkId === next.chunkId)), `${field} must yield an upsert`);
  }
});

test('optional undefined and absent RagChunk fields retain JSON omission semantics', () => {
  const absent = makeChunk();
  delete (absent as Partial<RagChunk>).sourceHash;
  const explicitUndefined = { ...makeChunk(), sourceHash: undefined } as unknown as RagChunk;
  assert.deepEqual(diffRagCorpusBySource(corpus([absent]), corpus([explicitUndefined])), []);
});

test('unknown enumerable fields stay on the JSON fallback path', () => {
  const previous = { ...makeChunk(), futureField: { revision: 1 } } as RagChunk;
  const same = { ...makeChunk(), futureField: { revision: 1 } } as RagChunk;
  const changed = { ...makeChunk(), futureField: { revision: 2 } } as RagChunk;
  assert.deepEqual(diffRagCorpusBySource(corpus([previous]), corpus([same])), []);
  assert.ok(diffRagCorpusBySource(corpus([previous]), corpus([changed])).some(delta => delta.upserts.length > 0));
});

test('own and inherited toJSON stay on the JSON fallback path and are called once per chunk', () => {
  const makeToJsonChunk = () => {
    let calls = 0;
    const value = makeChunk() as RagChunk & { toJSON(): unknown };
    Object.defineProperty(value, 'toJSON', {
      value() { calls += 1; return { ...makeChunk(), future: 'kept by native JSON' }; }
    });
    return { value, calls: () => calls };
  };
  const ownLeft = makeToJsonChunk();
  const ownRight = makeToJsonChunk();
  assert.deepEqual(diffRagCorpusBySource(corpus([ownLeft.value]), corpus([ownRight.value])), []);
  assert.equal(ownLeft.calls(), 1);
  assert.equal(ownRight.calls(), 1);

  let inheritedCalls = 0;
  const prototype = { toJSON() { inheritedCalls += 1; return makeChunk(); } };
  const inheritedLeft = Object.assign(Object.create(prototype) as object, makeChunk()) as RagChunk;
  const inheritedRight = Object.assign(Object.create(prototype) as object, makeChunk()) as RagChunk;
  assert.deepEqual(diffRagCorpusBySource(corpus([inheritedLeft]), corpus([inheritedRight])), []);
  assert.equal(inheritedCalls, 2);
});

test('accessor fields stay on the JSON fallback path without being read twice', () => {
  let leftReads = 0;
  let rightReads = 0;
  const left = makeChunk();
  const right = makeChunk();
  Object.defineProperty(left, 'body', { enumerable: true, configurable: true, get() { leftReads += 1; return 'same accessor body'; } });
  Object.defineProperty(right, 'body', { enumerable: true, configurable: true, get() { rightReads += 1; return 'same accessor body'; } });
  assert.deepEqual(diffRagCorpusBySource(corpus([left]), corpus([right])), []);
  assert.equal(leftReads, 1);
  assert.equal(rightReads, 1);
});

test('proxy chunks fall back without extra proxy traps', () => {
  const makeObservedProxy = () => {
    const counts = { get: 0, ownKeys: 0, descriptor: 0 };
    const target = makeChunk();
    const proxy = new Proxy(target, {
      get(value, key, receiver) { counts.get += 1; return Reflect.get(value, key, receiver); },
      ownKeys(value) { counts.ownKeys += 1; return Reflect.ownKeys(value); },
      getOwnPropertyDescriptor(value, key) { counts.descriptor += 1; return Reflect.getOwnPropertyDescriptor(value, key); }
    });
    return { proxy: proxy as RagChunk, counts };
  };
  const expectedProxy = makeObservedProxy();
  const expected = legacyDiff(corpus([expectedProxy.proxy]), corpus([makeChunk()]));
  const expectedCounts = { ...expectedProxy.counts };
  const actualProxy = makeObservedProxy();
  const actual = diffRagCorpusBySource(corpus([actualProxy.proxy]), corpus([makeChunk()]));
  assert.deepEqual(actual, expected);
  assert.deepEqual(actualProxy.counts, expectedCounts);
});

test('missing optional fields with inherited getters fall back without invoking them', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'sourceRevision');
  let getterReads = 0;
  Object.defineProperty(Object.prototype, 'sourceRevision', {
    configurable: true,
    get() { getterReads += 1; return 99; }
  });
  try {
    const previous = makeChunk();
    const next = makeChunk();
    delete (previous as Partial<RagChunk>).sourceRevision;
    delete (next as Partial<RagChunk>).sourceRevision;
    assert.deepEqual(diffRagCorpusBySource(corpus([previous]), corpus([next])), []);
    assert.equal(getterReads, 0, 'JSON and the shape guard must not read inherited non-JSON fields');
  } finally {
    if (previousDescriptor) Object.defineProperty(Object.prototype, 'sourceRevision', previousDescriptor);
    else Reflect.deleteProperty(Object.prototype, 'sourceRevision');
  }
});
test('nonfinite and sparse numericIds preserve legacy JSON semantics via fallback', () => {
  assert.deepEqual(diffRagCorpusBySource(
    corpus([makeChunk({ numericIds: [Number.NaN] })]),
    corpus([makeChunk({ numericIds: [Number.POSITIVE_INFINITY] })])
  ), [], 'JSON.stringify maps nonfinite array numbers to null');
  const sparse = new Array<number>(2);
  sparse[1] = 2;
  const explicitUndefined = [undefined, 2] as unknown as number[];
  assert.deepEqual(diffRagCorpusBySource(
    corpus([makeChunk({ numericIds: sparse })]),
    corpus([makeChunk({ numericIds: explicitUndefined })])
  ), [], 'JSON.stringify maps holes and undefined array items to null');
});

test('production build -> real SQLite persist/hydrate -> build diff is no-op despite reordered optional keys', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const adapter = {
    prepare: (sql: string) => db.prepare(sql),
    transaction: (body: () => void) => ({
      immediate() {
        db.exec('BEGIN IMMEDIATE');
        try { body(); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    })
  } as unknown as SqliteDatabase;
  try {
    initialize(db);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO workspaces(workspace_id,root_path,game,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(WORKSPACE_ID, '/fixture', 'sekiro', now, now);
    const index = new WorkspaceIndex(WORKSPACE_ID);
    index.setFiles([makeIndexedFile()]);
    const repository = new WorkspaceDataRepository(adapter, WORKSPACE_ID);
    const firstBuild = buildRagCorpus(index, 'before');
    persistRagCorpus(repository, firstBuild);
    const persistedChunk = firstBuild.chunks[0]!;
    repository.replaceRagEmbeddings([{
      chunkId: persistedChunk.chunkId,
      model: 'fixture-model',
      vector: new Float32Array([0.25, -0.5]),
      contentHash: persistedChunk.contentHash
    }]);
    const beforeEmbedding = repository.loadRagEmbeddingRecords().find(record => record.chunkId === persistedChunk.chunkId);
    assert.ok(beforeEmbedding, 'fixture embedding must be present before no-op persistence');
    const hydrated = loadRagCorpus(repository, WORKSPACE_ID);
    const nextBuild = buildRagCorpus(index, 'after');
    const hydratedChunk = hydrated.chunks[0]!;
    const rebuiltChunk = nextBuild.chunks[0]!;
    assert.equal(hydratedChunk.outerFileHash, rebuiltChunk.outerFileHash);
    assert.equal(hydratedChunk.sourceHash, rebuiltChunk.sourceHash);
    assert.notDeepEqual(Object.keys(hydratedChunk), Object.keys(rebuiltChunk), 'SQLite hydration and builder use different insertion order');
    persistRagCorpus(repository, nextBuild);
    const afterEmbedding = repository.loadRagEmbeddingRecords().find(record => record.chunkId === persistedChunk.chunkId);
    assert.ok(afterEmbedding, 'a repeated no-op persistence must not delete the existing embedding');
    assert.equal(afterEmbedding.model, beforeEmbedding.model);
    assert.equal(afterEmbedding.contentHash, beforeEmbedding.contentHash);
    assert.deepEqual(Array.from(afterEmbedding.vector), Array.from(beforeEmbedding.vector));
    assert.deepEqual(diffRagCorpusBySource(hydrated, nextBuild), []);
  } finally {
    db.close();
  }
});

function makeChunk(overrides: Partial<RagChunk> = {}): RagChunk {
  return {
    chunkId: 'rag:param_row:one',
    workspaceId: WORKSPACE_ID,
    sourceUri: SOURCE_URI,
    symbolUri: 'param://NpcParam/1',
    family: 'param_row',
    title: 'NpcParam 1',
    body: 'fixture body '.repeat(18),
    numericIds: [1, 2],
    contentHash: 'same-content-hash',
    sourceRevision: 1,
    outerFileHash: 'outer-hash',
    sourceHash: 'source-hash',
    relativePath: 'param/gameparam.parambnd.dcx',
    resourceKind: 'param',
    confidence: 'high',
    taeActionEventCount: 2,
    taeActionEventsComplete: true,
    ...overrides
  };
}

function corpus(chunks: RagChunk[]): RagCorpus {
  const byFamily = Object.fromEntries(FAMILIES.map(family => [family, 0])) as Record<RagChunkFamily, number>;
  for (const chunk of chunks) byFamily[chunk.family] += 1;
  return {
    workspaceId: WORKSPACE_ID,
    builtAt: 'fixture',
    chunks,
    references: [],
    stats: { total: chunks.length, byFamily },
    availability: 'available',
    diagnostics: []
  };
}

function legacyDiff(previous: RagCorpus | null | undefined, next: RagCorpus): RagChunkDelta[] {
  const oldChunks = previous?.chunks ?? [];
  const oldById = new Map(oldChunks.map(chunk => [chunk.chunkId, chunk] as const));
  const nextById = new Map(next.chunks.map(chunk => [chunk.chunkId, chunk] as const));
  const oldBySource = groupChunksBySource(oldChunks);
  const nextBySource = groupChunksBySource(next.chunks);
  const sourceUris = new Set([...oldBySource.keys(), ...nextBySource.keys()]);
  const deltas: RagChunkDelta[] = [];
  for (const sourceUri of sourceUris) {
    const oldForSource = oldBySource.get(sourceUri) ?? [];
    const nextForSource = nextBySource.get(sourceUri) ?? [];
    const deletedChunkIds = oldForSource
      .filter(chunk => nextById.get(chunk.chunkId)?.sourceUri !== sourceUri)
      .map(chunk => chunk.chunkId);
    const upserts = nextForSource.filter(chunk => {
      const old = oldById.get(chunk.chunkId);
      return !old || JSON.stringify(old) !== JSON.stringify(chunk);
    });
    if (deletedChunkIds.length > 0 || upserts.length > 0) deltas.push({ sourceUri, upserts, deletedChunkIds });
  }
  return deltas;
}

function groupChunksBySource(chunks: readonly RagChunk[]): Map<string, RagChunk[]> {
  const grouped = new Map<string, RagChunk[]>();
  for (const chunk of chunks) {
    const bucket = grouped.get(chunk.sourceUri);
    if (bucket) bucket.push(chunk);
    else grouped.set(chunk.sourceUri, [chunk]);
  }
  return grouped;
}

function makeIndexedFile(): IndexedFile {
  const relativePath = 'param/gameparam.parambnd.dcx';
  return {
    id: SOURCE_URI,
    workspaceId: WORKSPACE_ID,
    sourceUri: SOURCE_URI,
    sourcePath: relativePath,
    absolutePath: 'D:/fixture/param/gameparam.parambnd.dcx',
    relativePath,
    game: 'sekiro',
    resourceKind: 'param',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    formatKind: 'param',
    formatLabel: 'PARAM',
    size: 4096,
    mtimeMs: 1,
    sha256: 'a'.repeat(64),
    parseStatus: 'parsed',
    diagnostics: []
  };
}

function initialize(db: DatabaseSync): void {
  for (const migration of SQLITE_MIGRATIONS) {
    db.exec(migration.sql);
    for (const column of migration.addColumns ?? []) {
      const columns = db.prepare(`PRAGMA table_info(${column.table})`).all() as Array<{ name: string }>;
      if (!columns.some(columnInfo => columnInfo.name === column.column)) {
        db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.column} ${column.definition}`);
      }
    }
    if (migration.sqlAfterColumns) db.exec(migration.sqlAfterColumns);
  }
}
