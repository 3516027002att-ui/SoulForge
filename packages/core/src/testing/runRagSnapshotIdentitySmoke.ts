import assert from 'node:assert/strict';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { getLookupIndex } from '../rag/lookupIndex.js';
import { resolveRagCorpus, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { EventExport, IndexedFile, ParamRowSymbol } from '@soulforge/shared';

const index = new WorkspaceIndex('rag-identity-workspace');
const corpus = createRagCorpus({
  workspaceId: index.workspaceId,
  builtAt: '2026-09-18T00:00:00.000Z',
  chunks: [{
    chunkId: 'file-chunk',
    workspaceId: index.workspaceId,
    sourceUri: 'workspace://rag-identity/file.txt',
    symbolUri: 'workspace://rag-identity/file.txt',
    family: 'file',
    title: 'file.txt',
    body: 'identity fixture',
    numericIds: [],
    contentHash: 'fixture-content-hash'
  }],
  references: []
});

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceIndex: index,
    mode: 'plan',
    rag: corpus,
    workspaceSessionId: 'session-a',
    workspaceSessionGeneration: 7,
    indexedFilesRevision: 11,
    ragSessionId: 'session-a',
    ragGeneration: 7,
    ragIndexedFilesRevision: 11,
    ragEpoch: index.getNativeVersionEpoch(),
    ragScope: 'full',
    ...overrides
  };
}

assert.equal(resolveRagCorpus(context()), corpus, 'matching session identity should reuse the host snapshot');

for (const [label, overrides] of [
  ['session', { workspaceSessionId: 'session-b' }],
  ['snapshot session', { ragSessionId: 'session-b' }],
  ['generation', { workspaceSessionGeneration: 8 }],
  ['snapshot generation', { ragGeneration: 8 }],
  ['catalog revision', { indexedFilesRevision: 12 }],
  ['snapshot catalog revision', { ragIndexedFilesRevision: 12 }],
  ['scope', { ragScope: 'canonical-param' as const }]
] as const) {
  const resolved = resolveRagCorpus(context(overrides));
  assert.notEqual(resolved, corpus, `${label} mismatch must not reuse the old host snapshot`);
}

const missingProvenance = context();
delete missingProvenance.ragSessionId;
delete missingProvenance.ragGeneration;
delete missingProvenance.ragIndexedFilesRevision;
assert.notEqual(
  resolveRagCorpus(missingProvenance),
  corpus,
  'missing provenance must be treated as stale rather than trusted'
);

// A native source may be authoritative only for a partial semantic projection
// while the host already has a complete RAG snapshot for every family that is
// currently available.  Coverage status is not itself a RAG-family absence:
// the prepared snapshot must be reused instead of rebuilding/merging it.
const partialIndex = new WorkspaceIndex('rag-identity-partial');
const partialSourceUri = 'workspace://rag-identity-partial/gameparam.parambnd.dcx';
const partialFile: IndexedFile = {
  id: 'file:rag-identity-partial',
  workspaceId: partialIndex.workspaceId,
  sourceUri: partialSourceUri,
  sourcePath: 'gameparam/gameparam.parambnd.dcx',
  game: 'sekiro',
  resourceKind: 'param',
  parseStatus: 'parsed',
  diagnostics: [],
  absolutePath: 'gameparam/gameparam.parambnd.dcx',
  relativePath: 'gameparam/gameparam.parambnd.dcx',
  extension: '.dcx',
  compoundExtension: '.parambnd.dcx',
  formatKind: 'param',
  formatLabel: 'PARAM',
  size: 1,
  mtimeMs: 3,
  sha256: 'partial-param-hash'
};
partialIndex.setFiles([partialFile]);
const partialRow: ParamRowSymbol = {
  uri: `${partialSourceUri}#PartialParam/1`,
  sourceUri: partialSourceUri,
  paramName: 'PartialParam',
  entryName: 'PartialParam.param',
  entryIndex: 0,
  rowId: 1,
  sourceHash: 'partial-param-hash',
  outerFileHash: 'partial-param-hash',
  sourceRevision: 3,
  fields: []
};
assert.equal(partialIndex.upsertParamExport({
  paramName: 'PartialParam',
  sourceUri: partialSourceUri,
  entryName: 'PartialParam.param',
  entryIndex: 0,
  sourceHash: 'partial-param-hash',
  outerFileHash: 'partial-param-hash',
  sourceRevision: 3,
  rows: [partialRow]
}), true);
partialIndex.markCoveragePartial([partialSourceUri]);
const partialCoverage = partialIndex.getCoverageSnapshot().find((item) => item.domain === 'param');
assert.equal(partialCoverage?.status, 'partial');
assert.equal(partialCoverage?.expectedResources, 1);
const partialCorpus = createRagCorpus({
  workspaceId: partialIndex.workspaceId,
  builtAt: '2026-09-18T00:00:00.000Z',
  chunks: [{
    chunkId: 'partial-file-chunk',
    workspaceId: partialIndex.workspaceId,
    sourceUri: partialSourceUri,
    symbolUri: partialSourceUri,
    family: 'file',
    title: 'gameparam.parambnd.dcx',
    body: 'param partial source',
    numericIds: [],
    contentHash: 'partial-file-content',
    sourceRevision: 3,
    outerFileHash: 'partial-param-hash',
    resourceKind: 'param'
  }, {
    chunkId: 'partial-param-row-chunk',
    workspaceId: partialIndex.workspaceId,
    sourceUri: partialSourceUri,
    symbolUri: partialRow.uri,
    family: 'param_row',
    title: 'PartialParam#1',
    body: 'PartialParam row 1',
    numericIds: [1],
    contentHash: 'partial-row-content',
    sourceRevision: 3,
    outerFileHash: 'partial-param-hash',
    sourceHash: 'partial-param-hash',
    resourceKind: 'param',
    confidence: 'high'
  }],
  references: []
});
const partialPreparedLookup = getLookupIndex(partialCorpus);
assert.ok(partialPreparedLookup);
const partialResolved = resolveRagCorpus({
  workspaceIndex: partialIndex,
  mode: 'plan',
  rag: partialCorpus,
  workspaceSessionId: 'partial-session',
  workspaceSessionGeneration: 1,
  indexedFilesRevision: 1,
  ragSessionId: 'partial-session',
  ragGeneration: 1,
  ragIndexedFilesRevision: 1,
  ragEpoch: partialIndex.getNativeVersionEpoch(),
  ragScope: 'full'
});
assert.equal(
  partialResolved,
  partialCorpus,
  'matching full snapshot must be reused even when native coverage is partial'
);
assert.ok(partialResolved);
assert.equal(
  getLookupIndex(partialResolved),
  partialPreparedLookup,
  'reusing the snapshot must preserve its prepared lookup object'
);

const eventExport: EventExport = {
  events: [{
    uri: 'workspace://rag-identity/event.emevd#event/1',
    sourceUri: 'workspace://rag-identity/event.emevd',
    eventId: 1,
    instructions: []
  }]
};
assert.equal(index.upsertEventExport(eventExport), true);
assert.notEqual(
  resolveRagCorpus(context()),
  corpus,
  'a full snapshot missing a live event family must not be reused'
);

console.log('runRagSnapshotIdentitySmoke: PASS');
