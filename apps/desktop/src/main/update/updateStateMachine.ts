import { sha256Hex, sha512Base64 } from './githubReleaseClient.js';
import {
  diagnostic,
  type DownloadedUpdate,
  type UpdateClient,
  type UpdateDiagnostic,
  type UpdateDownloader,
  type UpdateInfo,
  type UpdateInstaller,
  type UpdatePackage,
  type UpdateProgress,
  type UpdateState,
  type UpdateDownloaderProgress
} from './types.js';

type Listener = (state: UpdateState) => void;
type Operation = { readonly kind: 'check' | 'download'; readonly controller: AbortController; readonly id: number };

function cancelledDiagnostic(): UpdateDiagnostic {
  return diagnostic('UPDATE_CANCELLED', 'cancel', '更新操作已取消。', true);
}

function errorDiagnostic(error: unknown, phase: 'check' | 'download' | 'install'): UpdateDiagnostic {
  if (error && typeof error === 'object' && 'diagnostic' in error) {
    const value = (error as { diagnostic?: unknown }).diagnostic;
    if (value && typeof value === 'object' && 'code' in value && 'message' in value) return value as UpdateDiagnostic;
  }
  const errorCode = error instanceof Error ? error.message.trim() : '';
  const knownCodes: readonly UpdateDiagnostic['code'][] = [
    'UPDATE_BUSY',
    'UPDATE_CANCELLED',
    'UPDATE_INVALID_STATE',
    'UPDATE_UNSUPPORTED_PLATFORM',
    'UPDATE_UNSUPPORTED_BUILD',
    'UPDATE_SETTINGS_FAILED',
    'UPDATE_NETWORK_FAILED',
    'UPDATE_TIMEOUT',
    'UPDATE_HTTP_ERROR',
    'UPDATE_RESPONSE_TOO_LARGE',
    'UPDATE_REDIRECT_FORBIDDEN',
    'UPDATE_METADATA_INVALID',
    'UPDATE_ASSET_MISSING',
    'UPDATE_CHECKSUM_INVALID',
    'UPDATE_HASH_MISMATCH',
    'UPDATE_DOWNLOAD_FAILED',
    'UPDATE_INSTALL_BLOCKED_AGENT_ACTIVE',
    'UPDATE_INSTALL_BLOCKED_TRANSACTION',
    'UPDATE_INSTALL_DECLINED',
    'UPDATE_INSTALL_FAILED'
  ];
  if (knownCodes.includes(errorCode as UpdateDiagnostic['code'])) {
    const code = errorCode as UpdateDiagnostic['code'];
    const message = code === 'UPDATE_HASH_MISMATCH'
      ? '更新包完整性校验失败，已禁止继续安装。'
      : code === 'UPDATE_METADATA_INVALID'
        ? 'GitHub Release 更新元数据无效，已停止更新。'
        : code === 'UPDATE_ASSET_MISSING'
          ? 'GitHub Release 缺少必需的 Windows x64 安装资产。'
          : code === 'UPDATE_CHECKSUM_INVALID'
            ? 'GitHub Release 校验清单无效，已停止更新。'
            : code === 'UPDATE_REDIRECT_FORBIDDEN'
              ? '更新下载地址未通过 GitHub HTTPS 信任校验。'
              : code === 'UPDATE_TIMEOUT'
                ? '连接 GitHub 超时，请稍后重试。'
                : code === 'UPDATE_DOWNLOAD_FAILED'
                  ? '更新包下载失败，请稍后重试。'
                  : code === 'UPDATE_INSTALL_FAILED'
                    ? '更新安装器启动失败，请改用 GitHub Release 手动安装。'
                    : '更新操作未能完成，请稍后重试。';
    return diagnostic(code, code === 'UPDATE_CANCELLED' ? 'cancel' : phase, message, code !== 'UPDATE_HASH_MISMATCH' && code !== 'UPDATE_METADATA_INVALID' && code !== 'UPDATE_CHECKSUM_INVALID');
  }
  return diagnostic(
    phase === 'download' ? 'UPDATE_DOWNLOAD_FAILED' : phase === 'install' ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_NETWORK_FAILED',
    phase,
    phase === 'download' ? '更新下载失败。' : phase === 'install' ? '更新安装失败。' : '更新检查失败。',
    true
  );
}

function busyDiagnostic(): UpdateDiagnostic {
  return diagnostic('UPDATE_BUSY', 'check', '已有更新操作正在进行。', true);
}

function invalidStateDiagnostic(): UpdateDiagnostic {
  return diagnostic('UPDATE_INVALID_STATE', 'download', '当前状态不允许执行该更新操作。', false);
}

function verificationDiagnostic(message: string): { readonly diagnostic: UpdateDiagnostic } {
  return { diagnostic: diagnostic('UPDATE_HASH_MISMATCH', 'download', message, false) };
}

export class UpdateStateMachine {
  private stateValue: UpdateState = { status: 'idle' };
  private readonly listeners = new Set<Listener>();
  private operation: Operation | null = null;
  private nextOperationId = 1;
  private checkPromise: Promise<UpdateState> | null = null;
  private availablePackage: UpdatePackage | null = null;
  private pendingToken: string | null = null;
  private installPromise: Promise<UpdateState> | null = null;
  private readonly client: UpdateClient;
  private readonly downloader: UpdateDownloader;
  private readonly installer: UpdateInstaller;

  public constructor(
    client: UpdateClient,
    downloader: UpdateDownloader,
    installer: UpdateInstaller
  ) {
    this.client = client;
    this.downloader = downloader;
    this.installer = installer;
  }

