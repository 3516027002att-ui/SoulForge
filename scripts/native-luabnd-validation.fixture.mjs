import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';

const script = fileURLToPath(new URL('./verify-native-luabnd.mjs', import.meta.url));
const inputVariables = ['SOULFORGE_LUABND_PATH', 'SOULFORGE_NATIVE_FIXTURE_ROOT',
  'SOULFORGE_NATIVE_FIXTURE_REGISTRY', 'SOULFORGE_SEKIRO_GAME_ROOT', 'SOULFORGE_SEKIRO_ROOT'];

function invoke(cwd, args = [], extraEnv = {}) {
  const env = { ...process.env };
  for (const name of inputVariables) delete env[name];
  Object.assign(env, extraEnv);
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  const output = `${child.stdout}\n${child.stderr}`.trim();
  const start = output.indexOf('{');
  assert.ok(start >= 0, `Expected a structured validation report: ${output}`);
  let report;
  try { report = JSON.parse(output.slice(start)); }
  catch { assert.fail(`Expected valid JSON validation report: ${output}`); }
  return { exitCode: child.status, report };
}

test('unconfigured Lua native validation is unavailable and cannot report success', async () => {
  const owned = await createOwnedTemporaryDirectory('luabnd-no-input-regression');
  try {
    const { exitCode, report } = invoke(owned.root);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.code, 'LUABND_INPUT_UNAVAILABLE');
    assert.equal(report.ok, false);
    assert.notEqual(exitCode, 0);
    assert.equal(report.fullCorpusAcceptance, false);
  } finally { await owned.dispose(); }
});

// Test-only construction. Native parsing/writing remains in the real Bridge.
function syntheticLuaBinder() {
  const children = [
    { name: 'goal_list.lua', bytes: Buffer.from('GOAL_COMMON_TopGoal = 0\n-- owned Lua validation fixture\n') },
    { name: 'other.lua', bytes: Buffer.from('return 42\n') },
    { name: 'opaque.bin', bytes: Buffer.from([0, 255, 1, 254, 2, 253]) }
  ];
  const names = children.map(item => Buffer.from(`${item.name}\0`));
  const tableEnd = 0x40 + 0x24 * children.length;
  const dataOffset = tableEnd + names.reduce((total, bytes) => total + bytes.length, 0) + 96;
  let end = dataOffset;
  const offsets = children.map(item => { const at = end; end += item.bytes.length + 48; return at; });
  const binder = Buffer.alloc(end);
  binder.write('BND4');
  binder.writeInt32LE(children.length, 0x0c);
  binder.writeBigInt64LE(0x40n, 0x10);
  binder.write('07D7R6\0\0', 0x18);
  binder.writeBigInt64LE(0x24n, 0x20);
  binder.writeBigInt64LE(BigInt(dataOffset - 8), 0x28);
  binder[0x30] = 0x74;
  binder[0x31] = 1;
  let nameOffset = tableEnd;
  children.forEach((item, index) => {
    const at = 0x40 + index * 0x24;
    binder.writeInt32LE(0x40, at);
    binder.writeInt32LE(-1, at + 4);
    binder.writeBigInt64LE(BigInt(item.bytes.length), at + 8);
    binder.writeBigInt64LE(BigInt(item.bytes.length), at + 16);
    binder.writeUInt32LE(offsets[index], at + 24);
    binder.writeInt32LE(index, at + 28);
    binder.writeUInt32LE(nameOffset, at + 32);
    names[index].copy(binder, nameOffset);
    item.bytes.copy(binder, offsets[index]);
    nameOffset += names[index].length;
  });
  const compressed = deflateSync(binder);
  const dcx = Buffer.alloc(0x4c + compressed.length);
  dcx.write('DCX\0');
  for (const [offset, value] of [[4, 0x10000], [8, 0x18], [12, 0x24], [16, 0x24], [20, 0x2c]]) dcx.writeInt32BE(value, offset);
  dcx.write('DCS\0', 0x18);
  dcx.writeInt32BE(binder.length, 0x1c);
  dcx.writeInt32BE(compressed.length, 0x20);
  dcx.write('DCP\0', 0x24);
  dcx.write('DFLT', 0x28);
  dcx.writeInt32BE(0x20, 0x2c);
  dcx[0x30] = 9;
  dcx.writeInt32BE(0x10100, 0x40);
  dcx.write('DCA\0', 0x44);
  dcx.writeInt32BE(8, 0x48);
  compressed.copy(dcx, 0x4c);
  return dcx;
}

