import { resolveCharacterFlverResource } from './services/characterPreviewService.js';
import type {
  AnalyzeWorkspaceSummary,
  RendererWorkspaceSession,
  WorkspaceIndexingStatus,
  RendererWorkspaceScanResult,
  RollbackOperationIpcResult,
  AiAgentRunRequest,
  AiAgentApprovalResponseRequest,
  AiAgentRunIpcResult,
  AiAgentPermissionRequestResult,
  AiAgentCancelIpcResult,
  AiAgentSessionSummaryIpc,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AiAgentSessionLifecycleEvent,
  AiAgentEventEnvelope,
  AiAgentEventReplayIpcResult,
  AgentResourceReferenceCreateIpcResult,
  AgentAttachmentCreateIpcResult,
  DirectorySelection,
  OpenWorkspaceScanOptions
} from '../ipc/publicTypes.js';
export type {
  AnalyzeWorkspaceSummary,
  RendererWorkspaceSession,
  WorkspaceIndexingStatus,
  RendererWorkspaceScanResult,
  RollbackOperationIpcResult,
  AiAgentRunRequest,
  AiAgentApprovalResponseRequest,
  AiAgentRunIpcResult,
  AiAgentPermissionRequestResult,
  AiAgentCancelIpcResult,
  AiAgentSessionSummaryIpc,
  AiAgentSessionListIpcResult,
  AiAgentSessionLoadIpcResult,
  AiAgentSessionLifecycleEvent,
  AiAgentEventEnvelope,
  AiAgentEventReplayIpcResult,
  AgentResourceReferenceCreateIpcResult,
  AgentAttachmentCreateIpcResult,
  DirectorySelection,
  OpenWorkspaceScanOptions
} from '../ipc/publicTypes.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TrustedIpcHandle } from './ipc/registration.js';
import { registerWindowThemeIpcHandlers } from './ipc/windowTheme.js';
import type { KnowledgeRefreshOwner } from './knowledgeRefreshOwnership.js';
import { createSessionCommitPort } from './services/sessionCommitService.js';
import { registerAgentIpcHandlers, hasActiveAgentRuns, isAgentSessionActive, scheduleInternalRagEmbedding } from './ipc/agent.js';
import { registerResourceIpcHandlers } from './ipc/resource.js';
import { resolveWorkspaceStoragePaths, type WorkspaceStoragePaths } from './workspaceStorage.js';
import { createWorkspaceUtilityLifecycleService } from './services/workspaceUtilityLifecycleService.js';
import { createSemanticRefreshService } from './services/semanticRefreshService.js';
import {
  buildAiSidebarDraft,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  isAllowedEndpoint,
  OpenAiCompatibleAdapter,
  AnthropicCompatibleAdapter,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  createContextBroker,
  createUnifiedDiff,
  listRolloutSessions,
  loadRolloutSession,
  runAgentSession,
  disposeBridgeDaemonPool,
  buildScriptContainerEvidence,
  analyzePlaintextLineEndings,
  classifyPlaintextBytes,
  decodePlaintext,
  encodePlaintext,
  encodeScriptSourceForWriteback,
  classifyScriptEntry,
  magicLabel,
  normalizePageWindow,
  sanitizeEntryName,
  applyParamFieldMutation,
  decodeRowFields,
  encodeFieldMutation,
  toCsvText,
  parseCsvText,
  commitFmgMutationViaBridge,
  commitFlverMutationViaBridge,
  commitGparamMutationsViaBridge,
  commitMtdPropertySetViaBridge,
  commitEsdTransitionViaBridge,
  type EsdTransitionMutation,
  commitTaeEventViaBridge,
  type TaeEventUpsertMutation,
  commitVfxFieldSetViaBridge,
  type VfxFieldSetMutation,
  commitTpfTextureReplaceViaBridge,
  type GparamFieldSetMutation,
  commitParamMutationViaBridge,
  commitMsbMutationViaBridge,
  type MsbBridgeMutation,
  executeMapTransaction,
  loadMapDocument,
  nativeEditSessionFromContext,
  readFmgDocumentViaBridge,
  readParamDocumentViaBridge,
  readMsbDocumentViaBridge,
  isParamBackupPath,
  openResourcePreview,
  openWorkspaceSession,
  inspectContainerTree,
  listContainerChildren,
  Me3RuntimeAdapter,
  probeContainerCapabilityOptions,
  readContainerChild,
  readRawResourceMetadata,
  readRawResourceRange,
  replaceContainerChild,
  resolveResourceCapabilities,
  rollbackFile,
  rollbackOperation,
  roundTripContainer,
  runBridge,
  saveTextResource,
  type KnowledgeRefreshResult,
  stageBridgeOutput,
  applyNativeMutation,
  validateContainer,
  buildNativeDocumentLocator,
  EditorDocumentStore,
  type EditorDocumentDataSource,
  type EditorMutationApplyPort,
  type NativeDocumentLocator,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WriteConfirmationPort,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type ResourceCapabilityMatrix,
  type RagCorpus,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  WorkspaceIndex,
  type WorkspaceSession,
  type ScriptContainerEntryEvidence,
  type ScriptEntryClassification,
  ingestBridgeResult,
  saveFingerprintStore,
  bumpPathSourceGeneration,
  mapExportFromMsbDocument
} from '@soulforge/core';
import {
  CONTAINER_PAGE_SIZE,
  FMG_PAGE_SIZE,
  PARAM_PAGE_SIZE,
  SCRIPT_PAGE_SIZE,
  EDITOR_DOCUMENT_IPC_CHANNELS,
  agentReferenceExpiresAt,
  agentSelectionSummary,
  decodeDecideAgentApprovalRequest,
  decodeEditorSelectionContext,
  decodeOpenEditorDocumentRequest,
  decodePageEditorDocumentRequest,
  decodeReadEditorContentRequest,
  decodeApplyEditorMutationRequest,
  mintAgentReferenceToken,
  selectionRendererSafetyIssues,
  validateAgentReferenceScope,
  type AgentResourceReference,
  type DecideAgentApprovalRequest,
  type EditorSelectionContext,
  type FmgEntryPage,
  logicalFmgTableName,
  type ScriptEntryPlaintextView,
  type ScriptSourceView,
  decodeCiteHits,
  formatCitationLabel,
  mergeCiteHits,
  type Citation,
  type MapEditTransaction
} from '@soulforge/shared';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from './bridgeRoots.js';
import type {
  ApplyEditorMutationValue,
  BridgeDocumentLocatorValue,
  ConfirmationReceipt,
  Diagnostic,
  EditorContentValue,
  EditorDocumentErrorCode,
  EditorDocumentPageValue,
  EditorDocumentResult,
  EditorPageQuery,
  EditorContentQuery,
  EditorMutation,
  OpenEditorDocumentValue,
  EmevdEditorDocument,
  IndexedFile,
  GparamDocument,
  ReadOperationId,
  RagChunkFamily,
  RagRetrieveResult,
  ResourceKind,
  SaveTextResourceResult,
  StructuredDiagnostic
} from '@soulforge/shared';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalDiff,
  ChatMessage,
  ModelListResult,
  ResumedRollout,
  RolloutSessionMeta
} from '@soulforge/core';
import {
  sanitizeDiagnostics,
  sanitizeRendererValue,
  toRendererEditorDocumentResult,
  toRendererHistoryEntry,
  toRendererIndexedFile,
  toRendererResourcePreview,
  toRendererSaveResult,
  type RendererIndexedFile,
  type RendererPatchHistoryEntry,
  type RendererResourcePreview,
  type RendererResourceLabelSource,
  type RendererSaveResult
} from './rendererDto.js';
import { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import { clearRecentPath, readRecentPath, writeRecentPath } from './recentPaths.js';
import { ModelServiceCredentialVault } from './modelServiceCredentials.js';
import { MainMe3RuntimeGateway } from './me3RuntimeGateway.js';
import { MemoryManager } from './memoryManager.js';
import {
  registerWorkspaceIpcHandlers,
  clearWorkspaceIpcCaches,
  getWorkspaceSession,
  getWorkspaceIndexedFiles,
  getWorkspaceActiveIndex,
  getActiveWorkspaceSessionIdState,
  getActiveWorkspaceSessionGenerationState,
  getWorkspaceRag,
  getWorkspaceRagSnapshotState,
  getWorkspaceIndexedFilesRevisionState,
  getWorkspaceRuntimeIdentityState,
  replaceWorkspaceIndexedFileState,
  getWorkspaceFingerprintStore,
  applyWorkspaceIndexSnapshot,
  applyWorkspaceRag,
  setWorkspaceForegroundActive,
  revokeDirectorySelectionsFor,
  ensureActionBinderMembershipForFamily,
  waitForWorkspaceIndexing
} from './ipc/workspace.js';
import { clearParamIpcCaches, registerParamIpcHandlers } from './ipc/param.js';
import { registerDocumentIpcHandlers, resetEditorDocumentStore } from './ipc/documents.js';
import { hasActiveRollbackRequests, registerOperationIpcHandlers } from './ipc/operations.js';
import { registerModelServiceIpcHandlers } from './ipc/modelServices.js';
import { registerRawIpcHandlers, clearRawIpcCaches } from './ipc/raw.js';
import { registerTextIpcHandlers, clearTextIpcCaches } from './ipc/text.js';
import { registerMapIpcHandlers } from './ipc/map.js';
import { registerActionIpcHandlers } from './ipc/action.js';
import { registerAssetIpcHandlers } from './ipc/assets.js';
import { registerEventIpcHandlers, clearEmevdIpcCaches, disposeEmevdWindow } from './ipc/event.js';
import { clearAgentIpcState } from './ipc/agent.js';
import { registerUpdateIpcHandlers } from './update/updateIpc.js';

/** 只读存在性检查（chrbnd 伴生查找用；不抛异常）。 */
function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
async function withForegroundPriority<T>(fn: () => Promise<T>): Promise<T> {
  setWorkspaceForegroundActive(true);
  try { return await fn(); } finally { setWorkspaceForegroundActive(false); }
}
function bumpPathSourceGenerationForUris(uris: readonly string[]): void {
  const fingerprintStore = getWorkspaceFingerprintStore();
  if (!fingerprintStore) return;
  const indexedFiles = getWorkspaceIndexedFiles();
  for (const uri of uris) {
    const rel = uri.startsWith('file://') ? decodeURI(uri.slice('file://'.length)) : uri;
    const file = indexedFiles.find(f => f.sourceUri === uri || f.relativePath === uri || f.absolutePath === uri);
    const rp = file?.relativePath ?? rel.replaceAll('\\','/').replace(/^\/+/,'');
    if (!rp) continue;
    bumpPathSourceGeneration(fingerprintStore, rp);
    fingerprintStore.hashes.delete(rp);
  }
  const session = getWorkspaceSession();
  if (session) {
    const root = durableStoragePaths(session.meta.workspaceId).root;
    void saveFingerprintStore({ storageRoot: root, state: fingerprintStore }).catch(()=>{});
  }
}
/** Provider configs may omit contextWindowTokens; keep compaction fail-safe by default. */
const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 500_000;
const AGENT_CONTEXT_COMPACTION_RATIO = 0.8;
/** 当前 overlay 的显示 label：remountBase 重建 session 时沿用（scan 时登记）。 */
// EMEVD authoritative caches and open-slot state moved to ipc/event.ts (domain-owned).

// Paginated editor caches moved to domain modules: text (fmgPageCache/textTableRefs/fmgTableCache),
// raw (containerChildrenCache/scriptContainerEntriesCache). See ipc/text.ts and ipc/raw.ts.

// Container/script helpers moved to ipc/raw.ts (domain-owned). See that module for enumeration and BND4 helpers.

function releaseWorkspaceEditorCaches(): void {
  // Composition of domain-owned cache resets — composition root does not touch domain private maps directly.
  clearParamIpcCaches();
  clearTextIpcCaches();
  clearRawIpcCaches();
  clearEmevdIpcCaches();
  resetEditorDocumentStore();
}

const resolveFlverReadFile = (sourceUri: string) => resolveCharacterFlverResource({
  getActiveSession: getWorkspaceSession, getIndexedFiles: getWorkspaceIndexedFiles, exists: existsSync
}, sourceUri);

// EMEDF registry cache moved to ipc/event.ts (domain-owned).
let handlersRegistered = false;
const trustedRendererDocuments = new Map<number, string>();

/**
 * S29：写时对文件内容现算 sha256（小写 hex，与 C# SourceHash/Hash 同算法）。
 *
 * 哈希是并发保护凭据而不是写入门禁：渲染器拿到的 containerHash/childHash
 * 偶发为空（索引没扫到 sha256、Bridge 没报 contentHash）时，不再拒绝写入，
 * 直接在 main 侧现算。缺哈希时并发保护退化为「写前读到的就是写时文件」，
 * 但 Patch Engine 的 HASH_MISMATCH 备份/回滚照旧兜底。
 */
async function sha256FileNow(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}
const here = dirname(fileURLToPath(import.meta.url));
const sqliteNativeBindingPath = app.isPackaged
  ? join(process.resourcesPath, 'native', 'better_sqlite3.node')
  : resolve(here, '../../.native/better_sqlite3.node');
const operationLogUtility = new OperationLogUtilityClient(
  join(here, 'databaseUtility.js'),
  15_000,
  sqliteNativeBindingPath
);
const utilityLifecycle = createWorkspaceUtilityLifecycleService({
  operationLogUtility,
  getActiveSession: getWorkspaceSession,
  workspaceStoragePaths,
  getUserDataPath: () => app.getPath('userData'),
  reportRecoveryCleanupRejections: items => process.stderr.write(`[SoulForge recovery cleanup] ${JSON.stringify(items)}\n`),
  reportKnowledgeSnapshotUnavailable: message => console.warn(`[SoulForge knowledge] utility snapshot unavailable: ${message}`)
});
const semanticRefresh = createSemanticRefreshService({
  getWorkspaceSession,
  getActiveWorkspaceSessionIdState,
  getActiveWorkspaceSessionGenerationState,
  getWorkspaceIndexedFilesRevisionState,
  getWorkspaceActiveIndex,
  getWorkspaceRag,
  applyWorkspaceIndexSnapshot,
  applyWorkspaceRag,
  getActiveOperationLog: () => utilityLifecycle.activeOperationLog,
  ensureActiveOperationLog,
  durableStoragePaths,
  hasActiveAgentRuns,
  scheduleInternalRagEmbedding
});
const { refreshActiveIndexAfterSemanticEvidence, refreshActiveIndexAfterNativeWrite } = semanticRefresh;
const modelServiceVault = new ModelServiceCredentialVault(app.getPath('userData'));
const memoryManager = new MemoryManager(app.getPath('userData'));

const toolRegistry = createDefaultToolRegistry();
// P0 authority: renderer cannot elevate this value. Persistent per-model-service
// grants replace this constant in P6; until then the desktop is plan-only.
const activeAiMode: ToolContext['mode'] = 'plan';

/**
 * 读装配进 Agent loop 的系统提示（prompt/system.md，仓库内自己的提示词）。
 *
 * T6 要求 main/core 读入装配、renderer 不拼。候选顺序：
 *  1. SOULFORGE_SYSTEM_PROMPT_PATH（显式覆盖）
 *  2. 打包 extraResources：process.resourcesPath/prompt/system.md
 *  3. dev 仓库根：app.getAppPath()（dev = apps/desktop）上两级 → repo/prompt/system.md
 * 读不到返回 null：loop 照常运行，只是没有系统提示（不硬失败）。
 */
function readSystemPrompt(): string | null {
  const candidates = [
    process.env.SOULFORGE_SYSTEM_PROMPT_PATH,
    join(process.resourcesPath, 'prompt', 'system.md'),
    resolve(app.getAppPath(), '..', '..', 'prompt', 'system.md')
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try next candidate
    }
  }
  return null;
}

function ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient> {
  return utilityLifecycle.ensureActiveOperationLog(session);
}

function currentToolContext(): ToolContext {
  const session = getWorkspaceSession();
  const index = getWorkspaceActiveIndex();
  const ragSnapshot = getWorkspaceRagSnapshotState();
  const workspaceSessionId = getActiveWorkspaceSessionIdState();
  const workspaceSessionGeneration = getActiveWorkspaceSessionGenerationState();
  const indexedFilesRevision = getWorkspaceIndexedFilesRevisionState();
  const nativeVersionEpoch = index?.getNativeVersionEpoch();
  const storage = session ? durableStoragePaths(session.meta.workspaceId) : undefined;
  const memoryStore = memoryManager.getStore(index?.workspaceId);
  const knowledgeStore = session && utilityLifecycle.activeKnowledgeWorkspaceId === session.meta.workspaceId
    ? utilityLifecycle.activeKnowledgeStore
    : null;
  return {
    workspaceIndex: index,
    mode: activeAiMode,
    memoryStore,
    ...(workspaceSessionId ? {
      workspaceSessionId,
      workspaceSessionGeneration,
      indexedFilesRevision
    } : {}),
    ...(ragSnapshot.corpus ? {
      rag: ragSnapshot.corpus,
      ragEpoch: ragSnapshot.epoch,
      ...(ragSnapshot.scope ? { ragScope: ragSnapshot.scope } : {}),
      ...(ragSnapshot.sessionId ? { ragSessionId: ragSnapshot.sessionId } : {}),
      ragGeneration: ragSnapshot.generation,
      ragIndexedFilesRevision: ragSnapshot.indexedFilesRevision
    } : {}),
    ...(session ? { session } : {}),
    ...(utilityLifecycle.activeOperationLog ? { operationLogStore: utilityLifecycle.activeOperationLog } : {}),
    ...(storage ? { backupBaseDir: storage.backupBaseDir, recoveryDir: storage.recoveryDir } : {}),
    ...(knowledgeStore ? { knowledgeStore } : {}),
    ...(utilityLifecycle.activeKnowledgeStoreError ? { knowledgeStoreDiagnostic: utilityLifecycle.activeKnowledgeStoreError } : {}),
    onSemanticEvidenceUpdated: refreshActiveIndexAfterSemanticEvidence,
    onNativeWriteCommitted: refreshActiveIndexAfterNativeWrite,
    isWorkspaceContextCurrent: () => {
      const currentRagSnapshot = getWorkspaceRagSnapshotState();
      const currentIndex = getWorkspaceActiveIndex();
      return getWorkspaceSession() === session
        && currentIndex === index
        && currentIndex?.getNativeVersionEpoch() === nativeVersionEpoch
        && getActiveWorkspaceSessionIdState() === workspaceSessionId
        && getActiveWorkspaceSessionGenerationState() === workspaceSessionGeneration
        && getWorkspaceIndexedFilesRevisionState() === indexedFilesRevision
        && currentRagSnapshot.corpus === ragSnapshot.corpus
        && currentRagSnapshot.epoch === ragSnapshot.epoch
        && currentRagSnapshot.scope === ragSnapshot.scope
        && currentRagSnapshot.sessionId === ragSnapshot.sessionId
        && currentRagSnapshot.generation === ragSnapshot.generation
        && currentRagSnapshot.indexedFilesRevision === ragSnapshot.indexedFilesRevision;
    }
  };
}

