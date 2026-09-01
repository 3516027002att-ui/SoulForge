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
let activeSession: WorkspaceSession | null = null;
let activeWorkspaceSessionId: string | null = null;
let activeWorkspaceSessionGeneration = 0;
let workspaceSessionGenerationCounter = 0;
const FINGERPRINT_STORE_GENERATION = 1;
let activeFingerprintStore: FingerprintStoreState | null = null;
let foregroundActive = false;
let workspaceIndexingAbort: AbortController | null = null;
let workspaceIndexingTask: Promise<void> | null = null;
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
async function persistActiveRag(database: OperationLogUtilityClient, corpus: RagCorpus): Promise<void> {
  activeRag = corpus;
  await database.replaceRagChunks(corpus.chunks);
  await database.replaceReferences(corpus.references);
}
async function refreshRagAfterScan(database: OperationLogUtilityClient, index: WorkspaceIndex): Promise<void> {
  const catalog = buildRagCorpus(index);
  const persisted = createRagCorpus({ workspaceId: index.workspaceId, builtAt: catalog.builtAt, chunks: await database.loadRagChunks(), references: await database.loadReferences() });
  await persistActiveRag(database, mergeCatalogAndPersisted(catalog, persisted));
}
async function refreshRagAfterAnalyze(database: OperationLogUtilityClient, index: WorkspaceIndex): Promise<void> {
  await persistActiveRag(database, buildRagCorpus(index));
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
 * 等待当前工作区的后台哈希/语义索引任务完成。
 *
 * workspace.scan 先返回轻量文件列表，再在后台建立 ACTION Binder membership。
 * 动作 IPC 需要等待同一个任务，而不是在播放阶段重新扫描 sibling ANIBND。
 * 任务自身会把失败写入扫描 job，因此这里保持等待接口不抛出后台异常。
 */
export async function waitForWorkspaceIndexing(): Promise<void> {
  // scan 与 analyze 都可能替换/建立 ACTION membership。按快照等待，完成后
  // 再检查一次，避免刚等完 scan 就撞上 analyze 刚发布的未就绪索引。
  for (;;) {
    const scanTask = workspaceIndexingTask;
    if (scanTask) {
      try {
        await scanTask;
      } catch {
        // 失败状态由 workspace scan job / active index diagnostics 负责暴露。
      }
    }
    const analyzeTask = workspaceAnalyzeInFlight?.promise;
    if (analyzeTask) {
      try {
        await analyzeTask;
      } catch {
        // 分析失败由调用方的结构化诊断负责暴露。
      }
    }
    if (activeIndex?.isActionBinderMembershipReady()) return;
    if (workspaceIndexingTask !== scanTask || workspaceAnalyzeInFlight?.promise !== analyzeTask) continue;
    return;
  }
}

export function clearWorkspaceIpcCaches(): void {
  directorySelections.clear();
  actionMembershipForegroundTasks.clear();
}

export function registerWorkspaceIpcHandlers(deps: WorkspaceIpcDeps): void {
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
    if (activeSession) await disposeBridgeDaemonPool();
    workspaceSessionGenerationCounter += 1;
    const thisSessionGeneration = workspaceSessionGenerationCounter;
    activeWorkspaceSessionGeneration = thisSessionGeneration;
    activeSession = await openWorkspaceSession({ overlayRoot: overlaySelection.absolutePath, ...(effectiveBaseRecord ? { baseRoot: effectiveBaseRecord.absolutePath } : {}), game: 'sekiro' });
    activeWorkspaceSessionId = randomUUID();
    const database = await deps.ensureActiveOperationLog(activeSession);
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
        if (controller.signal.aborted) { await releaseAll(); return; }
        if (currentGeneration !== activeWorkspaceSessionGeneration || currentSession !== activeSession || currentSessionId !== activeWorkspaceSessionId) { await releaseAll(); return; }
        indexedFiles = enriched as unknown as IndexedFile[]; indexForSession.setFiles(enriched as unknown as IndexedFile[]); await database.replaceFiles(enriched as unknown as IndexedFile[]);
        const actionBinderIndex = await rebuildActionBinderMembershipIndex({
          deps,
          index: indexForSession,
          session: currentSession,
          sessionId: currentSessionId,
          indexedFiles: indexedFiles
        });
        if (continuity.continuity === 'UNKNOWN' && hashedCount + reuseCount === enriched.length) fingerprintStore.continuity = { ...continuity, continuity: 'PROVEN', unknownReason: null, cleanShutdown: true };
        fingerprintStore.continuity.cleanShutdown = true; try { await saveFingerprintStore({ storageRoot, state: fingerprintStore }); } catch {}
        const completedAt = new Date().toISOString(); const backgroundCompleteAt = Date.now();
        await database.upsertJob({ jobId: scanJobId, title: '扫描工作区', jobKind: 'workspace_scan', status: 'completed', progress: { current: enriched.length, total: enriched.length }, payload: { workspaceSessionId: currentSessionId, workspaceSessionGeneration: currentGeneration, fingerprintStoreGeneration: currentStoreGen }, result: { fileCount: enriched.length, hashedCount, reuseCount, shellVisibleAt, filesVisibleAt, backgroundCompleteAt, shellVisibleMs: filesVisibleAt - shellVisibleAt, indexingMs: backgroundCompleteAt - shellVisibleAt, openHandles: 0, activeDiskReaders: 0, actionBinderIndex }, createdAt: scanStartedAt, startedAt: scanStartedAt, completedAt, updatedAt: completedAt });
        if (activeIndex === indexForSession) await refreshRagAfterScan(database, indexForSession);
      } catch (error) {
        await releaseAll(); if (controller.signal.aborted) return; if (currentGeneration !== activeWorkspaceSessionGeneration) return;
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
    await disposeBridgeDaemonPool();
    workspaceSessionGenerationCounter += 1; activeWorkspaceSessionGeneration = workspaceSessionGenerationCounter; activeWorkspaceSessionId = randomUUID();
    activeSession = await openWorkspaceSession({ overlayRoot: activeSession.layers.overlayRoot, ...(baseSelection ? { baseRoot: baseSelection.absolutePath } : {}), game: activeSession.meta.game });
    activeIndex?.clearActionBinderMembership();
    const workspaceLabel = activeOverlayLabel || activeSession.meta.game;
    return { workspaceSessionId: activeWorkspaceSessionId, session: { workspaceSessionId: activeWorkspaceSessionId, workspaceLabel, game: activeSession.meta.game, openedAt: activeSession.meta.openedAt, baseMounted: !activeSession.meta.baseMissing, ...(baseSelection ? { baseLabel: baseSelection.label } : {}) } };
  });

  let lastAnalyze: {
    sessionId: string;
    generation: number;
    summary: AnalyzeWorkspaceSummary;
  } | null = null;

  handle('workspace.analyze', async (): Promise<AnalyzeWorkspaceSummary> => {
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
    const promise = (async (): Promise<AnalyzeWorkspaceSummary> => {
      const result = await analyzeWorkspace({
        workspaceRoot: session.layers.overlayRoot,
        ...(session.layers.baseRoot ? { oodleRuntimeRoot: session.layers.baseRoot } : {})
      });
      if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
        throw new Error('工作区已切换，分析结果已丢弃。');
      }
      const actionBinderIndex = await rebuildActionBinderMembershipIndex({
        deps,
        index: result.index,
        session,
        sessionId,
        indexedFiles: result.index.getFiles()
      });
      if (sessionId !== activeWorkspaceSessionId || generation !== activeWorkspaceSessionGeneration) {
        throw new Error('工作区已切换，分析结果已丢弃。');
      }
      // 只有完整 ACTION membership 已装入新索引后才发布它。这样分析期间
      // 仍保留上一份可用索引，动作读取不会短暂撞上“未就绪”空投影。
      activeIndex = result.index;
      indexedFiles = result.index.getFiles();
      const database = await deps.ensureActiveOperationLog(session);
      await refreshRagAfterAnalyze(database, result.index);
      const summary: AnalyzeWorkspaceSummary = {
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
      if (!actionBinderIndex.ok) {
        summary.diagnostics = [...summary.diagnostics, ...actionBinderIndex.diagnostics];
      }
      lastAnalyze = { sessionId, generation, summary };
      return summary;
    })();
    workspaceAnalyzeInFlight = { sessionId, generation, promise };
    try {
      return await promise;
    } finally {
      if (workspaceAnalyzeInFlight?.promise === promise) workspaceAnalyzeInFlight = null;
    }
  });

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
