import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IndexedFile, ScriptExport, SymbolBundle } from '@soulforge/shared';
import { analyzeWorkspace } from '../pipeline/workspacePipeline.js';
import type { SemanticCacheProvider } from '../workspace/semanticFileCache.js';
import { createSmokeTemporaryDirectory as mkdtemp } from './harness/smokeWorkspace.js';

const root = await mkdtemp(join(tmpdir(), 'soulforge-script-cache-fixture-'));
const outerHash = 'script-outer-hash';
const sourceUri = 'file://script/cache-hit.luabnd.dcx';

function fileFor(resourceKind: 'script' | 'ai', relativePath: string, sha256 = outerHash): IndexedFile {
  return {
    id: `fixture:${relativePath}`,
    workspaceId: 'fixture-workspace',
    sourceUri: `file://${relativePath}`,
    sourcePath: `${root}/${relativePath}`,
    absolutePath: `${root}/${relativePath}`,
    relativePath,
    game: 'sekiro',
    resourceKind,
    extension: '.dcx',
    compoundExtension: '.luabnd.dcx',
    formatKind: 'dcx',
    formatLabel: 'LUABND.DCX',
    size: 10,
    mtimeMs: 1234,
    sha256,
    parseStatus: 'parsed',
    diagnostics: []
  };
}

function scriptBundle(source: string, sha = outerHash): SymbolBundle {
  const child = `${source}!/main.lua`;
  const exportItem: ScriptExport = {
    sourceUri: source,
    containerKind: 'luabnd',
    outerFileHash: sha,
    sourceRevision: 77,
    catalogComplete: true,
    scripts: [{
      uri: child,
      sourceUri: source,
      childChain: ['main.lua'],
      entryIndex: 0,
      entryName: 'main.lua',
      contentKind: 'source',
      sourceText: 'return 1',
      sourceHash: 'child-hash',
      outerFileHash: sha,
      sourceRevision: 77
    }]
  };
  return { scripts: [exportItem] };
}

function cacheFor(payload: SymbolBundle | null): {
  provider: SemanticCacheProvider;
  loads: number;
  saves: number;
} {
  const state = { loads: 0, saves: 0 };
  return {
    provider: {
      load: () => {
        state.loads += 1;
        return payload;
      },
      save: () => {
        state.saves += 1;
      }
    },
    get loads() { return state.loads; },
    get saves() { return state.saves; }
  };
}

try {
  const hitCache = cacheFor(scriptBundle(sourceUri));
  const hit = await analyzeWorkspace({
    workspaceRoot: root,
    files: [fileFor('script', 'script/cache-hit.luabnd.dcx')],
    semanticCache: hitCache.provider,
    inspectNativeResources: false
  });
  const hydrated = hit.index.toSymbolBundle().scripts?.[0];
  assert.equal(hitCache.loads, 1, 'native script cache should be consulted during pipeline hydration');
  assert.equal(hitCache.saves, 0, 'cache hits must not rewrite the semantic payload');
  assert.equal(hydrated?.scripts.length, 1, 'a verified cached script export must be indexed');
  assert.equal(hydrated?.scripts[0]?.sourceRevision, 1234, 'cache hit revision must rebase to current catalog mtime');

  const aiSource = 'file://script/cache-hit-ai.luabnd.dcx';
  const aiCache = cacheFor(scriptBundle(aiSource));
  const ai = await analyzeWorkspace({
    workspaceRoot: root,
    files: [fileFor('ai', 'script/cache-hit-ai.luabnd.dcx')],
    semanticCache: aiCache.provider,
    inspectNativeResources: false
  });
  assert.equal(ai.index.toSymbolBundle().scripts?.[0]?.sourceUri, aiSource,
    'AI-classified LUABND sources must use the same verified semantic cache path');

  const missCache = cacheFor(null);
  const miss = await analyzeWorkspace({
    workspaceRoot: root,
    files: [fileFor('script', 'script/cache-miss.luabnd.dcx')],
    semanticCache: missCache.provider,
    inspectNativeResources: false
  });
  assert.equal(missCache.loads, 1);
  assert.equal(miss.index.toSymbolBundle().scripts, undefined,
    'cache miss must remain not_indexed without invoking a text/native parser');
  assert.equal(missCache.saves, 0);

  const staleCache = cacheFor(scriptBundle('file://script/cache-stale.luabnd.dcx', 'old-outer-hash'));
  const stale = await analyzeWorkspace({
    workspaceRoot: root,
    files: [fileFor('script', 'script/cache-stale.luabnd.dcx')],
    semanticCache: staleCache.provider,
    inspectNativeResources: false
  });
  assert.equal(stale.index.toSymbolBundle().scripts, undefined,
    'outer-hash mismatch must keep the native script source unavailable');
  assert.equal(staleCache.saves, 0);

  const missingRevisionPayload = scriptBundle('file://script/cache-missing-revision.luabnd.dcx');
  delete missingRevisionPayload.scripts![0]!.sourceRevision;
  delete missingRevisionPayload.scripts![0]!.scripts[0]!.sourceRevision;
  const missingRevisionCache = cacheFor(missingRevisionPayload);
  const missingRevision = await analyzeWorkspace({
    workspaceRoot: root,
    files: [fileFor('script', 'script/cache-missing-revision.luabnd.dcx')],
    semanticCache: missingRevisionCache.provider,
    inspectNativeResources: false
  });
  assert.equal(missingRevision.index.toSymbolBundle().scripts, undefined,
    'missing native source revision must invalidate the cached script projection');

  console.log(JSON.stringify({ ok: true, suite: 'script-semantic-cache-hydration' }));
} finally {
  await rm(root, { recursive: true, force: true });
}
