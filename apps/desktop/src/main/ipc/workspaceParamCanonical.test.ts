import assert from 'node:assert/strict';
import {
  buildRagCorpus,
  createRagCorpus,
  diffRagCorpusBySource,
  retrieveEvidence,
  WorkspaceIndex
} from '@soulforge/core';
import type {
  IndexedFile,
  MsgExport,
  ParamExport,
  ParamRowSymbol,
  RagChunk,
  ReferenceEdge
} from '@soulforge/shared';
// Internal-only test access: do not widen @soulforge/core's public export just
// to inspect whether an explicitly deferred corpus has materialized its index.
// @ts-ignore The focused runner reads the built core module directly.
import { ensureLookupIndex, getLookupIndex } from '@soulforge/core/dist/rag/lookupIndex.js';
// @ts-ignore The focused runner executes this source file with Node's experimental TypeScript stripping.
import { createParamCanonicalProjectionCache, mergeCanonicalParamExports, persistCanonicalRagProjection, prepareParamCanonicalProjection } from './workspaceParamCanonical.ts';

const PARAM_SOURCE = 'file://synthetic/param/gameparam.parambnd.dcx';
const SECOND_PARAM_SOURCE = 'file://synthetic/param/drawparam.parambnd.dcx';
const MSG_SOURCE = 'file://synthetic/msg/menu.msgbnd.dcx';
const LOOKUP_PARAM_URI = 'file://synthetic/param/gameparam.parambnd.dcx#NpcParam/50800000';

function makeFile(
  sourceUri: string,
  resourceKind: IndexedFile['resourceKind'],
  sha256 = resourceKind === 'param' ? 'outer-v1' : 'msg-outer',
  mtimeMs = resourceKind === 'param' ? 10 : 20
): IndexedFile {
  const relativePath = resourceKind === 'param'
    ? 'param/gameparam/gameparam.parambnd.dcx'
    : 'msg/menu/menu.msgbnd.dcx';
  return {
    id: sourceUri,
    workspaceId: 'workspace://synthetic',
    sourceUri,
    sourcePath: relativePath,
    game: 'sekiro',
    resourceKind,
    parseStatus: 'parsed',
    diagnostics: [],
    absolutePath: `C:/synthetic/${relativePath}`,
    relativePath,
    extension: '.dcx',
    compoundExtension: resourceKind === 'param' ? '.parambnd.dcx' : '.msgbnd.dcx',
    formatKind: resourceKind === 'param' ? 'param' : 'fmg',
    formatLabel: resourceKind.toUpperCase(),
    size: 100,
    mtimeMs,
    sha256
  };
}

function makeParamRow(
  sourceUri: string,
  entryName: string,
  rowId: number,
  outerFileHash: string,
  sourceRevision: number,
  value: string,
  includeFields = true
): ParamRowSymbol {
  return {
    uri: `${sourceUri}#${entryName}/${rowId}`,
    sourceUri,
    paramName: entryName.replace(/\.param$/i, ''),
    entryName,
    entryIndex: rowId,
    rowId,
    outerFileHash,
    sourceRevision,
    ...(includeFields ? { fields: [{ fieldId: 'name', name: 'name', type: 'string', value }] } : {})
  };
}

function makeParamExport(
  sourceUri: string,
  entryName: string,
  outerFileHash: string,
  sourceRevision: number,
  value: string,
  includeFields = true
): ParamExport {
  return {
    sourceUri,
    entryName,
    entryIndex: entryName === 'NpcParam.param' ? 0 : 1,
    paramName: entryName.replace(/\.param$/i, ''),
    outerFileHash,
    sourceRevision,
    rows: [makeParamRow(sourceUri, entryName, entryName === 'NpcParam.param' ? 100 : 200, outerFileHash, sourceRevision, value, includeFields)]
  };
}

