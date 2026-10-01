import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeResult, IndexedFile, MsgExport } from '@soulforge/shared';
import { refreshNativeSemanticSources, type NativeSemanticRefreshOptions } from '../indexing/nativeSemanticRefresh.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { getFirstPartyParamMetadataPackage } from '../schema/sekiro/firstPartySchema.js';
import type { RunBridgeOptions } from '../bridge/runBridge.js';

function bridgeOk<T>(sourceUri: string, data: T): BridgeResult<T> {
  return {
    sourceUri,
    sourcePath: sourceUri,
    game: 'sekiro',
    resourceKind: 'msg',
    parseStatus: 'parsed',
    diagnostics: [],
    data
  };
}

/** Cancellation must not publish the first completed child of a batch. */
export async function runNativeSemanticRefreshCancellationSmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-refresh-cancel-'));
  const sourcePath = join(root, 'msg.msgbnd.dcx');
  const bytes = Buffer.from('synthetic-msg-container');
  await writeFile(sourcePath, bytes);
  const sourceUri = `file://${sourcePath.replaceAll('\\', '/')}`;
  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  const file = {
    id: 'cancel-msg',
    workspaceId: 'cancel-workspace',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'msg.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    formatKind: 'msgbnd',
    formatLabel: 'MSG BND4',
    extension: '.dcx',
    compoundExtension: '.msgbnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: bytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const index = new WorkspaceIndex('cancel-workspace');
  index.setFiles([file]);
  const controller = new AbortController();
  let fmgReads = 0;
  let resolveSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { resolveSecondStarted = resolve; });

  const bridgeRunner = async <T>(options: RunBridgeOptions): Promise<BridgeResult<T>> => {
    if (options.command === 'list-bnd4-entries') {
      return bridgeOk(sourceUri, {
        sourceHash: outerFileHash, entryCount: 2,
        entries: [{ index: 0, name: 'a.fmg' }, { index: 1, name: 'b.fmg' }]
      }) as BridgeResult<T>;
    }
    if (options.command === 'extract-bnd4-child') {
      return bridgeOk(sourceUri, { extracted: true }) as BridgeResult<T>;
    }
    if (options.command !== 'read-fmg-document') {
      throw new Error(`unexpected command ${options.command}`);
    }
    fmgReads += 1;
    if (fmgReads === 1) {
      return bridgeOk(sourceUri, { entries: [{ id: 1, text: 'first child' }] }) as BridgeResult<T>;
    }
    resolveSecondStarted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        options.signal?.removeEventListener('abort', onAbort);
        reject(Object.assign(new Error('synthetic child aborted'), { name: 'AbortError' }));
      };
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener('abort', onAbort, { once: true });
      void resolve;
    });
    throw new Error('second child unexpectedly completed');
  };

  const refreshOptions: NativeSemanticRefreshOptions = {
    index,
    sourceFiles: [file],
    stagingRoot: root,
    allowedRoots: [root],
    signal: controller.signal,
    bridgeRunner
  };
  const refresh = refreshNativeSemanticSources(refreshOptions);
  await secondStarted;
  controller.abort();
  await assert.rejects(refresh, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  assert.equal(index.getStats().textEntries, 0, 'cancelled refresh must not publish the first FMG child');
  assert.equal(index.getStats().references, 0, 'cancelled refresh must not rebuild a partial reference graph');
  await rm(root, { recursive: true, force: true });
}

