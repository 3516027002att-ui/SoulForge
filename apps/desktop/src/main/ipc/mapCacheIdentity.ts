export interface MapCacheIdentityInput {
  workspaceSessionId: string | null;
  workspaceSessionGeneration: number;
  workspaceId: string | null;
  indexedFilesRevision: number;
  indexedFilesIdentityDigest: string;
  overlayRoot: string | null;
  baseRoot: string | null;
}

/** Opaque cache identity shared by model, directory and allowed-root caches. */
export function makeMapCacheIdentity(input: MapCacheIdentityInput): string {
  return JSON.stringify({
    sessionId: input.workspaceSessionId,
    generation: input.workspaceSessionGeneration,
    workspaceId: input.workspaceId,
    revision: input.indexedFilesRevision,
    catalog: input.indexedFilesIdentityDigest,
    overlayRoot: input.overlayRoot,
    baseRoot: input.baseRoot
  });
}
