import { contextBridge, ipcRenderer } from 'electron';
import type { IndexedFile, ResourcePreview, WorkspaceScanResult } from '@soulforge/shared';
import type { AnalyzeWorkspaceSummary } from '../main/ipc.js';
import type { ToolContext, ToolDescriptor, ToolResult } from '@soulforge/core';

const api = {
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke('workspace.openDialog'),
  scanWorkspace: (workspaceRoot: string): Promise<WorkspaceScanResult> => ipcRenderer.invoke('workspace.scan', workspaceRoot),
  analyzeWorkspace: (workspaceRoot: string): Promise<AnalyzeWorkspaceSummary> => ipcRenderer.invoke('workspace.analyze', workspaceRoot),
  searchResources: (query: string): Promise<IndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<ResourcePreview | null> => ipcRenderer.invoke('resource.preview', sourceUri),
  listAiTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke('ai.tools'),
  runAiTool: (name: string, input: unknown, mode: ToolContext['mode'] = 'plan'): Promise<ToolResult> =>
    ipcRenderer.invoke('ai.runTool', name, input, mode)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
