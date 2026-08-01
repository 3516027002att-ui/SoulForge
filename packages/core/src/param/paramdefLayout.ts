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

const INTEGER_TYPES = new Set(['u8', 's8', 'u16', 's16', 'u32', 's32']);
const NUMERIC_TYPES = new Set([...INTEGER_TYPES, 'f32', 'f64']);
const SCALAR_RANGES: Record<string, readonly [number, number]> = {
  u8: [0, 0xff],
  s8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  s16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  s32: [-0x80000000, 0x7fffffff]
};
const DOCUMENT_KEYS = new Set([
  'schemaVersion',
  'typeName',
  'version',
  'rowDataSize',
  'fields',
  'enums',
  'origin',
  'notes'
]);
const DOCUMENT_REQUIRED_KEYS = new Set([
  'schemaVersion',
  'typeName',
  'version',
  'rowDataSize',
  'fields',
  'origin'
]);
const FIELD_KEYS = new Set([
  'id',
  'name',
  'type',
  'offset',
  'size',
  'alignment',
  'defaultValue',
  'min',
  'max',
  'enumRef',
  'bitfield',
  'description'
]);
const FIELD_REQUIRED_KEYS = new Set(['id', 'name', 'type', 'offset', 'size']);
const ENUM_KEYS = new Set(['id', 'name', 'values']);
const ENUM_VALUE_KEYS = new Set(['value', 'label']);
const BITFIELD_KEYS = new Set(['bitOffset', 'bitWidth']);

export const PARAMDEF_MAX_FIELDS = 16_384;
export const PARAMDEF_MAX_ENUMS = 4_096;
export const PARAMDEF_MAX_ENUM_VALUES = 65_536;

export interface ParamDefValidationResult {
  ok: boolean;
  diagnostics: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
}

