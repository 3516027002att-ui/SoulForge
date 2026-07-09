/**
 * DCX DFLT (zlib) decompress / recompress for SoulForge container workbench.
 *
 * Supported: DCX with compression kind DFLT (zlib).
 * Unsupported (honest): KRAK / EDGE / ZSTD / unknown variants.
 *
 * Not a claim of every FromSoftware DCX layout — only layouts whose payload
 * boundary matches the reviewed DCS/DCP/DCA probe used by the bridge.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type { CompressionKind, ContainerRoundTripReport } from './containerIr.js';

const DCX_MIN = 0x4c;

export interface DcxHeaderInfo {
  magic: string;
  headerVersion: number;
  compressionKind: CompressionKind;
  uncompressedSize: number;
  compressedSize: number;
  payloadOffset: number;
  dcsOffset: number;
  dcpOffset: number;
  dcaStart: number;
  dcaHeaderLength: number;
  compressionLevel: number;
  compressionSubFlag: number;
  /** Raw prefix bytes preserved for style-preserving recompress when possible. */
  headerPrefix: Buffer;
  boundaryConfirmed: boolean;
}

export interface DcxReadResult {
  ok: boolean;
  header?: DcxHeaderInfo;
  payload?: Buffer;
  payloadHash?: string;
  compressionKind: CompressionKind;
  decompressionStatus: 'supported' | 'unsupported' | 'failed' | 'none';
  diagnostics: StructuredDiagnostic[];
}

export interface DcxWriteResult {
  ok: boolean;
  bytes?: Buffer;
  hash?: string;
  payloadHash?: string;
  byteIdenticalToOriginal?: boolean;
  diagnostics: StructuredDiagnostic[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readU32Be(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return 0;
  return buf.readUInt32BE(offset);
}

function writeU32Be(buf: Buffer, offset: number, value: number): void {
  buf.writeUInt32BE(value >>> 0, offset);
}

function findAscii(buf: Buffer, ascii: string, start: number, end: number): number {
  const needle = Buffer.from(ascii, 'ascii');
  const limit = Math.min(buf.length - needle.length, end);
  for (let i = start; i <= limit; i += 1) {
    if (buf.subarray(i, i + needle.length).equals(needle)) return i;
  }
  return -1;
}

function startsWith(buf: Buffer, ascii: string, offset = 0): boolean {
  const needle = Buffer.from(ascii, 'ascii');
  if (offset + needle.length > buf.length) return false;
  return buf.subarray(offset, offset + needle.length).equals(needle);
}

function classifyCompression(raw: string): CompressionKind {
  if (raw === 'DFLT' || raw === 'KRAK' || raw === 'EDGE' || raw === 'ZSTD') return raw;
  return 'unknown';
}

/**
 * Parse DCX header and locate compressed payload boundary.
 */
export function parseDcxHeader(bytes: Buffer): {
  header?: DcxHeaderInfo;
  diagnostics: StructuredDiagnostic[];
} {
  const diagnostics: StructuredDiagnostic[] = [];
  if (!startsWith(bytes, 'DCX\0')) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'DCX_MAGIC_MISSING',
      message: 'Not a DCX file (missing DCX\\0 magic).'
    }));
    return { diagnostics };
  }
  if (bytes.length < DCX_MIN) {
    diagnostics.push(createDiagnostic({
      severity: 'error',
      code: 'DCX_HEADER_TRUNCATED',
      message: `DCX header requires at least ${DCX_MIN} bytes.`
    }));
    return { diagnostics };
  }

  const headerVersion = readU32Be(bytes, 0x04);
  const dcsOffset = readU32Be(bytes, 0x08);
  const dcpOffset = readU32Be(bytes, 0x0c);
  const uncompressedSize = readU32Be(bytes, 0x1c);
  const compressedSize = readU32Be(bytes, 0x20);
  const compressionRaw = bytes.subarray(0x28, 0x2c).toString('ascii');
  const compressionKind = classifyCompression(compressionRaw);
  const compressionLevel = bytes[0x30] ?? 0;
  const compressionSubFlag = bytes[0x38] ?? 0;
  const dcaStart = findAscii(bytes, 'DCA\0', 0x30, Math.min(bytes.length, 0x100));
  const dcaHeaderLength = dcaStart >= 0 ? readU32Be(bytes, dcaStart + 4) : 0;
  const payloadOffset = dcaStart >= 0 ? dcaStart + dcaHeaderLength : -1;
  const hasDcs = startsWith(bytes, 'DCS\0', 0x18);
  const hasDcp = startsWith(bytes, 'DCP\0', 0x24);
  const payloadEnd = payloadOffset >= 0 ? payloadOffset + compressedSize : -1;
  const rangeValid =
    payloadOffset >= 0
    && compressedSize > 0
    && payloadEnd <= bytes.length
    && hasDcs
    && hasDcp
    && dcaStart >= 0;

  if (!rangeValid) {
    diagnostics.push(createDiagnostic({
      severity: 'warning',
      code: 'DCX_PAYLOAD_BOUNDARY_UNCONFIRMED',
      message: 'Could not confirm a valid DCX payload boundary.',
      details: { payloadOffset, compressedSize, fileLength: bytes.length }
    }));
  } else {
    diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'DCX_PAYLOAD_BOUNDARY_CONFIRMED',
      message: `Confirmed DCX ${compressionKind} payload at offset ${payloadOffset}.`,
      details: { compressionKind, payloadOffset, compressedSize, uncompressedSize }
    }));
  }

  const header: DcxHeaderInfo = {
    magic: 'DCX\0',
    headerVersion,
    compressionKind,
    uncompressedSize,
    compressedSize,
    payloadOffset: payloadOffset >= 0 ? payloadOffset : 0,
    dcsOffset,
    dcpOffset,
    dcaStart: dcaStart >= 0 ? dcaStart : 0,
    dcaHeaderLength,
    compressionLevel,
    compressionSubFlag,
    headerPrefix: Buffer.from(bytes.subarray(0, Math.max(payloadOffset, 0x4c))),
    boundaryConfirmed: rangeValid
  };
  return { header, diagnostics };
}

