import { createHash } from 'node:crypto';
import {
  GITHUB_UPDATE_REPOSITORY,
  UPDATE_ASSET_NAMES,
  diagnostic,
  type UpdateCheckResult,
  type UpdateDiagnostic,
  type UpdateDiagnosticCode,
  type UpdateInfo,
  type UpdatePackage,
  type UpdateTransport
} from './types.js';
import { isAllowedGitHubUrl, UpdateTransportError } from './httpTransport.js';

const API_URL = `https://api.github.com/repos/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases?per_page=100`;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;
const RELEASE_NOTES_MAX_CHARS = 20_000;
const RELEASE_WEB_PREFIX = `https://github.com/${GITHUB_UPDATE_REPOSITORY.owner}/${GITHUB_UPDATE_REPOSITORY.repo}/releases/`;

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly (number | string)[];
}

interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
  readonly state?: string;
}

interface GitHubRelease {
  readonly tag_name: string;
  readonly name?: string | null;
  readonly body?: string | null;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly published_at?: string | null;
  readonly html_url: string;
  readonly assets: readonly GitHubAsset[];
}

export interface LatestYmlInfo {
  readonly version: string;
  readonly path: string;
  readonly sha512: string;
  readonly size: number;
}

function parseSemVer(value: string): SemVer | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  const [, majorText, minorText, patchText, preText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (![major, minor, patch].every((item) => Number.isSafeInteger(item))) return null;
  const pre = preText ? preText.split('.').map((item) => /^\d+$/.test(item) ? Number(item) : item) : [];
  if (pre.some((item) => typeof item === 'number' && !Number.isSafeInteger(item))) return null;
  return { major, minor, patch, pre };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length > 0) return 1;
  if (left.pre.length > 0 && right.pre.length === 0) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index];
    const b = right.pre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'string') return -1;
    if (typeof a === 'string' && typeof b === 'number') return 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

function normalizedVersion(version: SemVer): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.pre.length === 0 ? base : `${base}-${version.pre.join('.')}`;
}

function text(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, maxLength);
}

function decode(body: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(body);
}

function invalid(message: string, code: UpdateDiagnosticCode): UpdateTransportError {
  return new UpdateTransportError(diagnostic(code, 'check', message, false));
}

function isFixedReleaseAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.pathname.startsWith(`${new URL(RELEASE_WEB_PREFIX).pathname}download/`);
  } catch {
    return false;
  }
}

function isFixedReleasePageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.pathname.startsWith(new URL(RELEASE_WEB_PREFIX).pathname);
  } catch {
    return false;
  }
}

function validateAsset(asset: unknown): GitHubAsset {
  if (!asset || typeof asset !== 'object') throw invalid('GitHub Release 资产格式无效。', 'UPDATE_METADATA_INVALID');
  const candidate = asset as Partial<GitHubAsset>;
  const size = candidate.size;
  if (typeof candidate.name !== 'string' || typeof candidate.browser_download_url !== 'string'
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
    || !isAllowedGitHubUrl(candidate.browser_download_url)
    || !isFixedReleaseAssetUrl(candidate.browser_download_url)) {
    throw invalid('GitHub Release 资产信息无效或地址不受信任。', 'UPDATE_METADATA_INVALID');
  }
  return { name: candidate.name, browser_download_url: candidate.browser_download_url, size, ...(candidate.state === undefined ? {} : { state: candidate.state }) };
}

function validateRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== 'object') throw invalid('GitHub Release 条目格式无效。', 'UPDATE_METADATA_INVALID');
  const candidate = value as Partial<GitHubRelease>;
  if (typeof candidate.tag_name !== 'string' || typeof candidate.draft !== 'boolean'
    || typeof candidate.prerelease !== 'boolean' || typeof candidate.html_url !== 'string'
    || !isAllowedGitHubUrl(candidate.html_url)
    || !isFixedReleasePageUrl(candidate.html_url)
    || !Array.isArray(candidate.assets)) {
    throw invalid('GitHub Release 元数据格式无效。', 'UPDATE_METADATA_INVALID');
  }
  return {
    tag_name: candidate.tag_name,
    draft: candidate.draft,
    prerelease: candidate.prerelease,
    html_url: candidate.html_url,
    assets: candidate.assets.map(validateAsset),
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
    ...(candidate.body === undefined ? {} : { body: candidate.body }),
    ...(candidate.published_at === undefined ? {} : { published_at: candidate.published_at })
  };
}

function assetMap(release: GitHubRelease): Map<string, GitHubAsset> {
  const result = new Map<string, GitHubAsset>();
  for (const asset of release.assets) {
    if (result.has(asset.name)) throw invalid(`GitHub Release 存在重复资产：${asset.name}。`, 'UPDATE_METADATA_INVALID');
    result.set(asset.name, asset);
  }
  return result;
}

