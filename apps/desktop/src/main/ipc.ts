import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TrustedIpcHandle } from './ipc/registration.js';
import { registerAgentIpcHandlers, isAgentSessionActive } from './ipc/agent.js';
import { registerResourceIpcHandlers } from './ipc/resource.js';
import {
  analyzeWorkspace,
  buildAiSidebarDraft,
  buildTrustPolicyFromPackage,
  clearTrustDecision,
  readTrustDecision,
  trustCoversPackage,
  writeTrustDecision,
  type AppSettingsStore,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  fetchEmbeddings,
  isAllowedEndpoint,
  OpenAiCompatibleAdapter,
  AnthropicCompatibleAdapter,
  retrieveEvidenceHybrid,
  type HybridVectorSource,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  createContextBroker,
  createUnifiedDiff,
  importPinnedSmithboxSdtParamMetadata,
  applyYappedFieldOverlay,
  readYappedSdtDefsIndex,
  readYappedSdtRowNamesIndex,
  readTaeEventTemplateFile,
  type TaeEventTemplateInfo,
  type YappedParamOverlay,
  type YappedSourceDiagnostic,
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
  locateDsLuaDecompilerSync,
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
  resolveOperationLogStorePath,
  resolveResourceCapabilities,
  rollbackFile,
  rollbackOperation,
  roundTripContainer,
  runBridge,
  saveRawReplace,
  saveTextResource,
  scanWorkspace,
  buildRagCorpus,
  createRagCorpus,
  mergeCatalogAndPersisted,
  refreshKnowledgeAfterCommit,
  refreshNativeSemanticSources,
  summarizeKnowledgeRefresh,
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
  ParamMetadataPackage,
  EmevdEditorDocument,
  IndexedFile,
  ParamDefDocument,
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
  type RendererSaveResult
} from './rendererDto.js';
import { OperationLogUtilityClient } from './operationLogUtilityClient.js';
import { clearRecentPath, readRecentPath, writeRecentPath } from './recentPaths.js';
import { executeRecoveryCleanup } from './recoveryCleanup.js';
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
  getWorkspaceRag,
  getWorkspaceFingerprintStore,
  applyWorkspaceIndexSnapshot,
  applyWorkspaceRag,
  setWorkspaceForegroundActive,
  revokeDirectorySelectionsFor,
  rebuildActionBinderMembershipIndex,
  ensureActionBinderMembershipForFamily,
  waitForWorkspaceIndexing
} from './ipc/workspace.js';
import { clearParamIpcCaches, registerParamIpcHandlers } from './ipc/param.js';
import { registerDocumentIpcHandlers, resetEditorDocumentStore } from './ipc/documents.js';
import { registerOperationIpcHandlers } from './ipc/operations.js';
import { registerModelServiceIpcHandlers } from './ipc/modelServices.js';
import { registerRawIpcHandlers, clearRawIpcCaches } from './ipc/raw.js';
import { registerTextIpcHandlers, clearTextIpcCaches } from './ipc/text.js';
import { registerMapIpcHandlers } from './ipc/map.js';
import { registerActionIpcHandlers } from './ipc/action.js';
import { registerAssetIpcHandlers } from './ipc/assets.js';
import { registerEventIpcHandlers, clearEmevdIpcCaches, disposeEmevdWindow } from './ipc/event.js';
import { clearAgentIpcState } from './ipc/agent.js';

/** 只读存在性检查（chrbnd 伴生查找用；不抛异常）。 */
function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

let activeOperationLog: OperationLogUtilityClient | null = null;
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
/** Prevent duplicate rollback dialogs/transactions while one request is in flight. */
const activeRollbackRequests = new Set<string>();
/** Provider configs may omit contextWindowTokens; keep compaction fail-safe by default. */
const DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS = 500_000;
const AGENT_CONTEXT_COMPACTION_RATIO = 0.8;
/** 当前 overlay 的显示 label：remountBase 重建 session 时沿用（scan 时登记）。 */
type KnowledgeRefreshCarrier = Pick<SaveTextResourceResult, 'knowledgeRefresh'>;
// EMEVD authoritative caches and open-slot state moved to ipc/event.ts (domain-owned).

// Paginated editor caches moved to domain modules: text (fmgPageCache/textTableRefs/fmgTableCache),
// raw (containerChildrenCache/scriptContainerEntriesCache). See ipc/text.ts and ipc/raw.ts.

// Container/script helpers moved to ipc/raw.ts (domain-owned). See that module for enumeration and BND4 helpers.

function clearEditorPageCaches(): void {
  // Composition of domain-owned cache resets — composition root does not touch domain private maps directly.
  clearParamIpcCaches();
  clearTextIpcCaches();
  clearRawIpcCaches();
  clearEmevdIpcCaches();
  clearWorkspaceIpcCaches();
  clearAgentIpcState();
  resetEditorDocumentStore();
}

/**
 * EMEDF 自动定位（同步、只读、有界）。
 *
 * R3/P4 裁定：事件源码必须是 DarkScript3 式（EMEDF 函数名），没 EMEDF 失败关闭。
 * T4 查找顺序（grok 2026-08-15 拍死）：
 * 1. SOULFORGE_EMEDF_PATH（显式覆盖）；
 * 2. 固定候选：本机 DarkScript3 事件编辑器发布包的真实落地
 *    `<tools>/事件编辑器3.4.1/Resources/sekiro-common.emedf.json`；
 * 3. 已挂载 baseRoot 兄弟 `tools/<一层子目录>/Resources/`（DarkScript3 发布包
 *    常规落地形态）；
 * 4. 已挂载 overlay 根向上两级（workspace 层）的兄弟 `tools/<一层>/Resources/`；
 * 5. SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools；
 * 6. 有界用户目录（Desktop/Documents/Downloads）。
 * 绝不递归整盘；找不到返回 null，由 resolveEmevdRegistry 失败关闭到 fixture。
 */
