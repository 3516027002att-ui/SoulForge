import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiAgentApprovalResponseRequest,
  AiAgentEventEnvelope,
  AiAgentRunIpcResult,
  AiAgentRunRequest,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AgentAttachmentCreateIpcResult,
  AgentResourceReferenceCreateIpcResult,
  AnalyzeWorkspaceSummary,
  DirectorySelection,
  OpenWorkspaceScanOptions,
  RendererWorkspaceScanResult,
  RendererWorkspaceSession,
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
  EmedfCompletionItem,
  ResourceCapabilityMatrix,
  ToolDescriptor,
  ToolResult,
  ModelThinkingLevel,
  MemoryEntry,
  DoctorReport,
  AutoFixResult,
  DoctorOptions
} from '@soulforge/core';
import type {
  AgentResourceReference,
  ApplyEditorMutationRequest,
  ApplyEditorMutationValue,
  Diagnostic,
  EditorContentValue,
  EditorDocumentPageValue,
  EditorDocumentResult,
  EditorPageQuery,
  EditorSelectionContext,
  FmgEntryPage,
  OpenEditorDocumentRequest,
  OpenEditorDocumentValue,
  PageEditorDocumentRequest,
  ParamFieldDef,
  ParamRowPage,
  RagRetrieveResult,
  ReadEditorContentRequest,
  RendererContainerChildBytes,
  RendererContainerChildrenList,
  RendererContainerChildrenPage,
  RendererContainerTreeSummary,
  ScriptContainerEntryPage,
  ScriptContainerEvidence,
  ScriptEntryPlaintextView,
  CiteHit
} from '@soulforge/shared';
import { EDITOR_DOCUMENT_IPC_CHANNELS, maskPathFragments } from '@soulforge/shared';

/** Path-bearing fields that must never cross the context bridge to the renderer. */
const RENDERER_FORBIDDEN_PATH_KEYS = new Set([
  'containerPath',
  'rootPath',
  'absolutePath',
  'sourcePath',
  'targetPath',
  'backupPath'
]);

/** Mask absolute filesystem paths that may appear inside diagnostic strings.
 *  S13：与 main 共用 shared 的同一规则 —— 只打码路径片段，保留上下文。 */
