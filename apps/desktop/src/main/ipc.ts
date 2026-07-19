import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OpenAiCompatibleAdapter,
  AnthropicCompatibleAdapter,
  runAgentToolLoop,
  analyzeWorkspace,
  buildAiSidebarDraft,
  buildOutboundContext,
  createDefaultToolRegistry,
  createConfirmationReceipt,
  disposeBridgeDaemonPool,
  commitEmevdMutationViaBridge,
  commitEmevdEventAddThroughPatchIr,
  commitEmevdEventDeleteThroughPatchIr,
  commitEmevdEventDuplicateThroughPatchIr,
  commitEmevdEventReorderThroughPatchIr,
  commitEmevdInstructionAddThroughPatchIr,
  commitEmevdInstructionArgsThroughPatchIr,
  commitEmevdInstructionDeleteThroughPatchIr,
  commitEmevdInstructionDuplicateThroughPatchIr,
  commitEmevdInstructionReorderThroughPatchIr,
  commitEmevdRestBehaviorThroughPatchIr,
  commitFmgMutationViaBridge,
  commitFmgEntryAddThroughPatchIr,
  commitFmgEntryDeleteThroughPatchIr,
  commitFmgEntryReorderThroughPatchIr,
  commitFmgEntryTextThroughPatchIr,
  commitParamMutationViaBridge,
  commitMsbMutationViaBridge,
  commitMsbPartPositionThroughPatchIr,
  commitMsbRegionPositionThroughPatchIr,
  readFmgDocumentViaBridge,
  readParamDocumentViaBridge,
  readMsbDocumentViaBridge,
  openResourcePreview,
  openWorkspaceSession,
  inspectContainerTree,
  listContainerChildren,
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
  saveRawByteRange,
  saveRawReplace,
  saveTextResource,
  scanWorkspace,
  validateContainer,
  type AiSidebarDraft,
  type AiSidebarDraftRequest,
  type AgentRunResult,
  type ModelServiceConfig,
  type ToolDefinition as ModelToolDefinition,
  type ResourceCapabilityMatrix,
  type ToolContext,
  type ToolDescriptor,
  type ToolResult,
  type WorkspaceIndex,
  type WorkspaceSession,
  type AppPermissionGrant
} from '@soulforge/core';
import type {
  ConfirmationReceipt,
  Diagnostic,
  IndexedFile,
  ResourceKind
} from '@soulforge/shared';
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

let indexedFiles: IndexedFile[] = [];
let activeIndex: WorkspaceIndex | null = null;
let activeSession: WorkspaceSession | null = null;
let activeOperationLog: OperationLogUtilityClient | null = null;
let activeWorkspaceSessionId: string | null = null;
let handlersRegistered = false;
const trustedRendererDocuments = new Map<number, string>();
const directorySelections = new Map<string, DirectorySelectionRecord>();
const here = dirname(fileURLToPath(import.meta.url));
const operationLogUtility = new OperationLogUtilityClient(
  join(here, 'databaseUtility.js'),
  15_000,
  resolve(here, '../../.native/better_sqlite3.node')
);
const modelServiceVault = new ModelServiceCredentialVault(app.getPath('userData'), operationLogUtility);

const toolRegistry = createDefaultToolRegistry();
// Renderer cannot elevate mode. Mode is resolved from app.db permission grants.
// Default fallback remains plan until a higher grant exists.
const DEFAULT_AI_MODE: ToolContext['mode'] = 'plan';
const AI_PLAN_POLICY_VERSION = '1';
const AI_NORMAL_POLICY_VERSION = '1';
const AI_FULL_POLICY_VERSION = '1';

async function resolveAiModeForService(serviceId: string): Promise<{
  mode: ToolContext['mode'];
  grantId: string;
}> {
  const fullGrant = await operationLogUtility.getActivePermissionGrant(
    serviceId,
    'fullPermission',
    AI_FULL_POLICY_VERSION
  );
  if (fullGrant) {
    return { mode: 'fullPermission', grantId: fullGrant.grantId };
  }

  const normalGrant = await operationLogUtility.getActivePermissionGrant(
    serviceId,
    'normal',
    AI_NORMAL_POLICY_VERSION
  );
  if (normalGrant) {
    return { mode: 'normal', grantId: normalGrant.grantId };
  }

  let planGrant = await operationLogUtility.getActivePermissionGrant(
    serviceId,
    'plan',
    AI_PLAN_POLICY_VERSION
  );
  if (!planGrant) {
    planGrant = await operationLogUtility.replacePermissionGrant({
      grantId: randomUUID(),
      serviceId,
      policyVersion: AI_PLAN_POLICY_VERSION,
      permissionMode: 'plan',
      scope: { permissions: ['read', 'analyze', 'propose'] },
      grantedAt: new Date().toISOString()
    });
  }
  return { mode: 'plan', grantId: planGrant.grantId };
}

function systemPromptForMode(mode: ToolContext['mode']): string {
  if (mode === 'fullPermission') {
    return '你是 SoulForge 完全权限助手。工具仍必须经过 Patch Engine 与 policy gate；不得绕过确认、暂存、验证、提交或回滚流程。工具输入不得包含绝对路径。';
  }
  if (mode === 'normal') {
    return '你是 SoulForge 普通模式助手。可读取、分析、提案并暂存/验证，但提交与回滚仍受 policy gate 与确认约束。工具输入不得包含绝对路径。';
  }
  return '你是 SoulForge 计划模式助手。只能读取、分析和生成补丁提案；不得暂存、验证暂存输出、提交或回滚。工具输入不得包含绝对路径。';
}

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