function workspaceStoragePaths(workspaceId: string, workspaceRoot?: string): WorkspaceStoragePaths {
  const session = getWorkspaceSession();
  const resolvedRoot = workspaceRoot
    ?? ((session && session.meta.workspaceId === workspaceId) ? session.layers.overlayRoot : undefined);
  return resolveWorkspaceStoragePaths(workspaceId, resolvedRoot);
}

function durableStoragePaths(workspaceId: string, workspaceRoot?: string): WorkspaceStoragePaths {
  return workspaceStoragePaths(workspaceId, workspaceRoot);
}

/**
 * ROOT-07（front-end.md §13.2）：Bridge 调用的 allowed-root 生命周期入口。
 * 所有 Bridge production handler 复用；不得再向 Bridge 传递未经验证的路径。
 */
function bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession {
  return {
    overlayRoot: session.layers.overlayRoot,
    baseRoot: session.layers.baseRoot ?? null,
    storageRoot: storage.root
  };
}

/**
 * §13.3：Bridge 拒绝「Every allowed root must be an existing directory.」时，
 * 转换为可行动 Problems（操作提示），不得把原始技术消息当唯一输出。
 */
function bridgeRootsDiagnostic(code: string, result: Extract<PrepareBridgeRootsResult, { ok: false }>): Diagnostic {
  return {
    severity: 'error',
    code,
    message: `${result.message}。操作：重试 / 打开诊断 / 检查工作区存储权限。`,
    ...(result.details !== undefined ? { details: result.details } : {})
  };
}

