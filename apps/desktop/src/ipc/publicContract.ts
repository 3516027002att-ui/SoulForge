/** Sole authority for the existing renderer-visible SoulForge IPC facade.
 * Internal handlers are deliberately not described here. Generated projections
 * preserve these public parameters, wire defaults, results and subscriptions.
 */
import { invoke, subscribe } from './contractDefinition.js';
import type { NativeWindowThemeMode, NativeWindowThemeResult } from './publicTypes.js';
import type {
  AiAgentApprovalResponseRequest,
  AiAgentCancelIpcResult,
  AiAgentEventEnvelope,
  AiAgentEventReplayIpcResult,
  AiAgentPermissionRequestResult,
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
} from './publicTypes.js';
import type {
  RendererIndexedFile,
  RendererPatchHistoryEntry,
  RendererResourcePreview,
  RendererSaveResult
} from './publicTypes.js';
import type {
  AiSidebarDraft,
  AiSidebarDraftRequest,
  EmedfCompletionItem,
  ResourceCapabilityMatrix,
  ToolDescriptor,
  ToolResult,
  ModelThinkingLevel,
  MemoryEntry
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
  FeedbackStatusIpcResult,
  FmgEntryPage,
  MutterNextIpcResult,
  MutterStatusIpcResult,
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
  SessionFeedbackIpcRequest,
  SessionFeedbackIpcResult,
  SubmitAllHistoryIpcResult,
  CiteHit,
  MapEditTransaction,
  UpdateCommandResult,
  UpdateSetChannelRequest,
  UpdateStateEvent,
  UpdatePublicState
} from '@soulforge/shared';
import { AUXILIARY_IPC_CHANNELS, EDITOR_DOCUMENT_IPC_CHANNELS, PARAM_SESSION_IPC_CHANNELS, UPDATE_IPC_CHANNELS } from '@soulforge/shared';
import type {
  OpenParamSessionRequest,
  OpenParamSessionResult,
  ReadParamIndexPageRequest,
  ParamIndexPageResult,
  ReadParamRowsRequest,
  ParamRowPayloadBatchResult
} from '@soulforge/shared';
import type { MapReadCancellationResult } from './publicTypes.js';