function requireAsset(assets: Map<string, GitHubAsset>, name: string): GitHubAsset {
  const asset = assets.get(name);
  if (!asset || (asset.state !== undefined && asset.state !== 'uploaded')) {
    throw invalid(`GitHub Release 缺少资产：${name}。`, 'UPDATE_ASSET_MISSING');
  }
  return asset;
}

/** Parses the subset of electron-builder latest.yml needed by the update boundary. */
export function parseLatestYml(source: string, installerName: string): LatestYmlInfo {
  const lines = source.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, '').trimEnd());
  let version: string | undefined;
  let path: string | undefined;
  let rootSha512: string | undefined;
  let currentFile: string | undefined;
  let installerSha512: string | undefined;
  let installerSize: number | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const versionMatch = /^version:\s*(\S+)$/.exec(line);
    if (versionMatch) version = versionMatch[1];
    const pathMatch = /^path:\s*(\S+)$/.exec(line);
    if (pathMatch) path = pathMatch[1];
    const fileMatch = /^\s*-\s*url:\s*(\S+)$/.exec(rawLine);
    if (fileMatch) {
      currentFile = fileMatch[1];
    }
    const fileHashMatch = /^\s{2,}sha512:\s*(\S+)$/.exec(rawLine);
    if (fileHashMatch && currentFile === installerName) installerSha512 = fileHashMatch[1];
    const fileSizeMatch = /^\s{2,}size:\s*(\d+)$/.exec(rawLine);
    if (fileSizeMatch && currentFile === installerName) {
      const parsedSize = Number(fileSizeMatch[1]);
      if (Number.isSafeInteger(parsedSize)) installerSize = parsedSize;
    }
    const rootHashMatch = /^sha512:\s*(\S+)$/.exec(rawLine);
    if (rootHashMatch) rootSha512 = rootHashMatch[1];
  }
  const sha512 = installerSha512 ?? rootSha512;
  if (!version || !path || !sha512 || path !== installerName || !installerSha512 || !rootSha512
    || rootSha512 !== installerSha512 || installerSize === undefined) {
    throw invalid('latest.yml 缺少与 x64 NSIS 安装包匹配的版本、路径、大小或 SHA-512。', 'UPDATE_METADATA_INVALID');
  }
  if (!/^[A-Za-z0-9+/=_-]{20,}$/.test(sha512)) {
    throw invalid('latest.yml 的 SHA-512 格式无效。', 'UPDATE_METADATA_INVALID');
  }
  return { version, path, sha512, size: installerSize };
}

export function parseSha256Sums(source: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})\s+[* ]?(.+?)\s*$/.exec(line);
    if (!match) throw invalid('SHA256SUMS.txt 包含无法解析的行。', 'UPDATE_CHECKSUM_INVALID');
    const [, hash, name] = match;
    if (!hash || !name) throw invalid('SHA256SUMS.txt 包含无法解析的行。', 'UPDATE_CHECKSUM_INVALID');
    if (result.has(name)) throw invalid('SHA256SUMS.txt 包含重复资产记录。', 'UPDATE_CHECKSUM_INVALID');
    result.set(name, hash.toLowerCase());
  }
  return result;
}

function mapTransportError(error: unknown): UpdateDiagnostic {
  if (error instanceof UpdateTransportError) return error.diagnostic;
  return diagnostic('UPDATE_NETWORK_FAILED', 'check', '更新检查失败。', true);
}

function validateMetadataResponse(response: { readonly status: number; readonly url: string; readonly body: Uint8Array }): void {
  if (!isAllowedGitHubUrl(response.url)) {
    throw invalid('GitHub 响应地址不受信任。', 'UPDATE_REDIRECT_FORBIDDEN');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new UpdateTransportError(diagnostic(
      'UPDATE_HTTP_ERROR',
      'check',
      'GitHub 返回了不可用的响应。',
      response.status >= 500,
      response.status
    ));
  }
  if (response.body.byteLength > METADATA_MAX_BYTES) {
    throw new UpdateTransportError(diagnostic('UPDATE_RESPONSE_TOO_LARGE', 'check', 'GitHub 响应超过大小上限。', false));
  }
}

export class GitHubReleaseClient {
  private readonly current: SemVer | null;
  private readonly transport: UpdateTransport;
  private readonly includePrerelease: boolean;
  private readonly platform: string;
  private readonly arch: string;

  public constructor(input: {
    readonly currentVersion: string;
    readonly transport: UpdateTransport;
    readonly includePrerelease?: boolean;
    readonly platform?: string;
    readonly arch?: string;
  }) {
    this.current = parseSemVer(input.currentVersion);
    this.transport = input.transport;
    this.includePrerelease = input.includePrerelease ?? true;
    this.platform = input.platform ?? 'win32';
    this.arch = input.arch ?? 'x64';
  }

