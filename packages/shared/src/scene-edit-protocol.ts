/**
 * Renderer-independent scene edit contract.  It carries opaque handles and
 * source identities only; absolute filesystem paths never cross this boundary.
 */

export type SceneEditLevel = 0 | 1 | 2 | 3 | 4;
export type SceneObjectKind = 'model' | 'part' | 'region' | 'event' | 'route' | 'asset';

export interface SceneResourceIdentity {
  sourceUri: string;
  sourceHash: string;
  game: string;
  resourceKind: 'map' | 'model' | 'asset';
  mapId?: string;
}

export interface SceneNativeIdentity {
  family: string;
  nativeOffset: number;
  stableKey: string;
}

export interface SceneCapability {
  level: SceneEditLevel;
  operation: string;
  profile: string;
  writable: boolean;
  blockers: string[];
  testedVariants: string[];
}

export interface SceneSnapshotObject {
  objectHandle: string;
  kind: SceneObjectKind;
  displayName: string;
  nativeIdentityAtSnapshot: SceneNativeIdentity;
  localMatrix: number[];
  parentHandle: string | null;
  modelAssetHandle: string | null;
}

export interface SceneAssetRef {
  assetHandle: string;
  identity: SceneResourceIdentity;
  sourceHash: string;
  sharedInstanceCount: number;
}

export interface SceneSnapshotV2 {
  schemaVersion: 2;
  exportSessionId: string;
  workspaceId: string;
  sceneResourceIdentity: SceneResourceIdentity;
  snapshotVersion: string;
  coordinateProfileId: string;
  coordinateProfileHash: string;
  objects: SceneSnapshotObject[];
  assetRefs: SceneAssetRef[];
  capabilities: SceneCapability[];
}

export type SceneDeltaOperation =
  | {
      operationId: string;
      kind: 'set_transform';
      objectHandle: string;
      matrix: number[];
    }
  | {
      operationId: string;
      kind: 'set_model';
      objectHandle: string;
      modelAssetHandle: string;
    }
  | {
      operationId: string;
      kind: 'delete' | 'create' | 'duplicate' | 'reparent';
      objectHandle: string;
      parentHandle?: string | null;
    };

export interface SceneDeltaV2 {
  schemaVersion: 2;
  exportSessionId: string;
  baseVersion: string;
  coordinateProfileHash: string;
  operations: SceneDeltaOperation[];
}

export interface SceneDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  operationId?: string;
  objectHandle?: string;
}

export type ScenePreviewResult = {
  ok: true;
  snapshotVersion: string;
  operations: SceneDeltaOperation[];
  nativeMatrices: Record<string, number[]>;
  diagnostics: SceneDiagnostic[];
  affectedObjectHandles: string[];
} | {
  ok: false;
  diagnostics: SceneDiagnostic[];
};

export function isSceneSnapshotV2(value: unknown): value is SceneSnapshotV2 {
  return Boolean(value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2);
}

export function isSceneDeltaV2(value: unknown): value is SceneDeltaV2 {
  return Boolean(value && typeof value === 'object' && (value as { schemaVersion?: unknown }).schemaVersion === 2);
}