/** A failed/partial source must not resurrect the old projection on commit. */
export async function runNativeSemanticRefreshSourceAtomicitySmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-refresh-atomic-'));
  const sourcePath = join(root, 'msg.msgbnd.dcx');
  const bytes = Buffer.from('synthetic-msg-container-atomic');
  await writeFile(sourcePath, bytes);
  const sourceUri = `file://${sourcePath.replaceAll('\\', '/')}`;
  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  const file = {
    id: 'atomic-msg',
    workspaceId: 'atomic-workspace',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'msg.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    formatKind: 'msgbnd',
    formatLabel: 'MSG BND4',
    extension: '.dcx',
    compoundExtension: '.msgbnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: bytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const index = new WorkspaceIndex('atomic-workspace');
  index.setFiles([file]);
  const staleProjection: MsgExport = {
    category: 'orphan-old-leaf',
    outerFileHash,
    entries: [{
      uri: `${sourceUri}#orphan-old-leaf/99`,
      sourceUri,
      category: 'orphan-old-leaf',
      entryIndex: 99,
      textId: 99,
      text: 'old projection must not return',
      confidence: 'high',
      outerFileHash
    }]
  };
  assert.equal(index.upsertMsgExport(staleProjection), true);

  const bridgeRunner = async <T>(options: RunBridgeOptions): Promise<BridgeResult<T>> => {
    if (options.command === 'list-bnd4-entries') {
      return bridgeOk(sourceUri, {
        sourceHash: outerFileHash, entryCount: 2,
        entries: [
          { index: 0, name: 'fresh.fmg' },
          { index: 1, name: 'broken.fmg' }
        ]
      }) as BridgeResult<T>;
    }
    if (options.command === 'extract-bnd4-child') {
      return bridgeOk(sourceUri, { extracted: true }) as BridgeResult<T>;
    }
    if (options.command !== 'read-fmg-document') {
      throw new Error(`unexpected command ${options.command}`);
    }
    if (options.filePath.includes('broken.fmg')) {
      throw new Error('synthetic FMG leaf failure');
    }
    return bridgeOk(sourceUri, {
      entries: [{ id: 1, text: 'fresh leaf' }],
      sourceHash: 'fresh-leaf-hash'
    }) as BridgeResult<T>;
  };

  const result = await refreshNativeSemanticSources({
    index,
    sourceFiles: [file],
    stagingRoot: root,
    allowedRoots: [root],
    bridgeRunner
  });
  assert.deepEqual(result.partialSources, [sourceUri]);
  assert.deepEqual(result.failedSources, []);
  const entries = index.toSymbolBundle().msgs?.flatMap((item) => item.entries) ?? [];
  assert.deepEqual(entries.map((entry) => entry.text), ['fresh leaf']);
  assert.equal(entries.some((entry) => entry.text.includes('old projection')), false);
  assert.equal(index.getCoverageSnapshot().find((item) => item.domain === 'msg')?.status, 'partial');

  const failed = await refreshNativeSemanticSources({
    index,
    sourceFiles: [file],
    stagingRoot: root,
    allowedRoots: [root],
    bridgeRunner: async <T>(options: RunBridgeOptions): Promise<BridgeResult<T>> => {
      if (options.command === 'list-bnd4-entries') {
        return bridgeOk(sourceUri, {
          sourceHash: outerFileHash, entryCount: 1,
          entries: [{ index: 0, name: 'broken-only.fmg' }]
        }) as BridgeResult<T>;
      }
      if (options.command === 'extract-bnd4-child') {
        return bridgeOk(sourceUri, { extracted: true }) as BridgeResult<T>;
      }
      throw new Error('synthetic complete source failure');
    }
  });
  assert.deepEqual(failed.failedSources, [sourceUri]);
  assert.equal((index.toSymbolBundle().msgs?.flatMap((item) => item.entries) ?? []).length, 0);
  assert.equal(index.getCoverageSnapshot().find((item) => item.domain === 'msg')?.status, 'stale');
  await rm(root, { recursive: true, force: true });
}

