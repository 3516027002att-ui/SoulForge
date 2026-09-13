export interface SyntheticFlverFixture {
  bytes: Buffer;
  indices: number[];
  expectedTriangles: Array<[number, number, number]>;
  vertexCount: number;
}

export type SyntheticReferencePoseCase =
  | 'absolute'
  | 'dynamic'
  | 'weighted'
  | 'invalid-binding'
  | 'unused-singular'
  | 'used-singular'
  | 'dynamic-cycle';

export interface SyntheticReferencePoseFixture extends SyntheticFlverFixture {
  rawPositions: number[];
  rawNormals: number[];
  expectedAbsolutePositions: number[];
  expectedAbsoluteNormals: number[];
}

interface StripState {
  a: number;
  b: number;
  hasA: boolean;
  hasB: boolean;
  parity: boolean;
}

function consumeStripIndex(
  state: StripState,
  value: number,
  output: Array<[number, number, number]>
): void {
  if (value === 0xffff) {
    state.hasA = false;
    state.hasB = false;
    state.parity = false;
    return;
  }
  if (!state.hasA) {
    state.a = value;
    state.hasA = true;
    return;
  }
  if (!state.hasB) {
    state.b = value;
    state.hasB = true;
    return;
  }
  const c = value;
  const triangle: [number, number, number] = state.parity
    ? [c, state.b, state.a]
    : [state.a, state.b, c];
  // Parity advances even when the candidate is degenerate.
  state.parity = !state.parity;
  state.a = state.b;
  state.b = c;
  if (triangle[0] === triangle[1]
    || triangle[1] === triangle[2]
    || triangle[2] === triangle[0]) {
    return;
  }
  output.push(triangle);
}

function buildStripIndexStream(emittedTriangleTarget: number): {
  indices: number[];
  expectedTriangles: Array<[number, number, number]>;
  vertexCount: number;
} {
  const indices: number[] = [0, 1, 2, 2];
  const expectedTriangles: Array<[number, number, number]> = [];
  const state: StripState = { a: 0, b: 0, hasA: false, hasB: false, parity: false };
  for (const value of indices) consumeStripIndex(state, value, expectedTriangles);

  let nextVertex = 3;
  // Keep a degenerate prefix, then cross a primitive restart before filling
  // the remaining pages. This loop is linear in the requested fixture size;
  // the old implementation repeatedly expanded the complete prefix.
  while (expectedTriangles.length < Math.floor(emittedTriangleTarget / 2)) {
    const value = nextVertex++;
    indices.push(value);
    consumeStripIndex(state, value, expectedTriangles);
  }

  indices.push(0xffff);
  consumeStripIndex(state, 0xffff, expectedTriangles);
  for (let i = 0; i < 3; i++) {
    const value = nextVertex++;
    indices.push(value);
    consumeStripIndex(state, value, expectedTriangles);
  }
  while (expectedTriangles.length < emittedTriangleTarget) {
    const value = nextVertex++;
    indices.push(value);
    consumeStripIndex(state, value, expectedTriangles);
  }
  return { indices, expectedTriangles, vertexCount: nextVertex };
}

function buildTriangleListIndexStream(emittedTriangleTarget: number): {
  indices: number[];
  expectedTriangles: Array<[number, number, number]>;
  vertexCount: number;
} {
  // One deliberate degenerate triplet exercises the list path without using
  // primitive-restart, which is a strip-only concern in this fixture.
  const indices = [0, 0, 1];
  const expectedTriangles: Array<[number, number, number]> = [];
  // Reuse a bounded vertex pool so a four-page 16-bit fixture does not
  // accidentally cross the native index-width boundary.
  const vertexCount = 4_096;
  while (expectedTriangles.length < emittedTriangleTarget) {
    const base = 2 + (expectedTriangles.length * 3) % (vertexCount - 2);
    const a = base;
    const b = 2 + ((base - 2 + 1) % (vertexCount - 2));
    const c = 2 + ((base - 2 + 2) % (vertexCount - 2));
    indices.push(a, b, c);
    expectedTriangles.push([a, b, c]);
    if (expectedTriangles.length % 4096 === 0
      && expectedTriangles.length < emittedTriangleTarget) {
      // Keep a few degenerate list candidates between page boundaries.
      indices.push(a, a, b);
    }
  }
  return { indices, expectedTriangles, vertexCount };
}

