import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, type WebContents } from 'electron';
import type { ProgressInfo } from 'electron-updater';
import { CancellationToken } from 'builder-util-runtime';
import {
  GITHUB_UPDATE_REPOSITORY,
  GitHubReleaseClient,
  createGitHubFetchTransport,
  sha256Hex,
  sha512Base64,
  type DownloadedUpdate,
  type UpdateClient,
  type UpdateDiagnostic,
  type UpdateInfo,
  type UpdatePackage,
  type UpdateState,
  type UpdateDownloader
} from './index.js';
import { UpdateStateMachine as StateMachine } from './updateStateMachine.js';
import {
  UPDATE_IPC_CHANNELS,
  updateDiagnostic,
  isUpdateChannel,
  type UpdateChannel,
  type UpdateCommandResult,
  type UpdateDiagnostic as ProtocolUpdateDiagnostic,
  type UpdatePublicInfo,
  type UpdatePublicState
} from '@soulforge/shared';

// electron-updater is published as CommonJS.  Do not put its runtime import in
// the desktop main module: an NSIS app must be able to create its first window
// before the user ever opens the update panel.  The GitHub Release check is
// SoulForge-owned and does not need electron-updater; load the updater only for
// the explicit download/install actions.
type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  disableWebInstaller: boolean;
  setFeedURL(options: { provider: string; url: string }): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(token: CancellationToken): Promise<string[]>;
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): void;
  removeListener(event: 'download-progress', listener: (progress: ProgressInfo) => void): void;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  verifyUpdateCodeSignature?: (publisherNames: string[], path: string) => Promise<string | null>;
};

let autoUpdaterPromise: Promise<AutoUpdaterLike> | null = null;

async function getAutoUpdater(): Promise<AutoUpdaterLike> {
  if (!autoUpdaterPromise) {
    autoUpdaterPromise = import('electron-updater').then((module) => {
      const runtime = (module.default ?? module) as { autoUpdater?: AutoUpdaterLike };
      if (!runtime.autoUpdater) throw new Error('UPDATE_UPDATER_UNAVAILABLE');
      return runtime.autoUpdater;
    }).catch((error) => {
      autoUpdaterPromise = null;
      throw error;
    });
  }
  return autoUpdaterPromise;
}

const UPDATE_SETTINGS_FILE = 'update-settings.json';
const UPDATE_CACHE_DIRECTORY = 'updates';

interface UpdateSettingsDocument {
  readonly channel?: unknown;
}

interface DownloadTokenRecord {
  readonly installerPath: string;
  readonly updateVersion: string;
  readonly installerSha512: string;
}

export interface DesktopUpdateServiceOptions {
  readonly userDataPath: string;
  readonly currentVersion?: string;
  readonly isPackaged?: boolean;
  readonly webContents: WebContents;
  readonly hasActiveAgentRuns: () => boolean;
  readonly hasActiveTransactions: () => Promise<boolean>;
  readonly hasActiveRollbacks: () => boolean;
}

type StateListener = (state: UpdatePublicState) => void;

function settingsChannel(userDataPath: string): UpdateChannel {
  try {
    const value = JSON.parse(readFileSync(join(userDataPath, UPDATE_SETTINGS_FILE), 'utf8')) as UpdateSettingsDocument;
    return isUpdateChannel(value.channel) ? value.channel : 'prerelease';
  } catch {
    return 'prerelease';
  }
}

function asProtocolInfo(info: UpdateInfo): UpdatePublicInfo {
  return info;
}

function asProtocolDiagnostic(diagnosticValue: UpdateDiagnostic): ProtocolUpdateDiagnostic {
  return diagnosticValue;
}