/**
 * Full decompress of a DCX buffer. Only DFLT is supported.
 */
export function decompressDcx(bytes: Buffer): DcxReadResult {
  const { header, diagnostics } = parseDcxHeader(bytes);
  if (!header || !header.boundaryConfirmed) {
    return {
      ok: false,
      compressionKind: header?.compressionKind ?? 'unknown',
      decompressionStatus: 'failed',
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          severity: 'error',
          code: 'DCX_DECOMPRESS_BOUNDARY_FAILED',
          message: 'Cannot decompress DCX without a confirmed payload boundary.'
        })
      ]
    };
  }

  if (header.compressionKind !== 'DFLT') {
    return {
      ok: false,
      header,
      compressionKind: header.compressionKind,
      decompressionStatus: 'unsupported',
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          severity: 'error',
          code: 'DCX_COMPRESSION_UNSUPPORTED',
          message: `DCX compression ${header.compressionKind} is not supported for full decompress (only DFLT).`,
          details: { compressionKind: header.compressionKind }
        })
      ]
    };
  }

  const compressed = bytes.subarray(
    header.payloadOffset,
    header.payloadOffset + header.compressedSize
  );

  try {
    const payload = inflateSync(compressed);
    if (header.uncompressedSize > 0 && payload.length !== header.uncompressedSize) {
      diagnostics.push(createDiagnostic({
        severity: 'warning',
        code: 'DCX_SIZE_MISMATCH',
        message: `Decompressed size ${payload.length} != declared ${header.uncompressedSize}.`,
        details: { actual: payload.length, declared: header.uncompressedSize }
      }));
    }
    return {
      ok: true,
      header,
      payload,
      payloadHash: sha256(payload),
      compressionKind: 'DFLT',
      decompressionStatus: 'supported',
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          severity: 'info',
          code: 'DCX_DFLT_DECOMPRESSED',
          message: `Decompressed ${payload.length} byte(s) from DFLT/zlib DCX.`,
          details: { payloadHash: sha256(payload) }
        })
      ]
    };
  } catch (error) {
    return {
      ok: false,
      header,
      compressionKind: 'DFLT',
      decompressionStatus: 'failed',
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          severity: 'error',
          code: 'DCX_DFLT_DECOMPRESS_FAILED',
          message: error instanceof Error ? error.message : 'zlib inflate failed.'
        })
      ]
    };
  }
}