/**
 * ROOT-07：只读调用入口。返回已验证存在的 overlay/base roots；无 session 时
 * 退回调用方 fallback（只读枚举的真实路径），不附加 staging、不创建目录。
 */
async function verifiedReadRoots(
  session: WorkspaceSession | null,
  fallback: string
): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }> {
  if (!session) return { allowedRoots: [fallback], diagnostics: [] };
  const roots = await prepareBridgeRoots(
    bridgeRootSession(session, durableStoragePaths(session.meta.workspaceId)),
    'read'
  );
  if (!roots.ok) return { allowedRoots: [], diagnostics: [bridgeRootsDiagnostic('BRIDGE_ROOT_MISSING', roots)] };
  return { allowedRoots: [...roots.allowedRoots], diagnostics: [] };
}

// Text catalog helpers moved to ipc/text.ts (domain-owned).
export type {
  TextCatalogResponse
} from '../ipc/publicTypes.js';

/**
 * ROOT-07：staging 调用入口。mkdir → realpath → boundary check 后返回
 * allowed/writable roots；失败返回 §13.3 可行动结构化诊断。
 */
async function verifiedStageRoots(
  session: WorkspaceSession,
  storage: { root: string },
  code: string
): Promise<{ allowedRoots: string[]; writableRoots: string[]; diagnostics: Diagnostic[] }> {
  const roots = await prepareBridgeRoots(bridgeRootSession(session, storage), 'stage');
  if (!roots.ok) {
    return { allowedRoots: [], writableRoots: [], diagnostics: [bridgeRootsDiagnostic(code, roots)] };
  }
  return { allowedRoots: [...roots.allowedRoots], writableRoots: [...roots.writableRoots], diagnostics: [] };
}