const EMEDF_RELATIVE_CANDIDATES = [
  'sekiro-common.emedf.json',
  'Sekiro/sekiro-common.emedf.json',
  'sekiro.emedf.json',
  'Resources/sekiro-common.emedf.json'
];

/** T4 固定候选：本机 DarkScript3 事件编辑器发布包真实落地（grok 已求证存在）。 */
const EMEDF_FIXED_CANDIDATES = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\事件编辑器3.4.1\\Resources\\sekiro-common.emedf.json'
];

/**
 * 往 roots 追加某 gameRoot 兄弟 `tools/` 目录及其中一层子目录，供后续逐候选探测。
 * 找不到 tools/ 或不可读时静默跳过，不阻断其他候选。
 */
function pushToolsSubdirs(roots: string[], gameRoot: string | undefined): void {
  if (!gameRoot) return;
  const toolsDir = join(dirname(gameRoot), 'tools');
  try {
    roots.push(toolsDir);
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(toolsDir, entry.name));
    }
  } catch {
    // tools 目录不存在/不可读：跳过，继续其他候选。
  }
}

function locateUserEmedfSync(): string | null {
  const roots: string[] = [];
  // 1) 显式环境变量优先。
  const explicit = process.env.SOULFORGE_EMEDF_PATH?.trim();
  if (explicit) roots.push(resolve(explicit));
  // 2) 固定候选：DarkScript3 事件编辑器发布包的本机真实落地（整路径直接判存在）。
  for (const candidate of EMEDF_FIXED_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 继续下一个候选。
    }
  }
  // 3) 已挂载 baseRoot 的兄弟 tools/<一层子目录>。
  const emedfSession = getWorkspaceSession();
  pushToolsSubdirs(roots, emedfSession?.layers.baseRoot);
  // 4) 已挂载 overlay 根向上两级（workspace 层）的兄弟 tools/<一层>/Resources/。
  const overlay = emedfSession?.layers.overlayRoot?.trim();
  if (overlay) pushToolsSubdirs(roots, dirname(dirname(overlay)));
  // 5) SOULFORGE_SEKIRO_GAME_ROOT 同样扫兄弟 tools。
  const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (gameRootEnv) pushToolsSubdirs(roots, gameRootEnv);
  // 6) 有界用户目录。
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  if (home) {
    roots.push(join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads'));
  }
  for (const root of roots) {
    for (const relative of EMEDF_RELATIVE_CANDIDATES) {
      try {
        const candidate = join(root, relative);
        if (existsSync(candidate)) return candidate;
      } catch {
        // 继续下一个候选。
      }
    }
  }
  return null;
}

/**
 * S17（2026-08-15）：动作域 TAE 的伴生 chrbnd 只读解析。
 *
 * 虚拟 sourceUri 形如 `chrbnd:chr/c1130.chrbnd.dcx` —— renderer 只持有这个
 * 逻辑标识，真实路径永远留在 main。查找顺序：overlay 根 → 已挂载原版根。
 * 拒绝 `..` 等越界片段。找不到返回 null，由调用方给空态文案。
 */
function resolveChrbndVirtualFile(sourceUri: string): { absolutePath: string; relativePath: string } | null {
  if (!sourceUri.startsWith('chrbnd:')) return null;
  const relativePath = sourceUri.slice('chrbnd:'.length).replace(/[/\\]+/g, '/').replace(/^[/\\]+/, '');
  if (!relativePath || relativePath.split('/').some((segment) => segment === '..' || segment === '')) {
    return null;
  }
  const chrbndSession = getWorkspaceSession();
  const overlay = chrbndSession?.layers.overlayRoot?.trim();
  if (overlay) {
    const candidate = join(overlay, relativePath);
    try {
      if (existsSync(candidate)) return { absolutePath: candidate, relativePath };
    } catch {
      // 不可读，继续下一个候选。
    }
  }
  const base = chrbndSession?.layers.baseRoot?.trim();
  if (base) {
    const candidate = join(base, relativePath);
    try {
      if (existsSync(candidate)) return { absolutePath: candidate, relativePath };
    } catch {
      // 不可读。
    }
  }
  return null;
}

/**
 * S17：FLVER 读通道的资源解析 —— 先走已索引文件，再走 chrbnd 虚拟标识
 * （伴生模型预览）。返回 null 时调用方按 RESOURCE_NOT_INDEXED 处理。
 */
function resolveFlverReadFile(sourceUri: string): { absolutePath: string; relativePath: string } | null {
  const indexed = getWorkspaceIndexedFiles().find((item) => item.sourceUri === sourceUri);
  if (indexed) return { absolutePath: indexed.absolutePath, relativePath: indexed.relativePath };
  return resolveChrbndVirtualFile(sourceUri);
}

function logicalMapModelName(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? raw;
  return base
    .replace(/\.(?:flver|chrbnd|objbnd|mapbnd)(?:\.dcx)?$/i, '')
    .replace(/\.dcx$/i, '');
}