export function validateParamDef(doc: ParamDefDocument): ParamDefValidationResult {
  const diagnostics = validateParamDefShape(doc);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (doc.schemaVersion !== 1) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_SCHEMA_UNSUPPORTED',
      message: 'Only ParamDefDocument schemaVersion 1 is supported.'
    });
  }
  if (typeof doc.typeName !== 'string' || !doc.typeName.trim()) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_TYPE_NAME_EMPTY',
      message: 'Param definition typeName is required.'
    });
  }
  if (!Number.isSafeInteger(doc.version) || doc.version < 0 || doc.version > 65_535) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_DATA_VERSION_INVALID',
      message: 'Param data version must be an unsigned 16-bit integer.'
    });
  }
  if (!Number.isSafeInteger(doc.rowDataSize) || doc.rowDataSize <= 0 || doc.rowDataSize > 65_536) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_ROW_SIZE_INVALID',
      message: `Param rowDataSize ${doc.rowDataSize} is invalid.`
    });
  }
  if (!['user-derived', 'fixture', 'imported'].includes(String(doc.origin))) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_ORIGIN_INVALID',
      message: 'Param definition origin is invalid.'
    });
  }

  const enumIds = new Set<string>();
  if (doc.enums !== undefined && !Array.isArray(doc.enums)) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_ENUMS_INVALID',
      message: 'Param definition enums must be an array.'
    });
  }
  for (const enumDef of Array.isArray(doc.enums) ? doc.enums : []) {
    if (!enumDef.id.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_ENUM_ID_EMPTY',
        message: 'Enum id is required.'
      });
    } else if (enumIds.has(enumDef.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_ENUM_ID_DUPLICATE',
        message: `Enum id ${enumDef.id} is duplicated.`
      });
    }
    enumIds.add(enumDef.id);
    if (!enumDef.name.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_ENUM_NAME_EMPTY',
        message: `Enum ${enumDef.id} is missing a display name.`
      });
    }
    const values = new Set<number>();
    for (const entry of enumDef.values) {
      if (!Number.isSafeInteger(entry.value)) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_ENUM_VALUE_INVALID',
          message: `Enum ${enumDef.id} contains a non-integer value.`
        });
      } else if (values.has(entry.value)) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_ENUM_VALUE_DUPLICATE',
          message: `Enum ${enumDef.id} duplicates value ${entry.value}.`
        });
      }
      values.add(entry.value);
      if (!entry.label.trim()) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_ENUM_LABEL_EMPTY',
          message: `Enum ${enumDef.id} value ${entry.value} is missing a label.`
        });
      }
    }
  }

  if (!Array.isArray(doc.fields)) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_FIELDS_INVALID',
      message: 'Param definition fields must be an array.'
    });
    return { ok: false, diagnostics };
  }

  const rowDataSize = Number.isSafeInteger(doc.rowDataSize)
    && doc.rowDataSize > 0
    && doc.rowDataSize <= 65_536
    ? doc.rowDataSize
    : 0;
  const occupiedRanges: ParamBitRange[] = [];
  const fieldIds = new Set<string>();
  for (const field of doc.fields) {
    if (!field.id.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_ID_EMPTY',
        message: 'Field id is required.'
      });
    } else if (fieldIds.has(field.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_ID_DUPLICATE',
        message: `Field id ${field.id} is duplicated.`
      });
    }
    fieldIds.add(field.id);
    if (!field.name.trim()) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_NAME_EMPTY',
        message: `Field ${field.id} is missing a display name.`
      });
    }
    const expected = SCALAR_SIZES[field.type];
    if (expected === undefined && field.type !== 'bytes' && field.type !== 'fix') {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_TYPE_UNSUPPORTED',
        message: `Field ${field.name} has unsupported type ${String(field.type)}.`
      });
    } else if (expected !== undefined && field.size !== expected) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_SIZE_MISMATCH',
        message: `Field ${field.name} type ${field.type} requires size=${expected}; got ${field.size}.`
      });
    }
    const rangeValid = Number.isSafeInteger(field.offset)
      && Number.isSafeInteger(field.size)
      && field.offset >= 0
      && field.size > 0
      && field.offset + field.size <= rowDataSize;
    if (!rangeValid) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_RANGE',
        message: `Field ${field.name} is outside row bounds: offset=${field.offset} size=${field.size} row=${doc.rowDataSize}.`
      });
      continue;
    }

    if (field.alignment !== undefined
      && (!Number.isSafeInteger(field.alignment)
        || field.alignment <= 0
        || field.alignment > Math.min(rowDataSize, 65_536)
        || (field.alignment & (field.alignment - 1)) !== 0
        || field.offset % field.alignment !== 0)) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_ALIGNMENT_INVALID',
        message: `Field ${field.name} has an invalid or unsatisfied alignment.`
      });
    }
    if (field.enumRef !== undefined) {
      if (!INTEGER_TYPES.has(field.type)) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_ENUM_FIELD_TYPE_INVALID',
          message: `Field ${field.name} cannot use an enum with type ${field.type}.`
        });
      }
      if (!enumIds.has(field.enumRef)) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_ENUM_REF_MISSING',
          message: `Field ${field.name} references missing enum ${field.enumRef}.`
        });
      }
    }
    validateFieldValueConstraints(field, diagnostics);

    let firstBit = field.offset * 8;
    let bitCount = field.size * 8;
    if (field.bitfield !== undefined) {
      const { bitOffset, bitWidth } = field.bitfield;
      const bitfieldValid = (INTEGER_TYPES.has(field.type) || field.type === 'bool')
        && Number.isSafeInteger(bitOffset)
        && Number.isSafeInteger(bitWidth)
        && bitOffset >= 0
        && bitWidth > 0
        && (field.type !== 'bool' || bitWidth === 1)
        && bitOffset + bitWidth <= field.size * 8;
      if (!bitfieldValid) {
        diagnostics.push({
          severity: 'error',
          code: 'PARAMDEF_BITFIELD_INVALID',
          message: `Field ${field.name} has an invalid bitfield range or scalar type.`
        });
      } else {
        firstBit += bitOffset;
        bitCount = bitWidth;
      }
    }
    occupiedRanges.push({
      start: firstBit,
      end: firstBit + bitCount,
      fieldId: field.id,
      fieldName: field.name
    });
  }
  validateFieldOverlaps(occupiedRanges, diagnostics);
  return { ok: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
}

