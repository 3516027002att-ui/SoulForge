/**
 * Backend open-format decoders for asset import conversion.
 * Minimal self-contained PNG (zlib IDAT) and uncompressed TGA → raw RGBA8.
 * No third-party image codec dependency. Does not claim full PNG/TGA coverage.
 */

import { inflateSync } from 'node:zlib';
import type { RawRgbaImage } from './pngToDds.js';

export type OpenFormatDecodeAuthority = 'decoded' | 'unsupported';
export type ImageDecodeFormat = 'png' | 'tga';

export interface OpenFormatDecodeResult {
  ok: boolean;
  authority: OpenFormatDecodeAuthority;
  image?: RawRgbaImage;
  code?: string;
  message?: string;
  notes: string[];
}

/** Dispatch helper for open-format texture conversion. */
export function decodeOpenFormatImage(format: ImageDecodeFormat, bytes: Buffer): OpenFormatDecodeResult {
  if (format === 'png') return decodePngToRgba(bytes);
  if (format === 'tga') return decodeTgaToRgba(bytes);
  return {
    ok: false,
    authority: 'unsupported',
    code: 'ASSET_IMPORT_FORMAT_UNSUPPORTED',
    message: `image decode format unsupported: ${String(format)}`,
    notes: []
  };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Decode a subset of PNG:
 * - color type 2 (RGB) or 6 (RGBA)
 * - 8-bit depth
 * - no interlace
 * - filter types 0–4
 * Does not support palette, 16-bit, adam7, or ancillary critical transforms.
 */
export function decodePngToRgba(bytes: Buffer): OpenFormatDecodeResult {
  const notes: string[] = ['png-decoder=subset-rgb-rgba-8bit-no-interlace'];
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIG)) {
    return fail('ASSET_IMPORT_PNG_MAGIC', 'PNG signature mismatch', notes);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idatParts: Buffer[] = [];
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length || length < 0) {
      return fail('ASSET_IMPORT_PNG_CHUNK_TRUNCATED', 'PNG chunk truncated', notes);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    // CRC skipped for candidate decoder — structural/IDAT integrity still enforced via inflate.
    offset = dataEnd + 4;

    if (type === 'IHDR') {
      if (length < 13) return fail('ASSET_IMPORT_PNG_IHDR', 'PNG IHDR too small', notes);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      const compression = data[10]!;
      const filter = data[11]!;
      interlace = data[12]!;
      sawIhdr = true;
      if (compression !== 0 || filter !== 0) {
        return fail('ASSET_IMPORT_PNG_UNSUPPORTED', 'PNG compression/filter method unsupported', notes);
      }
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        return fail(
          'ASSET_IMPORT_PNG_UNSUPPORTED',
          `PNG colorType=${colorType} bitDepth=${bitDepth} unsupported (need 8-bit RGB/RGBA)`,
          notes
        );
      }
      if (interlace !== 0) {
        return fail('ASSET_IMPORT_PNG_INTERLACE', 'PNG interlacing unsupported', notes);
      }
      if (width === 0 || height === 0 || width > 16384 || height > 16384) {
        return fail('ASSET_IMPORT_PNG_DIMENSION', 'PNG dimensions invalid', notes);
      }
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    } else if (type.length === 4 && (type.charCodeAt(0) & 0x20) === 0) {
      // Unknown critical chunk
      return fail('ASSET_IMPORT_PNG_CRITICAL_CHUNK', `unsupported critical PNG chunk ${type}`, notes);
    }
  }

  if (!sawIhdr) return fail('ASSET_IMPORT_PNG_IHDR_MISSING', 'PNG IHDR missing', notes);
  if (!sawIend) notes.push('png-iend-missing-tolerated');
  if (idatParts.length === 0) return fail('ASSET_IMPORT_PNG_IDAT_MISSING', 'PNG IDAT missing', notes);

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idatParts));
  } catch {
    return fail('ASSET_IMPORT_PNG_INFLATE', 'PNG IDAT inflate failed', notes);
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const expected = height * (1 + stride);
  if (inflated.length < expected) {
    return fail(
      'ASSET_IMPORT_PNG_FILTER_SIZE',
      `PNG filtered data too small: ${inflated.length} < ${expected}`,
      notes
    );
  }

  const rgba = Buffer.alloc(width * height * 4);
  const prior = Buffer.alloc(stride);
  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y++) {
    const filterType = inflated[src++]!;
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const raw = row[i]!;
      const a = i >= bytesPerPixel ? recon[i - bytesPerPixel]! : 0;
      const b = prior[i]!;
      const c = i >= bytesPerPixel ? prior[i - bytesPerPixel]! : 0;
      let value = raw;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = (raw + a) & 0xff;
          break;
        case 2:
          value = (raw + b) & 0xff;
          break;
        case 3:
          value = (raw + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          value = (raw + paeth(a, b, c)) & 0xff;
          break;
        default:
          return fail('ASSET_IMPORT_PNG_FILTER_TYPE', `PNG filter type ${filterType} unsupported`, notes);
      }
      recon[i] = value;
    }
    if (colorType === 6) {
      recon.copy(rgba, dst, 0, stride);
      dst += stride;
    } else {
      for (let x = 0; x < width; x++) {
        const si = x * 3;
        rgba[dst++] = recon[si]!;
        rgba[dst++] = recon[si + 1]!;
        rgba[dst++] = recon[si + 2]!;
        rgba[dst++] = 255;
      }
    }
    recon.copy(prior, 0, 0, stride);
  }

  notes.push(`png-decoded=${width}x${height}`, `png-colorType=${colorType}`);
  return {
    ok: true,
    authority: 'decoded',
    image: { width, height, rgba },
    notes
  };
}