function resolveMapModelFile(
  mapRelativePath: string,
  modelName: string,
  sibPath?: string
): { absolutePath: string; relativePath: string; kind: 'flver' | 'chrbnd' } | null {
  const names = [...new Set(
    [modelName, sibPath ?? '']
      .map((value) => logicalMapModelName(value))
      .filter((value) => value.length > 0)
  )];
  const mapStem = basename(mapRelativePath).replace(/\.msb(\.dcx)?$/i, '');
  const mapId = /^m\d{2}_\d{2}_\d{2}_\d{2}$/i.test(mapStem) ? mapStem : null;
  const candidates: Array<{ rel: string; kind: 'flver' | 'chrbnd' }> = [];
  for (const name of names) {
    if (mapId) {
      // m000010 → m10_00_00_00_000010：MSB 侧短名需展开为 mapbnd 侧长名
      const mShort = /^m(\d{6})$/i.exec(name)?.[1];
      if (mShort) {
        const longName = `${mapId}_${mShort}`;
        candidates.push({ rel: `map/${mapId}/${longName}.mapbnd.dcx`, kind: 'flver' });
        // mapbnd 容器内的 FLVER 名就是长名本身（条目名为 .../long.flver），
        // 但单文件 flver 路径也试一下（部分 map 可能有散文件）
        candidates.push({ rel: `map/${mapId}/${longName}.flver.dcx`, kind: 'flver' });
        candidates.push({ rel: `map/${mapId}/${longName}.flver`, kind: 'flver' });
      }
      candidates.push({ rel: `map/${mapId}/${name}.flver.dcx`, kind: 'flver' });
      candidates.push({ rel: `map/${mapId}/${name}.flver`, kind: 'flver' });
    }
    candidates.push({ rel: `map/${name}.flver.dcx`, kind: 'flver' });
    if (/^c\d/i.test(name)) candidates.push({ rel: `chr/${name}.chrbnd.dcx`, kind: 'chrbnd' });
    if (/^o\d/i.test(name)) candidates.push({ rel: `obj/${name}.objbnd.dcx`, kind: 'flver' });
  }
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  const indexedFiles = getWorkspaceIndexedFiles();
  for (const candidate of candidates) {
    const indexed = indexedFiles.find((item) => {
      const rel = normalize(item.relativePath);
      return rel === normalize(candidate.rel) || rel.endsWith(`/${normalize(candidate.rel)}`);
    });
    if (indexed) {
      return { absolutePath: indexed.absolutePath, relativePath: indexed.relativePath, kind: candidate.kind };
    }
  }
  const mapSession = getWorkspaceSession();
  const overlay = mapSession?.layers.overlayRoot?.trim();
  const base = mapSession?.layers.baseRoot?.trim();
  for (const root of [overlay, base]) {
    if (!root) continue;
    for (const candidate of candidates) {
      const absolutePath = join(root, candidate.rel);
      if (safeExists(absolutePath)) {
        return { absolutePath, relativePath: candidate.rel, kind: candidate.kind };
      }
    }
  }
  return null;
}

// EMEDF registry cache moved to ipc/event.ts (domain-owned).
let handlersRegistered = false;
const trustedRendererDocuments = new Map<number, string>();
const directorySelections = new Map<string, DirectorySelectionRecord>();

/* ------------------------------------------------------------------ */
/*  §14.4 DocumentStore IPC（DOCSTORE-04）                             */
/*  renderer 只发逻辑引用；ownerKey 由 main 从 trusted webContents 与 */
/*  workspace session 派生，renderer 永远不能传入；locator 由 main     */
/*  probe 组装（含 outerSourceUri），永不出 main。                     */
/* ------------------------------------------------------------------ */

let editorDocumentStore: EditorDocumentStore | null = null;

/**
 * 惰性创建文档仓库。分页数据源与写链是骨架：由后续卡（PARAM-10B、TEXT-20B
 * 等）接入真实实现；未接入的查询/写入如实返回 capability-blocked /
 * mutation-rejected，不假装成功。
 */
function ensureEditorDocumentStore(): EditorDocumentStore {
  if (editorDocumentStore) return editorDocumentStore;
  const skeletonDataSource: EditorDocumentDataSource = {
    loadPage: async () => ({ items: null, nextCursor: null, totalKnown: null }),
    readContent: async () => null
  };
  const skeletonApplyPort: EditorMutationApplyPort = {
    apply: async () => ({ kind: 'rejected', code: 'WRITE_CHAIN_NOT_CONNECTED' })
  };
  editorDocumentStore = new EditorDocumentStore({
    ttlMs: 30 * 60_000,
    dataSource: skeletonDataSource,
    applyPort: skeletonApplyPort
  });
  return editorDocumentStore;
}

/**
 * ownerKey 绑定「会话 + 窗口」：另一窗口（webContents）即使猜中 handle 也
 * 得到 owner-mismatch；重新扫描工作区（activeWorkspaceSessionId 更换）后
 * 旧 handle 全部失效——这正是 cross-sender rejection 的实现点。
 */
function deriveDocumentOwnerKey(event: IpcMainInvokeEvent): string {
  return createHash('sha256')
    .update(`${getActiveWorkspaceSessionIdState() ?? 'no-session'}:${event.sender.id}`)
    .digest('hex');
}

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

