import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeWorkspace,
  buildAiSidebarDraft,
  createAgentToolBridge,
  createConfiguredModelServiceAdapter,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  listRolloutSessions,
  loadRolloutSession,
  runAgentSession,
  disposeBridgeDaemonPool,
  commitEmevdMutationViaBridge,
  fingerprintEmedfRegistry,
  readFullEmevdDocumentViaBridge,
  renderEmevdPatchDslBounded,
  submitEmevdDslPlanViaFourView,
  resolveEmevdRegistry,
  buildScriptContainerEvidence,
  classifyScriptEntry,
  magicLabel,
  normalizePageWindow,
  sanitizeEntryName,
  applyParamFieldMutation,
  commitFmgMutationViaBridge,
  commitParamMutationViaBridge,
  commitMsbMutationViaBridge,
  readFmgDocumentViaBridge,
  readParamDocumentViaBridge,
  readMsbDocumentViaBridge,
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
  rollbackOperation,
  roundTripContainer,
  runBridge,
  saveRawReplace,
  saveTextResource,
  scanWorkspace,
  stageBridgeOutput,
  applyNativeMutation,
  validateContainer,
  isDeferredPreviewEditor,
  type NativeMutationOutcome,
  type RawReplaceCommitPort,
  type WriteConfirmationPort,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type ResourceCapabilityMatrix,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex,
  type WorkspaceSession,
  type ScriptContainerEntryEvidence,
  type ScriptEntryClassification
} from '@soulforge/core';
import {
  CONTAINER_PAGE_SIZE,
  FMG_PAGE_SIZE,
  PARAM_PAGE_SIZE,
  SCRIPT_PAGE_SIZE
} from '@soulforge/shared';
import type {
  ConfirmationReceipt,
  Diagnostic,
  EditorKind,
  EmevdEditorDocument,
  IndexedFile,
  ParamDefDocument,
  ResourceKind,
  StructuredDiagnostic
} from '@soulforge/shared';
import type {
  AgentEvent,
  ChatMessage,
  ResumedRollout,
  RolloutSessionMeta
} from '@soulforge/core';
import {
  sanitizeDiagnostics,
  sanitizeRendererValue,
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
import { executeRecoveryCleanup } from './recoveryCleanup.js';
import { ModelServiceCredentialVault } from './modelServiceCredentials.js';
import { MainMe3RuntimeGateway } from './me3RuntimeGateway.js';

let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
let activeSession: WorkspaceSession | null = null;
let activeOperationLog: OperationLogUtilityClient | null = null;
let activeWorkspaceSessionId: string | null = null;
/**
 * Authoritative full EMEVD editor documents keyed by sourceUri. Assembled in
 * main via paginated Bridge reads; the renderer only ever edits DSL text and
 * never holds these documents (hard constraint 18).
 */
const emevdFullDocuments = new Map<string, EmevdEditorDocument>();

/* ------------------------------------------------------------------ */
/*  Paginated editor access caches (hard constraint 17)                */
/*  Main holds the complete document; the renderer only ever receives  */
/*  bounded pages via resource.readFmgPage / resource.readParamPage /  */
/*  resource.listContainerChildrenPage. Each cache is invalidated on   */
/*  mutation commit so the next page fetch re-reads the fresh file.    */
/* ------------------------------------------------------------------ */

/*
 * 页大小来自 @soulforge/shared（唯一来源）。此前主进程、renderer 6 处面板与 e2e
 * harness 各写一遍字面量，任一侧改动都没有编译错误，症状是分页错位或末页重复。
 */
/** Upper bound for the paginated PARAM channel's complete-coverage read. */
const MAX_PAGED_PARAM_ROWS = 100_000;

interface CachedFmgDocument {
  sourceHash: string;
  maxId: number;
  entries: Array<{ id: number; text: string }>;
  authority?: string;
}
const fmgPageCache = new Map<string, CachedFmgDocument>();

interface CachedParamDocument {
  sourceHash: string;
  typeName: string;
  rowDataSize: number;
  rowCount: number;
  // dataBase64 is absent for params whose rows the Bridge serves without
  // payloads (rowCount > 32 or rowDataSize > 256) — the channel reports those
  // rows by id/name only and never fabricates bytes.
  rows: Array<{ id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
  authority?: string;
}
const paramPageCache = new Map<string, CachedParamDocument>();

type CachedContainerChildren = Awaited<
  ReturnType<typeof listContainerChildren>
>['children'];
const containerChildrenCache = new Map<string, CachedContainerChildren>();

/**
 * Classified script-container entry table keyed by sourceUri. Materialized
 * once in main and served as bounded pages so the renderer never holds the
 * full table. Enumeration uses the Bridge `read-dcx-document` command, which
 * returns the COMPLETE inner BND4 entry table (e.g. 301 entries for the real
 * luabnd) — `inventory-asset-resources` only samples entries, so it cannot
 * back a full-coverage page channel.
 */
interface CachedScriptContainerEntries {
  containerFormat: string;
  entryCount: number;
  entries: ScriptContainerEntryEvidence[];
  classificationSummary: Record<ScriptEntryClassification, number>;
  entriesComplete: boolean;
  diagnostics: StructuredDiagnostic[];
}
const scriptContainerEntriesCache = new Map<string, CachedScriptContainerEntries>();

function emptyScriptClassificationSummary(): Record<ScriptEntryClassification, number> {
  return {
    'lua-bytecode': 0,
    'luagnl': 0,
    'luainfo': 0,
    'esd-bytecode': 0,
    'hkx-bytecode': 0,
    'unknown': 0
  };
}

function summarizeScriptClassifications(
  entries: readonly ScriptContainerEntryEvidence[]
): Record<ScriptEntryClassification, number> {
  const summary = emptyScriptClassificationSummary();
  for (const entry of entries) {
    summary[entry.classification] += 1;
  }
  return summary;
}

/** Native BND4 entry fields surfaced by the Bridge `read-dcx-document` envelope. */
interface NativeBnd4EntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  unknown?: number;
  duplicateOrdinal?: number;
  nameOffset?: number;
  dataOffset?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

interface NativeBnd4DocumentLike {
  format?: string;
  entryCount?: number;
  entries?: NativeBnd4EntryLike[];
  authority?: string;
}

interface NativeDcxEnvelopeLike {
  format?: string;
  compressionFormat?: string;
  nested?: NativeBnd4DocumentLike;
}

/**
 * True when the file is a real (non-SFBN) BND3/BND4 binder or a DCX wrapper
 * (whose payload may be BND4). The TS container tree cannot enumerate these;
 * the native Bridge read-dcx-document command is the full-enumeration fallback.
 */
async function isRealNativeBndContainer(absolutePath: string): Promise<boolean> {
  try {
    const header = await readFile(absolutePath);
    const magic = header.subarray(0, 4).toString('ascii');
    if (magic.startsWith('BND3') || magic.startsWith('BND4')) {
      // Synthetic SFBN binders are enumerated by the TS reader; real BND has no
      // SFBN marker.
      return !header.subarray(4, 8).equals(Buffer.from('SFBN', 'ascii'));
    }
    return magic.startsWith('DCX');
  } catch {
    return false;
  }
}

/**
 * Load the complete container-child table for a paginated channel. Uses the TS
 * container tree (works for synthetic SFBN binders); when it returns zero
 * children for a real (non-SFBN) BND/DCX container, falls back to the native
 * Bridge full BND4 entry-table enumeration so real containers get complete
 * bounded access instead of an empty table (hard constraint 17).
 */
async function loadContainerChildrenTable(
  file: IndexedFile,
  sourceUri: string,
  recursive: boolean
): Promise<{ ok: boolean; children: CachedContainerChildren; diagnostics: StructuredDiagnostic[] }> {
  const result = await listContainerChildren(file.absolutePath, {
    relativePath: file.relativePath,
    recursive
  });
  if (!result.ok) return { ok: false, children: [], diagnostics: result.diagnostics };
  let children = result.children;
  if (children.length === 0 && await isRealNativeBndContainer(file.absolutePath)) {
    // The read/replace chain for real BND children remains TS-synthetic-only and
    // fails closed with structured diagnostics; enumeration is still honest.
    const native = await enumerateNativeContainerEntries(
      file.absolutePath,
      sourceUri,
      activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)]
    );
    if (!native.ok) return { ok: false, children: [], diagnostics: native.diagnostics };
    children = native.children;
  }
  return { ok: true, children, diagnostics: [] };
}

/**
 * Enumerate the complete inner BND4 entry table of a real (non-synthetic)
 * container via the Bridge `read-dcx-document` command — the same
 * full-enumeration source as `listScriptContainerEntriesPage`. Entries are
 * projected to the renderer-safe container-child DTO; inner names are sanitized
 * to their basename (Sekiro BND4 names are absolute build-machine paths).
 * `canReplace=false` keeps the real-BND replace chain fail-closed (it is
 * TS-synthetic-only today); `rawBytesAvailable=true` because
 * snapshot-bnd4-child can read real child bytes.
 */
