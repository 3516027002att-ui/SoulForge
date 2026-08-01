/**
 * PARAM field-level mutation end-to-end smoke:
 * applyParamFieldMutation covers scalar writes, preserving bitfield writes,
 * and structured failure-close error codes, while leaving the source row
 * unchanged. The Bridge is not involved here — this validates the TS field
 * encoding layer that the IPC/preload path feeds into.
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

function buildScalarRow(): Buffer {
  const row = Buffer.alloc(16);
  row.writeInt32LE(42, 0);
  row.writeUInt16LE(100, 4);
  row.writeUInt8(1, 6);
  row.writeFloatLE(1.5, 8);
  return row;
}

function expectCode(result: { ok: boolean; code?: string }, code: string, label: string): void {
  if (result.ok || result.code !== code) {
    throw new Error(
      `${label}: expected code ${code}, got ${result.ok ? 'ok' : result.code}`
    );
  }
}

function main(): void {
  let caseCount = 0;
  const pass = (label: string): void => {
    caseCount += 1;
    void label;
  };

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

  // 8. Out-of-range values close with a structured code:
  //    bitfield width overflow and scalar type overflow both surface as
  //    PARAMDEF_ENCODE_FAILED with a diagnostic message.
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

  console.log(JSON.stringify({
    ok: true,
    message: 'PARAM 字段级 mutation 端到端验证通过',
    caseCount,
    scalarTypeName: SCALAR_DEF.typeName,
    bitfieldTypeName: BITFIELD_DEF.typeName,
    bitfieldWriteAuthority: 'preserving-bit-writer',
    nonClaims: [
      '仅覆盖 TS 字段编码层；Bridge 整行写入与真实 PARAM 文档需 native smoke。'
    ]
  }, null, 2));
}

main();
