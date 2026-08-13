import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiAgentApprovalResponseRequest,
  AiAgentEventEnvelope,
  AiAgentRunIpcResult,
  AiAgentRunRequest,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AnalyzeWorkspaceSummary,
  DirectorySelection,
  OpenWorkspaceScanOptions,
  RendererWorkspaceScanResult,
  RollbackOperationIpcResult,
  TextCatalogResponse
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
  ApplyEditorMutationRequest,
  ApplyEditorMutationValue,
  Diagnostic,
  EditorContentValue,
  EditorDocumentPageValue,
  EditorDocumentResult,
  EditorPageQuery,
  FmgEntryPage,
  OpenEditorDocumentRequest,
  OpenEditorDocumentValue,
  PageEditorDocumentRequest,
  ParamRowPage,
  ReadEditorContentRequest,
  RendererContainerChildBytes,
  RendererContainerChildrenList,
  RendererContainerChildrenPage,
  RendererContainerTreeSummary,
  ScriptContainerEntryPage,
  ScriptContainerEvidence,
  ScriptEntryPlaintextView
} from '@soulforge/shared';
import { EDITOR_DOCUMENT_IPC_CHANNELS } from '@soulforge/shared';

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
  /**
   * §14.4 DocumentStore typed facade（DOCSTORE-04）。
   * 所有方法都是 named DTO 请求/响应，不保留 Promise<unknown> 旁路；
   * ownerKey 由 main 从 trusted webContents 与 workspace session 派生，
   * renderer 永远不能传入。
   */
  openEditorDocument: (request: OpenEditorDocumentRequest): Promise<EditorDocumentResult<OpenEditorDocumentValue>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.open, request),
  getEditorDocument: (documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.get, documentHandle),
  pageEditorDocument: (request: PageEditorDocumentRequest): Promise<EditorDocumentResult<EditorDocumentPageValue>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.page, request),
  readEditorDocumentContent: (request: ReadEditorContentRequest): Promise<EditorDocumentResult<EditorContentValue>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.readContent, request),
  applyEditorMutation: (request: ApplyEditorMutationRequest): Promise<EditorDocumentResult<ApplyEditorMutationValue>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.apply, request),
  closeEditorDocument: (documentHandle: string): Promise<EditorDocumentResult<{ closed: true }>> =>
    ipcRenderer.invoke(EDITOR_DOCUMENT_IPC_CHANNELS.close, documentHandle),
  /**
   * 上次打开过的工作区 / 原版目录的选择凭据，供启动时自动挂载。
   *
   * 不接受入参：路径由主进程从「用户亲手选过」的记录里取，渲染器无法借它
   * 让主进程为任意路径签发凭据。目录已失效时返回 null。
   */
  lastWorkspaceSelection: (): Promise<{
    overlay: DirectorySelection | null;
    base: DirectorySelection | null;
  }> => ipcRenderer.invoke('workspace.lastSelection'),
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
  readScriptEntryPlaintext: (
    sourceUri: string,
    entryName: string
  ): Promise<ScriptEntryPlaintextView> =>
    ipcRenderer.invoke('resource.readScriptEntryPlaintext', sourceUri, entryName),
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
    sourceFormat?: string | null;
    outerFileHash?: string | null;
    outline?: {
      schemaVersion: 1;
      resourceUri: string;
      eventCount: number;
      instructionTotal: number;
      truncated: boolean;
      limit: number;
      events: Array<{
        eventUri: string;
        eventId: number;
        restBehavior: number;
        layer: number;
        instructionCount: number;
        unknownCount: number;
      }>;
    } | null;
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
  readTextCatalog: (): Promise<TextCatalogResponse> =>
    ipcRenderer.invoke('resource.readTextCatalog'),
  readFmgTablePage: (
    tableId: string,
    page: number,
    pageSize: number,
    query?: string
  ): Promise<FmgEntryPage> =>
    ipcRenderer.invoke('resource.readFmgTablePage', tableId, page, pageSize, query),
  applyFmgMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string },
    tableId?: string
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyFmgMutation', sourceUri, expectedHash, mutation, tableId),
  readMsbDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMsbDocument', sourceUri),
  readTaeDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeDocument', sourceUri),
  readEsdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readEsdDocument', sourceUri),
  readMtdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMtdDocument', sourceUri),
  readFxrDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFxrDocument', sourceUri),
  readFlverDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverDocument', sourceUri),
  readTpfDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTpfDocument', sourceUri),
  readTpfTexturePreview: (sourceUri: string, textureIndex: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTpfTexturePreview', sourceUri, textureIndex),
  saveTpfTextureReplace: (
    sourceUri: string,
    expectedHash: string,
    textureIndex: number,
    newTextureBase64: string
  ): Promise<unknown> =>
    ipcRenderer.invoke('resource.saveTpfTextureReplace', sourceUri, expectedHash, textureIndex, newTextureBase64),
  readFlverMesh: (sourceUri: string, meshIndex: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverMesh', sourceUri, meshIndex),
  readFlverSkeleton: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverSkeleton', sourceUri),
  readFlverDummies: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverDummies', sourceUri),
  readFlverTextureSlots: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFlverTextureSlots', sourceUri),
  applyMsbMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: {
      kind: 'set_part_position' | 'set_part_transform' | 'set_region_position'
        | 'delete_part' | 'delete_region' | 'delete_event';
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
  readGparamDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readGparamDocument', sourceUri),
  /**
   * GPARAM-11C：typed field-set 写回（无 bytes replace fallback——只有 typed
   * 定位才有写入口）。expectedDocumentHash 由渲染器回传 read 时的 sourceHash。
   */
  commitGparamMutations: (
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: Array<{
      groupId: number;
      paramId: number;
      valueIndex: number;
      value: number;
    }>
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.commitGparamMutations', sourceUri, expectedDocumentHash, mutations),
  /**
   * MATERIAL-53C：MTD 材质属性写回（无通用 XML 文本替换 fallback——只有 typed
   * paramId 定位才有写入口）。expectedDocumentHash 由渲染器回传 read 时的 sourceHash。
   */
  commitMtdPropertySet: (
    sourceUri: string,
    expectedDocumentHash: string,
    set: { paramId: string; newValue: string }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.commitMtdPropertySet', sourceUri, expectedDocumentHash, set),
  /**
   * BEHAVIOR-55C：ESD 状态转移写回（behavior-transition-upsert）。
   * mutation 定位用读信封的 stable relOffset（stateRelOffset / conditionRelOffset /
   * targetStateRelOffset）。命令参数体（RPN 字节码）永久不解码，触碰它的 mutation
   * 由 C# 侧 fail-closed 拒绝。
   */
  commitEsdTransition: (
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: Array<{
      mutation: string;
      stateRelOffset?: number;
      conditionRelOffset?: number;
      targetStateRelOffset?: number;
    }>
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.commitEsdTransition', sourceUri, expectedDocumentHash, mutations),
  /**
   * 当前 PARAM 元数据包的身份与信任状态。
   *
   * 界面据此决定是否显示「信任该元数据包」的一次性确认入口 —— 字段写入必须
   * 先经这一步，因为元数据的字段偏移若与真实 PARAM 不符，按它写入就是往错误
   * 字节位置塞数值。
   */
  getParamMetadataTrustState: (): Promise<{
    ok: boolean;
    trusted: boolean;
    packageId: string | null;
    packageVersion: string | null;
    sourceIdentity?: string | null;
    sourceRevision?: string | null;
    licenseSpdxExpression?: string | null;
    confirmedAt?: string;
    diagnostics: Diagnostic[];
  }> => ipcRenderer.invoke('param.metadata.trustState'),
  /** 记录/撤销对当前元数据包的信任。信任绑定到包摘要，包变化会要求重新确认。 */
  setParamMetadataTrust: (trusted: boolean): Promise<{
    ok: boolean;
    trusted?: boolean;
    diagnostics: Diagnostic[];
  }> => ipcRenderer.invoke('param.metadata.setTrust', trusted),
  readParamPage: (
    sourceUri: string,
    page: number,
    pageSize: number,
    query?: string
  ): Promise<ParamRowPage> =>
    ipcRenderer.invoke('resource.readParamPage', sourceUri, page, pageSize, query),
  /**
   * 列出 parambnd 容器内的 param 条目（Smithbox 的 Param List 那一栏）。
   * 每一项都可直接交给 readContainerParamPage —— 列得出来就读得到。
   */
  listContainerParams: (containerUri: string): Promise<{
    ok: boolean;
    containerUri: string;
    containerFormat?: string | null;
    params: Array<{ entryIndex: number; name: string; size: number }>;
    diagnostics: Diagnostic[];
  }> => ipcRenderer.invoke('resource.listContainerParams', containerUri),
  /**
   * 读取容器内某个 param 的一页行。main 侧先把该条目解包成裸 param 落会话
   * 暂存区再读 —— read-param-document 不解 DCX/BND4，直接喂容器必失败。
   */
  readContainerParamPage: (
    containerUri: string,
    entryIndex: number,
    page: number,
    pageSize: number,
    query?: string
  ): Promise<ParamRowPage & {
    containerUri: string;
    entryIndex: number;
    paramName?: string;
    typeName: string | null;
    /** 写回所需：容器与条目的当前哈希，原样回传即可。 */
    containerHash?: string;
    childHash?: string;
  }> => ipcRenderer.invoke(
    'resource.readContainerParamPage',
    containerUri,
    entryIndex,
    page,
    pageSize,
    query
  ),
  /**
   * 一次读出容器内某个 param 的完整行索引（只 id + name，不含行字节）。
   *
   * 行表据此建成一条完整长列表（虚拟滚动的前提），跨表引用跳转也据此按绝对下标
   * 定位目标行。行字节仍按页取 —— 载荷门限按页算。详见 main 侧该 handler 的注释。
   */
  readContainerParamRowIndex: (
    containerUri: string,
    entryIndex: number
  ): Promise<{
    ok: boolean;
    paramName: string | null;
    typeName: string | null;
    rowDataSize: number;
    rowCount: number;
    rows: Array<{ id: number; name?: string }>;
    rowsTruncated: boolean;
    containerHash: string;
    childHash: string;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }> => ipcRenderer.invoke(
    'resource.readContainerParamRowIndex',
    containerUri,
    entryIndex
  ),
  /**
   * 容器内 param 的字段写入：改字段 → 重打包容器 → Patch Engine 提交。
   *
   * 与 applyParamFieldMutation 的区别是写目标：那条写裸 param 文件，这条写
   * 用户实际打开的 parambnd 容器。两个哈希来自 readContainerParamPage，
   * 用于并发保护（容器或条目在读写之间被改过时拒绝而非静默覆盖）。
   */
  applyContainerParamFieldMutation: (
    containerUri: string,
    expectedContainerHash: string,
    mutation: {
      entryIndex: number;
      expectedChildHash: string;
      rowId: number;
      fieldId: string;
      value: number | string | boolean;
      rowDataBase64: string;
      definition: unknown;
    }
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'resource.applyContainerParamFieldMutation',
    containerUri,
    expectedContainerHash,
    mutation
  ),
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
  /**
   * Answer one approval request. The request itself arrives as an
   * `approval-requested` agent event; main parks the loop until this resolves.
   * `matched: false` means the request had already been settled (session ended
   * or timed out) — a normal race the UI uses to clear its card.
   */
  respondAiAgentApproval: (
    request: AiAgentApprovalResponseRequest
  ): Promise<{ ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }> =>
    ipcRenderer.invoke('ai.agent.approval.respond', request),
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
