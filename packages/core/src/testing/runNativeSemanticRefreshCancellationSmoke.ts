import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BridgeResult, IndexedFile, MsgExport } from '@soulforge/shared';
import { refreshNativeSemanticSources, type NativeSemanticRefreshOptions } from '../indexing/nativeSemanticRefresh.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
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
    if (options.command === 'read-dcx-document') {
      return bridgeOk(sourceUri, {
        outerFileHash,
        nested: { entries: [{ index: 0, name: 'a.fmg' }, { index: 1, name: 'b.fmg' }] }
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
    if (options.command === 'read-dcx-document') {
      return bridgeOk(sourceUri, {
        outerFileHash,
        nested: { entries: [
          { index: 0, name: 'fresh.fmg' },
          { index: 1, name: 'broken.fmg' }
        ] }
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
      if (options.command === 'read-dcx-document') {
        return bridgeOk(sourceUri, {
          outerFileHash,
          nested: { entries: [{ index: 0, name: 'broken-only.fmg' }] }
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

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runNativeSemanticRefreshCancellationSmoke.js')) {
  runNativeSemanticRefreshCancellationSmoke()
    .then(() => runNativeSemanticRefreshSourceAtomicitySmoke())
    .then(() => console.log('runNativeSemanticRefreshCancellationSmoke: PASS'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
