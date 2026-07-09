/**
 * SoulForge synthetic BND3/BND4 (SFBN marker) — full list/read/replace/repack.
 *
 * Layout (documented in docs/V0_3_SYNTHETIC_BND_FIXTURE.md):
 *   0x00 magic BND3|BND4
 *   0x04 marker SFBN
 *   0x08 version=1
 *   0x0C child count
 *   0x10 child table start
 *   0x14 string pool start
 *   rows: id, nameRel, dataOffset, packedSize, unpackedSize (32 bytes)
 *
 * This is NOT native FromSoftware BND authority. It is fixture-confirmed
 * authoritative for SoulForge-owned synthetic binders only.
 */

import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';
import type {
  ContainerChild,
  ContainerFormat,
  ContainerRoundTripReport
} from './containerIr.js';

const MARKER = Buffer.from('SFBN', 'ascii');
const ROW_STRIDE = 32;
const MAX_CHILDREN = 300;

export interface SyntheticBndChild {
  id: number;
  name: string;
  offset: number;
  packedSize: number;
  unpackedSize: number;
  bytes: Buffer;
  hash: string;
}

export interface SyntheticBndReadResult {
  ok: boolean;
  format: ContainerFormat;
  version: number;
  children: SyntheticBndChild[];
  childTableStart: number;
  stringPoolStart: number;
  authority: 'fixture-confirmed' | 'none';
  diagnostics: StructuredDiagnostic[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readI32(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return -1;
  return buf.readInt32LE(offset);
}

function readI64(buf: Buffer, offset: number): number {
  if (offset + 8 > buf.length) return -1;
  // Synthetic fixtures use sizes that fit JS safe integer range.
  return Number(buf.readBigInt64LE(offset));
}

function writeI32(buf: Buffer, offset: number, value: number): void {
  buf.writeInt32LE(value, offset);
}

function writeI64(buf: Buffer, offset: number, value: number): void {
  buf.writeBigInt64LE(BigInt(value), offset);
}

function readUtf16Le(buf: Buffer, offset: number): string | null {
  if (offset < 0 || offset >= buf.length) return null;
  const parts: number[] = [];
  for (let i = offset; i + 1 < buf.length && parts.length < 1024; i += 2) {
    const code = buf.readUInt16LE(i);
    if (code === 0) break;
    parts.push(code);
  }
  if (parts.length === 0) return null;
  return Buffer.from(Uint16Array.from(parts).buffer).toString('utf16le');
}

function encodeUtf16Le(text: string): Buffer {
  const out = Buffer.alloc((text.length + 1) * 2);
  for (let i = 0; i < text.length; i += 1) {
    out.writeUInt16LE(text.charCodeAt(i), i * 2);
  }
  out.writeUInt16LE(0, text.length * 2);
  return out;
}

function detectFormat(bytes: Buffer): ContainerFormat | null {
  if (bytes.length < 8) return null;
  const magic = bytes.subarray(0, 4).toString('ascii');
  if (magic === 'BND4') return 'bnd4';
  if (magic === 'BND3') return 'bnd3';
  return null;
}

export function isSyntheticBnd(bytes: Buffer): boolean {
  const format = detectFormat(bytes);
  if (!format) return false;
  return bytes.subarray(4, 8).equals(MARKER);
}

/**
 * Parse synthetic SFBN binder. Returns ok=false for non-synthetic or corrupt.
 */
export function readSyntheticBnd(bytes: Buffer): SyntheticBndReadResult {
  const diagnostics: StructuredDiagnostic[] = [];
  const format = detectFormat(bytes);
  if (!format) {
    return {
      ok: false,
      format: 'unknown',
      version: 0,
      children: [],
      childTableStart: 0,
      stringPoolStart: 0,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_MAGIC_MISSING',
        message: 'Not a BND3/BND4 file.'
      })]
    };
  }

  if (!bytes.subarray(4, 8).equals(MARKER)) {
    return {
      ok: false,
      format,
      version: 0,
      children: [],
      childTableStart: 0,
      stringPoolStart: 0,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'warning',
        code: 'BND_NATIVE_NOT_AUTHORITATIVE',
        message: 'Native BND3/BND4 without SFBN marker is not authoritative for child replace in v0.6. Use raw-level only.',
        details: { format, nativeFormatAuthority: false }
      })]
    };
  }

  const version = readI32(bytes, 8);
  const childCount = readI32(bytes, 12);
  const childTableStart = readI32(bytes, 16);
  const stringPoolStart = readI32(bytes, 20);

  if (version !== 1) {
    return {
      ok: false,
      format,
      version,
      children: [],
      childTableStart,
      stringPoolStart,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_SYNTHETIC_VERSION_UNSUPPORTED',
        message: `Synthetic BND version ${version} is not supported (expected 1).`
      })]
    };
  }
  if (childCount < 0 || childCount > MAX_CHILDREN) {
    return {
      ok: false,
      format,
      version,
      children: [],
      childTableStart,
      stringPoolStart,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_CHILD_COUNT_INVALID',
        message: `Invalid child count ${childCount}.`
      })]
    };
  }
  if (childTableStart < 0 || childTableStart + childCount * ROW_STRIDE > bytes.length) {
    return {
      ok: false,
      format,
      version,
      children: [],
      childTableStart,
      stringPoolStart,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_TABLE_OOB',
        message: 'Child table is out of bounds.'
      })]
    };
  }
  if (stringPoolStart <= 0 || stringPoolStart >= bytes.length) {
    return {
      ok: false,
      format,
      version,
      children: [],
      childTableStart,
      stringPoolStart,
      authority: 'none',
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_STRING_POOL_OOB',
        message: 'String pool start is out of bounds.'
      })]
    };
  }

  const children: SyntheticBndChild[] = [];
  for (let index = 0; index < childCount; index += 1) {
    const row = childTableStart + index * ROW_STRIDE;
    const id = readI32(bytes, row);
    const nameRel = readI32(bytes, row + 4);
    const dataOffset = readI64(bytes, row + 8);
    const packedSize = readI64(bytes, row + 16);
    const unpackedSize = readI64(bytes, row + 24);
    const nameOffset = stringPoolStart + nameRel;

    if (id < 0 || dataOffset < 0 || packedSize < 0 || unpackedSize < 0) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'BND_CHILD_ROW_INVALID',
        message: `Child row ${index} has invalid fields.`,
        details: { id, dataOffset, packedSize, unpackedSize }
      }));
      return {
        ok: false,
        format,
        version,
        children: [],
        childTableStart,
        stringPoolStart,
        authority: 'none',
        diagnostics
      };
    }
    if (dataOffset + packedSize > bytes.length) {
      diagnostics.push(createDiagnostic({
        severity: 'error',
        code: 'BND_CHILD_DATA_OOB',
        message: `Child ${id} data range is out of bounds.`,
        details: { dataOffset, packedSize, fileLength: bytes.length }
      }));
      return {
        ok: false,
        format,
        version,
        children: [],
        childTableStart,
        stringPoolStart,
        authority: 'none',
        diagnostics
      };
    }

    const name = readUtf16Le(bytes, nameOffset) ?? `child_${id}`;
    const childBytes = Buffer.from(bytes.subarray(dataOffset, dataOffset + packedSize));
    children.push({
      id,
      name,
      offset: dataOffset,
      packedSize,
      unpackedSize,
      bytes: childBytes,
      hash: sha256(childBytes)
    });
  }

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'BND_SYNTHETIC_FIXTURE_CONFIRMED',
    message: `Parsed synthetic ${format.toUpperCase()} with ${children.length} child(ren). Fixture-confirmed, not native game BND authority.`,
    details: {
      format,
      childCount: children.length,
      authority: 'fixture-confirmed',
      nativeFormatAuthority: false
    }
  }));

  return {
    ok: true,
    format,
    version,
    children,
    childTableStart,
    stringPoolStart,
    authority: 'fixture-confirmed',
    diagnostics
  };
}

