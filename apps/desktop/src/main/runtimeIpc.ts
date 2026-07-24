import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type WebContents
} from 'electron';
import { dirname, join } from 'node:path';
import {
  isRuntimeOperatorVerdict,
  openWorkspaceSession,
  type RuntimeLaunchRecord,
  type RuntimeOperatorVerdict
} from '@soulforge/core';
import type { Diagnostic } from '@soulforge/shared';
import {
  sanitizeDiagnostics,
  sanitizeRendererValue,
  toRendererRuntimeCapability,
  toRendererRuntimeLaunchRecord,
  toRendererRuntimeOperationVerificationSummary,
  toRendererRuntimeVerificationEvidence,
  toRendererRuntimeVerificationSummary,
  type RendererRuntimeActionResult
} from './rendererDto.js';
import {
  getLatestOperationLogUtilityClient,
  type OperationLogUtilityClient
} from './operationLogUtilityClient.js';
import {
  DesktopRuntimeController,
  runtimeErrorCode
} from './runtimeController.js';
import type { OpenWorkspaceDatabasePayload } from './operationLogUtilityProtocol.js';

let handlersRegistered = false;
let controller: DesktopRuntimeController | null = null;
let authority: OperationLogUtilityClient | null = null;
let restoreWorkspaceOpen: (() => void) | null = null;
let attachedWorkspaceKey: string | null = null;
const trustedRendererDocuments = new Map<number, string>();

