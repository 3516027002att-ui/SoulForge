import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oracleSourcePrerequisites, verificationSkipReason } from '../verification-inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(resolve(process.env.SOULFORGE_TOOLING_ROOT ?? root, 'package.json'));
const ts = require('typescript');
const text = await readFile(resolve(root, 'packages/shared/src/msb-shape-profile.ts'), 'utf8');
const javascript = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const api = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);

test('shape capability and scaling preserve Sekiro native discriminants and axis fields', () => {
  for (const [id, kind] of [[0, 'point'], [2, 'sphere'], [3, 'cylinder'], [5, 'box']]) {
    assert.equal(api.getShapeProfile(id)?.kind, kind);
    assert.match(api.getShapeProfile(id).shapeDataPointerRule, /0x48/);
  }
  for (const id of [1, 4, 6, 99]) assert.equal(api.isShapeSupported(id), false);
  assert.deepEqual(api.BOX_SHAPE_PROFILE.fields.map(({ name, offset }) => [name, offset]), [['length', 0], ['width', 4], ['height', 8]]);
  const shapes = [
    { kind: 'sphere', shapeType: 2, radius: 7 },
    { kind: 'cylinder', shapeType: 3, radius: 2, height: 9 },
    { kind: 'box', shapeType: 5, length: 11, width: 13, height: 17 }
  ];
  for (const shape of shapes) {
    assert.equal(api.validateRegionShape(shape).valid, true);
    assert.equal(api.scaleRegionShape(shape, [2, 2, 2]).shapeType, shape.shapeType);
    const stale = { ...shape, shapeType: shape.shapeType - 1 };
    assert.equal(api.validateRegionShape(stale).valid, false, 'a kind/native-ID mismatch must fail closed');
    assert.throws(() => api.scaleRegionShape(stale, [2, 2, 2]), /shapeType/);
  }
});

const shapeOracleReason = verificationSkipReason(oracleSourcePrerequisites(process.env.SOULFORGE_MSB_FIELDS,
  'SOULFORGE_MSB_FIELDS',oracle=>oracle.source,oracle=>{
    assert.equal(oracle.ok,true); assert.equal(oracle.decoded?.format,'MSBS');
    assert.equal(oracle.oracle?.commit,'ee1dd61958f60bdc51ce3da548e9a90a8ab39905');
    assert.ok(Array.isArray(oracle.fields?.regions));
  }));
test('profiles decode dimensions at the actual raw MSBS shape pointer', { skip: shapeOracleReason ?? false }, async () => {
  const oracle = JSON.parse(await readFile(process.env.SOULFORGE_MSB_FIELDS, 'utf8'));
  assert.equal(oracle.oracle.commit, 'ee1dd61958f60bdc51ce3da548e9a90a8ab39905');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const outer = await readFile(oracle.source.path);
  assert.equal(hash(outer), oracle.source.sha256);
  assert.equal(outer.toString('ascii', 0x28, 0x2c), 'DFLT');
  const raw = inflateSync(outer.subarray(0x4c), { maxOutputLength: 64 * 1024 * 1024 });
  assert.equal(hash(raw), oracle.decoded.sha256);
  let at = 0x10, offsets;
  const visited = new Set();
  while (at) {
    assert.equal(visited.has(at), false); visited.add(at);
    const count = raw.readInt32LE(at + 4);
    const nameAt = Number(raw.readBigInt64LE(at + 8));
    let end = nameAt; while (raw.readUInt16LE(end)) end += 2;
    if (raw.toString('utf16le', nameAt, end) === 'POINT_PARAM_ST') {
      offsets = Array.from({ length: count - 1 }, (_, index) => Number(raw.readBigInt64LE(at + 0x10 + index * 8)));
      break;
    }
    at = Number(raw.readBigInt64LE(at + 0x10 + (count - 1) * 8));
  }
  assert.equal(offsets?.length, oracle.fields.regions.length);
  let decodedCount = 0;
  for (const [index, offset] of offsets.entries()) {
    const expected = oracle.fields.regions[index].entry.Shape;
    const shapeType = raw.readInt32LE(offset + 0x10);
    const profile = api.getShapeProfile(shapeType);
    const pointer = Number(raw.readBigInt64LE(offset + 0x48));
    if (shapeType === 0) { assert.equal(pointer, 0); continue; }
    if (!profile) continue; // Composite is explicitly outside dimension support.
    assert.equal(profile.kind, expected.kind.split('+').at(-1).toLowerCase());
    assert.ok(pointer >= 0x60 && offset + pointer + profile.fields.length * 4 <= raw.length);
    const oracleNames = { radius: 'Radius', height: 'Height', length: 'Width', width: 'Depth' };
    for (const field of profile.fields) assert.equal(raw.readFloatLE(offset + pointer + field.offset), Math.fround(expected[oracleNames[field.name]]));
    // +0x30 points at baseData1, and is not the shape-data address.
    assert.notEqual(raw.readBigInt64LE(offset + 0x30), BigInt(pointer));
    decodedCount++;
  }
  assert.equal(decodedCount, 208); // 81 spheres, 36 cylinders, 91 boxes.
});
