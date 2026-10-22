import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const bridge = process.env.SF_TEST_BRIDGE_DLL;
if (!bridge) throw new Error('SF_TEST_BRIDGE_DLL must name a locally built framework-dependent Bridge DLL');
const dotnet = process.env.SOULFORGE_DOTNET ?? 'dotnet';
function fixture(members) {
  const stride = 12 + members.reduce((sum, m) => sum + m.bytes.length, 0);
  const refs = 256 + (members.length + 1) * 20, dataStart = refs + 8;
  const dataBytes = stride * 3 + 6;
  const bytes = Buffer.alloc(dataStart + dataBytes);
  const i32 = (at, value) => bytes.writeInt32LE(value, at);
  bytes.write('FLVER\0'); bytes.write('L\0', 6);
  i32(8, 0x20014); i32(12, dataStart); i32(16, dataBytes); i32(32, 1); i32(36, 1); i32(64, 1); i32(68, 1);
  bytes.writeUInt8(16, 72); i32(80, 1); i32(84, 1);
  for (const at of [52, 56, 60]) bytes.writeFloatLE(1, at);
  i32(128 + 4, -1); i32(128 + 16, -1); i32(128 + 32, 1); i32(128 + 36, refs); i32(128 + 40, 1); i32(128 + 44, refs + 4);
  i32(176 + 8, 3); i32(176 + 12, stride * 3); i32(176 + 24, 16);
  i32(208 + 8, stride); i32(208 + 12, 3); i32(208 + 24, stride * 3);
  i32(240, members.length + 1); i32(240 + 12, 256); i32(256 + 8, 2);
  let offset = 12;
  for (const [ordinal, member] of members.entries()) {
    const at = 256 + (ordinal + 1) * 20;
    i32(at + 4, offset); i32(at + 8, member.type); i32(at + 12, member.semantic ?? 6); i32(at + 16, ordinal);
    for (let vertex = 0; vertex < 3; vertex++) member.bytes.copy(bytes, dataStart + vertex * stride + offset);
    offset += member.bytes.length;
  }
  bytes.writeFloatLE(1, dataStart + stride); bytes.writeFloatLE(1, dataStart + stride * 2 + 4);
  [0, 1, 2].forEach((value, i) => bytes.writeUInt16LE(value, dataStart + stride * 3 + i * 2));
  return bytes;
}
const floats = (values) => { const bytes = Buffer.alloc(values.length * 4); values.forEach((v, i) => bytes.writeFloatLE(v, i * 4)); return bytes; };
const shorts = (values) => { const bytes = Buffer.alloc(values.length * 2); values.forEach((v, i) => bytes.writeInt16LE(v, i * 2)); return bytes; };
const decode = (value) => { const bytes = Buffer.from(value, 'base64'); return Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4)); };
function secondDiagnosticBuffer({ offset = 36, length = 12, semantic = 6, type = 17, layout = 1 } = {}) {
  const b = Buffer.alloc(410), i32 = (at, value) => b.writeInt32LE(value, at);
  b.write('FLVER\0'); b.write('L\0', 6);
  i32(8, 0x20014); i32(12, 356); i32(16, 54); i32(32, 1); i32(36, 2); i32(80, 1); i32(84, 2); b[72] = 16;
  i32(132, -1); i32(144, -1); i32(160, 1); i32(164, 344); i32(168, 2); i32(172, 348);
  i32(184, 3); i32(188, 48); i32(200, 16);
  i32(216, 12); i32(220, 3); i32(232, 36);
  i32(244, layout); i32(248, 4); i32(252, 3); i32(264, length); i32(268, offset);
  i32(272, 1); i32(284, 304); i32(288, 1); i32(300, 324);
  i32(312, 2); i32(332, type); i32(336, semantic); i32(352, 1);
  b.writeFloatLE(1, 368); b.writeFloatLE(1, 384);
  for (let v = 0; v < 3; v++) Buffer.from([0, 127, 254, 255]).copy(b, 392 + v * 4);
  [0, 1, 2].forEach((value, i) => b.writeUInt16LE(value, 404 + i * 2));
  return b;
}
const directory = await mkdtemp(join(tmpdir(), 'sf-flver-vector4-'));
try {
  const read = async (name, members, options = {}) => {
    const path = join(directory, `${name}.flver`); await writeFile(path, Buffer.isBuffer(members) ? members : fixture(members));
    const result = spawnSync(dotnet, [resolve(bridge), 'read-flver-mesh', path, '--options', JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (result.error) throw result.error;
    return JSON.parse(result.stdout);
  };
  const packed = { type: 17, bytes: Buffer.from([0, 127, 254, 255]) };
  const vector = { type: 3, bytes: floats([-2, 0.25, 3, 1]) };
  const full = await read('multiple', [packed, vector, { ...packed, semantic: 7 }]);
  assert.equal(full.data.tangentStatus, 'decoded'); assert.equal(full.data.bitangentStatus, 'decoded');
  assert.equal(full.data.tangentDiagnostics.length, 2); assert.equal(full.data.bitangentDiagnostics.length, 1);
  assert.deepEqual(decode(full.data.tangentDiagnostics[0].xyzwBase64), Array(3).fill([-1, 0, 1, Math.fround(128 / 127)]).flat());
  assert.deepEqual(decode(full.data.tangentDiagnostics[1].xyzwBase64), Array(3).fill([-2, 0.25, 3, 1]).flat());
  const reversed = await read('signed-reverse', [{ type: 20, bytes: Buffer.from([129, 192, 0, 127]) }]);
  assert.deepEqual(decode(reversed.data.tangentDiagnostics[0].xyzwBase64), Array(3).fill([1, 0, Math.fround(-64 / 127), -1]).flat());
  const short = await read('short', [{ type: 26, bytes: shorts([-32767, -8192, 16384, 32767]) }]);
  assert.deepEqual(decode(short.data.tangentDiagnostics[0].xyzwBase64), Array(3).fill([-1, Math.fround(-8192 / 32767), Math.fround(16384 / 32767), 1]).flat());
  const unsupported = await read('unsupported', [packed, { type: 1, bytes: Buffer.alloc(4) }]);
  assert.equal(unsupported.data.tangentStatus, 'unsupported'); assert.equal(unsupported.data.tangentDiagnostics, undefined);
  const nonfinite = await read('nonfinite', [packed, { type: 3, bytes: floats([0, NaN, 0, 1]) }]);
  assert.equal(nonfinite.data.tangentStatus, 'invalid'); assert.equal(nonfinite.data.tangentDiagnostics, undefined);
  const bitangentFloat = await read('bitangent-float', [{ ...vector, semantic: 7 }]);
  assert.equal(bitangentFloat.data.bitangentStatus, 'unsupported');
  const absent = await read('absent', []); assert.equal(absent.data.tangentStatus, 'absent');
  const normal = await read('packed-normal-at-tail', [{ type: 17, semantic: 3, bytes: Buffer.from([0, 127, 254, 7]) }]);
  assert.deepEqual(decode(normal.data.normalsBase64), Array(3).fill([-1, 0, 1]).flat());
  const signedNormal = await read('signed-normal', [{ type: 20, semantic: 3, bytes: Buffer.from([129, 0, 127, 7]) }]);
  assert.deepEqual(decode(signedNormal.data.normalsBase64), Array(3).fill([Math.fround(7 / 127), 1, 0]).flat());
  const second = await read('valid-second-buffer', secondDiagnosticBuffer()); assert.equal(second.data.tangentStatus, 'decoded');
  for (const [name, options] of [['short-buffer', { length: 8 }], ['negative-buffer', { length: -1 }], ['offset-outside-file', { offset: 999999 }], ['invalid-layout', { layout: 99 }]]) {
    const corrupt = await read(name, secondDiagnosticBuffer(options));
    assert.equal(corrupt.data.tangentStatus, 'invalid'); assert.equal(corrupt.data.tangentDiagnostics, undefined);
  }
  const badColor = await read('invalid-second-color', secondDiagnosticBuffer({ semantic: 10, type: 19, offset: 999999 }));
  assert.equal(badColor.data.vertexColorStatus, 'invalid'); assert.equal(badColor.data.vertexColorDiagnostics, undefined);
  console.log(JSON.stringify({ status: 'passed', cases: ['packed/f32 multi-member and bitangent', 'signed WZYX', 'signed short XYZW', 'unsupported all-or-nothing', 'nonfinite all-or-nothing', 'unsupported bitangent', 'absent', 'packed normal source-tail bound', 'signed normal WZYX', 'valid second buffer', 'short declared buffer', 'negative declared buffer', 'second offset out of file', 'invalid second layout', 'invalid RGBA second buffer'] }));
} finally { await rm(directory, { recursive: true, force: true }); }
