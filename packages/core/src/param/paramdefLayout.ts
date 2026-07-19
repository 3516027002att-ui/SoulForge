/**
 * Apply / validate user-derived paramdef layouts against raw PARAM row bytes.
 * Does not parse native .paramdef binaries — that remains Bridge work.
 */

import type {
  ParamDefDocument,
  ParamEnumDef,
  ParamFieldDef,
  ParamFieldScalarType,
  ParamFieldValue
} from '@soulforge/shared';

const MAX_ROW_DATA_SIZE = 65_536;
const SCALAR_SIZES: Partial<Record<ParamFieldScalarType, number>> = {
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
const VALID_TYPES = new Set<ParamFieldScalarType>([
  'u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'f64', 'bool', 'fix', 'bytes'
]);
const INTEGER_TYPES = new Set<ParamFieldScalarType>(['u8', 's8', 'u16', 's16', 'u32', 's32']);
const SIGNED_TYPES = new Set<ParamFieldScalarType>(['s8', 's16', 's32']);
const NUMERIC_TYPES = new Set<ParamFieldScalarType>([
  'u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'f64'
]);

export interface ParamDefValidationResult {
  ok: boolean;
  diagnostics: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
}

type NormalizedValue =
  | { ok: true; value: number | string | boolean }
  | { ok: false; message: string };

export function validateParamDef(doc: ParamDefDocument): ParamDefValidationResult {
  const diagnostics: ParamDefValidationResult['diagnostics'] = [];
  const error = (code: string, message: string): void => {
    diagnostics.push({ severity: 'error', code, message });
  };

  if (doc.schemaVersion !== 1) {
    error('PARAMDEF_SCHEMA_VERSION_UNSUPPORTED', '参数结构定义 schemaVersion 必须为 1。');
  }
  if (typeof doc.typeName !== 'string' || !doc.typeName.trim()) {
    error('PARAMDEF_TYPE_NAME_EMPTY', '参数结构定义缺少类型名。');
  }
  if (!Number.isSafeInteger(doc.version) || doc.version < 0) {
    error('PARAMDEF_VERSION_INVALID', `版本 ${doc.version} 必须是非负安全整数。`);
  }
  const rowSizeValid = Number.isSafeInteger(doc.rowDataSize)
    && doc.rowDataSize > 0
    && doc.rowDataSize <= MAX_ROW_DATA_SIZE;
  if (!rowSizeValid) {
    error('PARAMDEF_ROW_SIZE_INVALID', `行大小 ${doc.rowDataSize} 无效。`);
  }
  if (!Array.isArray(doc.fields) || doc.fields.length === 0) {
    error('PARAMDEF_FIELDS_EMPTY', '参数结构定义至少需要一个字段。');
  }

  const enums = validateEnums(doc.enums ?? [], error);
  const fieldIds = new Set<string>();
  const fieldNames = new Set<string>();
  const occupiedBits = rowSizeValid
    ? new Array<string | null>(doc.rowDataSize * 8).fill(null)
    : [];

  for (const field of doc.fields ?? []) {
    if (typeof field.id !== 'string' || !field.id.trim()) {
      error('PARAMDEF_FIELD_ID_EMPTY', '字段 id 不能为空。');
    } else if (fieldIds.has(field.id)) {
      error('PARAMDEF_FIELD_ID_DUPLICATE', `字段 id ${field.id} 重复。`);
    } else {
      fieldIds.add(field.id);
    }
    if (typeof field.name !== 'string' || !field.name.trim()) {
      error('PARAMDEF_FIELD_NAME_EMPTY', `字段 ${field.id || '<unknown>'} 名称不能为空。`);
    } else if (fieldNames.has(field.name)) {
      error('PARAMDEF_FIELD_NAME_DUPLICATE', `字段名称 ${field.name} 重复。`);
    } else {
      fieldNames.add(field.name);
    }
    if (!VALID_TYPES.has(field.type)) {
      error('PARAMDEF_FIELD_TYPE_UNSUPPORTED', `字段 ${field.name} 类型 ${String(field.type)} 不受支持。`);
      continue;
    }

    const expectedSize = SCALAR_SIZES[field.type];
    if (expectedSize !== undefined && field.size !== expectedSize) {
      error(
        'PARAMDEF_FIELD_SIZE_MISMATCH',
        `字段 ${field.name} 类型 ${field.type} 期望 size=${expectedSize}，实际 ${field.size}。`
      );
    }
    const rangeValid = Number.isSafeInteger(field.offset)
      && Number.isSafeInteger(field.size)
      && field.offset >= 0
      && field.size > 0
      && rowSizeValid
      && field.offset + field.size <= doc.rowDataSize;
    if (!rangeValid) {
      error(
        'PARAMDEF_FIELD_RANGE',
        `字段 ${field.name} 越界 offset=${field.offset} size=${field.size} row=${doc.rowDataSize}。`
      );
      continue;
    }

    if (field.alignment !== undefined) {
      const alignmentValid = Number.isSafeInteger(field.alignment)
        && field.alignment > 0
        && (field.alignment & (field.alignment - 1)) === 0;
      if (!alignmentValid) {
        error('PARAMDEF_FIELD_ALIGNMENT_INVALID', `字段 ${field.name} alignment 必须是正的 2 次幂。`);
      } else if (field.offset % field.alignment !== 0) {
        error(
          'PARAMDEF_FIELD_ALIGNMENT_MISMATCH',
          `字段 ${field.name} offset=${field.offset} 未按 ${field.alignment} 字节对齐。`
        );
      }
    }

    validateFieldConstraints(field, enums, error);
    const bitRange = field.bitfield
      ? validateBitfield(field, error)
      : { start: field.offset * 8, width: field.size * 8 };
    if (!bitRange) continue;
    for (let index = bitRange.start; index < bitRange.start + bitRange.width; index += 1) {
      const previous = occupiedBits[index];
      if (previous && previous !== field.id) {
        error(
          'PARAMDEF_FIELD_OVERLAP',
          `字段 ${field.name} 与 ${previous} 在 bit ${index} 重叠。`
        );
        break;
      }
      occupiedBits[index] = field.id;
    }

    if (field.defaultValue !== undefined) {
      const normalized = normalizeValue(field, field.defaultValue, enums);
      if (!normalized.ok) {
        error('PARAMDEF_DEFAULT_INVALID', `字段 ${field.name} 默认值无效：${normalized.message}`);
      }
    }
  }
  return { ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'), diagnostics };
}

export function decodeRowFields(rowData: Buffer, def: ParamDefDocument): ParamFieldValue[] {
  return def.fields.map((field) => decodeField(rowData, field));
}

export function encodeFieldMutation(
  rowData: Buffer,
  def: ParamDefDocument,
  fieldId: string,
  value: number | string | boolean
): { ok: true; next: Buffer } | { ok: false; code: string; message: string } {
  const validation = validateParamDef(def);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'PARAMDEF_INVALID',
      message: validation.diagnostics[0]?.message ?? '参数结构定义无效。'
    };
  }
  if (rowData.length !== def.rowDataSize) {
    return {
      ok: false,
      code: 'PARAMDEF_ROW_SIZE_MISMATCH',
      message: `行字节 ${rowData.length} 与结构定义 ${def.rowDataSize} 不一致。`
    };
  }
  const field = def.fields.find((candidate) => candidate.id === fieldId);
  if (!field) {
    return { ok: false, code: 'PARAMDEF_FIELD_NOT_FOUND', message: `字段 ${fieldId} 不存在。` };
  }
  const normalized = normalizeValue(field, value, enumMap(def.enums ?? []));
  if (!normalized.ok) {
    return { ok: false, code: 'PARAMDEF_VALUE_INVALID', message: normalized.message };
  }
  const next = Buffer.from(rowData);
  try {
    writeField(next, field, normalized.value);
  } catch (error) {
    return {
      ok: false,
      code: 'PARAMDEF_ENCODE_FAILED',
      message: error instanceof Error ? error.message : '编码失败。'
    };
  }
  return { ok: true, next };
}

