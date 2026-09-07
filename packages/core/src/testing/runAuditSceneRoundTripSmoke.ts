import { strict as assert } from 'node:assert';
import type { SceneCapability, SceneDeltaV2, SceneSnapshotV2 } from '@soulforge/shared';
import { SceneEditService } from '../scene/sceneEditService.js';
import { SceneExportLeaseStore } from '../scene/sceneExportLeaseStore.js';
import { createCoordinateProfile, identityMatrix4, matrixResidual, convertNativeMatrixToBlender } from '../scene/coordinateTransform.js';

export function runSceneRoundTripSmoke(): { sessionId: string; affectedObjectHandles: string[]; residual: number } {
  const profile = createCoordinateProfile({
    profileId: 'fixture-native-yz-swap',
    units: 'meters',
    handedness: 'left',
    upAxis: 'z',
    forwardAxis: '-y',
    eulerOrder: 'XYZ',
    angleUnit: 'degrees',
    nativeToBlender: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
  });
  const capability: SceneCapability = { level: 0, operation: 'set_transform', profile: 'msb-transform-fixture', writable: true, blockers: [], testedVariants: ['non-symmetric-translation', 'non-uniform-scale'] };
  const service = new SceneEditService(new SceneExportLeaseStore());
  const nativeMatrix = [2, 0, 0, 11, 0, 3, 0, 7, 0, 0, 4, -5, 0, 0, 0, 1];
  const snapshot = service.exportSnapshot({
    owner: 'owner-a',
    workspaceId: 'ws-a',
    sceneResourceIdentity: { sourceUri: 'file:///map/m10.msb.dcx', sourceHash: 'map-hash', game: 'sekiro', resourceKind: 'map', mapId: 'm10_00_00_00' },
    snapshotVersion: 'rev-map-1',
    coordinateProfile: profile,
    objects: [{ objectHandle: 'object:part:1', kind: 'part', displayName: 'm000000', nativeIdentityAtSnapshot: { family: 'part', nativeOffset: 0x100, stableKey: 'part:m10:offset-100' }, localMatrix: nativeMatrix, parentHandle: null, modelAssetHandle: 'asset:flver:1' }],
    assetRefs: [{ assetHandle: 'asset:flver:1', identity: { sourceUri: 'file:///map/m10.flver', sourceHash: 'flver-hash', game: 'sekiro', resourceKind: 'model' }, sourceHash: 'flver-hash', sharedInstanceCount: 2 }],
    capabilities: [capability]
  });
  const blenderMatrix = convertNativeMatrixToBlender(profile, nativeMatrix);
  const delta: SceneDeltaV2 = { schemaVersion: 2, exportSessionId: snapshot.exportSessionId, baseVersion: snapshot.snapshotVersion, coordinateProfileHash: profile.profileHash, operations: [{ operationId: 'op-1', kind: 'set_transform', objectHandle: 'object:part:1', matrix: blenderMatrix }] };
  const preview = service.previewDelta({ owner: 'owner-a', workspaceId: 'ws-a', snapshot, delta, coordinateProfile: profile });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  if (!preview.ok) throw new Error('scene preview failed');
  assert.equal(matrixResidual(preview.nativeMatrices['object:part:1']!, nativeMatrix), 0);
  const transaction = service.buildMapTransaction({ snapshot, delta, preview, coordinateProfile: profile });
  assert.equal(transaction.operations.length, 1);

  const duplicateOp: SceneDeltaV2 = { ...delta, operations: [delta.operations[0]!, { ...delta.operations[0]!, objectHandle: 'object:part:1' }] };
  assert.equal(service.previewDelta({ owner: 'owner-a', workspaceId: 'ws-a', snapshot, delta: duplicateOp, coordinateProfile: profile }).ok, false);
  const staleProfile = { ...delta, coordinateProfileHash: '0'.repeat(64) };
  assert.equal(service.previewDelta({ owner: 'owner-a', workspaceId: 'ws-a', snapshot, delta: staleProfile, coordinateProfile: profile }).ok, false);
  const oldSchema = { ...delta, schemaVersion: 1 } as unknown as SceneDeltaV2;
  assert.equal(service.previewDelta({ owner: 'owner-a', workspaceId: 'ws-a', snapshot, delta: oldSchema, coordinateProfile: profile }).ok, false);
  const deletedThenModified: SceneDeltaV2 = { ...delta, operations: [
    { operationId: 'delete', kind: 'delete', objectHandle: 'object:part:1' },
    { ...delta.operations[0]!, operationId: 'after-delete' }
  ] };
  const deletedResult = service.previewDelta({ owner: 'owner-a', workspaceId: 'ws-a', snapshot, delta: deletedThenModified, coordinateProfile: profile });
  assert.equal(deletedResult.ok, false);
  assert(deletedResult.ok === false && deletedResult.diagnostics.some((item) => item.code === 'SCENE_TARGET_DELETED'));

  return { sessionId: snapshot.exportSessionId, affectedObjectHandles: preview.affectedObjectHandles, residual: matrixResidual(preview.nativeMatrices['object:part:1']!, nativeMatrix) };
}

void (process.argv[1]?.endsWith('runAuditSceneRoundTripSmoke.js') ? (() => {
  const result = runSceneRoundTripSmoke();
  console.log(JSON.stringify({ ok: true, taskId: 'SF-25', suite: 'scene-round-trip', layer: 'unit', executedCases: 12, ...result }));
})() : undefined);