interface ParamBitRange {
  start: number;
  end: number;
  fieldId: string;
  fieldName: string;
}

function validateFieldOverlaps(
  ranges: ParamBitRange[],
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  let active = sorted[0];
  for (let index = 1; index < sorted.length && active !== undefined; index += 1) {
    const current = sorted[index]!;
    if (current.start < active.end && current.fieldId !== active.fieldId) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_OVERLAP',
        message: `Field ${current.fieldName} overlaps ${active.fieldId} at bit ${current.start}.`
      });
    }
    if (current.end > active.end) active = current;
  }
}

function validateParamDefShape(input: unknown): ParamDefValidationResult['diagnostics'] {
  const diagnostics: ParamDefValidationResult['diagnostics'] = [];
  if (!isRecord(input)) {
    addShapeDiagnostic(diagnostics, 'PARAMDEF_DOCUMENT_NOT_OBJECT', '$', 'Param definition must be an object.');
    return diagnostics;
  }
  validateObjectKeys(input, DOCUMENT_KEYS, DOCUMENT_REQUIRED_KEYS, '$', diagnostics);
  validatePrimitive(input.schemaVersion, 'number', '$.schemaVersion', diagnostics);
  validateBoundedString(input.typeName, 256, '$.typeName', diagnostics);
  validatePrimitive(input.version, 'number', '$.version', diagnostics);
  validatePrimitive(input.rowDataSize, 'number', '$.rowDataSize', diagnostics);
  validateBoundedString(input.origin, 32, '$.origin', diagnostics);
  if (input.notes !== undefined) validateBoundedString(input.notes, 16_384, '$.notes', diagnostics);

  if (!Array.isArray(input.fields)) {
    addShapeDiagnostic(diagnostics, 'PARAMDEF_FIELDS_INVALID', '$.fields', 'Fields must be an array.');
  } else if (input.fields.length > PARAMDEF_MAX_FIELDS) {
    addShapeDiagnostic(
      diagnostics,
      'PARAMDEF_FIELD_LIMIT_EXCEEDED',
      '$.fields',
      `At most ${PARAMDEF_MAX_FIELDS} fields are allowed in one definition.`
    );
  } else if (!validateDenseArray(
    input.fields,
    '$.fields',
    'PARAMDEF_FIELD_ARRAY_SPARSE',
    diagnostics
  )) {
    // The diagnostic identifies the first missing index.
  } else {
    input.fields.forEach((field, index) => validateFieldShape(field, index, diagnostics));
  }
  if (input.enums !== undefined) {
    if (!Array.isArray(input.enums)) {
      addShapeDiagnostic(diagnostics, 'PARAMDEF_ENUMS_INVALID', '$.enums', 'Enums must be an array.');
    } else if (input.enums.length > PARAMDEF_MAX_ENUMS) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_ENUM_LIMIT_EXCEEDED',
        '$.enums',
        `At most ${PARAMDEF_MAX_ENUMS} enums are allowed in one definition.`
      );
    } else if (!validateDenseArray(
      input.enums,
      '$.enums',
      'PARAMDEF_ENUM_ARRAY_SPARSE',
      diagnostics
    )) {
      // The diagnostic identifies the first missing index.
    } else if (countEnumValues(input.enums) > PARAMDEF_MAX_ENUM_VALUES) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_ENUM_VALUE_LIMIT_EXCEEDED',
        '$.enums',
        `At most ${PARAMDEF_MAX_ENUM_VALUES} enum values are allowed in one definition.`
      );
    } else {
      input.enums.forEach((enumDef, index) => validateEnumShape(enumDef, index, diagnostics));
    }
  }
  return diagnostics;
}

function countEnumValues(input: unknown[]): number {
  let total = 0;
  for (const enumDef of input) {
    if (isRecord(enumDef) && Array.isArray(enumDef.values)) {
      total += enumDef.values.length;
      if (total > PARAMDEF_MAX_ENUM_VALUES) return total;
    }
  }
  return total;
}