/** §4.3 域 → 资源 kind 的粗粒度匹配（CAT-05 的 Catalog 校验落地后替换）。 */
const DOMAIN_RESOURCE_KINDS: Record<string, readonly string[]> = {
  param: ['param', 'container'],
  gparam: ['param', 'container'],
  container: ['container', 'param'],
  text: ['msg'],
  event: ['event'],
  script: ['script'],
  map: ['map'],
  model: ['model'],
  texture: ['texture'],
  material: ['material'],
  vfx: ['vfx'],
  behavior: ['behavior'],
  animation: ['animation']
};

function editorDocumentFailure(
  code: EditorDocumentErrorCode,
  retryable: boolean
): EditorDocumentResult<never> {
  return { ok: false, code, retryable };
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
const modelServiceVault = new ModelServiceCredentialVault(app.getPath('userData'));
const memoryManager = new MemoryManager(app.getPath('userData'));

const toolRegistry = createDefaultToolRegistry();
// P0 authority: renderer cannot elevate this value. Persistent per-model-service
// grants replace this constant in P6; until then the desktop is plan-only.
const activeAiMode: ToolContext['mode'] = 'plan';

export interface AnalyzeWorkspaceSummary {
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: {
    high: number;
    medium: number;
    low: number;
    suppressedAmbiguousNumbers: number;
  };
  diagnostics: Diagnostic[];
  events: Array<{ uri: string; eventId: number; name?: string }>;
  tools: ToolDescriptor[];
}

export interface RendererWorkspaceSession {
  workspaceSessionId: string;
  workspaceLabel: string;
  game: string;
  openedAt: string;
  baseMounted: boolean;
  baseLabel?: string;
}

export interface WorkspaceIndexingStatus {
  workspaceSessionId: string | null;
  phase: 'idle' | 'hashing' | 'persisting' | 'rag' | 'ready' | 'failed';
  current: number;
  total: number;
  message: string;
  elapsedMs?: number;
}

export interface RendererWorkspaceScanResult {
  workspaceSessionId: string;
  workspaceLabel: string;
  files: RendererIndexedFile[];
  countsByKind: Record<ResourceKind, number>;
  diagnostics: Diagnostic[];
  session: RendererWorkspaceSession;
  indexingStatus: WorkspaceIndexingStatus;
}

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
  knowledgeRefresh?: NonNullable<SaveTextResourceResult['knowledgeRefresh']>;
}

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

/* ------------------------------------------------------------------ */
/*  AI agent session IPC contract (Codex-derived kernel).             */
/*  Keys never cross the bridge; events are redacted by the host.     */
/* ------------------------------------------------------------------ */

export interface AiAgentRunRequest {
  configId: string;
  prompt: string;
  mode?: 'plan' | 'normal' | 'fullPermission';
  streaming?: boolean;
  /** Session-relative rollout path as returned by ai.agent.sessions. */
  resumeSessionPath?: string;
  /**
   * Per-model-call timeout. Before this was exposed, the loop ran with no
   * timeout at all: a provider that accepted the connection and then stalled
   * left the session running until the user cancelled it by hand.
   */
  timeoutMs?: number;
  /** Total output token budget across all steps; the loop stops when exceeded. */
  maxTotalOutputTokens?: number;
  /**
   * Auto-compaction trigger in estimated context tokens. Compaction is
   * implemented but never fired in production, because reaching it requires
   * this value and nothing supplied one.
   */
  autoCompactTokenLimit?: number;
  /** Retry attempts for model calls; the loop defaults to 4 when unset. */
  retryMaxAttempts?: number;
  /** Assemble workspace evidence into bounded context before each model call. */
  useContextBroker?: boolean;
  /** Byte ceiling for Context Broker output; ignored unless useContextBroker. */
  contextMaxBytes?: number;
  /**
   * 2-A：本次任务的思考强度（官方 effort 档：off/none/minimal/low/medium/high/xhigh/max），
   * 优先于服务级默认。作用于下一次 runAgentTask，不要求用户进设置页。
   */
  thinkingLevel?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * RAG auto-search: before each model call, retrieve workspace evidence from
   * the most recent user message and inject a [rag-evidence] system message.
   * Default false; requires an analyzed workspace (activeRag corpus).
   */
  useRagSearch?: boolean;
  /** Cap on injected rag-evidence hits per turn (1..8). */
  ragSearchMaxHits?: number;
  /**
   * Permission levels that require user approval. Omit for the loop's default
   * (stage/commit/rollback/write). An explicit empty array disables approval,
   * which main refuses outside plan mode — see the handler.
   */
  approvalRequiredLevels?: string[];
  /**
   * main-issued opaque resource references (§12.11 SubmitAgentRunRequest)。
   *
   * AGENT-60D 提交期消费点：每个 token 必须已在 agentReferenceRegistry 签发，
   * 且 ownerId 与当前 sender 一致（跨 sender 拒绝）。未传或空数组 = 无引用。
   */
  resources?: readonly AgentResourceReference[];
  /**
   * 当前选区（可选元数据，T6）：逻辑名 + 资源 kind。作为系统提示的一部分给模型
   * 参考，**不是**默认任务对象，renderer 不把 `#路径` 自动写进 prompt 文本。
   * main 装配（appends to systemPrompt）；未选中时不传。
   */
  selection?: {
    label: string;
    resourceKind: ResourceKind;
  };
  /**
   * 最近一次资源打开失败（可选元数据，S15/S19 失败面）：打开 KRAK / 读取失败的
   * 资源时，renderer 把结构化失败随下一次任务提交。main 校验后附进系统提示，
   * 让 Agent 直接解释原因与下一步，而不是等用户复制日志。
   *
   * 只允许逻辑名（相对路径 / basename），不含绝对路径；main 对每个字符串做
   * 失败关闭校验（命中盘符 / UNC / file:/// 一律拒绝整次请求）。
   */
  openFailure?: {
    kind:
      | 'event-open-failed'
      | 'msb-open-failed'
      | 'fmg-open-failed'
      | 'param-open-failed'
      | 'script-open-failed'
      | 'tae-open-failed';
    document: string;
    code: string;
    message: string;
  };
}