function mapMachineState(state: UpdateState, channel: UpdateChannel, currentVersion: string): UpdatePublicState {
  switch (state.status) {
    case 'idle': return { status: 'idle', currentVersion, channel };
    case 'checking': return { status: 'checking', currentVersion, channel };
    case 'up-to-date': return { status: 'up-to-date', currentVersion, channel };
    case 'available': return { status: 'available', currentVersion, channel, info: asProtocolInfo(state.info) };
    case 'downloading': return { status: 'downloading', currentVersion, channel, info: asProtocolInfo(state.info), progress: state.progress };
    case 'pending-install': return { status: 'pending-install', currentVersion, channel, info: asProtocolInfo(state.info) };
    case 'installing': return { status: 'installing', currentVersion, channel, info: asProtocolInfo(state.info) };
    case 'installed': return { status: 'installed', currentVersion, channel, info: asProtocolInfo(state.info) };
    case 'cancelled': return { status: 'cancelled', currentVersion, channel, diagnostic: asProtocolDiagnostic(state.diagnostic) };
    case 'error': return { status: 'error', currentVersion, channel, diagnostic: asProtocolDiagnostic(state.diagnostic) };
  }
}

function releaseDirectoryUrl(update: UpdatePackage): string {
  const url = new URL(update.installerUrl);
  const slash = url.pathname.lastIndexOf('/');
  if (slash < 0) throw new Error('UPDATE_METADATA_INVALID');
  url.pathname = `${url.pathname.slice(0, slash + 1)}`;
  url.search = '';
  url.hash = '';
  return url.href;
}

class ElectronUpdaterDownloader implements UpdateDownloader {
  private selectedPackage: UpdatePackage | null = null;
  private readonly tokens = new Map<string, DownloadTokenRecord>();

  public select(update: UpdatePackage | null): void {
    this.selectedPackage = update;
  }

  public async download(input: Parameters<UpdateDownloader['download']>[0]): Promise<DownloadedUpdate> {
    const update = this.selectedPackage;
    if (!update) throw new Error('UPDATE_INVALID_STATE');
    const updater = await getAutoUpdater();

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.autoRunAppAfterInstall = true;
    updater.disableWebInstaller = true;
    updater.setFeedURL({ provider: 'generic', url: releaseDirectoryUrl(update) });

    const cancellationToken = new CancellationToken();
    const onAbort = (): void => cancellationToken.cancel();
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
    const onProgress = (progress: ProgressInfo): void => {
      if (input.signal.aborted) return;
      input.onProgress({
        downloadedBytes: Number.isFinite(progress.transferred) ? Math.max(0, progress.transferred) : 0,
        totalBytes: Number.isFinite(progress.total) ? Math.max(0, progress.total) : update.info.installerSize
      });
    };
    updater.on('download-progress', onProgress);
    try {
      const checked = await updater.checkForUpdates();
      if (!checked || !checked.isUpdateAvailable || checked.updateInfo.version !== update.info.version) {
        throw new Error('UPDATE_METADATA_INVALID');
      }
      const paths = await updater.downloadUpdate(cancellationToken);
      const installerPath = paths.find((path) => basename(path).toLowerCase() === update.info.installerName.toLowerCase());
      if (!installerPath) throw new Error('UPDATE_DOWNLOAD_FAILED');
      const installerBytes = Uint8Array.from(await readFile(installerPath));
      const token = randomUUID();
      this.tokens.set(token, {
        installerPath,
        updateVersion: update.info.version,
        installerSha512: update.installerSha512
      });
      return { token, installerBytes };
    } finally {
      updater.removeListener('download-progress', onProgress);
      input.signal.removeEventListener('abort', onAbort);
      cancellationToken.dispose();
    }
  }

  public consumeToken(token: string, version: string): DownloadTokenRecord | null {
    const record = this.tokens.get(token);
    if (!record || record.updateVersion !== version) return null;
    this.tokens.delete(token);
    return record;
  }
}

class ElectronUpdaterInstaller {
  public constructor(private readonly downloader: ElectronUpdaterDownloader) {}

  public async install(input: { readonly update: UpdateInfo; readonly token: string }): Promise<void> {
    const tokenRecord = this.downloader.consumeToken(input.token, input.update.version);
    if (!tokenRecord) throw new Error('UPDATE_INSTALL_FAILED');
    const bytes = Uint8Array.from(await readFile(tokenRecord.installerPath));
    if (bytes.byteLength !== input.update.installerSize
      || sha256Hex(bytes) !== input.update.installerSha256
      || sha512Base64(bytes) !== tokenRecord.installerSha512) {
      throw new Error('UPDATE_HASH_MISMATCH');
    }
    // SHA-256/SHA-512 metadata is the installation trust boundary. The
    // Authenticode check in electron-updater is deliberately disabled here:
    // unsigned GitHub Release packages remain installable and the UI warns
    // about SmartScreen/UAC instead of treating a missing signature as a hash
    // failure.
    const updater = await getAutoUpdater();
    const updaterWithOptionalSignature = updater as typeof updater & {
      verifyUpdateCodeSignature?: (publisherNames: string[], path: string) => Promise<string | null>;
    };
    if (updaterWithOptionalSignature.verifyUpdateCodeSignature) {
      updaterWithOptionalSignature.verifyUpdateCodeSignature = async () => null;
    }
    updater.quitAndInstall(false, true);
  }
}

