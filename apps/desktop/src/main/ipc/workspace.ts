import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import {
  analyzeWorkspace,
  canReusePersistedHash,
  createDefaultToolRegistry,
  disposeBridgeDaemonPool,
  fileIdentityFromStat,
  getPathSourceGeneration,
  loadFingerprintStore,
  makeFileFingerprint,
  makeWorkspacePersistentIdentityHash,
  normalizeCtimeNs,
  normalizeMtimeNs,
  openWorkspaceSession,
  saveFingerprintStore,
  scanWorkspace,
  workspacePhysicalRootHash,
  WorkspaceIndex,
  type WorkspaceSession,
  type FingerprintStoreState,
  type RagCorpus,
} from '@soulforge/core';
import { Me3RuntimeAdapter } from '@soulforge/core';
import { MainMe3RuntimeGateway } from '../me3RuntimeGateway.js';
import { clearRecentPath, readRecentPath, writeRecentPath } from '../recentPaths.js';
import type { Diagnostic, IndexedFile, ResourceKind } from '@soulforge/shared';
import { sanitizeDiagnostics, sanitizeRendererValue, toRendererIndexedFile } from '../rendererDto.js';
import type { RendererIndexedFile } from '../rendererDto.js';
import { prepareBridgeRoots, type BridgeRootSession, type PrepareBridgeRootsResult } from '../bridgeRoots.js';
import type { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import type { TrustedIpcHandle } from './registration.js';
import { persistRagCorpusBySourceDelta } from '../ragPersistence.js';
import { buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted } from '@soulforge/core';
import {
  buildActionBinderMembershipIndex,
  resolveActionEffectiveBaseRoot
} from './action.js';

// Workspace types – originally in ipc.ts composition root, now owned here.
export interface DirectorySelection {
  selectionId: string;
  label: string;
}
export interface OpenWorkspaceScanOptions {
  overlaySelectionId: string;
  baseSelectionId?: string;
  clearBase?: boolean;
}
interface DirectorySelectionRecord extends DirectorySelection {
  absolutePath: string;
  kind: 'overlay' | 'base';
  ownerWebContentsId: number;
  expiresAt: number;
}
export interface AnalyzeWorkspaceSummary {
  parsedFiles: number;
  inspectedFiles: number;
  referenceStats: { high: number; medium: number; low: number; suppressedAmbiguousNumbers: number };
  diagnostics: Diagnostic[];
  rag: Pick<RagCorpus, 'stats' | 'availability' | 'diagnostics'>;
  events: Array<{ uri: string; eventId: number; name?: string }>;
  tools: import('@soulforge/core').ToolDescriptor[];
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

// Module-owned mutable state – moved from composition root per A12.
let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
let activeRag: RagCorpus | null = null;
let scheduleRagEmbedding: ((corpus: RagCorpus, database: OperationLogUtilityClient) => void) | null = null;
let activeSession: WorkspaceSession | null = null;
let activeWorkspaceSessionId: string | null = null;
let activeWorkspaceSessionGeneration = 0;
let workspaceSessionGenerationCounter = 0;
const FINGERPRINT_STORE_GENERATION = 1;
let activeFingerprintStore: FingerprintStoreState | null = null;
let foregroundActive = false;
let workspaceIndexingAbort: AbortController | null = null;
let workspaceIndexingTask: Promise<void> | null = null;
interface WorkspaceSemanticIndexingTask {
  sessionId: string;
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
}
let workspaceSemanticIndexingTask: WorkspaceSemanticIndexingTask | null = null;
const actionMembershipForegroundTasks = new Map<string, Promise<{
  ok: boolean;
  diagnostics: Diagnostic[];
  characterFamilies: string[];
  candidateCount: number;
}>>();
let workspaceAnalyzeInFlight: {
  sessionId: string;
  generation: number;
  promise: Promise<AnalyzeWorkspaceSummary>;
} | null = null;
let workspaceAnalysisStarter: (() => Promise<void>) | null = null;
let activeOverlayLabel = '';
const directorySelections = new Map<string, DirectorySelectionRecord>();
const recentPathsFile = join(app.getPath('userData'), 'recent-paths.json');
const toolRegistry = createDefaultToolRegistry();

function localApplicationDataRoot(): string {
  if (process.platform === 'win32') return join(dirname(app.getPath('appData')), 'Local', 'SoulForge');
  return join(app.getPath('userData'), 'local-data');
}
function workspaceStoragePaths(workspaceId: string) {
  const safeWorkspaceKey = createHash('sha256').update(workspaceId).digest('hex').slice(0, 24);
  const root = join(localApplicationDataRoot(), 'workspaces', safeWorkspaceKey);
  return { root, backupBaseDir: join(root, 'backups'), recoveryDir: join(root, 'recovery'), stagingRoot: join(root, 'staging') };
}
function durableStoragePaths(workspaceId: string) { return workspaceStoragePaths(workspaceId); }
function bridgeRootSession(session: WorkspaceSession, storage: { root: string }): BridgeRootSession {
  return { overlayRoot: session.layers.overlayRoot, baseRoot: session.layers.baseRoot ?? null, storageRoot: storage.root };
}
function bridgeRootsDiagnostic(code: string, result: Extract<PrepareBridgeRootsResult, { ok: false }>): Diagnostic {
  return { severity: 'error', code, message: `${result.message}。操作：重试 / 打开 Problems / 检查工作区存储权限。`, ...(result.details !== undefined ? { details: result.details } : {}) };
}
async function persistActiveRag(
  database: OperationLogUtilityClient,
  corpus: RagCorpus,
  previous: RagCorpus | null = null,
  signal?: AbortSignal,
  scheduleEmbedding = true
): Promise<void> {
  await persistRagCorpusBySourceDelta(database, corpus, previous, signal);
  // Publish only after the source delta is durable.  Publishing first would
  // make a cancelled bounded refresh look committed and could cause the next
  // retry to skip SQLite batches that were not written yet.
  activeRag = corpus;
  if (scheduleEmbedding) scheduleRagEmbedding?.(corpus, database);
}

function throwIfRagRefreshAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('RAG 语义持久化已被更新任务取消。');
  error.name = 'AbortError';
  throw error;
}

async function refreshRagAfterScan(
  database: OperationLogUtilityClient,
  index: WorkspaceIndex,
  signal?: AbortSignal
): Promise<void> {
  throwIfRagRefreshAborted(signal);
  const catalog = buildRagCorpus(index);
  const chunks = await database.loadRagChunks();
  throwIfRagRefreshAborted(signal);
  const references = await database.loadReferences();
  throwIfRagRefreshAborted(signal);
  const persisted = createRagCorpus({ workspaceId: index.workspaceId, builtAt: catalog.builtAt, chunks, references });
  await persistActiveRag(database, mergeCatalogAndPersisted(catalog, persisted), persisted, signal);
}
async function refreshRagAfterAnalyze(
  database: OperationLogUtilityClient,
  index: WorkspaceIndex,
  diagnostics: readonly Diagnostic[] = [],
  signal?: AbortSignal,
  scheduleEmbedding = true
): Promise<void> {
  throwIfRagRefreshAborted(signal);
  const catalog = buildRagCorpus(index, new Date().toISOString(), diagnostics);
  throwIfRagRefreshAborted(signal);
  const chunks = await database.loadRagChunks();
  throwIfRagRefreshAborted(signal);
  const references = await database.loadReferences();
  throwIfRagRefreshAborted(signal);
  const persisted = createRagCorpus({
    workspaceId: index.workspaceId,
    builtAt: catalog.builtAt,
    chunks,
    references
  });
  await persistActiveRag(database, mergeCatalogAndPersisted(catalog, persisted), persisted, signal, scheduleEmbedding);
}

function resolveWorkspaceSemanticIndexingTask(task: WorkspaceSemanticIndexingTask | null = workspaceSemanticIndexingTask): void {
  if (!task) return;
  task.resolve();
  if (workspaceSemanticIndexingTask === task) workspaceSemanticIndexingTask = null;
}

async function cancelAbandonedWorkspaceJobs(database: OperationLogUtilityClient): Promise<void> {
  const now = new Date().toISOString();
  for (const job of await database.listJobs()) {
    if (job.status !== 'running' || !job.jobKind.startsWith('workspace_')) continue;
    await database.upsertJob({
      jobId: job.jobId,
      title: job.title,
      jobKind: job.jobKind,
      status: 'cancelled',
      progress: { ...job.progress, message: '上一次工作区任务未正常收口，已在新会话启动时取消。' },
      payload: job.payload,
      ...(job.result !== undefined ? { result: job.result } : {}),
      error: { code: 'WORKSPACE_JOB_SUPERSEDED', message: '工作区会话重新打开，旧任务已被新任务取代。' },
      createdAt: job.createdAt,
      ...(job.startedAt ? { startedAt: job.startedAt } : {}),
      completedAt: now,
      updatedAt: now
    });
  }
}
function createDirectorySelection(event: IpcMainInvokeEvent, absolutePath: string, kind: DirectorySelectionRecord['kind']): DirectorySelection {
  const selection: DirectorySelectionRecord = { selectionId: randomUUID(), label: basename(absolutePath) || (kind === 'overlay' ? 'Mod 工作区' : '原版游戏目录'), absolutePath, kind, ownerWebContentsId: event.sender.id, expiresAt: Date.now() + 5 * 60_000 };
  directorySelections.set(selection.selectionId, selection);
  return { selectionId: selection.selectionId, label: selection.label };
}
function consumeDirectorySelection(event: IpcMainInvokeEvent, selectionId: string, expectedKind: DirectorySelectionRecord['kind']): DirectorySelectionRecord {
  const selection = directorySelections.get(selectionId);
  directorySelections.delete(selectionId);
  if (!selection || selection.kind !== expectedKind || selection.ownerWebContentsId !== event.sender.id || selection.expiresAt < Date.now()) throw new Error('目录选择凭据无效、已过期或不属于当前窗口。');
  return selection;
}
function resolveProjectJsonGameRoot(overlayAbsolutePath: string): string | null {
  const candidate = join(overlayAbsolutePath, 'project.json');
  if (!existsSync(candidate)) return null;
  try {
    const raw = readFileSync(candidate, 'utf8');
    const parsed = JSON.parse(raw) as { GameRoot?: unknown };
    const gameRoot = typeof parsed.GameRoot === 'string' ? parsed.GameRoot.trim() : '';
    if (!gameRoot) return null;
    const resolved = resolve(overlayAbsolutePath, gameRoot);
    if (!existsSync(resolved)) return null;
    const joined = (name: string): string => join(resolved, name);
    const looksLikeSekiroRoot = existsSync(joined('sekiro.exe')) || existsSync(joined('oo2core_6_win64.dll')) || existsSync(joined('sekiro.cdx'));
    if (!looksLikeSekiroRoot) return null;
    return resolved;
  } catch { return null; }
}

export interface WorkspaceIpcDeps {
  handle: TrustedIpcHandle;
  ensureActiveOperationLog(session: WorkspaceSession): Promise<OperationLogUtilityClient>;
  verifiedReadRoots(
    session: WorkspaceSession | null,
    fallback: string
  ): Promise<{ allowedRoots: string[]; diagnostics: Diagnostic[] }>;
  scheduleRagEmbedding?: (corpus: RagCorpus, database: OperationLogUtilityClient) => void;
}

export async function rebuildActionBinderMembershipIndex(input: {
  deps: Pick<WorkspaceIpcDeps, 'verifiedReadRoots'>;
  index: WorkspaceIndex;
  session: WorkspaceSession;
  sessionId: string;
  indexedFiles: readonly IndexedFile[];
  characterFamilies?: readonly string[];
}): Promise<{ ok: boolean; diagnostics: Diagnostic[]; characterFamilies: string[]; candidateCount: number }> {
  const roots = await input.deps.verifiedReadRoots(input.session, input.session.layers.overlayRoot);
  if (roots.diagnostics.length > 0) {
    if (input.characterFamilies?.length) {
      input.index.clearActionBinderMembershipFamilies(input.characterFamilies);
    } else {
      input.index.markActionBinderMembershipGlobalNotReady();
    }
    return { ok: false, diagnostics: roots.diagnostics, characterFamilies: [], candidateCount: 0 };
  }
  const result = await buildActionBinderMembershipIndex({
    session: input.session,
    sessionId: input.sessionId,
    effectiveBase: resolveActionEffectiveBaseRoot(input.session),
    indexedFiles: input.indexedFiles,
    allowedRoots: roots.allowedRoots,
    ...(input.characterFamilies?.length ? { characterFamilies: input.characterFamilies } : {}),
    ...(input.characterFamilies?.length ? { readConcurrency: 2 } : {})
  });
  if (result.ok) {
    if (input.characterFamilies?.length) {
      input.index.mergeActionBinderMembership(result.characterFamilies, result.candidates);
    } else {
      input.index.setActionBinderMembership(result.candidates, result.characterFamilies);
    }
  } else if (input.characterFamilies?.length) {
    input.index.clearActionBinderMembershipFamilies(result.characterFamilies);
  } else {
    // Keep any already-built foreground family projection available. The
    // global build can fail on an unrelated malformed family without making a
    // currently opened character unplayable; its global-ready bit remains off.
    input.index.markActionBinderMembershipGlobalNotReady();
  }
  return {
    ok: result.ok,
    diagnostics: result.diagnostics,
    characterFamilies: result.characterFamilies,
    candidateCount: result.candidates.length
  };
}

/**
 * Build only the current character family's complete membership projection.
 * workspace.scan still performs the full background build, but opening one
 * TAE must not wait for hashes/native reads belonging to unrelated characters.
 */
export async function ensureActionBinderMembershipForFamily(
  deps: Pick<WorkspaceIpcDeps, 'verifiedReadRoots'>,
  characterFamily: string
): Promise<{ ok: boolean; diagnostics: Diagnostic[]; characterFamilies: string[]; candidateCount: number }> {
  const normalizedFamily = characterFamily.trim().toLowerCase();
  if (!/^(?:c\d{4})$/.test(normalizedFamily)) {
    return {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'ACTION_CHARACTER_FAMILY_UNRESOLVED', message: 'ACTION character family 无法用于前台 membership 建立。' }],
      characterFamilies: [],
      candidateCount: 0
    };
  }
  const session = activeSession;
  const sessionId = activeWorkspaceSessionId;
  const index = activeIndex;
  if (!session || !sessionId || !index) {
    return {
      ok: false,
      diagnostics: [{ severity: 'error', code: 'ACTION_WORKSPACE_SESSION_UNAVAILABLE', message: '当前没有可用的 workspace session/index，无法建立 ACTION membership。' }],
      characterFamilies: [],
      candidateCount: 0
    };
  }
  const key = `${sessionId}|${activeWorkspaceSessionGeneration}|${normalizedFamily}`;
  const existing = actionMembershipForegroundTasks.get(key);
  if (existing) return existing;
  const task = rebuildActionBinderMembershipIndex({
    deps,
    index,
    session,
    sessionId,
    indexedFiles,
    characterFamilies: [normalizedFamily]
  });
  actionMembershipForegroundTasks.set(key, task);
  try {
    return await task;
  } finally {
    if (actionMembershipForegroundTasks.get(key) === task) actionMembershipForegroundTasks.delete(key);
  }
}

