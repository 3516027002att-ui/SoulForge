import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
declare const __SOULFORGE_REPO_ROOT__: string;
// @ts-ignore The focused runner uses Node TypeScript stripping.
import { createReadOnlyKnowledgeStore } from './knowledgeStoreSnapshot.ts';

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

const ipcSourcePath = typeof __SOULFORGE_REPO_ROOT__ !== 'undefined'
  ? join(__SOULFORGE_REPO_ROOT__,'apps/desktop/src/main/ipc.ts')
  : fileURLToPath(new URL('./ipc.ts', import.meta.url));
const ipcSource = await readFile(ipcSourcePath, 'utf8');
assert.equal(ipcSource.includes('openWorkspaceDatabase('), false, 'main currentToolContext must not open SQLite synchronously');
assert.match(ipcSource, /loadKnowledgeSnapshot/);

console.log('knowledgeStoreSnapshot: PASS (read-only CAS fail-closed)');
