import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import {
  applyNativeMutation,
  encodeScriptSourceForWriteback,
  inspectContainerTree,
  openResourcePreview,
  readContainerChild,
  replaceContainerChild,
  runBridge,
  saveRawReplace,
  saveTextResource,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WorkspaceIndex,
  type WorkspaceSession
} from '@soulforge/core';
import type { Diagnostic, IndexedFile, SaveTextResourceResult } from '@soulforge/shared';
import {
  sanitizeRendererValue,
  toRendererIndexedFile,
  toRendererResourcePreview,
  toRendererSaveResult,
  type RendererSaveResult
} from '../rendererDto.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';
import type { ConfirmationReceipt } from '@soulforge/shared';

export interface ResourceIpcDeps {
  handle: TrustedIpcHandle;
  getIndexedFiles(): readonly IndexedFile[];
  replaceIndexedFile(sourceUri: string, file: IndexedFile): boolean;
  getActiveIndex(): WorkspaceIndex | null;
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
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
    storage: { backupBaseDir: string; recoveryDir: string }
  ): RawReplaceCommitPort;
  toSaveResultFromOutcome(
    outcome: NativeMutationOutcome,
    files: readonly IndexedFile[]
  ): RendererSaveResult;
  rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null;
  requestWriteConfirmation(input: {
    event?: IpcMainInvokeEvent;
    resourceLabel: string;
    sourceUri: string;
    actionLabel: string;
    payloadHash: string;
    extraSubjects?: string[];
  }): Promise<ConfirmationReceipt | null>;
  refreshActiveIndexAfterNativeWrite(
    changedSources?: readonly string[],
    carrier?: unknown
  ): Promise<unknown>;
  withForegroundPriority<T>(fn: () => Promise<T>): Promise<T>;
  bumpPathSourceGenerationForUris(uris: readonly string[]): void;
  clearResourceRelatedCaches(): void;
  getActiveSessionLayers?(): { overlayRoot?: string; baseRoot?: string | null };
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

function confirmationRequiredResult(sourceUri: string): SaveTextResourceResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [{
      severity: 'warning',
      code: 'EDIT_CONFIRMATION_REQUIRED',
      message: '该脚本写回需要显式确认。',
      sourceUri
    }]
  };
}

function cancelledWrite(sourceUri: string): RendererSaveResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [
      {
        severity: 'warning',
        code: 'WRITE_CONFIRMATION_CANCELLED',
        message: '用户取消了高风险写入。',
        sourceUri
      }
    ]
  };
}

export function registerResourceIpcHandlers(deps: ResourceIpcDeps): void {
  const handle = deps.handle;

  // resource.replaceContainerChild — generic container lifecycle (composition root A5.1)
  handle(
    'resource.replaceContainerChild',
    async (
      event,
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
      const confirmation = await deps.requestWriteConfirmation({
        event,
        resourceLabel: `${file.relativePath} / ${childUri.slice(childUri.indexOf('#') + 1)}`,
        sourceUri: containerUri,
        actionLabel: '替换容器子项',
        payloadHash: createHash('sha256')
          .update(`${expectedContainerHash}\n${expectedChildHash}\n${newContentBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(containerUri);
      const result = await replaceContainerChild({
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
        deps.clearResourceRelatedCaches();
        await deps.refreshActiveIndexAfterNativeWrite([containerUri], result);
      }
      return toRendererSaveResult(result, [...deps.getIndexedFiles()] as IndexedFile[]);
    }
  );

  handle(
    'resource.saveScriptSource',
    async (
      event,
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
          const commitPort = deps.sessionCommitPort(activeSession, operationLog, storage);
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
                requestConfirmation: (input) => deps.requestWriteConfirmation({
                  event,
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
          const result = deps.toSaveResultFromOutcome(outcome, [...deps.getIndexedFiles()]);
          if (result.ok) {
            deps.clearResourceRelatedCaches();
            await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
          }
          return result;
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
        const confirmation = await deps.requestWriteConfirmation({
          event,
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
          deps.clearResourceRelatedCaches();
          await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
        }
        return toRendererSaveResult(result, [...deps.getIndexedFiles()] as IndexedFile[]);
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
      const confirmation = await deps.requestWriteConfirmation({
        event,
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
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
        });
        deps.replaceIndexedFile(sourceUri, refreshed.file);
        await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
      }
      return toRendererSaveResult(result, [...deps.getIndexedFiles()] as IndexedFile[]);
    }
  );

  // Generic preview dispatch — isolated here to avoid domain↔domain import in core domains.
  handle(
    'resource.preview',
    async (_event, sourceUri: string) => {
      return deps.withForegroundPriority(async () => {
        const indexedFiles = deps.getIndexedFiles();
        const activeSession = deps.getActiveSession();
        const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
        if (
          file &&
          (file.resourceKind === 'param' ||
            file.resourceKind === 'map' ||
            file.resourceKind === 'action')
        ) {
          return sanitizeRendererValue({
            sourceUri: file.sourceUri,
            relativePath: file.relativePath,
            kind: file.resourceKind,
            diagnostics: [],
            structured: null
          });
        }
        if (!file) return null;
        return toRendererResourcePreview(
          await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          })
        );
      });
    }
  );

  // Generic text save (non-FMG) — not owned by FMG text domain.
  handle(
    'resource.saveText',
    async (_event, sourceUri: string, newText: string): Promise<RendererSaveResult> => {
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
        const confirmation = await deps.requestWriteConfirmation({
          event: _event,
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
        deps.bumpPathSourceGenerationForUris([sourceUri]);
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
        });
        deps.replaceIndexedFile(sourceUri, refreshed.file);
        await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
      }
      return toRendererSaveResult(result, [...deps.getIndexedFiles()] as IndexedFile[]);
    }
  );

  // Workspace index search — generic resource listing, lives here rather than workspace domain.
  handle('resource.search', async (_event, query: string) => {
    const indexedFiles = deps.getIndexedFiles();
    const activeIndex = deps.getActiveIndex();
    if (activeIndex) {
      const items = activeIndex
        .searchResources({ query, limit: Math.max(100, indexedFiles.length) })
        .map(({ item }) => item);
      return items.map(toRendererIndexedFile);
    }

    // No active workspace means there is no resource catalog to search. Keep
    // the fallback tolerant of slashes, dots and underscores so an old/early
    // scan cannot turn a valid path query into a false empty result.
    const terms = query
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const items = terms.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          const text = [
            file.relativePath,
            file.resourceKind,
            file.extension,
            file.compoundExtension,
            file.formatKind,
            file.formatLabel
          ].join(' ').toLowerCase().replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, ' ');
          return terms.every((term) => text.includes(term));
        });
    return items.map(toRendererIndexedFile);
  });
}
