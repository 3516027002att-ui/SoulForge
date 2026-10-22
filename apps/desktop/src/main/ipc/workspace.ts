import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { app, dialog, type IpcMainInvokeEvent } from 'electron';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { localApplicationDataRoot, resolveWorkspaceStoragePaths } from '../workspaceStorage.js';
import { MainMe3RuntimeGateway } from '../me3RuntimeGateway.js';
import { clearRecentPath, readRecentPath, writeRecentPath } from '../recentPaths.js';
import type { TrustedIpcHandle } from './registration.js';
import { createWorkspaceService, clearWorkspaceServiceCaches, getWorkspaceSession, getActiveWorkspaceSessionIdState, type AdmittedWorkspaceDirectory, type DirectorySelection, type OpenWorkspaceScanOptions, type WorkspaceServiceDeps } from '../services/workspaceService.js';
import { createWorkspaceRuntimeService } from '../services/workspaceRuntimeService.js';
export type { DirectorySelection, OpenWorkspaceScanOptions, AnalyzeWorkspaceSummary, RendererWorkspaceSession, WorkspaceIndexingStatus, RendererWorkspaceScanResult, WorkspaceRuntimeIdentity, WorkspaceRagSnapshotState, WorkspaceRagScope } from '../services/workspaceService.js';
export { getWorkspaceSession, getWorkspaceIndexedFiles, getWorkspaceIndexedFilesRevisionState, getWorkspaceRuntimeIdentityState, replaceWorkspaceIndexedFileState, getWorkspaceActiveIndex, getActiveWorkspaceSessionIdState, getActiveWorkspaceSessionGenerationState, getWorkspaceRag, getWorkspaceRagSnapshotState, getWorkspaceFingerprintStore, applyWorkspaceIndexSnapshot, applyWorkspaceRag, setWorkspaceForegroundActive, rebuildActionBinderMembershipIndex, ensureActionBinderMembershipForFamily, waitForWorkspaceIndexing } from '../services/workspaceService.js';
interface DirectorySelectionRecord extends DirectorySelection {
    absolutePath: string;
    kind: 'overlay' | 'base';
    ownerWebContentsId: number;
    expiresAt: number;
}
const directorySelections = new Map<string, DirectorySelectionRecord>();
const recentPathsFile = join(app.getPath('userData'), 'recent-paths.json');
function createDirectorySelection(event: IpcMainInvokeEvent, absolutePath: string, kind: DirectorySelectionRecord['kind']): DirectorySelection {
    const selection: DirectorySelectionRecord = { selectionId: randomUUID(), label: basename(absolutePath) || (kind === 'overlay' ? 'Mod 工作区' : '原版游戏目录'), absolutePath, kind, ownerWebContentsId: event.sender.id, expiresAt: Date.now() + 5 * 60000 };
    directorySelections.set(selection.selectionId, selection);
    return { selectionId: selection.selectionId, label: selection.label };
}
function consumeDirectorySelection(event: IpcMainInvokeEvent, selectionId: string, expectedKind: DirectorySelectionRecord['kind']): DirectorySelectionRecord {
    const selection = directorySelections.get(selectionId);
    directorySelections.delete(selectionId);
    if (!selection || selection.kind !== expectedKind || selection.ownerWebContentsId !== event.sender.id || selection.expiresAt < Date.now())
        throw new Error('目录选择凭据无效、已过期或不属于当前窗口。');
    return selection;
}
export function revokeDirectorySelectionsFor(webContentsId: number): void {
    for (const [selectionId, selection] of directorySelections) {
        if (selection.ownerWebContentsId === webContentsId)
            directorySelections.delete(selectionId);
    }
}
function admitted(record: DirectorySelectionRecord): AdmittedWorkspaceDirectory {
    return Object.freeze({ absolutePath: record.absolutePath, label: record.label, kind: record.kind });
}
export interface WorkspaceIpcDeps extends Omit<WorkspaceServiceDeps, 'resolveWorkspaceStoragePaths' | 'clearRememberedBase'> {
    handle: TrustedIpcHandle;
}
export function clearWorkspaceIpcCaches(): void { directorySelections.clear(); clearWorkspaceServiceCaches(); }
export function registerWorkspaceIpcHandlers(deps: WorkspaceIpcDeps): void {
    const handle = deps.handle;
    const service = createWorkspaceService({
        ensureActiveOperationLog: deps.ensureActiveOperationLog, clearActiveOperationLog: deps.clearActiveOperationLog,
        releaseEditorCaches: deps.releaseEditorCaches, verifiedReadRoots: deps.verifiedReadRoots,
        ...(deps.scheduleRagEmbedding ? { scheduleRagEmbedding: deps.scheduleRagEmbedding } : {}),
        resolveWorkspaceStoragePaths, clearRememberedBase: () => clearRecentPath(recentPathsFile, 'base')
    });
    const runtime = createWorkspaceRuntimeService({ getWorkspaceSession, getWorkspaceSessionId: getActiveWorkspaceSessionIdState,
        localApplicationDataRoot, createGateway: localDataRoot => new MainMe3RuntimeGateway({ localDataRoot }) });
    handle('runtime.detectMe3', () => runtime.detectMe3());
    handle('runtime.prepareMe3Profile', () => runtime.prepareMe3Profile());
    handle('runtime.launchMe3', (_event, profileId: string) => runtime.launchMe3(profileId));
    handle('runtime.terminateMe3', (_event, sessionId: string) => runtime.terminateMe3(sessionId));
    handle('workspace.lastSelection', async (event): Promise<{
        overlay: DirectorySelection | null;
        base: DirectorySelection | null;
    }> => {
        const overlayPath = readRecentPath(recentPathsFile, 'overlay');
        const basePath = readRecentPath(recentPathsFile, 'base');
        return { overlay: overlayPath ? createDirectorySelection(event, overlayPath, 'overlay') : null, base: basePath ? createDirectorySelection(event, basePath, 'base') : null };
    });
    handle('workspace.openDialog', async (event): Promise<DirectorySelection | null> => {
        const harnessPath = installedHarnessDirectory('overlay');
        if (harnessPath)
            return createDirectorySelection(event, harnessPath, 'overlay');
        const remembered = readRecentPath(recentPathsFile, 'overlay');
        const result = await dialog.showOpenDialog({ title: '打开 Mod 工作区', properties: ['openDirectory'], ...(remembered ? { defaultPath: remembered } : {}) });
        const selectedPath = result.canceled ? undefined : result.filePaths[0];
        if (selectedPath)
            writeRecentPath(recentPathsFile, 'overlay', selectedPath);
        return selectedPath ? createDirectorySelection(event, selectedPath, 'overlay') : null;
    });
    handle('workspace.openBaseDialog', async (event): Promise<DirectorySelection | null> => {
        const harnessPath = installedHarnessDirectory('base');
        if (harnessPath)
            return createDirectorySelection(event, harnessPath, 'base');
        const remembered = readRecentPath(recentPathsFile, 'base');
        const result = await dialog.showOpenDialog({ title: '打开原版游戏目录（可选）', properties: ['openDirectory'], ...(remembered ? { defaultPath: remembered } : {}) });
        const selectedPath = result.canceled ? undefined : result.filePaths[0];
        if (selectedPath)
            writeRecentPath(recentPathsFile, 'base', selectedPath);
        return selectedPath ? createDirectorySelection(event, selectedPath, 'base') : null;
    });
    function installedHarnessDirectory(kind: 'overlay' | 'base'): string | null {
        if (process.env.SF_E2E_INSTALLED_HARNESS !== '1')
            return null;
        const raw = (kind === 'overlay' ? process.env.SF_E2E_OVERLAY_ROOT : process.env.SF_E2E_BASE_ROOT)?.trim();
        if (!raw || !isAbsolute(raw) || !existsSync(raw)) {
            throw new Error(`INSTALLED_HARNESS_${kind.toUpperCase()}_PATH_INVALID`);
        }
        return resolve(raw);
    }
    handle('workspace.scan', (event, options: OpenWorkspaceScanOptions) => service.scan(options, () => admitted(consumeDirectorySelection(event, options.overlaySelectionId, 'overlay')), () => options.clearBase === true ? undefined : options.baseSelectionId ? admitted(consumeDirectorySelection(event, options.baseSelectionId, 'base')) : undefined, path => { const selected = createDirectorySelection(event, path, 'base'); return admitted(consumeDirectorySelection(event, selected.selectionId, 'base')); }));
    handle('workspace.remountBase', (event, baseSelectionId: string | null) => service.remountBase(() => baseSelectionId ? admitted(consumeDirectorySelection(event, baseSelectionId, 'base')) : undefined));
    handle('workspace.analyze', () => service.analyze());
}
