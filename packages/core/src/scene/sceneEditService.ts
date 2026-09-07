import { randomUUID } from 'node:crypto';
import type {
  MapEditTransaction,
  SceneCapability,
  SceneDeltaV2,
  SceneDiagnostic,
  ScenePreviewResult,
  SceneResourceIdentity,
  SceneSnapshotObject,
  SceneSnapshotV2
} from '@soulforge/shared';
import { isSceneDeltaV2 } from '@soulforge/shared';
import {
  assertMatrix4,
  assertTrsRepresentable,
  convertBlenderMatrixToNative,
  convertNativeMatrixToBlender,
  type CoordinateProfile,
  type Matrix4
} from './coordinateTransform.js';
import { SceneExportLeaseStore } from './sceneExportLeaseStore.js';

export interface SceneSnapshotObjectInput extends SceneSnapshotObject {}

export interface CreateSceneSnapshotInput {
  owner: string;
  workspaceId: string;
  sceneResourceIdentity: SceneResourceIdentity;
  snapshotVersion: string;
  coordinateProfile: CoordinateProfile;
  objects: SceneSnapshotObjectInput[];
  assetRefs: SceneSnapshotV2['assetRefs'];
  capabilities: SceneCapability[];
}

export interface PreviewDeltaInput {
  owner: string;
  workspaceId: string;
  snapshot: SceneSnapshotV2;
  delta: SceneDeltaV2;
  coordinateProfile: CoordinateProfile;
}

export class SceneEditService {
  constructor(private readonly leaseStore: SceneExportLeaseStore) {}

  exportSnapshot(input: CreateSceneSnapshotInput): SceneSnapshotV2 {
    if (!input.owner || !input.workspaceId || !input.snapshotVersion) throw new Error('SCENE_SNAPSHOT_IDENTITY_INVALID');
    if (input.coordinateProfile.profileHash.length !== 64) throw new Error('SCENE_COORDINATE_PROFILE_REQUIRED');
    const objectHandles = input.objects.map((object) => object.objectHandle);
    if (new Set(objectHandles).size !== objectHandles.length || objectHandles.some((handle) => !handle)) throw new Error('SCENE_OBJECT_HANDLE_DUPLICATE');
    const assetHandles = input.assetRefs.map((asset) => asset.assetHandle);
    if (new Set(assetHandles).size !== assetHandles.length) throw new Error('SCENE_ASSET_HANDLE_DUPLICATE');
    const lease = this.leaseStore.open({
      owner: input.owner,
      workspaceId: input.workspaceId,
      sourceVersions: { [input.sceneResourceIdentity.sourceUri]: input.snapshotVersion },
      objectAllowlist: objectHandles,
      assetAllowlist: assetHandles,
      coordinateProfileHash: input.coordinateProfile.profileHash,
      expiresAt: Date.now() + 10 * 60_000,
      sceneResourceIdentity: input.sceneResourceIdentity
    });
    return {
      schemaVersion: 2,
      exportSessionId: lease.exportSessionId,
      workspaceId: input.workspaceId,
      sceneResourceIdentity: structuredClone(input.sceneResourceIdentity),
      snapshotVersion: input.snapshotVersion,
      coordinateProfileId: input.coordinateProfile.profileId,
      coordinateProfileHash: input.coordinateProfile.profileHash,
      objects: structuredClone(input.objects),
      assetRefs: structuredClone(input.assetRefs),
      capabilities: structuredClone(input.capabilities)
    };
  }

