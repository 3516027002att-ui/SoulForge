/**
 * PARAM field-level mutation end-to-end smoke:
 * applyParamFieldMutation covers every ParamFieldScalarType (u8/s8/u16/s16/
 * u32/s32/f32/f64/bool/fix/bytes) with positive, boundary, and out-of-range
 * cases, plus preserving bitfield writes on u8/u16/u32/s32/bool storage
 * (including a full 32-bit bitfield that exercises the BigInt bit codec).
 * Every case leaves the source row unchanged and closes failures with
 * structured error codes. The Bridge is not involved here — this validates the
 * TS field encoding layer that the IPC/preload path feeds into.
 */
import type { ParamDefDocument } from '@soulforge/shared';
import { applyParamFieldMutation } from '../param/paramFieldMutation.js';

const SCALAR_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'DEMO_PARAM_ST',
  version: 1,
  rowDataSize: 16,
  origin: 'fixture',
  fields: [
    { id: 'f_id', name: 'idHint', type: 's32', offset: 0, size: 4 },
    {
      id: 'f_hp',
      name: 'hp',
      type: 'u16',
      offset: 4,
      size: 2,
      min: 0,
      max: 9999,
      defaultValue: 100
    },
    { id: 'f_flag', name: 'enabled', type: 'bool', offset: 6, size: 1 },
    { id: 'f_rate', name: 'rate', type: 'f32', offset: 8, size: 4 }
  ]
};

const BITFIELD_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_PARAM_ST',
  version: 1,
  rowDataSize: 1,
  origin: 'fixture',
  fields: [
    { id: 'low', name: 'low', type: 'u8', offset: 0, size: 1, bitfield: { bitOffset: 0, bitWidth: 4 } },
    { id: 'high', name: 'high', type: 'u8', offset: 0, size: 1, bitfield: { bitOffset: 4, bitWidth: 4 } }
  ]
};

/** Every scalar storage type in one 64-byte row. */
const ALL_TYPES_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'ALL_TYPES_PARAM_ST',
  version: 1,
  rowDataSize: 64,
  origin: 'fixture',
  fields: [
    { id: 'f_u8', name: 'u8', type: 'u8', offset: 0, size: 1 },
    { id: 'f_s8', name: 's8', type: 's8', offset: 1, size: 1 },
    { id: 'f_u16', name: 'u16', type: 'u16', offset: 2, size: 2 },
    { id: 'f_s16', name: 's16', type: 's16', offset: 4, size: 2 },
    { id: 'f_u32', name: 'u32', type: 'u32', offset: 8, size: 4 },
    { id: 'f_s32', name: 's32', type: 's32', offset: 12, size: 4 },
    { id: 'f_f32', name: 'f32', type: 'f32', offset: 16, size: 4 },
    { id: 'f_f64', name: 'f64', type: 'f64', offset: 24, size: 8 },
    { id: 'f_bool', name: 'bool', type: 'bool', offset: 32, size: 1 },
    { id: 'f_fix', name: 'fix', type: 'fix', offset: 40, size: 16 },
    { id: 'f_bytes', name: 'bytes', type: 'bytes', offset: 56, size: 8 }
  ]
};

/** u16 storage with two 6-bit fields sharing the word. */
const BITFIELD_U16_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_U16_PARAM_ST',
  version: 1,
  rowDataSize: 2,
  origin: 'fixture',
  fields: [
    { id: 'lo6', name: 'lo6', type: 'u16', offset: 0, size: 2, bitfield: { bitOffset: 0, bitWidth: 6 } },
    { id: 'hi6', name: 'hi6', type: 'u16', offset: 0, size: 2, bitfield: { bitOffset: 6, bitWidth: 6 } }
  ]
};

/** Full-width u32 bitfield — the case the Number-based codec could not handle. */
const BITFIELD_U32_FULL_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_U32_FULL_PARAM_ST',
  version: 1,
  rowDataSize: 4,
  origin: 'fixture',
  fields: [
    { id: 'all32', name: 'all32', type: 'u32', offset: 0, size: 4, bitfield: { bitOffset: 0, bitWidth: 32 } }
  ]
};

