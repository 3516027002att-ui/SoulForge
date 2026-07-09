import { contextBridge, ipcRenderer } from 'electron';
import type {
  IndexedFile,
  PatchHistoryEntry,
  ResourcePreview,
  SaveTextResourceResult,
  WorkspaceScanResult
} from '@soulforge/shared';
import type {
  AnalyzeWorkspaceSummary,
  OpenWorkspaceScanOptions,
  RollbackOperationIpcResult
} from '../main/ipc.js';
import type { AiSidebarDraft, AiSidebarDraftRequest, ToolContext, ToolDescriptor, ToolResult } from '@soulforge/core';

const api = {
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke('workspace.openDialog'),
  openBaseDialog: (): Promise<string | null> => ipcRenderer.invoke('workspace.openBaseDialog'),
  scanWorkspace: (
    workspaceRootOrOptions: string | OpenWorkspaceScanOptions,
    baseRoot?: string
  ): Promise<WorkspaceScanResult & { session?: import('@soulforge/shared').WorkspaceSessionMeta }> => {
    if (typeof workspaceRootOrOptions === 'string') {
      return ipcRenderer.invoke('workspace.scan', workspaceRootOrOptions, baseRoot);
    }
    return ipcRenderer.invoke('workspace.scan', workspaceRootOrOptions);
  },
  analyzeWorkspace: (workspaceRoot: string): Promise<AnalyzeWorkspaceSummary> =>
    ipcRenderer.invoke('workspace.analyze', workspaceRoot),
  searchResources: (query: string): Promise<IndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<ResourcePreview | null> =>
    ipcRenderer.invoke('resource.preview', sourceUri),
  saveTextResource: (sourceUri: string, newText: string): Promise<SaveTextResourceResult> =>
    ipcRenderer.invoke('resource.saveText', sourceUri, newText),
  listOperations: (): Promise<PatchHistoryEntry[]> => ipcRenderer.invoke('operation.list'),
  rollbackOperation: (opId: string): Promise<RollbackOperationIpcResult> =>
    ipcRenderer.invoke('operation.rollback', opId),
  listAiTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke('ai.tools'),
  buildAiSidebarDraft: (request: AiSidebarDraftRequest): Promise<AiSidebarDraft> =>
    ipcRenderer.invoke('ai.sidebarDraft', request),
  runAiTool: (name: string, input: unknown, mode: ToolContext['mode'] = 'plan'): Promise<ToolResult> =>
    ipcRenderer.invoke('ai.runTool', name, input, mode)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
