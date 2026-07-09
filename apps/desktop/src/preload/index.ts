import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConfirmationReceipt,
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
import type {
  AiSidebarDraft,
  AiSidebarDraftRequest,
  ResourceCapabilityMatrix,
  ToolContext,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';

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
  /** Honest capability matrix for any indexed file. */
  getResourceCapabilities: (sourceUri: string): Promise<ResourceCapabilityMatrix | null> =>
    ipcRenderer.invoke('resource.capabilities', sourceUri),
  readRawMetadata: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readRawMetadata', sourceUri),
  readRawRange: (sourceUri: string, offset: number, length: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readRawRange', sourceUri, offset, length),
  saveRawReplace: (
    sourceUri: string,
    expectedHash: string,
    newContentBase64: string,
    confirmation?: ConfirmationReceipt
  ): Promise<SaveTextResourceResult> =>
    ipcRenderer.invoke('resource.saveRawReplace', sourceUri, expectedHash, newContentBase64, confirmation),
  saveRawByteRange: (
    sourceUri: string,
    expectedHash: string,
    offset: number,
    length: number,
    replacementBase64: string,
    confirmation?: ConfirmationReceipt
  ): Promise<SaveTextResourceResult> =>
    ipcRenderer.invoke(
      'resource.saveRawByteRange',
      sourceUri,
      expectedHash,
      offset,
      length,
      replacementBase64,
      confirmation
    ),
  createConfirmation: (
    subjects: string[],
    riskLevel: 'safe' | 'caution' | 'high' | 'blocked',
    sourceUri?: string
  ): Promise<ConfirmationReceipt> =>
    ipcRenderer.invoke('resource.createConfirmation', subjects, riskLevel, sourceUri),
  inspectContainerTree: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.inspectContainerTree', sourceUri),
  listContainerChildren: (sourceUri: string, recursive?: boolean): Promise<unknown> =>
    ipcRenderer.invoke('resource.listContainerChildren', sourceUri, recursive),
  readContainerChild: (childUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readContainerChild', childUri),
  replaceContainerChild: (
    childUri: string,
    expectedContainerHash: string,
    expectedChildHash: string,
    newContentBase64: string,
    confirmation?: ConfirmationReceipt
  ): Promise<SaveTextResourceResult> =>
    ipcRenderer.invoke(
      'resource.replaceContainerChild',
      childUri,
      expectedContainerHash,
      expectedChildHash,
      newContentBase64,
      confirmation
    ),
  roundTripContainer: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.roundTripContainer', sourceUri),
  validateContainer: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.validateContainer', sourceUri),
  probeContainerCapabilities: (sourceUri: string): Promise<ResourceCapabilityMatrix | null> =>
    ipcRenderer.invoke('resource.probeContainerCapabilities', sourceUri),
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