function validateFieldShape(
  input: unknown,
  index: number,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  const path = `$.fields[${index}]`;
  if (!isRecord(input)) {
    addShapeDiagnostic(diagnostics, 'PARAMDEF_FIELD_NOT_OBJECT', path, 'Field must be an object.');
    return;
  }
  validateObjectKeys(input, FIELD_KEYS, FIELD_REQUIRED_KEYS, path, diagnostics);
  validateBoundedString(input.id, 256, `${path}.id`, diagnostics);
  validateBoundedString(input.name, 1_024, `${path}.name`, diagnostics);
  validateBoundedString(input.type, 32, `${path}.type`, diagnostics);
  validatePrimitive(input.offset, 'number', `${path}.offset`, diagnostics);
  validatePrimitive(input.size, 'number', `${path}.size`, diagnostics);
  for (const key of ['alignment', 'min', 'max'] as const) {
    if (input[key] !== undefined) validatePrimitive(input[key], 'number', `${path}.${key}`, diagnostics);
  }
  for (const key of ['enumRef', 'description'] as const) {
    if (input[key] !== undefined) {
      validateBoundedString(
        input[key],
        key === 'enumRef' ? 256 : 4_096,
        `${path}.${key}`,
        diagnostics
      );
    }
  }
  if (input.defaultValue !== undefined
    && !['number', 'string', 'boolean'].includes(typeof input.defaultValue)) {
    addShapeDiagnostic(
      diagnostics,
      'PARAMDEF_VALUE_TYPE_INVALID',
      `${path}.defaultValue`,
      'Default value must be a number, string, or boolean.'
    );
  } else if (typeof input.defaultValue === 'string' && input.defaultValue.length > 131_072) {
    addShapeDiagnostic(
      diagnostics,
      'PARAMDEF_STRING_LIMIT_EXCEEDED',
      `${path}.defaultValue`,
      'Default string exceeds the maximum encoded row payload.'
    );
  }
  if (input.bitfield !== undefined) {
    const bitfieldPath = `${path}.bitfield`;
    if (!isRecord(input.bitfield)) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_BITFIELD_NOT_OBJECT',
        bitfieldPath,
        'Bitfield must be an object.'
      );
    } else {
      validateObjectKeys(input.bitfield, BITFIELD_KEYS, BITFIELD_KEYS, bitfieldPath, diagnostics);
      validatePrimitive(input.bitfield.bitOffset, 'number', `${bitfieldPath}.bitOffset`, diagnostics);
      validatePrimitive(input.bitfield.bitWidth, 'number', `${bitfieldPath}.bitWidth`, diagnostics);
    }
  }
}

function validateEnumShape(
  input: unknown,
  index: number,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  const path = `$.enums[${index}]`;
  if (!isRecord(input)) {
    addShapeDiagnostic(diagnostics, 'PARAMDEF_ENUM_NOT_OBJECT', path, 'Enum must be an object.');
    return;
  }
  validateObjectKeys(input, ENUM_KEYS, ENUM_KEYS, path, diagnostics);
  validateBoundedString(input.id, 256, `${path}.id`, diagnostics);
  validateBoundedString(input.name, 1_024, `${path}.name`, diagnostics);
  if (!Array.isArray(input.values)) {
    addShapeDiagnostic(diagnostics, 'PARAMDEF_ENUM_VALUES_INVALID', `${path}.values`, 'Enum values must be an array.');
    return;
  }
  if (!validateDenseArray(
    input.values,
    `${path}.values`,
    'PARAMDEF_ENUM_VALUE_ARRAY_SPARSE',
    diagnostics
  )) return;
  input.values.forEach((value, valueIndex) => {
    const valuePath = `${path}.values[${valueIndex}]`;
    if (!isRecord(value)) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_ENUM_VALUE_NOT_OBJECT',
        valuePath,
        'Enum value must be an object.'
      );
      return;
    }
    validateObjectKeys(value, ENUM_VALUE_KEYS, ENUM_VALUE_KEYS, valuePath, diagnostics);
    validatePrimitive(value.value, 'number', `${valuePath}.value`, diagnostics);
    validateBoundedString(value.label, 4_096, `${valuePath}.label`, diagnostics);
  });
}