function validateEnums(
  definitions: ParamEnumDef[],
  error: (code: string, message: string) => void
): Map<string, ParamEnumDef> {
  const result = new Map<string, ParamEnumDef>();
  const names = new Set<string>();
  for (const definition of definitions) {
    if (!definition.id?.trim()) {
      error('PARAMDEF_ENUM_ID_EMPTY', '枚举 id 不能为空。');
      continue;
    }
    if (result.has(definition.id)) {
      error('PARAMDEF_ENUM_ID_DUPLICATE', `枚举 id ${definition.id} 重复。`);
      continue;
    }
    if (!definition.name?.trim()) {
      error('PARAMDEF_ENUM_NAME_EMPTY', `枚举 ${definition.id} 名称不能为空。`);
    } else if (names.has(definition.name)) {
      error('PARAMDEF_ENUM_NAME_DUPLICATE', `枚举名称 ${definition.name} 重复。`);
    } else {
      names.add(definition.name);
    }
    const values = new Set<number>();
    const labels = new Set<string>();
    for (const item of definition.values ?? []) {
      if (!Number.isSafeInteger(item.value)) {
        error('PARAMDEF_ENUM_VALUE_INVALID', `枚举 ${definition.id} 含非安全整数值。`);
      } else if (values.has(item.value)) {
        error('PARAMDEF_ENUM_VALUE_DUPLICATE', `枚举 ${definition.id} 的值 ${item.value} 重复。`);
      } else {
        values.add(item.value);
      }
      if (!item.label?.trim()) {
        error('PARAMDEF_ENUM_LABEL_EMPTY', `枚举 ${definition.id} 的值 ${item.value} 缺少标签。`);
      } else if (labels.has(item.label)) {
        error('PARAMDEF_ENUM_LABEL_DUPLICATE', `枚举 ${definition.id} 的标签 ${item.label} 重复。`);
      } else {
        labels.add(item.label);
      }
    }
    result.set(definition.id, definition);
  }
  return result;
}

