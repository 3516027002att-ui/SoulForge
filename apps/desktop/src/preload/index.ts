import { contextBridge, ipcRenderer } from 'electron';
import type { IndexedFile, ResourcePreview, SaveTextResourceResult, WorkspaceScanResult } from '@soulforge/shared';
import type { AnalyzeWorkspaceSummary } from '../main/ipc.js';
import type { AiSidebarDraft, AiSidebarDraftRequest, ToolContext, ToolDescriptor, ToolResult } from '@soulforge/core';

const api = {
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke('workspace.openDialog'),
  scanWorkspace: (workspaceRoot: string): Promise<WorkspaceScanResult> => ipcRenderer.invoke('workspace.scan', workspaceRoot),
  analyzeWorkspace: (workspaceRoot: string): Promise<AnalyzeWorkspaceSummary> => ipcRenderer.invoke('workspace.analyze', workspaceRoot),
  searchResources: (query: string): Promise<IndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<ResourcePreview | null> => ipcRenderer.invoke('resource.preview', sourceUri),
  saveTextResource: (sourceUri: string, newText: string): Promise<SaveTextResourceResult> => ipcRenderer.invoke('resource.saveText', sourceUri, newText),
  listAiTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke('ai.tools'),
  buildAiSidebarDraft: (request: AiSidebarDraftRequest): Promise<AiSidebarDraft> => ipcRenderer.invoke('ai.sidebarDraft', request),
  runAiTool: (name: string, input: unknown, mode: ToolContext['mode'] = 'plan'): Promise<ToolResult> =>
    ipcRenderer.invoke('ai.runTool', name, input, mode)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