/**
 * 等待当前工作区的后台哈希与首批语义索引任务完成。
 *
 * workspace.scan 先返回轻量文件列表，再在后台完成哈希和 RAG 文件目录发布；
 * workspace.analyze 随后优先解析 PARAM/MSG，并在首批真实语义行出现时发布
 * 一份可查询的中间索引。
 * ACTION membership 现在按 cXXXX 家族懒建立；动作 IPC 不应在播放阶段
 * 重新扫描 sibling ANIBND，而应等待同一个按家族去重的任务。扫描任务自身
 * 会把失败写入 scan job，因此这里保持等待接口不抛出后台异常。
 *
 * 这里不能等待 workspace.analyze 的最终 Promise：深度原生分析包含真实 MSB
 * 全量解析，可能持续数分钟。只等待它的首批语义阶段；需要原生字段时，仍
 * 由对应工具按精确 sourceUri/ID 失败关闭或懒读取。
 */
export async function waitForWorkspaceIndexing(signal?: AbortSignal): Promise<void> {
  // The renderer normally starts workspace.analyze after the shell is visible,
  // but an Agent can be submitted in that small interval. Start the one
  // existing single-flight analysis here as well, so RAG never settles on a
  // file-only/old corpus merely because the UI request has not arrived yet.
  if (workspaceAnalysisStarter && activeSession && activeWorkspaceSessionId && activeIndex && !workspaceSemanticIndexingTask) {
    void workspaceAnalysisStarter().catch(() => {
      // The owning workspace job keeps the structured diagnostics; the Agent
      // receives RAG_UNAVAILABLE rather than an unhandled rejection.
    });
  }
  for (;;) {
    if (signal?.aborted) {
      const error = new Error('等待工作区语义索引时任务已取消。');
      error.name = 'AbortError';
      throw error;
    }
    const scanTask = workspaceIndexingTask;
    const semanticTask = workspaceSemanticIndexingTask;
    if (scanTask) {
      try {
        await scanTask;
      } catch {
        // 失败状态由 workspace scan job / active index diagnostics 负责暴露。
      }
    }
    if (semanticTask) {
      try {
        await semanticTask.promise;
      } catch {
        // 分析失败时由 activeRag/诊断保持失败关闭；等待者不能永久悬挂。
      }
    }
    if (signal?.aborted) {
      const error = new Error('等待工作区语义索引时任务已取消。');
      error.name = 'AbortError';
      throw error;
    }
    if (workspaceIndexingTask !== scanTask
      || workspaceSemanticIndexingTask?.promise !== semanticTask?.promise) continue;
    return;
  }
}