/** Renderer's answer to one approval request (ai.agent.approval.respond). */
export interface AiAgentApprovalResponseRequest {
  sessionId: string;
  callId: string;
  decision: ApprovalDecision;
  note?: string;
}

export type AiAgentRunIpcResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: { code: string; message: string } };

export interface AiAgentSessionSummaryIpc {
  /** Path relative to the agent sessions dir; opaque to the renderer. */
  sessionPath: string;
  fileName: string;
  sessionId: string | null;
  startedAt: string | null;
  messageCount: number;
  parseErrors: number;
  interrupted: boolean;
  compactedWindows: number;
  sizeBytes: number;
  modifiedAt: string;
}

export type AiAgentSessionListIpcResult =
  | { ok: true; sessions: AiAgentSessionSummaryIpc[] }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLoadIpcResult =
  | {
      ok: true;
      meta: RolloutSessionMeta | null;
      messageCount: number;
      parseErrors: number;
      interrupted: boolean;
      compactedWindows: number;
      /** Bounded tail page (hard constraint 17). */
      messagesPage: ChatMessage[];
    }
  | { ok: false; error: { code: string; message: string } };

export type AiAgentSessionLifecycleEvent =
  | { type: 'session-accepted'; mode: 'plan' | 'normal' | 'fullPermission' }
  | { type: 'session-done'; finishReason: string; steps: number; rolloutFileName: string }
  | { type: 'session-error'; code: string; message: string };

/** Envelope pushed on the 'ai:agent:event' channel. */
export interface AiAgentEventEnvelope {
  sessionId: string;
  /**
   * §12.11 严格递增 seq：同一 session 的推送必须严格递增。main 侧按 session 单调
   * 盖章，renderer 侧对重复 / 倒序 seq 丢弃并记诊断（见 shared agent-ui 的
   * applyAgentStreamSeq / reduceAgentStreamToMessages）。
   */
  seq: number;
  event: AgentEvent | AiAgentSessionLifecycleEvent;
}

/**
 * 补取 run 返回前已经产生的 agent 事件。推送仍是实时通道，回放只是
 * 为 renderer 建立 session 状态前的短竞态提供可靠补偿；调用方按 seq 去重。
 */
export type AiAgentEventReplayIpcResult =
  | { ok: true; events: AiAgentEventEnvelope[] }
  | { ok: false; error: { code: string; message: string } };

/** §12.11 资源引用 token 校验结果（agent 通道专用；不是 param/format 读取）。 */
export type AgentResourceReferenceCreateIpcResult =
  | { ok: true; reference: AgentResourceReference }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        diagnostics?: readonly { code: string; path: string; message: string }[];
      };
    };

export type AgentAttachmentCreateIpcResult =
  | {
      ok: true;
      reference: {
        token: string;
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'text/plain';
        byteLength: number;
        expiresAt: string;
      };
      label: string;
    }
  | {
      ok: false;
      cancelled?: boolean;
      error: { code: string; message: string };
    };

export interface DirectorySelection {
  selectionId: string;
  label: string;
}

export interface OpenWorkspaceScanOptions {
  overlaySelectionId: string;
  baseSelectionId?: string;
  /** 显式卸掉原版：不带 base，并忘掉最近一次原版目录。 */
  clearBase?: boolean;
}

interface DirectorySelectionRecord extends DirectorySelection {
  absolutePath: string;
  kind: 'overlay' | 'base';
  ownerWebContentsId: number;
  expiresAt: number;
}

function legacyOperationLogPathForWorkspace(workspaceId: string): string {
  // workspaceId is a file:// URL from makeWorkspaceId; never join it raw into a Windows path.
  return resolveOperationLogStorePath(join(app.getPath('userData'), 'operation-logs'), workspaceId);
}

async function ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient> {
  const storage = workspaceStoragePaths(session.meta.workspaceId);
  await operationLogUtility.openWorkspace({
    appDatabasePath: join(app.getPath('userData'), 'app.db'),
    databasePath: join(storage.root, 'workspace.db'),
    workspaceId: session.meta.workspaceId,
    rootPath: session.layers.overlayRoot,
    game: session.meta.game,
    legacyOperationLogPath: legacyOperationLogPathForWorkspace(session.meta.workspaceId),
    legacyBackupDirectory: join(storage.root, 'legacy-operation-logs'),
    legacySemanticSnapshotPath: join(session.layers.overlayRoot, 'semantic-snapshot.json'),
    legacySemanticBackupDirectory: join(storage.root, 'legacy-semantic-snapshots')
  });
  const cleanupPlan = await operationLogUtility.planRecoveryCleanup();
  const cleanup = await executeRecoveryCleanup({
    plan: cleanupPlan,
    allowedRoots: [storage.backupBaseDir, storage.recoveryDir],
    store: operationLogUtility
  });
  if (cleanup.rejected.length > 0) {
    process.stderr.write(`[SoulForge recovery cleanup] ${JSON.stringify(cleanup.rejected)}\n`);
  }
  activeOperationLog = operationLogUtility;
  return operationLogUtility;
}

