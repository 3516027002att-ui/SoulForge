import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyNativeMutation, encodeScriptSourceForWriteback, inspectContainerTree, openResourcePreview, readContainerChild, replaceContainerChild, runBridge, saveRawReplace, type NativeMutationOutcome, type RawReplaceCommitPort, type WorkspaceSession } from '@soulforge/core';
import type { Diagnostic, IndexedFile } from '@soulforge/shared';
import { toRendererSaveResult, type RendererSaveResult, type RendererResourceLabelSource } from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import { runCallerOwnedPostCommit, type KnowledgeRefreshOwner } from '../knowledgeRefreshOwnership.js';
import { appendRendererPostCommitFailureDiagnostic as appendPostCommitFailureDiagnostic } from '../rendererPostCommitDiagnostic.js';
import { cancelledWrite, confirmationRequiredResult, type ResourceWriteConfirmation } from './resourceWriteContext.js';
import { captureResourcePostCommitOwner, type ResourcePostCommitOwnerDeps } from './resourcePostCommitOwner.js';

export interface ScriptSourceServiceDeps extends ResourcePostCommitOwnerDeps {
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
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  verifiedStageRoots(
    session: WorkspaceSession,
    storage: { root: string },
    code: string
  ): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }>;
  sessionCommitPort(
    session: WorkspaceSession,
    operationLog: OperationLogUtilityClient,
    storage: { backupBaseDir: string; recoveryDir: string },
    options?: { knowledgeRefreshOwner?: KnowledgeRefreshOwner }
  ): RawReplaceCommitPort;
  toSaveResultFromOutcome(
    outcome: NativeMutationOutcome,
    files: readonly RendererResourceLabelSource[]
  ): RendererSaveResult;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: unknown
  ): Promise<unknown>;
  clearResourceRelatedCaches(): void;
}

function isHksBytecode(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x1b
    && bytes[1] === 0x4c
    && bytes[2] === 0x75
    && bytes[3] === 0x61
    && bytes[4] === 0x51;
}

type HksBridgeData = {
  contentBase64?: string;
  outputHash?: string;
  dialect?: string;
  package?: string;
  revision?: string;
};

async function compileHksSource(input: {
  file: IndexedFile;
  sourceUri: string;
  session: WorkspaceSession;
  sourceText: string;
  originalBytes: Uint8Array;
  expectedSourceHash: string;
  readRoots: string[];
}): Promise<{ ok: true; bytes: Buffer; data: HksBridgeData } | { ok: false; diagnostics: Diagnostic[] }> {
  const result = await runBridge<HksBridgeData>({
    command: 'compile-hks-source',
    filePath: input.file.absolutePath,
    resourceUri: input.sourceUri,
    allowedRoots: input.readRoots,
    workspaceSessionId: input.session.meta.workspaceId,
    commandOptions: {
      sourceText: input.sourceText,
      expectedSourceHash: input.expectedSourceHash,
      expectedDialect: 'sekiro-hks-1.6.x',
      // A container child is not the file passed as filePath. The Bridge uses
      // this bounded byte snapshot for the compile-time CAS check, so the
      // editor never silently compiles against a stale child.
      ...(isHksBytecode(input.originalBytes)
        ? { sourceContentBase64: Buffer.from(input.originalBytes).toString('base64') }
        : {})
    },
    timeoutMs: 120_000,
    maxFrameBytes: 32 * 1024 * 1024
  });
  if (result.parseStatus === 'failed' || !result.data?.contentBase64) {
    return {
      ok: false,
      diagnostics: result.diagnostics.length > 0
        ? result.diagnostics.map((item) => ({
            severity: item.severity,
            code: item.code,
            message: item.message,
            sourceUri: input.sourceUri
          }))
        : [{
            severity: 'error',
            code: 'HKS_COMPILER_OUTPUT_MISSING',
            message: 'SoulForge 内置 HKS 编译器未返回字节码。',
            sourceUri: input.sourceUri
          }]
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(result.data.contentBase64, 'base64');
  } catch (error) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'HKS_COMPILER_OUTPUT_INVALID',
        message: error instanceof Error ? error.message : 'HKS 编译器输出不是有效 base64。',
        sourceUri: input.sourceUri
      }]
    };
  }
  if (!isHksBytecode(bytes)) {
    return {
      ok: false,
      diagnostics: [{
        severity: 'error',
        code: 'HKS_COMPILER_OUTPUT_INVALID',
        message: 'SoulForge 内置 HKS 编译器返回的文件头不是 Sekiro 1.6.x dialect。',
        sourceUri: input.sourceUri
      }]
    };
  }
  return { ok: true, bytes, data: result.data };
}

