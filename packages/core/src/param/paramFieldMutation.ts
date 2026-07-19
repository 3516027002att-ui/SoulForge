import { createHash } from 'node:crypto';
import type { ParamDefDocument } from '@soulforge/shared';
import { decodeStrictBase64, StrictBase64Error } from '../util/base64.js';
import { decodeRowFields, encodeFieldMutation, validateParamDef } from './paramdefLayout.js';

export interface PrepareParamFieldMutationInput {
  documentTypeName: string;
  rowDataSize: number;
  rowId: number;
  rowDataBase64: string;
  rowDataHash: string;
  expectedRowHash: string;
  definition: ParamDefDocument;
  fieldId: string;
  value: number | string | boolean;
}

export type PrepareParamFieldMutationResult =
  | {
      ok: true;
      rowId: number;
      fieldId: string;
      dataBase64: string;
      dataHash: string;
      beforeValue: number | string | boolean | null;
      afterValue: number | string | boolean | null;
      changedByteOffsets: number[];
    }
  | { ok: false; code: string; message: string };

/**
 * Converts one validated user-derived field change into a complete PARAM row
 * payload. This is orchestration only; native document writing remains the C#
 * Bridge authority through write-param.
 */
export function prepareParamFieldMutation(
  input: PrepareParamFieldMutationInput
): PrepareParamFieldMutationResult {
  const validation = validateParamDef(input.definition);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'PARAM_FIELD_DEFINITION_INVALID',
      message: validation.diagnostics[0]?.message ?? '参数结构定义无效。'
    };
  }
  if (input.definition.typeName !== input.documentTypeName) {
    return {
      ok: false,
      code: 'PARAM_FIELD_TYPE_NAME_MISMATCH',
      message: `结构定义 ${input.definition.typeName} 与 PARAM ${input.documentTypeName} 不匹配。`
    };
  }
  if (input.definition.rowDataSize !== input.rowDataSize) {
    return {
      ok: false,
      code: 'PARAM_FIELD_ROW_SIZE_MISMATCH',
      message: `结构定义行大小 ${input.definition.rowDataSize} 与 PARAM ${input.rowDataSize} 不匹配。`
    };
  }
  if (!/^[a-f0-9]{64}$/.test(input.rowDataHash)
    || !/^[a-f0-9]{64}$/.test(input.expectedRowHash)
    || input.rowDataHash !== input.expectedRowHash) {
    return {
      ok: false,
      code: 'PARAM_FIELD_ROW_HASH_MISMATCH',
      message: 'PARAM row hash 与编辑时预期不一致。'
    };
  }

  let original: Buffer;
  try {
    original = decodeStrictBase64(input.rowDataBase64, { allowEmpty: false });
  } catch (error) {
    return {
      ok: false,
      code: error instanceof StrictBase64Error ? error.code : 'PARAM_FIELD_ROW_BASE64_INVALID',
      message: 'PARAM row payload 不是合法严格 Base64。'
    };
  }
  if (original.length !== input.rowDataSize) {
    return {
      ok: false,
      code: 'PARAM_FIELD_ROW_PAYLOAD_SIZE_MISMATCH',
      message: `PARAM row payload 为 ${original.length} 字节，预期 ${input.rowDataSize}。`
    };
  }
  const actualHash = hash(original);
  if (actualHash !== input.rowDataHash) {
    return {
      ok: false,
      code: 'PARAM_FIELD_ROW_PAYLOAD_HASH_MISMATCH',
      message: 'PARAM row payload 与 Bridge row hash 不一致。'
    };
  }

  const before = decodeRowFields(original, input.definition)
    .find((field) => field.fieldId === input.fieldId);
  if (!before) {
    return { ok: false, code: 'PARAMDEF_FIELD_NOT_FOUND', message: `字段 ${input.fieldId} 不存在。` };
  }
  const encoded = encodeFieldMutation(original, input.definition, input.fieldId, input.value);
  if (!encoded.ok) return encoded;
  const after = decodeRowFields(encoded.next, input.definition)
    .find((field) => field.fieldId === input.fieldId);
  if (!after || after.diagnostic) {
    return {
      ok: false,
      code: 'PARAM_FIELD_REREAD_FAILED',
      message: after?.diagnostic ?? '字段写入后无法重读。'
    };
  }

  const changedByteOffsets = differingOffsets(original, encoded.next);
  if (changedByteOffsets.length === 0) {
    return { ok: false, code: 'PARAM_FIELD_NO_CHANGE', message: '字段值未发生变化。' };
  }
  const definition = input.definition.fields.find((field) => field.id === input.fieldId)!;
  if (changedByteOffsets.some((offset) =>
    offset < definition.offset || offset >= definition.offset + definition.size)) {
    return {
      ok: false,
      code: 'PARAM_FIELD_WRITE_ESCAPED_RANGE',
      message: '字段写入修改了定义范围外的字节。'
    };
  }

  return {
    ok: true,
    rowId: input.rowId,
    fieldId: input.fieldId,
    dataBase64: encoded.next.toString('base64'),
    dataHash: hash(encoded.next),
    beforeValue: before.value,
    afterValue: after.value,
    changedByteOffsets
  };
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function differingOffsets(before: Buffer, after: Buffer): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) offsets.push(index);
  }
  return offsets;
}
