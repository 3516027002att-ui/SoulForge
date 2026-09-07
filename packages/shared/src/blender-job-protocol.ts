export type BlenderJobState = 'queued' | 'starting' | 'running' | 'exit_observed' | 'artifact_validated' | 'staged' | 'failed' | 'cancelled' | 'timed_out' | 'orphan_cleanup_required';

export type BlenderOperation = 'export_snapshot' | 'apply_placement_delta' | 'export_mesh_channels';

export interface BlenderJobManifest {
  schemaVersion: 1;
  jobId: string;
  exportSessionId: string;
  allowedOperations: BlenderOperation[];
  inputArtifactIds: string[];
  expectedInputHashes: Record<string, string>;
  outputDirectoryHandle: string;
  coordinateProfileHash: string;
  maxOutputBytes: number;
  deadlineAt: number;
  adapterVersion: string;
  operationCount: number;
}

export interface BlenderOutputManifestEntry {
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface BlenderResultManifest {
  schemaVersion: 1;
  jobId: string;
  adapterVersion: string;
  coordinateProfileHash: string;
  inputArtifactIds: string[];
  operationCount: number;
  outputs: BlenderOutputManifestEntry[];
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
}

export function validateBlenderJobManifest(manifest: BlenderJobManifest): void {
  if (manifest.schemaVersion !== 1 || !manifest.jobId || !manifest.exportSessionId || !manifest.adapterVersion) throw new Error('BLENDER_JOB_MANIFEST_INVALID');
  if (!Number.isSafeInteger(manifest.maxOutputBytes) || manifest.maxOutputBytes <= 0 || manifest.maxOutputBytes > 256 * 1024 * 1024) throw new Error('BLENDER_OUTPUT_BUDGET_INVALID');
  if (!Number.isSafeInteger(manifest.operationCount) || manifest.operationCount < 1 || manifest.operationCount > 4096) throw new Error('BLENDER_OPERATION_COUNT_INVALID');
  if (!Number.isFinite(manifest.deadlineAt) || manifest.deadlineAt <= Date.now()) throw new Error('BLENDER_DEADLINE_INVALID');
  if (!manifest.outputDirectoryHandle || manifest.outputDirectoryHandle.includes('..') || /^[a-z]:[\\/]/iu.test(manifest.outputDirectoryHandle) || manifest.outputDirectoryHandle.startsWith('/') || manifest.outputDirectoryHandle.startsWith('\\')) throw new Error('BLENDER_OUTPUT_PATH_INVALID');
  if (manifest.allowedOperations.length === 0 || manifest.allowedOperations.some((operation) => !['export_snapshot', 'apply_placement_delta', 'export_mesh_channels'].includes(operation))) throw new Error('BLENDER_OPERATION_UNSUPPORTED');
  if (new Set(manifest.inputArtifactIds).size !== manifest.inputArtifactIds.length) throw new Error('BLENDER_ARTIFACT_ID_DUPLICATE');
  for (const [artifactId, hash] of Object.entries(manifest.expectedInputHashes)) if (!artifactId || !/^[a-f0-9]{64}$/iu.test(hash)) throw new Error('BLENDER_INPUT_HASH_INVALID');
}

export function validateBlenderResultManifest(manifest: BlenderResultManifest, expected: Pick<BlenderJobManifest, 'jobId' | 'adapterVersion' | 'coordinateProfileHash' | 'inputArtifactIds' | 'operationCount'>): void {
  if (manifest.schemaVersion !== 1 || manifest.jobId !== expected.jobId || manifest.adapterVersion !== expected.adapterVersion || manifest.coordinateProfileHash !== expected.coordinateProfileHash) throw new Error('BLENDER_RESULT_IDENTITY_MISMATCH');
  if (manifest.operationCount !== expected.operationCount) throw new Error('BLENDER_RESULT_OPERATION_COUNT_MISMATCH');
  if (manifest.inputArtifactIds.some((id) => !expected.inputArtifactIds.includes(id))) throw new Error('BLENDER_RESULT_ARTIFACT_NOT_ALLOWED');
  for (const output of manifest.outputs) {
    if (!output.relativePath || output.relativePath.includes('..') || output.relativePath.startsWith('/') || output.relativePath.startsWith('\\')) throw new Error('BLENDER_RESULT_PATH_INVALID');
    if (!Number.isSafeInteger(output.byteLength) || output.byteLength < 0 || !/^[a-f0-9]{64}$/iu.test(output.sha256)) throw new Error('BLENDER_RESULT_ENTRY_INVALID');
  }
}
