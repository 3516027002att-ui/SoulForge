import type { PatchIrOperation, PatchTypedValue, ResourceFieldEditOp } from '@soulforge/shared';

export type ParamFieldSemanticOperation = ResourceFieldEditOp & {
  previousValue: PatchTypedValue;
  nextValue: PatchTypedValue;
};

export const PARAM_SEMANTIC_WRITER_ID = 'writer:param-semantic-v1';
export const PARAM_SEMANTIC_VALIDATOR_ID = 'param_semantic';

export interface ParamFieldIdentity {
  rowId: number;
  fieldId: string;
}

export function paramFieldUri(input: {
  documentUri: string;
  rowId: number;
  fieldId: string;
}): string {
  return `${input.documentUri}#row/${input.rowId}/field/${encodeURIComponent(input.fieldId)}`;
}

export function parseParamFieldUri(fieldUri: string): ParamFieldIdentity | undefined {
  const match = /#row\/(-?\d+)\/field\/([^#]+)$/.exec(fieldUri);
  if (!match) return undefined;
  const rowId = Number(match[1]);
  const fieldId = decodeURIComponent(match[2] ?? '');
  if (!Number.isSafeInteger(rowId) || !fieldId) return undefined;
  return { rowId, fieldId };
}

export function isParamFieldSemanticOperation(
  operation: PatchIrOperation
): operation is ParamFieldSemanticOperation {
  if (operation.kind !== 'resource_field_edit'
    || operation.resourceKind !== 'param'
    || operation.writerId !== PARAM_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || typeof operation.metadata.fieldId !== 'string'
    || typeof operation.metadata.rowId !== 'number'
    || typeof operation.metadata.definitionTypeName !== 'string'
    || typeof operation.metadata.expectedRowHash !== 'string') {
    return false;
  }
  const identity = parseParamFieldUri(operation.fieldUri);
  return Boolean(
    identity
    && identity.rowId === operation.metadata.rowId
    && identity.fieldId === operation.metadata.fieldId
    && operation.fieldUri.startsWith(`${operation.documentUri}#`)
  );
}

export function toParamPatchValue(value: number | string | boolean | null): PatchTypedValue {
  if (value === null) return { valueType: 'null', value: null };
  if (typeof value === 'boolean') return { valueType: 'boolean', value };
  if (typeof value === 'string') return { valueType: 'string', value };
  if (Number.isInteger(value)) return { valueType: 'integer', value };
  return { valueType: 'float', value };
}

export function fromParamPatchValue(value: PatchTypedValue): number | string | boolean | null {
  if (value.valueType === 'null') return null;
  if (value.valueType === 'boolean') return value.value;
  if (value.valueType === 'string') return value.value;
  if (value.valueType === 'integer' || value.valueType === 'float') return value.value;
  throw new Error(`PARAM semantic unsupported typed value ${value.valueType}`);
}
