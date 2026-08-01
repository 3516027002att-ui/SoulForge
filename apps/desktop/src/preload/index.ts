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
  RendererSaveResult
} from '../main/rendererDto.js';
import type {
  AiSidebarDraft,
  AiSidebarDraftRequest,
  ResourceCapabilityMatrix,
  ToolDescriptor,
  ToolResult
} from '@soulforge/core';

const api = {
  openWorkspaceDialog: (): Promise<DirectorySelection | null> => ipcRenderer.invoke('workspace.openDialog'),
  openBaseDialog: (): Promise<DirectorySelection | null> => ipcRenderer.invoke('workspace.openBaseDialog'),
  scanWorkspace: (options: OpenWorkspaceScanOptions): Promise<RendererWorkspaceScanResult> =>
    ipcRenderer.invoke('workspace.scan', options),
  detectMe3: (): Promise<import('@soulforge/core').RuntimeCapability> =>
    ipcRenderer.invoke('runtime.detectMe3'),
  prepareMe3Profile: (): Promise<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeProfileRef>> =>
    ipcRenderer.invoke('runtime.prepareMe3Profile'),
  launchMe3: (profileId: string): Promise<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeLaunchSession>> =>
    ipcRenderer.invoke('runtime.launchMe3', profileId),
  terminateMe3: (sessionId: string): Promise<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeTerminationResult>> =>
    ipcRenderer.invoke('runtime.terminateMe3', sessionId),
  analyzeWorkspace: (): Promise<AnalyzeWorkspaceSummary> => ipcRenderer.invoke('workspace.analyze'),
  searchResources: (query: string): Promise<RendererIndexedFile[]> => ipcRenderer.invoke('resource.search', query),
  openResourcePreview: (sourceUri: string): Promise<RendererResourcePreview | null> =>
    ipcRenderer.invoke('resource.preview', sourceUri),
  saveTextResource: (sourceUri: string, newText: string): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.saveText', sourceUri, newText),
  readRawMetadata: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readRawMetadata', sourceUri),
  readRawRange: (sourceUri: string, offset: number, length: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readRawRange', sourceUri, offset, length),
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
  scriptContainerEvidence: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.scriptContainerEvidence', sourceUri),
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
  readEmevdFullDocument: (
    sourceUri: string,
    documentInstanceId: string,
    loadFullDslTemplate?: boolean
  ): Promise<{
    ok?: boolean;
    documentInstanceId?: string;
    revision?: number;
    eventCount?: number;
    instructionCount?: number;
    dslTemplate?: string;
    dslTemplateTruncated?: boolean;
    dslTemplateTotalLines?: number;
    sourceHash?: string | null;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => ipcRenderer.invoke(
    'resource.readEmevdFullDocument',
    sourceUri,
    documentInstanceId,
    loadFullDslTemplate === true ? true : undefined
  ),
  submitEmevdDslPlan: (sourceUri: string, sourceText: string): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.submitEmevdDslPlan', sourceUri, sourceText),
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
  readTaeDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeDocument', sourceUri),
  readEsdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readEsdDocument', sourceUri),
  readFlverDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverDocument', sourceUri),
  readFlverMesh: (sourceUri: string, meshIndex: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverMesh', sourceUri, meshIndex),
  readFlverSkeleton: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverSkeleton', sourceUri),
  readFlverDummies: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverDummies', sourceUri),
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
  applyParamFieldMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: {
      rowId: number;
      fieldId: string;
      value: number | string | boolean;
      rowDataBase64: string;
      definition: unknown;
    }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyParamFieldMutation', sourceUri, expectedHash, mutation),
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
