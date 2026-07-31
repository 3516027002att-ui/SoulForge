/**
 * DFLT-wrapped DCX decompression (shared by native EMEVD smokes and the
 * full-document reader). KRAK or unknown inner formats fail structurally:
 * they are not supported by the DFLT-only path.
 */

import { inflateSync } from 'node:zlib';

export function isDcxWrapper(source: Buffer): boolean {
  return source.length >= 4 && source.subarray(0, 4).toString('ascii') === 'DCX\0';
}

export function decompressDfltDcx(source: Buffer): Buffer {
  if (!isDcxWrapper(source)) throw new Error('not DCX');
  let dca = -1;
  for (let i = 0x30; i < 0x100 && i + 4 <= source.length; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  const compressed = source.subarray(payloadOff, payloadOff + compressedSize);
  return inflateSync(compressed);
}