/** Existing resource orchestration, callable without IPC registration or sender capability. */
export function createScriptSourceService(deps: ScriptSourceServiceDeps) {
  const saveScriptSource = async (
    requestWriteConfirmation: ResourceWriteConfirmation,
    sourceUri: string,
    entryName: string | undefined,
    expectedChildHash: string | undefined,
    expectedContainerHash: string | undefined,
    sourceText: string,
    encoding?: string,
    entryIndex?: number
  ): Promise<RendererSaveResult> => {
      const file = deps.getIndexedFiles().find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'RESOURCE_NOT_INDEXED',
              message: '请先索引资源，再保存脚本源码。',
              sourceUri
            }
          ]
        };
      }
      const activeSession = deps.getActiveSession();
      const owner = captureResourcePostCommitOwner(deps, activeSession, sourceUri);
      if (!activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'WORKSPACE_NOT_OPEN',
              message: '需要已打开的工作区才能保存脚本源码。',
              sourceUri
            }
          ]
        };
      }
      const writeEncoding =
        encoding === 'utf8-bom' || encoding === 'shift_jis' ? encoding : 'utf8';
      void writeEncoding;
      const operationLog = await deps.ensureActiveOperationLog(activeSession);
      const storage = deps.durableStoragePaths(activeSession.meta.workspaceId);
      if (entryName) {
        const gameBlocked = deps.rejectNonSekiroNativeWrite(sourceUri, file);
        if (gameBlocked) return gameBlocked;
        const childUri = `${sourceUri}#bnd/child/${encodeURIComponent(entryName)}`;

        // Real Sekiro luabnd files are native BND4/DCX documents. The old
        // generic container helper intentionally only understands SFBN test
        // binders, so using it here would make a real script look writable and
        // then fail (or, worse, write the source text as raw bytes). Use the
        // Bridge's entry-indexed native read/write path whenever the read view
        // supplied the identity proof.
        if (entryIndex !== undefined) {
          const readRoots = await deps.verifiedReadRoots(activeSession, dirname(file.absolutePath));
          if (readRoots.diagnostics.length > 0) {
            return { ok: false, changedFiles: [], diagnostics: readRoots.diagnostics };
          }
          const nativeRead = await runBridge<{
            containerHash?: string;
            contentHash?: string;
            contentBase64?: string;
            sanitizedName?: string;
            isBytecode?: boolean;
          }>({
            command: 'read-luabnd-script',
            filePath: file.absolutePath,
            resourceUri: sourceUri,
            allowedRoots: readRoots.allowedRoots,
            workspaceSessionId: activeSession.meta.workspaceId,
            commandOptions: {
              entryIndex,
              ...(expectedContainerHash ? { expectedContainerHash } : {}),
              ...(expectedChildHash ? { expectedChildHash } : {})
            },
            ...(activeSession.layers.baseRoot
              ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
              : {}),
            timeoutMs: 120_000,
            maxFrameBytes: 32 * 1024 * 1024
          });
          const nativeData = nativeRead.data;
          if (nativeRead.parseStatus === 'failed'
            || !nativeData?.contentBase64
            || nativeData.contentHash === undefined
            || nativeData.containerHash === undefined) {
            return {
              ok: false,
              changedFiles: [],
              diagnostics: nativeRead.diagnostics.length > 0
                ? nativeRead.diagnostics.map((item) => ({
                    severity: item.severity,
                    code: item.code,
                    message: item.message,
                    sourceUri
                  }))
                : [{
                    severity: 'error',
                    code: 'LUABND_SCRIPT_READ_FAILED',
                    message: 'Bridge 未返回带完整身份哈希的 luabnd 条目。',
                    sourceUri
                  }]
            };
          }
          const originalChild = Buffer.from(nativeData.contentBase64, 'base64');
          if (originalChild.length === 0) {
            return {
              ok: false,
              changedFiles: [],
              diagnostics: [{
                severity: 'error',
                code: 'LUABND_CHILD_BYTES_EMPTY',
                message: 'Bridge 返回的 luabnd 条目字节为空。',
                sourceUri
              }]
            };
          }
          const actualContainerHash = nativeData.containerHash;
          const actualChildHash = nativeData.contentHash;
          const compiled = isHksBytecode(originalChild)
            ? await compileHksSource({
                file,
                sourceUri,
                session: activeSession,
                sourceText,
                originalBytes: originalChild,
                expectedSourceHash: actualChildHash,
                readRoots: readRoots.allowedRoots
              })
            : (() => {
                const encoded = encodeScriptSourceForWriteback(originalChild, sourceText);
                return encoded.ok
                  ? { ok: true as const, bytes: Buffer.from(encoded.bytes), data: {} }
                  : {
                      ok: false as const,
                      diagnostics: encoded.diagnostics.map((item) => ({
                        severity: item.severity,
                        code: item.code,
                        message: item.message,
                        sourceUri
                      }))
                    };
              })();
          if (!compiled.ok) return { ok: false, changedFiles: [], diagnostics: compiled.diagnostics };

          const stage = await deps.verifiedStageRoots(activeSession, storage, 'LUABND_STAGING_PREPARE_FAILED');
          if (stage.diagnostics.length > 0) {
            return { ok: false, changedFiles: [], diagnostics: stage.diagnostics };
          }
          const commitPort = deps.sessionCommitPort(activeSession, operationLog, storage, { knowledgeRefreshOwner: 'caller' });
          const confirmingCommit: RawReplaceCommitPort = {
            commit: async (input) => input.confirmation
              ? commitPort.commit(input)
              : confirmationRequiredResult(sourceUri)
          };
          const outcome = await applyNativeMutation(
            {
              file,
              sourceUri,
              expectedHash: actualContainerHash,
              stagingRoot: storage.stagingRoot,
              allowedRoots: () => [...stage.allowedRoots],
              stagingPrefix: 'luabnd',
              stagingFileName: `${entryIndex}.mut.dcx`,
              stageWrite: async (context) => {
                const nativeWrite = await runBridge<{ outputHash?: string }>({
                  command: 'write-luabnd-script',
                  filePath: file.absolutePath,
                  resourceUri: sourceUri,
                  allowedRoots: context.allowedRoots,
                  writableRoots: context.writableRoots,
                  workspaceSessionId: activeSession.meta.workspaceId,
                  ...(activeSession.layers.baseRoot
                    ? { oodleRuntimeRoot: activeSession.layers.baseRoot }
                    : {}),
                  commandOptions: {
                    outputPath: context.outputPath,
                    entryIndex,
                    expectedContainerHash: actualContainerHash,
                    expectedChildHash: actualChildHash,
                    contentBase64: compiled.bytes.toString('base64')
                  },
                  timeoutMs: 120_000,
                  maxFrameBytes: 32 * 1024 * 1024
                });
                return {
                  ok: nativeWrite.parseStatus !== 'failed' && nativeWrite.data !== null,
                  diagnostics: nativeWrite.diagnostics
                };
              },
              title: `保存 HKS 脚本源码 ${nativeData.sanitizedName ?? entryName}`,
              confirmActionLabel: '保存 HKS 脚本源码'
            },
            {
              confirm: {
                requestConfirmation: (input) => requestWriteConfirmation({
                  resourceLabel: `${file.relativePath} / ${nativeData.sanitizedName ?? entryName}`,
                  sourceUri,
                  actionLabel: input.actionLabel,
                  payloadHash: input.payloadHash,
                  ...(input.extraSubjects ? { extraSubjects: input.extraSubjects } : {})
                })
              },
              commit: confirmingCommit
            }
          );
          if (outcome.status === 'committed' && outcome.result.ok) {
            await runCallerOwnedPostCommit(outcome.result, {
              prepare: () => { if (owner.canProject(outcome.result)) deps.clearResourceRelatedCaches(); },
              refresh: async result => { if (owner.canProject(result)) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result); },
              onPrepareError: (result, error) => appendPostCommitFailureDiagnostic(
                result,
                'POSTCOMMIT_PREVIEW_FAILED',
                sourceUri,
                error,
                '写入已提交，但脚本资源缓存失效失败；已保留已提交结果。'
              ),
              onRefreshError: (result, error) => appendPostCommitFailureDiagnostic(
                result,
                'POSTCOMMIT_REFRESH_FAILED',
                sourceUri,
                error
              )
            });
          }
          return deps.toSaveResultFromOutcome(outcome, owner.receiptFiles);
        }

        const read = await readContainerChild(file.absolutePath, childUri, {
          relativePath: file.relativePath
        });
        if (!read.ok || !read.bytes) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics:
              read.diagnostics.length > 0
                ? read.diagnostics
                : [
                    {
                      severity: 'error',
                      code: 'SCRIPT_SOURCE_READ_FAILED',
                      message: '写回前无法重读原条目字节。',
                      sourceUri
                    }
                  ]
          };
        }
        let containerHash = expectedContainerHash;
        let childHash = expectedChildHash || read.hash || '';
        if (!containerHash) {
          const tree = await inspectContainerTree(file.absolutePath, {
            relativePath: file.relativePath
          });
          containerHash = tree.ok && tree.tree?.rootHash ? tree.tree.rootHash : '';
        }
        if (isHksBytecode(read.bytes)) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: [{
              severity: 'error',
              code: 'HKS_ENTRY_INDEX_REQUIRED',
              message: 'HKS 容器条目必须带 native entryIndex，才能通过内置编译器写回。请重新读取条目后重试。',
              sourceUri
            }]
          };
        }
        const encoded = encodeScriptSourceForWriteback(read.bytes, sourceText);
        if (!encoded.ok) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: encoded.diagnostics.map((item) => ({
              severity: item.severity,
              code: item.code,
              message: item.message,
              sourceUri
            }))
          };
        }
        const confirmation = await requestWriteConfirmation({
          resourceLabel: `${file.relativePath} / ${entryName}`,
          sourceUri,
          actionLabel: '保存脚本源码',
          payloadHash: createHash('sha256')
            .update(`${containerHash}\n${childHash}\n`)
            .update(encoded.bytes)
            .digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        const result = await replaceContainerChild({
          file,
          childUri,
          expectedContainerHash: containerHash,
          expectedChildHash: childHash,
          newContentBase64: Buffer.from(encoded.bytes).toString('base64'),
          confirmation,
          session: activeSession,
          operationLog,
          ...storage
        });
        if (result.ok) {
          await runCallerOwnedPostCommit(result, {
            prepare: () => { if (owner.canProject(result)) deps.clearResourceRelatedCaches(); },
            refresh: async carrier => { if (owner.canProject(carrier)) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], carrier); },
            onPrepareError: (carrier, error) => appendPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_PREVIEW_FAILED', sourceUri, error),
            onRefreshError: (carrier, error) => appendPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_REFRESH_FAILED', sourceUri, error)
          });
        }
        return toRendererSaveResult(result, owner.receiptFiles);
      }
      let originalBytes: Uint8Array;
      try {
        originalBytes = new Uint8Array(await readFile(file.absolutePath));
      } catch (error) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [
            {
              severity: 'error',
              code: 'SCRIPT_SOURCE_READ_FAILED',
              message: error instanceof Error ? error.message : '写回前无法读取独立脚本文件。',
              sourceUri
            }
          ]
        };
      }
      const originalHash = createHash('sha256').update(originalBytes).digest('hex');
      let replacementBytes: Buffer;
      if (isHksBytecode(originalBytes)) {
        const readRoots = await deps.verifiedReadRoots(activeSession, dirname(file.absolutePath));
        if (readRoots.diagnostics.length > 0) {
          return { ok: false, changedFiles: [], diagnostics: readRoots.diagnostics };
        }
        const compiled = await compileHksSource({
          file,
          sourceUri,
          session: activeSession,
          sourceText,
          originalBytes,
          expectedSourceHash: originalHash,
          readRoots: readRoots.allowedRoots
        });
        if (!compiled.ok) return { ok: false, changedFiles: [], diagnostics: compiled.diagnostics };
        replacementBytes = compiled.bytes;
      } else {
        const encoded = encodeScriptSourceForWriteback(originalBytes, sourceText);
        if (!encoded.ok) {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: encoded.diagnostics.map((item) => ({
              severity: item.severity,
              code: item.code,
              message: item.message,
              sourceUri
            }))
          };
        }
        replacementBytes = Buffer.from(encoded.bytes);
      }
      const confirmation = await requestWriteConfirmation({
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '保存脚本源码',
        payloadHash: createHash('sha256').update(replacementBytes).digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      const result = await saveRawReplace({
        file,
        expectedHash: originalHash,
        newContentBase64: replacementBytes.toString('base64'),
        confirmation,
        session: activeSession,
        operationLog,
        ...storage,
        title: `保存脚本源码 ${file.relativePath}`
      });
      if (result.ok) {
        await runCallerOwnedPostCommit(result, {
          prepare: async () => {
            if (!owner.canProject(result)) return;
            const refreshed = await openResourcePreview({
              file,
              inspectNative: true,
              parseStructured: true,
              ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
            });
            if (owner.canProject(result)) deps.replaceIndexedFile(sourceUri, refreshed.file);
          },
          refresh: async carrier => { if (owner.canProject(carrier)) await deps.refreshActiveIndexAfterNativeWrite([sourceUri], carrier); },
          onPrepareError: (carrier, error) => appendPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_PREVIEW_FAILED', sourceUri, error),
          onRefreshError: (carrier, error) => appendPostCommitFailureDiagnostic(carrier, 'POSTCOMMIT_REFRESH_FAILED', sourceUri, error)
        });
      }
      return toRendererSaveResult(result, owner.receiptFiles);
    };

  return Object.freeze({ saveScriptSource });
}
export type ScriptSourceService = ReturnType<typeof createScriptSourceService>;