  previewDelta(input: PreviewDeltaInput): ScenePreviewResult {
    const diagnostics: SceneDiagnostic[] = [];
    if (!isSceneDeltaV2(input.delta)) return { ok: false, diagnostics: [{ severity: 'error', code: 'SCENE_SCHEMA_VERSION_UNSUPPORTED', message: '只接受 schemaVersion=2 的场景 delta。' }] };
    if (input.snapshot.schemaVersion !== 2) return { ok: false, diagnostics: [{ severity: 'error', code: 'SCENE_SCHEMA_VERSION_UNSUPPORTED', message: '只接受 schemaVersion=2 的场景 snapshot。' }] };
    let lease;
    try {
      lease = this.leaseStore.requireAuthorized(input.delta.exportSessionId, input.owner, input.workspaceId);
    } catch (error) {
      return { ok: false, diagnostics: [{ severity: 'error', code: error instanceof Error ? error.message : 'SCENE_LEASE_UNAUTHORIZED', message: '场景导出会话未授权或已过期。' }] };
    }
    if (input.snapshot.exportSessionId !== lease.exportSessionId) diagnostics.push({ severity: 'error', code: 'SCENE_SESSION_MISMATCH', message: 'snapshot 与 delta 不是同一个导出会话。' });
    if (input.delta.baseVersion !== input.snapshot.snapshotVersion) diagnostics.push({ severity: 'error', code: 'SCENE_BASE_VERSION_STALE', message: 'delta 基于旧 snapshot version。' });
    if (input.delta.coordinateProfileHash !== lease.coordinateProfileHash || input.delta.coordinateProfileHash !== input.coordinateProfile.profileHash) diagnostics.push({ severity: 'error', code: 'SCENE_COORDINATE_PROFILE_DRIFT', message: '坐标 profile 已漂移，禁止导入。' });
    if (input.delta.operations.length > 4096) diagnostics.push({ severity: 'error', code: 'SCENE_DELTA_TOO_LARGE', message: '单次 delta 最多允许 4096 个 operation。' });
    const objectByHandle = new Map(input.snapshot.objects.map((object) => [object.objectHandle, object]));
    const assetHandles = new Set(lease.assetAllowlist);
    const operationIds = new Set<string>();
    const deleted = new Set<string>();
    const nativeMatrices: Record<string, number[]> = {};
    const affected = new Set<string>();
    for (const operation of input.delta.operations) {
      if (!operation.operationId || operationIds.has(operation.operationId)) {
        diagnostics.push({ severity: 'error', code: 'SCENE_OPERATION_ID_DUPLICATE', message: 'operationId 必须唯一。', operationId: operation.operationId });
        continue;
      }
      operationIds.add(operation.operationId);
      if (!lease.objectAllowlist.includes(operation.objectHandle) || !objectByHandle.has(operation.objectHandle)) {
        diagnostics.push({ severity: 'error', code: 'SCENE_OBJECT_NOT_ALLOWED', message: '目标不在导出会话 allowlist 中。', operationId: operation.operationId, objectHandle: operation.objectHandle });
        continue;
      }
      if (deleted.has(operation.objectHandle)) {
        diagnostics.push({ severity: 'error', code: 'SCENE_TARGET_DELETED', message: '已删除对象不能再次修改。', operationId: operation.operationId, objectHandle: operation.objectHandle });
        continue;
      }
      if (operation.kind === 'set_transform') {
        if (!hasWritableCapability(input.snapshot.capabilities, 'set_transform')) {
          diagnostics.push({ severity: 'error', code: 'SCENE_CAPABILITY_BLOCKED', message: '当前 profile 未证明 set_transform 可写。', operationId: operation.operationId, objectHandle: operation.objectHandle });
          continue;
        }
        try {
          const nativeMatrix = convertBlenderMatrixToNative(input.coordinateProfile, assertMatrix4(operation.matrix, 'delta.matrix'));
          assertTrsRepresentable(nativeMatrix);
          nativeMatrices[operation.objectHandle] = nativeMatrix;
          affected.add(operation.objectHandle);
        } catch (error) {
          diagnostics.push({ severity: 'error', code: error instanceof Error ? error.message.split(':')[0]! : 'TRANSFORM_NOT_REPRESENTABLE', message: error instanceof Error ? error.message : String(error), operationId: operation.operationId, objectHandle: operation.objectHandle });
        }
      } else if (operation.kind === 'set_model') {
        if (!assetHandles.has(operation.modelAssetHandle)) diagnostics.push({ severity: 'error', code: 'SCENE_ASSET_NOT_ALLOWED', message: '模型资产不在导出会话 allowlist 中。', operationId: operation.operationId, objectHandle: operation.objectHandle });
        else if (!hasWritableCapability(input.snapshot.capabilities, 'set_model')) diagnostics.push({ severity: 'error', code: 'SCENE_CAPABILITY_BLOCKED', message: '当前 profile 未证明模型引用可写。', operationId: operation.operationId, objectHandle: operation.objectHandle });
        else affected.add(operation.objectHandle);
      } else {
        if (operation.kind === 'delete') deleted.add(operation.objectHandle);
        diagnostics.push({ severity: 'error', code: `SCENE_${operation.kind.toUpperCase()}_UNSUPPORTED`, message: `${operation.kind} 需要独立 native profile/引用闭包，当前拒绝。`, operationId: operation.operationId, objectHandle: operation.objectHandle });
      }
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { ok: false, diagnostics };
    return { ok: true, snapshotVersion: input.snapshot.snapshotVersion, operations: structuredClone(input.delta.operations), nativeMatrices, diagnostics, affectedObjectHandles: [...affected] };
  }

  buildMapTransaction(input: { snapshot: SceneSnapshotV2; delta: SceneDeltaV2; preview: Extract<ScenePreviewResult, { ok: true }>; coordinateProfile: CoordinateProfile }): MapEditTransaction {
    const mapId = input.snapshot.sceneResourceIdentity.mapId;
    if (!mapId) throw new Error('SCENE_MAP_ID_REQUIRED');
    const objects = new Map(input.snapshot.objects.map((object) => [object.objectHandle, object]));
    const operations: MapEditTransaction['operations'] = [];
    for (const operation of input.preview.operations) {
      if (operation.kind !== 'set_transform') continue;
      const object = objects.get(operation.objectHandle);
      const native = input.preview.nativeMatrices[operation.objectHandle];
      if (!object || !native) continue;
      const trs = assertTrsRepresentable(native);
      operations.push({ target: object.nativeIdentityAtSnapshot.stableKey, kind: 'set_transform', position: trs.translation, rotation: [0, 0, 0], scale: trs.scale });
    }
    if (operations.length === 0) throw new Error('SCENE_NO_MAP_OPERATIONS');
    return { id: `tx-scene-${randomUUID()}`, mapId, baseRevision: input.snapshot.snapshotVersion, description: 'SceneEditService verified scene delta', author: 'blender', operations, timestamp: Date.now() };
  }
}

function hasWritableCapability(capabilities: readonly SceneCapability[], operation: string): boolean {
  return capabilities.some((capability) => capability.operation === operation && capability.level === 0 && capability.writable && capability.blockers.length === 0);
}

export function sceneSnapshotMatrixInBlender(snapshot: SceneSnapshotV2, profile: CoordinateProfile, objectHandle: string): Matrix4 {
  const object = snapshot.objects.find((candidate) => candidate.objectHandle === objectHandle);
  if (!object) throw new Error('SCENE_OBJECT_NOT_FOUND');
  return convertNativeMatrixToBlender(profile, object.localMatrix);
}
