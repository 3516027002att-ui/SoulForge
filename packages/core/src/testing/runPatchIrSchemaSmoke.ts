import { createHash } from 'node:crypto';
import {
  PATCH_IR_SCHEMA_VERSION,
  type PatchIR,
  type PatchIrOperation,
  type ResourceNodePayload
} from '@soulforge/shared';
import { createPatchIr, validatePatchIr } from '../patch-engine/patchIr.js';

const DOCUMENT_HASH = sha256('document');

function main(): void {
  const previousPayload = paramPayload(100, 'old-row');
  const nextPayload = paramPayload(100, 'new-row');
  const previousReferencedPayload = paramPayload(101, 'old-referenced-row');
  const stagingObjectPayload: Extract<ResourceNodePayload, { nodeType: 'param_row' }> = {
    payloadVersion: 1,
    resourceKind: 'param',
    nodeType: 'param_row',
    paramType: 'DemoParam',
    rowId: 101,
    rowName: 'row-101',
    snapshot: {
      storage: 'staging_object',
      formatId: 'PARAM:row',
      schemaVersion: '1',
      objectId: 'staging-object:param-row-101',
      sha256: sha256('referenced-row-content'),
      size: 400_000
    }
  };
  const operations: PatchIrOperation[] = [
    {
      ...semanticBase('field-op', 'resource_field_edit', 'param'),
      kind: 'resource_field_edit',
      schemaId: 'paramdef:DemoParam',
      schemaVersion: '1',
      layoutFingerprint: sha256('layout'),
      fieldUri: 'soulforge://sekiro/overlay/param/demo.param?field=rows.100.hp',
      previousValue: {
        valueType: 'object',
        fields: {
          hp: { valueType: 'integer', value: 100 },
          enabled: { valueType: 'boolean', value: true }
        }
      },
      nextValue: {
        valueType: 'object',
        fields: {
          hp: { valueType: 'integer', value: 125 },
          enabled: { valueType: 'boolean', value: true }
        }
      },
      inverse: {
        kind: 'resource_field_edit',
        fieldUri: 'soulforge://sekiro/overlay/param/demo.param?field=rows.100.hp',
        value: {
          valueType: 'object',
          fields: {
            enabled: { valueType: 'boolean', value: true },
            hp: { valueType: 'integer', value: 100 }
          }
        }
      }
    },
    {
      ...semanticBase('update-op', 'resource_node_update', 'param'),
      kind: 'resource_node_update',
      nodeId: 'param-row:100',
      expectedNodeHash: previousPayload.snapshot.sha256,
      payload: nextPayload,
      inverse: {
        kind: 'resource_node_update',
        nodeId: 'param-row:100',
        payload: previousPayload
      }
    },
    {
      ...semanticBase('reorder-op', 'resource_node_reorder', 'event'),
      kind: 'resource_node_reorder',
      nodeId: 'instruction:2',
      parentNodeId: 'event:1000',
      beforeNodeId: 'instruction:1',
      expectedOrder: ['instruction:1', 'instruction:2', 'instruction:3'],
      inverse: {
        kind: 'resource_node_reorder',
        parentNodeId: 'event:1000',
        previousOrder: ['instruction:1', 'instruction:2', 'instruction:3']
      }
    },
    {
      ...semanticBase('staging-ref-op', 'resource_node_update', 'param'),
      kind: 'resource_node_update',
      nodeId: 'param-row:101',
      expectedNodeHash: previousReferencedPayload.snapshot.sha256,
      payload: stagingObjectPayload,
      inverse: {
        kind: 'resource_node_update',
        nodeId: 'param-row:101',
        payload: previousReferencedPayload
      }
    },
    {
      ...semanticBase('convert-op', 'resource_node_convert', 'param'),
      kind: 'resource_node_convert',
      nodeId: 'param-row:100',
      expectedNodeHash: previousPayload.snapshot.sha256,
      fromType: 'DemoParamV1',
      toType: 'DemoParamV2',
      payload: nextPayload,
      inverse: {
        kind: 'resource_node_convert',
        nodeId: 'param-row:100',
        previousType: 'DemoParamV1',
        payload: previousPayload
      }
    },
    {
      ...baseOperation('asset-op', 'asset_import_replace'),
      kind: 'asset_import_replace',
      sourceImportObjectId: 'import:demo.glb',
      importFormat: 'glb',
      targetAssetUri: 'soulforge://sekiro/overlay/obj/obj/demo.flver',
      targetUri: 'soulforge://sekiro/overlay/obj/obj/demo.flver',
      conversionRuleId: 'sekiro:flver-from-glb:v1',
      expectedTargetHash: sha256('previous-asset'),
      writerId: 'writer:sekiro-asset',
      generatedStagingObjects: [{
        objectId: 'staging:demo.flver',
        mediaType: 'application/x-fromsoftware-flver',
        sha256: sha256('generated-asset'),
        size: 15
      }],
      inverse: {
        kind: 'asset_import_replace',
        previousAssetObjectHash: sha256('previous-asset'),
        backupRef: 'backup:previous-asset'
      }
    }
  ];

  const patch = createPatchIr({
    workspaceId: 'workspace:test',
    title: 'typed PatchIR smoke',
    author: 'system',
    operations
  });
  assert(patch.schemaVersion === PATCH_IR_SCHEMA_VERSION, 'createPatchIr must stamp schemaVersion');
  const valid = validatePatchIr(patch);
  assert(valid.ok, `typed semantic PatchIR should validate: ${JSON.stringify(valid.diagnostics)}`);

  const wrongVersion = {
    ...patch,
    schemaVersion: '0.0.0'
  } as unknown as PatchIR;
  assert(
    validatePatchIr(wrongVersion).diagnostics.some((item) =>
      item.code === 'PATCH_IR_SCHEMA_VERSION_UNSUPPORTED'),
    'unsupported schemaVersion must fail closed'
  );
  assert(
    validatePatchIr(null).diagnostics.some((item) => item.code === 'PATCH_IR_INVALID_ROOT'),
    'non-object PatchIR must return a diagnostic instead of throwing'
  );
  const malformedOperation = {
    ...patch,
    operations: [null],
    affectedResources: []
  };
  assert(
    validatePatchIr(malformedOperation).diagnostics.some((item) =>
      item.code === 'PATCH_OP_INVALID_SHAPE'),
    'malformed operation must return a diagnostic instead of throwing'
  );
  assert(
    validatePatchIr({ ...patch, affectedResources: [] }).diagnostics.some((item) =>
      item.code === 'PATCH_IR_AFFECTED_RESOURCES_MISMATCH'),
    'declared affectedResources must match operation-derived URIs'
  );
  assert(
    validatePatchIr({ ...patch, riskLevel: 'safe' }).diagnostics.some((item) =>
      item.code === 'PATCH_IR_RISK_UNDERESTIMATED'),
    'declared patch risk cannot be lower than operation-derived risk'
  );

  const legacyUnknownPayload = {
    ...semanticBase('legacy-node', 'resource_node_add', 'param'),
    kind: 'resource_node_add',
    nodeId: 'param-row:200',
    nodePayload: { arbitrary: true },
    inverse: {
      kind: 'resource_node_delete',
      nodeId: 'param-row:200',
      expectedNodeHash: nextPayload.snapshot.sha256
    }
  } as unknown as PatchIrOperation;
  const legacyResult = validatePatchIr(createPatchIr({
    workspaceId: 'workspace:test',
    title: 'legacy unknown payload',
    author: 'system',
    operations: [legacyUnknownPayload]
  }));
  assert(
    legacyResult.diagnostics.some((item) => item.code === 'PATCH_NODE_PAYLOAD_INVALID'),
    'legacy nodePayload unknown must be rejected'
  );

  const tamperedPayload = {
    ...nextPayload,
    snapshot: {
      ...nextPayload.snapshot,
      dataBase64: Buffer.from('tampered').toString('base64')
    }
  };
  const tamperedOperation = {
    ...semanticBase('tampered-node', 'resource_node_update', 'param'),
    kind: 'resource_node_update',
    nodeId: 'param-row:100',
    expectedNodeHash: previousPayload.snapshot.sha256,
    payload: tamperedPayload,
    inverse: {
      kind: 'resource_node_update',
      nodeId: 'param-row:100',
      payload: previousPayload
    }
  } as unknown as PatchIrOperation;
  const tamperedResult = validatePatchIr(createPatchIr({
    workspaceId: 'workspace:test',
    title: 'tampered snapshot',
    author: 'system',
    operations: [tamperedOperation]
  }));
  assert(
    tamperedResult.diagnostics.some((item) => item.code === 'PATCH_NODE_UPDATE_INVALID'),
    'snapshot bytes/hash mismatch must be rejected'
  );

  const instructionArgs = Buffer.alloc(0);
  const instructionSnapshot = Buffer.alloc(24);
  const instructionHash = createHash('sha256').update(instructionSnapshot).digest('hex');
  const validInstructionPayload = {
    payloadVersion: 1,
    resourceKind: 'event',
    nodeType: 'emevd_instruction',
    eventId: 1000,
    eventIndex: 0,
    instructionIndex: 0,
    bank: 2000,
    instructionId: 1,
    layerOffset: -1,
    parameterCount: 0,
    instructionHash,
    args: {
      storage: 'inline',
      dataBase64: instructionArgs.toString('base64'),
      sha256: createHash('sha256').update(instructionArgs).digest('hex'),
      size: instructionArgs.length
    },
    snapshot: {
      storage: 'inline',
      formatId: 'soulforge.emevd.instruction-semantic-v1',
      schemaVersion: '1.0.0',
      dataBase64: instructionSnapshot.toString('base64'),
      sha256: instructionHash,
      size: instructionSnapshot.length
    }
  };
  const malformedInstructionPayload = { ...validInstructionPayload } as Record<string, unknown>;
  delete malformedInstructionPayload.parameterCount;
  const malformedInstructionResult = validatePatchIr(createPatchIr({
    workspaceId: 'workspace:test',
    title: 'malformed instruction payload',
    author: 'system',
    operations: [{
      ...semanticBase('malformed-instruction-node', 'resource_node_add', 'event'),
      kind: 'resource_node_add',
      nodeId: 'event:1000:instruction:0',
      payload: malformedInstructionPayload,
      inverse: {
        kind: 'resource_node_delete',
        nodeId: 'event:1000:instruction:0',
        expectedNodeHash: instructionHash
      }
    } as unknown as PatchIrOperation]
  }));
  assert(
    malformedInstructionResult.diagnostics.some((item) => item.code === 'PATCH_NODE_PAYLOAD_INVALID'),
    'EMEVD instruction payload without parameterCount must be rejected'
  );

  const oversizedBytes = Buffer.alloc(256 * 1024 + 1, 0x5a);
  const oversizedInlinePayload = {
    ...nextPayload,
    snapshot: {
      storage: 'inline',
      formatId: 'PARAM:row',
      schemaVersion: '1',
      dataBase64: oversizedBytes.toString('base64'),
      sha256: createHash('sha256').update(oversizedBytes).digest('hex'),
      size: oversizedBytes.length
    }
  };
  const oversizedResult = validatePatchIr(createPatchIr({
    workspaceId: 'workspace:test',
    title: 'oversized inline snapshot',
    author: 'system',
    operations: [{
      ...semanticBase('oversized-node', 'resource_node_update', 'param'),
      kind: 'resource_node_update',
      nodeId: 'param-row:100',
      expectedNodeHash: previousPayload.snapshot.sha256,
      payload: oversizedInlinePayload,
      inverse: {
        kind: 'resource_node_update',
        nodeId: 'param-row:100',
        payload: previousPayload
      }
    } as unknown as PatchIrOperation]
  }));
  assert(
    oversizedResult.diagnostics.some((item) => item.code === 'PATCH_NODE_UPDATE_INVALID'),
    'oversized inline snapshot must require a staging object reference'
  );

  const noAuthority = {
    ...operations[1]!,
    metadata: { nativeFormatAuthority: false }
  };
  const authorityResult = validatePatchIr(createPatchIr({
    workspaceId: 'workspace:test',
    title: 'missing writer authority',
    author: 'system',
    operations: [noAuthority]
  }));
  assert(!authorityResult.ok, 'semantic op without authority writer must remain blocked');
  assert(
    authorityResult.diagnostics.some((item) => item.code === 'NATIVE_WRITER_REQUIRED'),
    'semantic op without authority writer must report NATIVE_WRITER_REQUIRED'
  );

  console.log(JSON.stringify({
    ok: true,
    message: 'PatchIR schemaVersion、typed payload/inverse 与 writer authority 门禁验证通过',
    schemaVersion: patch.schemaVersion,
    typedOperations: operations.map((operation) => operation.kind),
    legacyUnknownPayloadBlocked: true,
    tamperedSnapshotBlocked: true,
    incompleteEmevdInstructionSnapshotBlocked: true,
    oversizedInlineSnapshotBlocked: true,
    stagingObjectReferenceAccepted: true,
    missingWriterAuthorityBlocked: true,
    malformedRuntimeInputsBlocked: true,
    derivedResourcesAndRiskBound: true,
    nonClaim: 'typed IR validation alone does not prove production writer coverage'
  }, null, 2));
}

