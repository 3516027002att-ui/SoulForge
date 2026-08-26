import { Buffer } from 'node:buffer';
import { mergeMapMeshGeometry, type MapMeshGeometryData } from './mapMeshGeometry.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`MAP_MESH_SMOKE_FAIL: ${message}`);
}

function expectThrow(name: string, fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, `${name} should reject malformed geometry`);
}

function f32(values: readonly number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString('base64');
}

function indices(values: readonly number[], indexSize: 16 | 32): string {
  const stride = indexSize / 8;
  const bytes = Buffer.alloc(values.length * stride);
  values.forEach((value, index) => {
    if (indexSize === 16) bytes.writeUInt16LE(value, index * stride);
    else bytes.writeUInt32LE(value, index * stride);
  });
  return bytes.toString('base64');
}

function triangle(offsetX: number, indexSize: 16 | 32 = 16): MapMeshGeometryData {
  return {
    vertexCount: 3,
    indexSize,
    positionsBase64: f32([
      offsetX, 0, 0,
      offsetX + 1, 0, 0,
      offsetX, 1, 0
    ]),
    indicesBase64: indices([0, 1, 2], indexSize)
  };
}

function decodeIndices(data: MapMeshGeometryData): number[] {
  assert(data.indexSize === 16 || data.indexSize === 32, 'merged indexSize missing');
  assert(typeof data.indicesBase64 === 'string', 'merged indices missing');
  const bytes = Buffer.from(data.indicesBase64, 'base64');
  const stride = data.indexSize / 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += stride) {
    out.push(data.indexSize === 16 ? view.getUint16(offset, true) : view.getUint32(offset, true));
  }
  return out;
}

// 1. 32-bit source indices remain 32-bit and decode to the authoritative values.
const merged32 = mergeMapMeshGeometry([triangle(0, 32)]);
assert(merged32.indexSize === 32, '32-bit source index metadata must survive merge');
assert(JSON.stringify(decodeIndices(merged32)) === JSON.stringify([0, 1, 2]), '32-bit indices must not be reinterpreted as uint16 halfwords');

// 2. Mesh B local indices are relocated by mesh A vertex count.
const mergedTwo = mergeMapMeshGeometry([triangle(0), triangle(10)]);
assert(mergedTwo.vertexCount === 6, 'two triangles should merge to six vertices');
assert(JSON.stringify(decodeIndices(mergedTwo)) === JSON.stringify([0, 1, 2, 3, 4, 5]), 'second mesh indices must receive baseVertex relocation');

// 3. Out-of-range local index is a decode failure, never clamped or filtered.
expectThrow('out-of-range index', () => {
  mergeMapMeshGeometry([{
    ...triangle(0),
    indicesBase64: indices([0, 1, 3], 16)
  }]);
});

// 4. Malformed index byte length is rejected before typed-array construction.
expectThrow('malformed index byte length', () => {
  mergeMapMeshGeometry([{
    ...triangle(0),
    indicesBase64: Buffer.from([0, 0, 1]).toString('base64')
  }]);
});

// 5. Non-finite positions are rejected rather than rewritten to zero.
expectThrow('non-finite position', () => {
  mergeMapMeshGeometry([{
    ...triangle(0),
    positionsBase64: f32([Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0])
  }]);
});

// Extra guard: positions must exactly match vertexCount * 3 Float32 values.
expectThrow('malformed position byte length', () => {
  mergeMapMeshGeometry([{
    ...triangle(0),
    positionsBase64: f32([0, 0, 0])
  }]);
});

console.log(JSON.stringify({
  ok: true,
  checks: [
    'uint32-index-authority',
    'multi-mesh-base-vertex',
    'index-range',
    'index-byte-length',
    'finite-positions',
    'position-byte-length'
  ]
}, null, 2));
