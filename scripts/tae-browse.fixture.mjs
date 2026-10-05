import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manyAnimationsFixture, manyEventsFixture, taeBinderFixture } from './tae-native-fixture-helpers.mjs';
import { openWorkspaceSession } from '../packages/core/dist/workspace/workspaceSession.js';
import { nativeEditSessionFromContext } from '../packages/core/dist/editing/nativeEditSession.js';
import { MemoryOperationLogStore } from '../packages/core/dist/patch/operationLog.js';
import { runBridge, disposeBridgeDaemonPool } from '../packages/core/dist/bridge/runBridge.js';

async function withBrowse(run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-browse-')); const source = join(root, 'chr/c0000.anibnd.dcx');
  await mkdir(join(root, 'chr')); await mkdir(join(root, 'storage'));
  const ordinary = manyAnimationsFixture(65); const table = Number(ordinary.readBigInt64LE(0x58));
  const expanded = manyEventsFixture(ordinary, [{ entry: Number(ordinary.readBigInt64LE(table + 8)) }]);
  const bytes = taeBinderFixture([expanded, ordinary]); await writeFile(source, bytes);
  const calls = []; const symbol = Symbol.for('sf.tae.browse.fixture');
  globalThis[symbol] = async input => { calls.push(input); return runBridge(input); };
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === '../bridge/runBridge.js' && context.parentURL?.endsWith('/editing/taeEdit.js') ? { url: 'sf:tae-browse-fixture', shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === 'sf:tae-browse-fixture' ? { format: 'module', shortCircuit: true, source: `export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.browse.fixture')](input); }` } : next(url, context); }
  });
  try {
    const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
    const edit = nativeEditSessionFromContext({ session, operationLog: new MemoryOperationLogStore(), backupBaseDir: join(root, 'storage/backups'), recoveryDir: join(root, 'storage/recovery'), stagingRoot: join(root, 'storage/staging') });
    const { readTaeEvents } = await import('../packages/core/dist/editing/taeEdit.js');
    const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
    await run({ source, bytes, edit, calls, readTaeEvents, registry: createDefaultToolRegistry(), context: { mode: 'plan', session, backupBaseDir: join(root, 'storage/backups') } });
  } finally { hooks.deregister(); delete globalThis[symbol]; await disposeBridgeDaemonPool(); await rm(root, { recursive: true, force: true }); }
}

test('unaddressed Agent TAE browse projects one native page and follows native boundaries without hydrating event tails', async () => withBrowse(async ({ source, edit, calls, readTaeEvents, registry, context }) => {
  const first = await registry.run('read_tae_events', { file: source, pageSize: 7 }, context);
  assert.equal(first.ok, true, JSON.stringify(first)); let page = first.data;
  assert.deepEqual(calls.map(call => call.commandOptions), [{ animationPage: 0, animationPageSize: 64 }]);
  assert.equal(page.animationCount, 130); assert.equal(page.totalEventCount, 369);
  assert.equal(page.nativePagination.returnedCount, 64); assert.equal(page.pagination.totalCount, null); assert.equal(page.status, 'partial');
  const action = page.actions.find(action => action.animId === 0); assert.equal(action.eventCount, 240); assert.equal(action.eventsComplete, false);
  const exactRead = action.pagination.nextRead; assert.ok(exactRead); assert.deepEqual(exactRead.args.addresses, ['action://c0000/tae/0/A0000']);
  const firstCursor = page.pagination.nextCursor; assert.ok(firstCursor);
  let windows = 0;
  while (calls.length === 1) {
    assert.ok(page.pagination.nextCursor); page = await readTaeEvents({ edit, file: source, pageSize: 7, cursor: page.pagination.nextCursor });
    assert.equal(page.ok, true, JSON.stringify(page)); assert.ok(++windows < 100);
  }
  assert.deepEqual(calls.map(call => call.commandOptions), [{ animationPage: 0, animationPageSize: 64 }, { animationPage: 1, animationPageSize: 64 }]);
  assert.equal(page.nativePagination.animationPage, 1); assert.ok(page.events.some(event => event.taeEntryIndex === 1));
  const replay = await readTaeEvents({ edit, file: source, pageSize: 7, cursor: firstCursor }); assert.equal(replay.ok, true); assert.equal(replay.nativePagination.animationPage, 0); assert.equal(calls.length, 2);
  const exact = await registry.run(exactRead.tool, exactRead.args, context); assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.deepEqual(calls.at(-1).commandOptions, { animId: 0, taeEntryIndex: 0 }); assert.equal(exact.data.pagination.totalCount, 240); assert.equal(exact.data.events[0].eventIndex, 7);
}));

test('structure analysis uses the same bounded native page and stale broad continuation rejects before native loading', async () => withBrowse(async ({ source, bytes, edit, calls, readTaeEvents, registry, context }) => {
  const result = await registry.run('analyze_tae_structure', { file: source, pageSize: 3 }, context);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(calls.map(call => call.commandOptions), [{ animationPage: 0, animationPageSize: 64 }]);
  assert.equal(result.data.status, 'partial'); assert.equal(result.data.pagination.totalCount, null);
  const changed = Buffer.from(bytes); changed[0x30] ^= 1; await writeFile(source, changed);
  const next = await readTaeEvents({ edit, file: source, cursor: result.data.pagination.nextCursor });
  assert.equal(next.ok, false); assert.equal(next.error.code, 'STALE_READ_CURSOR'); assert.equal(calls.length, 1);
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), createHash('sha256').update(changed).digest('hex'));
}));

test('public preview indexing retains native action totals and source-bound exact continuation', async () => withBrowse(async ({ source, bytes, edit, calls, registry, context }) => {
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const index = new WorkspaceIndex(edit.session.meta.workspaceId); const info = await stat(source);
  const sourceUri = 'file://chr/c0000.anibnd.dcx';
  index.setFiles([{ sourceUri, sourcePath: source, absolutePath: source, relativePath: 'chr/c0000.anibnd.dcx', resourceKind: 'chr', formatKind: 'bnd', game: 'sekiro', mtimeMs: info.mtimeMs, size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') }]);
  const indexedContext = { ...context, workspaceIndex: index };
  const read = await registry.run('read_tae_events', { file: sourceUri, pageSize: 7 }, indexedContext);
  assert.equal(read.ok, true, JSON.stringify(read)); assert.equal(calls.length, 1);
  const action = index.toSymbolBundle().tae[0].animations[0]; assert.equal(action.eventCount, 240); assert.equal(action.events.length, 7); assert.equal(action.eventsComplete, false);
  const search = await registry.run('search_tae_events', { query: '0000', pageSize: 7 }, indexedContext); assert.equal(search.ok, true, JSON.stringify(search));
  const next = search.data.matches[0].item.pagination.nextRead; assert.ok(next);
  assert.equal(next.args.expectedSourceHash, createHash('sha256').update(bytes).digest('hex'));
  const continued = await registry.run(next.tool, next.args, indexedContext); assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.equal(continued.data.pagination.totalCount, 240); assert.equal(continued.data.events[0].eventIndex, 7);
  assert.deepEqual(calls.at(-1).commandOptions, { animId: 0, taeEntryIndex: 0 });
}));
