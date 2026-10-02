import { createHash } from 'node:crypto';
import { replaceContainerChild as replaceNativeContainerChild, saveTextResource, openResourcePreview, type WorkspaceSession } from '@soulforge/core';
import type { IndexedFile } from '@soulforge/shared';
import { toRendererSaveResult, type RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import { cancelledWrite, type ResourceWriteConfirmation } from './resourceWriteContext.js';
import { runCallerOwnedPostCommit } from '../knowledgeRefreshOwnership.js';
import { appendRendererPostCommitFailureDiagnostic } from '../rendererPostCommitDiagnostic.js';
import { captureResourcePostCommitOwner, type ResourcePostCommitOwnerDeps } from './resourcePostCommitOwner.js';

export interface ResourceMutationServiceDeps extends ResourcePostCommitOwnerDeps {
  getIndexedFiles(): readonly IndexedFile[];
  replaceIndexedFile(sourceUri: string, file: IndexedFile): boolean;
  getActiveSession(): WorkspaceSession | null;
  durableStoragePaths(workspaceId: string): {
    root: string;
    backupBaseDir: string;
    recoveryDir: string;
    stagingRoot: string;
  };
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: unknown
  ): Promise<unknown>;
  bumpPathSourceGenerationForUris(uris: readonly string[]): void;
  clearResourceRelatedCaches(): void;
}


/** Existing resource orchestration, callable without IPC registration or sender capability. */
export function createResourceMutationService(deps: ResourceMutationServiceDeps) {
  const replaceContainerChild = async (
    requestWriteConfirmation: ResourceWriteConfirmation,
    childUri: string,
    expectedContainerHash: string,
    expectedChildHash: string,
    newContentBase64: string
  ): Promise<RendererSaveResult> => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = deps.getIndexedFiles().find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'RESOURCE_NOT_INDEXED',
              message: 'Parent container must be indexed before child replace.',
              sourceUri: containerUri
            }
          ]
        };
      }
      const activeSession = deps.getActiveSession();
      const owner = captureResourcePostCommitOwner(deps, activeSession, containerUri);
      if (!activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'CONTAINER_WRITE_NO_SESSION',
              message: '需要已打开的 Sekiro 工作区才能替换容器子项。',
              sourceUri: containerUri
            }
          ]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const operationLog = activeSession
        ? await deps.ensureActiveOperationLog(activeSession)
        : undefined;
      const storage = activeSession ? deps.durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      const confirmation = await requestWriteConfirmation({
        resourceLabel: `${file.relativePath} / ${childUri.slice(childUri.indexOf('#') + 1)}`,
        sourceUri: containerUri,
        actionLabel: '替换容器子项',
        payloadHash: createHash('sha256')
          .update(`${expectedContainerHash}\n${expectedChildHash}\n${newContentBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(containerUri);
      const result = await replaceNativeContainerChild({
        file,
        childUri,
        expectedContainerHash,
        expectedChildHash,
        newContentBase64,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      if (result.ok) {
        await runCallerOwnedPostCommit(result, {
          prepare: () => { if (owner.canProject(result)) deps.clearResourceRelatedCaches(); },
          refresh: async carrier => { if (owner.canProject(carrier)) await deps.refreshActiveIndexAfterNativeWrite([containerUri], carrier); },
          onPrepareError: (carrier, error) => appendRendererPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_PREVIEW_FAILED', containerUri, error),
          onRefreshError: (carrier, error) => appendRendererPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_REFRESH_FAILED', containerUri, error)
        });
      }
      return toRendererSaveResult(result, owner.receiptFiles);
    };

  const saveText = async (
    requestWriteConfirmation: ResourceWriteConfirmation,
    sourceUri: string,
    newText: string
  ): Promise<RendererSaveResult> => {
      const file = deps.getIndexedFiles().find((item) => item.sourceUri === sourceUri);
      if (!file)
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'RESOURCE_NOT_INDEXED',
              message: '请先索引资源，再保存文件。',
              sourceUri
            }
          ]
        };
      const activeSession = deps.getActiveSession();
      const owner = captureResourcePostCommitOwner(deps, activeSession, sourceUri);
      const operationLog = activeSession ? await deps.ensureActiveOperationLog(activeSession) : undefined;
      const storage = activeSession ? deps.durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      let result = await saveTextResource({
        file,
        newText,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      if (!result.ok && (result as { requiresConfirmation?: boolean }).requiresConfirmation) {
        const confirmation = await requestWriteConfirmation({
          resourceLabel: file.relativePath,
          sourceUri,
          actionLabel: 'save',
          payloadHash: createHash('sha256').update(newText).digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        result = await saveTextResource({
          file,
          newText,
          confirmation,
          ...(activeSession ? { session: activeSession } : {}),
          ...(operationLog ? { operationLog } : {}),
          ...(storage ?? {})
        });
      }
      if (result.ok) {
        await runCallerOwnedPostCommit(result, {
          prepare: async () => {
            if (!owner.canProject(result)) return;
            deps.bumpPathSourceGenerationForUris([sourceUri]);
            const refreshed = await openResourcePreview({
              file,
              inspectNative: true,
              parseStructured: true,
              ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
            });
            if (owner.canProject(result)) deps.replaceIndexedFile(sourceUri, refreshed.file);
          },
          refresh: async carrier => { if (owner.canProject(carrier)) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], carrier); },
          onPrepareError: (carrier, error) => appendRendererPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_PREVIEW_FAILED', sourceUri, error),
          onRefreshError: (carrier, error) => appendRendererPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_REFRESH_FAILED', sourceUri, error)
        });
      }
      return toRendererSaveResult(result, owner.receiptFiles);
    };

  return Object.freeze({ replaceContainerChild, saveText });
}
export type ResourceMutationService = ReturnType<typeof createResourceMutationService>;
