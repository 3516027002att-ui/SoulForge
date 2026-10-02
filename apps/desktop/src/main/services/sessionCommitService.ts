import { createConfirmationReceipt, saveRawReplace, type RawReplaceCommitPort, type WorkspaceSession } from '@soulforge/core';
import type { SaveTextResourceResult } from '@soulforge/shared';
import { appendPostCommitFailureDiagnostic, commitWithKnowledgeRefresh, type KnowledgeRefreshOwner } from '../knowledgeRefreshOwnership.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';

export interface SessionCommitServiceDeps {
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
  getActiveWorkspaceSessionGeneration(): number;
  refreshActiveIndexAfterNativeWrite(changedSources?: readonly string[], carrier?: Pick<SaveTextResourceResult, 'knowledgeRefresh'>): Promise<unknown>;
}

/** Bind native commit orchestration to its durable session and operation log.
 * Patch Engine retains write authority; current-workspace projection is allowed
 * only while the same activation owns this port. */
export function createSessionCommitPort(
  deps: SessionCommitServiceDeps,
  session: WorkspaceSession,
  operationLog: OperationLogUtilityClient,
  storage: { backupBaseDir: string; recoveryDir: string },
  options: { knowledgeRefreshOwner?: KnowledgeRefreshOwner } = {}
): RawReplaceCommitPort {
  const generation = deps.getActiveWorkspaceSessionGeneration();
  return {
    commit: async (input) => {
      const sourceUri = input.file.sourceUri;
      const confirmation = input.confirmation ?? createConfirmationReceipt({
        subjects: [
          'MAIN_WORKBENCH_COMMIT',
          sourceUri,
          'ALL_RISKS',
          ...(deps.getActiveWorkspaceSessionId() ? [`WORKSPACE_SESSION:${deps.getActiveWorkspaceSessionId()}`] : []),
          `TITLE:${input.title}`
        ],
        riskLevel: 'high',
        sourceUri,
        note: '工作台提交视为已确认'
      });
      return commitWithKnowledgeRefresh(
        () => saveRawReplace({
          file: input.file,
          expectedHash: input.expectedHash,
          newContentBase64: input.newContentBase64,
          title: input.title,
          confirmation,
          session,
          operationLog,
          backupBaseDir: storage.backupBaseDir,
          recoveryDir: storage.recoveryDir
        }),
        options.knowledgeRefreshOwner ?? 'port',
        async (result) => {
          if (deps.getActiveSession() !== session || deps.getActiveWorkspaceSessionGeneration() !== generation) {
            result.diagnostics.push({
              severity: 'warning', code: 'POSTCOMMIT_WORKSPACE_SUPERSEDED', sourceUri,
              message: '写入已提交，但工作区会话已更换；未向当前会话发布旧投影。'
            });
            return;
          }
          await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
        },
        (result, error) => appendPostCommitFailureDiagnostic(
          result, 'POSTCOMMIT_REFRESH_FAILED', sourceUri, error
        )
      );
    }
  };
}
