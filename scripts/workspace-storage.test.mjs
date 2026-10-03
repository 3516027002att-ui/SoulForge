import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Module, { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function loadStorage(userData) {
  const filename = resolve('apps/desktop/src/main/workspaceStorage.ts');
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = new Module(filename); loaded.filename = filename;
  loaded.require = name => name === 'electron' ? { app: { getPath: key => key === 'userData' ? userData : dirname(userData) } } : require(name);
  loaded._compile(source, filename);
  return loaded.exports;
}

test('explicit isolation creation failure does not enter normal storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-storage-isolated-'));
  const storage = loadStorage(join(root, 'userData'));
  const workspace = join(root, 'workspace'), blocked = join(root, 'file');
  fs.mkdirSync(workspace); fs.writeFileSync(blocked, 'not a directory');
  const old = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  try {
    process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = blocked;
    assert.throws(() => storage.resolveWorkspaceStoragePaths('test', workspace), error => error.code === 'WORKSPACE_ISOLATION_UNAVAILABLE');
    assert.equal(fs.existsSync(join(workspace, '.soulforge')), false);
    assert.equal(fs.existsSync(join(root, 'userData')), false);
  } finally { if (old === undefined) delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT; else process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = old; await rm(root, { recursive: true, force: true }); }
});

test('path selection leaves fallback database untouched for asynchronous initialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-storage-select-'));
  const storage = loadStorage(join(root, 'userData'));
  const workspace = join(root, 'workspace'); fs.mkdirSync(workspace);
  const old = process.env.SF_E2E_WORKSPACE_STORAGE_ROOT; delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  try {
    const fallback = storage.fallbackWorkspaceStoragePaths('test'); fs.mkdirSync(fallback.root, { recursive: true });
    const source = join(fallback.root, 'workspace.db'); fs.writeFileSync(source, 'sentinel');
    const selected = storage.resolveWorkspaceStoragePaths('test', workspace);
    assert.equal(fs.existsSync(join(selected.root, 'workspace.db')), false, 'selecting paths must not publish copied DB/WAL files');
    assert.equal(selected.migrationSourceDatabasePath, source);
    assert.equal(fs.readFileSync(source, 'utf8'), 'sentinel');
  } finally { if (old !== undefined) process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = old; await rm(root, { recursive: true, force: true }); }
});
