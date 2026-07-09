/**
 * SoulForge synthetic FMG (SFFX marker) — parse / update entry / rebuild.
 * Fixture-confirmed authoritative for owned fixtures only; not native FMG authority.
 *
 * Layout: docs/V0_3_FMG_SYNTHETIC_FIXTURE.md
 */

import { createHash } from 'node:crypto';
import type { StructuredDiagnostic } from '@soulforge/shared';
import { createDiagnostic } from '@soulforge/shared';

const MARKER = Buffer.from('SFFX', 'ascii');
const STRIDE = 8;
const MAX_ENTRIES = 2000;

export interface FmgEntry {
  textId: number;
  text: string;
  tableOffset: number;
  textOffset: number;
}

export interface FmgParseResult {
  ok: boolean;
  authority: 'fixture-confirmed' | 'none' | 'candidate';
  version: number;
  entries: FmgEntry[];
  tableStart: number;
  stringPoolStart: number;
  diagnostics: StructuredDiagnostic[];
  nativeFormatAuthority: false;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readI32(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) return -1;
  return buf.readInt32LE(offset);
}

function writeI32(buf: Buffer, offset: number, value: number): void {
  buf.writeInt32LE(value, offset);
}

function readUtf16Le(buf: Buffer, offset: number): string | null {
  if (offset < 0 || offset + 2 > buf.length) return null;
  const parts: number[] = [];
  for (let i = offset; i + 1 < buf.length && parts.length < 8192; i += 2) {
    const code = buf.readUInt16LE(i);
    if (code === 0) break;
    parts.push(code);
  }
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

export function isSyntheticFmg(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes.subarray(0, 4).equals(Buffer.from('FMG\0', 'ascii'))
    && bytes.subarray(4, 8).equals(MARKER);
}

export function parseSyntheticFmg(bytes: Buffer): FmgParseResult {
  const diagnostics: StructuredDiagnostic[] = [];
  if (!bytes.subarray(0, 4).equals(Buffer.from('FMG\0', 'ascii'))) {
    return {
      ok: false,
      authority: 'none',
      version: 0,
      entries: [],
      tableStart: 0,
      stringPoolStart: 0,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FMG_MAGIC_MISSING',
        message: 'Not an FMG file.'
      })],
      nativeFormatAuthority: false
    };
  }

  if (!bytes.subarray(4, 8).equals(MARKER)) {
    return {
      ok: false,
      authority: 'candidate',
      version: 0,
      entries: [],
      tableStart: 0,
      stringPoolStart: 0,
      diagnostics: [createDiagnostic({
        severity: 'warning',
        code: 'FMG_NATIVE_CANDIDATE_ONLY',
        message: 'Native FMG without SFFX marker is not fixture-confirmed. Semantic writer blocked.',
        details: { nativeFormatAuthority: false }
      })],
      nativeFormatAuthority: false
    };
  }

  const version = readI32(bytes, 8);
  const count = readI32(bytes, 12);
  const tableStart = readI32(bytes, 16);
  const stringPoolStart = readI32(bytes, 20);

  if (version !== 1 || count < 0 || count > MAX_ENTRIES) {
    return {
      ok: false,
      authority: 'none',
      version,
      entries: [],
      tableStart,
      stringPoolStart,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FMG_HEADER_INVALID',
        message: 'Synthetic FMG header invalid.'
      })],
      nativeFormatAuthority: false
    };
  }
  if (tableStart + count * STRIDE > bytes.length || stringPoolStart <= tableStart) {
    return {
      ok: false,
      authority: 'none',
      version,
      entries: [],
      tableStart,
      stringPoolStart,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FMG_TABLE_OOB',
        message: 'FMG table or string pool out of bounds.'
      })],
      nativeFormatAuthority: false
    };
  }

  const entries: FmgEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = tableStart + i * STRIDE;
    const textId = readI32(bytes, row);
    const rel = readI32(bytes, row + 4);
    const textOffset = stringPoolStart + rel;
    const text = readUtf16Le(bytes, textOffset);
    if (textId < 0 || text === null) {
      return {
        ok: false,
        authority: 'none',
        version,
        entries: [],
        tableStart,
        stringPoolStart,
        diagnostics: [createDiagnostic({
          severity: 'error',
          code: 'FMG_ENTRY_INVALID',
          message: `Invalid FMG entry at index ${i}.`
        })],
        nativeFormatAuthority: false
      };
    }
    entries.push({ textId, text, tableOffset: row, textOffset });
  }

  diagnostics.push(createDiagnostic({
    severity: 'info',
    code: 'MSG_FMG_SYNTHETIC_FIXTURE_CONFIRMED',
    message: `Parsed synthetic FMG with ${entries.length} entries (fixture-confirmed).`,
    details: {
      parser: 'soulforge-synthetic-fmg-fixture-v1',
      nativeFormatAuthority: false,
      authority: 'fixture-confirmed'
    }
  }));

  return {
    ok: true,
    authority: 'fixture-confirmed',
    version,
    entries,
    tableStart,
    stringPoolStart,
    diagnostics,
    nativeFormatAuthority: false
  };
}

