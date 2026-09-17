import { shell, type WebContents } from 'electron';
import {
  UPDATE_IPC_CHANNELS,
  isUpdateChannel,
  type UpdateCommandResult,
  type UpdateSetChannelRequest,
  type UpdateStateEvent
} from '@soulforge/shared';
import type { TrustedIpcHandle } from '../ipc/registration.js';
import { DesktopUpdateService, GITHUB_UPDATE_REPOSITORY } from './desktopUpdateService.js';

export interface UpdateIpcDeps {
  readonly handle: TrustedIpcHandle;
  readonly webContents: WebContents;
  readonly userDataPath: string;
  readonly currentVersion: string;
  readonly isPackaged: boolean;
  readonly hasActiveAgentRuns: () => boolean;
  readonly hasActiveTransactions: () => Promise<boolean>;
  readonly hasActiveRollbacks: () => boolean;
}

let service: DesktopUpdateService | null = null;
let boundWebContents: WebContents | null = null;
let handlersRegistered = false;

function currentWebContents(): WebContents | null {
  if (!boundWebContents || boundWebContents.isDestroyed()) return null;
  return boundWebContents;
}

function sendState(state: UpdateStateEvent['state']): void {
  const target = currentWebContents();
  if (!target) return;
  target.send(UPDATE_IPC_CHANNELS.event, { state } satisfies UpdateStateEvent);
}

function invalidChannelResult(): UpdateCommandResult {
  const state = service?.state;
  if (!state) {
    throw new Error('UPDATE_SERVICE_NOT_READY');
  }
  const error = {
    code: 'UPDATE_METADATA_INVALID' as const,
    phase: 'check' as const,
    message: '更新频道参数无效。',
    retryable: false
  };
  return { ok: false, state, error };
}

export function registerUpdateIpcHandlers(deps: UpdateIpcDeps): void {
  boundWebContents = deps.webContents;
  if (service) return;
  service = new DesktopUpdateService({
    userDataPath: deps.userDataPath,
    currentVersion: deps.currentVersion,
    isPackaged: deps.isPackaged,
    webContents: deps.webContents,
    hasActiveAgentRuns: deps.hasActiveAgentRuns,
    hasActiveTransactions: deps.hasActiveTransactions,
    hasActiveRollbacks: deps.hasActiveRollbacks
  });
  service.subscribe(sendState);
  if (handlersRegistered) return;
  handlersRegistered = true;

  deps.handle(UPDATE_IPC_CHANNELS.getState, async () => service!.state);
  deps.handle(UPDATE_IPC_CHANNELS.setChannel, async (_event, request: UpdateSetChannelRequest): Promise<UpdateCommandResult> => {
    if (!request || typeof request !== 'object' || !isUpdateChannel(request.channel)) return invalidChannelResult();
    return service!.setChannel(request.channel);
  });
  deps.handle(UPDATE_IPC_CHANNELS.check, async (): Promise<UpdateCommandResult> => service!.check());
  deps.handle(UPDATE_IPC_CHANNELS.download, async (): Promise<UpdateCommandResult> => service!.download());
  deps.handle(UPDATE_IPC_CHANNELS.cancel, async (): Promise<UpdateCommandResult> => service!.cancel());
  deps.handle(UPDATE_IPC_CHANNELS.install, async (): Promise<UpdateCommandResult> => service!.install());
  deps.handle(UPDATE_IPC_CHANNELS.openRelease, async (): Promise<UpdateCommandResult> => {
    const state = service!.state;
    try {
      await shell.openExternal(`https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases`);
      return { ok: true, state };
    } catch {
      const error = {
        code: 'UPDATE_NETWORK_FAILED' as const,
        phase: 'check' as const,
        message: '无法打开 GitHub Release 页面，请稍后重试。',
        retryable: true
      };
      return { ok: false, state, error };
    }
  });
}
