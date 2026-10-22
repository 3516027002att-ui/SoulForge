import { deflateSync } from 'node:zlib';

// Independent minimal FLVER2 construction, no production parser dependency.
export function triangleFlver(sourceBytes = 326, x = 1) {
  const bytes = Buffer.alloc(sourceBytes), i32 = (at, n) => bytes.writeInt32LE(n, at);
  const refs = 276, dataStart = 284;
  bytes.write('FLVER\0'); bytes.write('L\0', 6); i32(8, 0x20014); i32(12, dataStart); i32(16, 42);
  for (const at of [32, 36, 64, 68, 80, 84]) i32(at, 1);
  bytes[72] = 16; for (const at of [52, 56, 60]) bytes.writeFloatLE(1, at);
  i32(132, -1); i32(144, -1); i32(160, 1); i32(164, refs); i32(168, 1); i32(172, refs + 4);
  i32(184, 3); i32(188, 36); i32(200, 16); i32(216, 12); i32(220, 3); i32(232, 36);
  i32(240, 1); i32(252, 256); i32(264, 2);
  bytes.writeFloatLE(x, dataStart + 12); bytes.writeFloatLE(1, dataStart + 28);
  [0, 1, 2].forEach((n, i) => bytes.writeUInt16LE(n, dataStart + 36 + i * 2));
  return bytes;
}

export function singleFlverBinder(payload, entryName = 'allocationFixture.flver') {
  const name = Buffer.from(entryName + '\0');
  const namesOffset = 0x64, dataOffset = namesOffset + name.length;
  const bytes = Buffer.alloc(dataOffset + payload.length);
  bytes.write('BND4'); bytes.writeInt32LE(1, 0x0c);
  bytes.writeBigInt64LE(0x40n, 0x10); bytes.writeBigInt64LE(0x24n, 0x20);
  bytes.writeBigInt64LE(BigInt(dataOffset), 0x28);
  bytes.writeBigInt64LE(BigInt(payload.length), 0x48); bytes.writeBigInt64LE(BigInt(payload.length), 0x50);
  bytes.writeUInt32LE(dataOffset, 0x58); bytes.writeUInt32LE(namesOffset, 0x60);
  name.copy(bytes, namesOffset); payload.copy(bytes, dataOffset);
  return bytes;
}

export function dfltDcx(payload) {
  const compressed = deflateSync(payload), bytes = Buffer.alloc(0x4c + compressed.length);
  bytes.write('DCX\0'); bytes.writeUInt32BE(0x10000, 4); bytes.writeUInt32BE(0x18, 8);
  bytes.writeUInt32BE(0x24, 12); bytes.writeUInt32BE(0x24, 16); bytes.writeUInt32BE(0x2c, 20);
  bytes.write('DCS\0', 0x18); bytes.writeUInt32BE(payload.length, 0x1c); bytes.writeUInt32BE(compressed.length, 0x20);
  bytes.write('DCP\0', 0x24); bytes.write('DFLT', 0x28); bytes.writeUInt32BE(0x20, 0x2c); bytes[0x30] = 9;
  bytes.writeUInt32BE(0x00010100, 0x40); bytes.write('DCA\0', 0x44); bytes.writeUInt32BE(8, 0x48);
  compressed.copy(bytes, 0x4c); return bytes;
}