function validateDenseArray(
  input: unknown[],
  path: string,
  code: string,
  diagnostics: ParamDefValidationResult['diagnostics']
): boolean {
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) {
      addShapeDiagnostic(
        diagnostics,
        code,
        `${path}[${index}]`,
        'Sparse arrays are not valid metadata.'
      );
      return false;
    }
  }
  return true;
}

function validateObjectKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  path: string,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_REQUIRED_FIELD_MISSING',
        `${path}.${key}`,
        'Required param definition field is missing.'
      );
    }
  }
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      addShapeDiagnostic(
        diagnostics,
        'PARAMDEF_UNKNOWN_FIELD',
        `${path}.${key}`,
        'Unknown param definition fields are rejected.'
      );
    }
  }
}

function validatePrimitive(
  input: unknown,
  expected: 'number' | 'string',
  path: string,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  if (typeof input !== expected) {
    addShapeDiagnostic(
      diagnostics,
      'PARAMDEF_VALUE_TYPE_INVALID',
      path,
      `Expected ${expected}.`
    );
  }
}

function validateBoundedString(
  input: unknown,
  maximum: number,
  path: string,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  if (typeof input !== 'string') {
    validatePrimitive(input, 'string', path, diagnostics);
  } else if (input.length > maximum) {
    addShapeDiagnostic(
      diagnostics,
      'PARAMDEF_STRING_LIMIT_EXCEEDED',
      path,
      `String length exceeds ${maximum} characters.`
    );
  }
}

function addShapeDiagnostic(
  diagnostics: ParamDefValidationResult['diagnostics'],
  code: string,
  path: string,
  message: string
): void {
  diagnostics.push({ severity: 'error', code, message: `${path}: ${message}` });
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function validateFieldValueConstraints(
  field: ParamFieldDef,
  diagnostics: ParamDefValidationResult['diagnostics']
): void {
  if (field.min !== undefined && (!NUMERIC_TYPES.has(field.type) || !Number.isFinite(field.min))) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_FIELD_MIN_INVALID',
      message: `Field ${field.name} has an invalid minimum.`
    });
  }
  if (field.max !== undefined && (!NUMERIC_TYPES.has(field.type) || !Number.isFinite(field.max))) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_FIELD_MAX_INVALID',
      message: `Field ${field.name} has an invalid maximum.`
    });
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_FIELD_RANGE_CONSTRAINT_INVALID',
      message: `Field ${field.name} has min greater than max.`
    });
  }

  const intrinsic = SCALAR_RANGES[field.type];
  for (const [label, value] of [['min', field.min], ['max', field.max]] as const) {
    if (value !== undefined && intrinsic !== undefined
      && (value < intrinsic[0] || value > intrinsic[1])) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_RANGE_CONSTRAINT_INVALID',
        message: `Field ${field.name} ${label} is outside the scalar range.`
      });
    }
  }
  if (field.defaultValue === undefined) return;

  let validType = false;
  if (NUMERIC_TYPES.has(field.type)) {
    validType = typeof field.defaultValue === 'number'
      && Number.isFinite(field.defaultValue)
      && (!INTEGER_TYPES.has(field.type) || Number.isSafeInteger(field.defaultValue));
  } else if (field.type === 'bool') {
    validType = typeof field.defaultValue === 'boolean';
  } else if (field.type === 'fix') {
    validType = typeof field.defaultValue === 'string'
      && Buffer.byteLength(field.defaultValue, 'utf8') + 1 <= field.size;
  } else if (field.type === 'bytes') {
    validType = typeof field.defaultValue === 'string'
      && /^[a-fA-F0-9]*$/.test(field.defaultValue)
      && field.defaultValue.length === field.size * 2;
  }
  if (!validType) {
    diagnostics.push({
      severity: 'error',
      code: 'PARAMDEF_FIELD_DEFAULT_INVALID',
      message: `Field ${field.name} has an invalid default value.`
    });
    return;
  }
  if (typeof field.defaultValue === 'number') {
    if ((field.min !== undefined && field.defaultValue < field.min)
      || (field.max !== undefined && field.defaultValue > field.max)
      || (intrinsic !== undefined
        && (field.defaultValue < intrinsic[0] || field.defaultValue > intrinsic[1]))) {
      diagnostics.push({
        severity: 'error',
        code: 'PARAMDEF_FIELD_DEFAULT_OUT_OF_RANGE',
        message: `Field ${field.name} default value is outside its allowed range.`
      });
    }
  }
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
    if (field.bitfield !== undefined) {
      writeBitfield(next, field, value);
    } else {
      writeField(next, field, value);
    }
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

