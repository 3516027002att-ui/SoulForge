import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openWorkspaceSession } from '../packages/core/dist/workspace/workspaceSession.js';
import { distinctTaeFixture, manyEventsFixture } from './tae-native-fixture-helpers.mjs';

test('automatic TAE time and field mutation preflight reads query their edited actions exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-mutation-read-')); const source = join(root, 'chr/c0000.anibnd.dcx');
  await mkdir(join(root, 'chr')); await writeFile(source, 'owned read-only transport fixture');
  const calls = []; const symbol = Symbol.for('sf.tae.mutation.read');
  globalThis[symbol] = async input => { calls.push(input); return { parseStatus: 'failed', diagnostics: [{ severity: 'error', code: 'FIXTURE_STOP', message: 'Stop before mutation after observing its native read.' }] }; };
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === '../bridge/runBridge.js' && context.parentURL?.endsWith('/editing/taeEdit.js') ? { url: 'sf:tae-mutation-read', shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === 'sf:tae-mutation-read' ? { format: 'module', shortCircuit: true, source: `export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.mutation.read')](input); }` } : next(url, context); }
  });
  try {
    const { setTaeEventTimes, setTaeEventFields } = await import('../packages/core/dist/editing/taeEdit.js');
    const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' }); const edit = { session, allowedRoots: () => [root] };
    const times = await setTaeEventTimes({ edit, file: source, edits: [{ address: 'action://c0000/tae/9/A400000/e0', startFrame: 30 }] });
    assert.equal(times.ok, false); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].commandOptions, { animId: 400000, taeEntryIndex: 9 }, 'automatic edit preflight must not export all container actions');
    calls.length = 0;
    const fields = await setTaeEventFields({ edit, file: source, edits: [{ address: 'c0000#A400010.e0', fieldName: 'FFXID', value: 80 }] });
    assert.equal(fields.ok, false); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].commandOptions, { animId: 400010 });
    calls.length = 0;
    const invalid = await setTaeEventTimes({ edit, file: source, edits: [{ address: 'bad-address', startFrame: 30 }] });
    assert.equal(invalid.ok, false); assert.equal(invalid.error.code, 'TAE_ADDRESS_INVALID'); assert.equal(calls.length, 0, 'an invalid automatic edit cannot fall back to full export');
  } finally { hooks.deregister(); delete globalThis[symbol]; await rm(root, { recursive: true, force: true }); }
});

test('native TAE mutation readback keeps complete edited actions and supports multi-action batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-mutation-targets-')); const source = join(root, 'chr/c0000.tae');
  await mkdir(join(root, 'chr'));
  await mkdir(join(root, 'storage'), { recursive: true });
  const { bytes, expected } = distinctTaeFixture();
  const calls = []; const symbol = Symbol.for('sf.tae.mutation.read');
  const original = await import('../packages/core/dist/bridge/runBridge.js');
  globalThis[symbol] = async input => { calls.push(input); return original.runBridge(input); };
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === '../bridge/runBridge.js' && context.parentURL?.endsWith('/editing/taeEdit.js') ? { url: 'sf:tae-mutation-read', shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === 'sf:tae-mutation-read' ? { format: 'module', shortCircuit: true, source: `export async function runBridge(input) { return globalThis[Symbol.for('sf.tae.mutation.read')](input); }` } : next(url, context); }
  });
  try {
    const { setTaeEventTimes, setTaeEventFields } = await import('../packages/core/dist/editing/taeEdit.js');
    const { nativeEditSessionFromContext } = await import('../packages/core/dist/editing/nativeEditSession.js');
    const { MemoryOperationLogStore } = await import('../packages/core/dist/patch/operationLog.js');
    const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
    const edit = nativeEditSessionFromContext({ session, operationLog: new MemoryOperationLogStore(), backupBaseDir: join(root, 'storage/backups'), recoveryDir: join(root, 'storage/recovery'), stagingRoot: join(root, 'storage/staging') });
    await writeFile(source, manyEventsFixture(bytes, expected));
    const times = await setTaeEventTimes({ edit, file: source, edits: [{ address: 'c0000#A400000.e239', startFrame: 300, endFrame: 320 }] });
    assert.equal(times.ok, true, JSON.stringify(times));
    assert.equal(times.after.length, 240, 'complete selected action remains available beyond the 200-event timeline preview');
    assert.equal(times.after[239].startFrame, 300); assert.equal(times.after[239].endFrame, 320);
    assert.deepEqual(calls.filter(call => call.command === 'read-tae-document').map(call => call.commandOptions), [{ animId: 400000 }, { animId: 400000 }]);
    calls.length = 0; await writeFile(source, bytes);
    const fields = await setTaeEventFields({ edit, file: source, edits: [{ address: 'c0000#A400000.e0', fieldName: 'FFXID', value: 80 }] });
    assert.equal(fields.ok, true, JSON.stringify(fields)); assert.equal(fields.after.length, 1);
    assert.equal(fields.after[0].fields.find(field => field.name === 'FFXID').value, 80);
    assert.deepEqual(calls.filter(call => call.command === 'read-tae-document').map(call => call.commandOptions), [{ animId: 400000 }, { animId: 400000 }]);
    calls.length = 0;
    const batchTimes = await setTaeEventTimes({ edit, file: source, edits: [
      { address: 'c0000#A400000.e0', startFrame: 90, endFrame: 120 },
      { address: 'c0000#A400010.e0', startFrame: 150, endFrame: 180 }
    ] });
    assert.equal(batchTimes.ok, true, JSON.stringify(batchTimes));
    assert.deepEqual(batchTimes.after.map(event => ({ animId: event.animId, start: event.startFrame })), [
      { animId: 400000, start: 90 }, { animId: 400010, start: 150 }
    ]);
    const batchQueries = [{ animId: 400000 }, { animId: 400010 }];
    assert.deepEqual(calls.filter(call => call.command === 'read-tae-document').map(call => call.commandOptions), [...batchQueries, ...batchQueries]);
  } finally { hooks.deregister(); delete globalThis[symbol]; await original.disposeBridgeDaemonPool(); await rm(root, { recursive: true, force: true }); }
});
