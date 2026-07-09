import { app, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import {
  analyzeWorkspace,
  buildAiSidebarDraft,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  openFileOperationLogStore,
  openResourcePreview,
  openWorkspaceSession,
  inspectContainerTree,
  listContainerChildren,
  probeContainerCapabilityOptions,
  readContainerChild,
  readRawResourceMetadata,
  readRawResourceRange,
  replaceContainerChild,
  resolveOperationLogStorePath,
  resolveResourceCapabilities,
  rollbackOperation,
  roundTripContainer,
  saveRawByteRange,
  saveRawReplace,
  saveTextResource,
  scanWorkspace,
  validateContainer,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type FileOperationLogStore,
  type ResourceCapabilityMatrix,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex,
  type WorkspaceSession
} from '@soulforge/core';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  PatchHistoryEntry,
  ResourcePreview,
  SaveTextResourceResult,
  WorkspaceSessionMeta
} from '@soulforge/shared';

let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
let activeSession: WorkspaceSession | null = null;
let activeOperationLog: FileOperationLogStore | null = null;
let handlersRegistered = false;

const toolRegistry = createDefaultToolRegistry();

export interface AnalyzeWorkspaceSummary {
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
  diagnostics: Diagnostic[];
  events: Array<{ uri: string; eventId: number; name?: string }>;
  tools: ToolDescriptor[];
}

export interface WorkspaceScanWithSession {
  workspaceRoot: string;
  files: IndexedFile[];
  countsByKind: Record<string, number>;
  diagnostics: Diagnostic[];
  session: WorkspaceSessionMeta;
}

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
}

export interface OpenWorkspaceScanOptions {
  workspaceRoot: string;
  baseRoot?: string;
}

function operationLogPathForWorkspace(workspaceId: string): string {
  // workspaceId is a file:// URL from makeWorkspaceId; never join it raw into a Windows path.
  return resolveOperationLogStorePath(join(app.getPath('userData'), 'operation-logs'), workspaceId);
}

function ensureActiveOperationLog(workspaceId: string): FileOperationLogStore {
  const storePath = operationLogPathForWorkspace(workspaceId);
  if (activeOperationLog?.storePath === storePath) {
    return activeOperationLog;
  }
  activeOperationLog = openFileOperationLogStore(storePath);
  return activeOperationLog;
}