function maskAbsolutePathString(value: string): string {
  return maskPathFragments(value);
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
  // S22：工作区已打开时重挂原版目录（baseSelectionId=null 卸载原版层），当场生效。
  remountBase: (baseSelectionId: string | null): Promise<{
    workspaceSessionId: string;
    session: RendererWorkspaceSession;
  }> => ipcRenderer.invoke('workspace.remountBase', baseSelectionId),
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
  readScriptSource: (
    sourceUri: string,
    entryName?: string,
    entryIndex?: number
  ): Promise<import('@soulforge/shared').ScriptSourceView> =>
    ipcRenderer.invoke('resource.readScriptSource', sourceUri, entryName, entryIndex),
  saveScriptSource: (
    sourceUri: string,
    entryName: string | undefined,
    expectedChildHash: string | undefined,
    expectedContainerHash: string | undefined,
    sourceText: string,
    encoding?: string
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke(
      'resource.saveScriptSource',
      sourceUri,
      entryName,
      expectedChildHash,
      expectedContainerHash,
      sourceText,
      encoding
    ),
  listOperations: (): Promise<RendererPatchHistoryEntry[]> => ipcRenderer.invoke('operation.list'),
  rollbackOperation: (opId: string): Promise<RollbackOperationIpcResult> =>
    ipcRenderer.invoke('operation.rollback', opId),
  /** 文件级回滚：把某次已提交操作里的单个文件恢复到操作前状态。 */
  rollbackFile: (opId: string, targetUri: string): Promise<RollbackOperationIpcResult> =>
    ipcRenderer.invoke('operation.rollbackFile', opId, targetUri),
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
    /**
     * main 侧取消：本次打开已被更晚的打开请求取代（快速切换事件文件）。它与
     * `ok: false` 的读取失败必须分开处理 —— 取消不代表文件有问题，调用方要静默
     * 丢弃，不能渲染成「读不出来」。
     */
    cancelled?: boolean;
    documentInstanceId?: string;
    revision?: number;
    eventCount?: number;
    instructionCount?: number;
    /** R3/P4 裁定：DarkScript3 式源码；3.1 起首包不再带全文，全文走 sourceToken。 */
    dslTemplate?: string | null;
    /** 前 400 行，供首屏看见 $Event；其余走 readEmevdSourceSlice。 */
    sourcePrefix?: string | null;
    /** 只活在 main 的 opaque 令牌，不是路径。 */
    sourceToken?: string | null;
    sourceTotalLines?: number;
    /**
     * 源码形态：'dark-script'（EMEDF 反汇编，只读展示）、'patch-dsl'（旧 hash
     * DSL，仅历史路径）、'none'（EMEDF 缺失失败关闭）。
     */
    sourceStyle?: 'dark-script' | 'patch-dsl' | 'none';
    dslTemplateTruncated?: boolean;
    dslTemplateTotalLines?: number;
    sourceHash?: string | null;
    sourceFormat?: string | null;
    outerFileHash?: string | null;
    /** Bridge 往返判定：'native-verified'（语义+字节一致）/ 'candidate'（仅语义）。 */
    authority?: string | null;
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
  /**
   * 主动取消本窗口在飞的事件文档打开。
   *
   * 为什么非要有这条通道：main 的槽位只在**下一次打开请求**到达时才中止上一份，
   * 而「切到 PARAM/MAP 域」「关掉编辑器」根本不会再发打开请求 —— 于是那次读会
   * 一路跑完（剩余分页读 + outline + 整段反汇编），只是结果没人要。renderer 侧
   * 清理只翻一个本地布尔值，对主进程完全不可见。
   *
   * 不带参数：一个窗口只有一份在飞的打开，槽位就是按窗口存的，取消的语义只能是
   * 「我这个窗口那份」。传 sourceUri 反而会引入「传错了就静默不取消」的失败模式。
   */
  cancelEmevdFullDocument: (): Promise<{ ok: boolean; cancelled: boolean }> =>
    ipcRenderer.invoke('resource.cancelEmevdFullDocument'),
  readEmevdSourceSlice: (
    token: string,
    fromLine: number,
    lineCount: number
  ): Promise<{
    ok?: boolean;
    cancelled?: boolean;
    code?: string;
    message?: string;
    fromLine?: number;
    lineCount?: number;
    totalLines?: number;
    eof?: boolean;
    sliceText?: string;
  }> => ipcRenderer.invoke('resource.readEmevdSourceSlice', token, fromLine, lineCount),
  submitEmevdDslPlan: (sourceUri: string, sourceText: string, mode: 'patch' | 'dark-script' = 'patch'): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.submitEmevdDslPlan', sourceUri, sourceText, mode),
  readEmedfCompletionCatalog: (): Promise<{
    ok: boolean;
    origin: 'imported' | 'fixture';
    items: EmedfCompletionItem[];
    enums?: Record<string, import('@soulforge/core').EmedfEnumDef>;
  }> =>
    ipcRenderer.invoke('resource.readEmedfCompletionCatalog'),
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
  readMapPartFlverPreview: (mapSourceUri: string, modelName: string, sibPath?: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMapPartFlverPreview', mapSourceUri, modelName, sibPath),
  readTaeDocument: (sourceUri: string, options?: { animationPage?: number; animationPageSize?: number }): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeDocument', sourceUri, options),
  /** S17：词条名目录（main 解析本机 TAE.Template.SDT.xml；renderer 只拿逻辑名）。 */
  readTaeTemplateCatalog: (): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeTemplateCatalog'),
  /** S17：单个词条事件参数体（按本机模板解码字段；无模板返回未解码 + hex）。 */
  readTaeEventParams: (sourceUri: string, animId: number, eventIndex: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeEventParams', sourceUri, animId, eventIndex),
  /** S17：伴生 chrbnd 的 FLVER 预览（overlay → 原版；KRAK 缺 Oodle 给可行动码）。 */
  readTaeChrbndPreview: (sourceUri: string, meshIndex: number): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeChrbndPreview', sourceUri, meshIndex),
  /** ACTION：读取 TAE 关联的真实 HKX 动画 Clip 数据 */
  readTaeAnimationClip: (sourceUri: string, animId: number, flverBoneNames?: string[]): Promise<unknown> =>
    ipcRenderer.invoke('resource.readTaeAnimationClip', sourceUri, animId, flverBoneNames),
  /** ACTION：连续时间采样 TAE 动画位姿 */
  sampleTaeAnimationPose: (sourceUri: string, animId: number, timeSeconds: number, flverBoneNames?: string[], loop?: boolean): Promise<unknown> =>
    ipcRenderer.invoke('resource.sampleTaeAnimationPose', sourceUri, animId, timeSeconds, flverBoneNames, loop),
  // S23：按 modelName 在 mapbnd 容器里取 part 的 FLVER 网格（地图 viewport）。
  readMapPartMesh: (msbSourceUri: string, modelName: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMapPartMesh', msbSourceUri, modelName),
  readEsdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readEsdDocument', sourceUri),
  readMtdDocument: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readMtdDocument', sourceUri),
  readFxrDocument: (sourceUri: string, entryName?: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.readFxrDocument', sourceUri, entryName),
  // S24：ffxbnd 效果库的 .fxr 子项清单（逻辑名）。
  listFxrEntries: (sourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.listFxrEntries', sourceUri),
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
  resolveChrbndPreview: (animSourceUri: string): Promise<unknown> =>
    ipcRenderer.invoke('resource.resolveChrbndPreview', animSourceUri),
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
  /**
   * S38：write-flver material-slot-set 写回（与 main resource.applyFlverMutation
   * 通道一致；mesh 越界 / no-op / layoutWarnings 非空由 C# 侧 fail-closed 拒绝）。
   */
  applyFlverMutation: (
    sourceUri: string,
    expectedHash: string,
    mutation: {
      kind: 'material-slot-set';
      meshStableId: string;
      slotIndex: number;
      materialStableId: string;
    }
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.applyFlverMutation', sourceUri, expectedHash, mutation),
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
   * ANIMATION-56C：TAE 事件写回（tae-event-upsert）。
   * mutation 定位用 animId + 事件表下标；update-event-times 是字节级外科替换
   * 事件时间，insert-event 按模板逐字节拷贝参数体后追加新事件。时间槽被兄弟
   * 事件共享时由 C# 侧 fail-closed 拒绝。
   */
  commitTaeEvent: (
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: Array<{
      mutation: string;
      animId?: number;
      eventIndex?: number;
      templateEventIndex?: number;
      eventTypeId?: number;
      startTime?: number;
      endTime?: number;
    }>
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.commitTaeEvent', sourceUri, expectedDocumentHash, mutations),
  /**
   * VFX-54C：FXR 字段写回（vfx-field-set）。
   * mutation 定位用结构性路径（host 收集序 + property/§8 下标 + Section11 值下标）；
   * C# 侧只在已知布局下开放写入口，未知 node type / layout warning / Section9 非空 /
   * Section12-14 非空都 fail-closed 拒绝。
   */
  commitFxrFieldSet: (
    sourceUri: string,
    expectedDocumentHash: string,
    mutations: Array<{
      mutation: string;
      address: {
        container: string;
        hostIndex: number;
        propertyIndex?: number;
        section8Index?: number;
        valueIndex: number;
      };
      value: number;
    }>
  ): Promise<RendererSaveResult> =>
    ipcRenderer.invoke('resource.commitFxrFieldSet', sourceUri, expectedDocumentHash, mutations),
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
    query?: string,
    /** 全量加载（用户裁定）：一次返回全部行（含字节），renderer 本地过滤/虚拟化。 */
    loadAll?: boolean
  ): Promise<ParamRowPage> =>
    ipcRenderer.invoke('resource.readParamPage', sourceUri, page, pageSize, query, loadAll),
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
    query?: string,
    /** 全量加载（用户裁定）：一次返回全部行（含字节），renderer 本地过滤/虚拟化。 */
    loadAll?: boolean
  ): Promise<ParamRowPage & {
    containerUri: string;
    entryIndex: number;
    paramName?: string;
    typeName: string | null;
    /** 写回所需：容器与条目的当前哈希，原样回传即可。 */
    containerHash?: string;
    childHash?: string;
    /**
     * P1：随页下发的字段定义/枚举/授信来源。主进程在 resolveTrustedParamDefinition
     * 里完成包校验 + 行宽核对 + 用户信任策略；origin 只给白名单值，渲染器不自行判定。
     */
    fieldDefs?: ParamFieldDef[] | null;
    fieldEnums?: Array<{
      id: string;
      name?: string;
      values: Array<{ value: number; label: string }>;
    }> | null;
    fieldDefsDiagnostic?: { code: string; message: string } | null;
    fieldDefsOrigin?: 'fixture' | 'imported' | 'user-derived' | null;
    fieldDefsTrusted?: boolean;
  }> => ipcRenderer.invoke(
    'resource.readContainerParamPage',
    containerUri,
    entryIndex,
    page,
    pageSize,
    query,
    loadAll
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
  /**
   * 容器内 param 的**行名**写入（T5-3）：与字段写入同一条 Patch 链。
   * rowDataBase64 原样携带当前行字节；name 允许空串（清名）。
   */
  applyContainerParamRowNameMutation: (
    containerUri: string,
    expectedContainerHash: string,
    mutation: {
      entryIndex: number;
      expectedChildHash: string;
      rowId: number;
      name: string;
      rowDataBase64: string;
    }
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'resource.applyContainerParamRowNameMutation',
    containerUri,
    expectedContainerHash,
    mutation
  ),
  /**
   * 容器内 param 的**行级**写入（问题 4）：新建行 / 复制当前行 / 删除当前行。
   *
   * 与字段/行名写入同一条 Patch 链（write-param add/delete → write-bnd4 →
   * Patch Engine）。rowId 由渲染器按「当前表最大 id + 1」给出；add/copy 携带
   * 整行字节（copy = 当前行原样，add = 行宽 0 行），delete 不带字节。
   */
  applyContainerParamRowMutations: (
    containerUri: string,
    expectedContainerHash: string,
    mutation: {
      kind: 'add' | 'copy' | 'delete';
      entryIndex: number;
      expectedChildHash: string;
      rowId: number;
      rowDataBase64: string;
    }
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'resource.applyContainerParamRowMutations',
    containerUri,
    expectedContainerHash,
    mutation
  ),
  /**
   * T5-4：导出行（CSV，主进程保存对话框）。表头 id,name,<字段内部 id>…。
   * 导出是新建文件、不走 Patch Engine，但禁止写进游戏目录 / Mod 工作区。
   */
  exportParamRowsCsv: (
    containerUri: string,
    expectedContainerHash: string,
    entryIndex: number
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'param.exportRowsCsv',
    containerUri,
    expectedContainerHash,
    entryIndex
  ),
  /** T5-4：导出备注（行名 CSV：id,name），对照 Yapped Export Names。 */
  exportParamNamesCsv: (
    containerUri: string,
    expectedContainerHash: string,
    entryIndex: number
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'param.exportNamesCsv',
    containerUri,
    expectedContainerHash,
    entryIndex
  ),
  /**
   * T5-4：导入备注（行名 CSV：id,name，主进程打开对话框）。逐 id 走
   * write-param upsert（行字节原样回传 + 新 name）→ 重打包 → Patch Engine。
   */
  importParamNamesCsv: (
    containerUri: string,
    expectedContainerHash: string,
    entryIndex: number,
    expectedChildHash: string
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'param.importNamesCsv',
    containerUri,
    expectedContainerHash,
    entryIndex,
    expectedChildHash
  ),
  /**
   * T5-4：导入行（CSV：id,name,<字段内部 id>…，主进程打开对话框）。字段按表头
   * id 逐个套到当前行字节，整批走同一条 Patch 链。
   */
  importParamRowsCsv: (
    containerUri: string,
    expectedContainerHash: string,
    entryIndex: number,
    expectedChildHash: string
  ): Promise<RendererSaveResult> => ipcRenderer.invoke(
    'param.importRowsCsv',
    containerUri,
    expectedContainerHash,
    entryIndex,
    expectedChildHash
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
    protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    hasCredential: boolean;
    createdAt: string;
    updatedAt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    contextWindowTokens?: number;
    thinkingLevel?: ModelThinkingLevel;
  }>> => ipcRenderer.invoke('modelService.list'),
  getProviderUsageSummary: (): Promise<{
    calls: number;
    reportedCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    firstUsedAt: string | null;
    lastUsedAt: string | null;
    byService: Array<{
      serviceId: string;
      protocol: string;
      model: string;
      calls: number;
      reportedCalls: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      firstUsedAt: string | null;
      lastUsedAt: string | null;
    }>;
    latestSession: null | {
      sessionId: string;
      serviceId: string;
      protocol: string;
      model: string;
      calls: number;
      reportedCalls: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      firstUsedAt: string | null;
      lastUsedAt: string | null;
      lastCallIndex: number;
      currentContextTokens: number;
      contextSource: 'provider' | 'estimated';
      active: boolean;
    };
  }> => ipcRenderer.invoke('modelService.usageSummary'),
  modelServiceEncryptionAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('modelService.encryptionAvailable'),
  upsertModelService: (input: {
    id?: string;
    displayName: string;
    protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    apiKey?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    contextWindowTokens?: number;
    thinkingLevel?: ModelThinkingLevel;
  }): Promise<{
    id: string;
    displayName: string;
    protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
    baseUrl: string;
    model: string;
    hasCredential: boolean;
    createdAt: string;
    updatedAt: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    maxTokens?: number;
    contextWindowTokens?: number;
    thinkingLevel?: ModelThinkingLevel;
  }> => ipcRenderer.invoke('modelService.upsert', input),
  deleteModelService: (configId: string): Promise<{ ok: true }> =>
    ipcRenderer.invoke('modelService.delete', configId),
  /**
   * 为当前工作区语料生成 embedding 向量索引（分批 POST /v1/embeddings）。
   * 服务配置必须含 embeddingModel；失败批降级返回失败数。
   */
  embedWorkspaceRag: (input: { configId: string }): Promise<
    | { ok: true; embedded: number; failed: number; model: string; dim: number }
    | { ok: false; error: { code: string; message: string } }
  > => ipcRenderer.invoke('rag.embed', input),
  /**
   * 工作区混合检索：lexical + 向量 RRF 融合。configId 提供且与索引模型一致时
   * 启用向量侧，否则退化为纯 lexical。
   */
  searchWorkspaceEvidence: (input: {
    query: string;
    configId?: string;
    limit?: number;
    families?: string[];
    expandReferences?: boolean;
  }): Promise<RagRetrieveResult> => ipcRenderer.invoke('rag.searchEvidence', input),
  /**
   * 拉取模型服务的可用模型列表（GET /v1/models）。按表单当前值请求，不要求
   * 服务已保存；apiKey 可选（本地服务通常无密钥）。main 复用生产工厂的
   * endpoint 安全校验，key 只在本次调用内使用。
   */
  listModelModels: (input: {
    protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
    baseUrl: string;
    apiKey?: string;
  }): Promise<
    | { ok: true; models: Array<{ id: string; displayName?: string }> }
    | { ok: false; error: { code: string; message: string } }
  > => ipcRenderer.invoke('modelService.listModels', input),
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
  /**
   * 资源引用通道（AGENT-60C）：把 renderer 的 §12.8 语义选区换成 main 签发的
   * opaque token。main 先做 root 校验与安全白名单（绝对路径 / raw parser / Hex
   * dump 拒绝），token 不携带任何路径，跨 sender 提交在 main 侧被拒。
   */
  createAgentResourceReference: (
    selection: EditorSelectionContext
  ): Promise<AgentResourceReferenceCreateIpcResult> =>
    ipcRenderer.invoke('agent.resourceReference.create', { selection }),
  /**
   * S10 引用框选签发：把框选命中的 data-cite 节点（CiteHit[]）交给 main 解码合并
   * 并签发 opaque token（与资源引用同形态）。renderer 不拼 label、不伪造 token。
   */
  createAgentCitation: (
    hits: readonly CiteHit[]
  ): Promise<AgentResourceReferenceCreateIpcResult> =>
    ipcRenderer.invoke('agent.citation.create', { hits }),
  /**
   * 附件：main 弹原生文件对话框，把文件拷到 userData/agent/attachments，签发 opaque token。
   * renderer 只拿到 token / 媒体类型 / 字节数 / 显示名，没有绝对路径。
   */
  createAgentAttachment: (): Promise<AgentAttachmentCreateIpcResult> =>
    ipcRenderer.invoke('agent.attachment.create'),
  listAiMemories: (): Promise<{ ok: true; entries: MemoryEntry[] } | { ok: false; error: { code: string; message: string } }> =>
    ipcRenderer.invoke('ai.memory.list'),
  saveAiMemory: (entry: { id?: string; topic: string; summary: string; details?: string; tags?: string[] }): Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: { code: string; message: string } }> =>
    ipcRenderer.invoke('ai.memory.save', entry),
  deleteAiMemory: (idOrTopic: string): Promise<{ ok: true; deleted: boolean } | { ok: false; error: { code: string; message: string } }> =>
    ipcRenderer.invoke('ai.memory.delete', idOrTopic),
  onAiAgentEvent: (callback: (envelope: AiAgentEventEnvelope) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, envelope: AiAgentEventEnvelope): void => {
      callback(envelope);
    };
    ipcRenderer.on('ai:agent:event', listener);
    return () => {
      ipcRenderer.removeListener('ai:agent:event', listener);
    };
  },
  doctorDiagnose: (options?: DoctorOptions): Promise<DoctorReport> =>
    ipcRenderer.invoke('doctor.diagnose', options),
  doctorAutoFix: (options?: DoctorOptions): Promise<AutoFixResult> =>
    ipcRenderer.invoke('doctor.autoFix', options)
};

contextBridge.exposeInMainWorld('soulforge', api);

export type SoulForgeApi = typeof api;