export function buildSyntheticFmg(entries: Array<{ textId: number; text: string }>): {
  ok: boolean;
  bytes?: Buffer;
  hash?: string;
  diagnostics: StructuredDiagnostic[];
} {
  const tableStart = 24;
  const stringPoolStart = tableStart + entries.length * STRIDE;
  const encoded = entries.map((e) => encodeUtf16Le(e.text));
  let poolSize = 0;
  const rels: number[] = [];
  for (const e of encoded) {
    rels.push(poolSize);
    poolSize += e.length;
  }
  const total = stringPoolStart + poolSize;
  const out = Buffer.alloc(total);
  out.write('FMG\0', 0, 'ascii');
  MARKER.copy(out, 4);
  writeI32(out, 8, 1);
  writeI32(out, 12, entries.length);
  writeI32(out, 16, tableStart);
  writeI32(out, 20, stringPoolStart);
  for (let i = 0; i < entries.length; i += 1) {
    const row = tableStart + i * STRIDE;
    writeI32(out, row, entries[i]!.textId);
    writeI32(out, row + 4, rels[i]!);
  }
  let sp = stringPoolStart;
  for (const e of encoded) {
    e.copy(out, sp);
    sp += e.length;
  }
  return {
    ok: true,
    bytes: out,
    hash: sha256(out),
    diagnostics: [createDiagnostic({
      severity: 'info',
      code: 'FMG_SYNTHETIC_BUILT',
      message: `Built synthetic FMG with ${entries.length} entries.`,
      details: { nativeFormatAuthority: false }
    })]
  };
}

export function updateSyntheticFmgEntry(
  original: Buffer,
  textId: number,
  newText: string
): {
  ok: boolean;
  bytes?: Buffer;
  hash?: string;
  diagnostics: StructuredDiagnostic[];
} {
  const parsed = parseSyntheticFmg(original);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  const next = parsed.entries.map((e) =>
    e.textId === textId ? { textId: e.textId, text: newText } : { textId: e.textId, text: e.text }
  );
  if (!parsed.entries.some((e) => e.textId === textId)) {
    return {
      ok: false,
      diagnostics: [createDiagnostic({
        severity: 'error',
        code: 'FMG_ENTRY_NOT_FOUND',
        message: `FMG entry textId ${textId} not found.`
      })]
    };
  }
  return buildSyntheticFmg(next);
}

export function roundTripSyntheticFmg(original: Buffer): {
  ok: boolean;
  entriesMatch: boolean;
  originalHash: string;
  rebuiltHash: string;
  diagnostics: StructuredDiagnostic[];
} {
  const originalHash = sha256(original);
  const parsed = parseSyntheticFmg(original);
  if (!parsed.ok) {
    return {
      ok: false,
      entriesMatch: false,
      originalHash,
      rebuiltHash: '',
      diagnostics: parsed.diagnostics
    };
  }
  const built = buildSyntheticFmg(parsed.entries.map((e) => ({ textId: e.textId, text: e.text })));
  if (!built.ok || !built.bytes) {
    return {
      ok: false,
      entriesMatch: false,
      originalHash,
      rebuiltHash: '',
      diagnostics: [...parsed.diagnostics, ...built.diagnostics]
    };
  }
  const reparsed = parseSyntheticFmg(built.bytes);
  const entriesMatch =
    reparsed.ok
    && reparsed.entries.length === parsed.entries.length
    && reparsed.entries.every((e, i) =>
      e.textId === parsed.entries[i]!.textId && e.text === parsed.entries[i]!.text
    );
  return {
    ok: entriesMatch,
    entriesMatch,
    originalHash,
    rebuiltHash: built.hash ?? sha256(built.bytes),
    diagnostics: [...parsed.diagnostics, ...built.diagnostics, ...reparsed.diagnostics]
  };
}