export function clearWorkspaceIpcCaches(): void {
  directorySelections.clear();
  actionMembershipForegroundTasks.clear();
  resolveWorkspaceSemanticIndexingTask();
  activeRag = null;
  scheduleRagEmbedding = null;
  workspaceAnalysisStarter = null;
}

export function registerWorkspaceIpcHandlers(deps: WorkspaceIpcDeps): void {
  scheduleRagEmbedding = deps.scheduleRagEmbedding ?? null;
  const handle = deps.handle;

  let runtimeAdapter: Me3RuntimeAdapter | null = null;
  let runtimeGateway: MainMe3RuntimeGateway | null = null;
  function ensureRuntimeAdapter(): Me3RuntimeAdapter {
    if (!runtimeAdapter) {
      runtimeGateway = new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() });
      runtimeAdapter = new Me3RuntimeAdapter({ gateway: runtimeGateway, versionPolicy: { policyId: 'soulforge.me3-v0_12_1', supportedVersions: ['0.12.1'] } });
    }
    return runtimeAdapter;
  }

  handle('runtime.detectMe3', async () => {
    const adapter = new Me3RuntimeAdapter({ gateway: new MainMe3RuntimeGateway({ localDataRoot: localApplicationDataRoot() }), versionPolicy: { policyId: 'soulforge.me3-v0_12_1', supportedVersions: ['0.12.1'] } });
    return await adapter.detect({ timeoutMs: 5_000 });
  });

  handle('runtime.prepareMe3Profile', async () => {
    if (!activeSession || !activeWorkspaceSessionId) {
      return { ok: false, status: 'failed' as const, authority: 'unverified' as const, diagnostics: [{ severity: 'error' as const, code: 'RUNTIME_NO_WORKSPACE', message: '需要已打开的工作区才能准备 me3 配置文件。' }] };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.prepareProfile({ workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro' }, { timeoutMs: 30_000 });
    return sanitizeRendererValue(result);
  });

  handle('runtime.launchMe3', async (_event, profileId: string) => {
    if (!activeWorkspaceSessionId) {
      return { ok: false, status: 'failed' as const, authority: 'unverified' as const, diagnostics: [{ severity: 'error' as const, code: 'RUNTIME_NO_WORKSPACE', message: '需要已打开的工作区才能启动 me3。' }] };
    }
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.launch({ profile: { profileId, workspaceSessionId: activeWorkspaceSessionId, game: 'sekiro', profileVersion: 'v1', contentSha256: '' } }, { timeoutMs: 15_000 });
    return sanitizeRendererValue(result);
  });

  handle('runtime.terminateMe3', async (_event, sessionId: string) => {
    const adapter = ensureRuntimeAdapter();
    const result = await adapter.terminate({ sessionId, game: 'sekiro', state: 'running', startedAt: new Date().toISOString(), diagnostics: [] }, { timeoutMs: 10_000 });
    return sanitizeRendererValue(result);
  });

  handle('workspace.lastSelection', async (event): Promise<{ overlay: DirectorySelection | null; base: DirectorySelection | null }> => {
    const overlayPath = readRecentPath(recentPathsFile, 'overlay');
    const basePath = readRecentPath(recentPathsFile, 'base');
    return { overlay: overlayPath ? createDirectorySelection(event, overlayPath, 'overlay') : null, base: basePath ? createDirectorySelection(event, basePath, 'base') : null };
  });

  handle('workspace.openDialog', async (event): Promise<DirectorySelection | null> => {
    const remembered = readRecentPath(recentPathsFile, 'overlay');
    const result = await dialog.showOpenDialog({ title: '打开 Mod 工作区', properties: ['openDirectory'], ...(remembered ? { defaultPath: remembered } : {}) });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (selectedPath) writeRecentPath(recentPathsFile, 'overlay', selectedPath);
    return selectedPath ? createDirectorySelection(event, selectedPath, 'overlay') : null;
  });

  handle('workspace.openBaseDialog', async (event): Promise<DirectorySelection | null> => {
    const remembered = readRecentPath(recentPathsFile, 'base');
    const result = await dialog.showOpenDialog({ title: '打开原版游戏目录（可选）', properties: ['openDirectory'], ...(remembered ? { defaultPath: remembered } : {}) });
    const selectedPath = result.canceled ? undefined : result.filePaths[0];
    if (selectedPath) writeRecentPath(recentPathsFile, 'base', selectedPath);
    return selectedPath ? createDirectorySelection(event, selectedPath, 'base') : null;
  });

  handle('workspace.scan', async (event, options: OpenWorkspaceScanOptions): Promise<RendererWorkspaceScanResult> => {
    const overlaySelection = consumeDirectorySelection(event, options.overlaySelectionId, 'overlay');
    if (options.clearBase === true) clearRecentPath(recentPathsFile, 'base');
    let baseSelection = options.clearBase === true ? undefined : options.baseSelectionId ? consumeDirectorySelection(event, options.baseSelectionId, 'base') : undefined;
    let autoBaseRecord: DirectorySelectionRecord | null = null;
    if (!baseSelection && !options.clearBase) {
      let autoBasePath = resolveProjectJsonGameRoot(overlaySelection.absolutePath);
      if (!autoBasePath || !existsSync(autoBasePath)) {
        const parentDir = dirname(overlaySelection.absolutePath);
        if (existsSync(join(parentDir, 'sekiro.exe')) || existsSync(join(parentDir, 'map')) || existsSync(join(parentDir, 'parts'))) autoBasePath = parentDir;
      }
      if (autoBasePath && existsSync(autoBasePath)) {
        try { const created = createDirectorySelection(event, autoBasePath, 'base'); autoBaseRecord = consumeDirectorySelection(event, created.selectionId, 'base'); } catch {}
      }
    }
    const effectiveBaseRecord = (baseSelection as DirectorySelectionRecord | undefined) ?? autoBaseRecord ?? null;
    if (workspaceIndexingAbort) { try { workspaceIndexingAbort.abort(); } catch {} }
    if (workspaceIndexingTask) { try { await workspaceIndexingTask; } catch {} }
    resolveWorkspaceSemanticIndexingTask();
    if (activeSession) await disposeBridgeDaemonPool();
    // A corpus is valid only for its active WorkspaceIndex/session.  Clear it
    // before exposing the new session so an agent cannot query the previous
    // workspace during the open-to-analyze window.
    activeRag = null;
    activeIndex = null;
    indexedFiles = [];
    workspaceSessionGenerationCounter += 1;
    const thisSessionGeneration = workspaceSessionGenerationCounter;
    activeWorkspaceSessionGeneration = thisSessionGeneration;
    activeSession = await openWorkspaceSession({ overlayRoot: overlaySelection.absolutePath, ...(effectiveBaseRecord ? { baseRoot: effectiveBaseRecord.absolutePath } : {}), game: 'sekiro' });
    activeWorkspaceSessionId = randomUUID();
    const database = await deps.ensureActiveOperationLog(activeSession);
    await cancelAbandonedWorkspaceJobs(database);
    const physicalOverlayRoot = await (async () => { try { const { realpath } = await import('node:fs/promises'); return await realpath(activeSession.layers.overlayRoot); } catch { return activeSession.layers.overlayRoot; } })();
    const physicalOverlayHash = workspacePhysicalRootHash(physicalOverlayRoot);
    const physicalBaseHash = activeSession.layers.baseRoot ? workspacePhysicalRootHash(await (async () => { try { const { realpath } = await import('node:fs/promises'); return await realpath(activeSession.layers.baseRoot!); } catch { return activeSession.layers.baseRoot!; } })()) : undefined;
    const workspacePersistentIdentityHash = makeWorkspacePersistentIdentityHash({ workspaceId: activeSession.meta.workspaceId, game: activeSession.meta.game, physicalOverlayRootHash: physicalOverlayHash, ...(physicalBaseHash ? { physicalBaseRootHash: physicalBaseHash } : {}) });
    const storageRoot = durableStoragePaths(activeSession.meta.workspaceId).root;
    let fingerprintStore = await loadFingerprintStore({ workspacePersistentIdentityHash, storageRoot, fingerprintStoreGeneration: FINGERPRINT_STORE_GENERATION });
    activeFingerprintStore = fingerprintStore;
    const continuity = fingerprintStore.continuity;
    const shellVisibleAt = Date.now();
    const lightResult = await scanWorkspace({ workspaceRoot: activeSession.layers.overlayRoot, game: activeSession.meta.game, includeContentHashes: false });
    const filesVisibleAt = Date.now();
    indexedFiles = lightResult.files;
    activeOverlayLabel = overlaySelection.label;
    activeIndex = new WorkspaceIndex(activeSession.meta.workspaceId);
    activeIndex.setFiles(lightResult.files);
    const indexForSession = activeIndex;
    const scanJobId = randomUUID();
    const scanStartedAt = new Date().toISOString();
    await database.upsertJob({ jobId: scanJobId, title: '扫描工作区', jobKind: 'workspace_scan', status: 'running', progress: { current: 0, total: lightResult.files.length, message: '基础资源已可用，正在后台校验内容索引' }, payload: { workspaceSessionId: activeWorkspaceSessionId, workspaceSessionGeneration: thisSessionGeneration, fingerprintStoreGeneration: fingerprintStore.fingerprintStoreGeneration, workspacePersistentIdentityHash }, createdAt: scanStartedAt, startedAt: scanStartedAt, updatedAt: scanStartedAt });
    await database.replaceFiles(lightResult.files);
    const currentSessionId = activeWorkspaceSessionId;
    const currentSession = activeSession;
    const currentGeneration = thisSessionGeneration;
    const currentStoreGen = fingerprintStore.fingerprintStoreGeneration;
    const lightFiles = lightResult.files;
    const controller = new AbortController();
    workspaceIndexingAbort = controller;
    const backgroundTask = (async () => {
      const openHandles: import('node:fs/promises').FileHandle[] = [];
      let activeDiskReaders = 0;
      const releaseAll = async () => { for (const h of openHandles) { try { await h.close(); } catch {} } openHandles.length = 0; };
      const cancelCurrentJob = async (message: string) => {
        // The operation-log client is shared.  Once another workspace has
        // opened, writing through this old closure could mark the new
        // workspace's database, so leave cross-session reconciliation to the
        // next open's cancelAbandonedWorkspaceJobs call.
        if (currentSession !== activeSession || currentSessionId !== activeWorkspaceSessionId) return;
        const cancelledAt = new Date().toISOString();
        try {
          await database.upsertJob({
            jobId: scanJobId,
            title: '扫描工作区',
            jobKind: 'workspace_scan',
            status: 'cancelled',
            progress: { current: 0, total: lightFiles.length, message },
            payload: { workspaceSessionId: currentSessionId, workspaceSessionGeneration: currentGeneration },
            error: { code: 'WORKSPACE_SCAN_CANCELLED', message },
            createdAt: scanStartedAt,
            startedAt: scanStartedAt,
            completedAt: cancelledAt,
            updatedAt: cancelledAt
          });
        } catch { /* 会话切换时数据库可能已关闭；不能阻止句柄清理。 */ }
      };
      try {
        const { createHash: _createHash } = await import('node:crypto');
        const { open: _open } = await import('node:fs/promises');
        let hashedCount = 0; let reuseCount = 0; const enriched = [];
        for (const file of lightFiles) {
          if (controller.signal.aborted) throw new Error('aborted');
          if (currentGeneration !== activeWorkspaceSessionGeneration || currentSession !== activeSession || currentSessionId !== activeWorkspaceSessionId) throw new Error('aborted');
          let liveStat = null;
          try {
            const st = await (await import('node:fs/promises')).stat(file.absolutePath, { bigint: true }).catch(async () => await (await import('node:fs/promises')).stat(file.absolutePath));
            const mtimeNs = normalizeMtimeNs(st as unknown as Parameters<typeof normalizeMtimeNs>[0]);
            const ctimeNs = normalizeCtimeNs(st as unknown as Parameters<typeof normalizeCtimeNs>[0]);
            const fileIdentity = fileIdentityFromStat(st as unknown as Parameters<typeof fileIdentityFromStat>[0]);
            liveStat = { size: Number((st as { size: bigint | number }).size), mtimeNs, ctimeNs, fileIdentity };
          } catch { liveStat = { size: file.size, mtimeNs: String(BigInt(file.mtimeMs * 1_000_000)), ctimeNs: String(BigInt(file.mtimeMs * 1_000_000)), fileIdentity: null }; }
          const pathGen = getPathSourceGeneration(fingerprintStore, file.relativePath);
          const fp = makeFileFingerprint({ relativePath: file.relativePath, size: liveStat.size, mtimeNs: liveStat.mtimeNs, ctimeNs: liveStat.ctimeNs, fileIdentity: liveStat.fileIdentity, pathSourceGeneration: pathGen });
          const persisted = fingerprintStore.hashes.get(file.relativePath);
          const reuseCheck = canReusePersistedHash({ fingerprint: fp, persisted, currentStoreGeneration: currentStoreGen, continuity, workspaceIdentityMatches: persisted ? persisted.relativePath === fp.relativePath : false });
          if (reuseCheck.reuse && persisted) { enriched.push({ ...file, sha256: persisted.sha256 }); reuseCount++; continue; }
          if (foregroundActive) { await new Promise((r) => setTimeout(r, 12)); if (controller.signal.aborted) throw new Error('aborted'); if (currentGeneration !== activeWorkspaceSessionGeneration) throw new Error('aborted'); }
          try {
            const handle_ = await _open(file.absolutePath, 'r'); openHandles.push(handle_); activeDiskReaders++;
            try { const fhStat = await handle_.stat({ bigint: true }).catch(async () => await handle_.stat()); void normalizeMtimeNs(fhStat as unknown as Parameters<typeof normalizeMtimeNs>[0]); void normalizeCtimeNs(fhStat as unknown as Parameters<typeof normalizeCtimeNs>[0]); void fileIdentityFromStat(fhStat as unknown as Parameters<typeof fileIdentityFromStat>[0]); } catch {}
            const hasher = _createHash('sha256'); const buf = Buffer.alloc(1024 * 1024); let offset = 0; const fileSize = liveStat.size;
            while (offset < fileSize) {
              if (controller.signal.aborted) throw new Error('aborted'); if (currentGeneration !== activeWorkspaceSessionGeneration) throw new Error('aborted');
              const toRead = Math.min(buf.length, fileSize - offset); const { bytesRead } = await handle_.read(buf, 0, toRead, offset);
              if (bytesRead === 0 && offset < fileSize) throw Object.assign(new Error('HASH_UNEXPECTED_EOF'), { code: 'HASH_UNEXPECTED_EOF' });
              if (bytesRead > 0) hasher.update(buf.subarray(0, bytesRead)); offset += bytesRead;
              if (offset < fileSize && foregroundActive) { activeDiskReaders = Math.max(0, activeDiskReaders - 1); await new Promise((r) => setImmediate(r)); activeDiskReaders++; if (controller.signal.aborted) throw new Error('aborted'); if (currentGeneration !== activeWorkspaceSessionGeneration) throw new Error('aborted'); } else if (bytesRead > 0) { await new Promise((r) => setImmediate(r)); }
              if (bytesRead === 0) break;
            }
            try {
              const endStat = await handle_.stat({ bigint: true }).catch(async () => await handle_.stat()); const endMtimeNs = normalizeMtimeNs(endStat as unknown as Parameters<typeof normalizeMtimeNs>[0]); const endCtimeNs = normalizeCtimeNs(endStat as unknown as Parameters<typeof normalizeCtimeNs>[0]); const endId = fileIdentityFromStat(endStat as unknown as Parameters<typeof fileIdentityFromStat>[0]);
              if (endId !== fp.fileIdentity || Number((endStat as { size: bigint | number }).size) !== fp.size || endMtimeNs !== fp.mtimeNs || endCtimeNs !== fp.ctimeNs) throw Object.assign(new Error('FILE_CHANGED_DURING_HASH'), { code: 'FILE_CHANGED_DURING_HASH' });
            } catch (e) { const err = e as { code?: string }; if (err && err.code === 'FILE_CHANGED_DURING_HASH') throw e; }
            const sha = hasher.digest('hex'); enriched.push({ ...file, sha256: sha }); hashedCount++; fingerprintStore.hashes.set(file.relativePath, { ...fp, sha256: sha, lastVerifiedAtUtc: new Date().toISOString(), fingerprintStoreGeneration: currentStoreGen }); await handle_.close(); openHandles.splice(openHandles.indexOf(handle_), 1); activeDiskReaders = Math.max(0, activeDiskReaders - 1);
          } catch (e) {
            activeDiskReaders = Math.max(0, activeDiskReaders - 1); if (controller.signal.aborted) throw e; const err = e as { code?: string }; if (err && err.code === 'FILE_CHANGED_DURING_HASH') { enriched.push({ ...file }); continue; } if (currentGeneration !== activeWorkspaceSessionGeneration) throw e;
            enriched.push({ ...file, diagnostics: [...file.diagnostics, { severity: 'warning' as const, code: 'FILE_HASH_FAILED', message: e instanceof Error ? e.message : String(e), details: { absolutePath: file.absolutePath } }] });
          }
          await new Promise((r) => setTimeout(r, 0));
        }
        if (controller.signal.aborted) { await cancelCurrentJob('工作区扫描被新任务取消。'); await releaseAll(); return; }
        if (currentGeneration !== activeWorkspaceSessionGeneration || currentSession !== activeSession || currentSessionId !== activeWorkspaceSessionId) { await cancelCurrentJob('工作区会话已切换，旧扫描结果已丢弃。'); await releaseAll(); return; }
        indexedFiles = enriched as unknown as IndexedFile[]; indexForSession.setFiles(enriched as unknown as IndexedFile[]); await database.replaceFiles(enriched as unknown as IndexedFile[]);
        // ACTION membership is an on-demand projection.  Building every
        // original/mod *.anibnd.dcx here forces full DCX+BND4 materialization
        // for unrelated character families while the user is merely opening a
        // workspace; several large native reads can otherwise coexist and
        // exhaust the desktop.  The ACTION IPC builds only the requested
        // cXXXX family through ensureActionBinderMembershipForFamily.
        indexForSession.markActionBinderMembershipGlobalNotReady();
        const actionBinderIndex = {
          ok: true,
          diagnostics: [{
            severity: 'info' as const,
            code: 'ACTION_BINDER_MEMBERSHIP_DEFERRED',
            message: '全局 ACTION membership 已延迟；打开具体 cXXXX 动作时按角色家族建立。'
          }],
          characterFamilies: [],
          candidateCount: 0
        };
        if (continuity.continuity === 'UNKNOWN' && hashedCount + reuseCount === enriched.length) fingerprintStore.continuity = { ...continuity, continuity: 'PROVEN', unknownReason: null, cleanShutdown: true };
        fingerprintStore.continuity.cleanShutdown = true; try { await saveFingerprintStore({ storageRoot, state: fingerprintStore }); } catch {}
        const completedAt = new Date().toISOString(); const backgroundCompleteAt = Date.now();
        await database.upsertJob({ jobId: scanJobId, title: '扫描工作区', jobKind: 'workspace_scan', status: 'completed', progress: { current: enriched.length, total: enriched.length }, payload: { workspaceSessionId: currentSessionId, workspaceSessionGeneration: currentGeneration, fingerprintStoreGeneration: currentStoreGen }, result: { fileCount: enriched.length, hashedCount, reuseCount, shellVisibleAt, filesVisibleAt, backgroundCompleteAt, shellVisibleMs: filesVisibleAt - shellVisibleAt, indexingMs: backgroundCompleteAt - shellVisibleAt, openHandles: 0, activeDiskReaders: 0, actionBinderIndex }, createdAt: scanStartedAt, startedAt: scanStartedAt, completedAt, updatedAt: completedAt });
        if (activeIndex === indexForSession) await refreshRagAfterScan(database, indexForSession, controller.signal);
      } catch (error) {
        await releaseAll(); if (controller.signal.aborted) { await cancelCurrentJob('工作区扫描被新任务取消。'); return; } if (currentGeneration !== activeWorkspaceSessionGeneration) { await cancelCurrentJob('工作区会话已切换，旧扫描结果已丢弃。'); return; }
        const failedAt = new Date().toISOString(); try { await database.upsertJob({ jobId: scanJobId, title: '扫描工作区', jobKind: 'workspace_scan', status: 'failed', progress: { current: 0 }, payload: { workspaceSessionId: currentSessionId, workspaceSessionGeneration: currentGeneration }, error: { message: error instanceof Error ? error.message : String(error) }, createdAt: scanStartedAt, startedAt: scanStartedAt, completedAt: failedAt, updatedAt: failedAt }); } catch {}
      }
    })();
    workspaceIndexingTask = backgroundTask;
    return { workspaceSessionId: activeWorkspaceSessionId, workspaceLabel: overlaySelection.label, files: lightResult.files.map(toRendererIndexedFile), diagnostics: sanitizeDiagnostics(lightResult.diagnostics), countsByKind: lightResult.countsByKind, session: { workspaceSessionId: activeWorkspaceSessionId, workspaceLabel: overlaySelection.label, game: activeSession.meta.game, openedAt: activeSession.meta.openedAt, baseMounted: !activeSession.meta.baseMissing, ...(baseSelection ? { baseLabel: baseSelection.label } : {}) }, indexingStatus: { workspaceSessionId: activeWorkspaceSessionId, phase: 'hashing', current: 0, total: lightResult.files.length, message: '基础资源已可用，正在后台校验内容索引' } };
  });

  handle('workspace.remountBase', async (event, baseSelectionId: string | null): Promise<{ workspaceSessionId: string; session: RendererWorkspaceSession }> => {
    if (!activeSession) throw new Error('请先打开工作区。');
    const baseSelection = baseSelectionId ? consumeDirectorySelection(event, baseSelectionId, 'base') : undefined;
    if (workspaceIndexingAbort) { try { workspaceIndexingAbort.abort(); } catch {} }
    if (workspaceIndexingTask) { try { await workspaceIndexingTask; } catch {} }
    resolveWorkspaceSemanticIndexingTask();
    await disposeBridgeDaemonPool();
    activeRag = null;
    activeIndex?.clearActionBinderMembership();
    activeIndex = null;
    indexedFiles = [];
    workspaceSessionGenerationCounter += 1; activeWorkspaceSessionGeneration = workspaceSessionGenerationCounter; activeWorkspaceSessionId = randomUUID();
    activeSession = await openWorkspaceSession({ overlayRoot: activeSession.layers.overlayRoot, ...(baseSelection ? { baseRoot: baseSelection.absolutePath } : {}), game: activeSession.meta.game });
    const workspaceLabel = activeOverlayLabel || activeSession.meta.game;
    return { workspaceSessionId: activeWorkspaceSessionId, session: { workspaceSessionId: activeWorkspaceSessionId, workspaceLabel, game: activeSession.meta.game, openedAt: activeSession.meta.openedAt, baseMounted: !activeSession.meta.baseMissing, ...(baseSelection ? { baseLabel: baseSelection.label } : {}) } };
  });

  let lastAnalyze: {
    sessionId: string;
    generation: number;
    summary: AnalyzeWorkspaceSummary;
  } | null = null;

  const analyzeCurrentWorkspace = async (): Promise<AnalyzeWorkspaceSummary> => {
    if (!activeSession || !activeWorkspaceSessionId) throw new Error('请先打开工作区。');
    const session = activeSession;
    const sessionId = activeWorkspaceSessionId;
    const generation = activeWorkspaceSessionGeneration;
    // 扫描只建立文件目录，不能当成「已经解析过」。目录非空就返回 parsedFiles:0
    // 会让启动 toast 报「解析 0 个资源」，RAG 也只吃到空符号表。
    if (lastAnalyze && lastAnalyze.sessionId === sessionId && lastAnalyze.generation === generation) {
      return lastAnalyze.summary;
    }
    if (workspaceAnalyzeInFlight && workspaceAnalyzeInFlight.sessionId === sessionId && workspaceAnalyzeInFlight.generation === generation) {
      return workspaceAnalyzeInFlight.promise;
    }
    // workspace.scan deliberately returns after the light directory scan so the
    // shell can become interactive.  Its background task still hashes every
    // file, builds ACTION membership, and publishes the file-only RAG corpus.
    // Do not start the full native analysis beside that work: the map export is
    // CPU/memory intensive and the overlap can make Electron appear hung.
    const scanTask = workspaceIndexingTask;
    let resolveSemanticStage!: () => void;
    const semanticStagePromise = new Promise<void>((resolve) => {
      resolveSemanticStage = resolve;
    });
    const semanticStage: WorkspaceSemanticIndexingTask = {
      sessionId,
      generation,
      promise: semanticStagePromise,
      resolve: resolveSemanticStage
    };
    workspaceSemanticIndexingTask = semanticStage;
    let semanticStagePublished = false;
    const promise = (async (): Promise<AnalyzeWorkspaceSummary> => {
      if (scanTask) {
        try {
          await scanTask;
        } catch {
          // The scan job owns its structured failure state.  Analysis should
          // still run so it can return any native diagnostics it can obtain.
        }
      }
      if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
        throw new Error('工作区已切换，分析结果已丢弃。');
      }
      const result = await analyzeWorkspace({
        workspaceRoot: session.layers.overlayRoot,
        ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {}),
        onSemanticIndexReady: async (stage) => {
          if (semanticStagePublished) return;
          if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
            throw new Error('工作区已切换，阶段语义索引已丢弃。');
          }
          semanticStagePublished = true;
          // The analysis scan deliberately omits content hashes. Reattach the
          // already verified light catalog before publishing symbols so exact
          // sourceHash/sourceRevision checks remain available to the Agent.
          stage.index.setFiles(indexedFiles);
          stage.index.rebuildReferences({ enableNumericFallback: true });
          activeIndex = stage.index;
          indexedFiles = stage.index.getFiles();
          try {
            const database = await deps.ensureActiveOperationLog(session);
            // The full analysis will publish again at the end.  Do not start
            // embedding during this transitional slice: it would compete with
            // the remaining native EVENT/MAP pass and is not needed for the
            // default lexical/structured Agent path.
            await refreshRagAfterAnalyze(database, stage.index, stage.diagnostics, undefined, false);
          } finally {
            resolveWorkspaceSemanticIndexingTask(semanticStage);
          }
        }
      });
      if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
        throw new Error('工作区已切换，分析结果已丢弃。');
      }
      // Do not eagerly materialize every character's ANIBND after native
      // analysis.  ACTION playback has a scoped, deterministic lazy builder;
      // keeping the global projection deferred prevents another full native
      // fan-out immediately after the expensive map/event pass.
      result.index.markActionBinderMembershipGlobalNotReady();
      if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
        throw new Error('工作区已切换，分析结果已丢弃。');
      }
      // 只有完整 ACTION membership 已装入新索引后才发布它。这样分析期间
      // 仍保留上一份可用索引，动作读取不会短暂撞上“未就绪”空投影。
      activeIndex = result.index;
      indexedFiles = result.index.getFiles();
      const database = await deps.ensureActiveOperationLog(session);
      await refreshRagAfterAnalyze(database, result.index, result.diagnostics.map((diagnostic) => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.sourceUri ? { sourceUri: diagnostic.sourceUri } : {})
      })));
      const summary: AnalyzeWorkspaceSummary = {
        parsedFiles: result.parsedFiles,
        inspectedFiles: result.inspectedFiles,
        referenceStats: result.referenceStats,
        diagnostics: sanitizeDiagnostics(result.diagnostics),
        rag: activeRag
          ? {
              stats: activeRag.stats,
              availability: activeRag.availability,
              diagnostics: sanitizeDiagnostics(activeRag.diagnostics)
            }
          : {
              stats: createRagCorpus({ workspaceId: result.index.workspaceId, builtAt: new Date().toISOString(), chunks: [] }).stats,
              availability: 'unavailable',
              diagnostics: [{ severity: 'warning', code: 'RAG_NOT_PUBLISHED', message: 'RAG 语料尚未发布。' }]
            },
        events: result.index.searchEvents('', 200).map(({ item }) => ({
          uri: item.uri,
          eventId: item.eventId,
          ...(item.name ? { name: item.name } : {})
        })),
        tools: toolRegistry.list()
      };
      lastAnalyze = { sessionId, generation, summary };
      return summary;
    })();
    workspaceAnalyzeInFlight = { sessionId, generation, promise };
    try {
      return await promise;
    } finally {
      if (workspaceAnalyzeInFlight?.promise === promise) workspaceAnalyzeInFlight = null;
      resolveWorkspaceSemanticIndexingTask(semanticStage);
    }
  };
  handle('workspace.analyze', analyzeCurrentWorkspace);
  workspaceAnalysisStarter = async () => {
    await analyzeCurrentWorkspace();
  };

  // NOTE: resource.preview / resource.search / resource.saveText intentionally remain in composition root.
}

export function getWorkspaceSession(): WorkspaceSession | null {
  return activeSession;
}
export function getWorkspaceIndexedFiles(): IndexedFile[] {
  return indexedFiles;
}
export function getWorkspaceActiveIndex(): WorkspaceIndex | null {
  return activeIndex;
}
export function getActiveWorkspaceSessionIdState(): string | null {
  return activeWorkspaceSessionId;
}
export function getWorkspaceRag(): RagCorpus | null {
  return activeRag;
}
export function getWorkspaceFingerprintStore(): FingerprintStoreState | null {
  return activeFingerprintStore;
}
export function applyWorkspaceIndexSnapshot(index: WorkspaceIndex): void {
  activeIndex = index;
  indexedFiles = index.getFiles();
}
export function applyWorkspaceRag(corpus: RagCorpus): void {
  activeRag = corpus;
}
export function setWorkspaceForegroundActive(value: boolean): void {
  foregroundActive = value;
}
export function revokeDirectorySelectionsFor(webContentsId: number): void {
  for (const [selectionId, selection] of directorySelections) {
    if (selection.ownerWebContentsId === webContentsId) directorySelections.delete(selectionId);
  }
}
