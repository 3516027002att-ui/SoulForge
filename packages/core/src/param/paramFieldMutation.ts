/**
 * PARAM field-level mutation helper.
 *
 * Applies a single field change to a row's byte payload using the
 * paramdef layout codec, then returns the modified row as base64
 * for a whole-row Bridge upsert.
 *
 * The Bridge remains a whole-row writer — field granularity is a
 * TypeScript-side concern.
 */

import { encodeFieldMutation } from './paramdefLayout.js';
import type { ParamDefDocument } from '@soulforge/shared';

export interface ParamFieldMutationRequest {
  /** Current row data as base64. */
  rowDataBase64: string;
  /** The paramdef definition for this PARAM type. */
  definition: ParamDefDocument;
  /** The field ID to mutate. */
  fieldId: string;
  /** The new value for the field. */
  value: number | string | boolean;
}

export type ParamFieldMutationResult =
  | { ok: true; nextDataBase64: string }
  | { ok: false; code: string; message: string };

/**
 * Apply a field-level mutation to a PARAM row.
 *
 * Decodes the base64 row data, applies the field change via
 * `encodeFieldMutation` (which handles both scalar and bitfield writes),
 * and returns the modified row as base64.
 */
export function applyParamFieldMutation(
  request: ParamFieldMutationRequest
): ParamFieldMutationResult {
  let rowData: Buffer;
  try {
    rowData = Buffer.from(request.rowDataBase64, 'base64');
  } catch {
    return { ok: false, code: 'PARAM_FIELD_INVALID_BASE64', message: '行数据 base64 解码失败。' };
  }

  if (rowData.length === 0) {
    return { ok: false, code: 'PARAM_FIELD_EMPTY_ROW', message: '行数据为空。' };
  }

  if (rowData.length !== request.definition.rowDataSize) {
    return {
      ok: false,
      code: 'PARAM_FIELD_ROW_SIZE_MISMATCH',
      message: `行数据长度 ${rowData.length} 与定义 rowDataSize ${request.definition.rowDataSize} 不匹配。`
    };
  }

  const result = encodeFieldMutation(rowData, request.definition, request.fieldId, request.value);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  return { ok: true, nextDataBase64: result.next.toString('base64') };
}