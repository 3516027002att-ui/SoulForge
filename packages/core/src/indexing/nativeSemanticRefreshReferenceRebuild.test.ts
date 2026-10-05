import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { BridgeResult, EventExport, IndexedFile, ReferenceEdge } from '@soulforge/shared';
import type { RunBridgeOptions } from '../bridge/runBridge.js';
import { refreshNativeSemanticSources } from './nativeSemanticRefresh.js';
import { WorkspaceIndex } from './workspaceIndex.js';

function makeFile(path: string, sourceUri: string, sha256: string, relativePath: string, size: number): IndexedFile {
  return {
    id: sourceUri,
    workspaceId: 'refresh-reference-rebuild',
    sourceUri,
    sourcePath: relativePath,
    absolutePath: path,
    relativePath,
    game: 'sekiro',
    resourceKind: 'event',
    parseStatus: 'parsed',
    diagnostics: [],
    extension: '.dcx',
    compoundExtension: '.emevd.dcx',
    formatKind: 'emevd',
    formatLabel: 'EMEVD DCX',
    size,
    mtimeMs: 1,
    sha256
  } as unknown as IndexedFile;
}

function makeEvent(sourceUri: string, eventId: number, targetEventId?: number) {
  return {
    uri: `${sourceUri}#event/${eventId}`,
    sourceUri,
    eventId,
    instructions: targetEventId === undefined ? [] : [{
      uri: `${sourceUri}#event/${eventId}/instruction/0`,
      index: 0,
      name: 'InitializeEvent',
      args: [{ value: targetEventId, name: 'eventId', argIndex: 0, role: 'eventId' as const, roleSource: 'registry' as const }]
    }]
  };
}

function makeTextEvent(sourceUri: string, eventId: number, textId: number) {
  return {
    uri: `${sourceUri}#event/${eventId}`,
    sourceUri,
    eventId,
    instructions: [{
      uri: `${sourceUri}#event/${eventId}/instruction/0`,
      index: 0,
      name: 'DisplayText',
      args: [{ value: textId, name: 'textId', argIndex: 0, role: 'textId' as const, roleSource: 'registry' as const }]
    }]
  };
}

function makeExport(sourceUri: string, sourceTarget: number): EventExport {
  return { events: [makeEvent(sourceUri, 10, sourceTarget), makeEvent(sourceUri, 20), makeEvent(sourceUri, 21)] };
}

function makeBridgeResult<T>(sourceUri: string, sourcePath: string, data: unknown, failed = false, resourceKind: 'event' | 'msg' = 'event'): BridgeResult<T> {
  return {
    sourceUri,
    sourcePath,
    game: 'sekiro',
    resourceKind,
    parseStatus: failed ? 'failed' : 'parsed',
    diagnostics: failed ? [{ severity: 'error', code: 'FIXTURE_READ_FAILED', message: 'fixture rejected' }] : [],
    data: (failed ? null : data) as T
  };
}

async function makeSeededIndex() {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-reference-rebuild-'));
  const changedPath = join(root, 'm10.emevd.dcx');
  const commonPath = join(root, 'common.emevd.dcx');
  const changedBytes = Buffer.from('immutable changed-source fixture');
  const commonBytes = Buffer.from('immutable unchanged-source fixture');
  await writeFile(changedPath, changedBytes);
  await writeFile(commonPath, commonBytes);
  const sourceUri = pathToFileURL(changedPath).href;
  const commonUri = pathToFileURL(commonPath).href;
  const file = makeFile(
    changedPath,
    sourceUri,
    createHash('sha256').update(changedBytes).digest('hex'),
    'event/m10.emevd.dcx',
    changedBytes.length
  );
  const commonFile = makeFile(
    commonPath,
    commonUri,
    createHash('sha256').update(commonBytes).digest('hex'),
    'event/common.emevd.dcx',
    commonBytes.length
  );
  const index = new WorkspaceIndex('refresh-reference-rebuild');
  index.setFiles([file, commonFile]);
  index.upsertEventExport(makeExport(sourceUri, 20));
  index.upsertEventExport({ events: [makeEvent(commonUri, 30, 31), makeEvent(commonUri, 31)] });
  const initialEdges = index.rebuildReferences().edges;
  assert(initialEdges.some((edge) => edge.fromUri.endsWith('#event/10') && edge.toUri.endsWith('#event/20')));
  assert(initialEdges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')));
  return { root, changedPath, sourceUri, commonUri, file, index };
}

function trackTargetRebuilds(index: WorkspaceIndex) {
  const original = index.rebuildReferences.bind(index);
  let calls = 0;
  let lastEdges: ReferenceEdge[] = [];
  index.rebuildReferences = (...args) => {
    calls += 1;
    const result = original(...args);
    lastEdges = result.edges;
    return result;
  };
  return { calls: () => calls, lastEdges: () => lastEdges };
}

function replacementBridge(sourceUri: string, path: string, targetEventId: number) {
  return async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
    assert.equal(request.command, 'export-event');
    const data = makeExport(sourceUri, targetEventId);
    // readEventExport consumes native event records rather than indexed symbols.
    return makeBridgeResult<T>(sourceUri, path, {
      events: data.events.map((event) => ({
        id: event.eventId,
        instructions: event.instructions.map((instruction) => ({
          index: instruction.index,
          name: instruction.name,
          args: instruction.args
        }))
      }))
    });
  };
}

