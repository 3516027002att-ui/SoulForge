import { dirname, basename } from 'node:path';
import {
  applyNativeMutation,
  commitFlverMutationViaBridge,
  commitTpfTextureReplaceViaBridge,
  commitGparamMutationsViaBridge,
  commitMtdPropertySetViaBridge,
  commitEsdTransitionViaBridge,
  commitTaeEventViaBridge,
  commitTaeEventContainerViaBridge,
  commitVfxFieldSetViaBridge,
  isParamBackupPath,
  runBridge,
  type EsdTransitionMutation,
  type GparamFieldSetMutation,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type TaeEventUpsertMutation,
  type VfxFieldSetMutation,
  type WorkspaceSession,
  type WriteConfirmationPort
} from '@soulforge/core';
import type { Diagnostic, IndexedFile } from '@soulforge/shared';
import type { RendererSaveResult } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';

export interface AssetMutationServiceDeps {
  get indexedFiles(): readonly IndexedFile[];
  get activeSession(): WorkspaceSession | null;
  verifiedStageRoots(session: WorkspaceSession, storage: { root: string }, code: string): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }>;
  durableStoragePaths(workspaceId: string): { root: string; backupBaseDir: string; recoveryDir: string; stagingRoot: string };
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  sessionCommitPort(session: WorkspaceSession, operationLog: OperationLogUtilityClient, storage: { backupBaseDir: string; recoveryDir: string }): RawReplaceCommitPort;
  toSaveResultFromOutcome(outcome: NativeMutationOutcome, files: readonly IndexedFile[]): RendererSaveResult;
}

/** Existing native candidates, confirmation and Patch Engine commits. A lazy
 * request-bound port is supplied only after the original admission checks. */
