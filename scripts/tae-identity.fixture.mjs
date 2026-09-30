import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { distinctTaeFixture, manyEventsFixture } from './tae-native-fixture-helpers.mjs';

// The expected IDs, frames, fields and native byte positions are constructed
// independently. Neither reader nor round-trip output supplies the oracle.

function bridgeSession(root) {
  const executable = process.env.SOULFORGE_BRIDGE_PATH || resolve('bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe');
  const child = spawn(executable, ['daemon'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let serial = 0;
  let stderr = '';
  const pending = new Map();
  child.stderr.on('data', (data) => { stderr += data; });
  const rejectAll = (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', (code) => rejectAll(new Error(`Bridge exited (${code}): ${stderr}`)));
  createInterface({ input: child.stdout }).on('line', (line) => {
    const frame = JSON.parse(line);
    if (!['handshake', 'result', 'failed'].includes(frame.kind)) return;
    const waiter = pending.get(frame.requestId);
    if (waiter) { pending.delete(frame.requestId); clearTimeout(waiter.timeout); waiter.resolve(frame); }
  });
  const send = (kind, payload) => new Promise((resolveFrame, reject) => {
    const requestId = `fixture-${++serial}`;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Bridge timed out: ${requestId}`)); }, 30_000);
    pending.set(requestId, { resolve: resolveFrame, reject, timeout });
    child.stdin.write(JSON.stringify({ protocolVersion: '1.0.0', kind, requestId, workspaceSessionId: 'tae-fixture', payload }) + '\n');
  });
  return {
    async open() { assert.equal((await send('handshake', { allowedRoots: [root], writableRoots: [root] })).kind, 'handshake'); },
    async call(command, filePath, options = {}) {
      const frame = await send('request', { command, filePath, options });
      assert.equal(frame.kind, 'result', JSON.stringify(frame));
      return frame.payload.result;
    },
    close() { child.stdin.end(); child.kill(); }
  };
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-identity-'));
  const session = bridgeSession(root);
  try {
    await session.open();
    const fixture = distinctTaeFixture();
    const source = join(root, 'c0000.tae');
    await writeFile(source, fixture.bytes);
    await run({ ...fixture, source, root, session });
  } finally { session.close(); await rm(root, { recursive: true, force: true }); }
}

test('native reader pairs first and last IDs with their own events and HKX', async () => withFixture(async ({ source, expected, session }) => {
  const result = await session.call('read-tae-document', source);
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  assert.deepEqual(result.data.animations.map((animation) => ({
    animId: animation.animId, hkxName: animation.hkxName, motionAnimId: animation.motionAnimId,
    eventTypeId: animation.events[0].eventTypeId, startTime: animation.events[0].startTime, endTime: animation.events[0].endTime
  })), expected.map(({ animId, hkxName, eventTypeId, startTime, endTime }) => ({ animId, hkxName, motionAnimId: animId, eventTypeId, startTime, endTime })));
}));

test('native writer targets the external ID without changing adjacent animation bytes', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  for (const target of expected) {
    const outputPath = join(root, `times-${target.animId}.tae`);
    const result = await session.call('write-tae-document', source, {
      outputPath, expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'),
      mutations: [{ mutation: 'update-event-times', animId: target.animId, eventIndex: 0, startTime: 7, endTime: 8 }]
    });
    assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
    const wanted = Buffer.from(bytes);
    wanted.writeFloatLE(7, target.time); wanted.writeFloatLE(8, target.time + 4);
    assert.deepEqual(await readFile(outputPath), wanted, `only native time slots for ${target.animId} may change`);
  }
  const outputPath = join(root, 'field.tae');
  const result = await session.call('write-tae-document', source, {
    outputPath, expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'),
    mutations: [{ mutation: 'set-event-field', animId: 400000, eventIndex: 0, fieldName: 'FFXID', value: 4321, schemaBankId: 13 }]
  });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  const wanted = Buffer.from(bytes); wanted.writeInt32LE(4321, expected[0].field);
  assert.deepEqual(await readFile(outputPath), wanted);
}));

test('native reader rejects a truncated table and overflowing table/entry offsets structurally', async () => withFixture(async ({ source, bytes, session }) => {
  for (const [offset, value] of [[0x58, bytes.length - 16], [0x58, 0x7fffffffffffffffn], [0x88, 0x7fffffffffffffffn]]) {
    const malformed = Buffer.from(bytes); malformed.writeBigInt64LE(BigInt(value), offset); await writeFile(source, malformed);
    const result = await session.call('read-tae-document', source);
    assert.equal(result.parseStatus, 'failed');
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'TAE_DOCUMENT_READ_FAILED'), JSON.stringify(result));
  }
}));

test('native insertion changes only its selected animation and copies native template bytes', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  const target = expected[2];
  const outputPath = join(root, 'insert.tae');
  const result = await session.call('write-tae-document', source, {
    outputPath, expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'),
    mutations: [{ mutation: 'insert-event', animId: target.animId, templateEventIndex: 0, eventTypeId: target.eventTypeId, startTime: 9, endTime: 10 }]
  });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  const output = await readFile(outputPath);
  assert.equal(output.readInt32LE(target.entry + 32), 2);
  const table = Number(output.readBigInt64LE(target.entry));
  const added = table + 24;
  assert.equal(output.readFloatLE(Number(output.readBigInt64LE(added))), 9);
  assert.equal(output.readFloatLE(Number(output.readBigInt64LE(added + 8))), 10);
  const data = Number(output.readBigInt64LE(added + 16));
  assert.equal(output.readInt32LE(data), 300);
  const param = Number(output.readBigInt64LE(data + 8));
  assert.deepEqual(output.subarray(param, param + 32), bytes.subarray(target.field, target.field + 32));
  const reread = await session.call('read-tae-document', outputPath);
  assert.notEqual(reread.parseStatus, 'failed', JSON.stringify(reread));
  assert.equal(reread.data.animations[2].events.length, 2);
  const untouched = Buffer.from(output.subarray(0, bytes.length));
  bytes.copy(untouched, 12, 12, 16);
  bytes.copy(untouched, target.entry, target.entry, target.entry + 16);
  bytes.copy(untouched, target.entry + 32, target.entry + 32, target.entry + 36);
  assert.deepEqual(untouched, bytes, 'unrelated native bytes must be identical');
}));

test('an empty animation table ending at EOF is valid', async () => withFixture(async ({ source, bytes, session }) => {
  const empty = Buffer.from(bytes); empty.writeInt32LE(0, 0x54); empty.writeBigInt64LE(BigInt(empty.length), 0x58); empty.writeBigInt64LE(0n, 0x70);
  await writeFile(source, empty);
  const result = await session.call('read-tae-document', source);
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  assert.equal(result.data.animationCount, 0);
}));

test('targeted native action read returns every sibling beyond the timeline preview limit', async () => withFixture(async ({ source, bytes, expected, session }) => {
  const count = 240; const full = manyEventsFixture(bytes, expected, count);
  await writeFile(source, full);
  const result = await session.call('read-tae-document', source, { animId: 400000 });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  assert.equal(result.data.animations.length, 1);
  assert.equal(result.data.animations[0].events.length, count);
  assert.equal(result.data.animations[0].eventsTruncated, false);
  assert.equal(result.data.animations[0].events[239].parameterBytesHex, 'ef00000000000000');
}));

test('insertion copies a trusted other-action template and applies fields in one native mutation', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  const outputPath = join(root, 'cross-action.tae');
  const result = await session.call('write-tae-document', source, { outputPath,
    expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'),
    mutations: [{ mutation: 'insert-event', animId: 400020, templateAnimId: 400000, templateEventIndex: 0,
      eventTypeId: 100, startTime: 5, endTime: 6, fieldOverrides: [{ fieldName: 'FFXID', value: 80 }] }] });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  const output = await readFile(outputPath);
  const table = Number(output.readBigInt64LE(expected[2].entry));
  const data = Number(output.readBigInt64LE(table + 24 + 16));
  assert.equal(output.readInt32LE(data), 100);
  const param = Number(output.readBigInt64LE(data + 8));
  const wanted = Buffer.from(bytes.subarray(expected[0].field, expected[0].field + 32)); wanted.writeInt32LE(80);
  assert.deepEqual(output.subarray(param, param + 32), wanted);
  assert.deepEqual(output.subarray(expected[0].entry, expected[0].entry + 48), bytes.subarray(expected[0].entry, expected[0].entry + 48));
  assert.deepEqual(await readFile(source), bytes);
}));

test('insertion copies another native document and rejects unavailable or incompatible templates without output', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  const foreign = Buffer.from(bytes); foreign.writeInt32LE(6789, expected[0].field);
  const template = { templateAnimId: 400000, templateEventIndex: 0, templateDocumentBase64: foreign.toString('base64'), expectedTemplateDocumentHash: createHash('sha256').update(foreign).digest('hex') };
  const outputPath = join(root, 'foreign.tae');
  const options = { outputPath, expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'), mutations: [{ mutation: 'insert-event', animId: 400020, eventTypeId: 100, startTime: 5, endTime: 6, ...template }] };
  const good = await session.call('write-tae-document', source, options);
  assert.notEqual(good.parseStatus, 'failed', JSON.stringify(good));
  const output = await readFile(outputPath); const table = Number(output.readBigInt64LE(expected[2].entry));
  const data = Number(output.readBigInt64LE(table + 40)); const param = Number(output.readBigInt64LE(data + 8));
  assert.equal(output.readInt32LE(param), 6789);
  for (const change of [{ templateAnimId: 123 }, { eventTypeId: 9999 }, { expectedTemplateDocumentHash: '0'.repeat(64) }, { fieldOverrides: [{ fieldName: 'missing', value: 80 }] }]) {
    const badPath = join(root, `bad-${Object.keys(change)[0]}.tae`);
    const bad = await session.call('write-tae-document', source, { ...options, outputPath: badPath, mutations: [{ ...options.mutations[0], ...change }] });
    assert.equal(bad.parseStatus, 'failed');
    await assert.rejects(readFile(badPath), { code: 'ENOENT' });
  }
  assert.deepEqual(await readFile(source), bytes);
}));

test('Agent insertion commits through Patch Engine with audit and restores the exact original hash on rollback', async () => withFixture(async ({ source, root, bytes, expected }) => {
  const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
  const { openWorkspaceSession } = await import('../packages/core/dist/workspace/workspaceSession.js');
  const { MemoryOperationLogStore } = await import('../packages/core/dist/patch/operationLog.js');
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const { createAgentToolBridge } = await import('../packages/core/dist/ai/agentToolBridge.js');
  const { createNativeReadProofStore } = await import('../packages/core/dist/editing/nativeReadProofStore.js');
  const { createConfirmationReceipt } = await import('../packages/core/dist/patch/writerContract.js');
  const { disposeBridgeDaemonPool } = await import('../packages/core/dist/bridge/runBridge.js');
  const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
  await mkdir(join(root, '.storage'), { recursive: true });
  const store = new MemoryOperationLogStore(); const registry = createDefaultToolRegistry();
  const context = { workspaceIndex: new WorkspaceIndex(session.meta.workspaceId), mode: 'fullPermission', session, operationLogStore: store, backupBaseDir: join(root, '.storage/backups'), recoveryDir: join(root, '.storage/recovery'), nativeReadProofs: createNativeReadProofStore() };
  try {
    const insertInput = { file: source, events: [{ address: 'c0000#A400020', eventTypeId: 100, startFrame: 150, endFrame: 180, template: { address: 'c0000#A400000.e0' }, fields: [{ fieldName: 'FFXID', value: 80 }] }] };
    const unread = await registry.run('insert_tae_events', insertInput, context);
    assert.equal(unread.ok, false, 'unread insertion must fail closed');
    const bridge = createAgentToolBridge({ registry, context });
    const read = await bridge.executeTool({ id: 'read-template-and-target', name: 'read_tae_events', argumentsJson: JSON.stringify({ file: source, addresses: ['c0000#A400020', 'c0000#A400000.e0'] }) });
    assert.equal(read.ok, true, read.content);
    const result = await registry.run('insert_tae_events', insertInput, context);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.data.opId); assert.ok(result.data.backupRoot);
    assert.equal(result.data.after[0].address, 'c0000#A400020.e1');
    const output = await readFile(source); const table = Number(output.readBigInt64LE(expected[2].entry));
    const data = Number(output.readBigInt64LE(table + 40)); const param = Number(output.readBigInt64LE(data + 8));
    assert.equal(output.readInt32LE(data), 100); assert.equal(output.readInt32LE(param), 80);
    assert.deepEqual(output.subarray(expected[0].entry, expected[0].entry + 48), bytes.subarray(expected[0].entry, expected[0].entry + 48));
    const entries = await store.list(session.meta.workspaceId); assert.ok(entries.some(e => e.id === result.data.opId || e.opId === result.data.opId));
    const rollback = await registry.run('rollback_operation', { opId: result.data.opId }, { ...context, confirmation: createConfirmationReceipt({ subjects: [`ROLLBACK_OPERATION:${result.data.opId}`], riskLevel: 'high', note: 'TAE fixture rollback' }) });
    assert.equal(rollback.ok, true, JSON.stringify(rollback));
    assert.deepEqual(await readFile(source), bytes);
  } finally { await disposeBridgeDaemonPool(); }
}));


test('bounded native read of seven out of 240 events never becomes a complete cached action search', async () => withFixture(async ({ source, root, bytes, expected }) => {
  await writeFile(source, manyEventsFixture(bytes, expected));
  const { createDefaultToolRegistry } = await import('../packages/core/dist/ai/toolRegistry.js');
  const { openWorkspaceSession } = await import('../packages/core/dist/workspace/workspaceSession.js');
  const { WorkspaceIndex } = await import('../packages/core/dist/indexing/workspaceIndex.js');
  const { disposeBridgeDaemonPool } = await import('../packages/core/dist/bridge/runBridge.js');
  const session = await openWorkspaceSession({ overlayRoot: root, game: 'sekiro' });
  await mkdir(join(root, '.storage'), { recursive: true });
  const index = new WorkspaceIndex(session.meta.workspaceId); const registry = createDefaultToolRegistry();
  const context = { workspaceIndex: index, mode: 'plan', session, backupBaseDir: join(root, '.storage/backups') };
  try {
    const first = await registry.run('read_tae_events', { file: source, addresses: ['c0000#A400000'], pageSize: 7 }, context);
    assert.equal(first.ok, true, JSON.stringify(first)); assert.equal(first.data.events.length, 7);
    const found = await registry.run('search_tae_events', { query: '400000', pageSize: 7 }, context);
    assert.equal(found.ok, true, JSON.stringify(found));
    const action = found.data.matches[0].item;
    assert.equal(action.pagination.totalCount, 240);
    assert.equal(action.pagination.hasMore, true); assert.ok(action.pagination.nextRead);
    assert.equal(typeof action.pagination.nextRead.args.expectedSourceHash, 'string');
    assert.equal(action.pagination.nextRead.args.expectedReaderSchemaRevision, 2);
    assert.equal(action.eventsComplete, false);
    const next = await registry.run(action.pagination.nextRead.tool, action.pagination.nextRead.args, context);
    assert.equal(next.ok, true, JSON.stringify(next)); assert.equal(next.data.events[0].eventIndex, 7);
    let cursor = next.data.pagination.nextCursor;
    while (cursor) { const page = await registry.run('read_tae_events', { file: source, addresses: ['c0000#A400000'], cursor }, context); assert.equal(page.ok, true, JSON.stringify(page)); cursor = page.data.pagination.nextCursor; }
    const complete = index.searchTaeActionGroups('400000')[0].item;
    assert.equal(complete.eventCount, 240); assert.equal(complete.eventsComplete, true);
    assert.deepEqual(complete.events.map(e => e.index), Array.from({ length: 240 }, (_, i) => i));
    const sparseContext = { ...context, workspaceIndex: new WorkspaceIndex(session.meta.workspaceId) };
    const sparse = await registry.run('read_tae_events', { file: source, addresses: ['c0000#A400000.e239'], pageSize: 7 }, sparseContext);
    assert.equal(sparse.ok, true, JSON.stringify(sparse));
    const sparseSearch = await registry.run('search_tae_events', { query: '400000', pageSize: 7 }, sparseContext);
    assert.equal(sparseSearch.ok, true, JSON.stringify(sparseSearch));
    assert.equal(sparseSearch.data.matches[0].item.pagination.totalCount, 240);
    assert.equal(sparseSearch.data.matches[0].item.pagination.nextRead.args.offset, 0, 'a sparse cache cannot skip an unread native prefix');
    const changed = await readFile(source); changed.writeFloatLE(99, Number(changed.readBigInt64LE(Number(changed.readBigInt64LE(expected[0].entry))))); await writeFile(source, changed);
    const stale = await registry.run(action.pagination.nextRead.tool, action.pagination.nextRead.args, context);
    assert.equal(stale.ok, false, 'source changes cannot silently continue using old ordinals');
    assert.equal(stale.error.code, 'TAE_SOURCE_VERSION_CHANGED');

  } finally { await disposeBridgeDaemonPool(); }
}));

test('nonempty native event groups retain their event-table references after insertion and reject unknown reference layouts', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  const target = expected[2]; const originalTable = Number(bytes.readBigInt64LE(target.entry));
  const group = target.eventData + 48; const refs = group + 32; const descriptor = refs + 8;
  const native = Buffer.from(bytes); native.writeInt32LE(1, target.entry + 36);
  native.writeBigInt64LE(1n, group); native.writeBigInt64LE(BigInt(refs), group + 8); native.writeBigInt64LE(BigInt(descriptor), group + 16);
  native.writeInt32LE(originalTable, refs); native.writeInt32LE(300, descriptor);
  await writeFile(source, native);
  const options = { expectedDocumentHash: createHash('sha256').update(native).digest('hex'), mutations: [{ mutation: 'insert-event', animId: target.animId, templateEventIndex: 0, startTime: 9, endTime: 10 }] };
  const outputPath = join(root, 'groups.tae'); const result = await session.call('write-tae-document', source, { ...options, outputPath });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  const output = await readFile(outputPath); const table = Number(output.readBigInt64LE(target.entry)); const rebuiltGroup = Number(output.readBigInt64LE(target.entry + 8));
  const rebuiltRefs = Number(output.readBigInt64LE(rebuiltGroup + 8));
  assert.equal(output.readInt32LE(rebuiltRefs), table, 'group retains event0 identity using a native event-table entry');
  assert.equal(output.readBigInt64LE(rebuiltGroup + 16), BigInt(descriptor));
  assert.deepEqual(output.subarray(descriptor, descriptor + 16), native.subarray(descriptor, descriptor + 16));
  const unknown = Buffer.from(native); unknown.writeInt32LE(target.eventData, refs); await writeFile(source, unknown);
  const badPath = join(root, 'unknown-group.tae');
  const bad = await session.call('write-tae-document', source, { ...options, outputPath: badPath, expectedDocumentHash: createHash('sha256').update(unknown).digest('hex') });
  assert.equal(bad.parseStatus, 'failed'); assert.ok(bad.diagnostics.some(d => d.code === 'TAE_WRITE_BLOCKED_UNKNOWN_STRUCTURE'));
  await assert.rejects(readFile(badPath), { code: 'ENOENT' }); assert.deepEqual(await readFile(source), unknown);
}));

test('same-commit existing field edits survive event-data relocation while inserted overrides retain their independent template baseline', async () => withFixture(async ({ source, root, bytes, expected, session }) => {
  const outputPath = join(root, 'mixed.tae');
  const result = await session.call('write-tae-document', source, { outputPath, expectedDocumentHash: createHash('sha256').update(bytes).digest('hex'), mutations: [
    { mutation: 'set-event-field', animId: 400000, eventIndex: 0, fieldName: 'FFXID', value: 4321 },
    { mutation: 'insert-event', animId: 400000, templateEventIndex: 0, startTime: 5, endTime: 6, fieldOverrides: [{ fieldName: 'FFXID', value: 80 }] }
  ] });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  const output = await readFile(outputPath); const table = Number(output.readBigInt64LE(expected[0].entry));
  for (const [index, value] of [[0, 4321], [1, 80]]) { const data = Number(output.readBigInt64LE(table + index * 24 + 16)); const param = Number(output.readBigInt64LE(data + 8)); assert.equal(output.readInt32LE(param), value); }
  assert.deepEqual(await readFile(source), bytes);
}));