function enumMap(definitions: ParamEnumDef[]): Map<string, ParamEnumDef> {
  return new Map(definitions.map((definition) => [definition.id, definition]));
}

function validateFieldConstraints(
  field: ParamFieldDef,
  enums: Map<string, ParamEnumDef>,
  error: (code: string, message: string) => void
): void {
  if (field.enumRef) {
    if (!NUMERIC_TYPES.has(field.type)) {
      error('PARAMDEF_ENUM_TYPE_INVALID', `字段 ${field.name} 的类型 ${field.type} 不能引用枚举。`);
    }
    if (!enums.has(field.enumRef)) {
      error('PARAMDEF_ENUM_NOT_FOUND', `字段 ${field.name} 引用的枚举 ${field.enumRef} 不存在。`);
    }
  }
  if (field.min !== undefined && !Number.isFinite(field.min)) {
    error('PARAMDEF_MIN_INVALID', `字段 ${field.name} min 必须是有限数。`);
  }
  if (field.max !== undefined && !Number.isFinite(field.max)) {
    error('PARAMDEF_MAX_INVALID', `字段 ${field.name} max 必须是有限数。`);
  }
  if ((field.min !== undefined || field.max !== undefined) && !NUMERIC_TYPES.has(field.type)) {
    error('PARAMDEF_RANGE_TYPE_INVALID', `字段 ${field.name} 的类型 ${field.type} 不能声明 min/max。`);
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    error('PARAMDEF_RANGE_INVALID', `字段 ${field.name} min 不能大于 max。`);
  }
}

