import { contextBridge, ipcRenderer } from 'electron';
import type { IndexedFile, ResourcePreview, WorkspaceScanResult } from '@soulforge/shared';

const api = {
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke('workspace.openDialog'),
  scanWorkspace: (workspaceRoot: string): Promise<WorkspaceScanResult> => ipcRenderer.invoke('workspace.scan', workspaceRoot),
  searchResources: (query: string): Promise<IndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<ResourcePreview | null> => ipcRenderer.invoke('resource.preview', sourceUri)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
