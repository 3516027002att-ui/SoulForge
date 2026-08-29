import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IpcMainInvokeEvent } from 'electron';
import {
  encodeScriptSourceForWriteback,
  inspectContainerTree,
  openResourcePreview,
  readContainerChild,
  replaceContainerChild,
  saveRawReplace,
  saveTextResource,
  type WorkspaceSession
} from '@soulforge/core';
import type { IndexedFile } from '@soulforge/shared';
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
  getActiveSession(): WorkspaceSession | null;
  getActiveWorkspaceSessionId(): string | null;
  durableStoragePaths(workspaceId: string): {
    root: string;
    backupBaseDir: string;
    recoveryDir: string;
    stagingRoot: string;
  };
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
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
      encoding?: string
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
              message: 'Resource must be indexed before script source save.',
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
      const confirmation = await deps.requestWriteConfirmation({
        event,
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '保存脚本源码',
        payloadHash: createHash('sha256').update(encoded.bytes).digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      const result = await saveRawReplace({
        file,
        expectedHash: createHash('sha256').update(originalBytes).digest('hex'),
        newContentBase64: Buffer.from(encoded.bytes).toString('base64'),
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
        const files = deps.getIndexedFiles() as unknown as IndexedFile[];
        const index = files.findIndex((item) => item.sourceUri === sourceUri);
        if (index >= 0) (files as IndexedFile[])[index] = refreshed.file;
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
              message: 'Resource must be indexed before it can be saved.',
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
        const files = deps.getIndexedFiles() as unknown as IndexedFile[];
        const idx2 = files.findIndex((item) => item.sourceUri === sourceUri);
        if (idx2 >= 0) (files as IndexedFile[])[idx2] = refreshed.file;
        await deps.refreshActiveIndexAfterNativeWrite([sourceUri], result);
      }
      return toRendererSaveResult(result, [...deps.getIndexedFiles()] as IndexedFile[]);
    }
  );

  // Workspace index search — generic resource listing, lives here rather than workspace domain.
  handle('resource.search', async (_event, query: string) => {
    const normalized = query.trim().toLowerCase();
    const indexedFiles = deps.getIndexedFiles();
    const items =
      normalized.length === 0
        ? indexedFiles
        : indexedFiles.filter(
            (file) =>
              file.relativePath.toLowerCase().includes(normalized) ||
              file.resourceKind.includes(normalized)
          );
    return items.map(toRendererIndexedFile);
  });
}