async function ensureAppDatabase(): Promise<void> {
  await operationLogUtility.openApp(join(app.getPath('userData'), 'app.db'));
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

async function stageBridgeOutput<T extends { ok: boolean }>(input: {
  session: WorkspaceSession;
  storage: ReturnType<typeof durableStoragePaths>;
  prefix: string;
  fileName: string;
  write: (context: {
    outputPath: string;
    allowedRoots: string[];
    writableRoots: string[];
  }) => Promise<T>;
}): Promise<{ result: T; bytes?: Buffer }> {
  await mkdir(input.storage.stagingRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(input.storage.stagingRoot, `${input.prefix}-`));
  const outputPath = join(stagingDirectory, input.fileName);
  try {
    const result = await input.write({
      outputPath,
      allowedRoots: bridgeAllowedRoots(input.session, input.storage.stagingRoot),
      writableRoots: [input.storage.stagingRoot]
    });
    if (!result.ok) return { result };
    return { result, bytes: await readFile(outputPath) };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
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

export async function initializeAppData(): Promise<void> {
  await ensureAppDatabase();
  await operationLogUtility.cleanupExpiredAiHistory();
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

async function requestMainNativeConfirmation(input: {
  event: IpcMainInvokeEvent;
  title: string;
  message: string;
  detail: string;
}): Promise<boolean> {
  const parent = BrowserWindow.fromWebContents(input.event.sender);
  const options = {
    type: 'warning' as const,
    title: input.title,
    message: input.message,
    detail: input.detail,
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const decision = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return decision.response === 1;
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
  const confirmed = await requestMainNativeConfirmation({
    event: input.event,
    title: '确认高风险写入',
    message: `确认${input.actionLabel}“${input.resourceLabel}”吗？`,
    detail: '操作将只通过补丁引擎写入 Mod 覆盖层，并执行验证、备份和可回滚检查。原生格式证据不足时仍会阻断。'
  });
  if (!confirmed) return null;
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

function permissionModeLabel(mode: ToolContext['mode']): string {
  if (mode === 'fullPermission') return '完全权限';
  if (mode === 'normal') return '普通模式';
  return '计划模式';
}

function defaultScopeForMode(mode: ToolContext['mode']): { permissions: string[] } {
  if (mode === 'plan') {
    return { permissions: ['read', 'analyze', 'propose'] };
  }
  if (mode === 'normal') {
    return { permissions: ['read', 'analyze', 'propose', 'stage', 'validate'] };
  }
  return {
    permissions: ['read', 'analyze', 'propose', 'stage', 'validate', 'commit', 'rollback']
  };
}

function policyVersionForMode(mode: ToolContext['mode']): string {
  if (mode === 'fullPermission') return AI_FULL_POLICY_VERSION;
  if (mode === 'normal') return AI_NORMAL_POLICY_VERSION;
  return AI_PLAN_POLICY_VERSION;
}

function normalizePermissionMode(mode: unknown): ToolContext['mode'] {
  if (mode === 'fullPermission' || mode === 'normal' || mode === 'plan') return mode;
  if (mode === 'full') return 'fullPermission';
  throw new Error('PERMISSION_GRANT_MODE_INVALID');
}

function normalizePermissionScope(
  scope: unknown,
  mode: ToolContext['mode']
): Record<string, unknown> {
  const resolved = scope ?? defaultScopeForMode(mode);
  if (
    resolved === null
    || typeof resolved !== 'object'
    || Array.isArray(resolved)
    || (Object.getPrototypeOf(resolved) !== Object.prototype
      && Object.getPrototypeOf(resolved) !== null)
  ) {
    throw new Error('PERMISSION_GRANT_SCOPE_INVALID');
  }
  return { ...resolved };
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

  handle('resource.capabilities', async (_event, sourceUri: string): Promise<ResourceCapabilityMatrix | null> => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return resolveResourceCapabilities(file);
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

  handle(
    'resource.saveRawReplace',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      newContentBase64: string
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw replace.',
            sourceUri
          }]
        };
      }
      const operationLog = activeSession
        ? await ensureActiveOperationLog(activeSession)
        : undefined;
      const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      const confirmation = await requestWriteConfirmation({
        event,
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '替换原始字节',
        payloadHash: createHash('sha256')
          .update(`${expectedHash}\n${newContentBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      const result = await saveRawReplace({
        file,
        expectedHash,
        newContentBase64,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      return toRendererSaveResult(result, indexedFiles);
    }
  );

  handle(
    'resource.saveRawByteRange',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      offset: number,
      length: number,
      replacementBase64: string
    ): Promise<RendererSaveResult> => {
      const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
      if (!file) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: [{
            severity: 'error',
            code: 'RESOURCE_NOT_INDEXED',
            message: 'Resource must be indexed before raw byte-range patch.',
            sourceUri
          }]
        };
      }
      const operationLog = activeSession
        ? await ensureActiveOperationLog(activeSession)
        : undefined;
      const storage = activeSession ? durableStoragePaths(activeSession.meta.workspaceId) : undefined;
      const confirmation = await requestWriteConfirmation({
        event,
        resourceLabel: file.relativePath,
        sourceUri,
        actionLabel: '修改原始字节范围',
        payloadHash: createHash('sha256')
          .update(`${expectedHash}\n${offset}\n${length}\n${replacementBase64}`)
          .digest('hex')
      });
      if (!confirmation) return cancelledWrite(sourceUri);
      const result = await saveRawByteRange({
        file,
        expectedHash,
        offset,
        length,
        replacementBase64,
        confirmation,
        ...(activeSession ? { session: activeSession } : {}),
        ...(operationLog ? { operationLog } : {}),
        ...(storage ?? {})
      });
      return toRendererSaveResult(result, indexedFiles);
    }
  );

  handle('resource.readRawMetadata', async (_event, sourceUri: string) => {
    const file = indexedFiles.find((item) => item.sourceUri === sourceUri);
    if (!file) return null;
    return readRawResourceMetadata(file, { computeHash: file.size <= 32 * 1024 * 1024 });
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
   * 已迁移字段、事件与 instruction mutation 走 typed PatchIR + 原生语义 writer；
   * 其余 EMEVD mutation 在精确 inverse contract 完成前仍走 Bridge 暂存 + whole-file raw replace。
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
      if (bridgeMutation.kind === 'set_rest_behavior') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          restBehavior: Number(mutation.restBehavior),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD restBehavior typed semantic mutation'
        };
        let result = await commitEmevdRestBehaviorThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            restBehavior: semanticOptions.restBehavior
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 EMEVD restBehavior 语义变更',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_REST_BEHAVIOR']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdRestBehaviorThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'reorder_event') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          ...(mutation.beforeEventIndex === undefined
            ? {}
            : { beforeEventIndex: Number(mutation.beforeEventIndex) }),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD event reorder typed semantic mutation'
        };
        let result = await commitEmevdEventReorderThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            beforeEventIndex: semanticOptions.beforeEventIndex
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 EMEVD 事件重排',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_EVENT_REORDER']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdEventReorderThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'add_event') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          newEventId: Number(mutation.newEventId),
          ...(mutation.restBehavior === undefined
            ? {}
            : { restBehavior: Number(mutation.restBehavior) }),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD event add typed semantic mutation'
        };
        let result = await commitEmevdEventAddThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            newEventId: semanticOptions.newEventId,
            restBehavior: semanticOptions.restBehavior ?? 0
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '新增 EMEVD 空事件',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_EVENT_ADD']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdEventAddThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'delete_event') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD event delete typed semantic mutation'
        };
        let result = await commitEmevdEventDeleteThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '删除 EMEVD 事件',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_EVENT_DELETE']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdEventDeleteThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'duplicate_event') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          sourceEventId: Number(mutation.eventId),
          sourceEventIndex: Number(mutation.eventIndex),
          newEventId: Number(mutation.newEventId),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD event duplicate typed semantic mutation'
        };
        let result = await commitEmevdEventDuplicateThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            sourceEventId: semanticOptions.sourceEventId,
            sourceEventIndex: semanticOptions.sourceEventIndex,
            newEventId: semanticOptions.newEventId
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '复制 EMEVD 事件',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_EVENT_DUPLICATE']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdEventDuplicateThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'add_instruction') {
        if (typeof mutation.argsBase64 !== 'string') {
          return {
            ok: false,
            changedFiles: [],
            diagnostics: [{
              severity: 'error',
              code: 'EMEVD_SEMANTIC_INPUT_INVALID',
              message: '新增 EMEVD 指令必须显式提供 argsBase64。',
              sourceUri
            }]
          };
        }
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          instructionIndex: Number(mutation.instructionIndex),
          bank: Number(mutation.bank),
          instructionId: Number(mutation.id),
          argsBase64: mutation.argsBase64,
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD instruction add typed semantic mutation'
        };
        let result = await commitEmevdInstructionAddThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            instructionIndex: semanticOptions.instructionIndex,
            bank: semanticOptions.bank,
            instructionId: semanticOptions.instructionId,
            argsBase64: semanticOptions.argsBase64
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '新增 EMEVD 指令',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_INSTRUCTION_ADD']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdInstructionAddThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'duplicate_instruction') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          sourceInstructionIndex: Number(mutation.instructionIndex),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD instruction duplicate typed semantic mutation'
        };
        let result = await commitEmevdInstructionDuplicateThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            sourceInstructionIndex: semanticOptions.sourceInstructionIndex
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '复制 EMEVD 指令',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_INSTRUCTION_DUPLICATE']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdInstructionDuplicateThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'delete_instruction') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          instructionIndex: Number(mutation.instructionIndex),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD instruction delete typed semantic mutation'
        };
        let result = await commitEmevdInstructionDeleteThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            instructionIndex: semanticOptions.instructionIndex
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '删除 EMEVD 指令',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_INSTRUCTION_DELETE']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdInstructionDeleteThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (bridgeMutation.kind === 'reorder_instruction') {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          instructionIndex: Number(mutation.instructionIndex),
          ...(mutation.beforeInstructionIndex === undefined
            ? {}
            : { beforeInstructionIndex: Number(mutation.beforeInstructionIndex) }),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD instruction reorder typed semantic mutation'
        };
        let result = await commitEmevdInstructionReorderThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            instructionIndex: semanticOptions.instructionIndex,
            beforeInstructionIndex: semanticOptions.beforeInstructionIndex
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '重排 EMEVD 指令',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_INSTRUCTION_REORDER']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdInstructionReorderThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (
        (bridgeMutation.kind === 'set_instruction_args'
          || bridgeMutation.kind === 'emevd_set_instruction_args')
        && Number.isSafeInteger(Number(mutation.eventId))
        && Number.isSafeInteger(Number(mutation.eventIndex))
        && Number.isSafeInteger(Number(
          mutation.instructionLocalIndex ?? mutation.instructionIndex
        ))
        && Number.isSafeInteger(Number(mutation.expectedBank ?? mutation.bank))
        && Number.isSafeInteger(Number(mutation.expectedInstructionId ?? mutation.id))
        && typeof mutation.argsBase64 === 'string'
      ) {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          eventId: Number(mutation.eventId),
          eventIndex: Number(mutation.eventIndex),
          instructionIndex: Number(mutation.instructionLocalIndex ?? mutation.instructionIndex),
          expectedBank: Number(mutation.expectedBank ?? mutation.bank),
          expectedInstructionId: Number(mutation.expectedInstructionId ?? mutation.id),
          argsBase64: String(mutation.argsBase64),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'EMEVD instruction args typed semantic mutation'
        };
        let result = await commitEmevdInstructionArgsThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            eventId: semanticOptions.eventId,
            eventIndex: semanticOptions.eventIndex,
            instructionIndex: semanticOptions.instructionIndex,
            expectedBank: semanticOptions.expectedBank,
            expectedInstructionId: semanticOptions.expectedInstructionId,
            argsBase64: semanticOptions.argsBase64
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 EMEVD 指令参数语义变更',
            payloadHash,
            extraSubjects: ['EMEVD_SEMANTIC_INSTRUCTION_ARGS']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitEmevdInstructionArgsThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      const stagedOutput = await stageBridgeOutput({
        session: activeSession,
        storage,
        prefix: 'emevd',
        fileName: `${basename(file.relativePath)}.mut.emevd`,
        write: (context) => commitEmevdMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedSourceHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation,
          ...(typeof mutation.instructionIndex === 'number'
            ? { instructionIndex: mutation.instructionIndex }
            : {}),
          timeoutMs: 120_000
        })
      });
      const staged = stagedOutput.result;
      if (!staged.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: staged.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const bytes = stagedOutput.bytes!;
      const newContentBase64 = bytes.toString('base64');
      const operationLog = await ensureActiveOperationLog(activeSession);
      let result = await saveRawReplace({
        file,
        expectedHash,
        newContentBase64,
        session: activeSession,
        operationLog,
        ...storage,
        title: `EMEVD mutation ${String(mutation.kind ?? 'edit')}`
      });
      if (!result.ok && result.requiresConfirmation) {
        const confirmation = await requestWriteConfirmation({
          event,
          resourceLabel: file.relativePath,
          sourceUri,
          actionLabel: '提交 EMEVD 变更',
          payloadHash: createHash('sha256').update(bytes).digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        result = await saveRawReplace({
          file,
          expectedHash,
          newContentBase64,
          confirmation,
          session: activeSession,
          operationLog,
          ...storage,
          title: `EMEVD mutation ${String(mutation.kind ?? 'edit')}`
        });
      }
      if (result.ok) {
        const refreshed = await openResourcePreview({
          file,
          inspectNative: true,
          parseStructured: true,
          ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
        });
        const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
        if (index >= 0) indexedFiles[index] = refreshed.file;
      }
      return toRendererSaveResult(result, indexedFiles);
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
              text: e.text,
              stringIndex: e.stringIndex
            })),
            entriesTruncated: result.data.entries.length > 500,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

  handle(
    'resource.applyFmgMutation',
    async (
      event,
      sourceUri: string,
      expectedHash: string,
      mutation: {
        kind: 'upsert' | 'delete' | 'insert' | 'reorder';
        id: number;
        text?: string;
        stringIndex?: number;
        beforeStringIndex?: number;
      }
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
      if (mutation.kind === 'reorder'
        && Number.isSafeInteger(mutation.stringIndex)
        && (mutation.beforeStringIndex === undefined
          || Number.isSafeInteger(mutation.beforeStringIndex))) {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          entryId: mutation.id,
          stringIndex: mutation.stringIndex!,
          ...(mutation.beforeStringIndex !== undefined
            ? { beforeStringIndex: mutation.beforeStringIndex }
            : {}),
          session: activeSession,
          operationLog,
          ...storage,
          title: 'FMG slot reorder typed semantic mutation'
        };
        let result = await commitFmgEntryReorderThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            entryId: semanticOptions.entryId,
            stringIndex: semanticOptions.stringIndex,
            beforeStringIndex: mutation.beforeStringIndex ?? null,
            kind: 'reorder'
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 FMG 槽位重排语义变更',
            payloadHash,
            extraSubjects: ['FMG_SEMANTIC_ENTRY_REORDER']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitFmgEntryReorderThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (mutation.kind === 'insert' && Number.isSafeInteger(mutation.stringIndex)) {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          entryId: mutation.id,
          stringIndex: mutation.stringIndex!,
          text: mutation.text ?? '',
          session: activeSession,
          operationLog,
          ...storage,
          title: 'FMG slot insert typed semantic mutation'
        };
        let result = await commitFmgEntryAddThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            entryId: semanticOptions.entryId,
            stringIndex: semanticOptions.stringIndex,
            text: semanticOptions.text,
            kind: 'insert'
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 FMG 槽位新增语义变更',
            payloadHash,
            extraSubjects: ['FMG_SEMANTIC_ENTRY_ADD']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitFmgEntryAddThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (mutation.kind === 'upsert' && Number.isSafeInteger(mutation.stringIndex)) {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          entryId: mutation.id,
          stringIndex: mutation.stringIndex!,
          text: mutation.text ?? '',
          session: activeSession,
          operationLog,
          ...storage,
          title: 'FMG existing-entry text typed semantic mutation'
        };
        let result = await commitFmgEntryTextThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            entryId: semanticOptions.entryId,
            stringIndex: semanticOptions.stringIndex,
            text: semanticOptions.text
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 FMG 条目文本语义变更',
            payloadHash,
            extraSubjects: ['FMG_SEMANTIC_ENTRY_TEXT']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitFmgEntryTextThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      if (mutation.kind === 'delete' && Number.isSafeInteger(mutation.stringIndex)) {
        const operationLog = await ensureActiveOperationLog(activeSession);
        const semanticOptions = {
          file,
          expectedHash,
          entryId: mutation.id,
          stringIndex: mutation.stringIndex!,
          session: activeSession,
          operationLog,
          ...storage,
          title: 'FMG slot delete typed semantic mutation'
        };
        let result = await commitFmgEntryDeleteThroughPatchIr(semanticOptions);
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            entryId: semanticOptions.entryId,
            stringIndex: semanticOptions.stringIndex,
            kind: 'delete'
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: '提交 FMG 槽位删除语义变更',
            payloadHash,
            extraSubjects: ['FMG_SEMANTIC_ENTRY_DELETE']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitFmgEntryDeleteThroughPatchIr({
            ...semanticOptions,
            confirmation
          });
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      const bridgeMutation =
        mutation.kind === 'delete'
          ? { kind: 'delete' as const, id: mutation.id }
          : { kind: 'upsert' as const, id: mutation.id, text: mutation.text ?? '' };
      const stagedOutput = await stageBridgeOutput({
        session: activeSession,
        storage,
        prefix: 'fmg',
        fileName: `${basename(file.relativePath)}.mut.fmg`,
        write: (context) => commitFmgMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        })
      });
      const staged = stagedOutput.result;
      if (!staged.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: staged.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const bytes = stagedOutput.bytes!;
      const operationLog = await ensureActiveOperationLog(activeSession);
      let result = await saveRawReplace({
        file,
        expectedHash,
        newContentBase64: bytes.toString('base64'),
        session: activeSession,
        operationLog,
        ...storage,
        title: `FMG mutation ${mutation.kind} ${mutation.id}`
      });
      if (!result.ok && result.requiresConfirmation) {
        const confirmation = await requestWriteConfirmation({
          event,
          resourceLabel: file.relativePath,
          sourceUri,
          actionLabel: '提交 FMG 变更',
          payloadHash: createHash('sha256').update(bytes).digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        result = await saveRawReplace({
          file,
          expectedHash,
          newContentBase64: bytes.toString('base64'),
          confirmation,
          session: activeSession,
          operationLog,
          ...storage,
          title: `FMG mutation ${mutation.kind} ${mutation.id}`
        });
      }
      return toRendererSaveResult(result, indexedFiles);
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
      maxRegions: 128
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
            parts: result.data.parts,
            regions: result.data.regions,
            authority: result.data.authority,
            entityEdit: result.data.entityEdit
          }
        : null,
      diagnostics: result.diagnostics
    });
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
      const storage = durableStoragePaths(activeSession.meta.workspaceId);
      if (
        (mutation.kind === 'set_part_position' || mutation.kind === 'set_region_position')
        && Number.isFinite(mutation.posX)
        && Number.isFinite(mutation.posY)
        && Number.isFinite(mutation.posZ)
      ) {
        const entityKind = mutation.kind === 'set_part_position' ? 'part' : 'region';
        const operationLog = await ensureActiveOperationLog(activeSession);
        const commonOptions = {
          file,
          expectedHash,
          posX: mutation.posX!,
          posY: mutation.posY!,
          posZ: mutation.posZ!,
          session: activeSession,
          operationLog,
          ...storage,
          title: `MSB ${entityKind} position typed semantic mutation`
        };
        const commitSemantic = (confirmation?: Awaited<ReturnType<typeof requestWriteConfirmation>>) => (
          entityKind === 'part'
            ? commitMsbPartPositionThroughPatchIr({
                ...commonOptions,
                partName: mutation.partName,
                ...(confirmation ? { confirmation } : {})
              })
            : commitMsbRegionPositionThroughPatchIr({
                ...commonOptions,
                regionName: mutation.partName,
                ...(confirmation ? { confirmation } : {})
              })
        );
        let result = await commitSemantic();
        if (!result.ok && result.requiresConfirmation) {
          const payloadHash = createHash('sha256').update(JSON.stringify({
            sourceUri,
            expectedHash,
            entityKind,
            entityName: mutation.partName,
            posX: commonOptions.posX,
            posY: commonOptions.posY,
            posZ: commonOptions.posZ
          })).digest('hex');
          const confirmation = await requestWriteConfirmation({
            event,
            resourceLabel: file.relativePath,
            sourceUri,
            actionLabel: `提交 MSB ${entityKind} 位置语义变更`,
            payloadHash,
            extraSubjects: [entityKind === 'part'
              ? 'MSB_SEMANTIC_PART_POSITION'
              : 'MSB_SEMANTIC_REGION_POSITION']
          });
          if (!confirmation) return cancelledWrite(sourceUri);
          result = await commitSemantic(confirmation);
        }
        if (result.ok) {
          const refreshed = await openResourcePreview({
            file,
            inspectNative: true,
            parseStructured: true,
            ...(activeSession.layers.baseRoot ? { oodleRuntimeRoot: activeSession.layers.baseRoot } : {})
          });
          const index = indexedFiles.findIndex((item) => item.sourceUri === sourceUri);
          if (index >= 0) indexedFiles[index] = refreshed.file;
        }
        return toRendererSaveResult(result, indexedFiles);
      }
      const stagedOutput = await stageBridgeOutput({
        session: activeSession,
        storage,
        prefix: 'msb',
        fileName: `${basename(file.relativePath)}.mut.msb`,
        write: (context) => commitMsbMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation
        })
      });
      const staged = stagedOutput.result;
      if (!staged.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: staged.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const bytes = stagedOutput.bytes!;
      const operationLog = await ensureActiveOperationLog(activeSession);
      let result = await saveRawReplace({
        file,
        expectedHash,
        newContentBase64: bytes.toString('base64'),
        session: activeSession,
        operationLog,
        ...storage,
        title: `MSB mutation ${mutation.kind} ${mutation.partName}`
      });
      if (!result.ok && result.requiresConfirmation) {
        const confirmation = await requestWriteConfirmation({
          event,
          resourceLabel: file.relativePath,
          sourceUri,
          actionLabel: '提交 MSB 变更',
          payloadHash: createHash('sha256').update(bytes).digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        result = await saveRawReplace({
          file,
          expectedHash,
          newContentBase64: bytes.toString('base64'),
          confirmation,
          session: activeSession,
          operationLog,
          ...storage,
          title: `MSB mutation ${mutation.kind} ${mutation.partName}`
        });
      }
      return toRendererSaveResult(result, indexedFiles);
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
      rowOffset: 0,
      rowLimit: 100,
      includePayloads: true
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
              dataHash: r.dataHash,
              ...(r.dataBase64 ? { dataBase64: r.dataBase64 } : {}),
              ...(r.name ? { name: r.name } : {}),
              dataHexPreview: r.dataBase64
                ? Buffer.from(r.dataBase64, 'base64').subarray(0, 16).toString('hex')
                : ''
            })),
            rowOffset: result.data.rowOffset,
            rowLimit: result.data.rowLimit,
            rowsReturned: result.data.rowsReturned,
            rowsTruncated: result.data.rowsTruncated,
            payloadsIncluded: result.data.payloadsIncluded,
            payloadOmissionReason: result.data.payloadOmissionReason,
            authority: result.data.authority
          }
        : null,
      diagnostics: result.diagnostics
    });
  });

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
      const stagedOutput = await stageBridgeOutput({
        session: activeSession,
        storage,
        prefix: 'param',
        fileName: `${basename(file.relativePath)}.mut.param`,
        write: (context) => commitParamMutationViaBridge({
          sourcePath: file.absolutePath,
          outputPath: context.outputPath,
          expectedDocumentHash: expectedHash,
          allowedRoots: context.allowedRoots,
          writableRoots: context.writableRoots,
          mutation: bridgeMutation
        })
      });
      const staged = stagedOutput.result;
      if (!staged.ok) {
        return {
          ok: false,
          changedFiles: [],
          diagnostics: staged.diagnostics.map((d) => ({
            severity: d.severity as Diagnostic['severity'],
            code: d.code,
            message: d.message,
            sourceUri
          }))
        };
      }
      const bytes = stagedOutput.bytes!;
      const operationLog = await ensureActiveOperationLog(activeSession);
      let result = await saveRawReplace({
        file,
        expectedHash,
        newContentBase64: bytes.toString('base64'),
        session: activeSession,
        operationLog,
        ...storage,
        title: `PARAM mutation ${mutation.kind} ${mutation.id}`
      });
      if (!result.ok && result.requiresConfirmation) {
        const confirmation = await requestWriteConfirmation({
          event,
          resourceLabel: file.relativePath,
          sourceUri,
          actionLabel: '提交 PARAM 变更',
          payloadHash: createHash('sha256').update(bytes).digest('hex')
        });
        if (!confirmation) return cancelledWrite(sourceUri);
        result = await saveRawReplace({
          file,
          expectedHash,
          newContentBase64: bytes.toString('base64'),
          confirmation,
          session: activeSession,
          operationLog,
          ...storage,
          title: `PARAM mutation ${mutation.kind} ${mutation.id}`
        });
      }
      return toRendererSaveResult(result, indexedFiles);
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
      settings: { ...request.settings, mode: DEFAULT_AI_MODE },
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

      return toolRegistry.executeToolThroughPolicy(name, input, {
        workspaceIndex: activeIndex,
        mode: DEFAULT_AI_MODE,
        ...(activeSession?.layers.overlayRoot
          ? { workspaceRoot: activeSession.layers.overlayRoot }
          : {})
      });
    }
  );

  handle(
    'ai.runModel',
    async (
      _event,
      input: { configId: string; userPrompt: string }
    ): Promise<AgentRunResult> => {
      if (!activeIndex || !activeSession) {
        return failedAgentRun(input.configId, 'MODEL_SERVICE_WORKSPACE_REQUIRED', '需要先打开并分析工作区。');
      }
      const prompt = typeof input.userPrompt === 'string' ? input.userPrompt.trim() : '';
      if (!prompt) {
        return failedAgentRun(input.configId, 'MODEL_SERVICE_PROMPT_REQUIRED', '模型服务请求需要非空目标。');
      }
      await ensureAppDatabase();
      const configs = await modelServiceVault.listConfigs();
      const stored = configs.find((config) => config.id === input.configId);
      if (!stored) {
        return failedAgentRun(input.configId, 'MODEL_SERVICE_CONFIG_NOT_FOUND', '模型服务配置不存在。');
      }
      const apiKey = await modelServiceVault.resolveApiKey(stored.id);
      if (!apiKey) {
        return failedAgentRun(stored.id, 'MODEL_SERVICE_CREDENTIAL_REQUIRED', '模型服务凭据缺失或无法解密。');
      }
      const resolved = await resolveAiModeForService(stored.id);
      const activeMode = resolved.mode;
      const grantId = resolved.grantId;
      const config: ModelServiceConfig = { ...stored };
      const adapter = stored.protocol === 'anthropic-compatible'
        ? new AnthropicCompatibleAdapter({
            baseUrl: stored.baseUrl,
            apiKey,
            model: stored.model
          })
        : new OpenAiCompatibleAdapter({
            baseUrl: stored.baseUrl,
            apiKey,
            model: stored.model
          });
      const tools = modelToolDefinitions(toolRegistry.list());
      const toolLoopState: Record<string, unknown> = {};
      const outbound = await buildOutboundContext({
        session: activeSession,
        modelServiceId: stored.id,
        agentRunId: randomUUID(),
        items: [
          {
            kind: 'user_prompt',
            text: prompt
          },
          {
            kind: 'workspace_summary',
            workspaceSessionId: activeWorkspaceSessionId ?? activeSession.meta.workspaceId,
            ...(activeIndex ? { fileCount: activeIndex.getStats().files } : {})
          }
        ],
        forbiddenRoots: [
          app.getPath('userData'),
          ...(activeSession.layers.stagingRoot ? [activeSession.layers.stagingRoot] : [])
        ],
        redactApiKey: apiKey
      });
      if (!outbound.ok) {
        return failedAgentRun(
          stored.id,
          outbound.diagnostics[0]?.code ?? 'CONTEXT_BROKER_DENIED',
          outbound.diagnostics[0]?.message ?? 'Context Broker 拒绝了本次外发上下文。'
        );
      }
      const result = await runAgentToolLoop(adapter, {
        config,
        apiKey,
        messages: [
          {
            role: 'system',
            content: systemPromptForMode(activeMode)
          },
          { role: 'user', content: prompt }
        ],
        tools,
        permissionMode: activeMode,
        executeTool: async (call) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(call.argumentsJson);
          } catch {
            return {
              ok: false,
              code: 'AGENT_TOOL_ARGUMENTS_INVALID',
              content: JSON.stringify({
                ok: false,
                code: 'AGENT_TOOL_ARGUMENTS_INVALID',
                message: '工具参数不是合法 JSON。'
              })
            };
          }
          const result = await toolRegistry.executeToolThroughPolicy(call.name, parsed, {
            workspaceIndex: activeIndex!,
            mode: activeMode,
            workspaceRoot: activeSession!.layers.overlayRoot,
            state: toolLoopState
          });
          return {
            ok: result.ok,
            ...(result.error?.code ? { code: result.error.code } : {}),
            content: JSON.stringify(sanitizeRendererValue(result))
          };
        },
        maxSteps: 8
      });
      const retention = await operationLogUtility.getAiHistoryRetentionMode();
        const retentionMode = retention.mode;
      await operationLogUtility.recordAgentRun({
        runId: outbound.agentRunId,
        workspaceKey: activeSession.meta.workspaceId,
        serviceId: stored.id,
        retentionMode,
        messages: result.messages,
        result,
        outboundContextItems: outbound.outboundContextItems
      });
      await operationLogUtility.cleanupExpiredAiHistory();
      return result;
    }
  );

  // Model service configs — renderer receives DTO without secrets.
  handle('modelService.list', async () => {
    await ensureAppDatabase();
    return modelServiceVault.listConfigs();
  });

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
      await ensureAppDatabase();
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
    await ensureAppDatabase();
    await modelServiceVault.deleteConfig(configId);
    return { ok: true };
  });

  handle(
    'permissionGrant.getActive',
    async (
      _event,
      input: {
        serviceId: string;
        permissionMode: unknown;
        policyVersion?: string;
      }
    ) => {
      await ensureAppDatabase();
      const mode = normalizePermissionMode(input.permissionMode);
      const policyVersion = input.policyVersion ?? policyVersionForMode(mode);
      return operationLogUtility.getActivePermissionGrant(input.serviceId, mode, policyVersion);
    }
  );

  handle(
    'permissionGrant.getResolvedMode',
    async (_event, input: { serviceId: string }) => {
      await ensureAppDatabase();
      if (typeof input.serviceId !== 'string' || input.serviceId.trim().length === 0) {
        throw new Error('PERMISSION_GRANT_SERVICE_ID_REQUIRED');
      }
      const resolved = await resolveAiModeForService(input.serviceId.trim());
      return {
        serviceId: input.serviceId.trim(),
        permissionMode: resolved.mode,
        grantId: resolved.grantId
      };
    }
  );

  handle(
    'permissionGrant.replace',
    async (
      event,
      input: {
        serviceId: string;
        permissionMode: ToolContext['mode'];
        policyVersion?: string;
        scope?: unknown;
        grantId?: string;
        grantedAt?: string;
      }
    ) => {
      await ensureAppDatabase();
      if (typeof input.serviceId !== 'string' || input.serviceId.trim().length === 0) {
        throw new Error('PERMISSION_GRANT_SERVICE_ID_REQUIRED');
      }
      const serviceId = input.serviceId.trim();
      const mode = normalizePermissionMode(input.permissionMode);
      const policyVersion = input.policyVersion ?? policyVersionForMode(mode);

      // plan 可直接授权；normal / fullPermission 必须经 main 原生确认，禁止 renderer 静默提权。
      if (mode === 'normal' || mode === 'fullPermission') {
        const confirmed = await requestMainNativeConfirmation({
          event,
          title: '确认提升模型服务权限',
          message: `将“${serviceId}”提升到${permissionModeLabel(mode)}？`,
          detail: mode === 'fullPermission'
            ? '完全权限仍必须经过 Patch Engine 与 policy gate，但可在已有确认链路下提交/回滚。提权后可随时撤销。'
            : '普通模式允许暂存与验证，提交/回滚仍需确认。提权后可随时撤销。'
        });
        if (!confirmed) {
          throw new Error('PERMISSION_GRANT_ELEVATION_CANCELLED');
        }
      }

      const grant: AppPermissionGrant = {
        grantId: input.grantId ?? randomUUID(),
        serviceId,
        policyVersion,
        permissionMode: mode,
        scope: normalizePermissionScope(input.scope, mode),
        grantedAt: input.grantedAt ?? new Date().toISOString()
      };
      return operationLogUtility.replacePermissionGrant(grant);
    }
  );

  handle(
    'permissionGrant.revoke',
    async (
      event,
      input: { grantId: string; revokedAt?: string }
    ) => {
      await ensureAppDatabase();
      if (typeof input.grantId !== 'string' || input.grantId.trim().length === 0) {
        throw new Error('PERMISSION_GRANT_ID_REQUIRED');
      }
      const grantId = input.grantId.trim();
      const confirmed = await requestMainNativeConfirmation({
        event,
        title: '确认撤销模型服务权限',
        message: `撤销授权 ${grantId}？`,
        detail: '撤销后该服务将回落到仍有效的较低授权；若无更高授权则使用计划模式。'
      });
      if (!confirmed) {
        throw new Error('PERMISSION_GRANT_REVOKE_CANCELLED');
      }
      await operationLogUtility.revokePermissionGrant(grantId, input.revokedAt);
      return { ok: true };
    }
  );

  // Main-only AI history/retention reads. Intentionally not exposed via preload/renderer in this batch.
  handle('ai.history.getAgentRun', async (_event, input: { runId: string }) => {
    await ensureAppDatabase();
    if (typeof input?.runId !== 'string' || input.runId.trim().length === 0) {
      throw new Error('AI_HISTORY_RUN_ID_REQUIRED');
    }
    const detail = await operationLogUtility.getAgentRun(input.runId.trim());
    return detail;
  });

  handle('ai.history.listAgentRuns', async (_event, input: { workspaceKey?: string; serviceId?: string; limit?: number } = {}) => {
    await ensureAppDatabase();
    const limit = typeof input?.limit === 'number' && Number.isFinite(input.limit) ? Math.max(1, Math.min(200, Math.floor(input.limit))) : 50;
    return operationLogUtility.listAgentRuns({
      ...(typeof input?.workspaceKey === 'string' && input.workspaceKey.trim() ? { workspaceKey: input.workspaceKey.trim() } : {}),
      ...(typeof input?.serviceId === 'string' && input.serviceId.trim() ? { serviceId: input.serviceId.trim() } : {}),
      limit
    });
  });

  handle('ai.history.getRetentionMode', async () => {
    await ensureAppDatabase();
    return { mode: await operationLogUtility.getAiHistoryRetentionMode() };
  });

  handle('ai.history.setRetentionMode', async (_event, input: { mode: 'thirty_days' | 'session' | 'forever' }) => {
    await ensureAppDatabase();
    if (input?.mode !== 'thirty_days' && input?.mode !== 'session' && input?.mode !== 'forever') {
      throw new Error('AI_HISTORY_RETENTION_MODE_INVALID');
    }
    return { mode: await operationLogUtility.setAiHistoryRetentionMode(input.mode) };
  });
}

function modelToolDefinitions(descriptors: ToolDescriptor[]): ModelToolDefinition[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: true
    },
    permission: descriptor.permissionLevel ?? (
      descriptor.permission === 'plan'
        ? 'propose'
        : descriptor.permission === 'write'
          ? 'commit'
          : descriptor.permission
    )
  }));
}

function failedAgentRun(
  configId: string,
  code: string,
  message: string,
  permissionMode: ToolContext['mode'] = DEFAULT_AI_MODE
): AgentRunResult {
  return {
    messages: [],
    steps: 0,
    finishReason: 'error',
    diagnostics: [{ severity: 'error', code, message }],
    audit: {
      configId,
      protocol: 'openai-compatible',
      permissionMode,
      toolCalls: [],
      redacted: true
    }
  };
}