function normalizeGameIdentity(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function isSekiroGameIdentity(value: unknown): boolean {
  const normalized = normalizeGameIdentity(value);
  return normalized === 'sekiro'
    || normalized === 'sdt'
    || normalized === 'sekiro-shadows-die-twice';
}

function rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null {
  const sessionGame = getWorkspaceSession()?.meta.game;
  const fileGame = file?.game;
  // The light workspace scan can briefly carry `unknown`/empty metadata while
  // the active session is already the Sekiro adapter. The file has still been
  // resolved from the active index by each writer, so do not reject that normal
  // indexing window; explicit evidence of another game remains blocked.
  const fileGameIsUnresolved = normalizeGameIdentity(fileGame) === ''
    || normalizeGameIdentity(fileGame) === 'unknown';
  if (isSekiroGameIdentity(sessionGame)
    && (isSekiroGameIdentity(fileGame) || fileGameIsUnresolved)) return null;
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{
      severity: 'error',
      code: 'NATIVE_WRITE_GAME_UNSUPPORTED',
      message: '当前工作区不是 Sekiro 游戏适配包，已阻断原生语义写入。',
      sourceUri
    }]
  };
}

export async function disposeOperationLogUtility(): Promise<void> {
  await utilityLifecycle.dispose();
}

function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    const result = await listener(event, ...(args as Args));
    return sanitizeRendererValue(result);
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  const expectedDocument = trustedRendererDocuments.get(event.sender.id);
  const frame = event.senderFrame;
  const actualDocument = frame ? normalizeRendererDocumentUrl(frame.url) : null;
  if (!expectedDocument
    || !frame
    || frame !== event.sender.mainFrame
    || actualDocument !== expectedDocument) {
    throw new Error(`已拒绝不受信任的 IPC 调用：${channel}`);
  }
}

function normalizeRendererDocumentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.href;
  } catch {
    return null;
  }
}

async function requestWriteConfirmation(input: {
  /**
   * 弹对话框的宿主窗口。UI 通道（IPC handler）有 sender；AI 工具执行路径没有
   * IPC event（executeTool 由 runAgentSession 内部调用），缺省时用无父窗口的
   * dialog.showMessageBox —— 确认语义一致，只是不模态于某个窗口。
   */
  event?: IpcMainInvokeEvent;
  resourceLabel: string;
  sourceUri: string;
  actionLabel: string;
  payloadHash: string;
  extraSubjects?: string[];
}): Promise<ConfirmationReceipt | null> {
  const workspaceSessionId = getActiveWorkspaceSessionIdState();
  if (!workspaceSessionId) return null;
  // 日常 PARAM/FMG/GPARAM/脚本写入不再弹系统确认框；备份与回滚仍在 Patch Engine。
  return createConfirmationReceipt({
    subjects: [
      'MAIN_NATIVE_DIALOG_CONFIRMED',
      input.sourceUri,
      'ALL_RISKS',
      `WORKSPACE_SESSION:${workspaceSessionId}`,
      `PATCH_HASH:${input.payloadHash}`,
      `NONCE:${randomUUID()}`,
      ...(input.extraSubjects ?? [])
    ],
    riskLevel: 'high',
    sourceUri: input.sourceUri,
    note: '由 Electron main 原生确认对话框签发的一次写入确认'
  });
}

function cancelledWrite(sourceUri: string): RendererSaveResult {
  return {
    ok: false,
    changedFiles: [],
    requiresConfirmation: true,
    diagnostics: [{
      severity: 'warning',
      code: 'WRITE_CONFIRMATION_CANCELLED',
      message: '用户取消了高风险写入。',
      sourceUri
    }]
  };
}

/**
 * 把 Electron 原生确认对话框适配成 core 的 WriteConfirmationPort。
 *
 * core 不能依赖 electron（否则 core 单元测试要跑在 Electron 里），所以确认在
 * core 侧是能力而非实现，这里是它唯一的生产实现。
 */
function electronConfirmationPort(event: IpcMainInvokeEvent): WriteConfirmationPort {
  return {
    requestConfirmation: (input) => requestWriteConfirmation({ event, ...input })
  };
}

/**
 * 把 Patch Engine 的 saveRawReplace 适配成 core 的 RawReplaceCommitPort，
 * 绑定当前会话的持久化路径与操作日志。
 *
 * 会话与操作日志在这里绑定而不是由 core 传入，是因为它们是主进程生命周期
 * 状态；core 只需要「提交这段字节」的能力。所有 Mod 资源写入仍然只经由
 * saveRawReplace → PatchIR → WorkspaceTransaction，本适配器不绕过任何环节。
 */
function sessionCommitPort(
  session: WorkspaceSession,
  operationLog: OperationLogUtilityClient,
  storage: { backupBaseDir: string; recoveryDir: string },
  // Domain handlers that must invalidate their own preview/page caches first
  // explicitly take ownership of the one post-commit knowledge refresh.
  options: { knowledgeRefreshOwner?: KnowledgeRefreshOwner } = {}
): RawReplaceCommitPort {
  return createSessionCommitPort({
    getActiveSession: getWorkspaceSession,
    getActiveWorkspaceSessionId: getActiveWorkspaceSessionIdState,
    getActiveWorkspaceSessionGeneration: getActiveWorkspaceSessionGenerationState,
    refreshActiveIndexAfterNativeWrite
  }, session, operationLog, storage, options);
}

/**
 * 把 core 写链结果转成 renderer DTO。取消是正常结果，不能报成故障。
 */