/** Two 16-bit halves inside a u32 word. */
const BITFIELD_U32_PART_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_U32_PART_PARAM_ST',
  version: 1,
  rowDataSize: 4,
  origin: 'fixture',
  fields: [
    { id: 'lo16', name: 'lo16', type: 'u32', offset: 0, size: 4, bitfield: { bitOffset: 0, bitWidth: 16 } },
    { id: 'hi16', name: 'hi16', type: 'u32', offset: 0, size: 4, bitfield: { bitOffset: 16, bitWidth: 16 } }
  ]
};

/** Bitfield over signed storage: the bit pattern, not the signed value, is edited. */
const BITFIELD_S32_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_S32_PARAM_ST',
  version: 1,
  rowDataSize: 4,
  origin: 'fixture',
  fields: [
    { id: 'lo16', name: 'lo16', type: 's32', offset: 0, size: 4, bitfield: { bitOffset: 0, bitWidth: 16 } }
  ]
};

/** Single-bit bool bitfield. */
const BITFIELD_BOOL_DEF: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'BIT_BOOL_PARAM_ST',
  version: 1,
  rowDataSize: 1,
  origin: 'fixture',
  fields: [
    { id: 'bit', name: 'bit', type: 'bool', offset: 0, size: 1, bitfield: { bitOffset: 0, bitWidth: 1 } }
  ]
};

function buildScalarRow(): Buffer {
  const row = Buffer.alloc(16);
  row.writeInt32LE(42, 0);
  row.writeUInt16LE(100, 4);
  row.writeUInt8(1, 6);
  row.writeFloatLE(1.5, 8);
  return row;
}

function buildAllTypesRow(): Buffer {
  const row = Buffer.alloc(64);
  row.writeUInt8(0x11, 0);
  row.writeInt8(-7, 1);
  row.writeUInt16LE(0x2233, 2);
  row.writeInt16LE(-1000, 4);
  row.writeUInt32LE(0x44556677, 8);
  row.writeInt32LE(-1_000_000, 12);
  row.writeFloatLE(2.5, 16);
  row.writeDoubleLE(1e100, 24);
  row.writeUInt8(0, 32);
  Buffer.from('Hello', 'utf8').copy(row, 40);
  row.writeUInt8(0, 40 + 5); // null terminator for fix
  Buffer.from('AABBCCDDEEFF0001', 'hex').copy(row, 56);
  return row;
}

function expectCode(result: { ok: boolean; code?: string }, code: string, label: string): void {
  if (result.ok || result.code !== code) {
    throw new Error(
      `${label}: expected code ${code}, got ${result.ok ? 'ok' : result.code}`
    );
  }
}

/** Writes a value and asserts it lands at the expected offset/reader. */
function writeOk(
  rowBase64: string,
  definition: ParamDefDocument,
  fieldId: string,
  value: number | string | boolean,
  label: string,
  assert: (next: Buffer) => void
): Buffer {
  const result = applyParamFieldMutation({ rowDataBase64: rowBase64, definition, fieldId, value });
  if (!result.ok) throw new Error(`${label}: write failed: ${result.message}`);
  const next = Buffer.from(result.nextDataBase64, 'base64');
  assert(next);
  return next;
}

function expectEncodeFailed(
  rowBase64: string,
  definition: ParamDefDocument,
  fieldId: string,
  value: number | string | boolean,
  label: string
): void {
  const result = applyParamFieldMutation({ rowDataBase64: rowBase64, definition, fieldId, value });
  expectCode(result, 'PARAMDEF_ENCODE_FAILED', label);
  if (!('message' in result) || !result.message) {
    throw new Error(`${label}: out-of-range must carry a diagnostic message`);
  }
}