function currentToolContext(): ToolContext {
  const session = getWorkspaceSession();
  const index = getWorkspaceActiveIndex();
  const rag = getWorkspaceRag();
  const storage = session ? durableStoragePaths(session.meta.workspaceId) : undefined;
  return {
    workspaceIndex: index,
    mode: activeAiMode,
    ...(rag ? { rag } : {}),
    ...(session ? { session } : {}),
    ...(activeOperationLog ? { operationLogStore: activeOperationLog } : {}),
    ...(storage ? { backupBaseDir: storage.backupBaseDir, recoveryDir: storage.recoveryDir } : {}),
    onSemanticEvidenceUpdated: refreshActiveIndexAfterSemanticEvidence,
    onNativeWriteCommitted: refreshActiveIndexAfterNativeWrite
  };
}

async function persistActiveRag(
  database: OperationLogUtilityClient,
  corpus: RagCorpus
): Promise<void> {
  applyWorkspaceRag(corpus);
  await database.replaceRagChunks(corpus.chunks);
  await database.replaceReferences(corpus.references);
}

async function refreshRagAfterScan(
  database: OperationLogUtilityClient,
  index: WorkspaceIndex
): Promise<void> {
  const catalog = buildRagCorpus(index);
  const persisted = createRagCorpus({
    workspaceId: index.workspaceId,
    builtAt: catalog.builtAt,
    chunks: await database.loadRagChunks(),
    references: await database.loadReferences()
  });
  await persistActiveRag(database, mergeCatalogAndPersisted(catalog, persisted));
}

async function refreshRagAfterAnalyze(
  database: OperationLogUtilityClient,
  index: WorkspaceIndex
): Promise<void> {
  await persistActiveRag(database, buildRagCorpus(index));
}

async function refreshActiveIndexAfterSemanticEvidence(sourceUris: readonly string[] = []): Promise<void> {
  const session = getWorkspaceSession();
  const index = getWorkspaceActiveIndex();
  const sessionId = getActiveWorkspaceSessionIdState();
  if (!session || !index || !sessionId) return;
  // Live read tools have already replaced/merged the relevant semantic export.
  // Re-scan only refreshes the file catalog; it must not invalidate unrelated
  // semantic data or merge a stale persisted copy over the just-read value.
  const result = await scanWorkspace({
    workspaceRoot: session.layers.overlayRoot,
    game: session.meta.game
  });
  index.setFiles(result.files);
  // WorkspaceIndex.setFiles intentionally clears source-bound ACTION Binder
  // membership. Rebuild it before publishing the refreshed snapshot; otherwise
  // a successful TAE reread makes the next animation lookup fail with
  // ACTION_BINDER_MEMBERSHIP_INDEX_NOT_READY until the user reopens the workspace.
  const actionBinderIndex = await rebuildActionBinderMembershipIndex({
    deps: { verifiedReadRoots },
    index,
    session,
    sessionId,
    indexedFiles: result.files
  });
  if (!actionBinderIndex.ok) {
    throw new Error(actionBinderIndex.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('；')
      || 'ACTION_BINDER_MEMBERSHIP_REBUILD_FAILED');
  }
  index.rebuildReferences();
  applyWorkspaceIndexSnapshot(index);
  const database = activeOperationLog ?? await ensureActiveOperationLog(session);
  await refreshRagAfterAnalyze(database, index);
  void sourceUris;
}

/**
 * Native Agent/UI write 后刷新文件哈希与 RAG 新鲜度。
 * 只重扫当前 overlay 的 catalog，不把刷新失败伪装成「已同步」；持久化
 * symbol chunk 会按 sourceHash 在 mergeCatalogAndPersisted 中被丢弃。
 */
async function refreshActiveIndexAfterNativeWrite(
  changedSources: readonly string[] = [],
  carrier?: KnowledgeRefreshCarrier
): Promise<KnowledgeRefreshResult | void> {
  const session = getWorkspaceSession();
  const currentIndex = getWorkspaceActiveIndex();
  const sessionId = getActiveWorkspaceSessionIdState();
  if (!session || !currentIndex || !sessionId) return;
  const beforeFiles = currentIndex.getFiles();
  const requestedSources = resolveKnowledgeSourceUris(changedSources, beforeFiles);
  const result = await scanWorkspace({
    workspaceRoot: session.layers.overlayRoot,
    game: session.meta.game
  });
  const database = activeOperationLog ?? await ensureActiveOperationLog(session);
  const output = await refreshKnowledgeAfterCommit({
    index: currentIndex,
    beforeFiles,
    afterFiles: result.files,
    requestedSources,
    // A catalog scan cannot prove semantic truth.  Re-run the same production
    // analyzer used by workspace.analyze so old symbols are removed first and
    // the new source revision is only admitted after native reread/ingest.
    reanalyze: async () => {
      const analyzed = await analyzeWorkspace({
        workspaceRoot: session.layers.overlayRoot,
        ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {})
      });
      const nativeRefresh = await refreshNativeSemanticSources({
        index: analyzed.index,
        sourceFiles: analyzed.index.getFiles().filter((file) => requestedSources.includes(file.sourceUri)),
        stagingRoot: durableStoragePaths(session.meta.workspaceId).stagingRoot,
        allowedRoots: [
          session.layers.overlayRoot,
          ...(session.layers.baseRoot ? [session.layers.baseRoot] : [])
        ],
        ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {})
      });
      if (nativeRefresh.failedSources.length > 0) {
        const detail = nativeRefresh.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('；');
        throw new Error(detail || `native semantic refresh failed for ${nativeRefresh.failedSources.length} source(s)`);
      }
      if (getActiveWorkspaceSessionIdState() !== sessionId) {
        throw new Error('工作区已切换，ACTION membership 刷新结果已丢弃。');
      }
      const actionBinderIndex = await rebuildActionBinderMembershipIndex({
        deps: { verifiedReadRoots },
        index: analyzed.index,
        session,
        sessionId,
        indexedFiles: analyzed.index.getFiles()
      });
      if (!actionBinderIndex.ok) {
        const detail = actionBinderIndex.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('；');
        throw new Error(detail || 'ACTION_BINDER_MEMBERSHIP_REBUILD_FAILED');
      }
      return {
        index: analyzed.index,
        semanticState: nativeRefresh.partialSources.length > 0 ? 'partial' as const : 'reanalyzed' as const,
        ...(nativeRefresh.partialSources.length > 0
          ? { error: nativeRefresh.diagnostics.map((diagnostic) => diagnostic.message).join('；') }
          : {})
      };
    },
    persist: async (index) => {
      applyWorkspaceIndexSnapshot(index);
      await refreshRagAfterAnalyze(database, index);
    }
  });
  applyWorkspaceIndexSnapshot(output.index);
  if (carrier) carrier.knowledgeRefresh = summarizeKnowledgeRefresh(output.result);
  return output.result;
}