export interface BuildSyntheticBndInput {
  format?: 'bnd3' | 'bnd4';
  children: Array<{ id: number; name: string; bytes: Buffer }>;
}

/**
 * Build a synthetic SFBN binder. Unmodified child bytes are byte-preserving.
 */
export function buildSyntheticBnd(input: BuildSyntheticBndInput): {
  ok: boolean;
  bytes?: Buffer;
  hash?: string;
  children: SyntheticBndChild[];
  diagnostics: StructuredDiagnostic[];
} {
  const format = input.format ?? 'bnd4';
  const diagnostics: StructuredDiagnostic[] = [];
  if (input.children.length > MAX_CHILDREN) {
    return {
      ok: false,
      children: [],
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_CHILD_COUNT_INVALID',
        message: `Too many children (${input.children.length}).`
      })]
    };
  }

  const headerSize = 24;
  const tableStart = headerSize;
  const tableSize = input.children.length * ROW_STRIDE;

  // String pool
  const nameBuffers = input.children.map((c) => encodeUtf16Le(c.name));
  let stringPoolSize = 0;
  const nameRelOffsets: number[] = [];
  for (const nb of nameBuffers) {
    nameRelOffsets.push(stringPoolSize);
    stringPoolSize += nb.length;
  }
  const stringPoolStart = tableStart + tableSize;

  // Align data to 16 bytes after string pool
  let dataCursor = stringPoolStart + stringPoolSize;
  const align = 16;
  const pad = (align - (dataCursor % align)) % align;
  dataCursor += pad;

  const dataParts: Buffer[] = [];
  const builtChildren: SyntheticBndChild[] = [];
  const dataOffsets: number[] = [];

  for (let i = 0; i < input.children.length; i += 1) {
    const child = input.children[i]!;
    dataOffsets.push(dataCursor);
    dataParts.push(child.bytes);
    builtChildren.push({
      id: child.id,
      name: child.name,
      offset: dataCursor,
      packedSize: child.bytes.length,
      unpackedSize: child.bytes.length,
      bytes: child.bytes,
      hash: sha256(child.bytes)
    });
    dataCursor += child.bytes.length;
    // 4-byte pad between children for stability
    const childPad = (4 - (dataCursor % 4)) % 4;
    if (childPad > 0 && i < input.children.length - 1) {
      dataParts.push(Buffer.alloc(childPad));
      dataCursor += childPad;
    }
  }

  const totalSize = dataCursor;
  const out = Buffer.alloc(totalSize);
  out.write(format === 'bnd3' ? 'BND3' : 'BND4', 0, 'ascii');
  MARKER.copy(out, 4);
  writeI32(out, 8, 1);
  writeI32(out, 12, input.children.length);
  writeI32(out, 16, tableStart);
  writeI32(out, 20, stringPoolStart);

  for (let i = 0; i < input.children.length; i += 1) {
    const row = tableStart + i * ROW_STRIDE;
    const child = builtChildren[i]!;
    writeI32(out, row, child.id);
    writeI32(out, row + 4, nameRelOffsets[i]!);
    writeI64(out, row + 8, child.offset);
    writeI64(out, row + 16, child.packedSize);
    writeI64(out, row + 24, child.unpackedSize);
  }

  let sp = stringPoolStart;
  for (const nb of nameBuffers) {
    nb.copy(out, sp);
    sp += nb.length;
  }
  // pad zeros already from alloc
  for (let i = 0; i < dataParts.length; i += 1) {
    // Place each part: for child data use dataOffsets; pads are sequential after each child.
  }
  // Write children and inter-child pads sequentially from first data offset
  let writeAt = builtChildren[0]?.offset ?? stringPoolStart + stringPoolSize + pad;
  // Simpler: rebuild data region from built plan
  for (let i = 0; i < input.children.length; i += 1) {
    const child = builtChildren[i]!;
    child.bytes.copy(out, child.offset);
  }

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'BND_SYNTHETIC_BUILT',
    message: `Built synthetic ${format.toUpperCase()} with ${builtChildren.length} child(ren).`,
    details: { format, size: out.length, nativeFormatAuthority: false }
  }));

  return {
    ok: true,
    bytes: out,
    hash: sha256(out),
    children: builtChildren,
    diagnostics
  };
}