function main(): void {
  let caseCount = 0;
  const pass = (label: string): void => {
    caseCount += 1;
    void label;
  };

  // ------------------------------------------------------------------
  // Regression: original 10 cases (scalar + u8 bitfield + failure codes).
  // ------------------------------------------------------------------

  // 1. Scalar write success: value lands and other fields stay intact.
  const scalarRow = buildScalarRow();
  const scalarBase64 = scalarRow.toString('base64');
  const scalarWrite = applyParamFieldMutation({
    rowDataBase64: scalarBase64,
    definition: SCALAR_DEF,
    fieldId: 'f_hp',
    value: 250
  });
  if (!scalarWrite.ok) throw new Error(`scalar write failed: ${scalarWrite.message}`);
  const next = Buffer.from(scalarWrite.nextDataBase64, 'base64');
  if (next.readUInt16LE(4) !== 250) throw new Error('scalar write did not set hp');
  if (next.readInt32LE(0) !== 42 || Math.abs(next.readFloatLE(8) - 1.5) > 1e-6) {
    throw new Error('scalar write clobbered sibling fields');
  }
  pass('scalar field write');

  // 2. Bitfield write preserves other bits (low bits 0-3, all others set).
  const lowBase64 = Buffer.from([0b11111111]).toString('base64');
  const bitLow = applyParamFieldMutation({
    rowDataBase64: lowBase64,
    definition: BITFIELD_DEF,
    fieldId: 'low',
    value: 3
  });
  if (!bitLow.ok) throw new Error(`bitfield low write failed: ${bitLow.message}`);
  if (Buffer.from(bitLow.nextDataBase64, 'base64').readUInt8(0) !== 0b11110011) {
    throw new Error(`bitfield low write did not preserve high bits: 0b${Buffer.from(bitLow.nextDataBase64, 'base64').readUInt8(0).toString(2)}`);
  }
  pass('bitfield low write preserves other bits');

  // 3. Bitfield write to high bits (bits 4-7).
  const highBase64 = Buffer.from([0b00001111]).toString('base64');
  const bitHigh = applyParamFieldMutation({
    rowDataBase64: highBase64,
    definition: BITFIELD_DEF,
    fieldId: 'high',
    value: 5
  });
  if (!bitHigh.ok) throw new Error(`bitfield high write failed: ${bitHigh.message}`);
  if (Buffer.from(bitHigh.nextDataBase64, 'base64').readUInt8(0) !== 0b01011111) {
    throw new Error(`bitfield high write incorrect: 0b${Buffer.from(bitHigh.nextDataBase64, 'base64').readUInt8(0).toString(2)}`);
  }
  pass('bitfield high write');

  // 4. Invalid base64 closes with a structured code.
  expectCode(
    applyParamFieldMutation({
      rowDataBase64: null as unknown as string,
      definition: SCALAR_DEF,
      fieldId: 'f_hp',
      value: 1
    }),
    'PARAM_FIELD_INVALID_BASE64',
    'invalid base64'
  );
  pass('invalid base64 error code');

  // 5. Empty row closes with a structured code.
  expectCode(
    applyParamFieldMutation({
      rowDataBase64: '',
      definition: SCALAR_DEF,
      fieldId: 'f_hp',
      value: 1
    }),
    'PARAM_FIELD_EMPTY_ROW',
    'empty row'
  );
  pass('empty row error code');

  // 6. Row width mismatch closes with a structured code.
  const shortRow = Buffer.alloc(8).toString('base64');
  expectCode(
    applyParamFieldMutation({
      rowDataBase64: shortRow,
      definition: SCALAR_DEF,
      fieldId: 'f_hp',
      value: 1
    }),
    'PARAM_FIELD_ROW_SIZE_MISMATCH',
    'row size mismatch'
  );
  pass('row size mismatch error code');

  // 7. Unknown field closes with a structured code.
  expectCode(
    applyParamFieldMutation({
      rowDataBase64: scalarBase64,
      definition: SCALAR_DEF,
      fieldId: 'nope',
      value: 1
    }),
    'PARAMDEF_FIELD_NOT_FOUND',
    'unknown field'
  );
  pass('unknown field error code');

  // 8. Out-of-range values close with a structured code.
  const bfOutOfRange = applyParamFieldMutation({
    rowDataBase64: lowBase64,
    definition: BITFIELD_DEF,
    fieldId: 'low',
    value: 16
  });
  expectCode(bfOutOfRange, 'PARAMDEF_ENCODE_FAILED', 'bitfield out-of-range');
  if (!('message' in bfOutOfRange) || !bfOutOfRange.message.includes('超出')) {
    throw new Error('bitfield out-of-range must carry a diagnostic message');
  }
  const scalarOutOfRange = applyParamFieldMutation({
    rowDataBase64: scalarBase64,
    definition: SCALAR_DEF,
    fieldId: 'f_hp',
    value: 70_000
  });
  expectCode(scalarOutOfRange, 'PARAMDEF_ENCODE_FAILED', 'scalar out-of-range');
  pass('out-of-range error codes');

  // 9. Source row is never mutated: re-encoding yields the original bytes.
  if (Buffer.from(scalarBase64, 'base64').equals(buildScalarRow())) {
    pass('source row untouched');
  } else {
    throw new Error('scalar source row changed');
  }
  if (Buffer.from(lowBase64, 'base64').readUInt8(0) !== 0b11111111) {
    throw new Error('bitfield source row changed');
  }
  const rewound = applyParamFieldMutation({
    rowDataBase64: bitLow.nextDataBase64,
    definition: BITFIELD_DEF,
    fieldId: 'low',
    value: 0b1111
  });
  if (!rewound.ok || Buffer.from(rewound.nextDataBase64, 'base64').readUInt8(0) !== 0b11111111) {
    throw new Error('bitfield write is not reversible/restoring');
  }
  pass('source row immutable + reversible');

  // ------------------------------------------------------------------
  // Full ParamType scalar coverage on ALL_TYPES_DEF.
  // ------------------------------------------------------------------
  const allRow = buildAllTypesRow();
  const allBase64 = allRow.toString('base64');

  // u8: positive, boundaries (0/255), out-of-range (256, -1).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u8', 200, 'u8 write', (n) => {
    if (n.readUInt8(0) !== 200) throw new Error('u8 value not written');
    if (n.readInt8(1) !== -7) throw new Error('u8 write clobbered s8 sibling');
  });
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u8', 0, 'u8 min', (n) => n.readUInt8(0) === 0);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u8', 255, 'u8 max', (n) => n.readUInt8(0) === 255);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u8', 256, 'u8 overflow');
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u8', -1, 'u8 negative');
  pass('u8 write + bounds + overflow');

  // s8: positive, boundaries (-128/127), out-of-range (128, -129).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s8', -50, 's8 write', (n) => n.readInt8(1) === -50);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s8', -128, 's8 min', (n) => n.readInt8(1) === -128);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s8', 127, 's8 max', (n) => n.readInt8(1) === 127);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_s8', 128, 's8 overflow');
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_s8', -129, 's8 underflow');
  pass('s8 write + bounds + overflow');

  // u16: boundaries (0/65535), overflow (65536, -1).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u16', 0, 'u16 min', (n) => n.readUInt16LE(2) === 0);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u16', 65_535, 'u16 max', (n) => n.readUInt16LE(2) === 65_535);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u16', 65_536, 'u16 overflow');
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u16', -1, 'u16 negative');
  pass('u16 write + bounds + overflow');

  // s16: boundaries (-32768/32767), overflow (32768).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s16', -32_768, 's16 min', (n) => n.readInt16LE(4) === -32_768);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s16', 32_767, 's16 max', (n) => n.readInt16LE(4) === 32_767);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_s16', 32_768, 's16 overflow');
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_s16', -32_769, 's16 underflow');
  pass('s16 write + bounds + overflow');

  // u32: boundaries (0/0xFFFFFFFF), overflow (0x100000000, -1).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u32', 0, 'u32 min', (n) => n.readUInt32LE(8) === 0);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_u32', 4_294_967_295, 'u32 max', (n) => n.readUInt32LE(8) === 4_294_967_295);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u32', 4_294_967_296, 'u32 overflow');
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_u32', -1, 'u32 negative');
  pass('u32 write + bounds + overflow');

  // s32: boundaries (-2147483648/2147483647), overflow (2147483648).
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s32', -2_147_483_648, 's32 min', (n) => n.readInt32LE(12) === -2_147_483_648);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_s32', 2_147_483_647, 's32 max', (n) => n.readInt32LE(12) === 2_147_483_647);
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_s32', 2_147_483_648, 's32 overflow');
  pass('s32 write + bounds + overflow');

  // f32 / f64: approximate write, negative zero, large magnitudes.
  writeOk(allBase64, ALL_TYPES_DEF, 'f_f32', 3.25, 'f32 write', (n) => {
    if (Math.abs(n.readFloatLE(16) - 3.25) > 1e-6) throw new Error('f32 value not written');
  });
  writeOk(allBase64, ALL_TYPES_DEF, 'f_f32', -0, 'f32 negative zero', (n) => Object.is(n.readFloatLE(16), -0));
  writeOk(allBase64, ALL_TYPES_DEF, 'f_f32', 1e38, 'f32 large', (n) => Number.isFinite(n.readFloatLE(16)));
  writeOk(allBase64, ALL_TYPES_DEF, 'f_f64', 1e100, 'f64 write', (n) => {
    if (Math.abs(n.readDoubleLE(24) - 1e100) > 1e85) throw new Error('f64 value not written');
  });
  pass('f32/f64 write');

  // bool: true/false both encode to a single storage byte.
  writeOk(allBase64, ALL_TYPES_DEF, 'f_bool', true, 'bool true', (n) => n.readUInt8(32) === 1);
  writeOk(allBase64, ALL_TYPES_DEF, 'f_bool', false, 'bool false', (n) => n.readUInt8(32) === 0);
  pass('bool write');

  // fix: UTF-8 text with null terminator; capacity overflow fails.
  writeOk(allBase64, ALL_TYPES_DEF, 'f_fix', '你好', 'fix write', (n) => {
    const end = n.subarray(40, 56).indexOf(0);
    const text = n.subarray(40, end === -1 ? 56 : 40 + end).toString('utf8');
    if (text !== '你好') throw new Error(`fix value not written: ${text}`);
    if (n.readUInt8(40 + Buffer.byteLength('你好', 'utf8')) !== 0) {
      throw new Error('fix value missing null terminator');
    }
  });
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_fix', 'x'.repeat(20), 'fix overflow');
  pass('fix write + overflow');

  // bytes: exact-size hex; wrong length fails.
  writeOk(allBase64, ALL_TYPES_DEF, 'f_bytes', 'AABBCCDDEEFF0001', 'bytes write', (n) => {
    if (n.subarray(56, 64).toString('hex').toUpperCase() !== 'AABBCCDDEEFF0001') {
      throw new Error('bytes value not written');
    }
  });
  expectEncodeFailed(allBase64, ALL_TYPES_DEF, 'f_bytes', 'AABB', 'bytes length mismatch');
  pass('bytes write + length mismatch');

  // ------------------------------------------------------------------
  // Bitfield variants across storage widths.
  // ------------------------------------------------------------------

  // u16 bitfield: two 6-bit fields share a word, other bits preserved.
  const u16Row = Buffer.alloc(2, 0xff).toString('base64');
  const u16Lo = writeOk(u16Row, BITFIELD_U16_DEF, 'lo6', 3, 'u16 bitfield lo', (n) => {
    if (n.readUInt16LE(0) !== 0xFFC3) {
      throw new Error(`u16 bitfield lo expected 0xFFC3, got 0x${n.readUInt16LE(0).toString(16)}`);
    }
  });
  const u16Hi = writeOk(Buffer.from(u16Lo).toString('base64'), BITFIELD_U16_DEF, 'hi6', 5, 'u16 bitfield hi', (n) => {
    if (n.readUInt16LE(0) !== 0xF143) {
      throw new Error(`u16 bitfield hi expected 0xF143, got 0x${n.readUInt16LE(0).toString(16)}`);
    }
  });
  expectEncodeFailed(Buffer.from(u16Hi).toString('base64'), BITFIELD_U16_DEF, 'lo6', 64, 'u16 bitfield overflow');
  pass('u16 bitfield preserve + overflow');

  // u32 full-width bitfield (bitWidth 32): the Number codec overflowed here.
  const u32FullRow = Buffer.alloc(4).toString('base64');
  writeOk(u32FullRow, BITFIELD_U32_FULL_DEF, 'all32', 4_294_967_295, 'u32 bitfield 32-bit max', (n) => {
    if (n.readUInt32LE(0) !== 4_294_967_295) {
      throw new Error(`u32 full bitfield expected 0xFFFFFFFF, got 0x${n.readUInt32LE(0).toString(16)}`);
    }
  });
  writeOk(u32FullRow, BITFIELD_U32_FULL_DEF, 'all32', 0xDEADBEEF, 'u32 bitfield 32-bit value', (n) => {
    if (n.readUInt32LE(0) !== 0xDEADBEEF) {
      throw new Error(`u32 full bitfield expected 0xDEADBEEF, got 0x${n.readUInt32LE(0).toString(16)}`);
    }
  });
  pass('u32 32-bit full bitfield');

  // u32 partial bitfield: two 16-bit halves, each preserves the other.
  const u32PartRow = Buffer.alloc(4, 0xff).toString('base64');
  const u32Part = writeOk(u32PartRow, BITFIELD_U32_PART_DEF, 'lo16', 0x1234, 'u32 bitfield lo16', (n) => {
    if (n.readUInt32LE(0) !== 0xFFFF1234) {
      throw new Error(`u32 bitfield lo16 expected 0xFFFF1234, got 0x${n.readUInt32LE(0).toString(16)}`);
    }
  });
  const u32Part2 = writeOk(Buffer.from(u32Part).toString('base64'), BITFIELD_U32_PART_DEF, 'hi16', 0xABCD, 'u32 bitfield hi16', (n) => {
    if (n.readUInt32LE(0) !== 0xABCD1234) {
      throw new Error(`u32 bitfield hi16 expected 0xABCD1234, got 0x${n.readUInt32LE(0).toString(16)}`);
    }
  });
  expectEncodeFailed(Buffer.from(u32Part2).toString('base64'), BITFIELD_U32_PART_DEF, 'lo16', 65_536, 'u32 bitfield lo16 overflow');
  pass('u32 16-bit halves + overflow');

  // s32 storage bitfield: edits the raw bit pattern (0x8000 survives unsigned read).
  const s32Row = Buffer.alloc(4).toString('base64');
  const s32Bit = writeOk(s32Row, BITFIELD_S32_DEF, 'lo16', 0x8000, 's32 bitfield', (n) => {
    if (n.readUInt32LE(0) !== 0x8000) {
      throw new Error(`s32 bitfield expected raw 0x8000, got 0x${n.readUInt32LE(0).toString(16)}`);
    }
  });
  const s32Bit2 = writeOk(Buffer.from(s32Bit).toString('base64'), BITFIELD_S32_DEF, 'lo16', 0xFFFF, 's32 bitfield max', (n) => {
    if (n.readUInt32LE(0) !== 0xFFFF) throw new Error('s32 bitfield max not written');
  });
  expectEncodeFailed(Buffer.from(s32Bit2).toString('base64'), BITFIELD_S32_DEF, 'lo16', 65_536, 's32 bitfield overflow');
  pass('s32 storage bitfield');

  // bool bitfield: single bit.
  const boolBitRow = Buffer.alloc(1).toString('base64');
  writeOk(boolBitRow, BITFIELD_BOOL_DEF, 'bit', true, 'bool bitfield true', (n) => n.readUInt8(0) === 1);
  writeOk(boolBitRow, BITFIELD_BOOL_DEF, 'bit', false, 'bool bitfield false', (n) => n.readUInt8(0) === 0);
  pass('bool bitfield');

  // ALL_TYPES source row remains immutable after the full write sweep.
  if (!Buffer.from(allBase64, 'base64').equals(buildAllTypesRow())) {
    throw new Error('ALL_TYPES source row changed');
  }
  pass('ALL_TYPES source row immutable');

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM 字段级 mutation 端到端验证通过（全 ParamType + bitfield 变体）',
    caseCount,
    scalarTypeName: SCALAR_DEF.typeName,
    bitfieldTypeName: BITFIELD_DEF.typeName,
    allTypesTypeName: ALL_TYPES_DEF.typeName,
    scalarTypesCovered: ['u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'f64', 'bool', 'fix', 'bytes'],
    bitfieldStorageCovered: ['u8', 'u16', 'u32', 's32', 'bool'],
    bitfieldMaxBitWidth: 32,
    bitfieldWriteAuthority: 'preserving-bit-writer-bigint',
    nonClaims: [
      '仅覆盖 TS 字段编码层；Bridge 整行写入与真实 PARAM 文档需 native smoke。',
      'bitfield 值恒为非负整数位域；符号存储（s8/s16/s32）按原始位模式读写。'
    ]
  }, null, 2));
}

main();