/** Source-scoped postcommit analysis is disposable and must not duplicate a full changed PARAM/MSG projection. */
export async function runNativeSemanticRefreshOwnedIndexSmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-refresh-owned-'));
  const sourcePath = join(root, 'msg.msgbnd.dcx');
  const bytes = Buffer.from('synthetic-msg-container-owned');
  await writeFile(sourcePath, bytes);
  const sourceUri = `file://${sourcePath.replaceAll('\\', '/')}`;
  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  const file = {
    id: 'owned-msg',
    workspaceId: 'owned-workspace',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'msg.msgbnd.dcx',
    game: 'sekiro',
    resourceKind: 'msg',
    formatKind: 'msgbnd',
    formatLabel: 'MSG BND4',
    extension: '.dcx',
    compoundExtension: '.msgbnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: bytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const index = new WorkspaceIndex('owned-workspace');
  index.setFiles([file]);
  assert.equal(index.upsertMsgExport({
    category: 'old-leaf',
    outerFileHash,
    entries: [{
      uri: `${sourceUri}#old-leaf/99`, sourceUri, category: 'old-leaf', entryIndex: 99,
      textId: 99, text: 'old owned projection', confidence: 'high', outerFileHash
    }]
  }), true);
  (index as unknown as { cloneForRefreshShared(): WorkspaceIndex }).cloneForRefreshShared = () => {
    throw new Error('isolated source candidate must be refreshed in place');
  };
  let candidateReferenceRebuilds = 0;
  const rebuildCandidateReferences = index.rebuildReferences.bind(index);
  index.rebuildReferences = ((...args: Parameters<WorkspaceIndex['rebuildReferences']>) => {
    candidateReferenceRebuilds += 1;
    return rebuildCandidateReferences(...args);
  }) as WorkspaceIndex['rebuildReferences'];

  const options = {
    index,
    indexOwnership: 'isolated-candidate',
    sourceFiles: [file],
    stagingRoot: root,
    allowedRoots: [root],
    bridgeRunner: async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
      if (request.command === 'list-bnd4-entries') {
        return bridgeOk(sourceUri, {
          sourceHash: outerFileHash, entryCount: 1,
          entries: [{ index: 0, name: 'fresh.fmg' }]
        }) as BridgeResult<T>;
      }
      if (request.command === 'extract-bnd4-child') {
        return bridgeOk(sourceUri, { extracted: true }) as BridgeResult<T>;
      }
      if (request.command === 'read-fmg-document') {
        return bridgeOk(sourceUri, {
          entries: [{ id: 1, text: 'fresh owned projection' }],
          sourceHash: 'fresh-owned-leaf-hash'
        }) as BridgeResult<T>;
      }
      throw new Error(`unexpected owned-index command ${request.command}`);
    }
  } as NativeSemanticRefreshOptions;

  const result = await refreshNativeSemanticSources(options);
  assert.deepEqual(result.refreshedSources, [sourceUri]);
  assert.equal(candidateReferenceRebuilds, 1,
    'isolated source candidates should rebuild references only when invalidating before read, not again before publish');
  const entries = index.toSymbolBundle().msgs?.flatMap((item) => item.entries) ?? [];
  assert.deepEqual(entries.map((entry) => entry.text), ['fresh owned projection']);
  assert.equal(index.getCoverageSnapshot().find((item) => item.domain === 'msg')?.status, 'complete');

  const failed = await refreshNativeSemanticSources({
    ...options,
    bridgeRunner: async <T>(): Promise<BridgeResult<T>> => {
      throw new Error('synthetic owned-candidate native read failure');
    }
  });
  assert.deepEqual(failed.failedSources, [sourceUri]);
  assert.equal((index.toSymbolBundle().msgs?.flatMap((item) => item.entries) ?? []).length, 0,
    'a failed disposable refresh must leave the candidate invalidated, not resurrect prior rows');
  assert.equal(index.getCoverageSnapshot().find((item) => item.domain === 'msg')?.status, 'stale');
  await rm(root, { recursive: true, force: true });
}