function makeRichParamExport(
  sourceUri: string,
  entryName: string,
  entryIndex: number,
  outerFileHash: string,
  sourceRevision: number,
  rowCount: number
): ParamExport {
  return {
    sourceUri,
    entryName,
    entryIndex,
    paramName: entryName.replace(/\.param$/i, ''),
    outerFileHash,
    sourceRevision,
    rows: Array.from({ length: rowCount }, (_, offset) => {
      const rowId = (entryIndex + 1) * 1000 + offset;
      return {
        uri: `${sourceUri}#${entryName}/${rowId}`,
        sourceUri,
        paramName: entryName.replace(/\.param$/i, ''),
        entryName,
        entryIndex,
        rowId,
        outerFileHash,
        sourceRevision,
        fields: [
          { fieldId: 'name', name: 'name', type: 'string', description: 'display name', value: `${entryName}-${offset}` },
          { fieldId: 'enabled', name: 'enabled', type: 'bool', value: offset % 2 === 0 }
        ],
        raw: {
          rowId,
          nested: {
            entryName,
            values: [offset, offset + 1]
          }
        }
      };
    })
  };
}

function makeBaseIndex(): WorkspaceIndex {
  const index = new WorkspaceIndex('workspace://synthetic');
  index.setFiles([
    makeFile(PARAM_SOURCE, 'param'),
    makeFile(MSG_SOURCE, 'msg')
  ]);
  // Generic parser rows intentionally have no decoded fields: this mirrors
  // the old catalog-only PARAM body that must not leak into canonical RAG.
  index.upsertParamExport(makeParamExport(PARAM_SOURCE, 'NpcParam.param', 'outer-v1', 10, 'generic-good', false));
  index.upsertParamExport(makeParamExport(PARAM_SOURCE, 'ItemLotParam.param', 'outer-v1', 10, 'generic-failed', false));
  const msg: MsgExport = {
    category: 'MenuText',
    outerFileHash: 'msg-outer',
    sourceRevision: 20,
    entries: [{
      uri: `${MSG_SOURCE}#MenuText/1`,
      sourceUri: MSG_SOURCE,
      category: 'MenuText',
      textId: 1,
      text: 'non-param survives'
    }]
  };
  index.upsertMsgExport(msg);
  return index;
}

function makeLookupRegressionCorpus(lookupIndex?: 'eager' | 'deferred') {
  const workspaceId = 'workspace://lookup-regression';
  const textUri = 'file://synthetic/msg/menu.msgbnd.dcx#MenuText/50800000';
  const chunks: RagChunk[] = [
    {
      chunkId: 'lookup-param-row',
      workspaceId,
      sourceUri: 'file://synthetic/param/gameparam.parambnd.dcx',
      symbolUri: LOOKUP_PARAM_URI,
      family: 'param_row',
      title: 'NpcParam 鬼刑部 50800000',
      body: '鬼刑部 50800000 ninsatuNum value=3',
      numericIds: [50800000],
      contentHash: 'lookup-param-hash',
      sourceRevision: 1,
      outerFileHash: 'lookup-param-outer',
      sourceHash: 'lookup-param-source',
      resourceKind: 'param'
    },
    {
      chunkId: 'lookup-text-entry',
      workspaceId,
      sourceUri: 'file://synthetic/msg/menu.msgbnd.dcx',
      symbolUri: textUri,
      family: 'text_entry',
      title: '葦名城 MenuText',
      body: '葦名城',
      numericIds: [],
      contentHash: 'lookup-text-hash',
      sourceRevision: 2,
      outerFileHash: 'lookup-text-outer',
      sourceHash: 'lookup-text-source',
      resourceKind: 'msg'
    }
  ];
  const references: ReferenceEdge[] = [{
    fromUri: LOOKUP_PARAM_URI,
    toUri: textUri,
    kind: 'references_text',
    confidence: 'high',
    reason: 'synthetic PARAM↔FMG lookup regression',
    evidence: [{
      sourceUri: chunks[0]!.sourceUri,
      fieldName: 'name',
      value: '鬼刑部'
    }]
  }];
  return createRagCorpus({
    workspaceId,
    builtAt: 'lookup-regression',
    chunks,
    references,
    ...(lookupIndex ? { lookupIndex } : {})
  });
}