/**
 * Decode uncompressed TGA (image type 2 truecolor / 3 greyscale), 8/16/24/32 bpp.
 * RLE and color-mapped types are honest-unsupported.
 */
export function decodeTgaToRgba(bytes: Buffer): OpenFormatDecodeResult {
  const notes: string[] = ['tga-decoder=uncompressed-truecolor-greyscale'];
  if (bytes.length < 18) {
    return fail('ASSET_IMPORT_TGA_TOO_SMALL', 'TGA header too small', notes);
  }
  const idLength = bytes[0]!;
  const colorMapType = bytes[1]!;
  const imageType = bytes[2]!;
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const bpp = bytes[16]!;
  const descriptor = bytes[17]!;
  if (colorMapType !== 0) {
    return fail('ASSET_IMPORT_TGA_COLORMAP', 'TGA color-mapped images unsupported', notes);
  }
  if (imageType !== 2 && imageType !== 3) {
    return fail(
      'ASSET_IMPORT_TGA_TYPE_UNSUPPORTED',
      `TGA image type ${imageType} unsupported (need 2/3 uncompressed)`,
      notes
    );
  }
  if (![8, 16, 24, 32].includes(bpp)) {
    return fail('ASSET_IMPORT_TGA_BPP_UNSUPPORTED', `TGA bpp ${bpp} unsupported`, notes);
  }
  if (width === 0 || height === 0 || width > 16384 || height > 16384) {
    return fail('ASSET_IMPORT_TGA_DIMENSION', 'TGA dimensions invalid', notes);
  }

  const bytesPerPixel = bpp / 8;
  const dataOffset = 18 + idLength;
  const needed = dataOffset + width * height * bytesPerPixel;
  if (bytes.length < needed) {
    return fail('ASSET_IMPORT_TGA_TRUNCATED', 'TGA pixel data truncated', notes);
  }

  const originTop = (descriptor & 0x20) !== 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = originTop ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const si = dataOffset + (srcY * width + x) * bytesPerPixel;
      const di = (y * width + x) * 4;
      if (bpp === 8) {
        const g = bytes[si]!;
        rgba[di] = g;
        rgba[di + 1] = g;
        rgba[di + 2] = g;
        rgba[di + 3] = 255;
      } else if (bpp === 16) {
        const px = bytes.readUInt16LE(si);
        // 5-5-5-1 BGRA
        const b = ((px >> 0) & 0x1f) * 255 / 31;
        const g = ((px >> 5) & 0x1f) * 255 / 31;
        const r = ((px >> 10) & 0x1f) * 255 / 31;
        const a = (px & 0x8000) !== 0 ? 255 : 0;
        rgba[di] = Math.round(r);
        rgba[di + 1] = Math.round(g);
        rgba[di + 2] = Math.round(b);
        rgba[di + 3] = a;
      } else if (bpp === 24) {
        rgba[di] = bytes[si + 2]!;
        rgba[di + 1] = bytes[si + 1]!;
        rgba[di + 2] = bytes[si]!;
        rgba[di + 3] = 255;
      } else {
        rgba[di] = bytes[si + 2]!;
        rgba[di + 1] = bytes[si + 1]!;
        rgba[di + 2] = bytes[si]!;
        rgba[di + 3] = bytes[si + 3]!;
      }
    }
  }

  notes.push(`tga-decoded=${width}x${height}`, `tga-bpp=${bpp}`, `tga-type=${imageType}`);
  return {
    ok: true,
    authority: 'decoded',
    image: { width, height, rgba },
    notes
  };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function fail(code: string, message: string, notes: string[]): OpenFormatDecodeResult {
  return {
    ok: false,
    authority: 'unsupported',
    code,
    message,
    notes
  };
}
