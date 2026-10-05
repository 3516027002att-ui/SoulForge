// Actual application and Core fingerprint bodies, using owned temporary storage only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require(process.env.SOULFORGE_TEST_TYPESCRIPT_PATH ?? 'typescript');
const rootPath = resolve('apps/desktop/src/main/ipc.ts');
const servicePath = resolve('apps/desktop/src/main/services/workspaceService.ts');
const parse = (path) => ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const root = parse(rootPath);
const service = parse(servicePath);
const declaration = (ast, name) => ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
const serviceBody = declaration(service, 'bumpWorkspacePathSourceGenerationForUris');
const applicationBody = serviceBody ?? declaration(root, 'bumpPathSourceGenerationForUris');
assert.ok(applicationBody, 'actual application fingerprint helper');
const core = parse(resolve('packages/core/src/workspace/workspaceFingerprintStore.ts'));
const bodyText = (ast, node) => node.getText(ast).replace(/^export\s+/, '');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

async function harness(run) {
  const owned = await mkdtemp(join(tmpdir(), 'sf-workspace-fingerprints-'));
  const writes = [];
  const durableCalls = [];
  const getterCalls = [];
  const makeStore = () => ({ fingerprintStoreGeneration: 1, hashes: new Map(), pathGenerations: new Map(), continuity: { marker: 'owned' } });
  let store = makeStore();
  let files = [];
  let session = { meta: { workspaceId: 'workspace-a' } };
  let rejectPersistence = false;
  const durableStoragePaths = (workspaceId) => {
    durableCalls.push(workspaceId);
    return { root: join(owned, workspaceId) };
  };
  const context = {
    require, join, mkdir, writeFile,
    getWorkspaceFingerprintStore: () => { getterCalls.push('store'); return store; },
    getWorkspaceIndexedFiles: () => { getterCalls.push('files'); return files; },
    getWorkspaceSession: () => { getterCalls.push('session'); return session; },
    durableStoragePaths
  };
  vm.createContext(context);
  vm.runInContext(compile(['storePath', 'bumpPathSourceGeneration', 'saveFingerprintStore'].map((name) => bodyText(core, declaration(core, name))).join('\n')), context);
  const actualSave = context.saveFingerprintStore;
  context.saveFingerprintStore = (args) => {
    const promise = rejectPersistence ? Promise.reject(new Error('owned persistence refusal')) : actualSave(args);
    writes.push({ args, promise });
    return promise;
  };
  vm.runInContext(compile(bodyText(serviceBody ? service : root, applicationBody)), context);
  const ports = { durableStoragePaths };
  const bump = (uris) => serviceBody
    ? context.bumpWorkspacePathSourceGenerationForUris(ports, uris)
    : context.bumpPathSourceGenerationForUris(uris);
  try {
    await run({
      owned, writes, durableCalls, getterCalls, makeStore, bump,
      get store() { return store; },
      setStore: (value) => { store = value; },
      setFiles: (value) => { files = value; },
      setSession: (value) => { session = value; },
      rejectPersistence: () => { rejectPersistence = true; },
      flush: () => Promise.allSettled(writes.map((write) => write.promise))
    });
  } finally {
    await Promise.allSettled(writes.map((write) => write.promise));
    await rm(owned, { recursive: true, force: true });
  }
}

test('existing Workspace application owner contains the single fingerprint projection body', () => {
  assert.ok(serviceBody);
  assert.equal(declaration(root, 'bumpPathSourceGenerationForUris'), undefined);
  assert.match(readFileSync(rootPath, 'utf8'), /bumpWorkspacePathSourceGenerationForUris/);
});

test('missing fingerprint store returns before index/session/storage access', () => harness(async (h) => {
  h.setStore(null);
  assert.equal(h.bump(['logical://owned']), undefined);
  assert.deepEqual(h.getterCalls, ['store']);
  assert.deepEqual(h.durableCalls, []);
  assert.deepEqual(h.writes, []);
}));

