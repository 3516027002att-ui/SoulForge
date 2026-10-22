import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { NativeEditSession } from './nativeEditSession.js';
import { HKS_MAX_SOURCE_BYTES, readHksSource, type HksNativeReader } from './hksRead.js';

function fakeEdit(overlayRoot: string): NativeEditSession {
  return {
    session: {
      layers: { overlayRoot },
      meta: { workspaceId: 'file:///hks-read-test', layers: { overlayRoot } }
    },
    allowedRoots: () => [overlayRoot]
  } as unknown as NativeEditSession;
}

async function withOverlay<T>(run: (overlayRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-hks-read-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('readHksSource', () => {
  it('reads standalone plaintext and strips only trailing alignment padding', async () => {
    await withOverlay(async (overlayRoot) => {
      const file = join(overlayRoot, 'action', 'script', 'plain.lua');
      await mkdir(join(overlayRoot, 'action', 'script'), { recursive: true });
      await writeFile(file, Buffer.from('return 42\n\0\0', 'utf8'));

      const result = await readHksSource({ edit: fakeEdit(overlayRoot), file });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.sourceText, 'return 42\n');
        assert.equal(result.representation, 'plaintext');
        assert.equal(result.sourceUri, 'file://action/script/plain.lua');
        assert.equal(result.logicalSource, result.sourceUri);
        assert.equal(result.encoding, 'ascii');
        assert.equal(result.sourceHash.length, 64);
        assert.equal('writeSupported' in result, false);
      }
    });
  });

  it('requires an exact decode/encode round trip for plaintext', async () => {
    await withOverlay(async (overlayRoot) => {
      const file = join(overlayRoot, 'mixed.lua');
      // The invalid UTF-8 byte is surrounded by enough printable bytes to pass
      // the classifier; the strict encoder must still reject the replacement.
      await writeFile(file, Buffer.concat([Buffer.from('A'.repeat(1024), 'ascii'), Buffer.from([0x80, 0x01])]));

      const result = await readHksSource({ edit: fakeEdit(overlayRoot), file });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'HKS_PLAINTEXT_ROUND_TRIP_FAILED');
    });
  });

  it('delegates Lua bytecode to the native HKS reader and never treats writeSupported as write authority', async () => {
    await withOverlay(async (overlayRoot) => {
      const file = join(overlayRoot, 'bytecode.hks');
      await writeFile(file, Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x50, 0x00]));
      // Windows temporary roots may use an 8.3 alias or different casing.
      // Native reads must receive the physical path, while the resource URI
      // keeps its logical overlay identity.
      const physicalFile = await realpath(file);
      let requestFile = '';
      let requestUri = '';
      const nativeReader: HksNativeReader = async (request) => {
        requestFile = request.filePath;
        requestUri = request.resourceUri;
        return {
          parseStatus: 'ok',
          diagnostics: [],
          data: { sourceText: 'return 7\n', sourceHash: 'native-source-hash', writeSupported: false }
        };
      };

      const result = await readHksSource({ edit: fakeEdit(overlayRoot), file, nativeReader });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.representation, 'bytecode');
        assert.equal(result.sourceText, 'return 7\n');
        assert.equal(result.sourceHash, 'native-source-hash');
        assert.equal(result.encoding, 'utf8');
        assert.equal(requestFile, physicalFile);
        assert.equal(result.sourcePath, physicalFile);
        assert.equal(requestUri, 'file://bytecode.hks');
        assert.equal(result.sourceUri, requestUri);
        assert.equal('writeSupported' in result, false);
      }
    });
  });

  it('rejects partial or explicitly truncated native source before source pagination', async () => {
    await withOverlay(async (overlayRoot) => {
      const file = join(overlayRoot, 'incomplete.hks');
      await writeFile(file, Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x50]));
      const cases: Array<{ parseStatus: string; data: Record<string, unknown> }> = [
        { parseStatus: 'partial', data: { sourceText: 'return 1', sourceHash: 'partial' } },
        { parseStatus: 'ok', data: { sourceText: 'return 1', sourceHash: 'incomplete', sourceTextComplete: false } },
        { parseStatus: 'ok', data: { sourceText: 'return 1', sourceHash: 'truncated', truncated: true } }
      ];
      for (const item of cases) {
        const result = await readHksSource({
          edit: fakeEdit(overlayRoot),
          file,
          nativeReader: async () => ({ parseStatus: item.parseStatus, diagnostics: [], data: item.data })
        });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'HKS_NATIVE_SOURCE_INCOMPLETE');
      }
    });
  });

  it('rejects unknown binary without invoking the native reader', async () => {
    await withOverlay(async (overlayRoot) => {
      const file = join(overlayRoot, 'unknown.hks');
      await writeFile(file, Buffer.concat([Buffer.from('A'.repeat(1024), 'ascii'), Buffer.alloc(64, 0x01)]));
      let calls = 0;
      const nativeReader: HksNativeReader = async () => {
        calls += 1;
        throw new Error('must not be called');
      };

      const result = await readHksSource({ edit: fakeEdit(overlayRoot), file, nativeReader });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, 'HKS_UNKNOWN_BINARY');
      assert.equal(calls, 0);
    });
  });

  it('rejects container/event extensions and paths outside the opened overlay', async () => {
    await withOverlay(async (overlayRoot) => {
      const bnd = join(overlayRoot, 'scripts.bnd');
      const emevd = join(overlayRoot, 'common.emevd');
      await writeFile(bnd, Buffer.from('not standalone'));
      await writeFile(emevd, Buffer.from('not standalone'));
      const outsideRoot = await mkdtemp(join(tmpdir(), 'soulforge-hks-outside-'));
      try {
        const outside = join(outsideRoot, 'outside.lua');
        await writeFile(outside, Buffer.from('return 1\n'));
        const bndResult = await readHksSource({ edit: fakeEdit(overlayRoot), file: bnd });
        const emevdResult = await readHksSource({ edit: fakeEdit(overlayRoot), file: emevd });
        const outsideResult = await readHksSource({ edit: fakeEdit(overlayRoot), file: outside });
        assert.equal(bndResult.ok, false);
        assert.equal(emevdResult.ok, false);
        assert.equal(outsideResult.ok, false);
        if (!bndResult.ok) assert.equal(bndResult.code, 'HKS_STANDALONE_EXTENSION_REQUIRED');
        if (!emevdResult.ok) assert.equal(emevdResult.code, 'HKS_STANDALONE_EXTENSION_REQUIRED');
        if (!outsideResult.ok) assert.equal(outsideResult.code, 'HKS_SOURCE_OUTSIDE_OVERLAY');
      } finally {
        await rm(outsideRoot, { recursive: true, force: true });
      }
    });
  });

  it('enforces the 16 MiB bound and reports timeout/cancellation as failures', async () => {
    await withOverlay(async (overlayRoot) => {
      const large = join(overlayRoot, 'large.lua');
      await writeFile(large, Buffer.alloc(HKS_MAX_SOURCE_BYTES + 1, 0x41));
      const largeResult = await readHksSource({ edit: fakeEdit(overlayRoot), file: large });
      assert.equal(largeResult.ok, false);
      if (!largeResult.ok) assert.equal(largeResult.code, 'HKS_SOURCE_TOO_LARGE');

      const bytecode = join(overlayRoot, 'slow.hks');
      await writeFile(bytecode, Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x50]));
      const slowReader: HksNativeReader = async () => new Promise((resolve) => {
        setTimeout(() => resolve({ parseStatus: 'ok', data: { sourceText: 'return 1', sourceHash: 'late' }, diagnostics: [] }), 50);
      });
      const timeoutResult = await readHksSource({
        edit: fakeEdit(overlayRoot), file: bytecode, nativeReader: slowReader, timeoutMs: 5
      });
      assert.equal(timeoutResult.ok, false);
      if (!timeoutResult.ok) assert.equal(timeoutResult.code, 'HKS_READ_TIMEOUT');

      const controller = new AbortController();
      controller.abort();
      const cancelledResult = await readHksSource({ edit: fakeEdit(overlayRoot), file: bytecode, signal: controller.signal });
      assert.equal(cancelledResult.ok, false);
      if (!cancelledResult.ok) assert.equal(cancelledResult.code, 'HKS_READ_CANCELLED');
    });
  });
});