function toSaveResultFromOutcome(
  outcome: NativeMutationOutcome,
  files: readonly RendererResourceLabelSource[]
): RendererSaveResult {
  if (outcome.status === 'cancelled') return cancelledWrite(outcome.sourceUri);
  if (outcome.status === 'failed') {
    return { ok: false, changedFiles: [], diagnostics: outcome.diagnostics };
  }
  return toRendererSaveResult(outcome.result, files);
}

export function registerIpcHandlers(webContents: WebContents, rendererDocumentUrl: string): void {
  const normalizedDocument = normalizeRendererDocumentUrl(rendererDocumentUrl);
  if (!normalizedDocument) {
    throw new Error('IPC_TRUSTED_RENDERER_URL_INVALID');
  }
  trustedRendererDocuments.set(webContents.id, normalizedDocument);
  webContents.once('destroyed', () => {
    trustedRendererDocuments.delete(webContents.id);
    revokeDirectorySelectionsFor(webContents.id);
    disposeEmevdWindow(webContents.id);
    // 窗口销毁 = 用户强制中断：取消该窗口发起的 agent 运行，并把它的挂起
    // 审批按拒绝结算（无人回答 ≠ 同意执行写入）。其他窗口的运行不受影响。
    // agent runs teardown handled in ipc/agent.ts via bound webContents
  });
  const trustedHandle: TrustedIpcHandle = handle;
  // Update handlers are also called when a later window is created: the
  // service remains singleton, while its event target follows the foreground
  // trusted renderer.
  registerUpdateIpcHandlers({
    handle: trustedHandle,
    webContents,
    userDataPath: app.getPath('userData'),
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    hasActiveAgentRuns,
    hasActiveRollbacks: hasActiveRollbackRequests,
    hasActiveTransactions: async () => {
      if (!utilityLifecycle.activeOperationLog) return false;
      const incomplete = await utilityLifecycle.activeOperationLog.listIncompleteTransactions();
      return incomplete.length > 0;
    }
  });
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerWindowThemeIpcHandlers({
    handle: trustedHandle,
    windowForSender: (event) => BrowserWindow.fromWebContents(event.sender),
    platform: process.platform
  });
  // Spec A2-A13 registration order: documents -> operations -> modelServices -> raw -> text -> map -> action -> assets -> event -> param -> workspace -> agent
  registerDocumentIpcHandlers({
    handle: trustedHandle,
    get activeSession() { return getWorkspaceSession(); },
    get activeWorkspaceSessionId() { return getActiveWorkspaceSessionIdState(); },
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    durableStoragePaths,
    bridgeRootSession
  });

  registerOperationIpcHandlers({
    handle: trustedHandle,
    get activeSession() { return getWorkspaceSession(); },
    get activeWorkspaceSessionGeneration() { return getActiveWorkspaceSessionGenerationState(); },
    get activeOperationLog() { return utilityLifecycle.activeOperationLog; },
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    durableStoragePaths,
    requestWriteConfirmation,
    refreshActiveIndexAfterNativeWrite
  });

  registerModelServiceIpcHandlers({
    handle: trustedHandle,
    vault: modelServiceVault,
    operationLogUtility,
    appDatabasePath: join(app.getPath('userData'), 'app.db'),
    isAgentSessionActive
  });

  registerRawIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get activeSession() { return getWorkspaceSession(); },
    durableStoragePaths,
    bridgeRootSession,
    bridgeRootsDiagnostic,
    verifiedReadRoots,
    verifiedStageRoots
  });

  registerTextIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get activeSession() { return getWorkspaceSession(); },
    durableStoragePaths,
    bridgeRootSession,
    bridgeRootsDiagnostic,
    verifiedReadRoots,
    verifiedStageRoots,
    rejectNonSekiroNativeWrite,
    sha256FileNow,
    ensureActiveOperationLog,
    sessionCommitPort,
    toSaveResultFromOutcome,
    refreshActiveIndexAfterNativeWrite
  });

  registerMapIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get indexedFilesRevision() { return getWorkspaceIndexedFilesRevisionState(); },
    get indexedFilesIdentityDigest() { return getWorkspaceRuntimeIdentityState().indexedFilesIdentityDigest; },
    get activeSession() { return getWorkspaceSession(); },
    get activeIndex() { return getWorkspaceActiveIndex(); },
    get activeWorkspaceSessionId() { return getActiveWorkspaceSessionIdState(); },
    get activeWorkspaceSessionGeneration() { return getActiveWorkspaceSessionGenerationState(); },
    replaceIndexedFile: replaceWorkspaceIndexedFileState,
    safeExists,
    asBasicDiagnostics: (items) => items.map((item) => ({ severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error', code: item.code, message: item.message, ...(item.sourceUri ? { sourceUri: item.sourceUri } : {}) })),
    durableStoragePaths,
    verifiedReadRoots,
    rejectNonSekiroNativeWrite,
    ensureActiveOperationLog,
    electronConfirmationPort,
    refreshActiveIndexAfterNativeWrite
  });

  registerActionIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get activeSession() { return getWorkspaceSession(); },
    get activeIndex() { return getWorkspaceActiveIndex(); },
    get activeWorkspaceSessionId() { return getActiveWorkspaceSessionIdState(); },
    safeExists,
    asBasicDiagnostics: (items) => items.map((item) => ({ severity: item.severity === 'warning' || item.severity === 'info' ? item.severity : 'error', code: item.code, message: item.message, ...(item.sourceUri ? { sourceUri: item.sourceUri } : {}) })),
    verifiedReadRoots,
    ensureActionBinderMembershipForFamily: (characterFamily) => ensureActionBinderMembershipForFamily({ verifiedReadRoots }, characterFamily),
    waitForWorkspaceIndexing
  });

  registerAssetIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get activeSession() { return getWorkspaceSession(); },
    verifiedReadRoots,
    verifiedStageRoots,
    durableStoragePaths,
    rejectNonSekiroNativeWrite,
    ensureActiveOperationLog,
    sessionCommitPort,
    electronConfirmationPort,
    toSaveResultFromOutcome,
    resolveFlverReadFile
  });

  registerEventIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    replaceIndexedFile: replaceWorkspaceIndexedFileState,
    get activeSession() { return getWorkspaceSession(); },
    durableStoragePaths,
    bridgeRootSession,
    bridgeRootsDiagnostic,
    rejectNonSekiroNativeWrite,
    ensureActiveOperationLog,
    sessionCommitPort,
    electronConfirmationPort,
    toSaveResultFromOutcome,
    refreshActiveIndexAfterNativeWrite
  });

  registerParamIpcHandlers({
    handle: trustedHandle,
    get indexedFiles() { return getWorkspaceIndexedFiles(); },
    get activeSession() { return getWorkspaceSession(); },
    get activeWorkspaceSessionId() { return getActiveWorkspaceSessionIdState(); },
    getIndexedFiles: getWorkspaceIndexedFiles,
    getActiveSession: getWorkspaceSession,
    getActiveWorkspaceSessionId: getActiveWorkspaceSessionIdState,
    durableStoragePaths,
    bridgeRootSession,
    bridgeRootsDiagnostic,
    verifiedReadRoots,
    verifiedStageRoots,
    rejectNonSekiroNativeWrite,
    ensureActiveOperationLog,
    sessionCommitPort,
    electronConfirmationPort,
    toSaveResultFromOutcome,
    refreshActiveIndexAfterNativeWrite,
    sha256FileNow
  });

  registerWorkspaceIpcHandlers({
    handle: trustedHandle,
    ensureActiveOperationLog,
    releaseEditorCaches: releaseWorkspaceEditorCaches,
    clearActiveOperationLog: () => utilityLifecycle.dispose(),
    verifiedReadRoots,
    scheduleRagEmbedding: scheduleInternalRagEmbedding
  });

  registerAgentIpcHandlers({
    handle: trustedHandle,
    webContents,
    toolRegistry,
    memoryManager,
    modelServiceVault,
    operationLogUtility,
    getActiveIndex: getWorkspaceActiveIndex,
    getActiveSession: getWorkspaceSession,
    getActiveWorkspaceSessionId: getActiveWorkspaceSessionIdState,
    getActiveWorkspaceSessionGeneration: getActiveWorkspaceSessionGenerationState,
    waitForWorkspaceIndexing,
    ensureActiveOperationLog,
    durableStoragePaths,
    currentToolContext,
    requestWriteConfirmation,
    readSystemPrompt
  });

  registerResourceIpcHandlers({
    handle: trustedHandle,
    getIndexedFiles: getWorkspaceIndexedFiles,
    replaceIndexedFile: replaceWorkspaceIndexedFileState,
    getActiveIndex: getWorkspaceActiveIndex,
    getActiveSession: getWorkspaceSession,
    getActiveWorkspaceSessionId: getActiveWorkspaceSessionIdState,
    getActiveWorkspaceSessionGeneration: getActiveWorkspaceSessionGenerationState,
    durableStoragePaths,
    ensureActiveOperationLog,
    verifiedReadRoots,
    verifiedStageRoots,
    sessionCommitPort,
    toSaveResultFromOutcome,
    rejectNonSekiroNativeWrite,
    requestWriteConfirmation,
    refreshActiveIndexAfterNativeWrite,
    withForegroundPriority,
    bumpPathSourceGenerationForUris,
    clearResourceRelatedCaches: () => {
      clearRawIpcCaches();
      clearParamIpcCaches();
    }
  });

  // All domain handlers are now delegated; composition root retains no direct `handle(` calls.
}
