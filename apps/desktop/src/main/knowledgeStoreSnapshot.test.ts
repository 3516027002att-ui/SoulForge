import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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

const ipcSource = await readFile(fileURLToPath(new URL('./ipc.ts', import.meta.url)), 'utf8');
assert.equal(ipcSource.includes('openWorkspaceDatabase('), false, 'main currentToolContext must not open SQLite synchronously');
assert.match(ipcSource, /loadKnowledgeSnapshot/);

console.log('knowledgeStoreSnapshot: PASS (read-only CAS fail-closed)');