/**
 * Preserving bit writer: reads the existing integer at the field's offset,
 * clears only the target bit range, sets the new value, and writes back.
 * All other bits in the field's byte(s) are preserved.
 *
 * Arithmetic uses BigInt so that bitWidth up to 32 (a full u32/s32 field)
 * stays exact — the previous Number-based `1 << bitWidth` overflowed for
 * bitWidth >= 31. Signed scalar storage is treated as its raw unsigned bits
 * (bitfields operate on the bit pattern, not the signed interpretation).
 */
function writeBitfield(buf: Buffer, field: ParamFieldDef, value: number | string | boolean): void {
  const bf = field.bitfield;
  if (!bf) throw new Error('writeBitfield called without bitfield definition');
  const { bitOffset, bitWidth } = bf;

  // Read the existing integer value at the field's offset as an unsigned BigInt.
  const existing: bigint = readUnsignedFieldBits(buf, field);

  // Compute the new bit value: bitfields hold non-negative integers.
  let newValue: bigint;
  if (field.type === 'bool') {
    newValue = value ? 1n : 0n;
  } else {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) {
      throw new Error(`bitfield 值必须是整数，得到 ${value}`);
    }
    newValue = BigInt(numeric);
  }

  // Validate range: the value must fit in bitWidth bits.
  const maxValue = (1n << BigInt(bitWidth)) - 1n;
  if (newValue < 0n || newValue > maxValue) {
    throw new Error(`bitfield 值 ${newValue} 超出 ${bitWidth} 位范围 [0, ${maxValue}]`);
  }

  // Create mask and apply: clear target bits, set new value.
  const mask = maxValue << BigInt(bitOffset);
  const result = (existing & ~mask) | (newValue << BigInt(bitOffset));
  writeUnsignedFieldBits(buf, field, result);
}

/** Reads the storage bits at the field offset as an unsigned BigInt. */
function readUnsignedFieldBits(buf: Buffer, field: ParamFieldDef): bigint {
  switch (field.type) {
    case 'u8':
    case 's8':
    case 'bool':
      return BigInt(buf.readUInt8(field.offset));
    case 'u16':
    case 's16':
      return BigInt(buf.readUInt16LE(field.offset));
    case 'u32':
    case 's32':
      return BigInt(buf.readUInt32LE(field.offset));
    default:
      throw new Error(`bitfield 不支持类型 ${field.type}`);
  }
}

/** Writes the result BigInt back into the field's storage, truncating to its width. */
function writeUnsignedFieldBits(buf: Buffer, field: ParamFieldDef, result: bigint): void {
  switch (field.type) {
    case 'u8':
    case 's8':
    case 'bool':
      buf.writeUInt8(Number(result & 0xffn), field.offset);
      break;
    case 'u16':
    case 's16':
      buf.writeUInt16LE(Number(result & 0xffffn), field.offset);
      break;
    case 'u32':
    case 's32':
      buf.writeUInt32LE(Number(result & 0xffffffffn), field.offset);
      break;
    default:
      throw new Error(`bitfield 不支持类型 ${field.type}`);
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