function semanticBase(
  id: string,
  kind: PatchIrOperation['kind'],
  resourceKind: NonNullable<PatchIrOperation['resourceKind']>
) {
  return {
    ...baseOperation(id, kind),
    resourceKind,
    documentUri: `soulforge://sekiro/overlay/${resourceKind}/demo.bin`,
    documentRevision: 'revision:1',
    expectedDocumentHash: DOCUMENT_HASH,
    writerId: `writer:sekiro-${resourceKind}`
  };
}

function baseOperation(id: string, kind: PatchIrOperation['kind']) {
  return {
    id,
    kind,
    targetUri: 'soulforge://sekiro/overlay/other/demo.bin',
    preconditions: [],
    validatorRequirements: [],
    riskLevel: 'high' as const,
    metadata: {
      nativeFormatAuthority: true,
      requiresConfirmation: true,
      confirmationReceiptId: 'test-only-receipt'
    }
  };
}

function paramPayload(rowId: number, data: string): Extract<ResourceNodePayload, {
  nodeType: 'param_row';
}> {
  const bytes = Buffer.from(data, 'utf8');
  return {
    payloadVersion: 1,
    resourceKind: 'param',
    nodeType: 'param_row',
    paramType: 'DemoParam',
    rowId,
    rowName: `row-${rowId}`,
    snapshot: {
      storage: 'inline',
      formatId: 'PARAM:row',
      schemaVersion: '1',
      dataBase64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length
    }
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

main();