function commandResult(state: UpdatePublicState, error?: ProtocolUpdateDiagnostic): UpdateCommandResult {
  return error ? { ok: false, state, error } : { ok: true, state };
}

function stateDiagnostic(
  code: ProtocolUpdateDiagnostic['code'],
  phase: ProtocolUpdateDiagnostic['phase'],
  message: string,
  retryable: boolean
): ProtocolUpdateDiagnostic {
  return updateDiagnostic(code, phase, message, retryable);
}

export class DesktopUpdateService {
  private readonly listeners = new Set<StateListener>();
  private readonly settingsPath: string;
  private readonly options: DesktopUpdateServiceOptions;
  private readonly downloader = new ElectronUpdaterDownloader();
  private readonly installer = new ElectronUpdaterInstaller(this.downloader);
  private readonly currentVersion: string;
  private channelValue: UpdateChannel;
  private machine: StateMachine;
  private stateValue: UpdatePublicState;

  public constructor(options: DesktopUpdateServiceOptions) {
    this.options = options;
    this.currentVersion = options.currentVersion ?? app.getVersion();
    this.settingsPath = join(options.userDataPath, UPDATE_SETTINGS_FILE);
    this.channelValue = settingsChannel(options.userDataPath);
    this.machine = this.createMachine();
    this.stateValue = mapMachineState(this.machine.state, this.channelValue, this.currentVersion);
  }

  public get state(): UpdatePublicState {
    return this.stateValue;
  }

  public subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async setChannel(channel: UpdateChannel): Promise<UpdateCommandResult> {
    if (this.machine.state.status === 'downloading' || this.machine.state.status === 'installing' || this.machine.state.status === 'pending-install') {
      const error = stateDiagnostic('UPDATE_BUSY', 'check', '更新操作正在进行，暂不能切换更新频道。', true);
      return commandResult(this.stateValue, error);
    }
    try {
      await mkdir(this.options.userDataPath, { recursive: true });
      await writeFile(this.settingsPath, `${JSON.stringify({ channel }, null, 2)}\n`, 'utf8');
    } catch {
      const error = stateDiagnostic('UPDATE_SETTINGS_FAILED', 'check', '更新频道保存失败，未应用此次更改。', true);
      return commandResult(this.stateValue, error);
    }
    this.channelValue = channel;
    this.machine = this.createMachine();
    return commandResult(this.publish(mapMachineState(this.machine.state, this.channelValue, this.currentVersion)));
  }

  public async check(): Promise<UpdateCommandResult> {
    if (!this.isAutomaticUpdateSupported()) return this.unsupportedBuildResult('check');
    const state = await this.machine.check();
    return this.resultFromState(state);
  }

  public async download(): Promise<UpdateCommandResult> {
    if (!this.isAutomaticUpdateSupported()) return this.unsupportedBuildResult('download');
    const state = await this.machine.download();
    return this.resultFromState(state);
  }

  public cancel(): UpdateCommandResult {
    return this.resultFromState(this.machine.cancel());
  }

