import assert from 'node:assert/strict';
import { createRagCorpus } from '../rag/chunkBuilder.js';
import { resolveRagCorpus, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { EventExport } from '@soulforge/shared';

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