function validateBitfield(
  field: ParamFieldDef,
  error: (code: string, message: string) => void
): { start: number; width: number } | null {
  const bitfield = field.bitfield!;
  if (!INTEGER_TYPES.has(field.type) && field.type !== 'bool') {
    error('PARAMDEF_BITFIELD_TYPE_INVALID', `字段 ${field.name} 的类型 ${field.type} 不能作为 bitfield。`);
    return null;
  }
  if (!Number.isSafeInteger(bitfield.bitOffset)
    || !Number.isSafeInteger(bitfield.bitWidth)
    || bitfield.bitOffset < 0
    || bitfield.bitWidth <= 0
    || bitfield.bitOffset + bitfield.bitWidth > field.size * 8) {
    error('PARAMDEF_BITFIELD_RANGE_INVALID', `字段 ${field.name} bitfield 范围无效。`);
    return null;
  }
  if (field.type === 'bool' && bitfield.bitWidth !== 1) {
    error('PARAMDEF_BOOL_BITFIELD_WIDTH_INVALID', `布尔字段 ${field.name} bitWidth 必须为 1。`);
    return null;
  }
  return {
    start: field.offset * 8 + bitfield.bitOffset,
    width: bitfield.bitWidth
  };
}

function normalizeValue(
  field: ParamFieldDef,
  input: number | string | boolean,
  enums: Map<string, ParamEnumDef>
): NormalizedValue {
  if (field.type === 'bool') {
    const value = parseBoolean(input);
    if (value === undefined) return { ok: false, message: '布尔值只接受 true/false 或 0/1。' };
    return { ok: true, value };
  }
  if (field.type === 'fix') {
    if (typeof input !== 'string') return { ok: false, message: 'fix 字段需要字符串。' };
    if (Buffer.byteLength(input, 'utf8') + 1 > field.size) {
      return { ok: false, message: `字符串超过字段容量 ${field.size}。` };
    }
    return { ok: true, value: input };
  }
  if (field.type === 'bytes') {
    if (typeof input !== 'string') return { ok: false, message: 'bytes 字段需要十六进制字符串。' };
    const compact = input.replace(/\s+/g, '');
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(compact) || compact.length / 2 !== field.size) {
      return { ok: false, message: `bytes 字段需要恰好 ${field.size} 字节十六进制。` };
    }
    return { ok: true, value: compact.toLowerCase() };
  }

  const numeric = parseNumber(input);
  if (numeric === undefined) return { ok: false, message: '字段需要有限数值。' };
  if (INTEGER_TYPES.has(field.type) && !Number.isSafeInteger(numeric)) {
    return { ok: false, message: '整数字段需要安全整数。' };
  }
  if (field.type === 'f32' && !Number.isFinite(Math.fround(numeric))) {
    return { ok: false, message: '数值超出 f32 范围。' };
  }

  const range = numericRange(field);
  if (numeric < range.min || numeric > range.max) {
    return { ok: false, message: `数值 ${numeric} 超出允许范围 ${range.min}..${range.max}。` };
  }
  if (field.min !== undefined && numeric < field.min) {
    return { ok: false, message: `数值 ${numeric} 小于最小值 ${field.min}。` };
  }
  if (field.max !== undefined && numeric > field.max) {
    return { ok: false, message: `数值 ${numeric} 大于最大值 ${field.max}。` };
  }
  if (field.enumRef) {
    const definition = enums.get(field.enumRef);
    if (!definition?.values.some((item) => item.value === numeric)) {
      return { ok: false, message: `数值 ${numeric} 不在枚举 ${field.enumRef} 中。` };
    }
  }
  return { ok: true, value: numeric };
}

function numericRange(field: ParamFieldDef): { min: number; max: number } {
  if (field.bitfield) {
    const width = field.bitfield.bitWidth;
    return SIGNED_TYPES.has(field.type)
      ? { min: -(2 ** (width - 1)), max: 2 ** (width - 1) - 1 }
      : { min: 0, max: 2 ** width - 1 };
  }
  switch (field.type) {
    case 'u8': return { min: 0, max: 0xff };
    case 's8': return { min: -0x80, max: 0x7f };
    case 'u16': return { min: 0, max: 0xffff };
    case 's16': return { min: -0x8000, max: 0x7fff };
    case 'u32': return { min: 0, max: 0xffff_ffff };
    case 's32': return { min: -0x8000_0000, max: 0x7fff_ffff };
    case 'f32': return { min: -3.4028234663852886e38, max: 3.4028234663852886e38 };
    case 'f64': return { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };
    default: return { min: -Number.MAX_VALUE, max: Number.MAX_VALUE };
  }
}