function resolveKnowledgeSourceUris(sourceIds: readonly string[], files: readonly IndexedFile[]): string[] {
  const resolved: string[] = [];
  for (const sourceId of sourceIds) {
    const match = files.find((file) => (
      file.sourceUri === sourceId
      || file.absolutePath === sourceId
      || file.sourcePath === sourceId
      || file.relativePath === sourceId
    ));
    if (match) {
      resolved.push(match.sourceUri);
    } else if (sourceId.startsWith('file://')) {
      resolved.push(sourceId);
    } else if (resolve(sourceId) === sourceId) {
      resolved.push(pathToFileURL(sourceId).href);
    }
  }
  return [...new Set(resolved)];
}

function workspaceStoragePaths(workspaceId: string): {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  const safeWorkspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const root = join(localApplicationDataRoot(), 'workspaces', safeWorkspaceKey);
  return {
    root,
    backupBaseDir: join(root, 'backups'),
    recoveryDir: join(root, 'recovery'),
    stagingRoot: join(root, 'staging')
  };
}

function localApplicationDataRoot(): string {
  if (process.platform === 'win32') {
    return join(dirname(app.getPath('appData')), 'Local', 'SoulForge');
  }
  return join(app.getPath('userData'), 'local-data');
}

function durableStoragePaths(workspaceId: string): {
  root: string;
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  return workspaceStoragePaths(workspaceId);
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
    message: `${result.message}。操作：重试 / 打开 Problems / 检查工作区存储权限。`,
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
export type { TextCatalogResponse } from './ipc/text.js';

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

/**
 * S16 脚本 IDE：HKS 字节码反编译（main 进程 spawn 本机 DSLuaDecompiler.exe）。
 *
 * `DSLuaDecompiler <file> --console` 把 Lua 字节码反编译到 stdout；发行目标
 * net7，本机可能只有 .NET 6/8，故注入 DOTNET_ROLL_FORWARD=LatestMajor。
 * stdout 有界（8 MiB）、超时 kill；一切失败结构化返回，不抛给 renderer。
 */
export interface DsLuaDecompileRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number | null;
  spawnFailure: string | null;
  truncated: boolean;
}

export async function runDsLuaDecompilerCapture(
  exePath: string,
  hksPath: string,
  timeoutMs: number
): Promise<DsLuaDecompileRunResult> {
  return await new Promise((resolveResult) => {
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const stdoutLimit = 8 * 1024 * 1024;
    const settle = (result: DsLuaDecompileRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };
    const current = (exitCode: number | null, extra: Partial<DsLuaDecompileRunResult>): DsLuaDecompileRunResult => ({
      ok: exitCode === 0 && !truncated,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      timedOut: false,
      exitCode,
      spawnFailure: null,
      truncated,
      ...extra
    });
    timer = setTimeout(() => {
      try { child?.kill(); } catch { /* 超时终止，尽力而为 */ }
      settle(current(null, { timedOut: true }));
    }, timeoutMs);
    try {
      child = spawn(exePath, [hksPath, '--console'], {
        cwd: dirname(exePath),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DOTNET_ROLL_FORWARD: 'LatestMajor' }
      });
    } catch (error) {
      settle({
        ok: false,
        stdout: '',
        stderr: String(error),
        timedOut: false,
        exitCode: null,
        spawnFailure: error instanceof Error ? error.message : String(error),
        truncated: false
      });
      return;
    }
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = stdoutLimit - stdout.length;
      if (bytes.length > remaining) truncated = true;
      if (remaining > 0) stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = stdoutLimit - stderr.length;
      if (bytes.length > remaining) truncated = true;
      if (remaining > 0) stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
    });
    child.once('error', (error) => {
      settle({
        ok: false,
        stdout: '',
        stderr: '',
        timedOut: false,
        exitCode: null,
        spawnFailure: error.message,
        truncated: false
      });
    });
    child.once('close', (code) => {
      settle(current(code, {}));
    });
  });
}

