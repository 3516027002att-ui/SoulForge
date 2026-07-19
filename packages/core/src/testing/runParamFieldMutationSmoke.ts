/**
 * Typed user-derived PARAM field mutation contract.
 * This does not claim native .paramdef parsing or official field semantics.
 */
import { createHash } from 'node:crypto';
import type { ParamDefDocument } from '@soulforge/shared';
import { prepareParamFieldMutation } from '../param/paramFieldMutation.js';
import { decodeRowFields, validateParamDef } from '../param/paramdefLayout.js';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function main(): void {
  const definition: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'SYNTHETIC_PARAM_ST',
    version: 1,
    rowDataSize: 4,
    origin: 'fixture',
    enums: [{
      id: 'mode_enum',
      name: 'mode',
      values: [
        { value: 0, label: 'off' },
        { value: 1, label: 'normal' },
        { value: 2, label: 'boost' }
      ]
    }],
    fields: [
      {
        id: 'mode',
        name: 'mode',
        type: 'u8',
        offset: 0,
        size: 1,
        enumRef: 'mode_enum',
        bitfield: { bitOffset: 0, bitWidth: 2 }
      },
      {
        id: 'enabled',
        name: 'enabled',
        type: 'bool',
        offset: 0,
        size: 1,
        bitfield: { bitOffset: 2, bitWidth: 1 }
      },
      { id: 'count', name: 'count', type: 'u8', offset: 1, size: 1, min: 1, max: 10 },
      { id: 'payload', name: 'payload', type: 'bytes', offset: 2, size: 2 }
    ]
  };
  const validation = validateParamDef(definition);
  if (!validation.ok) {
    throw new Error(`expected valid definition: ${JSON.stringify(validation.diagnostics)}`);
  }

  // mode=1 in bits 0..1; enabled=true in bit 2.
  const original = Buffer.from([0b0000_0101, 5, 0xaa, 0xbb]);
  const originalHash = sha256(original);
  const changed = prepareParamFieldMutation({
    documentTypeName: definition.typeName,
    rowDataSize: definition.rowDataSize,
    rowId: 10,
    rowDataBase64: original.toString('base64'),
    rowDataHash: originalHash,
    expectedRowHash: originalHash,
    definition,
    fieldId: 'mode',
    value: 2
  });
  if (!changed.ok) throw new Error(`valid field mutation failed: ${changed.code} ${changed.message}`);
  const next = Buffer.from(changed.dataBase64, 'base64');
  const decoded = decodeRowFields(next, definition);
  if (next[0] !== 0b0000_0110
    || changed.beforeValue !== 1
    || changed.afterValue !== 2
    || changed.changedByteOffsets.join(',') !== '0'
    || decoded.find((field) => field.fieldId === 'enabled')?.value !== true
    || !original.equals(Buffer.from([0b0000_0101, 5, 0xaa, 0xbb]))) {
    throw new Error(`bitfield isolation failed: ${JSON.stringify({ changed, decoded })}`);
  }

  expectMutationFailure(definition, original, originalHash, 'mode', 2, 'PARAM_FIELD_ROW_HASH_MISMATCH', '0'.repeat(64));
  expectMutationFailure(definition, original, originalHash, 'mode', 3, 'PARAMDEF_VALUE_INVALID');
  expectMutationFailure(definition, original, originalHash, 'count', 0, 'PARAMDEF_VALUE_INVALID');
  expectMutationFailure(definition, original, originalHash, 'payload', 'not-hex', 'PARAMDEF_VALUE_INVALID');

  const invalidBase64 = prepareParamFieldMutation({
    documentTypeName: definition.typeName,
    rowDataSize: definition.rowDataSize,
    rowId: 10,
    rowDataBase64: 'not-base64!',
    rowDataHash: originalHash,
    expectedRowHash: originalHash,
    definition,
    fieldId: 'mode',
    value: 2
  });
  if (invalidBase64.ok) throw new Error('invalid Base64 must be rejected');

  const overlapping: ParamDefDocument = {
    ...definition,
    fields: definition.fields.map((field) => field.id === 'enabled'
      ? { ...field, bitfield: { bitOffset: 1, bitWidth: 1 } }
      : field)
  };
  expectDefinitionDiagnostic(overlapping, 'PARAMDEF_FIELD_OVERLAP');
  expectDefinitionDiagnostic({
    ...definition,
    fields: [...definition.fields, { ...definition.fields[2]!, name: 'other-count' }]
  }, 'PARAMDEF_FIELD_ID_DUPLICATE');
  expectDefinitionDiagnostic({
    ...definition,
    fields: [...definition.fields, { ...definition.fields[2]!, id: 'other-count' }]
  }, 'PARAMDEF_FIELD_NAME_DUPLICATE');

  console.log(JSON.stringify({
    ok: true,
    message: '用户派生 PARAM 字段 mutation 契约验证通过',
    typeName: definition.typeName,
    changedByteOffsets: changed.changedByteOffsets,
    siblingBitfieldPreserved: true,
    staleHashBlocked: true,
    enumConstraintBlocked: true,
    rangeConstraintBlocked: true,
    strictBase64Blocked: true,
    overlapAndDuplicateDefinitionsBlocked: true,
    nonClaim: 'native .paramdef semantics remain unverified'
  }, null, 2));
}

function expectMutationFailure(
  definition: ParamDefDocument,
  row: Buffer,
  rowHash: string,
  fieldId: string,
  value: number | string | boolean,
  expectedCode: string,
  expectedRowHash = rowHash
): void {
  const result = prepareParamFieldMutation({
    documentTypeName: definition.typeName,
    rowDataSize: definition.rowDataSize,
    rowId: 10,
    rowDataBase64: row.toString('base64'),
    rowDataHash: rowHash,
    expectedRowHash,
    definition,
    fieldId,
    value
  });
  if (result.ok || result.code !== expectedCode) {
    throw new Error(`expected ${expectedCode}, got ${JSON.stringify(result)}`);
  }
}

function expectDefinitionDiagnostic(definition: ParamDefDocument, expectedCode: string): void {
  const result = validateParamDef(definition);
  if (result.ok || !result.diagnostics.some((diagnostic) => diagnostic.code === expectedCode)) {
    throw new Error(`expected ${expectedCode}, got ${JSON.stringify(result.diagnostics)}`);
  }
}

main();
