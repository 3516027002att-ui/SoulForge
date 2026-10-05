import type { WorkspaceSession } from '@soulforge/core';
import type { Diagnostic, IndexedFile } from '@soulforge/shared';
import type { RendererResourceLabelSource } from '../rendererDto.js';

export interface ResourcePostCommitOwnerDeps {
  getIndexedFiles(): readonly IndexedFile[];
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionGeneration(): number;
}

/** Capture before the first await. Object identity separates owners; activation
 * generation also rejects a remount of the same session object. */
export function captureResourcePostCommitOwner(
  deps: ResourcePostCommitOwnerDeps,
  session: WorkspaceSession | null,
  sourceUri: string
) {
  const generation = deps.getActiveWorkspaceSessionGeneration();
  const receiptFiles: readonly RendererResourceLabelSource[] = deps.getIndexedFiles().map(file => Object.freeze({
    absolutePath: file.absolutePath,
    sourcePath: file.sourcePath,
    sourceUri: file.sourceUri
  }));
  let warned = false;
  const canProject = (result: { diagnostics: Diagnostic[] }): boolean => {
    if (deps.getActiveSession() === session && deps.getActiveWorkspaceSessionGeneration() === generation) return true;
    if (!warned) {
      warned = true;
      result.diagnostics.push({
        severity: 'warning', code: 'POSTCOMMIT_WORKSPACE_SUPERSEDED', sourceUri,
        message: '写入已提交，但工作区会话已更换；未向当前会话发布旧投影。'
      });
    }
    return false;
  };
  return { receiptFiles, canProject };
}