export function registerRuntimeIpcHandlers(
  webContents: WebContents,
  rendererDocumentUrl: string
): void {
  const normalizedDocument = normalizeRendererDocumentUrl(rendererDocumentUrl);
  if (!normalizedDocument) throw new Error('RUNTIME_IPC_TRUSTED_RENDERER_URL_INVALID');
  trustedRendererDocuments.set(webContents.id, normalizedDocument);
  webContents.once('destroyed', () => trustedRendererDocuments.delete(webContents.id));
  if (handlersRegistered) return;
  handlersRegistered = true;

  authority = getLatestOperationLogUtilityClient();
  controller = new DesktopRuntimeController({
    applicationDataRoot: localApplicationDataRoot(),
    appDatabasePath: join(app.getPath('userData'), 'app.db'),
    authority
  });
  installWorkspaceOpenBoundary(authority, controller);
  void controller.initializeAppAuthority()
    .then(() => synchronizeCurrentWorkspace())
    .catch((error) => {
      process.stderr.write(`[SoulForge runtime initialization] ${formatError(error)}\n`);
    });

  handle('runtime.chooseMe3Executable', async (event): Promise<RendererRuntimeActionResult> => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: '选择可信 me3 可执行文件',
      properties: ['openFile'],
      ...(process.platform === 'win32'
        ? { filters: [{ name: 'me3 executable', extensions: ['exe'] }] }
        : {})
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const executablePath = result.canceled ? undefined : result.filePaths[0];
    if (!executablePath) {
      return {
        ok: false,
        diagnostics: [{
          severity: 'warning',
          code: 'ME3_SELECTION_CANCELLED',
          message: '用户取消了 me3 可执行文件选择。'
        }]
      };
    }
    try {
      const capability = await requireController().configureMe3(executablePath);
      return {
        ok: true,
        capability: toRendererRuntimeCapability(capability, true),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.clearMe3Executable', async (): Promise<RendererRuntimeActionResult> => {
    try {
      const removed = await requireController().clearMe3Configuration();
      const capability = await requireController().detect();
      return {
        ok: true,
        removed,
        capability: toRendererRuntimeCapability(capability, false),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.capability', async (): Promise<RendererRuntimeActionResult> => {
    try {
      await synchronizeCurrentWorkspace();
      const capability = await requireController().detect();
      const configured = !capability.diagnostics.some((item) => item.code === 'ME3_NOT_CONFIGURED');
      return {
        ok: capability.status === 'available',
        capability: toRendererRuntimeCapability(capability, configured),
        diagnostics: sanitizeDiagnostics(capability.diagnostics)
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle('runtime.launchManual', async (): Promise<RendererRuntimeActionResult> => {
    await synchronizeCurrentWorkspace();
    return runtimeRecordAction(() => requireController().launchManual());
  });

  handle(
    'runtime.launchAfterCommit',
    async (_event, operationId: string): Promise<RendererRuntimeActionResult> => {
      await synchronizeCurrentWorkspace();
      return runtimeRecordAction(() => requireController().launchAfterCommit(assertIdentifier(operationId)));
    }
  );

  handle(
    'runtime.launchAfterRollback',
    async (
      _event,
      inverseOperationId: string,
      originalOperationId: string
    ): Promise<RendererRuntimeActionResult> => {
      await synchronizeCurrentWorkspace();
      return runtimeRecordAction(() => requireController().launchAfterRollback(
        assertIdentifier(inverseOperationId),
        assertIdentifier(originalOperationId)
      ));
    }
  );

  handle('runtime.listSessions', async (): Promise<RendererRuntimeActionResult> => {
    try {
      await synchronizeCurrentWorkspace();
      const records = await requireController().listSessions();
      return {
        ok: true,
        records: records.map(toRendererRuntimeLaunchRecord),
        diagnostics: []
      };
    } catch (error) {
      return runtimeFailure(error);
    }
  });

  handle(
    'runtime.getSession',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const record = await requireController().getSession(assertIdentifier(sessionId));
        if (!record) {
          return {
            ok: false,
            diagnostics: [{
              severity: 'error',
              code: 'RUNTIME_SESSION_NOT_FOUND',
              message: '找不到运行会话。'
            }]
          };
        }
        return { ok: true, record: toRendererRuntimeLaunchRecord(record), diagnostics: [] };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.terminate',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      await synchronizeCurrentWorkspace();
      return runtimeRecordAction(() => requireController().terminate(assertIdentifier(sessionId)));
    }
  );

  handle(
    'runtime.waitForExit',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      await synchronizeCurrentWorkspace();
      return runtimeRecordAction(() => requireController().waitForExit(assertIdentifier(sessionId)));
    }
  );

  handle(
    'runtime.recordOperatorVerification',
    async (
      _event,
      sessionId: string,
      verdict: unknown,
      note?: unknown
    ): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const normalizedVerdict = assertRuntimeVerdict(verdict);
        const normalizedNote = assertOptionalNote(note);
        const verification = await requireController().recordOperatorVerification(
          assertIdentifier(sessionId),
          normalizedVerdict,
          normalizedNote
        );
        return {
          ok: true,
          verification: toRendererRuntimeVerificationSummary(verification),
          ...(verification.latestEvidence
            ? { evidence: toRendererRuntimeVerificationEvidence(verification.latestEvidence) }
            : {}),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.listVerificationEvidence',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const evidence = await requireController().listVerificationEvidence(
          assertIdentifier(sessionId)
        );
        return {
          ok: true,
          evidenceList: evidence.map(toRendererRuntimeVerificationEvidence),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.getVerificationSummary',
    async (_event, sessionId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const verification = await requireController().getVerificationSummary(
          assertIdentifier(sessionId)
        );
        return {
          ok: true,
          verification: toRendererRuntimeVerificationSummary(verification),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );

  handle(
    'runtime.getOperationVerificationSummary',
    async (_event, operationId: string): Promise<RendererRuntimeActionResult> => {
      try {
        await synchronizeCurrentWorkspace();
        const operationVerification = await requireController().getOperationVerificationSummary(
          assertIdentifier(operationId)
        );
        return {
          ok: true,
          operationVerification: toRendererRuntimeOperationVerificationSummary(
            operationVerification
          ),
          diagnostics: []
        };
      } catch (error) {
        return runtimeFailure(error);
      }
    }
  );
}

export async function disposeRuntimeIpc(): Promise<void> {
  restoreWorkspaceOpen?.();
  restoreWorkspaceOpen = null;
  attachedWorkspaceKey = null;
  await controller?.dispose();
  controller = null;
  authority = null;
}

function installWorkspaceOpenBoundary(
  client: OperationLogUtilityClient,
  runtimeController: DesktopRuntimeController
): void {
  if (restoreWorkspaceOpen) return;
  const originalOpenWorkspace = client.openWorkspace.bind(client);
  client.openWorkspace = async (payload): Promise<void> => {
    const previous = client.activeWorkspacePayload();
    if (previous && sameWorkspace(previous, payload)) {
      await originalOpenWorkspace(payload);
      return;
    }
    const terminated = await runtimeController.terminateActiveForWorkspaceChange();
    if (terminated > 0) {
      process.stderr.write(
        `[SoulForge runtime] terminated ${terminated} active session(s) before workspace switch\n`
      );
    }
    attachedWorkspaceKey = null;
    await originalOpenWorkspace(payload);
    await attachWorkspacePayload(payload);
  };
  restoreWorkspaceOpen = () => {
    client.openWorkspace = originalOpenWorkspace;
  };
}

async function synchronizeCurrentWorkspace(): Promise<void> {
  const payload = authority?.activeWorkspacePayload();
  if (!payload) return;
  const key = workspaceKey(payload);
  if (key === attachedWorkspaceKey) return;
  await attachWorkspacePayload(payload);
}

async function attachWorkspacePayload(payload: OpenWorkspaceDatabasePayload): Promise<void> {
  const workspace = await openWorkspaceSession({
    overlayRoot: payload.rootPath,
    game: payload.game
  });
  const recovered = await requireController().attachWorkspace(workspace);
  attachedWorkspaceKey = workspaceKey(payload);
  if (recovered > 0) {
    process.stderr.write(
      `[SoulForge runtime] marked ${recovered} interrupted runtime session(s) orphaned\n`
    );
  }
}

function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    try {
      const result = await listener(event, ...(args as Args));
      return sanitizeRendererValue(result);
    } catch (error) {
      return sanitizeRendererValue(runtimeFailure(error));
    }
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
    throw new Error(`已拒绝不受信任的 runtime IPC 调用：${channel}`);
  }
}

async function runtimeRecordAction(
  action: () => Promise<RuntimeLaunchRecord>
): Promise<RendererRuntimeActionResult> {
  try {
    const record = await action();
    return {
      ok: true,
      record: toRendererRuntimeLaunchRecord(record),
      diagnostics: sanitizeDiagnostics(record.diagnostics)
    };
  } catch (error) {
    return runtimeFailure(error);
  }
}

function runtimeFailure(error: unknown): RendererRuntimeActionResult {
  const diagnostic: Diagnostic = {
    severity: 'error',
    code: runtimeErrorCode(error),
    message: formatError(error)
  };
  return { ok: false, diagnostics: sanitizeDiagnostics([diagnostic]) };
}

function requireController(): DesktopRuntimeController {
  if (!controller) throw new Error('Runtime IPC controller is not initialized.');
  return controller;
}

function assertIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f]/.test(normalized)) {
    throw new Error('Invalid runtime identifier.');
  }
  return normalized;
}

function assertRuntimeVerdict(value: unknown): RuntimeOperatorVerdict {
  if (!isRuntimeOperatorVerdict(value)) {
    throw new Error('Invalid runtime operator verdict.');
  }
  return value;
}

function assertOptionalNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Runtime verification note must be a string.');
  return value;
}

function localApplicationDataRoot(): string {
  if (process.platform === 'win32') {
    return join(dirname(app.getPath('appData')), 'Local', 'SoulForge');
  }
  return join(app.getPath('userData'), 'local-data');
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

function sameWorkspace(left: OpenWorkspaceDatabasePayload, right: OpenWorkspaceDatabasePayload): boolean {
  return left.databasePath === right.databasePath
    && left.appDatabasePath === right.appDatabasePath
    && left.workspaceId === right.workspaceId
    && left.rootPath === right.rootPath;
}

function workspaceKey(payload: OpenWorkspaceDatabasePayload): string {
  return `${payload.workspaceId}\n${payload.databasePath}\n${payload.rootPath}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
