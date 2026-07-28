/**
 * User-derived paramdef layout decode/encode/overlap validation.
 */
import type { ParamDefDocument } from '@soulforge/shared';
import {
  decodeRowFields,
  encodeFieldMutation,
  validateParamDef
} from '../param/paramdefLayout.js';

function main(): void {
  const def: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'DEMO_PARAM_ST',
    version: 1,
    rowDataSize: 16,
    origin: 'fixture',
    enums: [
      {
        id: 'hp_kind',
        name: 'HP kind',
        values: [
          { value: 0, label: 'Empty' },
          { value: 100, label: 'Default' }
        ]
      }
    ],
    fields: [
      { id: 'f_id', name: 'idHint', type: 's32', offset: 0, size: 4 },
      {
        id: 'f_hp',
        name: 'hp',
        type: 'u16',
        offset: 4,
        size: 2,
        alignment: 2,
        min: 0,
        max: 9999,
        defaultValue: 100,
        enumRef: 'hp_kind'
      },
      { id: 'f_flag', name: 'enabled', type: 'bool', offset: 6, size: 1 },
      { id: 'f_rate', name: 'rate', type: 'f32', offset: 8, size: 4 }
    ]
  };

  const valid = validateParamDef(def);
  if (!valid.ok) {
    throw new Error(`expected valid def: ${JSON.stringify(valid.diagnostics)}`);
  }

  const overlap: ParamDefDocument = {
    ...def,
    fields: [
      ...def.fields,
      { id: 'bad', name: 'overlap', type: 'u16', offset: 4, size: 2 }
    ]
  };
  const invalid = validateParamDef(overlap);
  if (invalid.ok || !invalid.diagnostics.some((d) => d.code === 'PARAMDEF_FIELD_OVERLAP')) {
    throw new Error('expected overlap diagnostic');
  }

  expectDiagnostic(
    { ...def, fields: [...def.fields, { ...def.fields[0]!, name: 'duplicate' }] },
    'PARAMDEF_FIELD_ID_DUPLICATE'
  );
  expectDiagnostic(
    { ...def, fields: def.fields.map((field) => field.id === 'f_hp' ? { ...field, enumRef: 'missing' } : field) },
    'PARAMDEF_ENUM_REF_MISSING'
  );
  expectDiagnostic(
    { ...def, fields: def.fields.map((field) => field.id === 'f_hp' ? { ...field, alignment: 1_048_576 } : field) },
    'PARAMDEF_FIELD_ALIGNMENT_INVALID'
  );
  expectDiagnostic(
    { ...def, fields: def.fields.map((field) => field.id === 'f_hp' ? { ...field, defaultValue: 10_000 } : field) },
    'PARAMDEF_FIELD_DEFAULT_OUT_OF_RANGE'
  );

  const bitfields: ParamDefDocument = {
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
  if (!validateParamDef(bitfields).ok) {
    throw new Error('expected non-overlapping bitfields to share storage');
  }
  expectDiagnostic(
    {
      ...bitfields,
      fields: [
        bitfields.fields[0]!,
        { ...bitfields.fields[1]!, bitfield: { bitOffset: 3, bitWidth: 4 } }
      ]
    },
    'PARAMDEF_FIELD_OVERLAP'
  );

  const malformed = {
    ...def,
    fields: [null, { ...def.fields[0], id: 42, unexpectedLayout: true }]
  } as unknown as ParamDefDocument;
  const malformedResult = validateParamDef(malformed);
  if (malformedResult.ok
    || !malformedResult.diagnostics.some((diagnostic) => diagnostic.code === 'PARAMDEF_FIELD_NOT_OBJECT')
    || !malformedResult.diagnostics.some((diagnostic) => diagnostic.code === 'PARAMDEF_VALUE_TYPE_INVALID')
    || !malformedResult.diagnostics.some((diagnostic) => diagnostic.code === 'PARAMDEF_UNKNOWN_FIELD')) {
    throw new Error(`malformed nested fields must fail closed: ${JSON.stringify(malformedResult)}`);
  }

  const row = Buffer.alloc(16);
  row.writeInt32LE(42, 0);
  row.writeUInt16LE(100, 4);
  row.writeUInt8(1, 6);
  row.writeFloatLE(1.5, 8);

  const fields = decodeRowFields(row, def);
  const hp = fields.find((f) => f.name === 'hp');
  const rate = fields.find((f) => f.name === 'rate');
  if (hp?.value !== 100 || Math.abs(Number(rate?.value) - 1.5) > 1e-6) {
    throw new Error(`decode failed: ${JSON.stringify(fields)}`);
  }

  const mutated = encodeFieldMutation(row, def, 'f_hp', 250);
  if (!mutated.ok) throw new Error(mutated.message);
  if (mutated.next.readUInt16LE(4) !== 250) {
    throw new Error('encode did not write hp');
  }
  // original unchanged
  if (row.readUInt16LE(4) !== 100) {
    throw new Error('encode mutated original buffer');
  }
  const bitfieldMutation = encodeFieldMutation(Buffer.from([0]), bitfields, 'low', 3);
  if (bitfieldMutation.ok || bitfieldMutation.code !== 'PARAMDEF_BITFIELD_WRITE_UNSUPPORTED') {
    throw new Error('bitfield writes must remain disabled until a preserving writer exists');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'paramdef 字段布局校验/解码/编码验证通过',
    typeName: def.typeName,
    fieldCount: def.fields.length,
    decodedHp: hp?.value,
    encodedHp: mutated.next.readUInt16LE(4),
    overlapBlocked: true,
    malformedNestedInputBlocked: true,
    bitfieldWriteAuthority: 'unsupported'
  }, null, 2));
}

function expectDiagnostic(doc: ParamDefDocument, code: string): void {
  const result = validateParamDef(doc);
  if (result.ok || !result.diagnostics.some((diagnostic) => diagnostic.code === code)) {
    throw new Error(`expected ${code}: ${JSON.stringify(result.diagnostics)}`);
  }
}

main();