  public async install(): Promise<UpdateCommandResult> {
    const pending = this.machine.state.status === 'pending-install' ? this.machine.state.info : null;
    if (!pending) {
      const error = stateDiagnostic('UPDATE_INVALID_STATE', 'install', '当前没有待安装的更新。', false);
      return commandResult(this.stateValue, error);
    }
    if (!this.isAutomaticUpdateSupported()) {
      const error = stateDiagnostic('UPDATE_UNSUPPORTED_BUILD', 'install', '当前是源码或非 NSIS 运行环境，请从 GitHub Release 手动下载对应安装包。', false);
      return commandResult(this.publish({ status: 'blocked', currentVersion: this.currentVersion, channel: this.channelValue, info: asProtocolInfo(pending), diagnostic: error }), error);
    }
    if (this.options.hasActiveAgentRuns()) {
      const error = stateDiagnostic('UPDATE_INSTALL_BLOCKED_AGENT_ACTIVE', 'install', 'Agent 仍在运行，完成或取消当前任务后再安装更新。', true);
      return commandResult(this.publish({ status: 'blocked', currentVersion: this.currentVersion, channel: this.channelValue, info: asProtocolInfo(pending), diagnostic: error }), error);
    }
    if (this.options.hasActiveRollbacks() || await this.options.hasActiveTransactions()) {
      const error = stateDiagnostic('UPDATE_INSTALL_BLOCKED_TRANSACTION', 'install', '当前存在 Patch Engine 事务或回滚任务，提交/回滚完成后再安装更新。', true);
      return commandResult(this.publish({ status: 'blocked', currentVersion: this.currentVersion, channel: this.channelValue, info: asProtocolInfo(pending), diagnostic: error }), error);
    }
    const confirmed = await this.confirmInstall(pending);
    if (!confirmed) {
      const error = stateDiagnostic('UPDATE_INSTALL_DECLINED', 'install', '用户暂未确认安装更新。', true);
      return commandResult(this.publish({ status: 'error', currentVersion: this.currentVersion, channel: this.channelValue, diagnostic: error }), error);
    }
    return this.resultFromState(await this.machine.install());
  }

  private createMachine(): StateMachine {
    const releaseClient = new GitHubReleaseClient({
      currentVersion: this.currentVersion,
      transport: createGitHubFetchTransport(),
      includePrerelease: this.channelValue === 'prerelease',
      platform: process.platform,
      arch: process.arch
    });
    const client: UpdateClient = {
      check: async (signal) => {
        const result = await releaseClient.check(signal);
        this.downloader.select(result.kind === 'available' ? result.update : null);
        return result;
      }
    };
    const machine = new StateMachine(client, this.downloader, this.installer);
    machine.subscribe((state) => this.publish(mapMachineState(state, this.channelValue, this.currentVersion)));
    return machine;
  }

  private isAutomaticUpdateSupported(): boolean {
    return (this.options.isPackaged ?? app.isPackaged) === true;
  }

  private unsupportedBuildResult(phase: 'check' | 'download'): UpdateCommandResult {
    const error = stateDiagnostic(
      'UPDATE_UNSUPPORTED_BUILD',
      phase,
      '当前是源码或非 NSIS 运行环境，请从 GitHub Release 手动下载对应安装包。',
      false
    );
    return commandResult(this.publish({
      status: 'error',
      currentVersion: this.currentVersion,
      channel: this.channelValue,
      diagnostic: error
    }), error);
  }

  private async confirmInstall(info: UpdateInfo): Promise<boolean> {
    const window = BrowserWindow.fromWebContents(this.options.webContents);
    const message = `SoulForge ${info.version} 已下载并通过 SHA-256/SHA-512 校验。`;
    const detail = '确认后 SoulForge 会退出并启动 NSIS 安装器。未签名安装包可能触发 Windows SmartScreen/UAC 提示；这不是安装门禁。';
    const result = window
      ? await dialog.showMessageBox(window, {
        type: 'question',
        title: '安装 SoulForge 更新',
        message,
        detail,
        buttons: ['安装并重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      : await dialog.showMessageBox({
        type: 'question',
        title: '安装 SoulForge 更新',
        message,
        detail,
        buttons: ['安装并重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
    return result.response === 0;
  }

  private publish(state: UpdatePublicState): UpdatePublicState {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }

  private resultFromState(state: UpdateState): UpdateCommandResult {
    const publicState = this.stateValue.status === 'blocked' && state.status === 'pending-install'
      ? this.stateValue
      : mapMachineState(state, this.channelValue, this.currentVersion);
    if (publicState !== this.stateValue) this.publish(publicState);
    if (state.status === 'error') return commandResult(publicState, asProtocolDiagnostic(state.diagnostic));
    return commandResult(publicState);
  }
}

export {
  GITHUB_UPDATE_REPOSITORY,
  UPDATE_IPC_CHANNELS
};
