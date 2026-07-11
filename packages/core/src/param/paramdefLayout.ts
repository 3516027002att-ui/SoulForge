/**
 * Apply / validate user-derived paramdef layouts against raw PARAM row bytes.
 * Does not parse native .paramdef binaries — that remains Bridge work.
 */

import type {
  ParamDefDocument,
  ParamFieldDef,
  ParamFieldValue
} from '@soulforge/shared';

const SCALAR_SIZES: Record<string, number> = {
  u8: 1,
  s8: 1,
  u16: 2,
  s16: 2,
  u32: 4,
  s32: 4,
  f32: 4,
  f64: 8,
  bool: 1
};

export interface ParamDefValidationResult {
  ok: boolean;
  diagnostics: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
}

export function validateParamDef(doc: ParamDefDocument): ParamDefValidationResult {
  const diagnostics: ParamDefValidationResult['diagnostics'] = [];
  if (!doc.typeName.trim()) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_TYPE_NAME_EMPTY',
      message: '参数结构定义缺少类型名。'
    });
  }
  if (doc.rowDataSize <= 0 || doc.rowDataSize > 65536) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_ROW_SIZE_INVALID',
      message: `行大小 ${doc.rowDataSize} 无效。`
    });
  }
  const occupied = new Array<string | null>(doc.rowDataSize).fill(null);
  for (const field of doc.fields) {
    const expected = SCALAR_SIZES[field.type];
    if (expected !== undefined && field.size !== expected && field.type !== 'bytes' && field.type !== 'fix') {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_SIZE_MISMATCH',
        message: `字段 ${field.name} 类型 ${field.type} 期望 size=${expected}，实际 ${field.size}。`
      });
    }
    if (field.offset < 0 || field.size <= 0 || field.offset + field.size > doc.rowDataSize) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_RANGE',
        message: `字段 ${field.name} 越界 offset=${field.offset} size=${field.size} row=${doc.rowDataSize}。`
      });
      continue;
    }
    for (let i = field.offset; i < field.offset + field.size; i += 1) {
      const prev = occupied[i];
      if (prev && prev !== field.id) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_FIELD_OVERLAP',
          message: `字段 ${field.name} 与 ${prev} 在偏移 ${i} 重叠。`
        });
        break;
      }
      occupied[i] = field.id;
    }
  }
  return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
}

export function decodeRowFields(
  rowData: Buffer,
  def: ParamDefDocument
): ParamFieldValue[] {
  return def.fields.map((field) => decodeField(rowData, field));
}

export function encodeFieldMutation(
  rowData: Buffer,
  def: ParamDefDocument,
  fieldId: string,
  value: number | string | boolean
): { ok: true; next: Buffer } | { ok: false; code: string; message: string } {
  const field = def.fields.find((f) => f.id === fieldId);
  if (!field) {
    return { ok: false, code: 'PARAMDEF_FIELD_NOT_FOUND', message: `字段 ${fieldId} 不存在。` };
  }
  if (field.offset + field.size > rowData.length) {
    return { ok: false, code: 'PARAMDEF_ROW_TOO_SHORT', message: '行字节不足以写入字段。' };
  }
  const next = Buffer.from(rowData);
  try {
    writeField(next, field, value);
  } catch (error) {
    return {
      ok: false,
      code: 'PARAMDEF_ENCODE_FAILED',
      message: error instanceof Error ? error.message : '编码失败。'
    };
  }
  return { ok: true, next };
}

function decodeField(rowData: Buffer, field: ParamFieldDef): ParamFieldValue {
  if (field.offset + field.size > rowData.length) {
    return {
      fieldId: field.id,
      name: field.name,
      type: field.type,
      value: null,
      diagnostic: '行字节不足'
    };
  }
  const slice = rowData.subarray(field.offset, field.offset + field.size);
  try {
    switch (field.type) {
      case 'u8':
        return base(field, rowData.readUInt8(field.offset));
      case 's8':
        return base(field, rowData.readInt8(field.offset));
      case 'u16':
        return base(field, rowData.readUInt16LE(field.offset));
      case 's16':
        return base(field, rowData.readInt16LE(field.offset));
      case 'u32':
        return base(field, rowData.readUInt32LE(field.offset));
      case 's32':
        return base(field, rowData.readInt32LE(field.offset));
      case 'f32':
        return base(field, rowData.readFloatLE(field.offset));
      case 'f64':
        return base(field, rowData.readDoubleLE(field.offset));
      case 'bool':
        return base(field, rowData.readUInt8(field.offset) !== 0);
      case 'fix': {
        const end = slice.indexOf(0);
        const text = slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
        return base(field, text, slice.toString('hex'));
      }
      case 'bytes':
        return base(field, null, slice.toString('hex'));
      default:
        return base(field, null, slice.toString('hex'), '未知类型');
    }
  } catch (error) {
    return {
      fieldId: field.id,
      name: field.name,
      type: field.type,
      value: null,
      diagnostic: error instanceof Error ? error.message : '解码失败'
    };
  }
}

function writeField(buf: Buffer, field: ParamFieldDef, value: number | string | boolean): void {
  switch (field.type) {
    case 'u8':
      buf.writeUInt8(Number(value), field.offset);
      return;
    case 's8':
      buf.writeInt8(Number(value), field.offset);
      return;
    case 'u16':
      buf.writeUInt16LE(Number(value), field.offset);
      return;
    case 's16':
      buf.writeInt16LE(Number(value), field.offset);
      return;
    case 'u32':
      buf.writeUInt32LE(Number(value), field.offset);
      return;
    case 's32':
      buf.writeInt32LE(Number(value), field.offset);
      return;
    case 'f32':
      buf.writeFloatLE(Number(value), field.offset);
      return;
    case 'f64':
      buf.writeDoubleLE(Number(value), field.offset);
      return;
    case 'bool':
      buf.writeUInt8(value ? 1 : 0, field.offset);
      return;
    case 'fix': {
      const text = String(value);
      const encoded = Buffer.from(text, 'utf8');
      if (encoded.length + 1 > field.size) {
        throw new Error(`字符串超过字段容量 ${field.size}`);
      }
      buf.fill(0, field.offset, field.offset + field.size);
      encoded.copy(buf, field.offset);
      return;
    }
    case 'bytes': {
      const hex = String(value).replace(/[^0-9a-fA-F]/g, '');
      const bytes = Buffer.from(hex, 'hex');
      if (bytes.length !== field.size) {
        throw new Error(`bytes 字段需要 ${field.size} 字节，得到 ${bytes.length}`);
      }
      bytes.copy(buf, field.offset);
      return;
    }
    default:
      throw new Error(`不支持的字段类型`);
  }
}

function base(
  field: ParamFieldDef,
  value: number | string | boolean | null,
  rawHex?: string,
  diagnostic?: string
): ParamFieldValue {
  return {
    fieldId: field.id,
    name: field.name,
    type: field.type,
    value,
    ...(rawHex ? { rawHex } : {}),
    ...(diagnostic ? { diagnostic } : {})
  };
}
