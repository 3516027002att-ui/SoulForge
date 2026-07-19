import type { PatchIrOperation, ResourceFieldEditOp } from '@soulforge/shared';

type ObjectPatchValue = {
  valueType: 'object';
  fields: {
    x: { valueType: 'float'; value: number };
    y: { valueType: 'float'; value: number };
    z: { valueType: 'float'; value: number };
  };
};

export type MsbPositionFieldOperation = ResourceFieldEditOp & {
  previousValue: ObjectPatchValue;
  nextValue: ObjectPatchValue;
};

export type MsbPartPositionFieldOperation = MsbPositionFieldOperation;

export const MSB_SEMANTIC_WRITER_ID = 'writer:msb-semantic-v1';
export const MSB_SEMANTIC_VALIDATOR_ID = 'msb_semantic';

export type MsbPositionIdentity =
  | { entityKind: 'part'; entityName: string }
  | { entityKind: 'region'; entityName: string };

export function msbPartPositionFieldUri(input: {
  documentUri: string;
  partName: string;
}): string {
  return `${input.documentUri}#part/${encodeURIComponent(input.partName)}/field/position`;
}

export function msbRegionPositionFieldUri(input: {
  documentUri: string;
  regionName: string;
}): string {
  return `${input.documentUri}#region/${encodeURIComponent(input.regionName)}/field/position`;
}

export function parseMsbPositionFieldUri(
  fieldUri: string
): MsbPositionIdentity | undefined {
  const match = /#(part|region)\/([^/]+)\/field\/position$/.exec(fieldUri);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    entityKind: match[1] as MsbPositionIdentity['entityKind'],
    entityName: decodeURIComponent(match[2])
  };
}

export function parseMsbPartPositionFieldUri(
  fieldUri: string
): { partName: string } | undefined {
  const identity = parseMsbPositionFieldUri(fieldUri);
  return identity?.entityKind === 'part' ? { partName: identity.entityName } : undefined;
}

export function isMsbPositionFieldOperation(
  operation: PatchIrOperation
): operation is MsbPositionFieldOperation {
  if (operation.kind !== 'resource_field_edit'
    || operation.resourceKind !== 'map'
    || operation.writerId !== MSB_SEMANTIC_WRITER_ID
    || operation.documentUri !== operation.targetUri
    || !operation.targetPath
    || operation.metadata?.nativeFormatAuthority !== true
    || operation.previousValue.valueType !== 'object'
    || operation.nextValue.valueType !== 'object') {
    return false;
  }
  const identity = parseMsbPositionFieldUri(operation.fieldUri);
  const prev = operation.previousValue.fields;
  const next = operation.nextValue.fields;
  return Boolean(
    identity
    && operation.fieldUri.startsWith(`${operation.documentUri}#`)
    && prev?.x?.valueType === 'float'
    && prev.y?.valueType === 'float'
    && prev.z?.valueType === 'float'
    && next?.x?.valueType === 'float'
    && next.y?.valueType === 'float'
    && next.z?.valueType === 'float'
  );
}

export function isMsbPartPositionFieldOperation(
  operation: PatchIrOperation
): operation is MsbPartPositionFieldOperation {
  return isMsbPositionFieldOperation(operation)
    && parseMsbPositionFieldUri(operation.fieldUri)?.entityKind === 'part';
}

export function positionObjectValue(input: {
  x: number;
  y: number;
  z: number;
}): ObjectPatchValue {
  return {
    valueType: 'object',
    fields: {
      x: { valueType: 'float', value: input.x },
      y: { valueType: 'float', value: input.y },
      z: { valueType: 'float', value: input.z }
    }
  };
}

export function readPositionObject(value: ObjectPatchValue): { x: number; y: number; z: number } {
  return {
    x: value.fields.x.value,
    y: value.fields.y.value,
    z: value.fields.z.value
  };
}
