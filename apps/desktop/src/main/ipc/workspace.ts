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
import { OperationLogUtilityClient } from '../operationLogUtilityClient.js';
import { executeRecoveryCleanup } from '../recoveryCleanup.js';
import { resolveOperationLogStorePath } from '@soulforge/core';
import type { TrustedIpcHandle } from './registration.js';
import { buildRagCorpus, createRagCorpus, mergeCatalogAndPersisted } from '@soulforge/core';

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
let activeOperationLog: OperationLogUtilityClient | null = null;
let activeWorkspaceSessionId: string | null = null;
let activeWorkspaceSessionGeneration = 0;
let workspaceSessionGenerationCounter = 0;
const FINGERPRINT_STORE_GENERATION = 1;
let activeFingerprintStore: FingerprintStoreState | null = null;
let foregroundActive = false;
let workspaceIndexingAbort: AbortController | null = null;
let workspaceIndexingTask: Promise<void> | null = null;
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
function legacyOperationLogPathForWorkspace(workspaceId: string): string {
  return resolveOperationLogStorePath(join(app.getPath('userData'), 'operation-logs'), workspaceId);
}
const here = dirname(new URL(import.meta.url).pathname);
const sqliteNativeBindingPath = app.isPackaged ? join(process.resourcesPath, 'native', 'better_sqlite3.node') : resolve(here, '../../.native/better_sqlite3.node');
const operationLogUtility = new OperationLogUtilityClient(join(here, 'databaseUtility.js'), 15_000, sqliteNativeBindingPath);
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
    legacySemanticBackupDirectory: join(storage.root, 'legacy-semantic-snapshots'),
  });
  const cleanupPlan = await operationLogUtility.planRecoveryCleanup();
  const cleanup = await executeRecoveryCleanup({ plan: cleanupPlan, allowedRoots: [storage.backupBaseDir, storage.recoveryDir], store: operationLogUtility });
  if (cleanup.rejected.length > 0) process.stderr.write(`[SoulForge recovery cleanup] ${JSON.stringify(cleanup.rejected)}\n`);
  activeOperationLog = operationLogUtility;
  return operationLogUtility;
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
}

export function clearWorkspaceIpcCaches(): void {
  directorySelections.clear();
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
    const database = await ensureActiveOperationLog(activeSession);
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
        indexedFiles = enriched as unknown as IndexedFile[]; activeIndex?.setFiles(enriched as unknown as IndexedFile[]); await database.replaceFiles(enriched as unknown as IndexedFile[]);
        if (continuity.continuity === 'UNKNOWN' && hashedCount + reuseCount === enriched.length) fingerprintStore.continuity = { ...continuity, continuity: 'PROVEN', unknownReason: null, cleanShutdown: true };
        fingerprintStore.continuity.cleanShutdown = true; try { await saveFingerprintStore({ storageRoot, state: fingerprintStore }); } catch {}
        const completedAt = new Date().toISOString(); const backgroundCompleteAt = Date.now();
        await database.upsertJob({ jobId: scanJobId, title: '扫描工作区', jobKind: 'workspace_scan', status: 'completed', progress: { current: enriched.length, total: enriched.length }, payload: { workspaceSessionId: currentSessionId, workspaceSessionGeneration: currentGeneration, fingerprintStoreGeneration: currentStoreGen }, result: { fileCount: enriched.length, hashedCount, reuseCount, shellVisibleAt, filesVisibleAt, backgroundCompleteAt, shellVisibleMs: filesVisibleAt - shellVisibleAt, indexingMs: backgroundCompleteAt - shellVisibleAt, openHandles: 0, activeDiskReaders: 0 }, createdAt: scanStartedAt, startedAt: scanStartedAt, completedAt, updatedAt: completedAt });
        if (activeIndex) await refreshRagAfterScan(database, activeIndex);
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
    const workspaceLabel = activeOverlayLabel || activeSession.meta.game;
    return { workspaceSessionId: activeWorkspaceSessionId, session: { workspaceSessionId: activeWorkspaceSessionId, workspaceLabel, game: activeSession.meta.game, openedAt: activeSession.meta.openedAt, baseMounted: !activeSession.meta.baseMissing, ...(baseSelection ? { baseLabel: baseSelection.label } : {}) } };
  });

  handle('workspace.analyze', async (): Promise<AnalyzeWorkspaceSummary> => {
    if (!activeSession) throw new Error('请先打开工作区。');
    if (activeIndex && indexedFiles.length > 0) {
      const databaseReuse = await ensureActiveOperationLog(activeSession);
      await refreshRagAfterAnalyze(databaseReuse, activeIndex);
      return { parsedFiles: 0, inspectedFiles: indexedFiles.length, referenceStats: { high: 0, medium: 0, low: 0, suppressedAmbiguousNumbers: 0 }, diagnostics: [], events: activeIndex.searchEvents('', 200).map(({ item }) => ({ uri: item.uri, eventId: item.eventId, ...(item.name ? { name: item.name } : {}) })), tools: toolRegistry.list() };
    }
    const result = await analyzeWorkspace({ workspaceRoot: activeSession.layers.overlayRoot, ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {}) });
    activeIndex = result.index; const database = await ensureActiveOperationLog(activeSession); await refreshRagAfterAnalyze(database, result.index);
    return { parsedFiles: result.parsedFiles, inspectedFiles: result.inspectedFiles, referenceStats: result.referenceStats, diagnostics: sanitizeDiagnostics(result.diagnostics), events: result.index.searchEvents('', 200).map(({ item }) => ({ uri: item.uri, eventId: item.eventId, ...(item.name ? { name: item.name } : {}) })), tools: toolRegistry.list() };
  });

  // NOTE: resource.preview / resource.search / resource.saveText intentionally remain in composition root.
}

// Getters for composition root / tests if needed
export function getWorkspaceSession(): WorkspaceSession | null { return activeSession; }
export function getWorkspaceIndexedFiles(): readonly IndexedFile[] { return indexedFiles; }
export function getWorkspaceActiveIndex(): WorkspaceIndex | null { return activeIndex; }
export function getActiveWorkspaceSessionIdState(): string | null { return activeWorkspaceSessionId; }
