import assert from 'node:assert/strict';
import type {
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamExport,
  TaeExport
} from '@soulforge/shared';
import { buildRagCorpus } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { refreshKnowledgeAfterCommit } from '../indexing/knowledgeRefresh.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const SOURCES = {
  event: 'file://synthetic/event/common.emevd.dcx',
  map: 'file://synthetic/map/m10_00_00_00.msb.dcx',
  param: 'file://synthetic/param/gameparam.parambnd.dcx',
  msg: 'file://synthetic/msg/zhocn.msgbnd.dcx',
  action: 'file://synthetic/chr/c0000.anibnd.dcx'
} as const;

async function main(): Promise<void> {
  // Live Bridge reads use absolute file URLs, while the workspace scanner
  // owns relative file URLs.  A changed relative source must invalidate the
  // absolute-provenance symbol too, or the next query can return stale data.
  const aliasIndex = new WorkspaceIndex('workspace-source-uri-alias');
  const aliasRelativeFile = makeFile(SOURCES.event, 'event', 'v1');
  aliasIndex.setFiles([{
    ...aliasRelativeFile,
    absolutePath: 'D:/synthetic-workspace/event/common.emevd.dcx'
  }]);
  const absoluteLiveSource = 'file:///D:/synthetic-workspace/event/common.emevd.dcx';
  aliasIndex.upsertEventExport(makeEvent(absoluteLiveSource, 'v1', 'absolute-old-value'));
  const aliasInvalidation = aliasIndex.invalidateChangedSources([SOURCES.event]);
  assert.equal(aliasInvalidation.removed.events, 1, 'relative and absolute file URLs must share invalidation identity');
  assert.equal(aliasIndex.getFile(absoluteLiveSource)?.sourceUri, SOURCES.event, 'absolute live URI must resolve to the scanned file');

  // If callers ever merge two workspace roots into one index, the same
  // relative URI is ambiguous.  Reads and invalidation must refuse to pick a
  // root silently rather than deleting or returning the wrong projection.
  const ambiguousIndex = new WorkspaceIndex('workspace-source-uri-ambiguous');
  ambiguousIndex.setFiles([
    {
      ...makeFile('file://root-a/event/common.emevd.dcx', 'event', 'v1'),
      absolutePath: 'D:/root-a/event/common.emevd.dcx',
      relativePath: 'event/common.emevd.dcx'
    },
    {
      ...makeFile('file://root-b/event/common.emevd.dcx', 'event', 'v1'),
      absolutePath: 'D:/root-b/event/common.emevd.dcx',
      relativePath: 'event/common.emevd.dcx'
    }
  ]);
  const ambiguousSource = 'file://event/common.emevd.dcx';
  ambiguousIndex.upsertEventExport(makeEvent('file:///D:/root-a/event/common.emevd.dcx', 'v1', 'ambiguous-old-value'));
  const ambiguousInvalidation = ambiguousIndex.invalidateChangedSources([ambiguousSource]);
  assert.equal(ambiguousInvalidation.removed.events, 0, 'ambiguous relative URI must not invalidate an arbitrary root');
  assert.equal(ambiguousIndex.getFile(ambiguousSource), undefined, 'ambiguous relative URI must not resolve an arbitrary root');

  const oldIndex = makeIndex('v1', 'old-value');
  const newIndex = makeIndex('v2', 'new-value');
  let persisted: ReturnType<typeof buildRagCorpus> | undefined;

  const committed = await refreshKnowledgeAfterCommit({
    index: oldIndex,
    beforeFiles: oldIndex.getFiles(),
    afterFiles: newIndex.getFiles(),
    requestedSources: Object.values(SOURCES),
    reanalyze: async () => newIndex,
    persist: async (index) => {
      persisted = buildRagCorpus(index);
    }
  });
  assert.equal(committed.result.status, 'converged');
  assert.equal(committed.result.semanticState, 'reanalyzed');
  assert.ok(persisted, 'post-commit refresh must persist the converged corpus');
  assertImmediateTruth(persisted!, 'old-value', 'new-value', 'v2');

  // Rollback is another committed native mutation.  It must use the same
  // boundary and make the restored revision visible before the next query.
  const rolledBack = await refreshKnowledgeAfterCommit({
    index: newIndex,
    beforeFiles: newIndex.getFiles(),
    afterFiles: oldIndex.getFiles(),
    requestedSources: Object.values(SOURCES),
    reanalyze: async () => makeIndex('v1', 'old-value'),
    persist: async (index) => {
      persisted = buildRagCorpus(index);
    }
  });
  assert.equal(rolledBack.result.status, 'converged');
  assert.ok(persisted, 'rollback refresh must persist the restored corpus');
  assertImmediateTruth(persisted!, 'new-value', 'old-value', 'v1');

  // A failed reanalysis must leave the changed source invalidated.  Returning
  // success with the pre-commit semantic projection would make the next
  // query lie about the bytes that were just committed.
  const failureBase = makeIndex('v1', 'old-value');
  const failureAfter = makeIndex('v2', 'new-value');
  let failedPersisted: ReturnType<typeof buildRagCorpus> | undefined;
  const failed = await refreshKnowledgeAfterCommit({
    index: failureBase,
    beforeFiles: failureBase.getFiles(),
    afterFiles: failureAfter.getFiles(),
    requestedSources: Object.values(SOURCES),
    reanalyze: async () => {
      throw new Error('forced-reanalysis-failure');
    },
    persist: async (index) => {
      failedPersisted = buildRagCorpus(index);
    }
  });
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.semanticState, 'empty');
  assert.equal(failed.result.error, 'forced-reanalysis-failure');
  assert.ok(failedPersisted, 'failed refresh must persist the invalidated state');
  assert.equal(failedPersisted!.chunks.some((chunk) => chunk.body.includes('old-value')), false);
  const failedQuery = retrieveEvidence(failedPersisted!, 'new-value');
  if (failedQuery.ok) {
    assert.equal(failedQuery.hits.some((hit) => hit.chunk.body.includes('new-value')), false);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'post-commit knowledge refresh immediate-query smoke: ok',
    changedSources: committed.result.changedSources.length,
    rollbackSources: rolledBack.result.changedSources.length,
    failedRefreshStatus: failed.result.status,
    sourceUriAliasInvalidated: aliasInvalidation.removed.events,
    ambiguousSourceRejected: ambiguousIndex.getFile(ambiguousSource) === undefined,
    families: ['event', 'map_entity', 'param_row', 'text_entry', 'tae_event'],
    nonClaims: ['synthetic writer callback fixture; native writer authority is covered by domain-specific native smokes']
  }, null, 2));
}