function summarizeLookupResult(result: ReturnType<typeof retrieveEvidence>): unknown {
  assert.equal(result.ok, true);
  if (!result.ok) return result;
  return {
    hitIds: result.hits.map((hit) => hit.chunk.chunkId),
    expanded: result.hits.filter((hit) => hit.expandedFrom !== undefined).map((hit) => hit.chunk.chunkId),
    scores: result.hits.map((hit) => hit.score),
    stats: result.stats,
    diagnostics: result.diagnostics ?? []
  };
}

function makeRefresh(
  calls: { value: number },
  status: 'refreshed' | 'partial' | 'failed' | 'stale',
  options: { abort?: AbortController; emit?: 'good' | 'none' } = {}
) {
  return async (input: Parameters<NonNullable<Parameters<typeof prepareParamCanonicalProjection>[0]['refresh']>>[0]) => {
    calls.value += 1;
    const file = input.sourceFiles[0]!;
    if (options.emit === 'good') {
      input.index.upsertParamExport(makeParamExport(
        file.sourceUri,
        'NpcParam.param',
        file.sha256 ?? 'outer-v1',
        file.mtimeMs,
        `native-${file.sha256 ?? 'outer-v1'}`
      ));
    }
    options.abort?.abort();
    return {
      refreshedSources: status === 'refreshed' ? [file.sourceUri] : [],
      partialSources: status === 'partial' ? [file.sourceUri] : [],
      failedSources: status === 'failed' ? [file.sourceUri] : [],
      staleSources: status === 'stale' ? [file.sourceUri] : [],
      diagnostics: status === 'partial' ? [{
        severity: 'warning' as const,
        code: 'PARAM_CANONICAL_TEST_LEAF_SKIPPED',
        message: 'synthetic failed leaf',
        sourceUri: file.sourceUri
      }] : []
    };
  };
}