export function createAssetMutationService(deps: AssetMutationServiceDeps) {
  const applyFlverMutation = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedHash: string,
    mutation: {
        kind: 'material-slot-set';
        meshStableId: string;
        slotIndex: number;
        materialStableId: string;
      }
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FLVER_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FLVER。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      // S38 开闸：write-flver material-slot-set 经 applyNativeMutation → Patch
      // Engine 提交（editorCapabilityContract flver 块已翻 releaseWriteEnabled）。
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'FLVER_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'flver',
        stagingFileName: `${basename(file.relativePath)}.mut.flver`,
        stageWrite: (context) => commitFlverMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation
        }),
        title: `FLVER mutation ${mutation.kind} ${mutation.meshStableId}`,
        confirmActionLabel: '提交 FLVER 变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

  const saveTpfTextureReplace = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedHash: string,
    textureIndex: number,
    newTextureBase64: string
  ): Promise<RendererSaveResult> => {
    const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file || !deps.activeSession) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'TPF_WRITE_NO_SESSION',
          message: '需要已打开的工作区才能写入 TPF。',
          sourceUri
        }]
      };
    }
    const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
    if (gameBlocked) return gameBlocked;
    const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
    // ROOT-07：stage 前 mkdir → realpath → boundary check；回调同步返回
    // 已验证集合（stageBridgeOutput 的 mkdir 幂等）。
    const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'TPF_STAGING_PREPARE_FAILED');
    if (stage.diagnostics.length > 0) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: stage.diagnostics
      };
    }
    const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
    const outcome = await applyNativeMutation({
      file,
      sourceUri,
      expectedHash,
      stagingRoot: storage.stagingRoot,
      allowedRoots: () => [...stage.allowedRoots],
      stagingPrefix: 'tpf',
      stagingFileName: `${basename(file.relativePath)}.mut.tpf`,
      stageWrite: (context) => commitTpfTextureReplaceViaBridge({
        sourcePath: file.absolutePath,
        outputPath: context.outputPath,
        expectedDocumentHash: expectedHash,
        allowedRoots: context.allowedRoots,
        writableRoots: context.writableRoots,
        replace: { textureIndex, newTextureBase64 }
      }),
      title: `TPF texture replace #${textureIndex}`,
      confirmActionLabel: '替换 TPF 纹理'
    }, {
      confirm: confirmation(),
      commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
    });
    return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
  };

  const commitGparamMutations = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: GparamFieldSetMutation[]
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'GPARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 GPARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: '备份文件只能在“历史与恢复”中只读查看，不能写入 GPARAM。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'GPARAM_MUTATIONS_REQUIRED',
            message: 'GPARAM typed write 需要至少一条 mutation；没有 typed 定位就没有写入口。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'GPARAM_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const gameRoot = deps.activeSession.layers.baseRoot;
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'gparam',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitGparamMutationsViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations,
          ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
        }),
        title: `GPARAM field-set ${mutations.length} mutations`,
        confirmActionLabel: '提交 GPARAM 字段变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

  const commitMtdPropertySet = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedDocumentHash: string,
    set: { paramId: string; newValue?: string }
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MTD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MTD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: '备份文件只能在“历史与恢复”中只读查看，不能写入 MTD。',
            sourceUri
          }]
        };
      }
      if (!set || typeof set.paramId !== 'string' || set.paramId.length === 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MTD_PROPERTY_SET_REQUIRED',
            message: 'MTD typed write 需要 paramId + newValue；没有 typed 定位就没有写入口。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'MTD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const gameRoot = deps.activeSession.layers.baseRoot;
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'mtd',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitMtdPropertySetViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          set: { paramId: set.paramId, newValue: set.newValue ?? '' },
          ...(gameRoot ? { oodleRuntimeRoot: gameRoot } : {})
        }),
        title: `MTD property ${set.paramId}`,
        confirmActionLabel: '提交 MTD 材质属性变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

  const commitEsdTransition = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: EsdTransitionMutation[]
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'ESD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 ESD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: '备份文件只能在“历史与恢复”中只读查看，不能写入 ESD。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'ESD_TRANSITION_MUTATIONS_REQUIRED',
            message: 'ESD typed write 需要至少一条 transition mutation（behavior-transition-upsert）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'ESD_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'esd',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitEsdTransitionViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations
        }),
        title: `ESD transition upsert × ${mutations.length}`,
        confirmActionLabel: '提交 ESD 状态转移变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

  const commitTaeEvent = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: TaeEventUpsertMutation[]
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'TAE_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 TAE。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: '备份文件只能在“历史与恢复”中只读查看，不能写入 TAE。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'TAE_EVENT_MUTATIONS_REQUIRED',
            message: 'TAE typed write 需要至少一条 event upsert mutation（tae-event-upsert）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const isAnibnd = /\.anibnd(?:\.dcx)?$/iu.test(file.absolutePath);
      const taeEntryIndexes = [...new Set(mutations
        .map((mutation) => mutation.taeEntryIndex)
        .filter((index): index is number => Number.isInteger(index)))];
      let commitExpectedHash = expectedDocumentHash;
      let containerEntryIndex: number | undefined;
      if (isAnibnd) {
        if (taeEntryIndexes.length === 0
          || mutations.some((mutation) => (
            !Number.isInteger(mutation.taeEntryIndex)
            || !taeEntryIndexes.includes(mutation.taeEntryIndex as number)
          ))) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: [{
              severity: 'error' as const,
              code: 'TAE_CONTAINER_ENTRY_REQUIRED',
              message: 'ANIBND TAE 写回必须为每条 mutation 提供有效的 taeEntryIndex。',
              sourceUri
            }]
          };
        }
        containerEntryIndex = taeEntryIndexes.length === 1 ? taeEntryIndexes[0] : undefined;
        const current = await runBridge<{
          sourceHash?: string;
          outerFileHash?: string;
          containerSourceHash?: string;
        }>({
          command: 'read-tae-document',
          filePath: file.absolutePath,
          // Hash validation needs the native aggregate identity, not every
          // animation's decoded event fields.
          commandOptions: { animationPage: 0, animationPageSize: 1 },
          allowedRoots: [dirname(file.absolutePath)],
          ...(deps.activeSession.layers.baseRoot
            ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
            : {}),
          timeoutMs: 120_000
        });
        if (current.parseStatus === 'failed' || !current.data?.outerFileHash) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: current.diagnostics.length > 0
              ? current.diagnostics
              : [{
                severity: 'error' as const,
                code: 'TAE_CONTAINER_HASH_UNAVAILABLE',
                message: '无法取得 ANIBND 外层 source hash，已拒绝 TAE 写回。',
                sourceUri
              }]
          };
        }
        if (current.data.sourceHash !== expectedDocumentHash) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: [{
              severity: 'error' as const,
              code: 'TAE_SOURCE_VERSION_STALE',
              message: 'TAE 聚合文档在读取后已变化，请重新读取后再写回。',
              sourceUri,
              details: { expectedDocumentHash, currentDocumentHash: current.data.sourceHash }
            }]
          };
        }
        commitExpectedHash = current.data.outerFileHash;
      } else if (taeEntryIndexes.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'TAE_LOOSE_ENTRY_SELECTOR_INVALID',
            message: '裸 TAE 不接受 taeEntryIndex；请使用 ANIBND 文档的 child identity。',
            sourceUri
          }]
        };
      }
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'TAE_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file: commitExpectedHash === expectedDocumentHash ? file : { ...file, sha256: commitExpectedHash },
        sourceUri,
        expectedHash: commitExpectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'tae',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => isAnibnd
          ? commitTaeEventContainerViaBridge({
            sourcePath: file.absolutePath,
            outputPath: context.outputPath,
            expectedDocumentHash: commitExpectedHash,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            mutations,
            ...(containerEntryIndex === undefined ? {} : { taeEntryIndex: containerEntryIndex }),
            ...(deps.activeSession?.layers.baseRoot
              ? { oodleRuntimeRoot: deps.activeSession.layers.baseRoot }
              : {})
          })
          : commitTaeEventViaBridge({
            sourcePath: file.absolutePath,
            outputPath: context.outputPath,
            expectedDocumentHash: commitExpectedHash,
            allowedRoots: context.allowedRoots,
            writableRoots: context.writableRoots,
            mutations
          }),
        title: `TAE event upsert × ${mutations.length}`,
        confirmActionLabel: '提交 TAE 事件变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

  const commitFxrFieldSet = async (
    confirmation: () => WriteConfirmationPort,
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: VfxFieldSetMutation[]
  ): Promise<RendererSaveResult> => {
      const file = deps.indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !deps.activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FXR_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FXR。',
            sourceUri
          }]
        };
      }
      const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (isParamBackupPath(file.relativePath)) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'BACKUP_READ_FORBIDDEN',
            message: '备份文件只能在“历史与恢复”中只读查看，不能写入 FXR。',
            sourceUri
          }]
        };
      }
      if (!Array.isArray(mutations) || mutations.length === 0
        || !mutations.every((m) => m && typeof m.mutation === 'string')) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FXR_FIELD_SET_MUTATIONS_REQUIRED',
            message: 'FXR typed write 需要至少一条 field set mutation（vfx-field-set）。',
            sourceUri
          }]
        };
      }
      const storage = deps.durableStoragePaths(deps.activeSession.meta.workspaceId);
      const stage = await deps.verifiedStageRoots(deps.activeSession, storage, 'FXR_STAGING_PREPARE_FAILED');
      if (stage.diagnostics.length > 0) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: stage.diagnostics
        };
      }
      const operationLog = await deps.ensureActiveOperationLog(deps.activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash: expectedDocumentHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: () => [...stage.allowedRoots],
        stagingPrefix: 'fxr',
        stagingFileName: `${basename(file.relativePath)}.mut`,
        stageWrite: (context) => commitVfxFieldSetViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutations
        }),
        title: `FXR field set × ${mutations.length}`,
        confirmActionLabel: '提交 FXR 字段变更'
      }, {
        confirm: confirmation(),
        commit: deps.sessionCommitPort(deps.activeSession, operationLog, storage)
      });
      return deps.toSaveResultFromOutcome(outcome, deps.indexedFiles);
    };

return Object.freeze({ applyFlverMutation, saveTpfTextureReplace, commitGparamMutations, commitMtdPropertySet, commitEsdTransition, commitTaeEvent, commitFxrFieldSet });
}
export type AssetMutationService = ReturnType<typeof createAssetMutationService>;
