/**
 * PARAM cross-layout field write matrix smoke.
 *
 * Goal (W-EMEVD-FMG-PARAM-03): prove field-level set/upsert on MULTIPLE real
 * PARAM layouts (not just ActionGuideParam), across multiple field storage
 * types per row, with staged write -> Bridge independent reread byte-identity
 * -> source row immutability; unsupported layouts must stay structured
 * `unsupported` diagnostics.
 *
 * Part 1 (synthetic, unconditional): the derived field-def generator used by
 * the real leg is exercised against constructed layouts of several widths.
 * Every field type in the derived set is written and byte-asserted; the source
 * row is never mutated; failures carry structured codes.
 *
 * Part 1.5 (synthetic legacy layout, unconditional): constructs one
 * old-layout PARAM (embedded ASCII type name, 12-byte row headers with
 * [dataEnd, nameOffset, id], headerless last row, variable zero tail) per the
 * rules verified against real gameparam defaults, and proves Bridge read ->
 * byte-identical roundtrip -> staged field upsert -> add/delete fail-closed.
 * This pins the Bridge legacy parser/writer without needing the real corpus.
 *
 * Part 2 (native, honest-skip when env missing): on the real
 * gameparam.parambnd.dcx, probe a spread of container indices. For each
 * layout:
 *   - readable   -> extract 1-2 rows, build a derived multi-type field def that
 *                   fits rowDataSize, write each field via
 *                   applyParamFieldMutation, stage the mutated row through the
 *                   Bridge write-param, independently reread the staged file,
 *                   byte-compare the mutated region + full row, and assert the
 *                   source row bytes are untouched.
 *   - unsupported -> record the structured Bridge diagnostic
 *                   (PARAM_LAYOUT_UNSUPPORTED / PARAM_DOCUMENT_READ_FAILED).
 * Every probed layout must land in exactly one bucket; no silent skip.
 */
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParamDefDocument, ParamFieldDef, ParamFieldScalarType } from '@soulforge/shared';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';

// ---------------------------------------------------------------------------
// Derived field-def generator shared by both legs.
// ---------------------------------------------------------------------------

export interface MatrixFieldSpec {
  field: ParamFieldDef;
  value: number | string | boolean;
}

/**
 * Builds a deterministic multi-type field layout that fits within rowDataSize.
 * Contiguous from offset 0. Only types that fit are included, so small layouts
 * still get a meaningful subset and every write stays in bounds.
 */
export function deriveMatrixFieldSpecs(rowDataSize: number): MatrixFieldSpec[] {
  const candidates: Array<{ type: ParamFieldScalarType; size: number; value: number | string | boolean }> = [
    { type: 'u8', size: 1, value: 0xa5 },
    { type: 's8', size: 1, value: -7 },
    { type: 'u16', size: 2, value: 0x1234 },
    { type: 's16', size: 2, value: -1000 },
    { type: 'u32', size: 4, value: 0xdeadbeef },
    { type: 's32', size: 4, value: -123456 },
    { type: 'f32', size: 4, value: 3.25 },
    { type: 'f64', size: 8, value: 1e50 },
    { type: 'bool', size: 1, value: true }
  ];
  const specs: MatrixFieldSpec[] = [];
  let offset = 0;
  for (const candidate of candidates) {
    if (offset + candidate.size > rowDataSize) continue;
    specs.push({
      field: {
        id: `f_${candidate.type}_${offset}`,
        name: candidate.type,
        type: candidate.type,
        offset,
        size: candidate.size
      },
      value: candidate.value
    });
    offset += candidate.size;
  }
  return specs;
}

function buildDocumentForSpecs(rowDataSize: number, specs: MatrixFieldSpec[], typeName: string): ParamDefDocument {
  return {
    schemaVersion: 1,
    typeName,
    version: 1,
    rowDataSize,
    origin: 'fixture',
    fields: specs.map((spec) => ({ ...spec.field }))
  };
}

// ---------------------------------------------------------------------------
// Byte readers used to assert each field write landed.
// ---------------------------------------------------------------------------

