// @ts-check
/** Owned, explicitly constructed native inputs; no game bytes or fixture IPC. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const SCRIPT_TEXT = '-- SoulForge constructed editor comparison input\nreturn 1\n';
export const OTHER_SCRIPT_TEXT = '-- SoulForge constructed second entry\nreturn 2\n';
export const LONG_SCRIPT_TEXT = Array.from({ length: 160 }, (_, index) => `-- loaded line ${index + 1}`).join('\n');

// Same 0x40/0x24 native layout as LuabndExportBoundaryTests.cs.
function nativeBinder(entries) {
  const names = entries.map(({ name }) => Buffer.from(`${name}\0`, 'utf8'));
  let nameOffset = 0x40 + entries.length * 0x24;
  let dataOffset = nameOffset + names.reduce((sum, name) => sum + name.length, 0);
  const bytes = Buffer.alloc(dataOffset + entries.reduce((sum, entry) => sum + entry.bytes.length, 0));
  bytes.write('BND4');
  bytes.writeInt32LE(entries.length, 0x0c);
  bytes.writeBigInt64LE(0x40n, 0x10);
  bytes.writeBigInt64LE(0x24n, 0x20);
  bytes.writeBigInt64LE(BigInt(dataOffset), 0x28);
  for (let index = 0; index < entries.length; index += 1) {
    const offset = 0x40 + index * 0x24;
    const payload = entries[index].bytes;
    bytes.writeInt32LE(0x40, offset);
    bytes.writeInt32LE(-1, offset + 4);
    bytes.writeBigInt64LE(BigInt(payload.length), offset + 8);
    bytes.writeBigInt64LE(BigInt(payload.length), offset + 0x10);
    bytes.writeUInt32LE(dataOffset, offset + 0x18);
    bytes.writeInt32LE(index, offset + 0x1c);
    bytes.writeUInt32LE(nameOffset, offset + 0x20);
    names[index].copy(bytes, nameOffset);
    payload.copy(bytes, dataOffset);
    nameOffset += names[index].length;
    dataOffset += payload.length;
  }
  return bytes;
}

// Same DFLT envelope as verify-bridge-write-boundary-gate.mjs; no Oodle.
function dflt(bytes) {
  const compressed = deflateSync(bytes);
  const dcx = Buffer.alloc(0x4c + compressed.length);
  dcx.write('DCX\0');
  for (const [offset, value] of [[4, 0x10000], [8, 0x18], [0x0c, 0x24], [0x10, 0x24], [0x14, 0x2c],
    [0x1c, bytes.length], [0x20, compressed.length], [0x2c, 0x20], [0x40, 0x10100], [0x48, 8]]) {
    dcx.writeInt32BE(value, offset);
  }
  dcx.write('DCS\0', 0x18);
  dcx.write('DCP\0', 0x24);
  dcx.write('DFLT', 0x28);
  dcx[0x30] = 9;
  dcx.write('DCA\0', 0x44);
  compressed.copy(dcx, 0x4c);
  return dcx;
}

// Existing verify-synthetic-core-fixtures compact layout, using the real
// first-party ACTION_GUIDE_PARAM_ST version 1 / 16-byte row contract.
function actionGuideParam() {
  const dataStart = 0x40 + 2 * 0x18;
  const typeOffset = dataStart + 2 * 16;
  const type = Buffer.from('ACTION_GUIDE_PARAM_ST\0', 'ascii');
  const bytes = Buffer.alloc(typeOffset + type.length);
  bytes.writeInt32LE((typeOffset + 15) & ~15, 0);
  bytes.writeUInt16LE(1, 8);
  bytes.writeUInt16LE(2, 10);
  bytes.writeBigInt64LE(BigInt(typeOffset), 0x10);
  bytes[0x2d] = 0x85;
  bytes[0x2e] = 0x07;
  for (let index = 0; index < 2; index += 1) {
    const offset = 0x40 + index * 0x18;
    bytes.writeInt32LE(100 + index, offset);
    bytes.writeBigInt64LE(BigInt(dataStart + index * 16), offset + 8);
    bytes.writeInt32LE(1000 + index, dataStart + index * 16);
    bytes.writeInt8(1 + index, dataStart + index * 16 + 4);
    // Unknown/padding bytes must survive the real field write unchanged.
    bytes.fill(0x5a + index, dataStart + index * 16 + 5, dataStart + (index + 1) * 16);
  }
  type.copy(bytes, typeOffset);
  return bytes;
}

export async function prepareEditorComparisonWorkspace(ownedRoot) {
  const overlay = join(ownedRoot, 'editor-comparison-overlay');
  const base = join(ownedRoot, 'editor-comparison-base');
  await Promise.all([mkdir(join(overlay, 'script'), { recursive: true }),
    mkdir(join(overlay, 'param', 'gameparam'), { recursive: true }), mkdir(base, { recursive: true })]);
  const scriptPath = 'script/comparison.luabnd.dcx';
  const paramPath = 'param/gameparam/gameparam.parambnd.dcx';
  await Promise.all([
    writeFile(join(overlay, scriptPath), dflt(nativeBinder([
      { name: 'baseline.lua', bytes: Buffer.from(SCRIPT_TEXT) },
      { name: 'other.lua', bytes: Buffer.from(OTHER_SCRIPT_TEXT) },
      { name: 'long.lua', bytes: Buffer.from(LONG_SCRIPT_TEXT) }
    ]))),
    writeFile(join(overlay, paramPath), dflt(nativeBinder([{ name: 'ActionGuideParam.param', bytes: actionGuideParam() }])))
  ]);
  return { overlay, base, scriptPath, paramPath };
}