function assertImmediateTruth(
  corpus: ReturnType<typeof buildRagCorpus>,
  forbidden: string,
  expected: string,
  expectedHash: string
): void {
  assert.equal(corpus.chunks.some((chunk) => chunk.body.includes(forbidden)), false, `${forbidden} survived refresh`);
  const result = retrieveEvidence(corpus, expected);
  assert.equal(result.ok, true, `immediate query for ${expected} must succeed`);
  assert.ok(result.hits.some((hit) => hit.chunk.body.includes(expected)), `immediate query missed ${expected}`);
  for (const chunk of corpus.chunks.filter((chunk) => chunk.family !== 'file')) {
    assert.equal(chunk.sourceHash, expectedHash, `semantic chunk carried ${chunk.sourceHash ?? 'no'} hash instead of ${expectedHash}`);
  }
}

function makeIndex(hash: string, value: string): WorkspaceIndex {
  const index = new WorkspaceIndex('workspace-knowledge-refresh');
  index.setFiles([
    makeFile(SOURCES.event, 'event', hash),
    makeFile(SOURCES.map, 'map', hash),
    makeFile(SOURCES.param, 'param', hash),
    makeFile(SOURCES.msg, 'msg', hash),
    makeFile(SOURCES.action, 'action', hash)
  ]);
  index.upsertEventExport(makeEvent(SOURCES.event, hash, value));
  index.upsertMapExport(makeMap(SOURCES.map, hash, value));
  index.upsertParamExport(makeParam(SOURCES.param, hash, value));
  index.upsertMsgExport(makeMsg(SOURCES.msg, hash, value));
  index.upsertTaeExport(makeTae(SOURCES.action, hash, value));
  index.rebuildReferences();
  return index;
}