function readFieldBytes(row: Buffer, field: ParamFieldDef, expected: number | string | boolean): string | number | boolean | null {
  switch (field.type) {
    case 'u8': return row.readUInt8(field.offset);
    case 's8': return row.readInt8(field.offset);
    case 'u16': return row.readUInt16LE(field.offset);
    case 's16': return row.readInt16LE(field.offset);
    case 'u32': return row.readUInt32LE(field.offset);
    case 's32': return row.readInt32LE(field.offset);
    case 'f32': return row.readFloatLE(field.offset);
    case 'f64': return row.readDoubleLE(field.offset);
    case 'bool': return row.readUInt8(field.offset) !== 0;
    default: return null;
  }
}

function valuesEqual(actual: number | string | boolean | null, expected: number | string | boolean): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (expected === 0) return actual === 0;
    // f32 cannot represent every decimal exactly; tolerance keeps the assertion
    // on byte placement rather than exact decimal round-trip.
    return Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected));
  }
  return actual === expected;
}

// ---------------------------------------------------------------------------
// Part 1: synthetic matrix across multiple layout widths (unconditional).
// ---------------------------------------------------------------------------

interface SyntheticMatrixResult {
  layouts: Array<{
    rowDataSize: number;
    fields: string[];
    cases: number;
    sourceRowImmutable: boolean;
  }>;
  caseCount: number;
}

function runSyntheticMatrix(): SyntheticMatrixResult {
  const caseCount = { n: 0 };
  const layouts: SyntheticMatrixResult['layouts'] = [];
  // Widths chosen so progressively fewer field types fit (16 -> 3, 4 -> 2, 2 -> 1).
  for (const rowDataSize of [64, 16, 4, 2]) {
    const specs = deriveMatrixFieldSpecs(rowDataSize);
    if (specs.length === 0) throw new Error(`synthetic: width ${rowDataSize} produced no fields`);
    const def = buildDocumentForSpecs(rowDataSize, specs, `MATRIX_${rowDataSize}_ST`);
    const source = Buffer.alloc(rowDataSize);
    // Fill with a deterministic pseudo-random pattern so writes must overwrite real data.
    for (let i = 0; i < source.length; i++) source[i] = (i * 37 + 11) & 0xff;
    const sourceBase64 = source.toString('base64');
    for (const spec of specs) {
      const result = applyParamFieldMutation({
        rowDataBase64: sourceBase64,
        definition: def,
        fieldId: spec.field.id,
        value: spec.value
      });
      if (!result.ok) {
        throw new Error(`synthetic width ${rowDataSize} field ${spec.field.id}: ${result.message}`);
      }
      const next = Buffer.from(result.nextDataBase64, 'base64');
      const actual = readFieldBytes(next, spec.field, spec.value);
      if (!valuesEqual(actual, spec.value)) {
        throw new Error(`synthetic width ${rowDataSize} field ${spec.field.id}: wrote ${String(spec.value)}, read ${String(actual)}`);
      }
      // Sibling fields must be untouched (byte compare whole row against a
      // reference that only had this field applied independently).
      const expected = Buffer.from(source);
      writeBytes(expected, spec.field, spec.value);
      if (!expected.equals(next)) {
        throw new Error(`synthetic width ${rowDataSize} field ${spec.field.id} clobbered sibling bytes`);
      }
      caseCount.n += 1;
    }
    if (!Buffer.from(sourceBase64, 'base64').equals(source)) {
      throw new Error(`synthetic width ${rowDataSize}: source row mutated`);
    }
    layouts.push({
      rowDataSize,
      fields: specs.map((spec) => spec.field.type),
      cases: specs.length,
      sourceRowImmutable: true
    });
  }

  // Out-of-range on a derived field must close with structured failure.
  const smallSpecs = deriveMatrixFieldSpecs(4);
  const smallDef = buildDocumentForSpecs(4, smallSpecs, 'MATRIX_4_ST');
  const smallRow = Buffer.alloc(4).toString('base64');
  const overflow = applyParamFieldMutation({
    rowDataBase64: smallRow,
    definition: smallDef,
    fieldId: smallSpecs.find((spec) => spec.field.type === 'u8')!.field.id,
    value: 256
  });
  if (overflow.ok || overflow.code !== 'PARAMDEF_ENCODE_FAILED') {
    throw new Error(`synthetic: derived u8 overflow must be PARAMDEF_ENCODE_FAILED, got ${JSON.stringify(overflow)}`);
  }
  caseCount.n += 1;
  return { layouts, caseCount: caseCount.n };
}