export function replaceSyntheticBndChild(
  original: Buffer,
  childSelector: string | number,
  newBytes: Buffer
): {
  ok: boolean;
  bytes?: Buffer;
  hash?: string;
  previousChildHash?: string;
  newChildHash?: string;
  diagnostics: StructuredDiagnostic[];
} {
  const read = readSyntheticBnd(original);
  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics };
  }

  const target = read.children.find((c) =>
    c.id === Number(childSelector)
    || c.name === String(childSelector)
    || String(c.id) === String(childSelector)
  );
  if (!target) {
    return {
      ok: false,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'BND_CHILD_NOT_FOUND',
        message: `Child not found: ${childSelector}`,
        details: { available: read.children.map((c) => ({ id: c.id, name: c.name })) }
      })]
    };
  }

  const nextChildren = read.children.map((c) => ({
    id: c.id,
    name: c.name,
    bytes: c.id === target.id ? newBytes : c.bytes
  }));

  const built = buildSyntheticBnd({
    format: read.format === 'bnd3' ? 'bnd3' : 'bnd4',
    children: nextChildren
  });
  if (!built.ok || !built.bytes) {
    return { ok: false, diagnostics: [...read.diagnostics, ...built.diagnostics] };
  }

  const result: {
    ok: boolean;
    bytes?: Buffer;
    hash?: string;
    previousChildHash?: string;
    newChildHash?: string;
    diagnostics: StructuredDiagnostic[];
  } = {
    ok: true,
    bytes: built.bytes,
    previousChildHash: target.hash,
    newChildHash: sha256(newBytes),
    diagnostics: [
      ...read.diagnostics,
      ...built.diagnostics,
      createDiagnostic({
        severity: 'info',
        code: 'BND_CHILD_REPLACED',
        message: `Replaced child ${target.name} (${target.id}).`,
        details: {
          previousChildHash: target.hash,
          newChildHash: sha256(newBytes)
        }
      })
    ]
  };
  if (built.hash !== undefined) result.hash = built.hash;
  return result;
}