/** Full PARAM payload rereads must not fan out several large table documents at once. */
export async function runNativeParamReadConcurrencySmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-param-read-concurrency-'));
  const sourcePath = join(root, 'gameparam.parambnd.dcx');
  const bytes = Buffer.from('synthetic-param-container-concurrency');
  await writeFile(sourcePath, bytes);
  const sourceUri = `file://${sourcePath.replaceAll('\\', '/')}`;
  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  const file = {
    id: 'concurrency-param',
    workspaceId: 'concurrency-workspace',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'param/gameparam/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    formatKind: 'parambnd',
    formatLabel: 'PARAM BND4',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: bytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const index = new WorkspaceIndex('concurrency-workspace');
  index.setFiles([file]);
  const entries = [
    { index: 0, name: 'TableA.param' },
    { index: 1, name: 'TableB.param' },
    { index: 2, name: 'TableC.param' },
    { index: 3, name: 'TableD.param' }
  ];
  let activeReaders = 0;
  let maxActiveReaders = 0;
  let readerCalls = 0;
  const progressEvents: Array<{ phase: string; entryName: string; heapUsedMb: number }> = [];
  const bridgeRunner = async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
    if (request.command === 'list-bnd4-entries') {
      return {
        ...bridgeOk(sourceUri, { sourceHash: outerFileHash, entryCount: entries.length, entries }),
        resourceKind: 'param'
      } as BridgeResult<T>;
    }
    if (request.command === 'extract-bnd4-child') {
      return {
        ...bridgeOk(sourceUri, { extracted: true }),
        resourceKind: 'param'
      } as BridgeResult<T>;
    }
    if (request.command === 'read-param-document') {
      readerCalls += 1;
      activeReaders += 1;
      maxActiveReaders = Math.max(maxActiveReaders, activeReaders);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeReaders -= 1;
      return {
        sourceUri,
        sourcePath: sourceUri,
        game: 'sekiro',
        resourceKind: 'param',
        parseStatus: 'failed',
        diagnostics: [{ severity: 'error', code: 'SYNTHETIC_READ_FAILURE', message: 'expected fixture failure' }]
      } as BridgeResult<T>;
    }
    throw new Error(`unexpected command ${request.command}`);
  };

  try {
    const result = await refreshNativeSemanticSources({
      index,
      sourceFiles: [file],
      stagingRoot: root,
      allowedRoots: [root],
      bridgeRunner,
      paramReadProgress: (progress) => progressEvents.push(progress)
    });
    assert.deepEqual(result.failedSources, [sourceUri]);
    assert.equal(readerCalls, entries.length, 'every native child should get an explicit failed read result');
    assert.equal(maxActiveReaders, 1,
      'lazy PARAM document page reads must be single-flight to bound Bridge session state');
    assert.deepEqual(progressEvents.map((event) => event.phase), Array(entries.length).fill('read-start'));
    assert.equal(progressEvents.every((event) => Number.isFinite(event.heapUsedMb) && event.heapUsedMb > 0), true,
      'per-table diagnostics should include bounded heap measurements without changing refresh outcome');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A disposable PARAM candidate publishes each decoded table before the next heavy native read starts. */
export async function runNativeParamRefreshStreamsTablesSmoke(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-native-param-stream-'));
  const sourcePath = join(root, 'gameparam.parambnd.dcx');
  const bytes = Buffer.from('synthetic-param-container-stream');
  await writeFile(sourcePath, bytes);
  const sourceUri = `file://${sourcePath.replaceAll('\\', '/')}`;
  const outerFileHash = createHash('sha256').update(bytes).digest('hex');
  const file = {
    id: 'stream-param',
    workspaceId: 'stream-workspace',
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'param/gameparam/gameparam.parambnd.dcx',
    game: 'sekiro',
    resourceKind: 'param',
    formatKind: 'parambnd',
    formatLabel: 'PARAM BND4',
    extension: '.dcx',
    compoundExtension: '.parambnd.dcx',
    parseStatus: 'parsed',
    diagnostics: [],
    size: bytes.length,
    mtimeMs: 1,
    sha256: outerFileHash
  } as unknown as IndexedFile;
  const definition = getFirstPartyParamMetadataPackage().definitions[0]!;
  const entries = [
    { index: 0, name: 'TableA.param' },
    { index: 1, name: 'TableB.param' }
  ];
  const index = new WorkspaceIndex('stream-workspace');
  index.setFiles([file]);
  let readCount = 0;
  let currentRead = -1;
  let currentSourceHash = '';
  let currentSessionToken = '';
  let currentRowId = 0;
  let currentDataHash = '';
  let firstTableVisibleWhenSecondReadStarted = false;
  let fullPayloadRequested = false;

  const result = await refreshNativeSemanticSources({
    index,
    indexOwnership: 'isolated-candidate',
    sourceFiles: [file],
    stagingRoot: root,
    allowedRoots: [root],
    bridgeRunner: async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
      if (request.command === 'list-bnd4-entries') {
        return {
          ...bridgeOk(sourceUri, { sourceHash: outerFileHash, entryCount: entries.length, entries }),
          resourceKind: 'param'
        } as BridgeResult<T>;
      }
      if (request.command === 'extract-bnd4-child') {
        return {
          ...bridgeOk(sourceUri, { extracted: true }),
          resourceKind: 'param'
        } as BridgeResult<T>;
      }
      if (request.command === 'read-param-document') {
        const options = request.commandOptions ?? {};
        if (options.includeAllPayloads === true) fullPayloadRequested = true;
        const pageOpen = options.includeRowPayloads === false;
        if (pageOpen) {
          if (options.rowPage !== 0) throw new Error('single-row PARAM fixture has one index page');
          if (readCount === 1) {
            firstTableVisibleWhenSecondReadStarted = (index.toSymbolBundle().params ?? []).some((item) => (
              item.paramName === 'TableA' && item.rows.some((row) => row.rowId === 1000)
            ));
          }
          currentRead = readCount++;
          currentSourceHash = `table-${currentRead}-hash`;
          currentSessionToken = `table-session-${currentRead}`;
          currentRowId = 1000 + currentRead;
          currentDataHash = `row-${currentRowId}-hash`;
          return {
            sourceUri,
            sourcePath,
            game: 'sekiro',
            resourceKind: 'param',
            parseStatus: 'partial',
            diagnostics: [],
            data: {
              sourceHash: currentSourceHash,
              typeName: definition.document.typeName,
              dataVersion: definition.key.dataVersion,
              rowCount: 1,
              rowTotal: 1,
              rowDataSize: definition.document.rowDataSize,
              rowPage: 0,
              rowPageSize: Number(options.rowPageSize),
              rowPageCount: 1,
              returnedRowCount: 1,
              payloadsIncluded: false,
              sessionToken: currentSessionToken,
              workspaceSessionId: 'stream-workspace',
              pathSourceGeneration: 0,
              rows: [{ rowIndex: 0, id: currentRowId, dataHash: currentDataHash, name: `row-${currentRowId}`, dataBase64: null }]
            }
          } as unknown as BridgeResult<T>;
        }
        const selections = options.rowSelections as Array<{ rowIndex: number; expectedId: number; expectedDataHash: string }>;
        if (options.includeRowPayloads !== true || options.documentSession !== currentSessionToken
          || selections.length !== 1) throw new Error('unexpected PARAM payload selection request');
        return {
          sourceUri,
          sourcePath,
          game: 'sekiro',
          resourceKind: 'param',
          parseStatus: 'partial',
          diagnostics: [],
          data: {
            sourceHash: currentSourceHash,
            typeName: definition.document.typeName,
            dataVersion: definition.key.dataVersion,
            rowCount: 1,
            rowDataSize: definition.document.rowDataSize,
            payloadsIncluded: true,
            sessionToken: currentSessionToken,
            workspaceSessionId: 'stream-workspace',
            pathSourceGeneration: 0,
            rows: [{
              rowIndex: selections[0]!.rowIndex,
              id: selections[0]!.expectedId,
              dataHash: selections[0]!.expectedDataHash,
              name: `row-${currentRowId}`,
              dataBase64: Buffer.alloc(definition.document.rowDataSize).toString('base64')
            }]
          }
        } as unknown as BridgeResult<T>;
      }
      throw new Error(`unexpected command ${request.command}`);
    },
  });

  assert.deepEqual(result.refreshedSources, [sourceUri]);
  assert.deepEqual(result.partialSources, []);
  assert.equal(readCount, 2);
  assert.equal(fullPayloadRequested, false, 'native PARAM refresh must not fall back to full-table payload reads');
  assert.equal(firstTableVisibleWhenSecondReadStarted, true,
    'a disposable source candidate must release each decoded table before starting the next native payload read');
  assert.deepEqual((index.toSymbolBundle().params ?? []).map((item) => item.paramName), ['TableA', 'TableB']);
  await rm(root, { recursive: true, force: true });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runNativeSemanticRefreshCancellationSmoke.js')) {
  runNativeSemanticRefreshCancellationSmoke()
    .then(() => runNativeSemanticRefreshSourceAtomicitySmoke())
    .then(() => runNativeSemanticRefreshOwnedIndexSmoke())
    .then(() => runNativeParamReadConcurrencySmoke())
    .then(() => runNativeParamRefreshStreamsTablesSmoke())
    .then(() => console.log('runNativeSemanticRefreshCancellationSmoke: PASS'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
