import { dialog, ipcMain } from 'electron';
import { openResourcePreview, scanWorkspace } from '@soulforge/core';
import type { IndexedFile, ResourcePreview } from '@soulforge/shared';

let indexedFiles: IndexedFile[] = [];

export function registerIpcHandlers(): void {
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
    return result;
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
}