async function enumerateNativeContainerEntries(
  absolutePath: string,
  sourceUri: string,
  allowedRoots: string[]
): Promise<{
  ok: boolean;
  children: CachedContainerChildren;
  diagnostics: StructuredDiagnostic[];
}> {
  const result = await runBridge<NativeDcxEnvelopeLike>({
    command: 'read-dcx-document',
    filePath: absolutePath,
    resourceUri: `file:///${absolutePath.replace(/\\/g, '/')}`,
    allowedRoots,
    timeoutMs: 60_000
  });
  if (result.parseStatus === 'failed') {
    return { ok: false, children: [], diagnostics: result.diagnostics };
  }
  const nested = result.data?.nested;
  const entries = nested?.entries ?? [];
  if (entries.length === 0) {
    return {
      ok: true,
      children: [],
      diagnostics: [{
        severity: 'info',
        code: 'BND_NATIVE_ENUMERATION_EMPTY',
        message: 'Bridge 未返回原生 BND4 条目表（payload 可能不是 BND4）。',
        sourceUri
      }]
    };
  }
  const seen = new Set<string>();
  const children = entries.map((entry) => {
    const rawName = entry.name ?? `entry_${entry.index ?? 0}`;
    const name = sanitizeEntryName(rawName, entry.index ?? 0, seen);
    const extension = name.split('.').pop()?.toLowerCase() ?? 'unknown';
    return {
      childId: String(entry.index ?? 0),
      name,
      offset: entry.dataOffset ?? 0,
      size: entry.uncompressedSize ?? 0,
      ...(entry.compressedSize !== undefined && entry.compressedSize !== entry.uncompressedSize
        ? { compressedSize: entry.compressedSize }
        : {}),
      hash: entry.contentHash ?? '',
      formatKind: extension,
      sourceContainerUri: sourceUri,
      childUri: `${sourceUri}#bnd/child/${encodeURIComponent(name)}`,
      rawBytesAvailable: true,
      canReplace: false,
      diagnostics: []
    } satisfies CachedContainerChildren[number];
  });
  return {
    ok: true,
    children,
    diagnostics: [{
      severity: 'info',
      code: 'BND_NATIVE_ENUMERATION_COMPLETE',
      message: `原生 BND4 完整条目表已枚举：${entries.length} 项（${result.data?.compressionFormat ?? ''} 解包）。`,
      sourceUri
    }]
  };
}

/** Inner BND4 entry row from the Bridge `read-dcx-document` command. */
interface ScriptDcxEntryLike {
  index?: number;
  id?: number;
  name?: string;
  flags?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  contentHash?: string;
}

interface ScriptDcxDocumentLike {
  format?: string;
  nested?: {
    format?: string;
    entryCount?: number;
    entries?: ScriptDcxEntryLike[];
    authority?: string;
  };
}

/** Bounded sample fallback from the Bridge `inventory-asset-resources` command. */
interface ScriptInventoryEntryLike {
  name?: string;
  index?: number;
  uncompressedSize?: number;
  compressedSize?: number;
  flags?: number;
  id?: number;
}

interface ScriptInventoryDataLike {
  format?: string;
  containerType?: string;
  entryCount?: number;
  entries?: ScriptInventoryEntryLike[];
  sampleEntries?: ScriptInventoryEntryLike[];
  extensionDistribution?: Record<string, number>;
  resourceKindDistribution?: Record<string, number>;
}

function clearEditorPageCaches(): void {
  fmgPageCache.clear();
  paramPageCache.clear();
  containerChildrenCache.clear();
  scriptContainerEntriesCache.clear();
}

/**
 * Cached EMEDF registry. Resolved once from the user-provided external
 * DarkScript3 EMEDF JSON path (env SOULFORGE_EMEDF_PATH) or falls back
 * to the built-in fixture. SoulForge does NOT bundle EMEDF data.
 */
let cachedEmevdRegistry: ReturnType<typeof resolveEmevdRegistry> | null = null;
function getEmevdRegistry(): ReturnType<typeof resolveEmevdRegistry> {
  if (!cachedEmevdRegistry) {
    const externalPath = process.env.SOULFORGE_EMEDF_PATH || null;
    cachedEmevdRegistry = resolveEmevdRegistry(externalPath);
  }
  return cachedEmevdRegistry;
}
let handlersRegistered = false;
const trustedRendererDocuments = new Map<number, string>();
const directorySelections = new Map<string, DirectorySelectionRecord>();
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

export interface RendererWorkspaceScanResult {
  workspaceSessionId: string;
  workspaceLabel: string;
  files: RendererIndexedFile[];
  countsByKind: Record<ResourceKind, number>;
  diagnostics: Diagnostic[];
  session: RendererWorkspaceSession;
}

export interface RollbackOperationIpcResult {
  ok: boolean;
  opId: string;
  inverseOpId?: string;
  restoredFiles: string[];
  diagnostics: Diagnostic[];
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
  event: AgentEvent | AiAgentSessionLifecycleEvent;
}

export interface DirectorySelection {
  selectionId: string;
  label: string;
}

export interface OpenWorkspaceScanOptions {
  overlaySelectionId: string;
  baseSelectionId?: string;
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
  backupBaseDir: string;
  recoveryDir: string;
  stagingRoot: string;
} {
  const { backupBaseDir, recoveryDir, stagingRoot } = workspaceStoragePaths(workspaceId);
  return { backupBaseDir, recoveryDir, stagingRoot };
}

function bridgeAllowedRoots(session: WorkspaceSession, stagingRoot?: string): string[] {
  return [
    session.layers.overlayRoot,
    ...(session.layers.baseRoot ? [session.layers.baseRoot] : []),
    ...(stagingRoot ? [stagingRoot] : [])
  ];
}