function makeFile(sourceUri: string, resourceKind: IndexedFile['resourceKind'], hash: string): IndexedFile {
  const relativePath = sourceUri.replace('file://synthetic/', '');
  return {
    id: sourceUri,
    workspaceId: 'workspace-knowledge-refresh',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: relativePath,
    relativePath,
    game: 'sekiro',
    resourceKind,
    extension: '.dcx',
    compoundExtension: resourceKind === 'event' ? '.emevd.dcx' : '.dcx',
    formatKind: resourceKind === 'event'
      ? 'emevd'
      : resourceKind === 'map'
        ? 'msb'
        : resourceKind === 'param'
          ? 'param'
          : resourceKind === 'msg'
            ? 'fmg'
            : 'bnd',
    formatLabel: resourceKind.toUpperCase(),
    size: 32,
    mtimeMs: hash === 'v1' ? 1 : 2,
    sha256: hash,
    parseStatus: 'partial',
    diagnostics: []
  };
}

function makeEvent(sourceUri: string, sourceHash: string, value: string): EventExport {
  return {
    mapId: 'm10_00_00_00',
    sourceHash,
    sourceRevision: sourceHash === 'v1' ? 1 : 2,
    events: [{
      uri: `${sourceUri}#event/1000`,
      sourceUri,
      mapId: 'm10_00_00_00',
      eventId: 1000,
      name: value,
      sourceHash,
      sourceRevision: sourceHash === 'v1' ? 1 : 2,
      instructions: []
    }]
  };
}

function makeMap(sourceUri: string, sourceHash: string, value: string): MapExport {
  return {
    mapId: 'm10_00_00_00',
    sourceHash,
    sourceRevision: sourceHash === 'v1' ? 1 : 2,
    entities: [{
      uri: `${sourceUri}#part/${value}`,
      sourceUri,
      mapId: 'm10_00_00_00',
      name: value,
      kind: 'object',
      entityId: 100,
      sourceHash,
      sourceRevision: sourceHash === 'v1' ? 1 : 2
    }],
    regions: []
  };
}

function makeParam(sourceUri: string, sourceHash: string, value: string): ParamExport {
  return {
    paramName: 'NpcParam',
    sourceHash,
    sourceRevision: sourceHash === 'v1' ? 1 : 2,
    rows: [{
      uri: `${sourceUri}#NpcParam/1`,
      sourceUri,
      paramName: 'NpcParam',
      rowId: 1,
      rowName: value,
      sourceHash,
      sourceRevision: sourceHash === 'v1' ? 1 : 2,
      fields: [{ name: 'label', value }]
    }]
  };
}

function makeMsg(sourceUri: string, sourceHash: string, value: string): MsgExport {
  return {
    category: 'zhocn',
    sourceHash,
    sourceRevision: sourceHash === 'v1' ? 1 : 2,
    entries: [{
      uri: `${sourceUri}#zhocn/1`,
      sourceUri,
      category: 'zhocn',
      textId: 1,
      text: value,
      sourceHash,
      sourceRevision: sourceHash === 'v1' ? 1 : 2,
      confidence: 'high'
    }]
  };
}

function makeTae(sourceUri: string, sourceHash: string, value: string): TaeExport {
  return {
    chrId: 'c0000',
    sourceUri,
    sourceHash,
    sourceRevision: sourceHash === 'v1' ? 1 : 2,
    animations: [{
      animId: 10,
      code: 'A0010',
      events: [{
        uri: `${sourceUri}#A0010/e0`,
        index: 0,
        eventTypeId: 1,
        startTime: 0,
        endTime: 1,
        startFrame: 0,
        endFrame: 30,
        sourceHash,
        sourceRevision: sourceHash === 'v1' ? 1 : 2,
        fields: [{ name: 'label', value }]
      }]
    }]
  };
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