test('source commit rebuilds references once after replacement, preserving new and unchanged edges', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  try {
    const result = await refreshNativeSemanticSources({
      index: seeded.index,
      sourceFiles: [seeded.file],
      stagingRoot: seeded.root,
      allowedRoots: [seeded.root],
      bridgeRunner: replacementBridge(seeded.sourceUri, seeded.changedPath, 21)
    });
    assert.deepEqual(result.refreshedSources, [seeded.sourceUri]);
    assert.equal(tracked.calls(), 1, 'the target index should build only the final graph, not an intermediate invalidated graph');
    const edges = tracked.lastEdges();
    assert(edges.some((edge) => edge.fromUri.endsWith('#event/10') && edge.toUri.endsWith('#event/21')));
    assert.equal(edges.some((edge) => edge.fromUri.endsWith('#event/10') && edge.toUri.endsWith('#event/20')), false);
    assert(edges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')),
      'unmodified source references remain in the final graph');
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('failed source commit stays stale, drops its edges, and preserves unchanged references', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  try {
    const result = await refreshNativeSemanticSources({
      index: seeded.index,
      sourceFiles: [seeded.file],
      stagingRoot: seeded.root,
      allowedRoots: [seeded.root],
      bridgeRunner: async <T>(_request: RunBridgeOptions): Promise<BridgeResult<T>> =>
        makeBridgeResult<T>(seeded.sourceUri, seeded.changedPath, undefined, true)
    });
    assert.deepEqual(result.failedSources, [seeded.sourceUri]);
    assert(seeded.index.getStaleSourceUris().includes(seeded.sourceUri));
    assert.equal(tracked.calls(), 1);
    const edges = tracked.lastEdges();
    assert.equal(edges.some((edge) => edge.fromUri.endsWith('#event/10')), false, 'failed source edges must not remain published');
    assert(edges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')));
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('commit rebuilds after a partial synchronous load throws, removing partial source rows and retaining unchanged references', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  const originalUpsert = seeded.index.upsertEventExport.bind(seeded.index);
  seeded.index.upsertEventExport = (value) => {
    originalUpsert(value);
    throw new Error('synthetic target projection load failure');
  };
  try {
    await assert.rejects(
      refreshNativeSemanticSources({
        index: seeded.index,
        sourceFiles: [seeded.file],
        stagingRoot: seeded.root,
        allowedRoots: [seeded.root],
        bridgeRunner: replacementBridge(seeded.sourceUri, seeded.changedPath, 21)
      }),
      /synthetic target projection load failure/
    );
    assert.equal(tracked.calls(), 1, 'finally must rebuild the target graph exactly once');
    assert(seeded.index.getStaleSourceUris().includes(seeded.sourceUri));
    const storedEdges = seeded.index.listReferences();
    assert(storedEdges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')),
      'an unchanged source remains queryable after failed synchronous commit');
    assert.equal(storedEdges.some((edge) => edge.fromUri.endsWith('#event/10')), false);
  } finally {
    seeded.index.upsertEventExport = originalUpsert;
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('commit error remains inspectable when reference recovery also fails', async () => {
  const seeded = await makeSeededIndex();
  const originalUpsert = seeded.index.upsertEventExport.bind(seeded.index);
  seeded.index.upsertEventExport = (value) => {
    originalUpsert(value);
    throw new Error('synthetic target projection load failure');
  };
  seeded.index.rebuildReferences = () => { throw new Error('synthetic final graph failure'); };
  try {
    await assert.rejects(
      refreshNativeSemanticSources({
        index: seeded.index,
        sourceFiles: [seeded.file],
        stagingRoot: seeded.root,
        allowedRoots: [seeded.root],
        bridgeRunner: replacementBridge(seeded.sourceUri, seeded.changedPath, 21)
      }),
      (error: unknown) => {
        assert(error instanceof AggregateError);
        const cause = (error as Error & { cause?: unknown }).cause;
        assert(cause instanceof Error);
        assert.equal(cause.message, 'synthetic target projection load failure');
        assert(error.errors.some((item) => item instanceof Error && item.message === 'synthetic target projection load failure'));
        assert(error.errors.some((item) => item instanceof Error && item.message === 'synthetic final graph failure'));
        return true;
      }
    );
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('partial MSG refresh publishes only available native text references and keeps untouched edges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-partial-reference-refresh-'));
  const messagePath = join(root, 'msg.msgbnd.dcx');
  const messageBytes = Buffer.from('immutable partial message source');
  await writeFile(messagePath, messageBytes);
  const messageSourceUri = pathToFileURL(messagePath).href;
  const outerFileHash = createHash('sha256').update(messageBytes).digest('hex');
  const file = {
    id: messageSourceUri,
    workspaceId: 'partial-reference-refresh',
    sourceUri: messageSourceUri,
    sourcePath: messagePath,
    absolutePath: messagePath,
    relativePath: 'msg.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    formatKind: 'msgbnd',
    formatLabel: 'MSG BND4',
    extension: '.dcx',
    compoundExtension: '.msgbnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: messageBytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const eventSourceUri = 'file:///fixture/event/m10.emevd.dcx';
  const commonSourceUri = `file:///fixture/event/common.emevd.dcx`;
  const index = new WorkspaceIndex('partial-reference-refresh');
  index.setFiles([file]);
  assert.equal(index.upsertMsgExport({
    category: 'old',
    outerFileHash,
    sourceRevision: 1,
    entries: [{
      uri: `${messageSourceUri}#old/77`, sourceUri: messageSourceUri, category: 'old', entryIndex: 0,
      textId: 77, text: 'old text', confidence: 'high', outerFileHash, sourceRevision: 1
    }]
  }), true);
  index.upsertEventExport({ events: [
    makeTextEvent(eventSourceUri, 10, 77),
    makeTextEvent(eventSourceUri, 11, 88)
  ] });
  index.upsertEventExport({ events: [makeEvent(commonSourceUri, 30, 31), makeEvent(commonSourceUri, 31)] });
  const initialEdges = index.rebuildReferences().edges;
  assert(initialEdges.some((edge) => edge.fromUri.endsWith('#event/10') && edge.toUri.endsWith('#old/77')));
  assert.equal(initialEdges.some((edge) => edge.fromUri.endsWith('#event/11') && edge.toUri.endsWith('#fresh/88')), false);
  assert(initialEdges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')));
  const tracked = trackTargetRebuilds(index);

  try {
    const result = await refreshNativeSemanticSources({
      index,
      sourceFiles: [file],
      stagingRoot: root,
      allowedRoots: [root],
      bridgeRunner: async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
        if (request.command === 'list-bnd4-entries') {
          return makeBridgeResult<T>(messageSourceUri, messagePath, {
            sourceHash: outerFileHash,
            entryCount: 2,
            entries: [{ index: 0, name: 'fresh.fmg' }, { index: 1, name: 'broken.fmg' }]
          }, false, 'msg');
        }
        if (request.command === 'extract-bnd4-child') {
          return makeBridgeResult<T>(messageSourceUri, messagePath, { extracted: true }, false, 'msg');
        }
        if (request.command === 'read-fmg-document') {
          if (request.filePath.includes('broken.fmg')) throw new Error('synthetic FMG leaf failure');
          return makeBridgeResult<T>(messageSourceUri, messagePath, {
            entries: [{ id: 88, text: 'fresh partial text' }],
            sourceHash: 'fresh-leaf-hash'
          }, false, 'msg');
        }
        throw new Error(`unexpected partial MSG refresh command ${request.command}`);
      }
    });

    assert.deepEqual(result.partialSources, [messageSourceUri]);
    assert.deepEqual(result.failedSources, []);
    assert.equal(tracked.calls(), 1, 'publish one graph after loading the partial native source');
    const edges = index.listReferences();
    assert.equal(edges.some((edge) => edge.fromUri.endsWith('#event/10') && edge.toUri.endsWith('#old/77')), false,
      'the removed old message leaf must not retain a reference');
    assert(edges.some((edge) => edge.fromUri.endsWith('#event/11') && edge.toUri.endsWith('#fresh/88')),
      'the successfully decoded partial leaf must contribute its current reference');
    assert(edges.some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')),
      'references from untouched sources must survive the partial commit');
    const entries = index.toSymbolBundle().msgs?.flatMap((item) => item.entries) ?? [];
    assert.deepEqual(entries.map((entry) => entry.text), ['fresh partial text']);
    assert.equal(index.getCoverageSnapshot().find((item) => item.domain === 'msg')?.status, 'partial');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalidateChangedSources keeps its default synchronous reference rebuild', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  try {
    const result = seeded.index.invalidateChangedSources([seeded.sourceUri]);
    assert.equal(tracked.calls(), 1);
    assert.equal(result.referencesRebuilt, 1);
    assert.equal(tracked.lastEdges().length, 1);
    assert(tracked.lastEdges().some((edge) => edge.fromUri.endsWith('#event/30') && edge.toUri.endsWith('#event/31')));
    assert.equal(tracked.lastEdges().some((edge) => edge.fromUri.endsWith('#event/10')), false);
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('a failed recovery invalidation does not publish a partial reference graph', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  const originalUpsert = seeded.index.upsertEventExport.bind(seeded.index);
  const originalInvalidate = seeded.index.invalidateChangedSources.bind(seeded.index);
  let invalidations = 0;
  seeded.index.upsertEventExport = (value) => {
    originalUpsert(value);
    throw new Error('synthetic projection failure');
  };
  seeded.index.invalidateChangedSources = (...args) => {
    if (++invalidations === 2) throw new Error('synthetic recovery invalidation failure');
    return originalInvalidate(...args);
  };
  try {
    await assert.rejects(refreshNativeSemanticSources({
      index: seeded.index, sourceFiles: [seeded.file], stagingRoot: seeded.root,
      allowedRoots: [seeded.root],
      bridgeRunner: replacementBridge(seeded.sourceUri, seeded.changedPath, 21)
    }), (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((item: Error) => item.message),
        ['synthetic projection failure', 'synthetic recovery invalidation failure']);
      return true;
    });
    assert.equal(tracked.calls(), 0);
    assert.deepEqual(seeded.index.listReferences(), []);
    assert(seeded.index.getStaleSourceUris().includes(seeded.sourceUri));
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});

test('commit and both recovery errors remain inspectable when stale marking also fails', async () => {
  const seeded = await makeSeededIndex();
  const tracked = trackTargetRebuilds(seeded.index);
  const originalUpsert = seeded.index.upsertEventExport.bind(seeded.index);
  const originalInvalidate = seeded.index.invalidateChangedSources.bind(seeded.index);
  let invalidations = 0;
  seeded.index.upsertEventExport = (value) => {
    originalUpsert(value);
    throw new Error('synthetic projection failure');
  };
  seeded.index.invalidateChangedSources = (...args) => {
    if (++invalidations === 2) throw new Error('synthetic recovery invalidation failure');
    return originalInvalidate(...args);
  };
  seeded.index.markCoverageStale = () => { throw new Error('synthetic stale marking failure'); };
  try {
    await assert.rejects(refreshNativeSemanticSources({
      index: seeded.index, sourceFiles: [seeded.file], stagingRoot: seeded.root,
      allowedRoots: [seeded.root],
      bridgeRunner: replacementBridge(seeded.sourceUri, seeded.changedPath, 21)
    }), (error: unknown) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors.map((item: Error) => item.message), [
        'synthetic projection failure',
        'synthetic recovery invalidation failure',
        'synthetic stale marking failure'
      ]);
      const cause = (error as Error & { cause?: unknown }).cause;
      assert(cause instanceof Error && cause.message === 'synthetic projection failure');
      return true;
    });
    assert.equal(tracked.calls(), 0);
    assert.deepEqual(seeded.index.listReferences(), []);
  } finally {
    await rm(seeded.root, { recursive: true, force: true });
  }
});