  public async check(signal?: AbortSignal): Promise<UpdateCheckResult> {
    if (this.platform !== 'win32' || this.arch !== 'x64') {
      throw new UpdateTransportError(diagnostic(
        'UPDATE_UNSUPPORTED_PLATFORM',
        'check',
        '当前更新核心只支持 Windows x64 NSIS 安装包。',
        false
      ));
    }
    if (!this.current) {
      throw new UpdateTransportError(diagnostic('UPDATE_METADATA_INVALID', 'check', '当前应用版本格式无效，无法安全比较更新。', false));
    }
    let response: { readonly status: number; readonly url: string; readonly body: Uint8Array };
    try {
      response = await this.transport.get(API_URL, { ...(signal === undefined ? {} : { signal }), maxBytes: METADATA_MAX_BYTES });
      validateMetadataResponse(response);
    } catch (error) {
      throw new UpdateTransportError(mapTransportError(error));
    }
    let releases: unknown;
    try {
      releases = JSON.parse(decode(response.body));
    } catch {
      throw invalid('GitHub Release 列表不是有效 JSON。', 'UPDATE_METADATA_INVALID');
    }
    if (!Array.isArray(releases)) throw invalid('GitHub Release 列表格式无效。', 'UPDATE_METADATA_INVALID');
    const candidates = releases
      .map((item) => {
        const release = validateRelease(item);
        const version = parseSemVer(release.tag_name);
        return version && !release.draft && (this.includePrerelease || !release.prerelease)
          && compareSemVer(version, this.current as SemVer) > 0
          ? { release, version }
          : null;
      })
      .filter((item): item is { readonly release: GitHubRelease; readonly version: SemVer } => item !== null)
      .sort((a, b) => compareSemVer(b.version, a.version));

    const selected = candidates[0];
    if (!selected) return { kind: 'not-available' };
    return { kind: 'available', update: await this.resolvePackage(selected.release, selected.version, signal) };
  }

  private async resolvePackage(release: GitHubRelease, version: SemVer, signal?: AbortSignal): Promise<UpdatePackage> {
    const normalized = normalizedVersion(version);
    const installerName = `SoulForge-${normalized}-x64.exe`;
    const assets = assetMap(release);
    const installer = requireAsset(assets, installerName);
    const latest = requireAsset(assets, UPDATE_ASSET_NAMES.latest);
    const blockmap = requireAsset(assets, `${installerName}.blockmap`);
    const checksum = requireAsset(assets, UPDATE_ASSET_NAMES.checksum);

    let latestInfo: LatestYmlInfo;
    let sums: ReadonlyMap<string, string>;
    try {
      const [latestResponse, checksumResponse] = await Promise.all([
        this.transport.get(latest.browser_download_url, { ...(signal === undefined ? {} : { signal }), maxBytes: METADATA_MAX_BYTES }),
        this.transport.get(checksum.browser_download_url, { ...(signal === undefined ? {} : { signal }), maxBytes: METADATA_MAX_BYTES })
      ]);
      validateMetadataResponse(latestResponse);
      validateMetadataResponse(checksumResponse);
      latestInfo = parseLatestYml(decode(latestResponse.body), installerName);
      sums = parseSha256Sums(decode(checksumResponse.body));
    } catch (error) {
      if (error instanceof UpdateTransportError) throw error;
      throw new UpdateTransportError(mapTransportError(error));
    }
    if (latestInfo.version !== normalized) {
      throw invalid('latest.yml 版本与 GitHub Release 不一致。', 'UPDATE_METADATA_INVALID');
    }
    if (latestInfo.size !== installer.size) {
      throw invalid('latest.yml 安装包大小与 GitHub Release 资产不一致。', 'UPDATE_METADATA_INVALID');
    }
    const installerSha256 = sums.get(installerName);
    if (!installerSha256) throw invalid(`SHA256SUMS.txt 缺少资产：${installerName}。`, 'UPDATE_CHECKSUM_INVALID');
    if (!/^[a-f0-9]{64}$/.test(installerSha256)) throw invalid('安装包 SHA-256 格式无效。', 'UPDATE_CHECKSUM_INVALID');

    const info: UpdateInfo = {
      version: normalized,
      tag: release.tag_name,
      channel: release.prerelease ? 'prerelease' : 'stable',
      releaseName: text(release.name, release.tag_name, 200),
      releaseNotes: text(release.body, '', RELEASE_NOTES_MAX_CHARS),
      publishedAt: typeof release.published_at === 'string' ? text(release.published_at, '', 80) : null,
      releaseUrl: release.html_url,
      installerName,
      installerSize: installer.size,
      installerSha256
    };
    return {
      info,
      installerUrl: installer.browser_download_url,
      latestYmlUrl: latest.browser_download_url,
      blockmapUrl: blockmap.browser_download_url,
      checksumUrl: checksum.browser_download_url,
      installerSha512: latestInfo.sha512
    };
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha512Base64(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('base64');
}
