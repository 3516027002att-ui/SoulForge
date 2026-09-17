import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export class ReleaseUpdateAssetError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = 'ReleaseUpdateAssetError';
    this.code = code;
    this.path = path;
  }
}

export function parseVersion(value, { allowPrefix = false } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  const candidate = allowPrefix && text.startsWith('v') ? text.slice(1) : text;
  const match = VERSION_PATTERN.exec(candidate);
  if (!match) return null;
  const numeric = match.slice(1, 4).map(Number);
  if (!numeric.every(Number.isSafeInteger)) return null;
  if (match[1].length > 1 && match[1].startsWith('0')) return null;
  if (match[2].length > 1 && match[2].startsWith('0')) return null;
  if (match[3].length > 1 && match[3].startsWith('0')) return null;
  const pre = match[4] ?? '';
  if (pre.split('.').some((part) => /^d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
  return {
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease: pre
  };
}

export function normalizeVersion(value) {
  const parsed = typeof value === 'string' ? parseVersion(value, { allowPrefix: true }) : value;
  if (!parsed) throw new ReleaseUpdateAssetError('RELEASE_VERSION_INVALID', `版本格式无效：${String(value)}。`);
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${base}-${parsed.prerelease}` : base;
}

export function parseReleaseTag(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^v/.test(text)) return null;
  const version = parseVersion(text, { allowPrefix: true });
  return version ? { tag: text, version: normalizeVersion(version) } : null;
}

export async function readProjectVersion(root) {
  const rootPackage = await readJson(resolve(root, 'package.json'), 'PACKAGE_JSON_INVALID', 'package.json');
  const desktopPackage = await readJson(resolve(root, 'apps/desktop/package.json'), 'DESKTOP_PACKAGE_JSON_INVALID', 'apps/desktop/package.json');
  const rootVersion = normalizeVersion(rootPackage.version);
  const desktopVersion = normalizeVersion(desktopPackage.version);
  if (rootVersion !== desktopVersion) {
    throw new ReleaseUpdateAssetError(
      'RELEASE_PACKAGE_VERSION_MISMATCH',
      `根 package.json (${rootVersion}) 与 apps/desktop/package.json (${desktopVersion}) 版本不一致。`
    );
  }
  return { version: rootVersion, rootPackage, desktopPackage };
}

export async function readJson(path, code, label = path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ReleaseUpdateAssetError(code, `无法读取 ${label}。`, label);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseUpdateAssetError(code, `${label} 不是合法 JSON。`, label);
  }
}

export function option(args, name) {
  const prefix = `${name}=`;
  const item = args.find((value) => value.startsWith(prefix));
  return item === undefined ? null : item.slice(prefix.length);
}

export async function releaseDirectory(root, args) {
  const input = option(args, '--release-dir') ?? process.env.RELEASE_DIR ?? 'apps/desktop/release';
  const rootAbsolute = resolve(root);
  const directory = resolve(rootAbsolute, input);
  if (!isWithin(rootAbsolute, directory)) {
    throw new ReleaseUpdateAssetError('RELEASE_PATH_OUTSIDE_ROOT', 'Release 目录必须位于当前仓库内。', input);
  }
  let stats;
  try {
    stats = await lstat(directory);
  } catch {
    return directory;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReleaseUpdateAssetError('RELEASE_DIRECTORY_INVALID', 'Release 目录必须是仓库内的普通目录。', input);
  }
  try {
    const realRoot = await realpath(rootAbsolute);
    const realDirectory = await realpath(directory);
    if (!isWithin(realRoot, realDirectory)) {
      throw new ReleaseUpdateAssetError('RELEASE_PATH_OUTSIDE_ROOT', 'Release 目录的真实路径必须位于当前仓库内。', input);
    }
  } catch (error) {
    if (error instanceof ReleaseUpdateAssetError) throw error;
    throw new ReleaseUpdateAssetError('RELEASE_DIRECTORY_INVALID', '无法解析 Release 目录。', input);
  }
  return directory;
}

export function releaseVersion(args, projectVersion) {
  const input = option(args, '--version') ?? process.env.RELEASE_VERSION ?? projectVersion;
  const version = normalizeVersion(input);
  if (version !== projectVersion) {
    throw new ReleaseUpdateAssetError(
      'RELEASE_VERSION_MISMATCH',
      `请求的 Release 版本 ${version} 与项目版本 ${projectVersion} 不一致。`
    );
  }
  return version;
}

export function releaseTag(args, version, { required = false } = {}) {
  const positional = args.filter((value) => !value.startsWith('--'));
  const input = option(args, '--tag') ?? positional[0] ?? process.env.RELEASE_TAG ?? null;
  if (input === null) {
    if (required) throw new ReleaseUpdateAssetError('RELEASE_TAG_MISSING', '必须提供 vX.Y.Z Release tag。');
    return `v${version}`;
  }
  const parsed = parseReleaseTag(input);
  if (!parsed || parsed.version !== version) {
    throw new ReleaseUpdateAssetError(
      'RELEASE_TAG_VERSION_MISMATCH',
      `Release tag ${input} 必须是与项目版本 ${version} 完全一致的 v${version}。`
    );
  }
  return parsed.tag;
}

export function installerName(version) {
  return `SoulForge-${version}-x64.exe`;
}

export function releaseAssetNames(version) {
  const installer = installerName(version);
  return Object.freeze({
    installer,
    blockmap: `${installer}.blockmap`,
    latest: 'latest.yml',
    checksums: 'SHA256SUMS.txt',
    compliance: 'release-installer-compliance.json',
    source: `SoulForge-v${version}-win-x64-source.zip`
  });
}

export async function regularFile(path, label, { nonEmpty = true } = {}) {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new ReleaseUpdateAssetError('RELEASE_ASSET_MISSING', `缺少 Release 资产：${label}。`, label);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ReleaseUpdateAssetError('RELEASE_ASSET_NOT_REGULAR', `Release 资产必须是普通文件：${label}。`, label);
  }
  if (nonEmpty && stats.size <= 0) {
    throw new ReleaseUpdateAssetError('RELEASE_ASSET_EMPTY', `Release 资产不能为空：${label}。`, label);
  }
  return stats;
}

export async function assetPath(root, directory, name) {
  const rootAbsolute = resolve(root);
  const path = resolve(directory, name);
  if (!isWithin(rootAbsolute, path) || basename(path) !== name) {
    throw new ReleaseUpdateAssetError('RELEASE_PATH_INVALID', `Release 资产路径无效：${name}。`, name);
  }
  return path;
}

export async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm);
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    throw new ReleaseUpdateAssetError('RELEASE_ASSET_UNREADABLE', `无法读取 Release 资产：${path}。`, path);
  }
  return hash.digest(encoding);
}

export function isSha512Base64(value) {
  return typeof value === 'string' && SHA512_BASE64_PATTERN.test(value);
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function latestYmlText({ version, installer, sha512, size }) {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${installer}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installer}`,
    `sha512: ${sha512}`,
    ''
  ].join('\n');
}

export function parseLatestYml(source, installer) {
  const lines = String(source).replace(/^\uFEFF/, '').split(/\r?\n/);
  let version = null;
  let path = null;
  let rootSha512 = null;
  let currentUrl = null;
  let installerSha512 = null;
  let installerSize = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd();
    const versionMatch = /^version:\s*(\S+)\s*$/.exec(line);
    if (versionMatch) version = versionMatch[1];
    const pathMatch = /^path:\s*(\S+)\s*$/.exec(line);
    if (pathMatch) path = pathMatch[1];
    const itemMatch = /^\s*-\s*url:\s*(\S+)\s*$/.exec(line);
    if (itemMatch) {
      currentUrl = itemMatch[1];
      continue;
    }
    const fileHashMatch = /^\s{4,}sha512:\s*(\S+)\s*$/.exec(line);
    if (fileHashMatch && currentUrl === installer) installerSha512 = fileHashMatch[1];
    const sizeMatch = /^\s{4,}size:\s*(\d+)\s*$/.exec(line);
    if (sizeMatch && currentUrl === installer) installerSize = Number(sizeMatch[1]);
    const rootHashMatch = /^sha512:\s*(\S+)\s*$/.exec(line);
    if (rootHashMatch) rootSha512 = rootHashMatch[1];
  }
  if (!version || !path || !installerSha512 || !rootSha512 || installerSize === null || path !== installer || rootSha512 !== installerSha512) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_INVALID', 'latest.yml 缺少与 x64 NSIS 安装包匹配的版本、路径、大小或 SHA-512。', 'latest.yml');
  }
  if (!isSha512Base64(installerSha512)) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_INVALID', 'latest.yml 的 SHA-512 格式无效。', 'latest.yml');
  }
  if (!Number.isSafeInteger(installerSize) || installerSize < 0) {
    throw new ReleaseUpdateAssetError('RELEASE_LATEST_YML_INVALID', 'latest.yml 的安装包大小无效。', 'latest.yml');
  }
  return { version, path, sha512: installerSha512, size: installerSize };
}

export function parseSha256Sums(source) {
  const result = new Map();
  for (const rawLine of String(source).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-fA-F0-9]{64})\s+[* ]?([^\s]+)\s*$/.exec(line);
    if (!match) throw new ReleaseUpdateAssetError('RELEASE_SHA256SUMS_INVALID', 'SHA256SUMS.txt 包含无法解析的行。', 'SHA256SUMS.txt');
    const name = match[2];
    if (result.has(name)) throw new ReleaseUpdateAssetError('RELEASE_SHA256SUMS_INVALID', `SHA256SUMS.txt 包含重复资产记录：${name}。`, 'SHA256SUMS.txt');
    result.set(name, match[1].toLowerCase());
  }
  return result;
}

export function isWithin(root, candidate) {
  const rootText = resolve(root);
  const candidateText = resolve(candidate);
  const rel = relative(rootText, candidateText);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(`..\\`) && !/^[A-Za-z]:/.test(rel));
}

export function structuredError(error) {
  if (error instanceof ReleaseUpdateAssetError) {
    return { code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}) };
  }
  return { code: 'RELEASE_UPDATE_ASSET_UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error) };
}