/** 反编译器命中来源的人类可读标识（renderer 展示用，不含路径）。 */
function decompilerLabel(origin: 'explicit' | 'v1.1.5' | 'tools-scan' | 'legacy' | 'none'): string {
  switch (origin) {
    case 'explicit':
      return 'DSLuaDecompiler（显式路径）';
    case 'v1.1.5':
      return 'DSLuaDecompiler v1.1.5';
    case 'tools-scan':
      return 'DSLuaDecompiler（tools 扫描）';
    case 'legacy':
      return 'DSLuaDecompiler（hks解码目录）';
    default:
      return 'DSLuaDecompiler';
  }
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
  activeOperationLog = null;
  await operationLogUtility.dispose();
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

function createDirectorySelection(
  event: IpcMainInvokeEvent,
  absolutePath: string,
  kind: DirectorySelectionRecord['kind']
): DirectorySelection {
  const selection: DirectorySelectionRecord = {
    selectionId: randomUUID(),
    label: basename(absolutePath) || (kind === 'overlay' ? 'Mod 工作区' : '原版游戏目录'),
    absolutePath,
    kind,
    ownerWebContentsId: event.sender.id,
    expiresAt: Date.now() + 5 * 60_000
  };
  directorySelections.set(selection.selectionId, selection);
  return { selectionId: selection.selectionId, label: selection.label };
}

function consumeDirectorySelection(
  event: IpcMainInvokeEvent,
  selectionId: string,
  expectedKind: DirectorySelectionRecord['kind']
): DirectorySelectionRecord {
  const selection = directorySelections.get(selectionId);
  directorySelections.delete(selectionId);
  if (!selection
    || selection.kind !== expectedKind
    || selection.ownerWebContentsId !== event.sender.id
    || selection.expiresAt < Date.now()) {
    throw new Error('目录选择凭据无效、已过期或不属于当前窗口。');
  }
  return selection;
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
  storage: { backupBaseDir: string; recoveryDir: string }
): RawReplaceCommitPort {
  return {
    commit: async (input) => {
      // 工作台按钮就是确认。S29 拆掉了弹窗，但 file_replace 对 parambnd 等
      // 打包格式仍要一张 receipt；不补的话新建/删行会停在
      // EDIT_CONFIRMATION_REQUIRED（Files Mode raw/high-risk…）。
      const confirmation = input.confirmation ?? createConfirmationReceipt({
        subjects: [
          'MAIN_WORKBENCH_COMMIT',
          input.file.sourceUri,
          'ALL_RISKS',
          ...(getActiveWorkspaceSessionIdState() ? [`WORKSPACE_SESSION:${getActiveWorkspaceSessionIdState()}`] : []),
          `TITLE:${input.title}`
        ],
        riskLevel: 'high',
        sourceUri: input.file.sourceUri,
        note: '工作台提交视为已确认'
      });
      const result = await saveRawReplace({
        file: input.file,
        expectedHash: input.expectedHash,
        newContentBase64: input.newContentBase64,
        title: input.title,
        confirmation,
        session,
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir
      });
      // All native writers that use applyNativeMutation share this commit port.
      // Refresh only after Patch Engine reports a committed replacement; a
      // staged/failed write must never invalidate live evidence speculatively.
      if (result.ok) await refreshActiveIndexAfterNativeWrite([input.file.sourceUri], result);
      return result;
    }
  };
}

/**
 * 把 core 写链结果转成 renderer DTO。取消是正常结果，不能报成故障。
 */
function toSaveResultFromOutcome(
  outcome: NativeMutationOutcome,
  files: IndexedFile[]
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
    for (const [selectionId, selection] of directorySelections) {
      if (selection.ownerWebContentsId === webContents.id) directorySelections.delete(selectionId);
    }
    disposeEmevdWindow(webContents.id);
    // 窗口销毁 = 用户强制中断：取消该窗口发起的 agent 运行，并把它的挂起
    // 审批按拒绝结算（无人回答 ≠ 同意执行写入）。其他窗口的运行不受影响。
    // agent runs teardown handled in ipc/agent.ts via bound webContents
  });
  if (handlersRegistered) return;
  handlersRegistered = true;
  const trustedHandle: TrustedIpcHandle = handle;
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
    get activeOperationLog() { return activeOperationLog; },
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
    get activeSession() { return getWorkspaceSession(); },
    get activeIndex() { return getWorkspaceActiveIndex(); },
    get activeWorkspaceSessionId() { return getActiveWorkspaceSessionIdState(); },
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
    pushToolsSubdirs,
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
    get activeSession() { return getWorkspaceSession(); },
    durableStoragePaths,
    bridgeRootSession,
    bridgeRootsDiagnostic,
    pushToolsSubdirs,
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
    verifiedReadRoots
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
    getActiveRag: getWorkspaceRag,
    ensureActiveOperationLog,
    durableStoragePaths,
    currentToolContext,
    requestWriteConfirmation,
    readSystemPrompt
  });

  registerResourceIpcHandlers({
    handle: trustedHandle,
    getIndexedFiles: getWorkspaceIndexedFiles,
    getActiveIndex: getWorkspaceActiveIndex,
    getActiveSession: getWorkspaceSession,
    getActiveWorkspaceSessionId: getActiveWorkspaceSessionIdState,
    durableStoragePaths,
    ensureActiveOperationLog,
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
