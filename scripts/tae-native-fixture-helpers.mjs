export function distinctTaeFixture() {
  let bytes = Buffer.alloc(1536);
  const i32 = (offset, value) => bytes.writeInt32LE(value, offset);
  const i64 = (offset, value) => bytes.writeBigInt64LE(BigInt(value), offset);
  bytes.write('TAE '); bytes[7] = 0xff;
  i32(8, 0x1000d); i64(0x20, 0x50); i64(0x30, 13);
  i32(0x54, 3); i64(0x58, 0x80); i64(0x70, 3); i64(0x78, 0xc0);
  const expected = [400000, 400010, 400020].map((animId, index) => {
    const entry = 0xc0 + index * 0x30;
    const eventTable = 0x200 + index * 0x18;
    const time = 0x300 + index * 8;
    const eventData = 0x400 + index * 0x30;
    const fileInfo = 0x500 + index * 0x30;
    const hkxName = `a000_${animId}.hkt`;
    i64(0x80 + index * 16, animId); i64(0x88 + index * 16, entry);
    i64(entry, eventTable); i64(entry + 8, eventData + 0x30);
    i64(entry + 16, time); i64(entry + 24, fileInfo);
    i32(entry + 32, 1); i64(entry + 40, 2);
    i64(eventTable, time); i64(eventTable + 8, time + 4); i64(eventTable + 16, eventData);
    bytes.writeFloatLE(index, time); bytes.writeFloatLE(index + 1, time + 4);
    i32(eventData, (index + 1) * 100); i64(eventData + 8, eventData + 16);
    i32(eventData + 16, 1000 + index);
    i64(fileInfo + 8, fileInfo + 16); i64(fileInfo + 16, bytes.length);
    bytes = Buffer.concat([bytes, Buffer.from(`${hkxName}\0`, 'utf16le')]);
    return { animId, hkxName, eventTypeId: (index + 1) * 100, startTime: index, endTime: index + 1, entry, time, eventData, field: eventData + 16 };
  });
  i64(0xb0, 22); // Table-adjacent bytes must never become the last animation ID.
  i32(12, bytes.length);
  return { bytes, expected };
}

export function manyEventsFixture(bytes, expected, count = 240) {
  const table = (bytes.length + 7) & ~7;
  const times = table + count * 24;
  const data = times + count * 8;
  const end = data + count * 24;
  const full = Buffer.alloc(end); bytes.copy(full);
  full.writeInt32LE(end, 12);
  full.writeBigInt64LE(BigInt(table), expected[0].entry);
  full.writeBigInt64LE(BigInt(end), expected[0].entry + 8);
  full.writeInt32LE(count, expected[0].entry + 32);
  for (let i = 0; i < count; i++) {
    const at = data + i * 24;
    full.writeBigInt64LE(BigInt(times + i * 8), table + i * 24);
    full.writeBigInt64LE(BigInt(times + i * 8 + 4), table + i * 24 + 8);
    full.writeBigInt64LE(BigInt(at), table + i * 24 + 16);
    full.writeFloatLE(i, times + i * 8); full.writeFloatLE(i + 1, times + i * 8 + 4);
    full.writeInt32LE(9999, at); full.writeBigInt64LE(BigInt(at + 16), at + 8);
    full.writeInt32LE(i, at + 16);
  }
  return full;
}

export function manyAnimationsFixture(count = 2219) {
  const fixture = distinctTaeFixture();
  const table = (fixture.bytes.length + 7) & ~7;
  const entries = table + count * 16;
  const full = Buffer.alloc(entries + count * 48); fixture.bytes.copy(full);
  full.writeInt32LE(full.length, 12);
  full.writeInt32LE(count, 0x54); full.writeBigInt64LE(BigInt(table), 0x58);
  full.writeBigInt64LE(BigInt(count), 0x70); full.writeBigInt64LE(BigInt(entries), 0x78);
  for (let index = 0; index < count; index++) {
    const entry = entries + index * 48;
    full.writeBigInt64LE(BigInt(index), table + index * 16);
    full.writeBigInt64LE(BigInt(entry), table + index * 16 + 8);
    fixture.bytes.copy(full, entry, fixture.expected[0].entry, fixture.expected[0].entry + 48);
  }
  // Every unique TAE action references the same independently known native
  // a000_400000.hkt; selecting action 2218 must return motion 400000.
  return full;
}

export function taeBinderFixture(children) {
  const names = children.map((_, index) => Buffer.from(`a${String(index).padStart(2, '0')}.tae\0`));
  const namesOffset = 0x40 + children.length * 0x24;
  const dataOffset = namesOffset + names.reduce((sum, bytes) => sum + bytes.length, 0);
  const full = Buffer.alloc(dataOffset + children.reduce((sum, bytes) => sum + bytes.length, 0));
  full.write('BND4'); full.writeInt32LE(children.length, 0x0c);
  full.writeBigInt64LE(0x40n, 0x10); full.writeBigInt64LE(0x24n, 0x20); full.writeBigInt64LE(BigInt(dataOffset), 0x28);
  let nameAt = namesOffset; let dataAt = dataOffset;
  children.forEach((bytes, index) => {
    const entry = 0x40 + index * 0x24;
    full.writeBigInt64LE(BigInt(bytes.length), entry + 8); full.writeBigInt64LE(BigInt(bytes.length), entry + 16);
    full.writeUInt32LE(dataAt, entry + 24); full.writeInt32LE(5000000 + index, entry + 28); full.writeUInt32LE(nameAt, entry + 32);
    names[index].copy(full, nameAt); bytes.copy(full, dataAt); nameAt += names[index].length; dataAt += bytes.length;
  });
  return full;
}