function buildSyntheticFlver(
  indices: number[],
  expectedTriangles: Array<[number, number, number]>,
  vertexCount: number,
  triangleStrip: boolean
): SyntheticFlverFixture {
  const stride = 32;
  const headerSize = 0x80;
  const meshCount = 1;
  const faceSetCount = 1;
  const vertexBufferCount = 1;
  const layoutCount = 1;
  const memberCount = 3;

  let offset = headerSize;
  const meshesAt = offset;
  offset += 48 * meshCount;
  const faceSetsAt = offset;
  offset += 32 * faceSetCount;
  const vertexBuffersAt = offset;
  offset += 32 * vertexBufferCount;
  const layoutsAt = offset;
  offset += 16 * layoutCount;
  const memberTableAt = offset;
  offset += 20 * memberCount;
  const vertexBufferIndexAt = offset;
  offset += 4;
  const faceSetIndexAt = offset;
  offset += 4;
  const dataStart = (offset + 15) & ~15;
  const vertexBytes = vertexCount * stride;
  const indexBytes = indices.length * 2;
  const dataLength = vertexBytes + indexBytes;
  const bytes = Buffer.alloc(dataStart + dataLength);

  bytes.write('FLVER\0', 0, 'ascii');
  bytes.write('L\0', 6, 'ascii');
  bytes.writeInt32LE(0x2001a, 0x08);
  bytes.writeInt32LE(dataStart, 0x0c);
  bytes.writeInt32LE(dataLength, 0x10);
  bytes.writeInt32LE(0, 0x14);
  bytes.writeInt32LE(0, 0x18);
  bytes.writeInt32LE(0, 0x1c);
  bytes.writeInt32LE(meshCount, 0x20);
  bytes.writeInt32LE(vertexBufferCount, 0x24);
  bytes.writeFloatLE(-1, 0x28);
  bytes.writeFloatLE(-1, 0x2c);
  bytes.writeFloatLE(-1, 0x30);
  bytes.writeFloatLE(vertexCount + 1, 0x34);
  bytes.writeFloatLE(2, 0x38);
  bytes.writeFloatLE(1, 0x3c);
  bytes.writeInt32LE(expectedTriangles.length, 0x40);
  bytes.writeInt32LE(expectedTriangles.length * 3, 0x44);
  bytes.writeUInt8(16, 0x48);
  bytes.writeUInt8(0, 0x49);
  bytes.writeInt32LE(faceSetCount, 0x50);
  bytes.writeInt32LE(layoutCount, 0x54);
  bytes.writeInt32LE(0, 0x58);

  // Mesh[0]: one FaceSet and one vertex buffer.
  bytes.writeUInt8(0, meshesAt);
  bytes.writeInt32LE(-1, meshesAt + 0x04);
  bytes.writeInt32LE(-1, meshesAt + 0x10);
  bytes.writeInt32LE(0, meshesAt + 0x14);
  bytes.writeInt32LE(1, meshesAt + 0x20);
  bytes.writeInt32LE(faceSetIndexAt, meshesAt + 0x24);
  bytes.writeInt32LE(1, meshesAt + 0x28);
  bytes.writeInt32LE(vertexBufferIndexAt, meshesAt + 0x2c);
  bytes.writeInt32LE(0, faceSetIndexAt);
  bytes.writeInt32LE(0, vertexBufferIndexAt);

  // FaceSet[0]: native display list or strip, 16-bit index stream.
  bytes.writeUInt32LE(0, faceSetsAt);
  bytes.writeUInt8(triangleStrip ? 1 : 0, faceSetsAt + 0x04);
  bytes.writeUInt8(0, faceSetsAt + 0x05);
  bytes.writeInt32LE(indices.length, faceSetsAt + 0x08);
  bytes.writeInt32LE(vertexBytes, faceSetsAt + 0x0c);
  bytes.writeInt32LE(16, faceSetsAt + 0x18);

  bytes.writeInt32LE(0, vertexBuffersAt);
  bytes.writeInt32LE(0, vertexBuffersAt + 0x04);
  bytes.writeInt32LE(stride, vertexBuffersAt + 0x08);
  bytes.writeInt32LE(vertexCount, vertexBuffersAt + 0x0c);
  bytes.writeInt32LE(vertexBytes, vertexBuffersAt + 0x18);
  bytes.writeInt32LE(0, vertexBuffersAt + 0x1c);

  bytes.writeInt32LE(memberCount, layoutsAt);
  bytes.writeInt32LE(memberTableAt, layoutsAt + 0x0c);
  const members = [
    { offset: 0, type: 0x02, semantic: 0 },
    { offset: 12, type: 0x02, semantic: 3 },
    { offset: 24, type: 0x01, semantic: 5 }
  ];
  members.forEach((member, index) => {
    const at = memberTableAt + index * 20;
    bytes.writeInt32LE(0, at);
    bytes.writeInt32LE(member.offset, at + 0x04);
    bytes.writeUInt32LE(member.type, at + 0x08);
    bytes.writeUInt32LE(member.semantic, at + 0x0c);
    bytes.writeInt32LE(0, at + 0x10);
  });

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const at = dataStart + vertex * stride;
    bytes.writeFloatLE(vertex, at);
    bytes.writeFloatLE(vertex % 7, at + 4);
    bytes.writeFloatLE((vertex % 11) / 10, at + 8);
    // Keep all three normal components non-zero and vertex-dependent so a
    // reused decode scratch buffer cannot pass the SF-14 payload assertions.
    bytes.writeFloatLE((vertex % 5 + 1) / 6, at + 12);
    bytes.writeFloatLE((vertex % 7 + 2) / 9, at + 16);
    bytes.writeFloatLE((vertex % 11 + 3) / 14, at + 20);
    bytes.writeFloatLE(vertex / Math.max(1, vertexCount - 1), at + 24);
    bytes.writeFloatLE((vertex % 13 + 1) / 14, at + 28);
  }

  const indexAt = dataStart + vertexBytes;
  indices.forEach((index, position) => bytes.writeUInt16LE(index, indexAt + position * 2));
  return { bytes, indices, expectedTriangles, vertexCount };
}

