import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cliWorkspaceRoot, openLocalCliSession } from './localCliSession.js';
import { makeWorkspaceId } from '../workspace/resourceUri.js';
import { SqliteOperationLogStore } from '../patch/sqliteOperationLogStore.js';

async function profile<T>(execute: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'sf-cli-linux-storage-'));
  const names = ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'LOCALAPPDATA', 'SF_E2E_WORKSPACE_STORAGE_ROOT'] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.HOME = root; process.env.XDG_DATA_HOME = join(root, 'data'); process.env.XDG_STATE_HOME = join(root, 'state');
  process.env.LOCALAPPDATA = join(root, 'windows'); delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  try { return await execute(root); }
  finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(root, { recursive: true, force: true });
  }
}

test('disposing a CLI session releases its owned audit database and permits reopening the durable log', async () => profile(async root => {
  const overlayRoot = join(root, 'mod'); await mkdir(overlayRoot);
  const session = await openLocalCliSession({overlayRoot, analyze:false, useCache:false, mode:'plan', requireDurableLog:true});
  const store = session.coreSession.operationLog;
  assert.ok(store instanceof SqliteOperationLogStore);
  try {
    assert.equal(store.database.open, true);
    await session.dispose();
    assert.equal(store.database.open, false, 'session disposal must close the SQLite connection it created');
    await assert.rejects(store.list(), /not open/);
    const reopened = await openLocalCliSession({overlayRoot, analyze:false, useCache:false, mode:'plan', requireDurableLog:true});
    try { assert.deepEqual(await reopened.coreSession.operationLog.list(), []); }
    finally { await reopened.dispose(); }
  } finally {
    // Test cleanup must not hide the connection-open assertion on Windows.
    store.close(); await session.dispose();
  }
}));

test('a prior CLI teardown failure still releases owned audit handles and keeps the original error', async () => profile(async root => {
  const overlayRoot = join(root, 'mod'); await mkdir(overlayRoot);
  const session = await openLocalCliSession({overlayRoot, analyze:false, useCache:false, mode:'plan', requireDurableLog:true});
  const store = session.coreSession.operationLog;
  assert.ok(store instanceof SqliteOperationLogStore);
  const originalClose = session.coreSession.close.bind(session.coreSession);
  const failure = new Error('owned teardown failure fixture');
  session.coreSession.close = () => { originalClose(); throw failure; };
  try {
    await assert.rejects(session.dispose(), error => error === failure);
    assert.equal(store.database.open, false, 'earlier teardown failure must not leak the owned audit connection');
    await assert.rejects(store.list(), /not open/);
  } finally {
    session.coreSession.close = originalClose;
    store.close(); await session.dispose();
  }
}));

test('production Linux CLI initializes only its XDG data tree without the test storage override', { skip: process.platform !== 'linux' }, async () => profile(async root => {
  const overlayRoot = join(root, 'mod'); await mkdir(overlayRoot);
  const session = await openLocalCliSession({ overlayRoot, analyze: false, useCache: false, mode: 'plan', requireDurableLog: true });
  try {
    assert.ok(cliWorkspaceRoot(session.coreSession.workspaceId).startsWith(join(root, 'data', 'SoulForge', 'cli-workspaces')));
    assert.equal(session.durableLog, true);
    assert.deepEqual(await readdir(root), ['data', 'mod']);
    assert.ok((await readdir(cliWorkspaceRoot(session.coreSession.workspaceId))).includes('workspace.db'));
  } finally { await session.dispose(); }
}));

test('an unusable XDG data path fails initialization without falling back into Mod or Windows storage', { skip: process.platform !== 'linux' }, async () => profile(async root => {
  const overlayRoot = join(root, 'mod'); await mkdir(overlayRoot);
  const blocked = join(root, 'blocked'); await writeFile(blocked, 'unchanged'); process.env.XDG_DATA_HOME = blocked;
  await assert.rejects(openLocalCliSession({ overlayRoot, analyze: false, useCache: false, requireDurableLog: true }), error => (error as NodeJS.ErrnoException).code === 'ENOTDIR');
  assert.deepEqual(await readdir(overlayRoot), []);
  assert.deepEqual((await readdir(root)).sort(), ['blocked', 'mod']);
}));