/**
 * Build a standard SoulForge DCX-DFLT container around a payload.
 * Layout matches the common DCS/DCP/DCA style used by the bridge probe.
 */
export function compressDcxDflt(
  payload: Buffer,
  options?: { compressionLevel?: number; originalHeader?: DcxHeaderInfo }
): DcxWriteResult {
  const diagnostics: StructuredDiagnostic[] = [];
  const level = options?.compressionLevel ?? options?.originalHeader?.compressionLevel ?? 9;
  // zlib default; compressionLevel 0-9 maps loosely — Node uses zlib constants.
  const compressed = deflateSync(payload, { level: Math.min(9, Math.max(0, level)) });

  // Fixed SoulForge / common ER-style DCX-DFLT header (0x4C before payload).
  const header = Buffer.alloc(0x4c);
  header.write('DCX\0', 0, 'ascii');
  writeU32Be(header, 0x04, 0x00010000);
  writeU32Be(header, 0x08, 0x18);
  writeU32Be(header, 0x0c, 0x24);
  writeU32Be(header, 0x10, 0x24);
  writeU32Be(header, 0x14, 0x44);
  header.write('DCS\0', 0x18, 'ascii');
  writeU32Be(header, 0x1c, payload.length);
  writeU32Be(header, 0x20, compressed.length);
  header.write('DCP\0', 0x24, 'ascii');
  header.write('DFLT', 0x28, 'ascii');
  writeU32Be(header, 0x2c, 0x20);
  header[0x30] = level;
  // reserved zeros already
  header.write('DCA\0', 0x44, 'ascii');
  writeU32Be(header, 0x48, 0x08);

  const bytes = Buffer.concat([header, compressed]);
  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'DCX_DFLT_COMPRESSED',
    message: `Compressed payload ${payload.length} -> DCX ${bytes.length} (zlib DFLT).`,
    details: {
      payloadLength: payload.length,
      compressedLength: compressed.length,
      containerLength: bytes.length
    }
  }));

  return {
    ok: true,
    bytes,
    hash: sha256(bytes),
    payloadHash: sha256(payload),
    diagnostics
  };
}

/**
 * Recompress using original header style when possible; falls back to standard DFLT.
 * Guarantees payload-equivalent roundtrip for DFLT.
 */
