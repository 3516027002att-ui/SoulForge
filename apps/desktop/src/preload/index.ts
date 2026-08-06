import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiAgentEventEnvelope,
  AiAgentRunIpcResult,
  AiAgentRunRequest,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
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
import type {
  FmgEntryPage,
  ParamRowPage,
  RendererContainerChildBytes,
  RendererContainerChildrenList,
  RendererContainerChildrenPage,
  RendererContainerTreeSummary,
  ScriptContainerEntryPage,
  ScriptContainerEvidence
} from '@soulforge/shared';

/** Path-bearing fields that must never cross the context bridge to the renderer. */
const RENDERER_FORBIDDEN_PATH_KEYS = new Set([
  'containerPath',
  'rootPath',
  'absolutePath',
  'sourcePath',
  'targetPath',
  'backupPath'
]);

/** Mask absolute filesystem paths that may appear inside diagnostic strings. */
function maskAbsolutePathString(value: string): string {
  const containsWindowsDrivePath = /(^|[\s('"=])(?:[A-Za-z]:[\\/])/.test(value);
  const containsUncOrDevicePath = /(^|[\s('"=])\\\\(?:[?.]\\)?[^\\/\s]+[\\/]/.test(value);
  const containsAbsoluteFileUri = /file:\/\/\/[A-Za-z]:\//i.test(value);
  return containsWindowsDrivePath || containsUncOrDevicePath || containsAbsoluteFileUri
    ? '[本机路径已隐藏]'
    : value;
}

function stripPathFields<T>(value: T): T {
  if (typeof value === 'string') {
    return maskAbsolutePathString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPathFields(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (RENDERER_FORBIDDEN_PATH_KEYS.has(key)) continue;
      output[key] = stripPathFields(child);
    }
    return output as unknown as T;
  }
  return value;
}

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
  inspectContainerTree: (sourceUri: string): Promise<RendererContainerTreeSummary> =>
    ipcRenderer.invoke('resource.inspectContainerTree', sourceUri).then(stripPathFields),
  listContainerChildren: (sourceUri: string, recursive?: boolean): Promise<RendererContainerChildrenList> =>
    ipcRenderer.invoke('resource.listContainerChildren', sourceUri, recursive),
  listContainerChildrenPage: (
    sourceUri: string,
    page: number,
    pageSize: number,
    recursive?: boolean
  ): Promise<RendererContainerChildrenPage> =>
    ipcRenderer.invoke(
      'resource.listContainerChildrenPage',
      sourceUri,
      page,
      pageSize,
      recursive
    ).then(stripPathFields),
  readContainerChild: (childUri: string): Promise<RendererContainerChildBytes> =>
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
  scriptContainerEvidence: (sourceUri: string): Promise<ScriptContainerEvidence> =>
    ipcRenderer.invoke('resource.scriptContainerEvidence', sourceUri).then(stripPathFields),
  listScriptContainerEntriesPage: (
    sourceUri: string,
    page: number,
    pageSize: number
  ): Promise<ScriptContainerEntryPage> =>
    ipcRenderer.invoke(
      'resource.listScriptContainerEntriesPage',
      sourceUri,
      page,
      pageSize
    ).then(stripPathFields),
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
  readFmgPage: (
    sourceUri: string,
    page: number,
    pageSize: number,
    query?: string
  ): Promise<FmgEntryPage> =>
    ipcRenderer.invoke('resource.readFmgPage', sourceUri, page, pageSize, query),
  applyFmgMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string }
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
  readTpfDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTpfDocument', sourceUri),
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
  readParamPage: (
    sourceUri: string,
    page: number,
    pageSize: number,
    query?: string
  ): Promise<ParamRowPage> =>
    ipcRenderer.invoke('resource.readParamPage', sourceUri, page, pageSize, query),
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
    ipcRenderer.invoke('modelService.delete', configId),
  /**
   * AI agent sessions (Codex-derived kernel). Runs async in main; progress
   * arrives on onAiAgentEvent envelopes; keys never cross the bridge.
   */
  runAiAgent: (request: AiAgentRunRequest): Promise<AiAgentRunIpcResult> =>
    ipcRenderer.invoke('ai.agent.run', request),
  cancelAiAgent: (sessionId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('ai.agent.cancel', sessionId),
  listAiAgentSessions: (): Promise<AiAgentSessionListIpcResult> =>
    ipcRenderer.invoke('ai.agent.sessions'),
  loadAiAgentSession: (sessionPath: string): Promise<AiAgentSessionLoadIpcResult> =>
    ipcRenderer.invoke('ai.agent.session.load', sessionPath),
  onAiAgentEvent: (callback: (envelope: AiAgentEventEnvelope) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AiAgentEventEnvelope): void => {
      callback(envelope);
    };
    ipcRenderer.on('ai:agent:event', listener);
    return () => {
      ipcRenderer.removeListener('ai:agent:event', listener);
    };
  }
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