export function registerIpcHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle('workspace.openDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Mod Workspace (overlay)',
      properties: ['openDirectory']
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('workspace.openBaseDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Base Game Directory (read-only, optional)',
      properties: ['openDirectory']
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    'workspace.scan',
    async (
      _event,
      workspaceRootOrOptions: string | OpenWorkspaceScanOptions,
      maybeBaseRoot?: string
    ) => {
      const workspaceRoot = typeof workspaceRootOrOptions === 'string'
        ? workspaceRootOrOptions
        : workspaceRootOrOptions.workspaceRoot;
      const baseRoot = typeof workspaceRootOrOptions === 'string'
        ? maybeBaseRoot
        : workspaceRootOrOptions.baseRoot;

      activeSession = await openWorkspaceSession({
        overlayRoot: workspaceRoot,
        ...(baseRoot ? { baseRoot } : {})
      });
      ensureActiveOperationLog(activeSession.meta.workspaceId);

      const result = await scanWorkspace({ workspaceRoot });
      indexedFiles = result.files;
      activeIndex = null;
      return {
        ...result,
        session: activeSession.meta as WorkspaceSessionMeta
      };
    }
  );

  ipcMain.handle('workspace.analyze', async (_event, workspaceRoot: string): Promise<AnalyzeWorkspaceSummary> => {
    const result = await analyzeWorkspace({ workspaceRoot });
    activeIndex = result.index;

    return {
      parsedFiles: result.parsedFiles,
      inspectedFiles: result.inspectedFiles,
      referenceStats: result.referenceStats,
      diagnostics: result.diagnostics,
      events: result.index.searchEvents('', 200).map(({ item }) => ({
        uri: item.uri,
        eventId: item.eventId,
        ...(item.name ? { name: item.name } : {})
      })),
      tools: toolRegistry.list()
    };
  });

  ipcMain.handle('resource.preview', async (_event, sourceUri: string): Promise<ResourcePreview | null> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return openResourcePreview({ file, inspectNative: true, parseStructured: true });
  });

  ipcMain.handle('resource.saveText', async (_event, sourceUri: string, newText: string): Promise<SaveTextResourceResult> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
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
    }

    const operationLog = activeSession
      ? ensureActiveOperationLog(activeSession.meta.workspaceId)
      : undefined;

    const result = await saveTextResource({
      file,
      newText,
      ...(activeSession ? { session: activeSession } : {}),
      ...(operationLog ? { operationLog } : {})
    });
    if (result.ok) {
      const refreshed = await openResourcePreview({ file, inspectNative: true, parseStructured: true });
      const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) indexedFiles[index] = refreshed.file;
    }
    return result;
  });

  ipcMain.handle('resource.search', async (_event, query: string) => {
    const normalized = query.trim().toLowerCase();
    const items = normalized.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          return file.relativePath.toLowerCase().includes(normalized) || file.resourceKind.includes(normalized);
        });

    return items;
  });

  ipcMain.handle('resource.capabilities', async (_event, sourceUri: string): Promise<ResourceCapabilityMatrix | null> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return resolveResourceCapabilities(file);
  });

  ipcMain.handle(
    'resource.readRawRange',
    async (_event, sourceUri: string, offset: number, length: number) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          sourceUri,
          offset,
          length,
          fileSize: 0,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw range read.',
            sourceUri
          }]
        };
      }
      return readRawResourceRange(file, offset, length);
    }
  );

  ipcMain.handle(
    'resource.saveRawReplace',
    async (
      _event,
      sourceUri: string,
      expectedHash: string,
      newContentBase64: string,
      confirmation?: ConfirmationReceipt
    ): Promise<SaveTextResourceResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw replace.',
            sourceUri
          }]
        };
      }
      const operationLog = activeSession
        ? ensureActiveOperationLog(activeSession.meta.workspaceId)
        : undefined;
      return saveRawReplace({
        file,
        expectedHash,
        newContentBase64,
        ...(confirmation ? { confirmation } : {}),
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {})
      });
    }
  );

  ipcMain.handle(
    'resource.saveRawByteRange',
    async (
      _event,
      sourceUri: string,
      expectedHash: string,
      offset: number,
      length: number,
      replacementBase64: string,
      confirmation?: ConfirmationReceipt
    ): Promise<SaveTextResourceResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw byte-range patch.',
            sourceUri
          }]
        };
      }
      const operationLog = activeSession
        ? ensureActiveOperationLog(activeSession.meta.workspaceId)
        : undefined;
      return saveRawByteRange({
        file,
        expectedHash,
        offset,
        length,
        replacementBase64,
        ...(confirmation ? { confirmation } : {}),
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {})
      });
    }
  );

  /** Helper for renderer/dev tools: build a confirmation receipt without exposing secrets. */
  ipcMain.handle(
    'resource.createConfirmation',
    async (
      _event,
      subjects: string[],
      riskLevel: 'safe' | 'caution' | 'high' | 'blocked',
      sourceUri?: string
    ): Promise<ConfirmationReceipt> => {
      return createConfirmationReceipt({
        subjects,
        riskLevel,
        ...(sourceUri ? { sourceUri } : {}),
        note: 'IPC confirmation receipt for high-risk raw write'
      });
    }
  );

  ipcMain.handle('resource.readRawMetadata', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
  });

  ipcMain.handle('resource.inspectContainerTree', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container inspect.',
          sourceUri
        }]
      };
    }
    return inspectContainerTree(file.absolutePath, { relativePath: file.relativePath });
  });

  ipcMain.handle(
    'resource.listContainerChildren',
    async (_event, sourceUri: string, recursive?: boolean) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          children: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before listing container children.',
            sourceUri
          }]
        };
      }
      return listContainerChildren(file.absolutePath, {
        relativePath: file.relativePath,
        recursive: recursive === true
      });
    }
  );

  ipcMain.handle(
    'resource.readContainerChild',
    async (_event, childUri: string) => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          childUri,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before reading a child.',
            sourceUri: containerUri
          }]
        };
      }
      return readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
    }
  );

  ipcMain.handle(
    'resource.replaceContainerChild',
    async (
      _event,
      childUri: string,
      expectedContainerHash: string,
      expectedChildHash: string,
      newContentBase64: string,
      confirmation?: ConfirmationReceipt
    ): Promise<SaveTextResourceResult> => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before child replace.',
            sourceUri: containerUri
          }]
        };
      }
      const operationLog = activeSession
        ? ensureActiveOperationLog(activeSession.meta.workspaceId)
        : undefined;
      return replaceContainerChild({
        file,
        childUri,
        expectedContainerHash,
        expectedChildHash,
        newContentBase64,
        ...(confirmation ? { confirmation } : {}),
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {})
      });
    }
  );

  ipcMain.handle('resource.roundTripContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        byteIdentical: false,
        payloadEquivalent: false,
        originalHash: '',
        rebuiltHash: '',
        childHashMatches: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container roundtrip.',
          sourceUri
        }]
      };
    }
    return roundTripContainer(file.absolutePath);
  });

  ipcMain.handle('resource.validateContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        format: 'unknown' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container validate.',
          sourceUri
        }]
      };
    }
    return validateContainer(file.absolutePath);
  });

  ipcMain.handle('resource.probeContainerCapabilities', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const probed = await probeContainerCapabilityOptions(file.absolutePath);
    return resolveResourceCapabilities(file, probed);
  });

  ipcMain.handle('operation.list', async (): Promise<PatchHistoryEntry[]> => {
    if (!activeSession || !activeOperationLog) return [];
    return activeOperationLog.history(activeSession.meta.workspaceId);
  });

  ipcMain.handle('operation.rollback', async (_event, opId: string): Promise<RollbackOperationIpcResult> => {
    if (!activeSession || !activeOperationLog) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'WORKSPACE_NOT_OPEN',
          message: 'Open a workspace before rolling back an operation.'
        }]
      };
    }

    const result = await rollbackOperation({
      opId,
      store: activeOperationLog,
      session: activeSession
    });

    return {
      ok: result.ok,
      opId: result.opId,
      restoredFiles: result.restoredFiles,
      diagnostics: result.diagnostics
    };
  });

  ipcMain.handle('ai.tools', async () => toolRegistry.list());

  ipcMain.handle('ai.sidebarDraft', async (_event, request: AiSidebarDraftRequest): Promise<AiSidebarDraft> => {
    return buildAiSidebarDraft({
      ...request,
      availableTools: request.availableTools.length > 0 ? request.availableTools : toolRegistry.list()
    });
  });

  ipcMain.handle(
    'ai.runTool',
    async (_event, name: string, input: unknown, mode: ToolContext['mode'] = 'plan'): Promise<ToolResult> => {
      if (!activeIndex) {
        return {
          ok: false,
          error: {
            code: 'WORKSPACE_NOT_ANALYZED',
            message: 'Analyze a workspace before running AI-safe tools.'
          }
        };
      }

      return toolRegistry.run(name, input, { workspaceIndex: activeIndex, mode });
    }
  );
}