export function recompressDcx(
  payload: Buffer,
  original?: Buffer
): DcxWriteResult {
  let originalHeader: DcxHeaderInfo | undefined;
  if (original) {
    const parsed = parseDcxHeader(original);
    originalHeader = parsed.header;
  }

  const built = compressDcxDflt(payload, {
    ...(originalHeader ? { originalHeader } : {}),
    compressionLevel: originalHeader?.compressionLevel ?? 9
  });
  if (!built.ok || !built.bytes) return built;

  // Verify payload equivalence.
  const verify = decompressDcx(built.bytes);
  if (!verify.ok || !verify.payload) {
    return {
      ok: false,
      diagnostics: [
        ...built.diagnostics,
        createDiagnostic({
          severity: 'error',
          code: 'DCX_RECOMPRESS_VERIFY_FAILED',
          message: 'Recompressed DCX failed decompress verification.'
        })
      ]
    };
  }

  const payloadHash = sha256(payload);
  if (verify.payloadHash !== payloadHash) {
    return {
      ok: false,
      diagnostics: [
        ...built.diagnostics,
        createDiagnostic({
          severity: 'error',
          code: 'DCX_PAYLOAD_NOT_EQUIVALENT',
          message: 'Recompressed DCX payload hash does not match input payload.'
        })
      ]
    };
  }

  const byteIdentical = original ? built.bytes.equals(original) : false;
  if (original && !byteIdentical) {
    built.diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'DCX_NON_BYTE_IDENTICAL',
      message: 'Recompressed DCX is payload-equivalent but not byte-identical to original (zlib may differ).',
      details: {
        originalHash: sha256(original),
        rebuiltHash: built.hash,
        payloadHash
      }
    }));
  }

  return {
    ...built,
    byteIdenticalToOriginal: byteIdentical,
    payloadHash
  };
}

export function roundTripDcx(original: Buffer): ContainerRoundTripReport {
  const originalHash = sha256(original);
  const decomp = decompressDcx(original);
  if (!decomp.ok || !decomp.payload) {
    return {
      ok: false,
      byteIdentical: false,
      payloadEquivalent: false,
      originalHash,
      rebuiltHash: '',
      childHashMatches: false,
      diagnostics: decomp.diagnostics
    };
  }

  const re = recompressDcx(decomp.payload, original);
  if (!re.ok || !re.bytes) {
    const fail: ContainerRoundTripReport = {
      ok: false,
      byteIdentical: false,
      payloadEquivalent: false,
      originalHash,
      rebuiltHash: '',
      childHashMatches: false,
      diagnostics: [...decomp.diagnostics, ...re.diagnostics]
    };
    if (decomp.payloadHash !== undefined) fail.originalPayloadHash = decomp.payloadHash;
    return fail;
  }

  const verify = decompressDcx(re.bytes);
  const payloadEquivalent = verify.ok && verify.payloadHash === decomp.payloadHash;
  const report: ContainerRoundTripReport = {
    ok: payloadEquivalent === true,
    byteIdentical: re.byteIdenticalToOriginal === true,
    payloadEquivalent: payloadEquivalent === true,
    originalHash,
    rebuiltHash: re.hash ?? sha256(re.bytes),
    childHashMatches: true,
    diagnostics: [...decomp.diagnostics, ...re.diagnostics, ...verify.diagnostics],
    details: { compressionKind: 'DFLT' }
  };
  if (decomp.payloadHash !== undefined) report.originalPayloadHash = decomp.payloadHash;
  if (verify.payloadHash !== undefined) report.rebuiltPayloadHash = verify.payloadHash;
  return report;
}

/** Build a synthetic unsupported DCX-like buffer (KRAK marker) for negative tests. */
export function buildUnsupportedDcxStub(payloadHint = Buffer.from('krak-stub')): Buffer {
  const header = Buffer.alloc(0x4c);
  header.write('DCX\0', 0, 'ascii');
  writeU32Be(header, 0x04, 0x00010000);
  writeU32Be(header, 0x08, 0x18);
  writeU32Be(header, 0x0c, 0x24);
  writeU32Be(header, 0x10, 0x24);
  writeU32Be(header, 0x14, 0x44);
  header.write('DCS\0', 0x18, 'ascii');
  writeU32Be(header, 0x1c, payloadHint.length);
  writeU32Be(header, 0x20, payloadHint.length);
  header.write('DCP\0', 0x24, 'ascii');
  header.write('KRAK', 0x28, 'ascii');
  writeU32Be(header, 0x2c, 0x20);
  header.write('DCA\0', 0x44, 'ascii');
  writeU32Be(header, 0x48, 0x08);
  return Buffer.concat([header, payloadHint]);
}