test('indexed logical, relative and physical identities invalidate the same stable relative path', () => harness(async (h) => {
  const file = { sourceUri: 'logical://owned/param', relativePath: 'param/owned.param', absolutePath: join(h.owned, 'physical.param') };
  h.setFiles([file]);
  h.store.hashes.set(file.relativePath, { marker: 'stale' });
  h.store.hashes.set('param/other.param', { marker: 'retained' });
  h.bump([file.sourceUri, file.relativePath, file.absolutePath]);
  assert.equal(h.store.pathGenerations.get(file.relativePath), 3);
  assert.equal(h.store.hashes.has(file.relativePath), false);
  assert.equal(h.store.hashes.get('param/other.param').marker, 'retained');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].args.state, h.store);
}));

test('unindexed URI decoding and Windows separator fallback preserve existing source labels', () => harness(async (h) => {
  h.bump(['file://chr/owned%20model.flver', '\\chr\\owned.chrbnd.dcx', '/param/owned.param']);
  assert.deepEqual([...h.store.pathGenerations], [['chr/owned model.flver', 1], ['chr/owned.chrbnd.dcx', 1], ['param/owned.param', 1]]);
}));

test('empty labels keep the original no-mutation and one persistence behavior', () => harness(async (h) => {
  h.bump(['', '/', '\\']);
  assert.equal(h.store.pathGenerations.size, 0);
  assert.equal(h.writes.length, 1);
}));

test('malformed encoded URI retains synchronous refusal before persistence', () => harness(async (h) => {
  assert.throws(() => h.bump(['file://%invalid']), { name: 'URIError' });
  assert.equal(h.store.pathGenerations.size, 0);
  assert.equal(h.writes.length, 0);
}));

test('without an active session the original in-memory invalidation remains available', () => harness(async (h) => {
  h.setSession(null);
  h.store.hashes.set('param/owned.param', { marker: 'stale' });
  h.bump(['param/owned.param']);
  assert.equal(h.store.pathGenerations.get('param/owned.param'), 1);
  assert.equal(h.store.hashes.has('param/owned.param'), false);
  assert.deepEqual(h.durableCalls, []);
  assert.equal(h.writes.length, 0);
}));

test('actual Core persistence writes the captured fingerprint state into owned durable storage', () => harness(async (h) => {
  h.store.hashes.set('param/owned.param', { marker: 'stale' });
  assert.equal(h.bump(['param/owned.param']), undefined);
  assert.deepEqual(h.durableCalls, ['workspace-a']);
  assert.deepEqual((await h.flush()).map((result) => result.status), ['fulfilled']);
  const persisted = JSON.parse(await readFile(join(h.owned, 'workspace-a', 'fingerprints.json'), 'utf8'));
  assert.deepEqual(persisted.pathGenerations, { 'param/owned.param': 1 });
  assert.deepEqual(persisted.hashes, []);
  assert.deepEqual(persisted.continuity, { marker: 'owned' });
}));

test('rejected persistence stays best effort without changing the synchronous mutation receipt', () => harness(async (h) => {
  h.rejectPersistence();
  assert.equal(h.bump(['param/owned.param']), undefined);
  assert.equal(h.store.pathGenerations.get('param/owned.param'), 1);
  assert.deepEqual((await h.flush()).map((result) => result.status), ['rejected']);
}));

test('every call reads the active store/index/session and its explicit host storage capability', () => harness(async (h) => {
  const first = h.store;
  h.setFiles([{ sourceUri: 'logical://owned', relativePath: 'a/owned', absolutePath: 'owned-a' }]);
  h.bump(['logical://owned']);
  const second = h.makeStore();
  h.setStore(second);
  h.setFiles([{ sourceUri: 'logical://owned', relativePath: 'b/owned', absolutePath: 'owned-b' }]);
  h.setSession({ meta: { workspaceId: 'workspace-b' } });
  h.bump(['logical://owned']);
  assert.deepEqual([...first.pathGenerations], [['a/owned', 1]]);
  assert.deepEqual([...second.pathGenerations], [['b/owned', 1]]);
  assert.deepEqual(h.durableCalls, ['workspace-a', 'workspace-b']);
  assert.equal(h.writes[0].args.state, first);
  assert.equal(h.writes[1].args.state, second);
}));