function rejectNonSekiroNativeWrite(sourceUri: string, file?: IndexedFile): RendererSaveResult | null {
  if (activeSession?.meta.game === 'sekiro' && file?.game === 'sekiro') return null;
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

/**
 * 阻断已延期至 V0.6、仅保留标记只读预览的编辑器写入。
 * 门禁点放在 IPC 主进程而非 renderer：即使 UI 仍持有旧的提交入口，
 * 写路径也在进入 Patch Engine 之前失败关闭，并返回结构化诊断。
 */
function rejectDeferredPreviewEditorWrite(
  editorKind: EditorKind,
  sourceUri: string
): RendererSaveResult | null {
  if (!isDeferredPreviewEditor(editorKind)) return null;
  return {
    ok: false,
    changedFiles: [],
    diagnostics: [{
      severity: 'error',
      code: 'EDITOR_DEFERRED_TO_V06_READONLY',
      message: `${editorKind} 编辑器已延期至 V0.6，本版仅提供标记只读预览，写入已阻断。`,
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
  event: IpcMainInvokeEvent;
  resourceLabel: string;
  sourceUri: string;
  actionLabel: string;
  payloadHash: string;
  extraSubjects?: string[];
}): Promise<ConfirmationReceipt | null> {
  if (!activeWorkspaceSessionId) return null;
  const parent = BrowserWindow.fromWebContents(input.event.sender);
  const options = {
    type: 'warning' as const,
    title: '确认高风险写入',
    message: `确认${input.actionLabel}“${input.resourceLabel}”吗？`,
    detail: '操作将只通过补丁引擎写入 Mod 覆盖层，并执行验证、备份和可回滚检查。原生格式证据不足时仍会阻断。',
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const decision = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  if (decision.response !== 1) return null;
  return createConfirmationReceipt({
    subjects: [
      'MAIN_NATIVE_DIALOG_CONFIRMED',
      input.sourceUri,
      'ALL_RISKS',
      `WORKSPACE_SESSION:${activeWorkspaceSessionId}`,
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
    commit: (input) => saveRawReplace({
      file: input.file,
      expectedHash: input.expectedHash,
      newContentBase64: input.newContentBase64,
      title: input.title,
      ...(input.confirmation ? { confirmation: input.confirmation } : {}),
      session,
      operationLog,
      backupBaseDir: storage.backupBaseDir,
      recoveryDir: storage.recoveryDir
    })
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
    for (const [selectionId, selection] of directorySelections) {
      if (selection.ownerWebContentsId === webContents.id) directorySelections.delete(selectionId);
    }
  });
  if (handlersRegistered) return;
  handlersRegistered = true;

  handle('runtime.detectMe3', async () => {
    const adapter = new Me3RuntimeAdapter({
      gateway: new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() }),
      versionPolicy: {
        policyId: 'soulforge.me3-v0_12_1',
        supportedVersions: ['0.12.1']
      }
    });
    return await adapter.detect({ timeoutMs: 5_000 });
  });

  // Shared runtime adapter instance for profile/launch/terminate lifecycle
  let runtimeAdapter: Me3RuntimeAdapter | null = null;
  let runtimeGateway: MainMe3RuntimeGateway | null = null;
  function ensureRuntimeAdapter(): Me3RuntimeAdapter {
    if (!runtimeAdapter) {
      runtimeGateway = new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() });
      runtimeAdapter = new Me3RuntimeAdapter({
        gateway: runtimeGateway,
        versionPolicy: {
          policyId: 'soulforge.me3-v0_12_1',
          supportedVersions: ['0.12.1']
        }
      });
    }
    return runtimeAdapter;
  }

  handle('runtime.prepareMe3Profile', async () => {
    if (!activeSession || !activeWorkspaceSessionId) {
      return {
        ok: false,
        status: 'failed' as const,
        authority: 'unverified' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RUNTIME_NO_WORKSPACE',
          message: '需要已打开的工作区才能准备 me3 配置文件。'
        }]
      };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.prepareProfile(
      { workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro' },
      { timeoutMs: 30_000 }
    );
    return sanitizeRendererValue(result);
  });

  handle('runtime.launchMe3', async (_event, profileId: string) => {
    if (!activeWorkspaceSessionId) {
      return {
        ok: false,
        status: 'failed' as const,
        authority: 'unverified' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RUNTIME_NO_WORKSPACE',
          message: '需要已打开的工作区才能启动 me3。'
        }]
      };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.launch(
      {
        profile: {
          profileId,
          workspaceSessionId: activeWorkspaceSessionId,
          game: 'sekiro',
          profileVersion: 'v1',
          contentSha256: ''
        }
      },
      { timeoutMs: 15_000 }
    );
    return sanitizeRendererValue(result);
  });

  handle('runtime.terminateMe3', async (_event, sessionId: string) => {
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.terminate(
      {
        sessionId,
        game: 'sekiro',
        state: 'running',
        startedAt: new Date().toISOString(),
        diagnostics: []
      },
      { timeoutMs: 10_000 }
    );
    return sanitizeRendererValue(result);
  });

  handle('workspace.openDialog', async (event): Promise<DirectorySelection | null> => {
    const result = await dialog.showOpenDialog({
      title: '打开 Mod 工作区',
      properties: ['openDirectory']
    });

    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    return selectedPath ? createDirectorySelection(event, selectedPath, 'overlay') : null;
  });

  handle('workspace.openBaseDialog', async (event): Promise<DirectorySelection | null> => {
    const result = await dialog.showOpenDialog({
      title: '打开原版游戏目录（只读，可选）',
      properties: ['openDirectory']
    });

    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    return selectedPath ? createDirectorySelection(event, selectedPath, 'base') : null;
  });

  handle(
    'workspace.scan',
    async (
      event,
      options: OpenWorkspaceScanOptions
    ): Promise<RendererWorkspaceScanResult> => {
      const overlaySelection = consumeDirectorySelection(event, options.overlaySelectionId, 'overlay');
      const baseSelection = options.baseSelectionId
        ? consumeDirectorySelection(event, options.baseSelectionId, 'base')
        : undefined;

      if (activeSession) await disposeBridgeDaemonPool();
      activeSession = await openWorkspaceSession({
        overlayRoot: overlaySelection.absolutePath,
        ...(baseSelection ? { baseRoot: baseSelection.absolutePath } : {}),
        game: 'sekiro'
      });
      clearEditorPageCaches();
      activeWorkspaceSessionId = randomUUID();
      const database = await ensureActiveOperationLog(activeSession);
      const scanJobId = randomUUID();
      const scanStartedAt = new Date().toISOString();
      await database.upsertJob({
        jobId: scanJobId,
        title: '扫描工作区',
        jobKind: 'workspace_scan',
        status: 'running',
        progress: { current: 0, message: '正在扫描文件' },
        payload: { workspaceSessionId: activeWorkspaceSessionId },
        createdAt: scanStartedAt,
        startedAt: scanStartedAt,
        updatedAt: scanStartedAt
      });
      let result: Awaited<ReturnType<typeof scanWorkspace>>;
      try {
        result = await scanWorkspace({
          workspaceRoot: activeSession.layers.overlayRoot,
          game: activeSession.meta.game
        });
        await database.replaceFiles(result.files);
        const recordedAt = new Date().toISOString();
        await database.replaceDiagnostics([
          ...result.diagnostics,
          ...result.files.flatMap((file) => file.diagnostics)
        ].map((diagnostic) => ({
          id: randomUUID(),
          ...diagnostic,
          createdAt: recordedAt,
          suppressed: false
        })));
        await database.upsertJob({
          jobId: scanJobId,
          title: '扫描工作区',
          jobKind: 'workspace_scan',
          status: 'completed',
          progress: { current: result.files.length, total: result.files.length },
          payload: { workspaceSessionId: activeWorkspaceSessionId },
          result: { fileCount: result.files.length },
          createdAt: scanStartedAt,
          startedAt: scanStartedAt,
          completedAt: recordedAt,
          updatedAt: recordedAt
        });
      } catch (error) {
        const failedAt = new Date().toISOString();
        await database.upsertJob({
          jobId: scanJobId,
          title: '扫描工作区',
          jobKind: 'workspace_scan',
          status: 'failed',
          progress: { current: 0 },
          payload: { workspaceSessionId: activeWorkspaceSessionId },
          error: { message: error instanceof Error ? error.message : String(error) },
          createdAt: scanStartedAt,
          startedAt: scanStartedAt,
          completedAt: failedAt,
          updatedAt: failedAt
        });
        throw error;
      }
      indexedFiles = result.files;
      activeIndex = null;
      return {
        workspaceSessionId: activeWorkspaceSessionId,
        workspaceLabel: overlaySelection.label,
        files: result.files.map(toRendererIndexedFile),
        diagnostics: sanitizeDiagnostics(result.diagnostics),
        countsByKind: result.countsByKind,
        session: {
          workspaceSessionId: activeWorkspaceSessionId,
          workspaceLabel: overlaySelection.label,
          game: activeSession.meta.game,
          openedAt: activeSession.meta.openedAt,
          baseMounted: !activeSession.meta.baseMissing,
          ...(baseSelection ? { baseLabel: baseSelection.label } : {})
        }
      };
    }
  );

  handle('workspace.analyze', async (): Promise<AnalyzeWorkspaceSummary> => {
    if (!activeSession) throw new Error('请先打开工作区。');
    const result = await analyzeWorkspace({
      workspaceRoot: activeSession.layers.overlayRoot,
      ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
    });
    activeIndex = result.index;

    return {
      parsedFiles: result.parsedFiles,
      inspectedFiles: result.inspectedFiles,
      referenceStats: result.referenceStats,
      diagnostics: sanitizeDiagnostics(result.diagnostics),
      events: result.index.searchEvents('', 200).map(({ item }) => ({
        uri: item.uri,
        eventId: item.eventId,
        ...(item.name ? { name: item.name } : {})
      })),
      tools: toolRegistry.list()
    };
  });

  handle('resource.preview', async (_event, sourceUri: string): Promise<RendererResourcePreview | null> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return toRendererResourcePreview(await openResourcePreview({
      file,
      inspectNative: true,
      parseStructured: true,
      ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
    }));
  });

  handle('resource.saveText', async (_event, sourceUri: string, newText: string): Promise<RendererSaveResult> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        changedFiles: [],
        diagnostics: [
          {
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before it can be saved.',
            sourceUri
          }
        ]
      };
    }

    const operationLog = activeSession
      ? await ensureActiveOperationLog(activeSession)
      : undefined;
    const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;

    let result = await saveTextResource({
      file,
      newText,
      ...(activeSession ? { session: activeSession } : {}),
      ...(operationLog ? { operationLog } : {}),
      ...(storage ?? {})
    });
    if (!result.ok && result.requiresConfirmation) {
      const confirmation = await requestWriteConfirmation({
        event: _event,
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '保存',
        payloadHash: createHash('sha256').update(newText).digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      result = await saveTextResource({
        file,
        newText,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
    }
    if (result.ok) {
      const refreshed = await openResourcePreview({
        file,
        inspectNative: true,
        parseStructured: true,
        ...(activeSession?.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
      });
      const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) indexedFiles[index] = refreshed.file;
    }
    return toRendererSaveResult(result, indexedFiles);
  });

  handle('resource.search', async (_event, query: string) => {
    const normalized = query.trim().toLowerCase();
    const items = normalized.length === 0
      ? indexedFiles
      : indexedFiles.filter((file) => {
          return file.relativePath.toLowerCase().includes(normalized) || file.resourceKind.includes(normalized);
        });

    return items.map(toRendererIndexedFile);
  });

  handle(
    'resource.readRawRange',
    async (_event, sourceUri: string, offset: number, length: number) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          sourceUri,
          offset,
          length,
          fileSize: 0,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw range read.',
            sourceUri
          }]
        };
      }
      return readRawResourceRange(file, offset, length);
    }
  );

  handle('resource.readRawMetadata', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const meta = await readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
    // 必须脱敏：RawResourceMetadata 含 absolutePath（rawRead.ts:16），而
    // verify-desktop-security-runtime.mjs 把 absolutePath 列为泄漏键。此前这里
    // 直接 return 原对象，等于把本机绝对路径送进 renderer——同文件其余 handler
    // （:675/:904/:933/:948）都走了 sanitizeRendererValue，只有这一条漏了。
    // 该 channel 此前 renderer 零引用，所以泄漏一直没被触发；接线前必须先补上。
    return sanitizeRendererValue(meta);
  });

  /** Renderer-safe EMEVD envelope (no absolute paths). */
  handle('resource.readEmevdDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 EMEVD。',
          sourceUri
        }]
      };
    }
    try {
      const result = await runBridge<{
        sourceHash?: string;
        eventCount?: number;
        instructionCount?: number;
        events?: unknown[];
        instructionsSample?: unknown[];
        authority?: string;
        supportsEventGc?: boolean;
      }>({
        command: 'read-emevd-document',
        filePath: file.absolutePath,
        allowedRoots: activeSession
          ? bridgeAllowedRoots(activeSession)
          : [dirname(file.absolutePath)],
        timeoutMs: 120_000
      });
      return sanitizeRendererValue({
        ok: result.parseStatus !== 'failed',
        sourceUri,
        relativePath: file.relativePath,
        data: result.data
          ? {
              sourceHash: result.data.sourceHash,
              eventCount: result.data.eventCount,
              instructionCount: result.data.instructionCount,
              events: result.data.events,
              instructionsSample: result.data.instructionsSample,
              authority: result.data.authority,
              supportsEventGc: result.data.supportsEventGc === true
            }
          : null,
        diagnostics: sanitizeDiagnostics(result.diagnostics)
      });
    } catch (error) {
      return {
        ok: false,
        sourceUri,
        diagnostics: [{
          severity: 'error' as const,
          code: 'EMEVD_READ_FAILED',
          message: 'EMEVD 读取失败；底层路径与运行时详情已隐藏。',
          sourceUri
        }]
      };
    }
  });

  /**
   * Stage EMEVD mutation via Bridge, then whole-file replace through Patch Engine.
   * Mutation object is Bridge-native (set_rest_behavior / set_instruction_args / add_event / …).
   */
  handle(
    'resource.applyEmevdMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: Record<string, unknown>
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 EMEVD。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const bridgeMutation = {
        kind: String(mutation.kind ?? mutation.mutation ?? ''),
        ...mutation
      } as Parameters<typeof commitEmevdMutationViaBridge>[0]['mutation'];
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: (stagingRoot) => bridgeAllowedRoots(activeSession!, stagingRoot),
        stagingPrefix: 'emevd',
        stagingFileName: `${basename(file.relativePath)}.mut.emevd`,
        stageWrite: (context) => commitEmevdMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation,
          ...(typeof mutation.instructionIndex === 'number'
            ? { instructionIndex: mutation.instructionIndex }
            : {}),
          timeoutMs: 120_000
        }),
        title: `EMEVD mutation ${String(mutation.kind ?? 'edit')}`,
        confirmActionLabel: '提交 EMEVD 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) {
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
        });
        const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
        if (index >= 0) indexedFiles[index] = refreshed.file;
      }
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  /**
   * Assemble the authoritative full EMEVD editor document in main via
   * paginated Bridge reads (DCX unwrapped on demand). The renderer only ever
   * receives a DSL template string and a documentInstanceId, never the full
   * document. The prepared decompressed path is cached for later writes.
   */
  handle(
    'resource.readEmevdFullDocument',
    async (_event, sourceUri: string, documentInstanceId: string, loadFullDslTemplate?: boolean) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: '资源未索引，无法组装完整 EMEVD 文档。',
            sourceUri
          }]
        };
      }
      if (!activeSession) {
        return {
          ok: false,
          diagnostics: [{
            severity: 'error' as const,
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能组装完整 EMEVD 文档。',
            sourceUri
          }]
        };
      }
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const full = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: bridgeAllowedRoots(activeSession, storage.stagingRoot),
        tempDir: storage.stagingRoot,
        resourceUri: sourceUri,
        registry: getEmevdRegistry().registry,
        ...(documentInstanceId ? { documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (!full.ok || !full.document) {
        return {
          ok: false,
          sourceUri,
          diagnostics: full.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      emevdFullDocuments.set(sourceUri, full.document);
      // Hard constraint 17: the template is bounded so a real corpus document
      // (~70K+ DSL lines) is never transferred in one IPC payload. The renderer
      // can request the full template explicitly via loadFullDslTemplate.
      const bounded = renderEmevdPatchDslBounded(
        full.document,
        getEmevdRegistry().registry,
        loadFullDslTemplate ? undefined : 2000
      );
      return {
        ok: true,
        sourceUri,
        documentInstanceId,
        revision: full.document.revision,
        eventCount: full.document.events.length,
        instructionCount: full.instructionTotal,
        dslTemplate: bounded.text,
        dslTemplateTruncated: bounded.truncated,
        dslTemplateTotalLines: bounded.totalLines,
        sourceHash: full.sourceHash ?? null,
        preparedSourcePath: full.preparedSourcePath ?? null,
        diagnostics: full.diagnostics.map((d) => ({
          severity: d.severity as Diagnostic['severity'],
          code: d.code,
          message: d.message,
          sourceUri
        }))
      };
    }
  );

  /**
   * Submit a DSL patch authored in the renderer's four-view panel. The full
   * document is held in main (loaded by readEmevdFullDocument); compile →
   * typed plan → Bridge batch staging → file_replace PatchIR →
   * WorkspaceTransaction. On success the authoritative document cache and the
   * resource preview are refreshed.
   */
  handle(
    'resource.submitEmevdDslPlan',
    async (event, sourceUri: string, sourceText: string): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能提交 EMEVD DSL。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const document = emevdFullDocuments.get(sourceUri);
      if (!document) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'EMEVD_FULL_DOCUMENT_MISSING',
            message: '请先加载完整 EMEVD 文档（readEmevdFullDocument）再提交 DSL。',
            sourceUri
          }]
        };
      }
      // Re-resolve the decompressed staging source (DCX inputs were unwrapped
      // during load and cached as a temp file; raw .emevd uses the indexed path).
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const operationLog = await ensureActiveOperationLog(activeSession);
      const registry = getEmevdRegistry().registry;
      const full = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: bridgeAllowedRoots(activeSession, storage.stagingRoot),
        tempDir: storage.stagingRoot,
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (!full.ok || !full.document) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: full.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const fresh = full.document;
      const preparedPath = full.preparedSourcePath ?? file.absolutePath;
      const schemaFingerprint = fingerprintEmedfRegistry(registry);
      const result = await submitEmevdDslPlanViaFourView({
        compileRequest: {
          schemaVersion: 1,
          resourceUri: sourceUri,
          documentInstanceId: fresh.documentInstanceId ?? '',
          baseRevision: fresh.revision,
          emedfSchemaFingerprint: schemaFingerprint,
          sourceText,
          mode: 'patch'
        },
        document: fresh,
        registry,
        sourcePath: preparedPath,
        expectedDocumentHash: full.sourceHash ?? '',
        allowedRoots: bridgeAllowedRoots(activeSession, storage.stagingRoot),
        workspaceId: activeSession.meta.workspaceId,
        workspaceRoot: activeSession.layers.overlayRoot,
        stagingRoot: storage.stagingRoot,
        ...(activeSession ? { session: activeSession } : {}),
        operationLog,
        backupBaseDir: storage.backupBaseDir,
        recoveryDir: storage.recoveryDir,
        timeoutMs: 120_000
      });
      if (!result.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: result.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      // Refresh authoritative cache + indexed preview from the committed file.
      const refreshed = await readFullEmevdDocumentViaBridge({
        filePath: file.absolutePath,
        allowedRoots: bridgeAllowedRoots(activeSession, storage.stagingRoot),
        tempDir: storage.stagingRoot,
        resourceUri: sourceUri,
        registry,
        ...(document.documentInstanceId !== undefined ? { documentInstanceId: document.documentInstanceId } : {}),
        pageSize: 512,
        timeoutMs: 120_000
      });
      if (refreshed.ok && refreshed.document) {
        emevdFullDocuments.set(sourceUri, refreshed.document);
      }
      const preview = await openResourcePreview({
        file,
        inspectNative: true,
        parseStructured: true,
        ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
      });
      const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
      if (index >= 0) indexedFiles[index] = preview.file;
      return {
        ok: true,
        changedFiles: [sourceUri],
        diagnostics: [
          ...result.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          })),
          {
            severity: 'info',
            code: 'EMEVD_DSL_PLAN_COMMITTED',
            message: `DSL 计划已提交（revision ${fresh.revision} → ${refreshed.document?.revision ?? fresh.revision + 1}）。`,
            sourceUri
          }
        ]
      };
    }
  );

  handle('resource.readFmgDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 FMG。',
          sourceUri
        }]
      };
    }
    const result = await readFmgDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: activeSession
        ? bridgeAllowedRoots(activeSession)
        : [dirname(file.absolutePath)]
    });
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            entryCount: result.data.entryCount,
            // Cap rows for renderer safety
            entries: result.data.entries.slice(0, 500).map((e) => ({
              id: e.id,
              text: e.text
            })),
            entriesTruncated: result.data.entries.length > 500,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  /**
   * Paginated FMG entry access (hard constraint 17). Main assembles/caches the
   * complete entry list once and serves bounded pages; the renderer never
   * receives the full document. `query` filters the complete list in main, so
   * search still covers every page.
   */
  handle(
    'resource.readFmgPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string) => ({
        ok: false,
        sourceUri,
        sourceHash: null,
        entryCount: 0,
        maxId: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        entries: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页读取 FMG。');
      }
      let cached = fmgPageCache.get(sourceUri);
      if (!cached) {
        const result = await readFmgDocumentViaBridge({
          sourcePath: file.absolutePath,
          allowedRoots: activeSession
            ? bridgeAllowedRoots(activeSession)
            : [dirname(file.absolutePath)]
        });
        if (!result.ok || !result.data) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            entryCount: 0,
            maxId: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            entries: [],
            diagnostics: result.diagnostics
          };
        }
        cached = {
          sourceHash: result.data.sourceHash,
          maxId: result.data.entries.reduce((max, entry) => Math.max(max, entry.id), 0),
          entries: result.data.entries,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        fmgPageCache.set(sourceUri, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.entries
        : cached.entries.filter((entry) =>
            String(entry.id).includes(q) || entry.text.toLowerCase().includes(q)
          );
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || FMG_PAGE_SIZE
      );
      return {
        ok: true,
        sourceUri,
        sourceHash: cached.sourceHash,
        entryCount: filtered.length,
        maxId: cached.maxId,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        entries: filtered
          .slice(window.offset, window.offset + window.size)
          .map((entry) => ({ id: entry.id, text: entry.text })),
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: []
      };
    }
  );

  handle(
    'resource.applyFmgMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: { kind: 'upsert' | 'delete' | 'add'; id: number; text?: string }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'FMG_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 FMG。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const bridgeMutation =
        mutation.kind === 'delete'
          ? { kind: 'delete' as const, id: mutation.id }
          : mutation.kind === 'add'
            ? { kind: 'add' as const, id: mutation.id, text: mutation.text ?? '' }
            : { kind: 'upsert' as const, id: mutation.id, text: mutation.text ?? '' };
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: (stagingRoot) => bridgeAllowedRoots(activeSession!, stagingRoot),
        stagingPrefix: 'fmg',
        stagingFileName: `${basename(file.relativePath)}.mut.fmg`,
        stageWrite: (context) => commitFmgMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        }),
        title: `FMG mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 FMG 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) fmgPageCache.delete(sourceUri);
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle('resource.readMsbDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 MSB。',
          sourceUri
        }]
      };
    }
    const result = await readMsbDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: activeSession
        ? bridgeAllowedRoots(activeSession)
        : [dirname(file.absolutePath)],
      maxParts: 256,
      maxRegions: 128,
      maxModels: 128,
      maxEvents: 128
    });
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            version: result.data.version,
            modelCount: result.data.modelCount,
            partCount: result.data.partCount,
            regionCount: result.data.regionCount,
            eventCount: result.data.eventCount,
            models: result.data.models,
            parts: result.data.parts,
            regions: result.data.regions,
            events: result.data.events,
            authority: result.data.authority,
            entityEdit: result.data.entityEdit
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  handle('resource.readTaeDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TAE。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tae-document',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readEsdDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 ESD。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-esd-document',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-document',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readTpfDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 TPF。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-tpf-document',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverMesh', async (_event, sourceUri: string, meshIndex: number) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 网格。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-mesh',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000,
      commandOptions: { meshIndex }
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverSkeleton', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 骨骼层级。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-skeleton',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle('resource.readFlverDummies', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return { ok: false, diagnostics: [{ severity: 'error' as const, code: 'RESOURCE_NOT_INDEXED', message: '资源未索引，无法读取 FLVER 挂点。', sourceUri }] };
    }
    const result = await runBridge<Record<string, unknown>>({
      command: 'read-flver-dummies',
      filePath: file.absolutePath,
      allowedRoots: activeSession ? bridgeAllowedRoots(activeSession) : [dirname(file.absolutePath)],
      timeoutMs: 120_000
    });
    return sanitizeRendererValue({ ok: result.parseStatus !== 'failed', sourceUri, relativePath: file.relativePath, data: result.data, diagnostics: result.diagnostics });
  });

  handle(
    'resource.applyMsbMutation',
    async (
      event,
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
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'MSB_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 MSB。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      const deferredBlocked = rejectDeferredPreviewEditorWrite('msb', sourceUri);
      if (deferredBlocked) return deferredBlocked;
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: (stagingRoot) => bridgeAllowedRoots(activeSession!, stagingRoot),
        stagingPrefix: 'msb',
        stagingFileName: `${basename(file.relativePath)}.mut.msb`,
        stageWrite: (context) => commitMsbMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation
        }),
        title: `MSB mutation ${mutation.kind} ${mutation.partName}`,
        confirmActionLabel: '提交 MSB 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle('resource.readParamDocument', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: '资源未索引，无法读取 PARAM。',
          sourceUri
        }]
      };
    }
    const result = await readParamDocumentViaBridge({
      sourcePath: file.absolutePath,
      allowedRoots: activeSession
        ? bridgeAllowedRoots(activeSession)
        : [dirname(file.absolutePath)],
      maxRows: 500
    });
    return sanitizeRendererValue({
      ok: result.ok,
      sourceUri,
      relativePath: file.relativePath,
      data: result.data
        ? {
            sourceHash: result.data.sourceHash,
            typeName: result.data.typeName,
            rowCount: result.data.rowCount,
            rowDataSize: result.data.rowDataSize,
            rows: result.data.rows.map((r) => ({
              id: r.id,
              dataBase64: r.dataBase64,
              dataHash: r.dataHash,
              ...(r.name ? { name: r.name } : {}),
              dataHexPreview: Buffer.from(r.dataBase64, 'base64')
                .subarray(0, 16)
                .toString('hex')
            })),
            rowsTruncated: result.data.rowCount > result.data.rows.length,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  /**
   * Paginated PARAM row access (hard constraint 17). Main assembles/caches the
   * complete row table once (up to MAX_PAGED_PARAM_ROWS) and serves bounded
   * pages; the renderer never receives the whole document. `query` filters the
   * complete table in main so search covers every page. Rows carry full bytes
   * so the renderer can duplicate rows and edit fields without the full set.
   */
  handle(
    'resource.readParamPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      query?: string
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string) => ({
        ok: false,
        sourceUri,
        sourceHash: null,
        rowCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        rows: [],
        rowsTruncated: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页读取 PARAM。');
      }
      let cached = paramPageCache.get(sourceUri);
      if (!cached) {
        // NOTE: reads the real document through the Bridge directly (not via
        // readParamDocumentViaBridge) because that helper sends no
        // commandOptions: the C# read-param-document handler calls
        // options.TryGetProperty on a default JsonElement and throws
        // InvalidOperationException for every real gameparam. ROOT CAUSE belongs
        // in packages/core/src/editing/paramBridgeCommit.ts (pass
        // commandOptions: {}); this channel passes an explicit empty object so
        // the real-corpus paginated channel stays functional (hard constraint 17).
        const result = await runBridge<{
          sourceHash?: string;
          typeName?: string;
          dataVersion?: number;
          rowCount?: number;
          rowDataSize?: number;
          rows?: Array<{ id: number; dataBase64?: string | null; dataHash: string; name?: string }>;
          authority?: string;
        }>({
          command: 'read-param-document',
          filePath: file.absolutePath,
          allowedRoots: activeSession
            ? bridgeAllowedRoots(activeSession)
            : [dirname(file.absolutePath)],
          timeoutMs: 60_000,
          commandOptions: {}
        });
        if (result.parseStatus === 'failed' || !result.data?.sourceHash) {
          return {
            ok: false,
            sourceUri,
            sourceHash: null,
            rowCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            rows: [],
            rowsTruncated: false,
            diagnostics: result.diagnostics
          };
        }
        const rows = (result.data.rows ?? []).slice(0, MAX_PAGED_PARAM_ROWS);
        cached = {
          sourceHash: result.data.sourceHash,
          typeName: result.data.typeName ?? 'UNKNOWN_PARAM',
          rowDataSize: result.data.rowDataSize ?? 0,
          rowCount: result.data.rowCount ?? rows.length,
          rows,
          ...(result.data.authority ? { authority: result.data.authority } : {})
        };
        paramPageCache.set(sourceUri, cached);
      }
      const q = (query ?? '').trim().toLowerCase();
      const filtered = q.length === 0
        ? cached.rows
        : cached.rows.filter((row) =>
            String(row.id).includes(q) || (row.name ?? '').toLowerCase().includes(q)
          );
      const window = normalizePageWindow(
        filtered.length,
        requestedPage,
        requestedPageSize || PARAM_PAGE_SIZE
      );
      return {
        ok: true,
        sourceUri,
        sourceHash: cached.sourceHash,
        typeName: cached.typeName,
        rowDataSize: cached.rowDataSize,
        rowCount: filtered.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        rows: filtered
          .slice(window.offset, window.offset + window.size)
          .map((row) => ({
            id: row.id,
            // The Bridge only includes row payloads for small params
            // (rowCount <= rowPreviewLimit and rowDataSize <= 256); for larger
            // real params rows arrive without dataBase64. Keep the DTO honest:
            // carry payloads when present, otherwise expose the row id/name only
            // so the channel never fabricates bytes or throws on null payloads.
            ...(typeof row.dataBase64 === 'string'
              ? {
                  dataBase64: row.dataBase64,
                  dataHexPreview: Buffer.from(row.dataBase64, 'base64')
                    .subarray(0, 16)
                    .toString('hex')
                }
              : {}),
            ...(row.name ? { name: row.name } : {})
          })),
        rowsTruncated: cached.rowCount > cached.rows.length,
        ...(cached.authority ? { authority: cached.authority } : {}),
        diagnostics: []
      };
    }
  );

  handle(
    'resource.applyParamMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: { kind: 'upsert' | 'delete'; id: number; dataBase64?: string }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;
      if (mutation.kind === 'upsert' && !mutation.dataBase64) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_UPSERT_DATA_REQUIRED',
            message: 'PARAM upsert 需要 dataBase64。',
            sourceUri
          }]
        };
      }
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const bridgeMutation =
        mutation.kind === 'delete'
          ? { kind: 'delete' as const, id: mutation.id }
          : { kind: 'upsert' as const, id: mutation.id, dataBase64: mutation.dataBase64! };
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: (stagingRoot) => bridgeAllowedRoots(activeSession!, stagingRoot),
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.mut.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        }),
        title: `PARAM mutation ${mutation.kind} ${mutation.id}`,
        confirmActionLabel: '提交 PARAM 变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) paramPageCache.delete(sourceUri);
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle(
    'resource.applyParamFieldMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        rowId: number;
        fieldId: string;
        value: number | string | boolean;
        rowDataBase64: string;
        definition: unknown;
      }
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file || !activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'PARAM_WRITE_NO_SESSION',
            message: '需要已打开的工作区才能写入 PARAM。',
            sourceUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(sourceUri, file);
      if (gameBlocked) return gameBlocked;

      // Apply field-level mutation to get the modified row bytes
      const fieldResult = applyParamFieldMutation({
        rowDataBase64: mutation.rowDataBase64,
        definition: mutation.definition as ParamDefDocument,
        fieldId: mutation.fieldId,
        value: mutation.value
      });
      if (!fieldResult.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: fieldResult.code,
            message: fieldResult.message,
            sourceUri
          }]
        };
      }

      // Send the modified row as a whole-row upsert to the Bridge
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      const operationLog = await ensureActiveOperationLog(activeSession);
      const outcome = await applyNativeMutation({
        file,
        sourceUri,
        expectedHash,
        stagingRoot: storage.stagingRoot,
        allowedRoots: (stagingRoot) => bridgeAllowedRoots(activeSession!, stagingRoot),
        stagingPrefix: 'param',
        stagingFileName: `${basename(file.relativePath)}.field.param`,
        stageWrite: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: { kind: 'upsert' as const, id: mutation.rowId, dataBase64: fieldResult.nextDataBase64 }
        }),
        title: `PARAM field set ${mutation.fieldId} on row ${mutation.rowId}`,
        confirmActionLabel: '提交 PARAM 字段变更'
      }, {
        confirm: electronConfirmationPort(event),
        commit: sessionCommitPort(activeSession, operationLog, storage)
      });
      if (outcome.status === 'committed' && outcome.result.ok) paramPageCache.delete(sourceUri);
      return toSaveResultFromOutcome(outcome, indexedFiles);
    }
  );

  handle('resource.inspectContainerTree', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container inspect.',
          sourceUri
        }]
      };
    }
    return inspectContainerTree(file.absolutePath, { relativePath: file.relativePath });
  });

  handle(
    'resource.listContainerChildren',
    async (_event, sourceUri: string, recursive?: boolean) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          children: [],
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before listing container children.',
            sourceUri
          }]
        };
      }
      return listContainerChildren(file.absolutePath, {
        relativePath: file.relativePath,
        recursive: recursive === true
      });
    }
  );

  /**
   * Paginated container-child entry access (hard constraint 17). BND4/script
   * containers may expose hundreds of entries; main materializes the entry
   * table once and serves bounded pages so the renderer never holds the whole
   * table. Children are projected to the renderer-safe DTO subset (no absolute
   * paths / diagnostics cross the bridge).
   */
  handle(
    'resource.listContainerChildrenPage',
    async (
      _event,
      sourceUri: string,
      requestedPage: number,
      requestedPageSize: number,
      recursive?: boolean
    ) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (message: string) => ({
        ok: false,
        totalCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        children: [],
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('资源未索引，无法分页枚举容器子项。');
      }
      const recursiveFlag = recursive === true;
      const cacheKey = `${sourceUri}::${recursiveFlag ? 'recursive' : 'flat'}`;
      let children = containerChildrenCache.get(cacheKey);
      if (!children) {
        const loaded = await loadContainerChildrenTable(file, sourceUri, recursiveFlag);
        if (!loaded.ok) {
          return {
            ok: false,
            totalCount: 0,
            page: 0,
            pageSize: 0,
            pageCount: 0,
            children: [],
            diagnostics: loaded.diagnostics
          };
        }
        children = loaded.children;
        containerChildrenCache.set(cacheKey, children);
      }
      const window = normalizePageWindow(
        children.length,
        requestedPage,
        requestedPageSize || CONTAINER_PAGE_SIZE
      );
      return {
        ok: true,
        totalCount: children.length,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        children: children
          .slice(window.offset, window.offset + window.size)
          .map((child) => ({
            childId: child.childId,
            ...(child.name ? { name: child.name } : {}),
            offset: child.offset,
            size: child.size,
            ...(child.compressedSize !== undefined
              ? { compressedSize: child.compressedSize }
              : {}),
            hash: child.hash,
            formatKind: child.formatKind,
            sourceContainerUri: child.sourceContainerUri,
            childUri: child.childUri,
            rawBytesAvailable: child.rawBytesAvailable,
            canReplace: child.canReplace,
            ...(child.nestedFormat ? { nestedFormat: child.nestedFormat } : {})
          })),
        diagnostics: []
      };
    }
  );

  handle(
    'resource.readContainerChild',
    async (_event, childUri: string) => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          childUri,
          diagnostics: [{
            severity: 'error' as const,
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before reading a child.',
            sourceUri: containerUri
          }]
        };
      }
      return readContainerChild(file.absolutePath, childUri, { relativePath: file.relativePath });
    }
  );

  handle(
    'resource.replaceContainerChild',
    async (
      event,
      childUri: string,
      expectedContainerHash: string,
      expectedChildHash: string,
      newContentBase64: string
    ): Promise<RendererSaveResult> => {
      const hash = childUri.indexOf('#');
      const containerUri = hash >= 0 ? childUri.slice(0, hash) : childUri;
      const file = indexedFiles.find((item) => item.sourceUri === containerUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Parent container must be indexed before child replace.',
            sourceUri: containerUri
          }]
        };
      }
      if (!activeSession) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'CONTAINER_WRITE_NO_SESSION',
            message: '需要已打开的 Sekiro 工作区才能替换容器子项。',
            sourceUri: containerUri
          }]
        };
      }
      const gameBlocked = rejectNonSekiroNativeWrite(containerUri, file);
      if (gameBlocked) return gameBlocked;
      const operationLog = activeSession
        ? await ensureActiveOperationLog(activeSession)
        : undefined;
      const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      const confirmation = await requestWriteConfirmation({
        event,
        resourceLabel: `${file.relativePath} / ${childUri.slice(childUri.indexOf('#') + 1)}`,
        sourceUri: containerUri,
        actionLabel: '替换容器子项',
        payloadHash: createHash('sha256')
          .update(`${expectedContainerHash}\n${expectedChildHash}\n${newContentBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(containerUri);
      const result = await replaceContainerChild({
        file,
        childUri,
        expectedContainerHash,
        expectedChildHash,
        newContentBase64,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      if (result.ok) {
        containerChildrenCache.clear();
        scriptContainerEntriesCache.clear();
      }
      return toRendererSaveResult(result, indexedFiles);
    }
  );

  handle('resource.roundTripContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        byteIdentical: false,
        payloadEquivalent: false,
        originalHash: '',
        rebuiltHash: '',
        childHashMatches: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container roundtrip.',
          sourceUri
        }]
      };
    }
    return roundTripContainer(file.absolutePath);
  });

  handle('resource.validateContainer', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        format: 'unknown' as const,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before container validate.',
          sourceUri
        }]
      };
    }
    return validateContainer(file.absolutePath);
  });

  handle('resource.probeContainerCapabilities', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    const probed = await probeContainerCapabilityOptions(file.absolutePath);
    return resolveResourceCapabilities(file, probed);
  });

  handle('resource.scriptContainerEvidence', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'RESOURCE_NOT_INDEXED',
          message: 'Resource must be indexed before script evidence.',
          sourceUri
        }]
      };
    }
    if (!activeSession) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error' as const,
          code: 'WORKSPACE_NOT_OPEN',
          message: '需要已打开的工作区才能构建 script 容器证据。',
          sourceUri
        }]
      };
    }
    const storage = durableStoragePaths(activeSession.meta.workspaceId);
    return buildScriptContainerEvidence({
      containerPath: file.absolutePath,
      allowedRoots: bridgeAllowedRoots(activeSession, storage.stagingRoot),
      timeoutMs: 60_000
    });
  });

  /**
   * Paginated script-container entry access (hard constraint 17). The complete
   * classified entry table is materialized once in main and served as bounded
   * pages; the renderer navigates every entry the container reports.
   *
   * Enumeration uses the Bridge `read-dcx-document` command (the same source as
   * the native replace baseline) because it returns the complete inner BND4
   * entry table — `inventory-asset-resources` only returns a bounded sample and
   * cannot back full-coverage navigation. If the full read fails, a bounded
   * inventory sample is served and `entriesComplete=false` keeps the report
   * honest. Classification per entry stays on the main side.
   */
  handle(
    'resource.listScriptContainerEntriesPage',
    async (_event, sourceUri: string, requestedPage: number, requestedPageSize: number) => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      const failure = (code: string, message: string, diagnostics?: StructuredDiagnostic[]) => ({
        ok: false,
        containerFormat: 'unknown',
        entryCount: 0,
        page: 0,
        pageSize: 0,
        pageCount: 0,
        entries: [],
        classificationSummary: emptyScriptClassificationSummary(),
        entriesComplete: false,
        diagnostics: diagnostics ?? [{
          severity: 'error' as const,
          code,
          message,
          sourceUri
        }]
      });
      if (!file) {
        return failure('RESOURCE_NOT_INDEXED', '资源未索引，无法分页枚举脚本容器条目。');
      }
      if (!activeSession) {
        return failure('WORKSPACE_NOT_OPEN', '需要已打开的工作区才能分页读取脚本容器条目。');
      }
      let cached = scriptContainerEntriesCache.get(sourceUri);
      if (!cached) {
        const storage = durableStoragePaths(activeSession.meta.workspaceId);
        const allowedRoots = bridgeAllowedRoots(activeSession, storage.stagingRoot);
        const dcx = await runBridge<ScriptDcxDocumentLike>({
          command: 'read-dcx-document',
          filePath: file.absolutePath,
          resourceUri: `file:///${file.absolutePath.replace(/\\/g, '/')}`,
          allowedRoots,
          timeoutMs: 60_000
        });
        const nested = dcx.parseStatus === 'failed' ? undefined : dcx.data?.nested;
        if (!nested || !Array.isArray(nested.entries)) {
          // Full read unavailable: fall back to the bounded inventory sample.
          const inventory = await runBridge<ScriptInventoryDataLike>({
            command: 'inventory-asset-resources',
            filePath: file.absolutePath,
            resourceUri: `file:///${file.absolutePath.replace(/\\/g, '/')}`,
            allowedRoots,
            timeoutMs: 60_000
          });
          if (inventory.parseStatus === 'failed') {
            return failure(
              'SCRIPT_PAGED_INVENTORY_FAILED',
              '脚本容器完整读取与采样枚举均失败。',
              inventory.diagnostics
            );
          }
          const data = inventory.data ?? {};
          const rawEntries = data.entries ?? data.sampleEntries ?? [];
          const entries: ScriptContainerEntryEvidence[] = rawEntries.map((entry) => {
            const name = entry.name ?? `entry_${entry.index ?? 0}`;
            const classification = classifyScriptEntry(name);
            return {
              name,
              index: entry.index ?? 0,
              size: entry.uncompressedSize ?? 0,
              extension: name.split('.').pop()?.toLowerCase() ?? '',
              classification,
              magicLabel: magicLabel(classification)
            };
          });
          cached = {
            containerFormat: data.format ?? 'BND4',
            entryCount: data.entryCount ?? rawEntries.length,
            entries,
            classificationSummary: summarizeScriptClassifications(entries),
            entriesComplete: false,
            diagnostics: inventory.diagnostics
          };
        } else {
          const entries: ScriptContainerEntryEvidence[] = nested.entries.map((entry) => {
            const name = entry.name ?? `entry_${entry.index ?? 0}`;
            const classification = classifyScriptEntry(name);
            return {
              name,
              index: entry.index ?? 0,
              size: entry.uncompressedSize ?? entry.compressedSize ?? 0,
              extension: name.split('.').pop()?.toLowerCase() ?? '',
              classification,
              magicLabel: magicLabel(classification)
            };
          });
          cached = {
            containerFormat: dcx.data?.format
              ? `${dcx.data.format}->${nested.format ?? 'BND4'}`
              : (nested.format ?? 'BND4'),
            entryCount: nested.entryCount ?? entries.length,
            entries,
            classificationSummary: summarizeScriptClassifications(entries),
            entriesComplete: true,
            diagnostics: dcx.diagnostics
          };
        }
        scriptContainerEntriesCache.set(sourceUri, cached);
      }
      const window = normalizePageWindow(
        cached.entries.length,
        requestedPage,
        requestedPageSize || SCRIPT_PAGE_SIZE
      );
      return {
        ok: true,
        containerFormat: cached.containerFormat,
        entryCount: cached.entryCount,
        page: window.page,
        pageSize: window.size,
        pageCount: window.pageCount,
        entries: cached.entries.slice(window.offset, window.offset + window.size),
        classificationSummary: cached.classificationSummary,
        entriesComplete: cached.entriesComplete,
        diagnostics: cached.diagnostics
      };
    }
  );

  handle('operation.list', async (): Promise<RendererPatchHistoryEntry[]> => {
    if (!activeSession || !activeOperationLog) return [];
    const history = await activeOperationLog.history(activeSession.meta.workspaceId);
    const reversedOperationIds = new Set(
      history
        .filter((entry) => entry.status === 'committed' && entry.inverseOfOpId)
        .map((entry) => entry.inverseOfOpId!)
    );
    return history.map((entry) => toRendererHistoryEntry(
      reversedOperationIds.has(entry.opId) ? { ...entry, status: 'rolled_back' } : entry,
      indexedFiles
    ));
  });

  handle('operation.rollback', async (_event, opId: string): Promise<RollbackOperationIpcResult> => {
    if (!activeSession || !activeOperationLog) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'WORKSPACE_NOT_OPEN',
          message: 'Open a workspace before rolling back an operation.'
        }]
      };
    }

    const sourceOperation = await activeOperationLog.get(opId);
    if (!sourceOperation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'error',
          code: 'OPERATION_NOT_FOUND',
          message: '找不到要回滚的操作。'
        }]
      };
    }
    const confirmation = await requestWriteConfirmation({
      event: _event,
      resourceLabel: sourceOperation.title,
      sourceUri: sourceOperation.files[0]?.targetUri ?? `operation://${opId}`,
      actionLabel: '回滚操作',
      payloadHash: createHash('sha256').update(opId).digest('hex'),
      extraSubjects: [`ROLLBACK_OPERATION:${opId}`]
    });
    if (!confirmation) {
      return {
        ok: false,
        opId,
        restoredFiles: [],
        diagnostics: [{
          severity: 'warning',
          code: 'WRITE_CONFIRMATION_CANCELLED',
          message: '用户取消了回滚操作。'
        }]
      };
    }

    const storage = durableStoragePaths(activeSession.meta.workspaceId);

    const result = await rollbackOperation({
      opId,
      store: activeOperationLog,
      session: activeSession,
      confirmation,
      ...storage
    });

    return {
      ok: result.ok,
      opId: result.opId,
      ...(result.inverseOpId ? { inverseOpId: result.inverseOpId } : {}),
      restoredFiles: result.restoredFiles.map((path) => {
        return indexedFiles.find((file) => file.absolutePath === path)?.sourceUri ?? '[本机路径已隐藏]';
      }),
      diagnostics: sanitizeDiagnostics(result.diagnostics)
    };
  });

  handle('ai.tools', async () => toolRegistry.list());

  handle('ai.sidebarDraft', async (_event, request: AiSidebarDraftRequest): Promise<AiSidebarDraft> => {
    return buildAiSidebarDraft({
      ...request,
      settings: { ...request.settings, mode: activeAiMode },
      availableTools: request.availableTools.length > 0 ? request.availableTools : toolRegistry.list()
    });
  });

  handle(
    'ai.runTool',
    async (_event, name: string, input: unknown): Promise<ToolResult> => {
      if (!activeIndex) {
        return {
          ok: false,
          error: {
            code: 'WORKSPACE_NOT_ANALYZED',
            message: 'Analyze a workspace before running AI-safe tools.'
          }
        };
      }

      return toolRegistry.run(name, input, { workspaceIndex: activeIndex, mode: activeAiMode });
    }
  );

  // Model service configs — renderer receives DTO without secrets.
  handle('modelService.list', async () => modelServiceVault.listConfigs());

  handle('modelService.encryptionAvailable', async () => modelServiceVault.isEncryptionAvailable());

  handle(
    'modelService.upsert',
    async (
      _event,
      input: {
        id?: string;
        displayName: string;
        protocol: 'openai-compatible' | 'anthropic-compatible';
        baseUrl: string;
        model: string;
        apiKey?: string;
      }
    ) => {
      // apiKey is accepted once for encryption; never returned in the response DTO.
      const saved = await modelServiceVault.upsertConfig(input);
      return {
        id: saved.id,
        displayName: saved.displayName,
        protocol: saved.protocol,
        baseUrl: saved.baseUrl,
        model: saved.model,
        hasCredential: saved.hasCredential,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt
      };
    }
  );

  handle('modelService.delete', async (_event, configId: string) => {
    await modelServiceVault.deleteConfig(configId);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- */
  /*  AI agent sessions (Codex-derived kernel). Long tasks run async, */
  /*  report progress via 'ai:agent:event', cancel and have timeouts  */
  /*  (hard constraint 16). Keys stay in main (vault + adapter only). */
  /* ---------------------------------------------------------------- */

  const agentSessionsBaseDir = join(app.getPath('userData'), 'agent');
  const activeAgentRuns = new Map<string, AbortController>();

  const sendAgentEvent = (
    sessionId: string,
    event: AgentEvent | AiAgentSessionLifecycleEvent
  ): void => {
    if (webContents.isDestroyed()) return;
    const envelope: AiAgentEventEnvelope = { sessionId, event };
    webContents.send('ai:agent:event', sanitizeRendererValue(envelope));
  };

  const resolveSessionPath = (
    sessionPath: string
  ): { ok: true; absolute: string } | { ok: false; error: { code: string; message: string } } => {
    const base = resolve(agentSessionsBaseDir);
    const absolute = resolve(base, sessionPath);
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      return {
        ok: false,
        error: { code: 'ROLLOUT_PATH_FORBIDDEN', message: '会话路径必须位于会话目录内。' }
      };
    }
    return { ok: true, absolute };
  };

  handle('ai.agent.run', async (_event, request: AiAgentRunRequest): Promise<AiAgentRunIpcResult> => {
    if (!activeIndex) {
      return {
        ok: false,
        error: { code: 'WORKSPACE_NOT_ANALYZED', message: '请先分析工作区再运行 AI Agent。' }
      };
    }
    if (
      typeof request?.configId !== 'string' || request.configId.trim() === ''
      || typeof request?.prompt !== 'string' || request.prompt.trim() === ''
    ) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'configId 与 prompt 必填。' } };
    }
    const stored = (await modelServiceVault.listConfigs()).find((config) => config.id === request.configId);
    if (!stored) {
      return { ok: false, error: { code: 'MODEL_SERVICE_CONFIG_NOT_FOUND', message: '模型服务配置不存在。' } };
    }
    if (!stored.hasCredential) {
      return {
        ok: false,
        error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务未配置凭据；未发起网络请求。' }
      };
    }
    const apiKey = await modelServiceVault.resolveApiKey(stored.id);
    if (!apiKey) {
      return {
        ok: false,
        error: { code: 'MODEL_SERVICE_UNCONFIGURED', message: '模型服务凭据不可解密；未发起网络请求。' }
      };
    }
    const modelConfig = {
      id: stored.id,
      displayName: stored.displayName,
      protocol: stored.protocol,
      baseUrl: stored.baseUrl,
      model: stored.model,
      hasCredential: true as const,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    };
    const adapterResult = createConfiguredModelServiceAdapter({ config: modelConfig, apiKey });
    if (!adapterResult.ok) {
      const diagnostic = adapterResult.diagnostics[0];
      return { ok: false, error: { code: diagnostic?.code ?? 'MODEL_SERVICE_INVALID', message: diagnostic?.message ?? '模型服务配置无效。' } };
    }
    const mode: ToolContext['mode'] = request.mode === 'normal' || request.mode === 'fullPermission'
      ? request.mode
      : 'plan';
    const bridge = createAgentToolBridge({
      registry: toolRegistry,
      context: { workspaceIndex: activeIndex, mode }
    });

    let resumeFrom: ResumedRollout | undefined;
    if (request.resumeSessionPath !== undefined) {
      const resolved = resolveSessionPath(request.resumeSessionPath);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const loaded = await loadRolloutSession(resolved.absolute);
      if (!loaded.ok) {
        return { ok: false, error: { code: loaded.code, message: loaded.message } };
      }
      const { ok: _ok, path: _path, ...resumed } = loaded;
      resumeFrom = resumed;
    }

    const sessionId = randomUUID();
    const controller = new AbortController();
    activeAgentRuns.set(sessionId, controller);
    sendAgentEvent(sessionId, { type: 'session-accepted', mode });

    const permissionMode = mode === 'fullPermission' ? 'full' : mode;
    void runAgentSession({
      sessionsDir: agentSessionsBaseDir,
      sessionId,
      adapter: adapterResult.adapter,
      config: modelConfig,
      apiKey,
      prompt: request.prompt,
      permissionMode,
      tools: bridge.tools,
      executeTool: bridge.executeTool,
      signal: controller.signal,
      ...(request.streaming === true ? { streaming: true } : {}),
      ...(resumeFrom ? { resumeFrom } : {}),
      onEvent: (event) => sendAgentEvent(sessionId, event)
    }).then((result) => {
      activeAgentRuns.delete(sessionId);
      sendAgentEvent(sessionId, {
        type: 'session-done',
        finishReason: result.run.finishReason,
        steps: result.run.steps,
        rolloutFileName: basename(result.rolloutPath)
      });
    }).catch((error: unknown) => {
      activeAgentRuns.delete(sessionId);
      sendAgentEvent(sessionId, {
        type: 'session-error',
        code: 'AGENT_SESSION_FAILED',
        message: error instanceof Error ? error.message : String(error)
      });
    });

    return { ok: true, sessionId };
  });

  handle('ai.agent.cancel', async (_event, sessionId: string): Promise<{ ok: boolean }> => {
    const controller = activeAgentRuns.get(sessionId);
    if (controller) controller.abort();
    return { ok: true };
  });

  handle('ai.agent.sessions', async (): Promise<AiAgentSessionListIpcResult> => {
    const sessions = await listRolloutSessions(agentSessionsBaseDir, 50);
    return {
      ok: true,
      sessions: sessions.map((session) => ({
        sessionPath: relative(agentSessionsBaseDir, session.path),
        fileName: session.fileName,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        messageCount: session.messageCount,
        parseErrors: session.parseErrors,
        interrupted: session.interrupted,
        compactedWindows: session.compactedWindows,
        sizeBytes: session.sizeBytes,
        modifiedAt: session.modifiedAt
      }))
    };
  });

  handle('ai.agent.session.load', async (_event, sessionPath: string): Promise<AiAgentSessionLoadIpcResult> => {
    if (typeof sessionPath !== 'string' || sessionPath.trim() === '') {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'sessionPath 必填。' } };
    }
    const resolved = resolveSessionPath(sessionPath);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const loaded = await loadRolloutSession(resolved.absolute);
    if (!loaded.ok) {
      return { ok: false, error: { code: loaded.code, message: loaded.message } };
    }
    return {
      ok: true,
      meta: loaded.meta,
      messageCount: loaded.messages.length,
      parseErrors: loaded.parseErrors,
      interrupted: loaded.interrupted,
      compactedWindows: loaded.compactedWindows,
      messagesPage: loaded.messages.slice(-20)
    };
  });
}