export function roundTripSyntheticBnd(original: Buffer): ContainerRoundTripReport {
  const originalHash = sha256(original);
  const read = readSyntheticBnd(original);
  if (!read.ok) {
    return {
      ok: false,
      byteIdentical: false,
      payloadEquivalent: false,
      originalHash,
      rebuiltHash: '',
      childHashMatches: false,
      diagnostics: read.diagnostics
    };
  }

  const built = buildSyntheticBnd({
    format: read.format === 'bnd3' ? 'bnd3' : 'bnd4',
    children: read.children.map((c) => ({ id: c.id, name: c.name, bytes: c.bytes }))
  });
  if (!built.ok || !built.bytes) {
    return {
      ok: false,
      byteIdentical: false,
      payloadEquivalent: false,
      originalHash,
      rebuiltHash: '',
      childHashMatches: false,
      diagnostics: [...read.diagnostics, ...built.diagnostics]
    };
  }

  const reread = readSyntheticBnd(built.bytes);
  const childHashMatches =
    reread.ok
    && reread.children.length === read.children.length
    && reread.children.every((c, i) => c.hash === read.children[i]!.hash && c.name === read.children[i]!.name);

  const byteIdentical = built.bytes.equals(original);
  if (!byteIdentical) {
    built.diagnostics.push(createDiagnostic({
      severity: 'info',
      code: 'BND_NON_BYTE_IDENTICAL',
      message: 'Repack is not byte-identical to original but child list/hashes are preserved.',
      details: { originalHash, rebuiltHash: built.hash }
    }));
  }

  return {
    ok: childHashMatches,
    byteIdentical,
    payloadEquivalent: childHashMatches,
    originalHash,
    rebuiltHash: built.hash ?? sha256(built.bytes),
    childHashMatches,
    diagnostics: [...read.diagnostics, ...built.diagnostics, ...reread.diagnostics]
  };
}

export function toContainerChildren(
  sourceContainerUri: string,
  read: SyntheticBndReadResult,
  pathPrefix: string
): ContainerChild[] {
  if (!read.ok) return [];
  return read.children.map((c) => {
    const childUri = `${sourceContainerUri}#${pathPrefix}/child/${encodeURIComponent(c.name)}`;
    const nestedFormat = detectNestedFormat(c.bytes);
    const child: ContainerChild = {
      childId: String(c.id),
      name: c.name,
      pathHint: c.name,
      offset: c.offset,
      size: c.packedSize,
      compressedSize: c.packedSize,
      hash: c.hash,
      formatKind: guessFormatKind(c.name),
      sourceContainerUri,
      childUri,
      rawBytesAvailable: true,
      canReplace: true,
      diagnostics: []
    };
    if (nestedFormat !== undefined) child.nestedFormat = nestedFormat;
    return child;
  });
}

function guessFormatKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.fmg')) return 'fmg';
  if (lower.endsWith('.param')) return 'param';
  if (lower.endsWith('.emevd') || lower.endsWith('.emevd.dcx')) return 'emevd';
  if (lower.endsWith('.msb') || lower.endsWith('.msb.dcx')) return 'msb';
  if (lower.includes('.dcx')) return 'dcx';
  if (lower.includes('.bnd')) return 'bnd';
  return 'unknown';
}

function detectNestedFormat(bytes: Buffer): ContainerFormat | undefined {
  if (bytes.length >= 4) {
    const magic = bytes.subarray(0, 4).toString('ascii');
    if (magic === 'DCX\0' || magic.startsWith('DCX')) return 'dcx';
    if (magic === 'BND4') return 'bnd4';
    if (magic === 'BND3') return 'bnd3';
  }
  return undefined;
}