  public get state(): UpdateState {
    return this.stateValue;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public check(): Promise<UpdateState> {
    if (this.operation?.kind === 'check' && this.checkPromise) return this.checkPromise;
    if (this.operation) return Promise.resolve(this.errorState(busyDiagnostic()));
    if (this.stateValue.status === 'pending-install') {
      return Promise.resolve(this.errorState(invalidStateDiagnostic()));
    }

    const operation: Operation = { kind: 'check', controller: new AbortController(), id: this.nextOperationId++ };
    this.operation = operation;
    this.publish({ status: 'checking' });
    const promise = (async (): Promise<UpdateState> => {
      try {
        const result = await this.client.check(operation.controller.signal);
        if (operation.controller.signal.aborted) return this.stateValue;
        if (result.kind === 'not-available') {
          this.availablePackage = null;
          return this.publish({ status: 'up-to-date' });
        }
        this.availablePackage = result.update;
        return this.publish({ status: 'available', info: result.update.info });
      } catch (error) {
        if (operation.controller.signal.aborted) return this.stateValue;
        return this.publish({ status: 'error', diagnostic: errorDiagnostic(error, 'check') });
      } finally {
        if (this.operation?.id === operation.id) {
          this.operation = null;
          this.checkPromise = null;
        }
      }
    })();
    this.checkPromise = promise;
    return promise;
  }

  public download(): Promise<UpdateState> {
    if (this.operation) return Promise.resolve(this.errorState(busyDiagnostic()));
    const update = this.availablePackage;
    if (!update || this.stateValue.status !== 'available') {
      return Promise.resolve(this.errorState(invalidStateDiagnostic()));
    }
    const operation: Operation = { kind: 'download', controller: new AbortController(), id: this.nextOperationId++ };
    this.operation = operation;
    this.publish({ status: 'downloading', info: update.info, progress: { downloadedBytes: 0, totalBytes: update.info.installerSize, percent: 0 } });
    return (async (): Promise<UpdateState> => {
      try {
        const downloaded = await this.downloader.download({
          update,
          signal: operation.controller.signal,
          onProgress: (progress) => this.publishProgress(operation, update.info, progress)
        });
        if (operation.controller.signal.aborted) return this.stateValue;
        this.verifyDownloaded(update, downloaded);
        this.pendingToken = downloaded.token;
        return this.publish({ status: 'pending-install', info: update.info });
      } catch (error) {
        if (operation.controller.signal.aborted) return this.stateValue;
        return this.publish({ status: 'error', diagnostic: errorDiagnostic(error, 'download') });
      } finally {
        if (this.operation?.id === operation.id) this.operation = null;
      }
    })();
  }

  public cancel(): UpdateState {
    if (this.operation) {
      this.operation.controller.abort();
      this.operation = null;
      this.checkPromise = null;
      return this.publish({ status: 'cancelled', diagnostic: cancelledDiagnostic() });
    }
    if (this.stateValue.status === 'pending-install') {
      this.pendingToken = null;
      this.availablePackage = null;
      return this.publish({ status: 'cancelled', diagnostic: cancelledDiagnostic() });
    }
    return this.publish({ status: 'error', diagnostic: invalidStateDiagnostic() });
  }

  public install(): Promise<UpdateState> {
    if (this.installPromise) return this.installPromise;
    const update = this.availablePackage;
    const token = this.pendingToken;
    if (!update || !token || this.stateValue.status !== 'pending-install') {
      return Promise.resolve(this.publish({ status: 'error', diagnostic: diagnostic('UPDATE_INVALID_STATE', 'install', '当前没有待安装的更新。', false) }));
    }
    const promise = (async (): Promise<UpdateState> => {
      this.publish({ status: 'installing', info: update.info });
      try {
        await this.installer.install({ update: update.info, token });
        this.pendingToken = null;
        return this.publish({ status: 'installed', info: update.info });
      } catch (error) {
        return this.publish({ status: 'error', diagnostic: errorDiagnostic(error, 'install') });
      } finally {
        this.installPromise = null;
      }
    })();
    this.installPromise = promise;
    return promise;
  }

  private publishProgress(operation: Operation, info: UpdateInfo, progress: UpdateDownloaderProgress): void {
    if (this.operation?.id !== operation.id || operation.controller.signal.aborted) return;
    const totalBytes = Math.max(0, Number.isSafeInteger(progress.totalBytes) ? progress.totalBytes : info.installerSize);
    const downloadedBytes = Math.max(0, Math.min(totalBytes || Number.MAX_SAFE_INTEGER, progress.downloadedBytes));
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, Math.round(downloadedBytes / totalBytes * 100))) : 0;
    this.publish({ status: 'downloading', info, progress: { downloadedBytes, totalBytes, percent } });
  }

  private verifyDownloaded(update: UpdatePackage, downloaded: DownloadedUpdate): void {
    if (typeof downloaded.token !== 'string' || downloaded.token.length === 0 || downloaded.token.length > 512) {
      throw verificationDiagnostic('下载器返回的安装句柄无效。');
    }
    if (!(downloaded.installerBytes instanceof Uint8Array)) throw verificationDiagnostic('下载器返回的安装包数据无效。');
    if (downloaded.installerBytes.byteLength !== update.info.installerSize) {
      throw verificationDiagnostic('安装包大小与 GitHub Release 不一致。');
    }
    if (sha256Hex(downloaded.installerBytes) !== update.info.installerSha256) {
      throw verificationDiagnostic('安装包 SHA-256 与 GitHub Release 不一致。');
    }
    if (sha512Base64(downloaded.installerBytes) !== update.installerSha512) {
      throw verificationDiagnostic('安装包 SHA-512 与 latest.yml 不一致。');
    }
  }

  private publish(next: UpdateState): UpdateState {
    this.stateValue = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  private errorState(value: UpdateDiagnostic): Extract<UpdateState, { readonly status: 'error' }> {
    return { status: 'error', diagnostic: value };
  }
}
