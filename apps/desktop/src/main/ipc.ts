import { dialog, ipcMain } from 'electron';
import {
  analyzeWorkspace,
  createDefaultToolRegistry,
  openResourcePreview,
  scanWorkspace,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex
} from '@soulforge/core';
import type { Diagnostic, IndexedFile, ResourcePreview } from '@soulforge/shared';

let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
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

export function registerIpcHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle('workspace.openDialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open Mod Workspace',
      properties: ['openDirectory']
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('workspace.scan', async (_event, workspaceRoot: string) => {
    const result = await scanWorkspace({ workspaceRoot });
    indexedFiles = result.files;
    activeIndex = null;
    return result;
  });

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
    return openResourcePreview({ file });
  });

  ipcMain.handle('resource.search', async (_event, query: string) => {
    const normalized = query.trim().toLowerCase();
    const items = normalized.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          return file.relativePath.toLowerCase().includes(normalized) || file.resourceKind.includes(normalized);
        });

    return items.slice(0, 200);
  });

  ipcMain.handle('ai.tools', async () => toolRegistry.list());

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
