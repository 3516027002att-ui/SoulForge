export interface SyntheticFlverFixture {
  bytes: Buffer;
  indices: number[];
  expectedTriangles: Array<[number, number, number]>;
  vertexCount: number;
}

function expandStrip(indices: number[]): Array<[number, number, number]> {
  const output: Array<[number, number, number]> = [];
  let a = 0;
  let b = 0;
  let hasA = false;
  let hasB = false;
  let parity = false;
  for (const value of indices) {
    if (value === 0xffff) {
      hasA = false;
      hasB = false;
      parity = false;
      continue;
    }
    if (!hasA) {
      a = value;
      hasA = true;
      continue;
    }
    if (!hasB) {
      b = value;
      hasB = true;
      continue;
    }
    const c = value;
    const triangle: [number, number, number] = parity
      ? [c, b, a]
      : [a, b, c];
    parity = !parity;
    a = b;
    b = c;
    if (triangle[0] === triangle[1]
      || triangle[1] === triangle[2]
      || triangle[2] === triangle[0]) {
      continue;
    }
    output.push(triangle);
  }
  return output;
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

  const indices: number[] = [0, 1, 2, 2];
  let nextVertex = 3;
  while (expandStrip(indices).length < Math.floor(emittedTriangleTarget / 2)) {
    indices.push(nextVertex++);
  }

  indices.push(0xffff, nextVertex++, nextVertex++, nextVertex++);
  while (expandStrip(indices).length < emittedTriangleTarget) {
    indices.push(nextVertex++);
  }

  const expectedTriangles = expandStrip(indices);
  const vertexCount = nextVertex;
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

  // FaceSet[0]: native display strip, 16-bit index stream.
  bytes.writeUInt32LE(0, faceSetsAt);
  bytes.writeUInt8(1, faceSetsAt + 0x04);
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
    bytes.writeFloatLE(0, at + 12);
    bytes.writeFloatLE(0, at + 16);
    bytes.writeFloatLE(1, at + 20);
    bytes.writeFloatLE(vertex / Math.max(1, vertexCount - 1), at + 24);
    bytes.writeFloatLE(0.5, at + 28);
  }

  const indexAt = dataStart + vertexBytes;
  indices.forEach((index, position) => bytes.writeUInt16LE(index, indexAt + position * 2));
  return { bytes, indices, expectedTriangles, vertexCount };
}

