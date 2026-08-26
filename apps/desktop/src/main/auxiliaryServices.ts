import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  HttpFeedbackEndpoint,
  MutterService,
  SessionFeedbackService,
  type BuildFingerprint,
  type SessionFeedbackInput
} from '@soulforge/core';

const CHANNELS = {
  mutterNext: 'mutter.next',
  mutterStatus: 'mutter.status',
  feedbackStatus: 'feedback.status',
  feedbackSubmitSession: 'feedback.submitSession',
  feedbackSubmitAll: 'feedback.submitAllHistory'
} as const;

let handlersRegistered = false;
let trustedRendererId: number | null = null;
let mutterService: MutterService | null = null;
let feedbackService: SessionFeedbackService | null = null;
let feedbackConfigured = false;

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (trustedRendererId === null || event.sender.id !== trustedRendererId) {
    throw new Error('AUXILIARY_IPC_UNTRUSTED_SENDER');
  }
}

function resolveMutterPath(): string {
  const configured = process.env.SOULFORGE_MUTTER_PATH?.trim();
  const candidates = [
    configured && configured.length > 0 ? configured : null,
    app.isPackaged ? join(process.resourcesPath, 'mutter.md') : null,
    join(app.getAppPath(), 'mutter.md'),
    join(app.getAppPath(), '..', '..', 'mutter.md'),
    join(process.cwd(), 'mutter.md')
  ].filter((value): value is string => value !== null);

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? join(process.cwd(), 'mutter.md');
}

function buildFingerprint(): BuildFingerprint {
  const fingerprint: BuildFingerprint = { appVersion: app.getVersion() };
  const commitSha = process.env.SOULFORGE_COMMIT_SHA?.trim();
  const promptVersion = process.env.SOULFORGE_PROMPT_VERSION?.trim();
  const toolRegistryVersion = process.env.SOULFORGE_TOOL_REGISTRY_VERSION?.trim();
  if (commitSha) fingerprint.commitSha = commitSha;
  if (promptVersion) fingerprint.promptVersion = promptVersion;
  if (toolRegistryVersion) fingerprint.toolRegistryVersion = toolRegistryVersion;
  return fingerprint;
}

async function ensureMutterService(): Promise<MutterService> {
  if (mutterService) return mutterService;
  const service = new MutterService(resolveMutterPath());
  await service.load();
  service.startWatching();
  mutterService = service;
  return service;
}

function ensureFeedbackService(): SessionFeedbackService | null {
  if (feedbackService) return feedbackService;
  const endpointUrl = process.env.SOULFORGE_FEEDBACK_ENDPOINT?.trim() ?? '';
  if (endpointUrl.length === 0) {
    feedbackConfigured = false;
    return null;
  }

  feedbackConfigured = true;
  feedbackService = new SessionFeedbackService(
    join(app.getPath('userData'), 'agent'),
    new HttpFeedbackEndpoint(endpointUrl),
    buildFingerprint()
  );
  return feedbackService;
}

/**
 * Registers the main-process half of the two auxiliary features. The preload
 * and renderer deliberately stay separate so UI work can be done without
 * touching filesystem/network authority.
 */
export function registerAuxiliaryIpcHandlers(webContents: WebContents): void {
  trustedRendererId = webContents.id;
  webContents.once('destroyed', () => {
    if (trustedRendererId === webContents.id) trustedRendererId = null;
  });

  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(CHANNELS.mutterNext, async (event) => {
    assertTrustedSender(event);
    const service = await ensureMutterService();
    return { text: service.next(), ...service.snapshot() };
  });

  ipcMain.handle(CHANNELS.mutterStatus, async (event) => {
    assertTrustedSender(event);
    const service = await ensureMutterService();
    return service.snapshot();
  });

  ipcMain.handle(CHANNELS.feedbackStatus, (event) => {
    assertTrustedSender(event);
    const service = ensureFeedbackService();
    return {
      configured: service !== null && feedbackConfigured,
      appVersion: app.getVersion()
    };
  });

  ipcMain.handle(CHANNELS.feedbackSubmitSession, async (event, input: SessionFeedbackInput) => {
    assertTrustedSender(event);
    const service = ensureFeedbackService();
    if (!service) {
      return { ok: false, code: 'ENDPOINT_NOT_CONFIGURED', message: '反馈上传 endpoint 尚未配置。' };
    }
    return service.submitSessionFeedback(input);
  });

  ipcMain.handle(CHANNELS.feedbackSubmitAll, async (event) => {
    assertTrustedSender(event);
    const service = ensureFeedbackService();
    if (!service) {
      return {
        ok: false,
        submissionId: '',
        uploadedSessions: 0,
        failedSessions: [{ sessionId: '__endpoint__', code: 'ENDPOINT_NOT_CONFIGURED' }]
      };
    }
    return service.submitAllHistory();
  });
}

export function disposeAuxiliaryServices(): void {
  mutterService?.dispose();
  mutterService = null;
  feedbackService = null;
  trustedRendererId = null;
}