async function run(): Promise<void> {
  // A partial native read keeps only the successful native leaf.  The generic
  // failed leaf is removed from the canonical clone, while MSG remains.
  const partialCalls = { value: 0 };
  const partialIndex = makeBaseIndex();
  const partial = await prepareParamCanonicalProjection({
    index: partialIndex,
    sourceFiles: partialIndex.getFiles(),
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: createParamCanonicalProjectionCache(),
    refresh: makeRefresh(partialCalls, 'partial', { emit: 'good' })
  });
  assert.equal(partial.publishable, true);
  assert.equal(partialCalls.value, 1);
  assert.deepEqual(partial.partialSources, [PARAM_SOURCE]);
  assert.deepEqual(partial.canonicalExports.map((item) => item.entryName), ['NpcParam.param']);
  assert.equal(partial.canonicalIndex.toSymbolBundle().params?.some((item) => item.entryName === 'ItemLotParam.param'), false);
  assert.equal(partial.canonicalIndex.toSymbolBundle().msgs?.[0]?.entries[0]?.text, 'non-param survives');
  const partialRag = buildRagCorpus(partial.canonicalIndex);
  assert.equal(partialRag.chunks.some((chunk) => chunk.family === 'param_row' && chunk.body.includes('generic-failed')), false);
  assert.equal(partialRag.chunks.some((chunk) => chunk.family === 'param_row' && chunk.body.includes('native-outer-v1')), true);

  // The same-generation final projection reuses a refreshed/partial receipt;
  // use one explicit shared cache so the behavior remains observable without
  // exposing cache internals in the production result.
  const sharedCache = createParamCanonicalProjectionCache();
  const sharedCalls = { value: 0 };
  const firstShared = await prepareParamCanonicalProjection({
    index: makeBaseIndex(),
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: sharedCache,
    refresh: makeRefresh(sharedCalls, 'refreshed', { emit: 'good' })
  });
  const secondShared = await prepareParamCanonicalProjection({
    index: makeBaseIndex(),
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: sharedCache,
    refresh: makeRefresh(sharedCalls, 'refreshed', { emit: 'good' })
  });
  assert.equal(firstShared.publishable, true);
  assert.equal(secondShared.reusedSourceUris.includes(PARAM_SOURCE), true);
  assert.equal(sharedCalls.value, 1, 'same source identity must not decode twice');

  // Keep two tables and several rows here so the regression protects complete
  // fields/raw payloads as well as isolation between the candidate, receipt,
  // and structured live index.  The hook rejects any whole-source clone (a
  // ParamExport object or ParamExport[] passed to one structuredClone), while
  // the clone implementation remains free to copy primitive DTO fields
  // directly instead of routing every row through structuredClone.
  const richSource = 'file://synthetic/param/rich.parambnd.dcx';
  const richFile = makeFile(richSource, 'param', 'rich-v1', 30);
  const richIndex = new WorkspaceIndex('workspace://synthetic-rich');
  richIndex.setFiles([richFile]);
  const richCache = createParamCanonicalProjectionCache();
  const richCalls = { value: 0 };
  const richExports = [
    makeRichParamExport(richSource, 'NpcParam.param', 0, 'rich-v1', 30, 3),
    makeRichParamExport(richSource, 'ItemLotParam.param', 1, 'rich-v1', 30, 2)
  ];
  const cloneInputs: unknown[] = [];
  const originalStructuredClone = globalThis.structuredClone;
  const originalStructuredCloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
  const hookedStructuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    cloneInputs.push(value);
    return originalStructuredClone(value, options);
  }) as typeof globalThis.structuredClone;
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    enumerable: originalStructuredCloneDescriptor?.enumerable ?? true,
    writable: true,
    value: hookedStructuredClone
  });
  let rich!: Awaited<ReturnType<typeof prepareParamCanonicalProjection>>;
  try {
    rich = await prepareParamCanonicalProjection({
      index: richIndex,
      sourceFiles: [richFile],
      stagingRoot: 'C:/synthetic/staging',
      allowedRoots: [],
      cache: richCache,
      refresh: async (input) => {
        richCalls.value += 1;
        for (const value of richExports) assert.equal(input.index.upsertParamExport(value), true);
        return {
          refreshedSources: [richSource],
          partialSources: [],
          failedSources: [],
          staleSources: [],
          diagnostics: []
        };
      }
    });
  } finally {
    if (originalStructuredCloneDescriptor) {
      Object.defineProperty(globalThis, 'structuredClone', originalStructuredCloneDescriptor);
    } else {
      delete (globalThis as { structuredClone?: typeof structuredClone }).structuredClone;
    }
  }
  assert.equal(richCalls.value, 1);
  assert.deepEqual(rich.canonicalExports, richExports, 'all rich table rows, fields, and raw payloads must survive');
  assert.equal(cloneInputs.some((value) => {
    if (Array.isArray(value)) {
      return value.some((item) => Boolean(item && typeof item === 'object' && 'rows' in item));
    }
    return Boolean(value && typeof value === 'object' && 'rows' in value);
  }), false, 'desktop hook must not structuredClone a whole ParamExport or ParamExport[]');
  const sourceRichRow = richExports[0]!.rows[0]!;
  const candidateRichRow = rich.canonicalExports[0]!.rows[0]!;
  const reusedRich = await prepareParamCanonicalProjection({
    index: richIndex,
    sourceFiles: [richFile],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: richCache,
    refresh: async () => { throw new Error('cached rich source should not refresh'); }
  });
  assert.equal(reusedRich.reusedSourceUris.includes(richSource), true);
  const reusedRichRow = reusedRich.canonicalExports[0]!.rows[0]!;
  assert.notStrictEqual(reusedRich.canonicalExports[0]!.rows, richExports[0]!.rows, 'cached rows must not share the source array');
  assert.notStrictEqual(reusedRichRow, sourceRichRow, 'cached row must not share the source DTO');
  assert.notStrictEqual(reusedRichRow.fields, sourceRichRow.fields, 'cached fields array must be isolated');
  assert.notStrictEqual(reusedRichRow.fields![0], sourceRichRow.fields![0], 'cached field objects must be isolated');
  assert.notStrictEqual(reusedRichRow.raw, sourceRichRow.raw, 'cached raw object must be isolated');
  assert.notStrictEqual(
    (reusedRichRow.raw as { nested: unknown }).nested,
    (sourceRichRow.raw as { nested: unknown }).nested,
    'cached raw nested object must be isolated'
  );
  assert.deepEqual(candidateRichRow.fields, sourceRichRow.fields, 'field values and descriptions must survive');
  assert.deepEqual(candidateRichRow.raw, sourceRichRow.raw, 'raw nested payload must survive');
  assert.deepEqual(reusedRichRow.fields, sourceRichRow.fields, 'cached field values and descriptions must survive');
  assert.deepEqual(reusedRichRow.raw, sourceRichRow.raw, 'cached raw nested payload must survive');

  rich.canonicalExports[0]!.rows[0]!.fields![0]!.value = 'mutated-result';
  (rich.canonicalExports[0]!.rows[0]!.raw as { nested: { values: number[] } }).nested.values[0] = 999;
  assert.equal(reusedRich.canonicalExports[0]!.rows[0]!.fields![0]!.value, 'NpcParam.param-0');
  assert.deepEqual((reusedRich.canonicalExports[0]!.rows[0]!.raw as { nested: { values: number[] } }).nested.values, [0, 1]);

  const liveRichIndex = new WorkspaceIndex('workspace://synthetic-rich');
  mergeCanonicalParamExports(liveRichIndex, reusedRich.canonicalExports);
  const liveRichRow = liveRichIndex.toSymbolBundle().params?.[0]?.rows[0];
  assert.ok(liveRichRow);
  reusedRich.canonicalExports[0]!.rows[0]!.fields![0]!.value = 'mutated-after-merge';
  (reusedRich.canonicalExports[0]!.rows[0]!.raw as { nested: { values: number[] } }).nested.values[1] = 888;
  assert.equal(liveRichRow!.fields![0]!.value, 'NpcParam.param-0', 'live index must not share fields with merge input');
  assert.deepEqual((liveRichRow!.raw as { nested: { values: number[] } }).nested.values, [0, 1], 'live index must not share raw with merge input');

  const reusedRichAgain = await prepareParamCanonicalProjection({
    index: richIndex,
    sourceFiles: [richFile],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: richCache,
    refresh: async () => { throw new Error('cached rich source should not refresh'); }
  });
  assert.equal(reusedRichAgain.canonicalExports[0]!.rows[0]!.fields![0]!.value, 'NpcParam.param-0');
  assert.deepEqual((reusedRichAgain.canonicalExports[0]!.rows[0]!.raw as { nested: { values: number[] } }).nested.values, [0, 1]);
  assert.equal(richCalls.value, 1, 'rich source identity should remain cached after result/live mutations');

  // A changed outer hash/mtime is a new identity and must reread.
  const changedFile = makeFile(PARAM_SOURCE, 'param', 'outer-v2', 11);
  const changedIndex = makeBaseIndex();
  changedIndex.setFiles([changedFile, makeFile(MSG_SOURCE, 'msg')]);
  const changed = await prepareParamCanonicalProjection({
    index: changedIndex,
    sourceFiles: [changedFile],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: sharedCache,
    refresh: makeRefresh(sharedCalls, 'refreshed', { emit: 'good' })
  });
  assert.equal(changed.reusedSourceUris.includes(PARAM_SOURCE), false);
  assert.equal(sharedCalls.value, 2, 'new outer identity must trigger a native reread');
  assert.equal(changed.canonicalExports[0]?.outerFileHash, 'outer-v2');

  // A failed/stale source is fail-closed even if the generic clone had rows.
  for (const status of ['failed', 'stale'] as const) {
    const calls = { value: 0 };
    const index = makeBaseIndex();
    const result = await prepareParamCanonicalProjection({
      index,
      sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
      stagingRoot: 'C:/synthetic/staging',
      allowedRoots: [],
      cache: createParamCanonicalProjectionCache(),
      refresh: makeRefresh(calls, status, { emit: 'good' })
    });
    assert.equal(calls.value, 1);
    assert.equal(result.canonicalExports.length, 0);
    assert.equal(result.canonicalIndex.toSymbolBundle().params?.length ?? 0, 0);
  }

  // Two PARAM containers are independent source transactions: a failed
  // source must not erase the successful source or reintroduce its generic
  // rows into the canonical candidate.
  const twoSourceIndex = makeBaseIndex();
  const secondSourceFile = makeFile(SECOND_PARAM_SOURCE, 'param', 'draw-v1', 30);
  twoSourceIndex.setFiles([...twoSourceIndex.getFiles(), secondSourceFile]);
  twoSourceIndex.upsertParamExport(makeParamExport(SECOND_PARAM_SOURCE, 'DrawParam.param', 'draw-v1', 30, 'generic-draw', false));
  const twoSourceCalls = { value: 0 };
  const twoSource = await prepareParamCanonicalProjection({
    index: twoSourceIndex,
    sourceFiles: [makeFile(PARAM_SOURCE, 'param'), secondSourceFile],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: createParamCanonicalProjectionCache(),
    refresh: async (input) => {
      twoSourceCalls.value += 1;
      const good = input.sourceFiles.find((file) => file.sourceUri === PARAM_SOURCE)!;
      input.index.upsertParamExport(makeParamExport(good.sourceUri, 'NpcParam.param', good.sha256!, good.mtimeMs, 'native-good'));
      return {
        refreshedSources: [PARAM_SOURCE],
        partialSources: [],
        failedSources: [SECOND_PARAM_SOURCE],
        staleSources: [],
        diagnostics: [{
          severity: 'warning' as const,
          code: 'PARAM_CANONICAL_TEST_SECOND_FAILED',
          message: 'synthetic second source failed',
          sourceUri: SECOND_PARAM_SOURCE
        }]
      };
    }
  });
  assert.equal(twoSourceCalls.value, 1);
  assert.deepEqual(twoSource.canonicalExports.map((item) => item.sourceUri), [PARAM_SOURCE]);
  assert.equal(twoSource.canonicalIndex.toSymbolBundle().params?.some((item) => item.sourceUri === SECOND_PARAM_SOURCE), false);

  // Exercise the production IPC runtime helper, not a test-side copy of its
  // filtering/delta assembly.  Leave a second unattempted PARAM source in the
  // index to prove it and MSG survive the attempted-source replacement.
  const runtimeIndex = partial.canonicalIndex.cloneForRefresh();
  runtimeIndex.setFiles([...runtimeIndex.getFiles(), secondSourceFile]);
  runtimeIndex.upsertParamExport(makeParamExport(SECOND_PARAM_SOURCE, 'DrawParam.param', 'draw-v1', 30, 'generic-draw', false));
  const durableIndex = makeBaseIndex();
  durableIndex.setFiles([...durableIndex.getFiles(), secondSourceFile]);
  durableIndex.upsertParamExport(makeParamExport(SECOND_PARAM_SOURCE, 'DrawParam.param', 'draw-v1', 30, 'generic-draw', false));
  const durable = buildRagCorpus(durableIndex);
  const recordingStore = {
    corpus: durable,
    calls: [] as Array<{ previous: typeof durable; corpus: typeof durable; deltas: ReturnType<typeof diffRagCorpusBySource> }>
  };
  const persistRuntime = async (corpus: typeof durable, previous: typeof durable): Promise<void> => {
    assert.ok(getLookupIndex(corpus), 'final merge corpus must be indexed before persistence callback');
    assert.equal(getLookupIndex(previous), undefined, 'deferred persisted corpus must not build an intermediate index');
    const deltas = diffRagCorpusBySource(previous, corpus);
    recordingStore.calls.push({ previous, corpus, deltas });
    recordingStore.corpus = corpus;
  };
  const firstRuntime = await persistCanonicalRagProjection({
    index: runtimeIndex,
    attemptedParamSourceUris: [PARAM_SOURCE],
    now: '2026-09-09T00:00:00.000Z',
    loadPersisted: async () => ({ chunks: recordingStore.corpus.chunks, references: recordingStore.corpus.references }),
    persist: persistRuntime
  });
  assert.equal(getLookupIndex(firstRuntime.catalog), undefined, 'catalog must defer lookup construction');
  assert.equal(getLookupIndex(firstRuntime.persisted), undefined, 'persisted corpus must defer lookup construction');
  assert.equal(getLookupIndex(firstRuntime.mergeView), undefined, 'filtered intermediate corpus must defer lookup construction');
  assert.ok(getLookupIndex(firstRuntime.corpus), 'final merge corpus must retain eager lookup construction');
  const failedChunkId = durable.chunks.find((chunk) => chunk.family === 'param_row' && chunk.symbolUri.includes('ItemLotParam'))?.chunkId;
  assert.ok(failedChunkId, 'durable fixture must include the failed generic row');
  assert.equal(recordingStore.calls[0]?.deltas.some((delta) => delta.deletedChunkIds.includes(failedChunkId!)), true);
  assert.equal(firstRuntime.corpus.chunks.some((chunk) => chunk.symbolUri.includes('DrawParam')), true, 'unattempted PARAM source must survive');
  assert.equal(firstRuntime.corpus.chunks.some((chunk) => chunk.family === 'text_entry' && chunk.sourceUri === MSG_SOURCE), true, 'MSG must survive PARAM replacement');
  const finalRuntime = await persistCanonicalRagProjection({
    index: runtimeIndex,
    attemptedParamSourceUris: [PARAM_SOURCE],
    now: '2026-09-09T00:00:01.000Z',
    loadPersisted: async () => ({ chunks: recordingStore.corpus.chunks, references: recordingStore.corpus.references }),
    persist: persistRuntime
  });
  assert.equal(finalRuntime.corpus.chunks.length, firstRuntime.corpus.chunks.length);
  assert.equal(recordingStore.calls.length, 2);
  assert.equal(recordingStore.calls[1]?.deltas.reduce((count, delta) => count + delta.upserts.length, 0), 0, 'stage->final canonical reuse must not upsert');
  assert.equal(recordingStore.calls[1]?.deltas.reduce((count, delta) => count + delta.deletedChunkIds.length, 0), 0, 'stage->final canonical reuse must not rebuild/delete FTS rows');

  // The public defaults remain eager while the explicit deferred mode is
  // equivalent after ensureLookupIndex.  Keep the WeakMap inspection internal
  // to this test; @soulforge/core's public surface stays unchanged.
  const defaultBuilt = buildRagCorpus(durableIndex, 'lookup-default');
  const deferredBuilt = buildRagCorpus(
    durableIndex,
    'lookup-deferred',
    [],
    undefined,
    undefined,
    { lookupIndex: 'deferred' }
  );
  assert.ok(getLookupIndex(defaultBuilt), 'buildRagCorpus default must remain eager');
  assert.equal(getLookupIndex(deferredBuilt), undefined, 'buildRagCorpus deferred must not build an index');
  ensureLookupIndex(deferredBuilt);
  assert.ok(getLookupIndex(deferredBuilt), 'deferred build must materialize on ensure');

  const eagerLookupCorpus = makeLookupRegressionCorpus();
  const deferredLookupCorpus = makeLookupRegressionCorpus('deferred');
  assert.ok(getLookupIndex(eagerLookupCorpus), 'createRagCorpus default must remain eager');
  assert.equal(getLookupIndex(deferredLookupCorpus), undefined, 'createRagCorpus deferred must not build an index');
  ensureLookupIndex(deferredLookupCorpus);
  assert.ok(getLookupIndex(deferredLookupCorpus), 'deferred corpus must materialize on ensure');
  const lookupQueries: Array<{ query: string; expandReferences: boolean }> = [
    { query: '50800000', expandReferences: false },
    { query: '鬼刑部', expandReferences: false },
    { query: '50800000', expandReferences: true }
  ];
  for (const [index, item] of lookupQueries.entries()) {
    const eagerResult = retrieveEvidence(eagerLookupCorpus, item.query, {
      expandReferences: item.expandReferences,
      readerSchema: `lookup-eager-${index}`
    });
    const deferredResult = retrieveEvidence(deferredLookupCorpus, item.query, {
      expandReferences: item.expandReferences,
      readerSchema: `lookup-deferred-${index}`
    });
    assert.deepEqual(
      summarizeLookupResult(deferredResult),
      summarizeLookupResult(eagerResult),
      `deferred lookup must preserve ID/CJK/reference result for ${item.query} (expand=${item.expandReferences})`
    );
    assert.ok(
      eagerResult.ok && eagerResult.hits.some((hit) => hit.chunk.chunkId === 'lookup-param-row'),
      `eager lookup must return the primary PARAM hit for ${item.query}`
    );
    assert.ok(
      deferredResult.ok && deferredResult.hits.some((hit) => hit.chunk.chunkId === 'lookup-param-row'),
      `deferred lookup must return the primary PARAM hit for ${item.query}`
    );
    if (item.expandReferences) {
      assert.ok(
        eagerResult.ok && eagerResult.hits.some((hit) => hit.chunk.chunkId === 'lookup-text-entry' && hit.expandedFrom === LOOKUP_PARAM_URI),
        'eager reference expansion must return the linked text entry'
      );
      assert.ok(
        deferredResult.ok && deferredResult.hits.some((hit) => hit.chunk.chunkId === 'lookup-text-entry' && hit.expandedFrom === LOOKUP_PARAM_URI),
        'deferred reference expansion must return the linked text entry'
      );
    }
  }

  // Cancellation never publishes a speculative accepted leaf and does not
  // seed the same-generation cache.
  const cancellation = new AbortController();
  const cancellationCalls = { value: 0 };
  const cancellationCache = createParamCanonicalProjectionCache();
  const cancellationIndex = makeBaseIndex();
  const aborted = await prepareParamCanonicalProjection({
    index: cancellationIndex,
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    signal: cancellation.signal,
    cache: cancellationCache,
    refresh: makeRefresh(cancellationCalls, 'refreshed', { emit: 'good', abort: cancellation })
  });
  assert.equal(aborted.publishable, false);
  assert.equal(aborted.canonicalExports.length, 0);
  const afterAbort = await prepareParamCanonicalProjection({
    index: cancellationIndex,
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    cache: cancellationCache,
    refresh: makeRefresh(cancellationCalls, 'refreshed', { emit: 'good' })
  });
  assert.equal(afterAbort.publishable, true);
  assert.equal(cancellationCalls.value, 2, 'cancelled refresh must not be cached');

  const preCancelled = new AbortController();
  preCancelled.abort();
  const preCancelledCalls = { value: 0 };
  const preCancelledResult = await prepareParamCanonicalProjection({
    index: makeBaseIndex(),
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    signal: preCancelled.signal,
    cache: createParamCanonicalProjectionCache(),
    refresh: makeRefresh(preCancelledCalls, 'refreshed', { emit: 'good' })
  });
  assert.equal(preCancelledResult.publishable, false);
  assert.equal(preCancelledCalls.value, 0, 'pre-cancel must not enter native refresh');

  const nativeAwaitController = new AbortController();
  let nativeStarted!: () => void;
  const nativeStartedPromise = new Promise<void>((resolve) => { nativeStarted = resolve; });
  let releaseNative!: () => void;
  const nativeReleasePromise = new Promise<void>((resolve) => { releaseNative = resolve; });
  const nativeAwaitTask = prepareParamCanonicalProjection({
    index: makeBaseIndex(),
    sourceFiles: [makeFile(PARAM_SOURCE, 'param')],
    stagingRoot: 'C:/synthetic/staging',
    allowedRoots: [],
    signal: nativeAwaitController.signal,
    cache: createParamCanonicalProjectionCache(),
    refresh: async () => {
      nativeStarted();
      await nativeReleasePromise;
      return { refreshedSources: [PARAM_SOURCE], partialSources: [], failedSources: [], staleSources: [], diagnostics: [] };
    }
  });
  await nativeStartedPromise;
  nativeAwaitController.abort();
  releaseNative();
  const nativeAwaitResult = await nativeAwaitTask;
  assert.equal(nativeAwaitResult.publishable, false, 'native await cancellation must not publish');

  console.log('[workspace-param-canonical] PASS: partial/fail-closed/non-PARAM/cancel/cache/identity + deferred/eager lookup matrix');
}

await run();
