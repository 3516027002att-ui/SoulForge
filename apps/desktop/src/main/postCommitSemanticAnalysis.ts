import type { AnalyzeWorkspaceOptions } from '@soulforge/core';
import type { IndexedFile } from '@soulforge/shared';

export function createPostCommitSemanticAnalysisOptions(input: {
  workspaceRoot: string;
  files: readonly IndexedFile[];
  signal?: AbortSignal;
  oodleRuntimeRoot?: string;
}): AnalyzeWorkspaceOptions {
  return {
    workspaceRoot: input.workspaceRoot,
    files: input.files,
    // refreshNativeSemanticSources performs the authoritative, revision-bound
    // decode immediately afterward. Do not export/inspect the same native
    // PARAM, MSG, EMEVD, or MSB again into a second full semantic candidate.
    exportNativeCandidateResources: false,
    exportNativeMsgResources: false,
    inspectNativeResources: false,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.oodleRuntimeRoot ? { oodleRuntimeRoot: input.oodleRuntimeRoot } : {})
  };
}
