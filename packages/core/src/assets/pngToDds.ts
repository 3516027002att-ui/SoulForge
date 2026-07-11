/**
 * Minimal uncompressed 32-bit BGRA DDS encoder for staged PNG-like RGBA payloads.
 * Accepts raw RGBA8 frames (width*height*4). Not a full PNG decoder —
 * callers that only have PNG bytes must decode first or supply raw RGBA.
 *
 * For smoke/real path without image codec deps: encodeRawRgba8ToDds.
 */

import { createHash } from 'node:crypto';

export interface RawRgbaImage {
  width: number;
  height: number;
  /** length === width * height * 4, row-major RGBA */
  rgba: Buffer;
}

export interface DdsEncodeResult {
  dds: Buffer;
  contentHash: string;
  width: number;
  height: number;
  format: 'A8R8G8B8';
}

const DDS_MAGIC = Buffer.from('DDS ', 'ascii');
const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_LINEARSIZE = 0x80000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_RGB = 0x40;
const DDSCAPS_TEXTURE = 0x1000;

/**
 * Encode raw RGBA8 into an uncompressed DDS (A8R8G8B8 / BGRA in file).
 * This is a real, shipped encoder used by the asset conversion path.
 */
export function encodeRawRgba8ToDds(image: RawRgbaImage): DdsEncodeResult {
  if (image.width <= 0 || image.height <= 0 || image.width > 8192 || image.height > 8192) {
    throw new Error('DDS_DIMENSIONS_INVALID');
  }
  const expected = image.width * image.height * 4;
  if (image.rgba.length !== expected) {
    throw new Error(`DDS_RGBA_SIZE_MISMATCH: expected ${expected}, got ${image.rgba.length}`);
  }

  const pitch = image.width * 4;
  const pixelBytes = Buffer.alloc(expected);
  // RGBA -> BGRA
  for (let i = 0; i < expected; i += 4) {
    pixelBytes[i] = image.rgba[i + 2]!;     // B
    pixelBytes[i + 1] = image.rgba[i + 1]!; // G
    pixelBytes[i + 2] = image.rgba[i]!;     // R
    pixelBytes[i + 3] = image.rgba[i + 3]!; // A
  }

  const header = Buffer.alloc(128);
  DDS_MAGIC.copy(header, 0);
  header.writeUInt32LE(124, 4); // dwSize
  header.writeUInt32LE(
    DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT,
    8
  );
  header.writeUInt32LE(image.height, 12);
  header.writeUInt32LE(image.width, 16);
  header.writeUInt32LE(pitch, 20);
  header.writeUInt32LE(0, 24); // depth
  header.writeUInt32LE(0, 28); // mipmaps
  // reserved1[11] already zero
  // pixel format at offset 76
  header.writeUInt32LE(32, 76); // pfSize
  header.writeUInt32LE(DDPF_RGB | DDPF_ALPHAPIXELS, 80);
  header.writeUInt32LE(0, 84); // fourCC
  header.writeUInt32LE(32, 88); // rgbBitCount
  header.writeUInt32LE(0x00ff0000, 92); // R mask
  header.writeUInt32LE(0x0000ff00, 96); // G
  header.writeUInt32LE(0x000000ff, 100); // B
  header.writeUInt32LE(0xff000000, 104); // A
  header.writeUInt32LE(DDSCAPS_TEXTURE, 108);
  // caps2/3/4/reserved2 zero

  // Also set LINEARSIZE alternative not required when PITCH set.
  void DDSD_LINEARSIZE;

  const dds = Buffer.concat([header, pixelBytes]);
  return {
    dds,
    contentHash: createHash('sha256').update(dds).digest('hex'),
    width: image.width,
    height: image.height,
    format: 'A8R8G8B8'
  };
}

/**
 * Create a 1x1 or NxN solid-color test image and encode DDS.
 * Used by conversion smoke when no image decoder is available.
 */
export function encodeSolidRgbaDds(input: {
  width: number;
  height: number;
  r: number;
  g: number;
  b: number;
  a?: number;
}): DdsEncodeResult {
  const rgba = Buffer.alloc(input.width * input.height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = input.r;
    rgba[i + 1] = input.g;
    rgba[i + 2] = input.b;
    rgba[i + 3] = input.a ?? 255;
  }
  return encodeRawRgba8ToDds({ width: input.width, height: input.height, rgba });
}

export function isDdsBuffer(bytes: Buffer): boolean {
  return bytes.length >= 128 && bytes.subarray(0, 4).toString('ascii') === 'DDS ';
}
