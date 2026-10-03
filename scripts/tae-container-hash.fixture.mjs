import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { distinctTaeFixture, manyEventsFixture, taeBinderFixture } from './tae-native-fixture-helpers.mjs';
import { openWorkspaceSession } from '../packages/core/dist/workspace/workspaceSession.js';
import { nativeEditSessionFromContext } from '../packages/core/dist/editing/nativeEditSession.js';
import { MemoryOperationLogStore } from '../packages/core/dist/patch/operationLog.js';
import { runBridge, disposeBridgeDaemonPool } from '../packages/core/dist/bridge/runBridge.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function dfltDcx(payload) {
  const compressed = deflateSync(payload); const bytes = Buffer.alloc(0x4c + compressed.length);
  bytes.write('DCX\0'); bytes.writeUInt32BE(0x10000, 4); bytes.writeUInt32BE(0x18, 8); bytes.writeUInt32BE(0x24, 12);
  bytes.writeUInt32BE(0x24, 16); bytes.writeUInt32BE(0x2c, 20); bytes.write('DCS\0', 0x18);
  bytes.writeUInt32BE(payload.length, 0x1c); bytes.writeUInt32BE(compressed.length, 0x20);
  bytes.write('DCP\0', 0x24); bytes.write('DFLT', 0x28); bytes.writeUInt32BE(0x20, 0x2c); bytes[0x30] = 9;
  bytes.writeUInt32BE(0x00010100, 0x40); bytes.write('DCA\0', 0x44); bytes.writeUInt32BE(8, 0x48); compressed.copy(bytes, 0x4c);
  return bytes;
}

async function withContainer(run, intercept, expandedFirst = false) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-outer-hash-')); const source = join(root, 'chr/c0000.anibnd.dcx');
  await mkdir(join(root, 'chr')); await mkdir(join(root, 'storage'));
  const { bytes, expected } = distinctTaeFixture(); const payload = taeBinderFixture([expandedFirst ? manyEventsFixture(bytes, expected) : bytes, bytes]); const physical = dfltDcx(payload);
  await writeFile(source, physical); const calls = []; const symbol = Symbol.for('sf.tae.outer-hash.fixture');
  globalThis[symbol] = async input => { calls.push(input); const result = await runBridge(input); return intercept ? intercept(input, result, { source, physical }) : result; };
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === '../bridge/runBridge.js' && context.parentURL?.endsWith('/editing/taeEdit.js') ? { url: 'sf:tae-outer-hash-fixture', shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === 'sf:tae-outer-hash-fixture' ? { format: 'module', shortCircuit: true, source: `export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.outer-hash.fixture')](input); }` } : next(url, context); }
  });
  try {
    const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
    const edit = nativeEditSessionFromContext({ session, operationLog: new MemoryOperationLogStore(), backupBaseDir: join(root, 'storage/backups'), recoveryDir: join(root, 'storage/recovery'), stagingRoot: join(root, 'storage/staging') });
    const facade = await import('../packages/core/dist/editing/taeEdit.js');
    await run({ source, root, physical, payload, edit, calls, ...facade });
  } finally { hooks.deregister(); delete globalThis[symbol]; await disposeBridgeDaemonPool(); await rm(root, { recursive: true, force: true }); }
}

test('native ANIBND read keeps the physical DCX snapshot hash distinct from logical BND4 and TAE aggregate hashes', async () => withContainer(async ({ source, physical, payload, root }) => {
  const result = await runBridge({ command: 'read-tae-document', filePath: source, allowedRoots: [root], commandOptions: { animId: 400000, taeEntryIndex: 0 } });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  assert.equal(result.data.outerFileHash, hash(physical)); assert.equal(result.data.containerSourceHash, hash(payload));
  assert.notEqual(result.data.sourceHash, result.data.outerFileHash); assert.notEqual(result.data.sourceHash, result.data.containerSourceHash);
  assert.notEqual(result.data.outerFileHash, result.data.containerSourceHash);
}));

test('DFLT ANIBND multi-child time and field commits use the captured physical version and read back exact duplicate IDs', async () => withContainer(async ({ source, edit, calls, setTaeEventTimes, setTaeEventFields }) => {
  const times = await setTaeEventTimes({ edit, file: source, edits: [
    { address: 'action://c0000/tae/0/A400000/e0', startFrame: 90, endFrame: 120 },
    { address: 'action://c0000/tae/1/A400010/e0', startFrame: 150, endFrame: 180 }
  ] });
  assert.equal(times.ok, true, JSON.stringify(times));
  assert.deepEqual(times.after.map(event => ({ animId: event.animId, child: event.taeEntryIndex, start: event.startFrame })), [{ animId: 400000, child: 0, start: 90 }, { animId: 400010, child: 1, start: 150 }]);
  const queries = [{ animId: 400000, taeEntryIndex: 0 }, { animId: 400010, taeEntryIndex: 1 }];
  assert.deepEqual(calls.filter(call => call.command === 'read-tae-document').map(call => call.commandOptions), [...queries, ...queries]);
  calls.length = 0;
  const fields = await setTaeEventFields({ edit, file: source, edits: [
    { address: 'action://c0000/tae/0/A400000/e0', fieldName: 'FFXID', value: 81 },
    { address: 'action://c0000/tae/1/A400000/e0', fieldName: 'FFXID', value: 82 }
  ] });
  assert.equal(fields.ok, true, JSON.stringify(fields));
  assert.deepEqual(fields.after.map(event => ({ child: event.taeEntryIndex, value: event.fields.find(field => field.name === 'FFXID').value })), [{ child: 0, value: 81 }, { child: 1, value: 82 }]);
}));

