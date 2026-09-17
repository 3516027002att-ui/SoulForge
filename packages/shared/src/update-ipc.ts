/**
 * SoulForge 更新协议的 renderer 侧投影。
 *
 * 这里故意不暴露下载地址、文件路径、下载句柄、HTTP 响应或凭据。主进程
 * 负责 GitHub Release 信任校验和 NSIS 更新器；preload 只转发这些 DTO。
 */

export const UPDATE_IPC_CHANNELS = Object.freeze({
  getState: 'update.state',
  setChannel: 'update.setChannel',
  check: 'update.check',
  download: 'update.download',
  cancel: 'update.cancel',
  install: 'update.install',
  openRelease: 'update.openRelease',
  event: 'update:event'
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

export interface UpdatePublicInfo {
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

export type UpdatePublicState =
  | { readonly status: 'idle'; readonly currentVersion: string; readonly channel: UpdateChannel }
  | { readonly status: 'checking'; readonly currentVersion: string; readonly channel: UpdateChannel }
  | { readonly status: 'up-to-date'; readonly currentVersion: string; readonly channel: UpdateChannel }
  | { readonly status: 'available'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info: UpdatePublicInfo }
  | { readonly status: 'downloading'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info: UpdatePublicInfo; readonly progress: UpdateProgress }
  | { readonly status: 'pending-install'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info: UpdatePublicInfo }
  | { readonly status: 'installing'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info: UpdatePublicInfo }
  | { readonly status: 'installed'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info: UpdatePublicInfo }
  | { readonly status: 'cancelled'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly diagnostic: UpdateDiagnostic }
  | { readonly status: 'blocked'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly info?: UpdatePublicInfo; readonly diagnostic: UpdateDiagnostic }
  | { readonly status: 'error'; readonly currentVersion: string; readonly channel: UpdateChannel; readonly diagnostic: UpdateDiagnostic };

export interface UpdateCommandResult {
  readonly ok: boolean;
  readonly state: UpdatePublicState;
  readonly error?: UpdateDiagnostic;
}

export interface UpdateStateEvent {
  readonly state: UpdatePublicState;
}

export interface UpdateSetChannelRequest {
  readonly channel: UpdateChannel;
}

export function updateDiagnostic(
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

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'prerelease';
}
