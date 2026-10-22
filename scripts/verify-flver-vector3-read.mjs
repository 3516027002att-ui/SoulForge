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
const directory = await mkdtemp(join(tmpdir(), 'sf-flver-vector3-'));
try {
  const read = async (name, members, options = {}, command = 'read-flver-mesh') => {
    const path = join(directory, `${name}.flver`); await writeFile(path, Buffer.isBuffer(members) ? members : fixture(members));
    const result = spawnSync(dotnet, [resolve(bridge), command, path, '--options', JSON.stringify(options)], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const secondary = { type: 2, semantic: 0, bytes: floats([4, -2, 7]) };
  const packed = { type: 17, semantic: 3, bytes: Buffer.from([0, 127, 254, 7]) };
  const full = await read('extra-members', [secondary, packed, { ...packed, bytes: Buffer.from([254, 127, 0, 12]) }]);
  assert.equal(full.data.positionStatus, 'decoded'); assert.equal(full.data.normalStatus, 'decoded');
  assert.equal(full.data.positionDiagnostics.length, 2); assert.equal(full.data.normalDiagnostics.length, 2);
  assert.deepEqual(decode(full.data.positionDiagnostics[1].xyzBase64), Array(3).fill([4, -2, 7]).flat());
  assert.deepEqual(decode(full.data.normalDiagnostics[1].xyzBase64), Array(3).fill([1, 0, -1]).flat());
  const decodeW = (value) => { const b = Buffer.from(value, 'base64'); return Array.from({length:b.length/4},(_,i)=>b.readInt32LE(i*4)); };
  assert.deepEqual(decodeW(full.data.normalDiagnostics[1].normalWBase64), [12,12,12]);
  const signed = await read('signed-wzyx-normal', [{type:20,semantic:3,bytes:Buffer.from([129,192,0,127])}]);
  assert.deepEqual(decode(signed.data.normalsBase64), Array(3).fill([1,0,Math.fround(-64/127)]).flat());
  assert.deepEqual(decodeW(signed.data.normalDiagnostics[0].normalWBase64), [129,129,129]);
  const short = await read('signed-short-w', [{type:26,semantic:3,bytes:shorts([-32767,0,32767,-2])}]);
  assert.deepEqual(decodeW(short.data.normalDiagnostics[0].normalWBase64),[-2,-2,-2]);
  const floatNormal = await read('float-normal', [{type:3,semantic:3,bytes:floats([1,2,3,-4])}]);
  assert.deepEqual(decodeW(floatNormal.data.normalDiagnostics[0].normalWBase64),[-4,-4,-4]);
  const fraction = await read('fraction-normal-w', [{type:3,semantic:3,bytes:floats([1,2,3,0.25])}]);
  assert.equal(fraction.data.normalStatus,'invalid'); assert.equal(fraction.data.normalDiagnostics,undefined);
  const unsupported = await read('unsupported-extra-position',[secondary,{type:17,semantic:0,bytes:Buffer.alloc(4)}]);
  assert.equal(unsupported.data.positionStatus,'unsupported'); assert.equal(unsupported.data.positionDiagnostics,undefined);
  const nonfinite = await read('nonfinite-extra-position',[secondary,{type:2,semantic:0,bytes:floats([1,NaN,3])}]);
  assert.equal(nonfinite.data.positionStatus,'invalid'); assert.equal(nonfinite.data.positionDiagnostics,undefined);
  const document = await read('nonfinite-extra-document',[secondary,{type:2,semantic:0,bytes:floats([1,NaN,3])}],{},'read-flver-document');
  assert.notEqual(document.data.authority,'native-verified');
  assert.ok(document.data.layoutWarnings.some((message)=>message.includes('FLVER_VECTOR3_DATA_INVALID')));
  const nonzeroW = await read('nonzero-position-w',[{type:3,semantic:0,bytes:floats([1,2,3,1])}]);
  assert.equal(nonzeroW.data.positionStatus,'invalid');
  const xyzNormal = await read('xyz-normal',[{type:2,semantic:3,bytes:floats([1,2,3])}]);
  assert.equal(xyzNormal.data.normalStatus,'decoded'); assert.equal(xyzNormal.data.normalDiagnostics[0].normalWBase64,undefined);
  // A valid large member may exceed document content-validation work. It
  // must remain explicitly partial rather than claiming unexamined bytes.
  const count = 1_000_001, small = fixture([]), dataStart = small.readInt32LE(12);
  const large = Buffer.alloc(dataStart + count * 12 + 6);
  small.copy(large, 0, 0, dataStart);
  large.writeInt32LE(count * 12 + 6, 16);
  large.writeInt32LE(count * 12, 176 + 12);
  large.writeInt32LE(count, 208 + 12); large.writeInt32LE(count * 12, 208 + 24);
  [0, 1, 2].forEach((value, i) => large.writeUInt16LE(value, dataStart + count * 12 + i * 2));
  const exhausted = await read('content-probe-budget', large, {}, 'read-flver-document');
  assert.equal(exhausted.data.authority,'partial');
  assert.ok(exhausted.data.unparsedGaps.some((message)=>message.includes('content probe exceeds')));
  console.log(JSON.stringify({ok:true, cases:11, contract:'complete extra position/normal members and raw native NormalW; all-or-nothing negatives'}));
} finally { await rm(directory,{recursive:true,force:true}); }