/**
 * A legal Sekiro-era FLVER2 with one Float3 position, Float3 normal and
 * Float2 UV stream. The index stream is a triangle strip with two deliberate
 * degenerate connections and a primitive restart. It is intentionally larger
 * than the production 8000-triangle page cap.
 */
export function buildSyntheticStripFlver(
  emittedTriangleTarget = 8_005
): SyntheticFlverFixture {
  if (!Number.isSafeInteger(emittedTriangleTarget) || emittedTriangleTarget < 8_001) {
    throw new Error('SF14 fixture target must exceed the 8000 triangle page cap.');
  }
  const stream = buildStripIndexStream(emittedTriangleTarget);
  return buildSyntheticFlver(
    stream.indices,
    stream.expectedTriangles,
    stream.vertexCount,
    true
  );
}

/** A triangle-list counterpart used to keep the cursor budget assertion honest. */
export function buildSyntheticTriangleListFlver(
  emittedTriangleTarget = 32_005
): SyntheticFlverFixture {
  if (!Number.isSafeInteger(emittedTriangleTarget) || emittedTriangleTarget < 8_001) {
    throw new Error('SF14 fixture target must exceed the 8000 triangle page cap.');
  }
  const stream = buildTriangleListIndexStream(emittedTriangleTarget);
  return buildSyntheticFlver(
    stream.indices,
    stream.expectedTriangles,
    stream.vertexCount,
    false
  );
}

/**
 * Small bone-bearing FLVER used by the map reference-pose regression.  It is
 * intentionally independent from the large SF-14 paging fixture so each
 * skinning decision is asserted against a three-vertex native stream.
 */
