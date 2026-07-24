import { contextBridge, ipcRenderer } from 'electron';
import type {
  AnalyzeWorkspaceSummary,
  DirectorySelection,
  OpenWorkspaceScanOptions,
  RendererWorkspaceScanResult,
  RollbackOperationIpcResult
} from '../main/ipc.js';
import type {
  RendererIndexedFile,
  RendererPatchHistoryEntry,
  RendererResourcePreview,
  RendererRuntimeActionResult,
  RendererSaveResult
} from '../main/rendererDto.js';
import type {
  AiSidebarDraft,
  AiSidebarDraftRequest,
  ResourceCapabilityMatrix,
  RuntimeOperatorVerdict,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';

const api = {
  openWorkspaceDialog: (): Promise<DirectorySelection | null> => ipcRenderer.invoke('workspace.openDialog'),
  openBaseDialog: (): Promise<DirectorySelection | null> => ipcRenderer.invoke('workspace.openBaseDialog'),
  scanWorkspace: (options: OpenWorkspaceScanOptions): Promise<RendererWorkspaceScanResult> =>
    ipcRenderer.invoke('workspace.scan', options),
  analyzeWorkspace: (): Promise<AnalyzeWorkspaceSummary> => ipcRenderer.invoke('workspace.analyze'),
  searchResources: (query: string): Promise<RendererIndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<RendererResourcePreview | null> =>
    ipcRenderer.invoke('resource.preview', sourceUri),
  saveTextResource: (sourceUri: string, newText: string): Promise<RendererSaveResult> =>
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
    newContentBase64: string
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.saveRawReplace', sourceUri, expectedHash, newContentBase64),
  saveRawByteRange: (
    sourceUri: string,
    expectedHash: string,
    offset: number,
    length: number,
    replacementBase64: string
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke(
      'resource.saveRawByteRange',
      sourceUri,
      expectedHash,
      offset,
      length,
      replacementBase64
    ),
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
    newContentBase64: string
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke(
      'resource.replaceContainerChild',
      childUri,
      expectedContainerHash,
      expectedChildHash,
      newContentBase64
    ),
  roundTripContainer: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.roundTripContainer', sourceUri),
  validateContainer: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.validateContainer', sourceUri),
  probeContainerCapabilities: (sourceUri: string): Promise<ResourceCapabilityMatrix | null> =>
    ipcRenderer.invoke('resource.probeContainerCapabilities', sourceUri),
  chooseMe3Executable: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.chooseMe3Executable'),
  clearMe3Executable: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.clearMe3Executable'),
  getRuntimeCapability: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.capability'),
  launchRuntime: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchManual'),
  launchRuntimeAfterCommit: (operationId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchAfterCommit', operationId),
  launchRuntimeAfterRollback: (
    inverseOperationId: string,
    originalOperationId: string
  ): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.launchAfterRollback', inverseOperationId, originalOperationId),
  listRuntimeSessions: (): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.listSessions'),
  getRuntimeSession: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getSession', sessionId),
  terminateRuntimeSession: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.terminate', sessionId),
  waitForRuntimeExit: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.waitForExit', sessionId),
  recordRuntimeVerification: (
    sessionId: string,
    verdict: RuntimeOperatorVerdict,
    note?: string
  ): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.recordOperatorVerification', sessionId, verdict, note),
  listRuntimeVerificationEvidence: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.listVerificationEvidence', sessionId),
  getRuntimeVerificationSummary: (sessionId: string): Promise<RendererRuntimeActionResult> =>
    ipcRenderer.invoke('runtime.getVerificationSummary', sessionId),
  listOperations: (): Promise<RendererPatchHistoryEntry[]> => ipcRenderer.invoke('operation.list'),
  rollbackOperation: (opId: string): Promise<RollbackOperationIpcResult> =>
    ipcRenderer.invoke('operation.rollback', opId),
  readEmevdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readEmevdDocument', sourceUri),
  applyEmevdMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: Record<string, unknown>
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyEmevdMutation', sourceUri, expectedHash, mutation),
  readFmgDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFmgDocument', sourceUri),
  applyFmgMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: { kind: 'upsert' | 'delete'; id: number; text?: string }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyFmgMutation', sourceUri, expectedHash, mutation),
  readMsbDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMsbDocument', sourceUri),
  applyMsbMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: {
      kind: 'set_part_position' | 'set_part_transform' | 'set_region_position';
      partName: string;
      posX?: number;
      posY?: number;
      posZ?: number;
      rotX?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
    }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyMsbMutation', sourceUri, expectedHash, mutation),
  readParamDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readParamDocument', sourceUri),
  applyParamMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: { kind: 'upsert' | 'delete'; id: number; dataBase64?: string }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyParamMutation', sourceUri, expectedHash, mutation),
  listAiTools: (): Promise<ToolDescriptor[]> => ipcRenderer.invoke('ai.tools'),
  buildAiSidebarDraft: (request: AiSidebarDraftRequest): Promise<AiSidebarDraft> =>
    ipcRenderer.invoke('ai.sidebarDraft', request),
  runAiTool: (name: string, input: unknown): Promise<ToolResult> =>
    ipcRenderer.invoke('ai.runTool', name, input),
  /** Model service configs — hasCredential only; never plaintext secrets. */
  listModelServices: (): Promise<Array<{
    id: string;
    displayName: string;
    protocol: 'openai-compatible' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    hasCredential: boolean;
    createdAt: string;
    updatedAt: string;
  }>> => ipcRenderer.invoke('modelService.list'),
  modelServiceEncryptionAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('modelService.encryptionAvailable'),
  upsertModelService: (input: {
    id?: string;
    displayName: string;
    protocol: 'openai-compatible' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<{
    id: string;
    displayName: string;
    protocol: 'openai-compatible' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    hasCredential: boolean;
    createdAt: string;
    updatedAt: string;
  }> => ipcRenderer.invoke('modelService.upsert', input),
  deleteModelService: (configId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('modelService.delete', configId)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
