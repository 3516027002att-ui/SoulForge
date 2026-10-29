import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-ignore The focused runner uses Node TypeScript stripping.
import { createReadOnlyKnowledgeStore } from './knowledgeStoreSnapshot.ts';

/**
 * 打测试 bundle 后 `import.meta.url` 指向 node_modules/.cache，用它 join 生产
 * 源码会 ENOENT。先按模块位置找，找不到再从仓库根定位源码树。
 */
function mainSource(relative: string): string {
  const fromModule = join(dirname(fileURLToPath(import.meta.url)), relative);
  if (existsSync(fromModule)) return fromModule;
  return resolve(process.cwd(), 'apps', 'desktop', 'src', 'main', relative);
}

const snapshot = {
  schemaVersion: 'knowledge-v1',
  current: 'gen-1',
  generations: [{
    generationId: 'gen-1',
    parentGeneration: null,
    schemaVersion: 'knowledge-v1',
    pages: {},
    claims: {},
    sourceRevisions: {},
    createdAt: '2026-09-20T00:00:00.000Z'
  }],
  blobs: {}
};

const readOnly = createReadOnlyKnowledgeStore(snapshot);
const generation = readOnly.currentGeneration;
const persisted = readOnly.commitPatch({
  expectedGeneration: generation,
  pages: [],
  claims: [],
  sourceRevisions: []
});
assert.equal(persisted.ok, false);
if (!persisted.ok) assert.equal(persisted.code, 'PERSISTENCE_FAILED');
assert.equal(readOnly.currentGeneration, generation);

const empty = createReadOnlyKnowledgeStore(null);
const emptyGeneration = empty.currentGeneration;
const emptyWrite = empty.commitPatch({
  expectedGeneration: emptyGeneration,
  pages: [],
  claims: [],
  sourceRevisions: []
});
assert.equal(emptyWrite.ok, false);
if (!emptyWrite.ok) assert.equal(emptyWrite.code, 'PERSISTENCE_FAILED');
assert.equal(empty.currentGeneration, emptyGeneration);

const ipcSource = await readFile(mainSource('ipc.ts'), 'utf8');
assert.equal(ipcSource.includes('openWorkspaceDatabase('), false, 'main currentToolContext must not open SQLite synchronously');
assert.match(ipcSource, /loadKnowledgeSnapshot/);

console.log('knowledgeStoreSnapshot: PASS (read-only CAS fail-closed)');
