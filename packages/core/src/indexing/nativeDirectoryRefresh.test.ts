import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BridgeResult, IndexedFile } from '@soulforge/shared';
import type { RunBridgeOptions } from '../bridge/runBridge.js';
import { refreshNativeSemanticSources } from './nativeSemanticRefresh.js';
import { WorkspaceIndex } from './workspaceIndex.js';

async function exerciseDirectory(listing: (hash: string) => Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-directory-refresh-'));
  const path = join(root, 'fixture.msgbnd.dcx');
  const original = Buffer.from('immutable outer compressed-container bytes');
  await writeFile(path, original);
  const hash = createHash('sha256').update(original).digest('hex');
  const sourceUri = `file://${path.replaceAll('\\', '/')}`;
  const file = {
    id: 'directory-msg', workspaceId: 'directory-test', sourceUri, sourcePath: path,
    absolutePath: path, relativePath: 'fixture.msgbnd.dcx', game: 'sekiro',
    resourceKind: 'msg', formatKind: 'msgbnd', formatLabel: 'MSG BND4', extension: '.dcx',
    compoundExtension: '.msgbnd.dcx', parseStatus: 'parsed', diagnostics: [],
    size: original.length, mtimeMs: 1, sha256: hash
  } as unknown as IndexedFile;
  const index = new WorkspaceIndex('directory-test');
  index.setFiles([file]);
  const commands: string[] = [];
  const extracted: number[] = [];
  const resultFor = <T>(data: unknown): BridgeResult<T> => ({
    sourceUri, sourcePath: path, game: 'sekiro', resourceKind: 'msg',
    parseStatus: 'partial', diagnostics: [], data: data as T
  });
  try {
    const result = await refreshNativeSemanticSources({
      index, sourceFiles: [file], stagingRoot: root, allowedRoots: [root],
      bridgeRunner: async <T>(request: RunBridgeOptions): Promise<BridgeResult<T>> => {
        commands.push(request.command);
        if (request.command === 'list-bnd4-entries') return resultFor<T>(listing(hash));
        if (request.command === 'extract-bnd4-child') {
          extracted.push(request.commandOptions!.entryIndex as number);
          return resultFor<T>({ extracted: true });
        }
        if (request.command === 'read-fmg-document') return resultFor<T>({ entries: [{ id: 1, text: 'native leaf' }] });
        throw new Error(`directory enumeration must not run ${request.command}`);
      }
    });
    assert.deepEqual(await readFile(path), original, 'refresh must preserve the original source');
    return { result, commands, extracted, sourceUri };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('refresh uses the native directory projection and preserves duplicate-name physical indexes', async () => {
  const actual = await exerciseDirectory((sourceHash) => ({
    sourceHash, payloadHash: 'a different decoded-BND hash', entryCount: 3,
    entries: [{ index: 1, name: 'same.fmg', compressedSize: 7, uncompressedSize: 9 },
      { index: 2, name: 'other.param' }, { index: 4, name: 'same.fmg', compressedSize: 8, uncompressedSize: 10 }]
  }));
  assert.deepEqual(actual.result.refreshedSources, [actual.sourceUri]);
  assert.deepEqual(actual.extracted.sort((a, b) => a - b), [1, 4]);
  assert.equal(actual.commands[0], 'list-bnd4-entries');
  assert.equal(actual.commands.includes('read-dcx-document'), false);
});

for (const [label, listing] of Object.entries({
  'decoded hash substituted for physical source': (_: string) => ({ sourceHash: 'decoded-hash', entryCount: 1, entries: [{ index: 0, name: 'a.fmg' }] }),
  'missing directory': (sourceHash: string) => ({ sourceHash, entryCount: 0 }),
  'incomplete directory count': (sourceHash: string) => ({ sourceHash, entryCount: 2, entries: [{ index: 0, name: 'a.fmg' }] }),
  'duplicate physical index': (sourceHash: string) => ({ sourceHash, entryCount: 2, entries: [{ index: 0, name: 'a.fmg' }, { index: 0, name: 'b.fmg' }] }),
  'negative physical index': (sourceHash: string) => ({ sourceHash, entryCount: 1, entries: [{ index: -1, name: 'a.fmg' }] }),
  'fractional physical index': (sourceHash: string) => ({ sourceHash, entryCount: 1, entries: [{ index: 0.5, name: 'a.fmg' }] }),
  'missing member name': (sourceHash: string) => ({ sourceHash, entryCount: 2, entries: [{ index: 0, name: 'a.fmg' }, { index: 1 }] })
})) {
  test(`refresh rejects ${label} before extracting a native child`, async () => {
    const actual = await exerciseDirectory(listing);
    assert.equal(actual.commands[0], 'list-bnd4-entries');
    assert.deepEqual(actual.extracted, []);
    assert.deepEqual(actual.result.failedSources, [actual.sourceUri]);
    assert.deepEqual(actual.result.refreshedSources, []);
  });
}