test('an outer-only source replacement after native read cannot bless stale ordinals with a freshly sampled disk hash', async () => {
  let replacement;
  await withContainer(async ({ source, edit, calls, setTaeEventTimes }) => {
    const result = await setTaeEventTimes({ edit, file: source, edits: [{ address: 'action://c0000/tae/0/A400000/e0', startFrame: 90 }] });
    assert.equal(result.ok, false); assert.equal(result.error.code, 'TAE_SOURCE_VERSION_CHANGED');
    assert.deepEqual(await readFile(source), replacement, 'the external replacement must remain unchanged');
    assert.ok(calls.every(call => call.command === 'read-tae-document'), 'source mismatch rejects before native staging');
  }, async (input, result, { source, physical }) => {
    if (!replacement && input.command === 'read-tae-document') { replacement = Buffer.from(physical); replacement[0x34] ^= 1; await writeFile(source, replacement); }
    return result;
  });
});

test('public DFLT read-search continuation retains the native physical hash and advances the exact action', async () => withContainer(async ({ source, physical, edit, root }) => {
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
  const info = await stat(source); const sourceUri = pathToFileURL(source).href; const index = new WorkspaceIndex(edit.session.meta.workspaceId);
  index.setFiles([{ sourceUri, sourcePath: source, absolutePath: source, relativePath: 'chr/c0000.anibnd.dcx', resourceKind: 'action', formatKind: 'bnd', game: 'sekiro', mtimeMs: info.mtimeMs, size: info.size, sha256: hash(physical) }]);
  const context = { workspaceIndex: index, mode: 'plan', session: edit.session, backupBaseDir: join(root, 'storage/backups') }; const registry = createDefaultToolRegistry();
  const first = await registry.run('read_tae_events', { file: sourceUri, addresses: ['action://c0000/tae/0/A400000'], pageSize: 7 }, context);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(index.toSymbolBundle().tae?.[0]?.outerFileHash, hash(physical), 'public indexing must use the captured physical DCX version');
  const search = await registry.run('search_tae_events', { query: '400000', pageSize: 7 }, context); assert.equal(search.ok, true, JSON.stringify(search));
  const next = search.data.matches[0].item.pagination.nextRead; assert.ok(next); assert.equal(next.args.expectedSourceHash, hash(physical));
  const continued = await registry.run(next.tool, next.args, context); assert.equal(continued.ok, true, JSON.stringify(continued));
  assert.equal(continued.data.events[0].eventIndex, 7); assert.equal(continued.data.pagination.totalCount, 240);
}, undefined, true));

test('a public bounded read merges into an unchanged native snapshot without conflicting hash domains or dropping siblings', async () => withContainer(async ({ source, physical, edit, root }) => {
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const { ingestBridgeResult } = await import('../packages/core/dist/indexing/ingestBridgeResult.js');
  const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
  const info = await stat(source); const sourceUri = pathToFileURL(source).href; const index = new WorkspaceIndex(edit.session.meta.workspaceId);
  index.setFiles([{ sourceUri, sourcePath: source, absolutePath: source, relativePath: 'chr/c0000.anibnd.dcx', resourceKind: 'action', formatKind: 'bnd', game: 'sekiro', mtimeMs: info.mtimeMs, size: info.size, sha256: hash(physical) }]);
  const native = await runBridge({ command: 'read-tae-document', filePath: source, allowedRoots: [root], commandOptions: { animationPage: 0, animationPageSize: 64 } });
  assert.equal(ingestBridgeResult(index, native).accepted, true);
  const originalMerge = index.mergeTaeEvents.bind(index); let accepted;
  index.mergeTaeEvents = projection => (accepted = originalMerge(projection));
  const result = await createDefaultToolRegistry().run('read_tae_events', { file: sourceUri, addresses: ['action://c0000/tae/0/A400000/e0'], pageSize: 1 }, { workspaceIndex: index, mode: 'plan', session: edit.session, backupBaseDir: join(root, 'storage/backups') });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(accepted, true, 'the public projection must retain the native logical hash domain');
  const projected = index.toSymbolBundle().tae[0]; assert.equal(projected.sourceHash, native.data.sourceHash);
  assert.equal(projected.outerFileHash, hash(physical)); assert.equal(projected.animations.length, 6, 'the same physical snapshot must preserve unread sibling actions');
  assert.ok(projected.animations.some(action => action.taeEntryIndex === 1 && action.animId === 400020 && action.events.length === 1));
}));

test('a template extraction hash mismatch is rejected before using its child bytes', async () => {
  let extracted = false;
  await withContainer(async ({ source, physical, edit, insertTaeEvents }) => {
    const result = await insertTaeEvents({ edit, file: source, events: [{ address: 'action://c0000/tae/1/A400010', eventTypeId: 100, startFrame: 90, endFrame: 120, template: { address: 'action://c0000/tae/0/A400000/e0' } }] });
    assert.equal(extracted, true); assert.equal(result.ok, false); assert.equal(result.error.code, 'TAE_TEMPLATE_HASH_MISMATCH');
    assert.deepEqual(await readFile(source), physical);
  }, async (input, result) => {
    if (input.command === 'extract-bnd4-child') { extracted = true; return { ...result, data: { ...result.data, sourceHash: '0'.repeat(64) } }; }
    return result;
  });
});