export const publicIpcContract = {
  setWindowThemeMode: invoke<NativeWindowThemeResult>()('window.setThemeMode', (mode: NativeWindowThemeMode) => [mode]),
  openEditorDocument: invoke<EditorDocumentResult<OpenEditorDocumentValue>>()(EDITOR_DOCUMENT_IPC_CHANNELS.open, (request: OpenEditorDocumentRequest) => [request]),
  getEditorDocument: invoke<EditorDocumentResult<OpenEditorDocumentValue>>()(EDITOR_DOCUMENT_IPC_CHANNELS.get, (documentHandle: string) => [documentHandle]),
  pageEditorDocument: invoke<EditorDocumentResult<EditorDocumentPageValue>>()(EDITOR_DOCUMENT_IPC_CHANNELS.page, (request: PageEditorDocumentRequest) => [request]),
  readEditorDocumentContent: invoke<EditorDocumentResult<EditorContentValue>>()(EDITOR_DOCUMENT_IPC_CHANNELS.readContent, (request: ReadEditorContentRequest) => [request]),
  applyEditorMutation: invoke<EditorDocumentResult<ApplyEditorMutationValue>>()(EDITOR_DOCUMENT_IPC_CHANNELS.apply, (request: ApplyEditorMutationRequest) => [request]),
  closeEditorDocument: invoke<EditorDocumentResult<{ closed: true }>>()(EDITOR_DOCUMENT_IPC_CHANNELS.close, (documentHandle: string) => [documentHandle]),
  lastWorkspaceSelection: invoke<{
    overlay: DirectorySelection | null;
    base: DirectorySelection | null;
  }>()('workspace.lastSelection', () => []),
  openWorkspaceDialog: invoke<DirectorySelection | null>()('workspace.openDialog', () => []),
  openBaseDialog: invoke<DirectorySelection | null>()('workspace.openBaseDialog', () => []),
  scanWorkspace: invoke<RendererWorkspaceScanResult>()('workspace.scan', (options: OpenWorkspaceScanOptions) => [options]),
  remountBase: invoke<{
    workspaceSessionId: string;
    session: RendererWorkspaceSession;
  }>()('workspace.remountBase', (baseSelectionId: string | null) => [baseSelectionId]),
  detectMe3: invoke<import('@soulforge/core').RuntimeCapability>()('runtime.detectMe3', () => []),
  prepareMe3Profile: invoke<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeProfileRef>>()('runtime.prepareMe3Profile', () => []),
  launchMe3: invoke<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeLaunchSession>>()('runtime.launchMe3', (profileId: string) => [profileId]),
  terminateMe3: invoke<import('@soulforge/core').RuntimeOperationResult<import('@soulforge/core').RuntimeTerminationResult>>()('runtime.terminateMe3', (sessionId: string) => [sessionId]),
  analyzeWorkspace: invoke<AnalyzeWorkspaceSummary>()('workspace.analyze', () => []),
  searchResources: invoke<RendererIndexedFile[]>()('resource.search', (query: string) => [query]),
  openResourcePreview: invoke<RendererResourcePreview | null>()('resource.preview', (sourceUri: string) => [sourceUri]),
  saveTextResource: invoke<RendererSaveResult>()('resource.saveText', (sourceUri: string, newText: string) => [sourceUri, newText]),
  readRawMetadata: invoke<unknown>()('resource.readRawMetadata', (sourceUri: string) => [sourceUri]),
  readRawRange: invoke<unknown>()('resource.readRawRange', (sourceUri: string, offset: number, length: number) => [sourceUri, offset, length]),
  inspectContainerTree: invoke<RendererContainerTreeSummary>()('resource.inspectContainerTree', (sourceUri: string) => [sourceUri], 'stripPathFields'),
  listContainerChildren: invoke<RendererContainerChildrenList>()('resource.listContainerChildren', (sourceUri: string, recursive?: boolean) => [sourceUri, recursive]),
  listContainerChildrenPage: invoke<RendererContainerChildrenPage>()('resource.listContainerChildrenPage', (sourceUri: string, page: number, pageSize: number, recursive?: boolean) => [sourceUri, page, pageSize, recursive], 'stripPathFields'),
  readContainerChild: invoke<RendererContainerChildBytes>()('resource.readContainerChild', (childUri: string) => [childUri]),
  replaceContainerChild: invoke<RendererSaveResult>()('resource.replaceContainerChild', (childUri: string, expectedContainerHash: string, expectedChildHash: string, newContentBase64: string) => [childUri, expectedContainerHash, expectedChildHash, newContentBase64]),
  roundTripContainer: invoke<unknown>()('resource.roundTripContainer', (sourceUri: string) => [sourceUri]),
  validateContainer: invoke<unknown>()('resource.validateContainer', (sourceUri: string) => [sourceUri]),
  probeContainerCapabilities: invoke<ResourceCapabilityMatrix | null>()('resource.probeContainerCapabilities', (sourceUri: string) => [sourceUri]),
  scriptContainerEvidence: invoke<ScriptContainerEvidence>()('resource.scriptContainerEvidence', (sourceUri: string) => [sourceUri], 'stripPathFields'),
  listScriptContainerEntriesPage: invoke<ScriptContainerEntryPage>()('resource.listScriptContainerEntriesPage', (sourceUri: string, page: number, pageSize: number) => [sourceUri, page, pageSize], 'stripPathFields'),
  readScriptEntryPlaintext: invoke<ScriptEntryPlaintextView>()('resource.readScriptEntryPlaintext', (sourceUri: string, entryName: string) => [sourceUri, entryName]),
  readScriptSource: invoke<import('@soulforge/shared').ScriptSourceView>()('resource.readScriptSource', (sourceUri: string, entryName?: string, entryIndex?: number) => [sourceUri, entryName, entryIndex]),
  saveScriptSource: invoke<RendererSaveResult>()('resource.saveScriptSource', (sourceUri: string, entryName: string | undefined, expectedChildHash: string | undefined, expectedContainerHash: string | undefined, sourceText: string, encoding?: string, entryIndex?: number) => [sourceUri, entryName, expectedChildHash, expectedContainerHash, sourceText, encoding, entryIndex]),
  listOperations: invoke<RendererPatchHistoryEntry[]>()('operation.list', () => []),
  rollbackOperation: invoke<RollbackOperationIpcResult>()('operation.rollback', (opId: string) => [opId]),
  rollbackFile: invoke<RollbackOperationIpcResult>()('operation.rollbackFile', (opId: string, targetUri: string) => [opId, targetUri]),
  readEmevdDocument: invoke<unknown>()('resource.readEmevdDocument', (sourceUri: string) => [sourceUri]),
  applyEmevdMutation: invoke<RendererSaveResult>()('resource.applyEmevdMutation', (sourceUri: string, expectedHash: string, mutation: Record<string, unknown>) => [sourceUri, expectedHash, mutation]),
  readEmevdFullDocument: invoke<{
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
    registryOrigin?: 'first-party' | 'imported' | 'fixture';
    registryPackageId?: string | null;
    registryPackageVersion?: string | null;
    registryContentDigest?: string | null;
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
  }>()('resource.readEmevdFullDocument', (sourceUri: string, documentInstanceId: string, loadFullDslTemplate?: boolean) => [sourceUri, documentInstanceId, loadFullDslTemplate === true ? true : undefined]),
  cancelEmevdFullDocument: invoke<{ ok: boolean; cancelled: boolean }>()('resource.cancelEmevdFullDocument', () => []),
  readEmevdSourceSlice: invoke<{
    ok?: boolean;
    cancelled?: boolean;
    code?: string;
    message?: string;
    fromLine?: number;
    lineCount?: number;
    totalLines?: number;
    eof?: boolean;
    sliceText?: string;
  }>()('resource.readEmevdSourceSlice', (token: string, fromLine: number, lineCount: number) => [token, fromLine, lineCount]),
  submitEmevdDslPlan: invoke<RendererSaveResult>()('resource.submitEmevdDslPlan', (sourceUri: string, sourceText: string, mode: 'patch' | 'dark-script' = 'patch') => [sourceUri, sourceText, mode]),
  readEmedfCompletionCatalog: invoke<{
    ok: boolean;
    origin: 'first-party' | 'imported' | 'fixture';
    items: EmedfCompletionItem[];
    enums?: Record<string, import('@soulforge/core').EmedfEnumDef>;
  }>()('resource.readEmedfCompletionCatalog', () => []),
  readFmgDocument: invoke<unknown>()('resource.readFmgDocument', (sourceUri: string) => [sourceUri]),
  readFmgPage: invoke<FmgEntryPage>()('resource.readFmgPage', (sourceUri: string, page: number, pageSize: number, query?: string) => [sourceUri, page, pageSize, query]),
  readTextCatalog: invoke<TextCatalogResponse>()('resource.readTextCatalog', () => []),
  readFmgTablePage: invoke<FmgEntryPage>()('resource.readFmgTablePage', (tableId: string, page: number, pageSize: number, query?: string) => [tableId, page, pageSize, query]),
  applyFmgMutation: invoke<RendererSaveResult>()('resource.applyFmgMutation', (sourceUri: string, expectedHash: string, mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string }, tableId?: string) => [sourceUri, expectedHash, mutation, tableId]),
  readMsbDocument: invoke<unknown>()('resource.readMsbDocument', (sourceUri: string) => [sourceUri]),
  readTaeDocument: invoke<unknown>()('resource.readTaeDocument', (sourceUri: string, options?: { animationPage?: number; animationPageSize?: number }) => [sourceUri, options]),
  readTaeTemplateCatalog: invoke<unknown>()('resource.readTaeTemplateCatalog', () => []),
  readTaeEventParams: invoke<unknown>()('resource.readTaeEventParams', (sourceUri: string, animId: number, eventIndex: number, taeEntryIndex?: number, taeEntryId?: number, taeEntryName?: string, taeGroup?: string) => [sourceUri, animId, eventIndex, taeEntryIndex, taeEntryId, taeEntryName, taeGroup]),
  readTaeChrbndPreview: invoke<unknown>()('resource.readTaeChrbndPreview', (sourceUri: string) => [sourceUri]),
  readTaeAnimationClip: invoke<unknown>()('resource.readTaeAnimationClip', (sourceUri: string, animId: number, flverBoneNames?: string[], flverBoneParents?: number[], flverReferencePose?: Array<{
      translation: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    }>, taeEntryIndex?: number, taeEntryId?: number, taeEntryName?: string, taeGroup?: string) => [sourceUri, animId, flverBoneNames, flverBoneParents, flverReferencePose, taeEntryIndex, taeEntryId, taeEntryName, taeGroup]),
  sampleTaeAnimationPose: invoke<unknown>()('resource.sampleTaeAnimationPose', (sourceUri: string, animId: number, timeSeconds: number, flverBoneNames?: string[], loop?: boolean, flverBoneParents?: number[], flverReferencePose?: Array<{
      translation: [number, number, number];
      rotation: [number, number, number, number];
      scale: [number, number, number];
    }>, taeEntryIndex?: number, taeEntryId?: number, taeEntryName?: string, taeGroup?: string) => [sourceUri, animId, timeSeconds, flverBoneNames, loop, flverBoneParents, flverReferencePose, taeEntryIndex, taeEntryId, taeEntryName, taeGroup]),
  readMapPartMesh: invoke<unknown>()('resource.readMapPartMesh', (msbSourceUri: string, modelName: string) => [msbSourceUri, modelName]),
  readMapStaticGeometry: invoke<unknown>()('resource.readMapStaticGeometry', (msbSourceUri: string, modelName: string, cursor?: string | null, sessionToken?: string | null, requestId?: string) => [msbSourceUri, modelName, cursor ?? null, sessionToken ?? null, requestId ?? null]),
  cancelMapStaticGeometry: invoke<MapReadCancellationResult>()('resource.cancelMapStaticGeometry', (requestId: string) => [requestId]),
  readEsdDocument: invoke<unknown>()('resource.readEsdDocument', (sourceUri: string) => [sourceUri]),
  readMtdDocument: invoke<unknown>()('resource.readMtdDocument', (sourceUri: string) => [sourceUri]),
  readFxrDocument: invoke<unknown>()('resource.readFxrDocument', (sourceUri: string, entryName?: string) => [sourceUri, entryName]),
  listFxrEntries: invoke<unknown>()('resource.listFxrEntries', (sourceUri: string) => [sourceUri]),
  readFlverDocument: invoke<unknown>()('resource.readFlverDocument', (sourceUri: string) => [sourceUri]),
  readTpfDocument: invoke<unknown>()('resource.readTpfDocument', (sourceUri: string) => [sourceUri]),
  readTpfTexturePreview: invoke<unknown>()('resource.readTpfTexturePreview', (sourceUri: string, textureIndex: number) => [sourceUri, textureIndex]),
  saveTpfTextureReplace: invoke<unknown>()('resource.saveTpfTextureReplace', (sourceUri: string, expectedHash: string, textureIndex: number, newTextureBase64: string) => [sourceUri, expectedHash, textureIndex, newTextureBase64]),
  readFlverMesh: invoke<unknown>()('resource.readFlverMesh', (sourceUri: string, meshIndex: number) => [sourceUri, meshIndex]),
  readFlverSkeleton: invoke<unknown>()('resource.readFlverSkeleton', (sourceUri: string) => [sourceUri]),
  readFlverDummies: invoke<unknown>()('resource.readFlverDummies', (sourceUri: string) => [sourceUri]),
  readFlverTextureSlots: invoke<unknown>()('resource.readFlverTextureSlots', (sourceUri: string) => [sourceUri]),
  resolveChrbndPreview: invoke<unknown>()('resource.resolveChrbndPreview', (animSourceUri: string) => [animSourceUri]),
  applyMsbMutation: invoke<RendererSaveResult>()('resource.applyMsbMutation', (sourceUri: string, expectedHash: string, mutation: {
      kind: 'set_part_position' | 'set_part_transform' | 'set_region_position'
        | 'delete_part' | 'delete_region' | 'delete_event';
      family: 'part' | 'region' | 'event';
      nativeOffset: number;
      expectedName?: string;
      posX?: number;
      posY?: number;
      posZ?: number;
      rotX?: number;
      scaleX?: number;
      scaleY?: number;
      scaleZ?: number;
    }) => [sourceUri, expectedHash, mutation]),
  executeMapTransaction: invoke<RendererSaveResult>()('resource.executeMapTransaction', (sourceUri: string, expectedHash: string, transaction: MapEditTransaction) => [sourceUri, expectedHash, transaction]),
  applyFlverMutation: invoke<RendererSaveResult>()('resource.applyFlverMutation', (sourceUri: string, expectedHash: string, mutation: {
      kind: 'material-slot-set';
      meshStableId: string;
      slotIndex: number;
      materialStableId: string;
    }) => [sourceUri, expectedHash, mutation]),
  readParamDocument: invoke<unknown>()('resource.readParamDocument', (sourceUri: string) => [sourceUri]),
  readGparamDocument: invoke<unknown>()('resource.readGparamDocument', (sourceUri: string) => [sourceUri]),
  commitGparamMutations: invoke<RendererSaveResult>()('resource.commitGparamMutations', (sourceUri: string, expectedDocumentHash: string, mutations: Array<{
      groupId: number;
      paramId: number;
      valueIndex: number;
      value: number;
    }>) => [sourceUri, expectedDocumentHash, mutations]),
  commitMtdPropertySet: invoke<RendererSaveResult>()('resource.commitMtdPropertySet', (sourceUri: string, expectedDocumentHash: string, set: { paramId: string; newValue: string }) => [sourceUri, expectedDocumentHash, set]),
  commitEsdTransition: invoke<RendererSaveResult>()('resource.commitEsdTransition', (sourceUri: string, expectedDocumentHash: string, mutations: Array<{
      mutation: string;
      stateRelOffset?: number;
      conditionRelOffset?: number;
      targetStateRelOffset?: number;
    }>) => [sourceUri, expectedDocumentHash, mutations]),
  commitTaeEvent: invoke<RendererSaveResult>()('resource.commitTaeEvent', (sourceUri: string, expectedDocumentHash: string, mutations: Array<{
      mutation: string;
      animId?: number;
      eventIndex?: number;
      templateEventIndex?: number;
      eventTypeId?: number;
      startTime?: number;
      endTime?: number;
      fieldIndex?: number;
      fieldName?: string;
      value?: string | number | boolean;
      schemaBankId?: number;
      taeEntryIndex?: number;
    }>) => [sourceUri, expectedDocumentHash, mutations]),
  commitFxrFieldSet: invoke<RendererSaveResult>()('resource.commitFxrFieldSet', (sourceUri: string, expectedDocumentHash: string, mutations: Array<{
      mutation: string;
      address: {
        container: string;
        hostIndex: number;
        propertyIndex?: number;
        section8Index?: number;
        valueIndex: number;
      };
      value: number;
    }>) => [sourceUri, expectedDocumentHash, mutations]),
  getParamMetadataTrustState: invoke<{
    ok: boolean;
    trusted: boolean;
    packageId: string | null;
    packageVersion: string | null;
    sourceIdentity?: string | null;
    sourceRevision?: string | null;
    licenseSpdxExpression?: string | null;
    confirmedAt?: string;
    diagnostics: Diagnostic[];
  }>()('param.metadata.trustState', () => []),
  setParamMetadataTrust: invoke<{
    ok: boolean;
    trusted?: boolean;
    diagnostics: Diagnostic[];
  }>()('param.metadata.setTrust', (trusted: boolean) => [trusted]),
  readParamPage: invoke<ParamRowPage>()('resource.readParamPage', (sourceUri: string, page: number, pageSize: number, query?: string, loadAll?: boolean) => [sourceUri, page, pageSize, query, loadAll]),
  openParamSession: invoke<OpenParamSessionResult>()(PARAM_SESSION_IPC_CHANNELS.open, (request: OpenParamSessionRequest) => [request]),
  readParamIndexPage: invoke<ParamIndexPageResult>()(PARAM_SESSION_IPC_CHANNELS.readIndexPage, (request: ReadParamIndexPageRequest) => [request]),
  readParamRows: invoke<ParamRowPayloadBatchResult>()(PARAM_SESSION_IPC_CHANNELS.readRows, (request: ReadParamRowsRequest) => [request]),
  listContainerParams: invoke<{
    ok: boolean;
    containerUri: string;
    containerFormat?: string | null;
    params: Array<{ entryIndex: number; name: string; size: number }>;
    diagnostics: Diagnostic[];
  }>()('resource.listContainerParams', (containerUri: string) => [containerUri]),
  readContainerParamPage: invoke<ParamRowPage & {
    containerUri: string;
     entryIndex: number;
     paramName?: string;
     typeName: string | null;
     /** 当前分页复用的 opaque native session token。 */
     sessionToken?: string;
     /** 写回所需：容器与条目的当前哈希，原样回传即可。 */
    containerHash?: string;
    childHash?: string;
    /**
     * P1：随页下发的字段定义/枚举/授信来源。主进程在 resolveTrustedParamDefinition
     * 里完成 first-party 包校验 + 行宽核对；origin 只给白名单值，渲染器不自行判定。
     */
    fieldDefs?: ParamFieldDef[] | null;
    fieldEnums?: Array<{
      id: string;
      name?: string;
      values: Array<{ value: number; label: string }>;
    }> | null;
    fieldDefsDiagnostic?: { code: string; message: string } | null;
    fieldDefsOrigin?: 'first-party' | 'fixture' | 'imported' | 'user-derived' | null;
    fieldDefsTrusted?: boolean;
  }>()('resource.readContainerParamPage', (containerUri: string, entryIndex: number, page: number, pageSize: number, query?: string, loadAll?: boolean, documentSessionToken?: string) => [containerUri, entryIndex, page, pageSize, query, loadAll, documentSessionToken]),
  readContainerParamRowIndex: invoke<{
    ok: boolean;
    paramName: string | null;
    typeName: string | null;
    rowDataSize: number;
    rowCount: number;
    rows: Array<{ rowIndex: number; id: number; name?: string; dataHash: string }>;
    rowsTruncated: boolean;
    containerHash: string;
    childHash: string;
    sessionToken?: string;
    authority?: string;
    diagnostics?: Array<{ severity: string; code: string; message: string }>;
  }>()('resource.readContainerParamRowIndex', (containerUri: string, entryIndex: number) => [containerUri, entryIndex]),
  applyContainerParamFieldMutation: invoke<RendererSaveResult>()('resource.applyContainerParamFieldMutation', (containerUri: string, expectedContainerHash: string, mutation: {
      entryIndex: number;
      expectedChildHash: string;
      rowIndex: number;
      rowId: number;
      expectedDataHash: string;
      expectedRowDataSize?: number;
      fieldId: string;
      value: number | string | boolean;
      rowDataBase64: string;
      definition: unknown;
    }) => [containerUri, expectedContainerHash, mutation]),
  applyContainerParamRowNameMutation: invoke<RendererSaveResult>()('resource.applyContainerParamRowNameMutation', (containerUri: string, expectedContainerHash: string, mutation: {
      entryIndex: number;
      expectedChildHash: string;
      rowIndex: number;
      rowId: number;
      expectedDataHash: string;
      expectedRowDataSize?: number;
      name: string;
      rowDataBase64: string;
    }) => [containerUri, expectedContainerHash, mutation]),
  applyContainerParamRowMutations: invoke<RendererSaveResult>()('resource.applyContainerParamRowMutations', (containerUri: string, expectedContainerHash: string, mutation: {
      kind: 'add' | 'copy' | 'delete';
      entryIndex: number;
      expectedChildHash: string;
      rowId: number;
      rowDataBase64: string;
    }) => [containerUri, expectedContainerHash, mutation]),
  exportParamRowsCsv: invoke<RendererSaveResult>()('param.exportRowsCsv', (containerUri: string, expectedContainerHash: string, entryIndex: number) => [containerUri, expectedContainerHash, entryIndex]),
  exportParamNamesCsv: invoke<RendererSaveResult>()('param.exportNamesCsv', (containerUri: string, expectedContainerHash: string, entryIndex: number) => [containerUri, expectedContainerHash, entryIndex]),
  importParamNamesCsv: invoke<RendererSaveResult>()('param.importNamesCsv', (containerUri: string, expectedContainerHash: string, entryIndex: number, expectedChildHash: string) => [containerUri, expectedContainerHash, entryIndex, expectedChildHash]),
  importParamRowsCsv: invoke<RendererSaveResult>()('param.importRowsCsv', (containerUri: string, expectedContainerHash: string, entryIndex: number, expectedChildHash: string) => [containerUri, expectedContainerHash, entryIndex, expectedChildHash]),
  applyParamMutation: invoke<RendererSaveResult>()('resource.applyParamMutation', (sourceUri: string, expectedHash: string, mutation: {
      kind: 'upsert' | 'delete';
      id: number;
      dataBase64?: string;
      rowIndex?: number;
      expectedDataHash?: string;
    }) => [sourceUri, expectedHash, mutation]),
  applyParamFieldMutation: invoke<RendererSaveResult>()('resource.applyParamFieldMutation', (sourceUri: string, expectedHash: string, mutation: {
      rowId: number;
      rowIndex?: number;
      expectedDataHash?: string;
      fieldId: string;
      value: number | string | boolean;
      rowDataBase64: string;
      definition: unknown;
    }) => [sourceUri, expectedHash, mutation]),
  listAiTools: invoke<ToolDescriptor[]>()('ai.tools', () => []),
  buildAiSidebarDraft: invoke<AiSidebarDraft>()('ai.sidebarDraft', (request: AiSidebarDraftRequest) => [request]),
  runAiTool: invoke<ToolResult>()('ai.runTool', (name: string, input: unknown) => [name, input]),
  getMutterNext: invoke<MutterNextIpcResult>()(AUXILIARY_IPC_CHANNELS.mutterNext, () => []),
  getMutterStatus: invoke<MutterStatusIpcResult>()(AUXILIARY_IPC_CHANNELS.mutterStatus, () => []),
  getFeedbackStatus: invoke<FeedbackStatusIpcResult>()(AUXILIARY_IPC_CHANNELS.feedbackStatus, () => []),
  submitSessionFeedback: invoke<SessionFeedbackIpcResult>()(AUXILIARY_IPC_CHANNELS.feedbackSubmitSession, (input: SessionFeedbackIpcRequest) => [input]),
  submitAllHistory: invoke<SubmitAllHistoryIpcResult>()(AUXILIARY_IPC_CHANNELS.feedbackSubmitAll, () => []),
  listModelServices: invoke<Array<{
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
  }>>()('modelService.list', () => []),
  getProviderUsageSummary: invoke<{
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
  }>()('modelService.usageSummary', () => []),
  modelServiceEncryptionAvailable: invoke<boolean>()('modelService.encryptionAvailable', () => []),
  upsertModelService: invoke<{
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
  }>()('modelService.upsert', (input: {
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
  }) => [input]),
  deleteModelService: invoke<{ ok: true }>()('modelService.delete', (configId: string) => [configId]),
  embedWorkspaceRag: invoke<| { ok: true; embedded: number; reused: number; failed: number; model: string; dim: number }
    | { ok: false; error: { code: string; message: string } }>()('rag.embed', () => []),
  getRagLocalModelStatus: invoke<import('@soulforge/shared').RagLocalModelStatus>()('rag.localModelStatus', () => []),
  searchWorkspaceEvidence: invoke<RagRetrieveResult>()('rag.searchEvidence', (input: {
    query: string;
    limit?: number;
    families?: string[];
    expandReferences?: boolean;
  }) => [input]),
  listModelModels: invoke<| { ok: true; models: Array<{ id: string; displayName?: string }> }
    | { ok: false; error: { code: string; message: string } }>()('modelService.listModels', (input: {
    protocol: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';
    baseUrl: string;
    apiKey?: string;
  }) => [input]),
  runAiAgent: invoke<AiAgentRunIpcResult>()('ai.agent.run', (request: AiAgentRunRequest) => [request]),
  requestAiAgentPermission: invoke<AiAgentPermissionRequestResult>()('ai.agent.permission.request', (mode: 'plan' | 'normal' | 'fullPermission') => [mode]),
  getAiAgentEvents: invoke<AiAgentEventReplayIpcResult>()('ai.agent.events', (sessionId: string, afterSeq = 0) => [sessionId, afterSeq]),
  cancelAiAgent: invoke<AiAgentCancelIpcResult>()('ai.agent.cancel', (sessionId: string) => [sessionId]),
  respondAiAgentApproval: invoke<{ ok: true; matched: boolean } | { ok: false; error: { code: string; message: string } }>()('ai.agent.approval.respond', (request: AiAgentApprovalResponseRequest) => [request]),
  listAiAgentSessions: invoke<AiAgentSessionListIpcResult>()('ai.agent.sessions', () => []),
  loadAiAgentSession: invoke<AiAgentSessionLoadIpcResult>()('ai.agent.session.load', (sessionPath: string) => [sessionPath]),
  createAgentResourceReference: invoke<AgentResourceReferenceCreateIpcResult>()('agent.resourceReference.create', (selection: EditorSelectionContext) => [{ selection }]),
  createAgentCitation: invoke<AgentResourceReferenceCreateIpcResult>()('agent.citation.create', (hits: readonly CiteHit[]) => [{ hits }]),
  createAgentAttachment: invoke<AgentAttachmentCreateIpcResult>()('agent.attachment.create', () => []),
  listAiMemories: invoke<{ ok: true; entries: MemoryEntry[] } | { ok: false; error: { code: string; message: string } }>()('ai.memory.list', () => []),
  saveAiMemory: invoke<{ ok: true; entry: MemoryEntry } | { ok: false; error: { code: string; message: string } }>()('ai.memory.save', (entry: { id?: string; topic: string; summary: string; details?: string; tags?: string[] }) => [entry]),
  deleteAiMemory: invoke<{ ok: true; deleted: boolean } | { ok: false; error: { code: string; message: string } }>()('ai.memory.delete', (idOrTopic: string) => [idOrTopic]),
  getUpdateState: invoke<UpdatePublicState>()(UPDATE_IPC_CHANNELS.getState, () => []),
  setUpdateChannel: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.setChannel, (request: UpdateSetChannelRequest) => [request]),
  checkForUpdate: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.check, () => []),
  downloadUpdate: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.download, () => []),
  cancelUpdate: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.cancel, () => []),
  installUpdate: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.install, () => []),
  openUpdateRelease: invoke<UpdateCommandResult>()(UPDATE_IPC_CHANNELS.openRelease, () => []),
  onUpdateState: subscribe<UpdateStateEvent, UpdatePublicState>(UPDATE_IPC_CHANNELS.event, (envelope) => envelope.state, 'transport'),
  onAiAgentEvent: subscribe<AiAgentEventEnvelope, AiAgentEventEnvelope>('ai:agent:event', (envelope) => envelope)
} as const;