test('readonly audit fallback uses the physical workspace identity and exposes the actual database failure', async () => profile(async root => {
  const physicalOverlayRoot = join(root, 'mod'); await mkdir(physicalOverlayRoot);
  // The Windows runner's TEMP can use an 8.3 alias. Exercise another physical
  // alias on Linux so seeding the wrong workspace database fails locally too.
  const overlayRoot = process.platform === 'linux' ? join(root, 'mod-alias') : physicalOverlayRoot;
  if (overlayRoot !== physicalOverlayRoot) await symlink(physicalOverlayRoot, overlayRoot, 'dir');
  const workspaceId = makeWorkspaceId(await realpath(overlayRoot));
  const database = join(cliWorkspaceRoot(workspaceId), 'workspace.db');
  await mkdir(dirname(database), {recursive: true});
  await writeFile(database, 'invalid-owned-database');
  const warnings: string[] = [];
  const diagnostics: import('../diagnostics/diagnosticEvent.js').DiagnosticEvent[] = [];
  const session = await openLocalCliSession({overlayRoot, mode:'plan', analyze:false, useCache:false,
    onFallbackWarning: value => warnings.push(value), onDiagnostic: value => diagnostics.push(value)});
  try {
    assert.equal(session.coreSession.workspaceId, workspaceId);
    assert.equal(session.durableLog, false);
    assert.ok(warnings.some(value => value.includes('CLI_SQLITE_FALLBACK') && value.includes('file is not a database')));
    assert.ok(diagnostics.some(value => value.phase === 'storage.audit' && value.status === 'failed'
      && value.details?.code === 'SQLITE_NOTADB' && value.details?.durableLog === false));
    const denied = await session.executeTool({id:'plan-write',name:'mutate_param_fields',argumentsJson:'{"edits":[]}'});
    assert.equal(denied.code, 'CLI_SQLITE_UNAVAILABLE');
    assert.equal(await readFile(database, 'utf8'), 'invalid-owned-database');
    assert.deepEqual(await readdir(overlayRoot), []);
  } finally {await session.dispose();}
  await assert.rejects(openLocalCliSession({overlayRoot,mode:'normal',analyze:false,useCache:false,requireDurableLog:true}), /CLI_SQLITE_UNAVAILABLE/);
}));

test('failed semantic analysis reports source diagnostics and zero row counts instead of only completed timing', async () => profile(async root => {
  const overlayRoot = join(root, 'mod'); await mkdir(join(overlayRoot,'param'),{recursive:true});
  await writeFile(join(overlayRoot,'param','mockparam.json'), '{invalid-json');
  const warnings: string[] = [];
  const diagnostics: import('../diagnostics/diagnosticEvent.js').DiagnosticEvent[] = [];
  const session = await openLocalCliSession({overlayRoot,mode:'plan',analyze:true,useCache:false,
    onFallbackWarning:value=>warnings.push(value),onDiagnostic:value=>diagnostics.push(value)});
  try {
    assert.equal(session.workspaceIndex.getStats().paramRows, 0);
    const summary = diagnostics.find(value => value.phase === 'workspace.analyze.summary');
    assert.equal(summary?.status, 'failed');
    assert.equal((summary?.details?.counts as {paramRows:number}).paramRows, 0);
    assert.ok((summary?.details?.diagnostics as {code:string}[]).some(value=>value.code==='WORKSPACE_PIPELINE_PARSE_SKIPPED'));
    assert.ok(warnings.some(value=>value.includes('CLI_PARAM_SEMANTICS_UNAVAILABLE')));
  } finally {await session.dispose();}
}));