test('production host exports and writes only staging while preserving every other synthetic child', async () => {
  const owned = await createOwnedTemporaryDirectory('luabnd-host-regression');
  try {
    const path = join(owned.root, 'owned.luabnd.dcx');
    const bytes = syntheticLuaBinder();
    await writeFile(path, bytes);
    const { exitCode, report } = invoke(owned.root, [path]);
    assert.equal(exitCode, 0, JSON.stringify(report));
    assert.equal(report.status, 'passed');
    assert.equal(report.selection, 'explicit-source');
    assert.equal(report.sourceUnchanged, true);
    assert.equal(report.entryCount, 3);
    assert.equal(report.scriptCount, 2);
    assert.equal(report.unchangedEntriesVerified, 2);
    assert.equal(report.stagedWriteVerified, true);
    assert.equal(report.nativeWriterPreservationVerified, true);
    assert.equal(report.exportVerified, true);
    assert.equal(report.negativeControls.outputBoundary, 'BRIDGE_OUTPUT_OUTSIDE_WRITABLE_ROOTS');
    assert.equal(report.negativeControls.containerHash, 'LUABND_CONTAINER_HASH_MISMATCH');
    assert.equal(report.negativeControls.childHash, 'LUABND_CHILD_HASH_MISMATCH');
    assert.equal(report.fullCorpusAcceptance, false);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await owned.dispose(); }
});

test('an explicitly missing Lua input returns a structured unavailable report', async () => {
  const owned = await createOwnedTemporaryDirectory('luabnd-missing-input-regression');
  try {
    const { exitCode, report } = invoke(owned.root, [join(owned.root, 'missing.luabnd.dcx')]);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.code, 'LUABND_INPUT_UNAVAILABLE');
    assert.equal(report.ok, false);
    assert.notEqual(exitCode, 0);
  } finally { await owned.dispose(); }
});

test('a registry hash mismatch fails closed before any native operation', async () => {
  const owned = await createOwnedTemporaryDirectory('luabnd-registry-cas-regression');
  try {
    await mkdir(join(owned.root, 'mods', 'script'), { recursive: true });
    const path = join(owned.root, 'mods', 'script', 'aicommon.luabnd.dcx');
    const bytes = syntheticLuaBinder();
    await writeFile(path, bytes);
    const registry = join(owned.root, 'registry.json');
    await writeFile(registry, JSON.stringify({ schemaVersion: '1.0.0', fixtures: [{
      fixtureId: 'owned-lua-fixture', testRole: 'luabnd-primary',
      localPath: 'mods/script/aicommon.luabnd.dcx', sha256: '0'.repeat(64)
    }] }));
    const { exitCode, report } = invoke(owned.root, [], {
      SOULFORGE_NATIVE_FIXTURE_ROOT: owned.root, SOULFORGE_NATIVE_FIXTURE_REGISTRY: registry
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.code, 'NATIVE_FIXTURE_HASH_MISMATCH');
    assert.equal(report.ok, false);
    assert.notEqual(exitCode, 0);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await owned.dispose(); }
});

test('a matching custom registry cannot replace the independently pinned native corpus', async () => {
  const owned = await createOwnedTemporaryDirectory('luabnd-pinned-cas-regression');
  try {
    await mkdir(join(owned.root, 'mods', 'script'), { recursive: true });
    const path = join(owned.root, 'mods', 'script', 'aicommon.luabnd.dcx');
    const bytes = syntheticLuaBinder();
    await writeFile(path, bytes);
    const registry = join(owned.root, 'registry.json');
    await writeFile(registry, JSON.stringify({ schemaVersion: '1.0.0', fixtures: [{
      fixtureId: 'owned-lua-fixture', testRole: 'luabnd-primary',
      localPath: 'mods/script/aicommon.luabnd.dcx', sha256: createHash('sha256').update(bytes).digest('hex')
    }] }));
    const { exitCode, report } = invoke(owned.root, [], {
      SOULFORGE_NATIVE_FIXTURE_ROOT: owned.root, SOULFORGE_NATIVE_FIXTURE_REGISTRY: registry
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.code, 'FIXED_CORPUS_HASH_MISMATCH');
    assert.equal(report.ok, false);
    assert.notEqual(exitCode, 0);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await owned.dispose(); }
});