export function buildSyntheticReferencePoseFlver(
  testCase: SyntheticReferencePoseCase = 'absolute'
): SyntheticReferencePoseFixture {
  const dynamic = testCase === 'dynamic' || testCase === 'dynamic-cycle';
  const singular = testCase === 'used-singular' || testCase === 'unused-singular';
  const boneCount = testCase === 'unused-singular' ? 3 : 2;
  const vertexCount = 3;
  const indices = [0, 1, 2];
  const expectedTriangles: Array<[number, number, number]> = [[0, 1, 2]];
  const stride = 40;
  const headerSize = 0x80;
  const meshCount = 1;
  const faceSetCount = 1;
  const vertexBufferCount = 1;
  const layoutCount = 1;
  const memberCount = 5;

  let offset = headerSize;
  const bonesAt = offset;
  offset += 128 * boneCount;
  const meshesAt = offset;
  offset += 48;
  const faceSetsAt = offset;
  offset += 32;
  const vertexBuffersAt = offset;
  offset += 32;
  const layoutsAt = offset;
  offset += 16;
  const memberTableAt = offset;
  offset += 20 * memberCount;
  const vertexBufferIndexAt = offset;
  offset += 4;
  const faceSetIndexAt = offset;
  offset += 4;
  const boneIndexAt = offset;
  offset += boneCount * 4;
  const dataStart = (offset + 15) & ~15;
  const vertexBytes = vertexCount * stride;
  const indexBytes = indices.length * 2;
  const dataLength = vertexBytes + indexBytes;
  const bytes = Buffer.alloc(dataStart + dataLength);

  bytes.write('FLVER\0', 0, 'ascii');
  bytes.write('L\0', 6, 'ascii');
  bytes.writeInt32LE(0x2001a, 0x08);
  bytes.writeInt32LE(dataStart, 0x0c);
  bytes.writeInt32LE(dataLength, 0x10);
  bytes.writeInt32LE(0, 0x14); // dummy count
  bytes.writeInt32LE(0, 0x18); // material count
  bytes.writeInt32LE(boneCount, 0x1c);
  bytes.writeInt32LE(meshCount, 0x20);
  bytes.writeInt32LE(vertexBufferCount, 0x24);
  bytes.writeFloatLE(-1, 0x28);
  bytes.writeFloatLE(-1, 0x2c);
  bytes.writeFloatLE(-1, 0x30);
  bytes.writeFloatLE(14, 0x34);
  bytes.writeFloatLE(9, 0x38);
  bytes.writeFloatLE(3, 0x3c);
  bytes.writeInt32LE(1, 0x40); // one triangle
  bytes.writeInt32LE(3, 0x44);
  bytes.writeUInt8(16, 0x48);
  bytes.writeUInt8(0, 0x49);
  bytes.writeInt32LE(faceSetCount, 0x50);
  bytes.writeInt32LE(layoutCount, 0x54);
  bytes.writeInt32LE(0, 0x58);

  const parentOfBone0 = testCase === 'dynamic-cycle' ? 1 : -1;
  const parentOfBone1 = testCase === 'dynamic-cycle' ? 0 : 0;
  const writeBone = (
    at: number,
    translation: readonly number[],
    parent: number,
    scale: readonly number[]
  ): void => {
    bytes.writeFloatLE(translation[0]!, at + 0x00);
    bytes.writeFloatLE(translation[1]!, at + 0x04);
    bytes.writeFloatLE(translation[2]!, at + 0x08);
    bytes.writeInt32LE(0, at + 0x0c); // empty name offset
    bytes.writeFloatLE(0, at + 0x10);
    bytes.writeFloatLE(0, at + 0x14);
    bytes.writeFloatLE(0, at + 0x18);
    bytes.writeInt16LE(parent, at + 0x1c);
    bytes.writeInt16LE(-1, at + 0x1e);
    bytes.writeFloatLE(scale[0]!, at + 0x20);
    bytes.writeFloatLE(scale[1]!, at + 0x24);
    bytes.writeFloatLE(scale[2]!, at + 0x28);
    bytes.writeInt16LE(-1, at + 0x2c);
  };
  writeBone(bonesAt, [10, 0, 0], parentOfBone0, singular && testCase === 'used-singular' ? [0, 1, 1] : [2, 1, 1]);
  writeBone(bonesAt + 128, [0, 5, 0], parentOfBone1, [1, 3, 1]);
  if (boneCount === 3) writeBone(bonesAt + 256, [0, 0, 0], -1, [0, 1, 1]);

  // Mesh[0]: the FLVER2 index stream uses global bone indices.
  bytes.writeUInt8(dynamic ? 1 : 0, meshesAt);
  bytes.writeInt32LE(-1, meshesAt + 0x04);
  bytes.writeInt32LE(0, meshesAt + 0x10);
  bytes.writeInt32LE(boneCount, meshesAt + 0x14);
  bytes.writeInt32LE(boneIndexAt, meshesAt + 0x1c);
  bytes.writeInt32LE(1, meshesAt + 0x20);
  bytes.writeInt32LE(faceSetIndexAt, meshesAt + 0x24);
  bytes.writeInt32LE(1, meshesAt + 0x28);
  bytes.writeInt32LE(vertexBufferIndexAt, meshesAt + 0x2c);
  for (let bone = 0; bone < boneCount; bone++) bytes.writeInt32LE(bone, boneIndexAt + bone * 4);
  bytes.writeInt32LE(0, vertexBufferIndexAt);
  bytes.writeInt32LE(0, faceSetIndexAt);

  bytes.writeUInt32LE(0, faceSetsAt);
  bytes.writeUInt8(0, faceSetsAt + 0x04);
  bytes.writeUInt8(0, faceSetsAt + 0x05);
  bytes.writeInt32LE(indices.length, faceSetsAt + 0x08);
  bytes.writeInt32LE(vertexBytes, faceSetsAt + 0x0c);
  bytes.writeInt32LE(16, faceSetsAt + 0x18);

  bytes.writeInt32LE(0, vertexBuffersAt);
  bytes.writeInt32LE(0, vertexBuffersAt + 0x04);
  bytes.writeInt32LE(stride, vertexBuffersAt + 0x08);
  bytes.writeInt32LE(vertexCount, vertexBuffersAt + 0x0c);
  bytes.writeInt32LE(vertexBytes, vertexBuffersAt + 0x18);
  bytes.writeInt32LE(0, vertexBuffersAt + 0x1c);

  bytes.writeInt32LE(memberCount, layoutsAt);
  bytes.writeInt32LE(memberTableAt, layoutsAt + 0x0c);
  const members = [
    { offset: 0, type: 0x02, semantic: 0 },
    { offset: 12, type: 0x13, semantic: 1 },
    { offset: 16, type: 0x11, semantic: 2 },
    { offset: 20, type: 0x02, semantic: 3 },
    { offset: 32, type: 0x01, semantic: 5 }
  ];
  members.forEach((member, index) => {
    const at = memberTableAt + index * 20;
    bytes.writeInt32LE(0, at);
    bytes.writeInt32LE(member.offset, at + 0x04);
    bytes.writeUInt32LE(member.type, at + 0x08);
    bytes.writeUInt32LE(member.semantic, at + 0x0c);
    bytes.writeInt32LE(0, at + 0x10);
  });

  const rawPositions = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rawNormals = [1, 0, 0, 1, 1, 0, 0, 0, 1];
  const rawUvs = [0, 0, 1, 0, 0, 1];
  const vertexBones = [0, 1, 1];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const at = dataStart + vertex * stride;
    for (let axis = 0; axis < 3; axis++) {
      bytes.writeFloatLE(rawPositions[vertex * 3 + axis]!, at + axis * 4);
      bytes.writeFloatLE(rawNormals[vertex * 3 + axis]!, at + 20 + axis * 4);
    }
    const isWeighted = testCase === 'weighted' && vertex === 0;
    // Zero decoded weights exercise the native rigid fallback to the first
    // BoneIndices slot; any positive weight is deliberately the unsupported
    // weighted case.
    bytes[at + 12] = isWeighted ? 128 : 0;
    bytes[at + 13] = isWeighted ? 127 : 0;
    bytes[at + 14] = 0;
    bytes[at + 15] = 0;
    bytes[at + 16] = isWeighted ? 0 : vertexBones[vertex]!;
    bytes[at + 17] = isWeighted ? 1 : 0;
    bytes[at + 18] = 0;
    bytes[at + 19] = 0;
    if (testCase === 'invalid-binding' && vertex === 0) bytes[at + 16] = 7;
    bytes.writeFloatLE(rawUvs[vertex * 2]!, at + 32);
    bytes.writeFloatLE(rawUvs[vertex * 2 + 1]!, at + 36);
  }
  const indexAt = dataStart + vertexBytes;
  indices.forEach((index, position) => bytes.writeUInt16LE(index, indexAt + position * 2));

  // Independent expected reference-pose values (row-vector Scale*Translation).
  const expectedAbsolutePositions = [
    12, 0, 0,
    10, 8, 0,
    10, 5, 1
  ];
  const normalize = (x: number, y: number, z: number): number[] => {
    const length = Math.hypot(x, y, z);
    return length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
  };
  const expectedAbsoluteNormals = [
    ...normalize(0.5, 0, 0),
    ...normalize(0.5, 1 / 3, 0),
    ...normalize(0, 0, 1)
  ];
  return {
    bytes,
    indices,
    expectedTriangles,
    vertexCount,
    rawPositions,
    rawNormals,
    expectedAbsolutePositions,
    expectedAbsoluteNormals
  };
}
