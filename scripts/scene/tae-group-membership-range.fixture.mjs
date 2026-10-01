import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

// Independent construction, with two distinct animation event-header tables.
// This fixture checks structural membership bounds only, not group semantics.
function fixture() {
  const bytes = Buffer.alloc(2048);
  const i64 = (at, value) => bytes.writeBigInt64LE(BigInt(value), at);
  bytes.write('TAE '); bytes[7] = 0xff;
  bytes.writeInt32LE(0x1000d, 8); bytes.writeInt32LE(bytes.length, 12);
  i64(0x20, 0x50); i64(0x30, 14);
  bytes.writeInt32LE(2, 0x54); i64(0x58, 0x80); i64(0x70, 2);
  const records = [];
  for (let index = 0; index < 2; index++) {
    const id = 100 + index * 100, entry = 0xc0 + index * 0x30;
    const fileInfo = 0x140 + index * 0x40, table = 0x200 + index * 0x80;
    const time = 0x300 + index * 0x40, data = 0x400 + index * 0x80;
    const group = 0x500 + index * 0x80, descriptor = 0x620 + index * 0x20;
    const offsets = 0x680 + index * 0x20, name = 0x700 + index * 0x40;
    i64(0x80 + index * 16, id); i64(0x88 + index * 16, entry);
    i64(entry, table); i64(entry + 8, group); i64(entry + 16, time); i64(entry + 24, fileInfo);
    bytes.writeInt32LE(2, entry + 32); bytes.writeInt32LE(1, entry + 36); i64(entry + 40, 4);
    i64(fileInfo + 8, fileInfo + 16); i64(fileInfo + 16, name);
    bytes.write(`a000_${String(id).padStart(6, '0')}.hkt\0`, name, 'utf16le');
    for (let event = 0; event < 2; event++) {
      const header = table + event * 24, eventTime = time + event * 8, eventData = data + event * 32;
      i64(header, eventTime); i64(header + 8, eventTime + 4); i64(header + 16, eventData);
      bytes.writeFloatLE(event, eventTime); bytes.writeFloatLE(event + 1, eventTime + 4);
      bytes.writeInt32LE(9999, eventData); i64(eventData + 8, eventData + 16);
    }
    i64(group, 2); i64(group + 8, offsets); i64(group + 16, descriptor);
    bytes.writeInt32LE(table, offsets); bytes.writeInt32LE(table + 24, offsets + 4);
    records.push({ id, table, offsets, group });
  }
  return { bytes, records };
}

const dll = process.env.SOULFORGE_BRIDGE_DLL;
const runtime = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
const filename = process.platform === 'win32' ? 'SoulForge.Bridge.exe' : 'SoulForge.Bridge';
const executable = dll ? process.env.SOULFORGE_DOTNET_PATH || 'dotnet' : process.env.SOULFORGE_BRIDGE_PATH || resolve('bridge/SoulForge.Bridge/bin/Release/net10.0', runtime, 'publish', filename);
async function readFixture(mutate) {
  const root = await mkdtemp(join(tmpdir(), 'sf-tae-group-header-range-'));
  try {
    const sample = fixture(); mutate?.(sample);
    const path = join(root, 'sample.tae'); await writeFile(path, sample.bytes);
    const args = [...(dll ? [resolve(dll)] : []), 'read-tae-document', path];
    const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024 });
    if (result.error) throw result.error;
    const envelope = JSON.parse(result.stdout);
    assert.equal(result.status, envelope.parseStatus === 'failed' ? 2 : 0, result.stderr);
    return envelope;
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('native TAE group offsets accept first and last event headers of their own animation', async () => {
  const result = await readFixture();
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result));
  assert.equal(result.data.animationCount, 2);
  assert.deepEqual(result.data.animations.map(animation => animation.animId), [100, 200]);
  assert.equal(result.data.totalEventCount, 4);
  assert.equal(result.data.totalGroupCount, 2);
});
test('native TAE accepts an empty group without requiring an event-header member', async () => {
  const result = await readFixture(({ bytes, records }) => {
    for (const record of records) bytes.writeBigInt64LE(0n, record.group);
  });
  assert.notEqual(result.parseStatus, 'failed', JSON.stringify(result.diagnostics));
  assert.equal(result.data.totalGroupCount, 2);
});

for (const [name, offset] of [
  ['unaligned', record => record.table + 1],
  ['before the table', record => record.table - 24],
  ['at the exclusive table end', record => record.table + 48],
  ['in the other animation', (_record, records) => records[1].table],
  ['negative', () => -1]
]) {
  test(`native TAE rejects a group event-header offset ${name}`, async () => {
    const result = await readFixture(({ bytes, records }) => bytes.writeInt32LE(offset(records[0], records), records[0].offsets));
    assert.equal(result.parseStatus, 'failed', JSON.stringify(result.diagnostics));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'TAE_DOCUMENT_READ_FAILED'), JSON.stringify(result));
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.message.includes('动画 100 事件组 0 成员 0 偏移')), JSON.stringify(result.diagnostics));
  });
}