function parseNumber(input: number | string | boolean): number | undefined {
  if (typeof input === 'boolean') return undefined;
  if (typeof input === 'string' && !input.trim()) return undefined;
  const value = typeof input === 'number' ? input : Number(input);
  return Number.isFinite(value) ? value : undefined;
}

function parseBoolean(input: number | string | boolean): boolean | undefined {
  if (typeof input === 'boolean') return input;
  if (input === 0 || input === '0' || input === 'false') return false;
  if (input === 1 || input === '1' || input === 'true') return true;
  return undefined;
}

function decodeField(rowData: Buffer, field: ParamFieldDef): ParamFieldValue {
  if (field.offset < 0 || field.size <= 0 || field.offset + field.size > rowData.length) {
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
    if (field.bitfield) return base(field, decodeBitfield(slice, field));
    switch (field.type) {
      case 'u8': return base(field, rowData.readUInt8(field.offset));
      case 's8': return base(field, rowData.readInt8(field.offset));
      case 'u16': return base(field, rowData.readUInt16LE(field.offset));
      case 's16': return base(field, rowData.readInt16LE(field.offset));
      case 'u32': return base(field, rowData.readUInt32LE(field.offset));
      case 's32': return base(field, rowData.readInt32LE(field.offset));
      case 'f32': return base(field, rowData.readFloatLE(field.offset));
      case 'f64': return base(field, rowData.readDoubleLE(field.offset));
      case 'bool': return base(field, rowData.readUInt8(field.offset) !== 0);
      case 'fix': {
        const end = slice.indexOf(0);
        const text = slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
        return base(field, text, slice.toString('hex'));
      }
      case 'bytes': return base(field, null, slice.toString('hex'));
      default: return base(field, null, slice.toString('hex'), '未知类型');
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
  if (field.bitfield) {
    writeBitfield(buf.subarray(field.offset, field.offset + field.size), field, value);
    return;
  }
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
    case 'fix': {
      const encoded = Buffer.from(String(value), 'utf8');
      buf.fill(0, field.offset, field.offset + field.size);
      encoded.copy(buf, field.offset);
      return;
    }
    case 'bytes': Buffer.from(String(value), 'hex').copy(buf, field.offset); return;
    default: throw new Error('不支持的字段类型。');
  }
}

function decodeBitfield(slice: Buffer, field: ParamFieldDef): number | boolean {
  const bitfield = field.bitfield!;
  const mask = (1n << BigInt(bitfield.bitWidth)) - 1n;
  const raw = (readUnsignedLittleEndian(slice) >> BigInt(bitfield.bitOffset)) & mask;
  if (field.type === 'bool') return raw !== 0n;
  if (SIGNED_TYPES.has(field.type)) {
    const sign = 1n << BigInt(bitfield.bitWidth - 1);
    return Number((raw & sign) === 0n ? raw : raw - (1n << BigInt(bitfield.bitWidth)));
  }
  return Number(raw);
}

function writeBitfield(slice: Buffer, field: ParamFieldDef, value: number | string | boolean): void {
  const bitfield = field.bitfield!;
  const width = BigInt(bitfield.bitWidth);
  const offset = BigInt(bitfield.bitOffset);
  const valueMask = (1n << width) - 1n;
  const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  const encoded = numeric < 0 ? (1n << width) + BigInt(numeric) : BigInt(numeric);
  const shiftedMask = valueMask << offset;
  const current = readUnsignedLittleEndian(slice);
  writeUnsignedLittleEndian(slice, (current & ~shiftedMask) | ((encoded & valueMask) << offset));
}

function readUnsignedLittleEndian(bytes: Buffer): bigint {
  let result = 0n;
  for (let index = 0; index < bytes.length; index += 1) {
    result |= BigInt(bytes[index] ?? 0) << BigInt(index * 8);
  }
  return result;
}

function writeUnsignedLittleEndian(bytes: Buffer, value: bigint): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number((value >> BigInt(index * 8)) & 0xffn);
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