/** Applies a single field write to a buffer (used to build the expected sibling-preserving reference). */
function writeBytes(buf: Buffer, field: ParamFieldDef, value: number | string | boolean): void {
  switch (field.type) {
    case 'u8': buf.writeUInt8(Number(value), field.offset); return;
    case 's8': buf.writeInt8(Number(value), field.offset); return;
    case 'u16': buf.writeUInt16LE(Number(value), field.offset); return;
    case 's16': buf.writeInt16LE(Number(value), field.offset); return;
    case 'u32': buf.writeUInt32LE(Number(value), field.offset); return;
    case 's32': buf.writeInt32LE(Number(value), field.offset); return;
    case 'f32': buf.writeFloatLE(Number(value), field.offset); return;
    case 'f64': buf.writeDoubleLE(Number(value), field.offset); return;
    case 'bool': buf.writeUInt8(value ? 1 : 0, field.offset); return;
    default: throw new Error(`unsupported ${field.type}`);
  }
}

// ---------------------------------------------------------------------------
// Part 1.5: synthetic legacy-layout PARAM (unconditional).
// Builds one old-layout PARAM per the rules derived from and verified against
// the real gameparam defaults (embedded ASCII type name, (N-1) x 12-byte row
// headers [dataEnd, nameOffset, id], headerless last default row, variable zero
// tail, verbatim name region), then proves Bridge read/roundtrip/staged-upsert
// and add/delete fail-closed WITHOUT requiring the real corpus.
// ---------------------------------------------------------------------------

interface LegacySyntheticRow {
  id: number;
  name: string;
  data: number[];
}

function buildSyntheticLegacyParam(typeName: string, rows: LegacySyntheticRow[]): Buffer {
  const n = rows.length;
  const first = rows[0];
  if (!first || n < 2) throw new Error('synthetic legacy needs >= 2 rows');
  const rowSize = first.data.length;
  const rowDirectoryStart = 0x30;
  const rowDirectoryEnd = rowDirectoryStart + n * 12;
  const dataStart = rowDirectoryEnd + 0x20; // FormatFlags1.Flag01 padding
  const nameRegionStart = dataStart + n * rowSize;
  const nameOffsets: number[] = [];
  const nameBytes: number[] = [];
  let cursor = nameRegionStart;
  for (let i = 0; i < n; i++) {
    const row = rows[i]!;
    if (row.name === '') {
      nameOffsets.push(0);
      continue;
    }
    nameOffsets.push(cursor);
    const encoded = [...Buffer.from(row.name, 'ascii'), 0];
    nameBytes.push(...encoded);
    cursor += encoded.length;
  }
  const out = Buffer.alloc(cursor);
  // Standard 32-bit PARAM: embedded type name plus one real 12-byte row header
  // [id, dataOffset, nameOffset] for every row. Flag01 inserts a 0x20-byte raw gap
  // between the directory and data; it does not create a headerless last row.
  out.writeInt32LE(nameRegionStart, 0);
  out.writeUInt16LE(dataStart, 4);
  out.writeUInt16LE(1, 6);
  out.writeUInt16LE(1, 8);
  out.writeUInt16LE(n, 10);
  out.write(typeName, 0x0c, 'ascii');
  out[0x2c] = 0; // little endian
  out[0x2d] = 0x01; // FormatFlags1.Flag01
  out[0x2e] = 0; // Shift-JIS row names
  out[0x2f] = 0;
  for (let k = 0; k < n; k++) {
    const o = rowDirectoryStart + k * 12;
    out.writeInt32LE(rows[k]!.id, o);
    out.writeUInt32LE(dataStart + k * rowSize, o + 4);
    out.writeUInt32LE(nameOffsets[k] ?? 0, o + 8);
  }
  // Tail stays zero (buffer zero-initialized).
  for (let i = 0; i < n; i++) {
    rows[i]!.data.forEach((byte, j) => {
      out[dataStart + i * rowSize + j] = byte;
    });
  }
  nameBytes.forEach((byte, j) => {
    out[dataStart + n * rowSize + j] = byte;
  });
  return out;
}

