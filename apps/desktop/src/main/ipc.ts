import { app, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import {
  analyzeWorkspace,
  buildAiSidebarDraft,
  createDefaultToolRegistry,
  openFileOperationLogStore,
  openResourcePreview,
  openWorkspaceSession,
  resolveOperationLogStorePath,
  rollbackOperation,
  saveTextResource,
  scanWorkspace,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type FileOperationLogStore,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex,
  type WorkspaceSession
} from '@soulforge/core';
import type {
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
