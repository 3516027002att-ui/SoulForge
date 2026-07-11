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
    fields: [
      { id: 'f_id', name: 'idHint', type: 's32', offset: 0, size: 4 },
      { id: 'f_hp', name: 'hp', type: 'u16', offset: 4, size: 2, min: 0, max: 9999 },
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

  console.log(JSON.stringify({
    ok: true,
    message: 'paramdef 字段布局校验/解码/编码验证通过',
    typeName: def.typeName,
    fieldCount: def.fields.length,
    decodedHp: hp?.value,
    encodedHp: mutated.next.readUInt16LE(4),
    overlapBlocked: true
  }, null, 2));
}

main();