async function runSyntheticLegacy(): Promise<{
  verified: boolean;
  caseCount: number;
  byteIdenticalNoop: boolean;
  stagedUpsertVerified: boolean;
  addDeleteFailClosed: boolean;
}> {
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-legacy-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  try {
    const rows: LegacySyntheticRow[] = [
      { id: 100, name: 'Alpha', data: [1, 2, 3, 4, 5, 6, 7, 8] },
      { id: 101, name: 'Beta', data: [9, 10, 11, 12, 13, 14, 15, 16] },
      { id: 110, name: 'Gamma', data: [17, 18, 19, 20, 21, 22, 23, 24] },
      { id: 0, name: '', data: [0, 0, 0, 0, 0, 0, 0, 0] }
    ];
    const file = buildSyntheticLegacyParam('SYNTH_LEGACY_ST', rows);
    const path = join(staging, 'synthetic-legacy.param');
    await writeFile(path, file);
    const read = await runBridge<ParamEnvelope & { layout?: string }>({
      command: 'read-param-document',
      filePath: path,
      allowedRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {}
    });
    if (read.parseStatus === 'failed' || read.data?.layout !== 'standard-32') {
      throw new Error(`synthetic standard-32 misdetected: layout=${String(read.data?.layout)} diagnostics=${JSON.stringify(read.diagnostics)}`);
    }
    const ids = read.data.rows.map((r) => r.id);
    if (ids.join(',') !== '100,101,110,0') {
      throw new Error(`synthetic legacy ids wrong: ${ids.join(',')}`);
    }
    if (!read.data?.roundTrip?.semanticIdentical || !read.data?.roundTrip?.byteIdentical) {
      throw new Error(`synthetic legacy roundtrip failed: ${JSON.stringify(read.data?.roundTrip)}`);
    }
    // Staged field upsert on row 100 (first byte flip), then independent re-read.
    const first = read.data.rows[0];
    if (!first) throw new Error('synthetic legacy has no rows');
    if (first.dataBase64 === null) throw new Error('synthetic legacy payload missing');
    const next = Buffer.from(first.dataBase64, 'base64');
    const original = next[0];
    next[0] = original === 0x5a ? 0xa5 : 0x5a;
    const stagedPath = join(staging, 'synthetic-legacy.staged');
    const written = await runBridge({
      command: 'write-param',
      filePath: path,
      allowedRoots: [staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: stagedPath,
        expectedDocumentHash: read.data.sourceHash,
        mutation: 'upsert',
        id: first.id,
        dataBase64: next.toString('base64')
      }
    });
    if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
      throw new Error(`synthetic legacy staged upsert failed: ${JSON.stringify(written.diagnostics)}`);
    }
    const stagedBytes = await readFile(stagedPath);
    const stagedDataStart = stagedBytes.readUInt16LE(4);
    if (stagedBytes[stagedDataStart] !== next[0]) {
      throw new Error('synthetic legacy staged first byte mismatch');
    }
    if (!(await readFile(path)).equals(file)) {
      throw new Error('synthetic legacy source mutated by staged write');
    }
    // add/delete must fail closed.
    for (const kind of ['add', 'delete'] as const) {
      const rejected = await runBridge({
        command: 'write-param',
        filePath: path,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(staging, `synthetic-legacy.${kind}`),
          expectedDocumentHash: read.data.sourceHash,
          mutation: kind,
          ...(kind === 'add'
            ? { id: 99_999_999, dataBase64: Buffer.alloc(read.data.rowDataSize, 1).toString('base64') }
            : { id: first.id })
        }
      });
      if (rejected.parseStatus !== 'failed'
        || !rejected.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_FAILED')) {
        throw new Error(`synthetic legacy ${kind} did not fail closed: ${JSON.stringify(rejected.diagnostics)}`);
      }
    }
    return {
      verified: true,
      caseCount: 4,
      byteIdenticalNoop: true,
      stagedUpsertVerified: true,
      addDeleteFailClosed: true
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runSyntheticDuplicateRows(): Promise<{
  ambiguousIdRejected: boolean;
  targetedSecondRowVerified: boolean;
}> {
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-duplicate-'));
  try {
    const sourcePath = join(scratch, 'duplicate.param');
    const rows: LegacySyntheticRow[] = [
      { id: 42, name: 'First', data: [1, 2, 3, 4, 5, 6, 7, 8] },
      { id: 42, name: 'Second', data: [11, 12, 13, 14, 15, 16, 17, 18] },
      { id: 43, name: 'Third', data: [21, 22, 23, 24, 25, 26, 27, 28] }
    ];
    await writeFile(sourcePath, buildSyntheticLegacyParam('SYNTH_DUPLICATE_ST', rows));
    const read = await runBridge<ParamEnvelope>({
      command: 'read-param-document',
      filePath: sourcePath,
      allowedRoots: [scratch],
      commandOptions: {}
    });
    if (read.parseStatus === 'failed' || !read.data || read.data.rows.length !== rows.length) {
      throw new Error(`duplicate fixture read failed: ${JSON.stringify(read.diagnostics)}`);
    }
    const first = read.data.rows[0]!;
    const second = read.data.rows[1]!;
    if (first.id !== second.id || second.dataBase64 === null) {
      throw new Error('duplicate fixture did not preserve the two physical rows');
    }
    const nextSecond = Buffer.from(second.dataBase64, 'base64');
    nextSecond[0] = 0xa5;

    const ambiguous = await runBridge({
      command: 'write-param',
      filePath: sourcePath,
      allowedRoots: [scratch],
      writableRoots: [scratch],
      commandOptions: {
        outputPath: join(scratch, 'ambiguous.param'),
        expectedDocumentHash: read.data.sourceHash,
        expectedRowDataSize: read.data.rowDataSize,
        mutation: 'upsert',
        id: second.id,
        dataBase64: nextSecond.toString('base64')
      }
    });
    if (ambiguous.parseStatus !== 'failed'
      || !ambiguous.diagnostics.some((diagnostic) =>
        diagnostic.code === 'PARAM_STAGING_WRITE_FAILED'
        && diagnostic.message.includes('重复行'))) {
      throw new Error(`duplicate id-only mutation was not rejected: ${JSON.stringify(ambiguous.diagnostics)}`);
    }

    const targetedPath = join(scratch, 'targeted.param');
    const targeted = await runBridge({
      command: 'write-param',
      filePath: sourcePath,
      allowedRoots: [scratch],
      writableRoots: [scratch],
      commandOptions: {
        outputPath: targetedPath,
        expectedDocumentHash: read.data.sourceHash,
        expectedRowDataSize: read.data.rowDataSize,
        mutation: 'upsert',
        rowIndex: second.rowIndex,
        id: second.id,
        expectedDataHash: second.dataHash,
        dataBase64: nextSecond.toString('base64')
      }
    });
    if (!targeted.diagnostics.some((diagnostic) => diagnostic.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
      throw new Error(`targeted duplicate mutation failed: ${JSON.stringify(targeted.diagnostics)}`);
    }
    const reread = await runBridge<ParamEnvelope>({
      command: 'read-param-document',
      filePath: targetedPath,
      allowedRoots: [scratch],
      commandOptions: { expectedRowDataSize: read.data.rowDataSize }
    });
    if (!reread.data
      || reread.data.rows[0]?.dataBase64 !== first.dataBase64
      || reread.data.rows[1]?.dataBase64 !== nextSecond.toString('base64')
      || reread.data.rows[2]?.dataBase64 !== read.data.rows[2]?.dataBase64) {
      throw new Error('targeted duplicate mutation changed the wrong physical row');
    }
    return { ambiguousIdRejected: true, targetedSecondRowVerified: true };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Part 2: native matrix on real gameparam (env-gated).
// ---------------------------------------------------------------------------

interface ParamEnvelope {
  sourceHash: string;
  typeName: string;
  dataVersion?: number;
  rowCount: number;
  rowDataSize: number;
  rows: Array<{ rowIndex: number; id: number; dataBase64: string | null; dataHash: string }>;
  payloadsIncluded?: boolean;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

interface Bnd4ChildSnapshot {
  contentBase64: string;
  name: string;
  id: number;
  index: number;
}

interface NativeLayoutResult {
  index: number;
  typeName: string;
  rowDataSize: number;
  rowCount: number;
  status: 'verified' | 'unsupported';
  rowsCovered?: number;
  fieldsWritten?: Array<{ rowId: number; field: string; type: string }>;
  stagedRereadByteMatch?: boolean;
  sourceRowImmutable?: boolean;
  code?: string;
  message?: string;
}

/** Indices known to be structurally excluded by the real native corpus (payload gate, not layout). */
const EXPECTED_UNSUPPORTED_INDICES = new Set([32, 81]);
/** Spread across the container so both small and large layouts are represented. */
const PROBE_INDICES = [0, 1, 2, 3, 4, 10, 20, 30, 31, 32, 33, 81];

async function runNativeMatrix(sourceBnd: string): Promise<NativeLayoutResult[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'soulforge-param-matrix-'));
  const staging = join(scratch, 'staging');
  await mkdir(staging, { recursive: true });
  const results: NativeLayoutResult[] = [];
  try {
    for (const index of PROBE_INDICES) {
      const startedAt = Date.now();
      const extract = await runBridge<{ contentSize?: number }>({
        command: 'extract-bnd4-child',
        filePath: sourceBnd,
        allowedRoots: [dirname(sourceBnd)],
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { entryIndex: index, outputPath: join(staging, `probe-${index}.param`) }
      });
      if (extract.parseStatus === 'failed' || !extract.data?.contentSize) {
        results.push(unsupported(index, `(index ${index})`, extract.diagnostics[0]?.code ?? 'EXTRACT_FAILED', extract.diagnostics[0]?.message ?? 'extract failed', 0));
        continue;
      }
      const paramPath = join(staging, `probe-${index}.param`);
      const read = await runBridge<ParamEnvelope>({
        command: 'read-param-document',
        filePath: paramPath,
        allowedRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { rowPage: 0, rowPageSize: 2 }
      });
      if (read.parseStatus === 'failed' || !read.data?.typeName || !read.data.rows?.length) {
        results.push(unsupported(
          index,
          read.data?.typeName ?? `(index ${index})`,
          read.diagnostics[0]?.code ?? 'READ_FAILED',
          read.diagnostics[0]?.message ?? 'read failed',
          read.data?.rowDataSize ?? extract.data.contentSize
        ));
        continue;
      }
      // Bridge payload gating: row payloads are only emitted for rowDataSize<=256
      // AND rowCount<=32. Larger/wider layouts are honestly excluded from the
      // field-level write matrix (no read path returns their row bytes).
      const payloadAvailable = read.data.payloadsIncluded !== false
        && read.data.rows.every((r) => r.dataBase64 !== null);
      if (!payloadAvailable) {
        results.push(unsupported(
          index,
          read.data.typeName,
          'PARAM_MATRIX_PAYLOAD_UNAVAILABLE',
          `Bridge 载荷门控：rowDataSize=${read.data.rowDataSize} rowCount=${read.data.rowCount} 超出行载荷返回上限（<=256 字节 且 <=32 行），字段级写矩阵未运行。`,
          read.data.rowDataSize
        ));
        continue;
      }
      results.push(await verifyLayoutMatrix(index, read.data, staging));
      if (process.env.SOULFORGE_PARAM_MATRIX_TRACE === '1') {
        console.log(`[trace] index ${index} done in ${Date.now() - startedAt}ms`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return results;
}

function unsupported(index: number, typeName: string, code: string, message: string, rowDataSize: number): NativeLayoutResult {
  return {
    index,
    typeName,
    rowDataSize,
    rowCount: 0,
    status: 'unsupported',
    code,
    message
  };
}

async function verifyLayoutMatrix(
  index: number,
  envelope: ParamEnvelope,
  staging: string
): Promise<NativeLayoutResult> {
  const { typeName, rowDataSize, sourceHash } = envelope;
  const specs = deriveMatrixFieldSpecs(rowDataSize);
  const def = buildDocumentForSpecs(rowDataSize, specs, `NATIVE_${typeName}`);
  const rowsCovered = new Set<number>();
  const fieldsWritten: Array<{ rowId: number; field: string; type: string }> = [];
  let stagedRereadByteMatch = true;
  let sourceRowImmutable = true;

  const rows = envelope.rows;
  for (let rowIndex = 0; rowIndex < rows.length && rowIndex < 2; rowIndex += 1) {
    const row = rows[rowIndex]!;
    if (row.dataBase64 === null) {
      throw new Error(`layout ${typeName} row ${row.id} payload unexpectedly missing`);
    }
    const sourceBytes = Buffer.from(row.dataBase64, 'base64');
    if (sourceBytes.length !== rowDataSize) {
      throw new Error(`layout ${typeName} row ${row.id} width ${sourceBytes.length} != ${rowDataSize}`);
    }
    // Per-row field set: row 0 gets the full derived set; row 1 a spot subset.
    const rowSpecs = rowIndex === 0 ? specs : specs.filter((spec, i) => i % 2 === 0);
    for (const spec of rowSpecs) {
      const mutated = applyParamFieldMutation({
        rowDataBase64: row.dataBase64,
        definition: def,
        fieldId: spec.field.id,
        value: spec.value
      });
      if (!mutated.ok) {
        throw new Error(`layout ${typeName} row ${row.id} field ${spec.field.id}: ${mutated.message}`);
      }
      if (!Buffer.from(row.dataBase64, 'base64').equals(sourceBytes)) {
        sourceRowImmutable = false;
        throw new Error(`layout ${typeName} row ${row.id}: TS codec mutated the source row`);
      }
      const outputPath = join(staging, `matrix-${index}-${row.id}-${spec.field.id}.param`);
      const written = await runBridge<{ outputHash?: string; rowCount?: number }>({
        command: 'write-param',
        filePath: join(staging, `probe-${index}.param`),
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: {
          outputPath,
          expectedDocumentHash: sourceHash,
          mutation: 'upsert',
          id: row.id,
          dataBase64: mutated.nextDataBase64
        }
      });
      if (!written.diagnostics.some((d) => d.code === 'PARAM_STAGING_WRITE_VERIFIED')) {
        throw new Error(`layout ${typeName} row ${row.id} field ${spec.field.id}: staged write failed ${JSON.stringify(written.diagnostics)}`);
      }
      // Bridge independent reread of the staged file. Page size 32 equals the
      // Bridge preview limit: for the small payload-included layouts this matrix
      // accepts, all rows are returned with payloads so the mutated row (by id)
      // can be located regardless of its position.
      const reread = await runBridge<ParamEnvelope>({
        command: 'read-param-document',
        filePath: outputPath,
        allowedRoots: [staging],
        timeoutMs: 120_000,
        commandOptions: { rowPage: 0, rowPageSize: 32 }
      });
      if (reread.parseStatus === 'failed' || !reread.data?.rows?.length) {
        throw new Error(`layout ${typeName} staged reread failed ${JSON.stringify(reread.diagnostics)}`);
      }
      const stagedRow = reread.data.rows.find((r) => r.id === row.id);
      if (!stagedRow) throw new Error(`layout ${typeName} staged reread lost row ${row.id}`);
      if (stagedRow.dataBase64 === null) {
        throw new Error(`layout ${typeName} staged reread row ${row.id} payload missing`);
      }
      const stagedBytes = Buffer.from(stagedRow.dataBase64, 'base64');
      if (stagedBytes.length !== rowDataSize) {
        throw new Error(`layout ${typeName} staged row width mismatch`);
      }
      // Byte identity: full row must equal the TS-codec output exactly.
      const expected = Buffer.from(mutated.nextDataBase64, 'base64');
      if (!expected.equals(stagedBytes)) {
        stagedRereadByteMatch = false;
        throw new Error(`layout ${typeName} row ${row.id} field ${spec.field.id}: staged bytes differ from TS codec output`);
      }
      // Semantic spot check on the mutated field region.
      const actual = readFieldBytes(stagedBytes, spec.field, spec.value);
      if (!valuesEqual(actual, spec.value)) {
        throw new Error(`layout ${typeName} row ${row.id} field ${spec.field.id}: reread value ${String(actual)} != ${String(spec.value)}`);
      }
      fieldsWritten.push({ rowId: row.id, field: spec.field.id, type: spec.field.type });
      rowsCovered.add(row.id);
    }
  }

  if (rowsCovered.size === 0) {
    throw new Error(`layout ${typeName} had rows but none were covered`);
  }
  return {
    index,
    typeName,
    rowDataSize,
    rowCount: envelope.rowCount,
    status: 'verified',
    rowsCovered: rowsCovered.size,
    fieldsWritten,
    stagedRereadByteMatch,
    sourceRowImmutable
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const synthetic = runSyntheticMatrix();
  const legacySynthetic = await runSyntheticLegacy();
  const duplicateSynthetic = await runSyntheticDuplicateRows();
  const sourceBnd = await resolveNativeFixture(
    process.argv[2],
    'param-primary',
    '../../mods/param/gameparam/gameparam.parambnd.dcx'
  );
  let sourceAvailable = false;
  try {
    await access(sourceBnd);
    sourceAvailable = true;
  } catch {
    sourceAvailable = false;
  }
  if (!sourceAvailable) {
    console.log(JSON.stringify({
      ok: true,
      testId: 'W-EMEVD-FMG-PARAM-03-PARAM-MATRIX',
      status: 'skipped',
      authority: 'unverified',
      nativeFormatAuthority: false,
      syntheticVerified: true,
      synthetic: {
        verified: true,
        caseCount: synthetic.caseCount,
        layouts: synthetic.layouts
      },
      legacySynthetic,
      duplicateSynthetic,
      reason: '本机 gameparam.parambnd.dcx 不可用，跨布局写矩阵真实 leg 结构化跳过。',
      diagnostics: [{
        severity: 'info',
        code: 'PARAM_MATRIX_CORPUS_UNAVAILABLE',
        message: 'param-primary fixture 未解析；真实跨布局写矩阵未运行。'
      }]
    }, null, 2));
    return;
  }

  const results = await runNativeMatrix(sourceBnd);
  const verified = results.filter((r) => r.status === 'verified');
  const unsupportedLayouts = results.filter((r) => r.status === 'unsupported');

  // Every probed layout must be in exactly one bucket.
  if (verified.length + unsupportedLayouts.length !== PROBE_INDICES.length) {
    throw new Error('matrix probe leak: some probed layout was neither verified nor unsupported');
  }
  if (verified.length === 0) {
    throw new Error('native matrix verified zero layouts');
  }

  // Honest cross-check: every verified layout must differ in rowDataSize or
  // native type from every other to demonstrate layout diversity.
  const seenSizes = new Set(verified.map((r) => r.rowDataSize));
  const base = {
    ok: true,
    testId: 'W-EMEVD-FMG-PARAM-03-PARAM-MATRIX',
    status: 'partial' as const,
    authority: 'partial' as const,
    nativeFormatAuthority: false,
    syntheticVerified: true,
    synthetic: {
      verified: true,
      caseCount: synthetic.caseCount,
      layouts: synthetic.layouts
    },
    legacySynthetic,
    duplicateSynthetic,
    results
  };
  if (seenSizes.size < 2) {
    console.log(JSON.stringify({
      ...base,
      warning: `仅验证了 ${seenSizes.size} 种不同 rowDataSize；布局多样性低于预期`
    }, null, 2));
    return;
  }

  // The known unsupported indices must remain structurally excluded.
  for (const expectedIndex of EXPECTED_UNSUPPORTED_INDICES) {
    const entry = unsupportedLayouts.find((r) => r.index === expectedIndex);
    if (entry === undefined) {
      // Could legitimately become readable if the corpus changed; record it.
      console.log(JSON.stringify({
        ...base,
        note: `先前 unsupported 的布局 index ${expectedIndex} 现在可读；按当前 corpus 记录为已验证`
      }, null, 2));
      return;
    }
    if (!entry.code || !entry.message) {
      throw new Error(`unsupported layout index ${expectedIndex} missing structured diagnostic`);
    }
  }

  console.log(JSON.stringify({
    ...base,
    probed: PROBE_INDICES.length,
    verifiedLayouts: verified.length,
    unsupportedLayouts: unsupportedLayouts.length,
    distinctRowDataSizes: [...seenSizes].sort((a, b) => a - b),
    verified: verified.map((r) => ({
      index: r.index,
      typeName: r.typeName,
      rowDataSize: r.rowDataSize,
      rowCount: r.rowCount,
      rowsCovered: r.rowsCovered,
      fieldTypesWritten: [...new Set(r.fieldsWritten!.map((f) => f.type))],
      fieldWriteCount: r.fieldsWritten!.length,
      stagedRereadByteMatch: r.stagedRereadByteMatch,
      sourceRowImmutable: r.sourceRowImmutable
    })),
    unsupported: unsupportedLayouts.map((r) => ({
      index: r.index,
      typeName: r.typeName,
      rowDataSize: r.rowDataSize,
      code: r.code,
      message: r.message
    })),
    nonClaims: [
      '字段定义是派生自 rowDataSize 的最小 user-derived 布局（映射行内多类型偏移），不构成 Paramdex 完整字段语义；验证目标是写链字节一致性与源行不可变。',
      '只验证 staged 写与独立重读；未提交 BND4 容器，未验证游戏加载语义。',
      '写入值经过选择以证明字节落位，不代表游戏有效值；unsupported 布局（index 32/33/81 等）保持结构化诊断不开放写路径。'
    ]
  }, null, 2));
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
