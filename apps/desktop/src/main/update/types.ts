/**
 * GitHub Release 更新核心的主进程边界类型。
 *
 * UpdateInfo 是唯一允许向 renderer 投影的更新信息：它不包含文件系统
 * 路径、下载 token、HTTP 响应原文或任何凭据。UpdatePackage 只供同目录的
 * main-side client/state machine 使用，下载器和安装器是显式注入端口。
 */

export const GITHUB_UPDATE_REPOSITORY = Object.freeze({
  owner: '3516027002att-ui',
  repo: 'SoulForge'
} as const);

export const UPDATE_ASSET_NAMES = Object.freeze({
  checksum: 'SHA256SUMS.txt',
  latest: 'latest.yml'
} as const);

export type UpdateChannel = 'stable' | 'prerelease';

export type UpdateDiagnosticCode =
  | 'UPDATE_BUSY'
  | 'UPDATE_CANCELLED'
  | 'UPDATE_INVALID_STATE'
  | 'UPDATE_UNSUPPORTED_PLATFORM'
  | 'UPDATE_UNSUPPORTED_BUILD'
  | 'UPDATE_SETTINGS_FAILED'
  | 'UPDATE_NETWORK_FAILED'
  | 'UPDATE_TIMEOUT'
  | 'UPDATE_HTTP_ERROR'
  | 'UPDATE_RESPONSE_TOO_LARGE'
  | 'UPDATE_REDIRECT_FORBIDDEN'
  | 'UPDATE_METADATA_INVALID'
  | 'UPDATE_ASSET_MISSING'
  | 'UPDATE_CHECKSUM_INVALID'
  | 'UPDATE_HASH_MISMATCH'
  | 'UPDATE_DOWNLOAD_FAILED'
  | 'UPDATE_INSTALL_BLOCKED_AGENT_ACTIVE'
  | 'UPDATE_INSTALL_BLOCKED_TRANSACTION'
  | 'UPDATE_INSTALL_DECLINED'
  | 'UPDATE_INSTALL_FAILED';

export type UpdateDiagnosticPhase = 'check' | 'download' | 'install' | 'cancel';

export interface UpdateDiagnostic {
  readonly code: UpdateDiagnosticCode;
  readonly phase: UpdateDiagnosticPhase;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

/** Renderer-safe update description. Never add local paths or opaque tokens here. */
export interface UpdateInfo {
  readonly version: string;
  readonly tag: string;
  readonly channel: UpdateChannel;
  readonly releaseName: string;
  readonly releaseNotes: string;
  readonly publishedAt: string | null;
  readonly releaseUrl: string;
  readonly installerName: string;
  readonly installerSize: number;
  readonly installerSha256: string;
}

export interface UpdateProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export type UpdateState =
  | { readonly status: 'idle' }
  | { readonly status: 'checking' }
  | { readonly status: 'up-to-date' }
  | { readonly status: 'available'; readonly info: UpdateInfo }
  | { readonly status: 'downloading'; readonly info: UpdateInfo; readonly progress: UpdateProgress }
  | { readonly status: 'pending-install'; readonly info: UpdateInfo }
  | { readonly status: 'installing'; readonly info: UpdateInfo }
  | { readonly status: 'installed'; readonly info: UpdateInfo }
  | { readonly status: 'cancelled'; readonly diagnostic: UpdateDiagnostic }
  | { readonly status: 'error'; readonly diagnostic: UpdateDiagnostic };

export interface UpdateTransportResponse {
  readonly status: number;
  readonly url: string;
  readonly body: Uint8Array;
}

export interface UpdateTransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

export interface UpdateTransport {
  get(url: string, options?: UpdateTransportRequestOptions): Promise<UpdateTransportResponse>;
}

export interface UpdateDownloaderProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}

export interface DownloadedUpdate {
  /** Opaque main-process handle owned by the injected installer port. */
  readonly token: string;
  /** Bytes are returned to the core so hash verification happens before install. */
  readonly installerBytes: Uint8Array;
}

export interface UpdateDownloader {
  download(input: {
    readonly update: UpdatePackage;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: UpdateDownloaderProgress) => void;
  }): Promise<DownloadedUpdate>;
}

export interface UpdateInstaller {
  install(input: { readonly update: UpdateInfo; readonly token: string }): Promise<void>;
}

/** Main-only resolved package. It is never part of UpdateState or UpdateInfo. */
export interface UpdatePackage {
  readonly info: UpdateInfo;
  readonly installerUrl: string;
  readonly latestYmlUrl: string;
  readonly blockmapUrl: string;
  readonly checksumUrl: string;
  readonly installerSha512: string;
}

export type UpdateCheckResult =
  | { readonly kind: 'not-available' }
  | { readonly kind: 'available'; readonly update: UpdatePackage };

export interface UpdateClient {
  check(signal?: AbortSignal): Promise<UpdateCheckResult>;
}

export function diagnostic(
  code: UpdateDiagnosticCode,
  phase: UpdateDiagnosticPhase,
  message: string,
  retryable: boolean,
  httpStatus?: number
): UpdateDiagnostic {
  return {
    code,
    phase,
    message,
    retryable,
    ...(httpStatus === undefined ? {} : { httpStatus })
  };
}
