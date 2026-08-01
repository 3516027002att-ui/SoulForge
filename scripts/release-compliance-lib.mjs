import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  globSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const RELEASE_MANIFEST_RELATIVE_PATH = 'apps/desktop/out/release-compliance.json';
export const RELEASE_POLICY_RELATIVE_PATH = 'scripts/release-compliance-policy.json';

const SECRET_PATTERNS = [
  { code: 'PRIVATE_KEY_CONTENT', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { code: 'AWS_ACCESS_KEY_CONTENT', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'GITHUB_TOKEN_CONTENT', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { code: 'OPENAI_KEY_CONTENT', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/ }
];

const SUPPORTED_LOCKFILE_VERSIONS = new Set([2, 3]);
const SECRET_SCAN_OVERLAP_BYTES = 512;

export function loadReleasePolicy(root) {
  const policyPath = resolve(root, RELEASE_POLICY_RELATIVE_PATH);
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  const findings = [];
  if (policy.schemaVersion !== 1) {
    findings.push(error('RELEASE_POLICY_SCHEMA_UNSUPPORTED', RELEASE_POLICY_RELATIVE_PATH, 'release policy schemaVersion 必须为 1。'));
  }
  if (!Array.isArray(policy.allowedLicenseExpressions) || policy.allowedLicenseExpressions.length === 0) {
    findings.push(error('RELEASE_LICENSE_ALLOWLIST_EMPTY', RELEASE_POLICY_RELATIVE_PATH, '许可证 allowlist 不能为空。'));
  }
  if (!Array.isArray(policy.artifactInputs) || policy.artifactInputs.length === 0) {
    findings.push(error('RELEASE_ARTIFACT_INPUTS_EMPTY', RELEASE_POLICY_RELATIVE_PATH, 'artifactInputs 不能为空。'));
  }
  return { policy, findings };
}

export async function createReleaseComplianceManifest(root, policy) {
  const findings = [];
  const lockPath = resolve(root, 'package-lock.json');
  const rootPackagePath = resolve(root, 'package.json');
  const lockText = await readFile(lockPath, 'utf8');
  const lock = JSON.parse(lockText);
  const rootPackage = JSON.parse(await readFile(rootPackagePath, 'utf8'));
  validatePackageLock(lock, findings);
  const licenses = collectProductionLicenses(root, rootPackage, lock, policy, findings);
  const artifacts = await collectArtifactSnapshot(root, policy, findings);
  const policyHash = sha256Text(canonicalJson(policy));
  const lockfileSha256 = sha256Text(lockText);

  return {
    schemaVersion: 1,
    authority: 'partial',
    scope: 'unsigned-win-x64-build-inputs',
    product: {
      name: rootPackage.name,
      version: rootPackage.version,
      target: policy.target
    },
    policy: {
      path: RELEASE_POLICY_RELATIVE_PATH,
      sha256: policyHash
    },
    lockfile: {
      path: 'package-lock.json',
      sha256: lockfileSha256,
      lockfileVersion: isRecord(lock) ? (lock.lockfileVersion ?? null) : null
    },
    licenses,
    artifacts,
    reproducibility: {
      algorithm: 'sha256-content-manifest-v1',
      aggregateSha256: artifacts.aggregateSha256,
      ignoredMetadata: ['absolute-path', 'directory-enumeration-order', 'mtime', 'ctime']
    },
    diagnostics: findings.map(({ severity, code, path, message }) => ({ severity, code, path, message }))
  };
}

export async function auditReleaseCompliance(input) {
  const { root, policy, trackedPaths = [] } = input;
  const expected = await createReleaseComplianceManifest(root, policy);
  const findings = [...expected.diagnostics];
  const manifestPath = resolve(root, RELEASE_MANIFEST_RELATIVE_PATH);
  let actual = null;
  let actualText = '';
  let actualParsed = false;
  if (!existsSync(manifestPath)) {
    findings.push(error(
      'RELEASE_MANIFEST_MISSING',
      RELEASE_MANIFEST_RELATIVE_PATH,
      '缺少 release compliance manifest；先运行 npm run build。'
    ));
  } else {
    try {
      actualText = readFileSync(manifestPath, 'utf8');
      actual = JSON.parse(actualText);
      actualParsed = true;
    } catch {
      findings.push(error('RELEASE_MANIFEST_INVALID', RELEASE_MANIFEST_RELATIVE_PATH, 'release compliance manifest 不是合法 JSON。'));
    }
  }

  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  if (actualParsed && actualText !== expectedText) {
    findings.push(error(
      'RELEASE_MANIFEST_STALE',
      RELEASE_MANIFEST_RELATIVE_PATH,
      'release compliance manifest 与当前 lockfile/构建产物不一致。'
    ));
  }
  findings.push(...await auditPaths(root, trackedPaths, 'tracked'));
  findings.push(...await auditPaths(root, expected.artifacts.files.map((item) => item.sourcePath), 'artifact'));
  findings.push(...auditTargetPaths(expected.artifacts.files.map((item) => item.path), 'artifact-target'));

  const errors = deduplicateFindings(findings).filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'passed' : 'failed',
    expected,
    actual,
    manifestSha256: actualText ? sha256Text(actualText) : null,
    findings: deduplicateFindings(findings)
  };
}

export function serializeReleaseManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function validatePackageLock(lock, findings) {
  if (!isRecord(lock)) {
    findings.push(error('PACKAGE_LOCK_INVALID', 'package-lock.json', 'package-lock.json root must be an object.'));
    return;
  }
  if (!SUPPORTED_LOCKFILE_VERSIONS.has(lock.lockfileVersion)) {
    findings.push(error(
      'PACKAGE_LOCK_VERSION_UNSUPPORTED',
      'package-lock.json',
      `package-lock.json lockfileVersion must be one of ${[...SUPPORTED_LOCKFILE_VERSIONS].join(', ')}.`
    ));
  }
  if (!isRecord(lock.packages)) {
    findings.push(error(
      'PACKAGE_LOCK_PACKAGES_MISSING',
      'package-lock.json',
      'package-lock.json packages must be a non-array object.'
    ));
  }
}

function collectProductionLicenses(root, rootPackage, lock, policy, findings) {
  const allowed = new Set(policy.allowedLicenseExpressions);
  const packages = [];
  const lockPackages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  const workspacePaths = declaredWorkspacePaths(root, rootPackage, findings);
  for (const [lockPath, metadata] of Object.entries(lockPackages)) {
    if (!isRecord(metadata)) continue;
    if (!lockPath.includes('node_modules/') || metadata.dev === true) continue;
    if (metadata.link === true) {
      const resolved = typeof metadata.resolved === 'string' ? normalize(metadata.resolved) : '';
      if (resolved && workspacePaths.has(foldWindowsPath(resolved))) continue;
      findings.push(error(
        'DEPENDENCY_LINK_OUTSIDE_WORKSPACE',
        lockPath,
        'Production link dependencies must resolve to a repository workspace declared by the root package.json.'
      ));
      continue;
    }
    const name = packageNameFromLockPath(lockPath);
    const license = typeof metadata.license === 'string' ? metadata.license.trim() : '';
    if (!metadata.version) {
      findings.push(error('DEPENDENCY_VERSION_MISSING', lockPath, `依赖 ${name} 缺少锁定版本。`));
    }
    if (!license) {
      findings.push(error('DEPENDENCY_LICENSE_MISSING', lockPath, `依赖 ${name} 缺少 license metadata。`));
    } else if (!allowed.has(license)) {
      findings.push(error('DEPENDENCY_LICENSE_NOT_ALLOWED', lockPath, `依赖 ${name} 的许可证 ${license} 未经策略允许。`));
    }
    const packageDirectory = resolve(root, lockPath);
    const licenseFiles = directLicenseFiles(root, packageDirectory, name);
    const isInstalled = existsSync(packageDirectory);
    const isOptionalNotInstalled = metadata.optional === true && !isInstalled;
    packages.push({
      name,
      version: metadata.version ?? null,
      license: license || null,
      lockPath: normalize(lockPath),
      integrity: metadata.integrity ?? null,
      optional: metadata.optional === true,
      installed: isInstalled,
      licenseFiles,
      licenseTextStatus: isOptionalNotInstalled
        ? 'not-installed'
        : licenseFiles.length > 0 ? 'present' : 'metadata-only'
    });
  }
  packages.sort((left, right) => compareText(
    `${left.name}\0${left.version}\0${left.lockPath}`,
    `${right.name}\0${right.version}\0${right.lockPath}`
  ));
  if (packages.length === 0) {
    findings.push(error(
      'PRODUCTION_DEPENDENCY_INVENTORY_EMPTY',
      'package-lock.json',
      'package-lock.json did not produce any non-development dependency inventory entries.'
    ));
  }
  const expressions = {};
  for (const item of packages) {
    const key = item.license ?? '<missing>';
    expressions[key] = (expressions[key] ?? 0) + 1;
  }
  const metadataOnly = packages.filter((item) => item.licenseTextStatus === 'metadata-only').length;
  const notInstalled = packages.filter((item) => item.licenseTextStatus === 'not-installed').length;
  if (metadataOnly > 0) {
    findings.push(warning(
      'LICENSE_TEXT_COVERAGE_PARTIAL',
      'package-lock.json',
      `${metadataOnly} 个锁定依赖只有 license metadata，尚未形成完整 third-party notice 文本。`
    ));
  }
  return {
    inventoryKind: 'production-lockfile-metadata',
    packageCount: packages.length,
    licenseExpressions: sortRecord(expressions),
    textCoverage: {
      present: packages.length - metadataOnly - notInstalled,
      metadataOnly,
      notInstalled,
      complete: metadataOnly === 0
    },
    inventorySha256: sha256Text(canonicalJson(packages)),
    packages
  };
}

function declaredWorkspacePaths(root, rootPackage, findings) {
  const declaration = rootPackage?.workspaces;
  const patterns = Array.isArray(declaration)
    ? declaration
    : isRecord(declaration) && Array.isArray(declaration.packages)
      ? declaration.packages
      : [];
  const paths = new Set();
  let physicalRoot;
  try {
    physicalRoot = realpathSync(root);
  } catch {
    findings.push(error(
      'WORKSPACE_ROOT_RESOLUTION_FAILED',
      'package.json',
      'Repository root could not be resolved while validating workspace links.'
    ));
    return paths;
  }
  for (const pattern of patterns) {
    if (typeof pattern !== 'string'
      || pattern.length === 0
      || pattern.includes('\0')
      || isAbsolute(pattern)
      || normalize(pattern).split('/').includes('..')) {
      findings.push(error(
        'WORKSPACE_DECLARATION_INVALID',
        'package.json',
        'Root workspace declarations must be non-empty repository-relative glob patterns.'
      ));
      continue;
    }
    let matches;
    try {
      matches = globSync(pattern, { cwd: root, withFileTypes: false });
    } catch {
      findings.push(error(
        'WORKSPACE_DECLARATION_INVALID',
        'package.json',
        'Root workspace declaration could not be evaluated.'
      ));
      continue;
    }
    for (const match of matches) {
      const normalized = normalize(match).replace(/\/$/u, '');
      const absolute = resolveWithinRoot(root, normalized);
      if (!absolute || !existsSync(resolve(absolute, 'package.json'))) continue;
      let physicalWorkspace;
      try {
        physicalWorkspace = realpathSync(absolute);
      } catch {
        findings.push(error(
          'WORKSPACE_PATH_RESOLUTION_FAILED',
          normalized,
          'Declared workspace path could not be resolved.'
        ));
        continue;
      }
      if (!isWithinPath(physicalRoot, physicalWorkspace)) {
        findings.push(error(
          'WORKSPACE_PATH_OUTSIDE_REPOSITORY',
          normalized,
          'Declared workspace must resolve inside the repository root.'
        ));
        continue;
      }
      paths.add(foldWindowsPath(normalized));
    }
  }
  return paths;
}

async function collectArtifactSnapshot(root, policy, findings) {
  const files = [];
  const targets = new Map();
  const artifactInputs = Array.isArray(policy.artifactInputs) ? policy.artifactInputs : [];
  for (const input of artifactInputs) {
    if (!isRecord(input)) {
      findings.push(error('RELEASE_ARTIFACT_INPUT_INVALID', RELEASE_POLICY_RELATIVE_PATH, 'artifact input must be an object.'));
      continue;
    }
    const sourcePathFinding = unsafeRelativePathFinding(input.source, 'RELEASE_ARTIFACT_SOURCE_PATH_INVALID');
    const targetPathFinding = unsafeRelativePathFinding(input.target, 'RELEASE_ARTIFACT_TARGET_PATH_INVALID');
    if (sourcePathFinding) findings.push(sourcePathFinding);
    if (targetPathFinding) findings.push(targetPathFinding);
    if (sourcePathFinding || targetPathFinding) continue;
    const source = resolveWithinRoot(root, input.source);
    if (!source || !existsSync(source)) {
      findings.push(error('RELEASE_ARTIFACT_INPUT_MISSING', input.source, `缺少发行输入 ${input.source}。`));
      continue;
    }
    if (input.kind === 'file') {
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        findings.push(error('RELEASE_ARTIFACT_INPUT_INVALID', input.source, '发行输入必须是普通文件。'));
        continue;
      }
      await addArtifactEntry(files, targets, findings, root, source, normalize(input.target));
      continue;
    }
    if (input.kind !== 'directory') {
      findings.push(error('RELEASE_ARTIFACT_KIND_INVALID', input.source, `未知 artifact kind ${input.kind}。`));
      continue;
    }
    const sourceStat = lstatSync(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      findings.push(error('RELEASE_ARTIFACT_INPUT_INVALID', input.source, 'directory artifact input must be a regular directory.'));
      continue;
    }
    const excludes = new Set();
    const excludedPaths = Array.isArray(input.exclude) ? input.exclude : [];
    for (const excludedPath of excludedPaths) {
      const excludeFinding = unsafeRelativePathFinding(excludedPath, 'RELEASE_ARTIFACT_EXCLUDE_PATH_INVALID');
      if (excludeFinding) findings.push(excludeFinding);
      else excludes.add(normalize(excludedPath));
    }
    const walked = walkRegularFiles(root, source, findings);
    for (const file of walked) {
      const local = normalize(relative(source, file));
      if (excludes.has(local)) continue;
      await addArtifactEntry(files, targets, findings, root, file, normalize(join(input.target, local)));
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  if (files.length === 0) {
    findings.push(error('RELEASE_ARTIFACT_SET_EMPTY', 'apps/desktop/out', '发行内容集合为空。'));
  }
  const aggregateSha256 = sha256Text(files.map((item) => `${item.path}\0${item.size}\0${item.sha256}`).join('\n'));
  return {
    fileCount: files.length,
    byteCount: files.reduce((total, item) => total + item.size, 0),
    aggregateSha256,
    files
  };
}

async function addArtifactEntry(files, targets, findings, root, source, target) {
  const forbiddenTarget = forbiddenPathFinding(target, 'artifact-target');
  if (forbiddenTarget) {
    findings.push(forbiddenTarget);
    return;
  }
  const foldedTarget = target.toLowerCase();
  const existing = targets.get(foldedTarget);
  if (existing) {
    findings.push(error(
      'RELEASE_ARTIFACT_TARGET_CONFLICT',
      target,
      `artifact target conflicts on Windows with ${existing}.`
    ));
    return;
  }
  targets.set(foldedTarget, target);
  files.push(await artifactEntry(root, source, target));
}

async function artifactEntry(root, source, target) {
  const stat = lstatSync(source);
  return {
    path: target,
    sourcePath: normalize(relative(root, source)),
    size: stat.size,
    sha256: await sha256File(source)
  };
}

function walkRegularFiles(root, directory, findings) {
  const result = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const rel = normalize(relative(root, path));
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      findings.push(error('RELEASE_SYMLINK_FORBIDDEN', rel, '发行输入不得包含 symlink/junction。'));
      continue;
    }
    if (stat.isDirectory()) result.push(...walkRegularFiles(root, path, findings));
    else if (stat.isFile()) result.push(path);
  }
  return result;
}

async function auditPaths(root, paths, scope) {
  const findings = [];
  for (const relativePath of [...new Set(paths.map(normalize))].sort(compareText)) {
    const pathFinding = forbiddenPathFinding(relativePath, scope);
    if (pathFinding) findings.push(pathFinding);
    const absolute = resolveWithinRoot(root, relativePath);
    if (!absolute || !existsSync(absolute)) continue;
    const stat = lstatSync(absolute);
    if (!stat.isFile()) continue;
    try {
      const codes = await scanSecretCodes(absolute);
      for (const code of codes) {
        findings.push(error(code, relativePath, `在 ${scope} 文件中发现高置信凭据模式。`));
      }
    } catch {
      findings.push(error(
        'RELEASE_CONTENT_SCAN_FAILED',
        relativePath,
        `无法扫描 ${scope} 文件内容。`
      ));
    }
  }
  return findings;
}

function auditTargetPaths(paths, scope) {
  const findings = [];
  for (const path of [...new Set(paths.map(normalize))].sort(compareText)) {
    const pathFinding = forbiddenPathFinding(path, scope);
    if (pathFinding) findings.push(pathFinding);
  }
  return findings;
}

async function scanSecretCodes(path) {
  const found = new Set();
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    scanDecodedText(bytes.toString('utf8'), found);
    scanDecodedText(bytes.toString('utf16le'), found);
    scanDecodedText(bytes.subarray(1).toString('utf16le'), found);
    scanDecodedText(decodeUtf16Be(bytes), found);
    scanDecodedText(decodeUtf16Be(bytes.subarray(1)), found);
    carry = bytes.subarray(Math.max(0, bytes.length - SECRET_SCAN_OVERLAP_BYTES));
  }
  return [...found].sort(compareText);
}

function scanDecodedText(text, found) {
  for (const item of SECRET_PATTERNS) {
    if (!found.has(item.code) && item.pattern.test(text)) found.add(item.code);
  }
}

function decodeUtf16Be(bytes) {
  const evenLength = bytes.length - (bytes.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let index = 0; index < evenLength; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped.toString('utf16le');
}

function forbiddenPathFinding(path, scope) {
  const normalized = normalize(path);
  const lower = normalized.toLowerCase();
  const segments = lower.split('/');
  if (segments.includes('mods')
    || lower.includes('testdata/native-fixtures/')
    || lower.includes('sekiro shadows die twice/')) {
    return error('PRIVATE_ASSET_PATH_FORBIDDEN', normalized, `${scope} 内容不得包含真实游戏/Mod/private corpus 路径。`);
  }
  const fileName = basename(lower);
  if (/^oo2core_.*\.dll$/.test(fileName)) {
    return error('OODLE_RUNTIME_FORBIDDEN', normalized, `${scope} 内容不得包含 Oodle runtime。`);
  }
  if (/^(?:\.env(?:\..*)?|id_rsa)$/.test(fileName)
    || /\.(?:pem|p12|pfx|key)$/.test(fileName)) {
    return error('CREDENTIAL_FILE_FORBIDDEN', normalized, `${scope} 内容不得包含凭据/私钥文件。`);
  }
  return null;
}

function directLicenseFiles(root, packageDirectory, packageName) {
  const files = [];
  if (existsSync(packageDirectory)) {
    try {
      for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
        if (entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name)) {
          files.push(normalize(relative(root, join(packageDirectory, entry.name))));
        }
      }
    } catch { /* ignore */ }
  }
  // Supplemental license texts from project-level licenses/ directory.
  if (files.length === 0 && packageName) {
    const supplemental = join(root, 'licenses', `${packageName.replace(/\//g, '+')}.txt`);
    if (existsSync(supplemental)) {
      files.push(normalize(relative(root, supplemental)));
    }
  }
  return files.sort(compareText);
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const tail = normalize(lockPath).slice(normalize(lockPath).lastIndexOf(marker) + marker.length);
  const parts = tail.split('/');
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveWithinRoot(root, relativePath) {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const prefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`;
  if (target !== absoluteRoot && !target.startsWith(prefix)) return null;
  return target;
}

function isWithinPath(root, target) {
  const foldedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const foldedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target);
  const prefix = foldedRoot.endsWith(sep) ? foldedRoot : `${foldedRoot}${sep}`;
  return foldedTarget === foldedRoot || foldedTarget.startsWith(prefix);
}

function unsafeRelativePathFinding(path, code) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    return error(code, RELEASE_POLICY_RELATIVE_PATH, 'artifact path must be a non-empty relative path.');
  }
  const slashed = path.replaceAll('\\', '/');
  const segments = slashed.split('/');
  const invalid = isAbsolute(path)
    || slashed.startsWith('/')
    || /^[A-Za-z]:/.test(slashed)
    || segments.some((segment) => segment.length === 0
      || segment === '.'
      || segment === '..'
      || /[<>:"|?*]/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
      || /[ .]$/.test(segment));
  if (!invalid) return null;
  return error(code, path, 'artifact path must be a safe relative path without traversal segments.');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareText(left, right)));
}

function normalize(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//, '');
}

function foldWindowsPath(path) {
  return normalize(path).toLowerCase();
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), 'en');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function error(code, path, message) {
  return { severity: 'error', code, path: normalize(path), message };
}

function warning(code, path, message) {
  return { severity: 'warning', code, path: normalize(path), message };
}

function deduplicateFindings(findings) {
  const seen = new Set();
  const result = [];
  for (const item of findings) {
    const key = `${item.severity}\0${item.code}\0${item.path}\0${item.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((left, right) => compareText(
    `${left.severity}\0${left.code}\0${left.path}`,
    `${right.severity}\0${right.code}\0${right.path}`
  ));
}

// --- Package tree (unpacked/NSIS payload) scanning ---

export const INSTALLER_MANIFEST_RELATIVE_PATH = 'apps/desktop/release/release-installer-compliance.json';
export const UNPACKED_DIRECTORY_RELATIVE_PATH = 'apps/desktop/release/win-unpacked';
export const SOURCE_MANIFEST_RELATIVE_PATH = RELEASE_MANIFEST_RELATIVE_PATH;

/** Files inside win-unpacked that must always be present (application payload). */
const PACKAGE_TREE_STRICT_REQUIRED = [
  'resources/app.asar',
  'resources/native/better_sqlite3.node',
  'resources/native/better_sqlite3.json'
];

/** Electron runtime files that must always be present in the unpacked tree. */
const PACKAGE_TREE_RUNTIME_REQUIRED = [
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'resources.pak',
  'icudtl.dat',
  'ffmpeg.dll',
  'v8_context_snapshot.bin',
  'snapshot_blob.bin',
  'LICENSE.electron.txt',
  'resources/elevate.exe'
];

/** Recommended but non-fatal runtime files (missing entries produce warnings). */
const PACKAGE_TREE_RECOMMENDED = [
  'locales/en-US.pak',
  'libEGL.dll',
  'libGLESv2.dll',
  'd3dcompiler_47.dll',
  'LICENSES.chromium.html'
];

const ASAR_HEADER_OFFSET = 16;

/**
 * Parse the Chromium pickle header of an app.asar and return the normalized
 * list of file entries (directories excluded), sorted deterministically.
 */
export function listAsarEntries(asarPath) {
  const buffer = readFileSync(asarPath);
  if (buffer.length < ASAR_HEADER_OFFSET) {
    throw new Error('ASAR_HEADER_TRUNCATED');
  }
  const jsonLength = buffer.readUInt32LE(12);
  if (jsonLength <= 0 || jsonLength > buffer.length - ASAR_HEADER_OFFSET) {
    throw new Error('ASAR_HEADER_INVALID');
  }
  let header;
  try {
    header = JSON.parse(buffer.subarray(ASAR_HEADER_OFFSET, ASAR_HEADER_OFFSET + jsonLength).toString('utf8'));
  } catch {
    throw new Error('ASAR_HEADER_JSON_INVALID');
  }
  const entries = [];
  const walk = (node, prefix) => {
    const files = isRecord(node) ? node.files : null;
    if (!files) return;
    for (const [name, child] of Object.entries(files)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (isRecord(child) && isRecord(child.files)) walk(child, path);
      else entries.push(path);
    }
  };
  walk(header, '');
  return entries.sort(compareText);
}

/**
 * Derive the NSIS installer artifact file name from the strict electron-builder
 * config and the desktop package version, e.g. SoulForge-0.0.0-x64.exe.
 */
export function installerArtifactName(electronBuilderConfig, desktopPackage) {
  const template = typeof electronBuilderConfig?.win?.artifactName === 'string'
    ? electronBuilderConfig.win.artifactName
    : '${productName}-${version}-${arch}.${ext}';
  const target = Array.isArray(electronBuilderConfig?.win?.target) ? electronBuilderConfig.win.target[0] : null;
  const arch = Array.isArray(target?.arch) && typeof target.arch[0] === 'string'
    ? target.arch[0]
    : 'x64';
  return template
    .replaceAll('${productName}', typeof electronBuilderConfig?.productName === 'string'
      ? electronBuilderConfig.productName
      : 'SoulForge')
    .replaceAll('${version}', typeof desktopPackage?.version === 'string'
      ? desktopPackage.version
      : '0.0.0')
    .replaceAll('${arch}', arch)
    .replaceAll('${ext}', 'exe');
}

/**
 * Scan the unpacked package tree (the exact payload NSIS packs) and assert that
 * required files are present, forbidden paths never appear, and optional
 * not-installed platform packages are honestly recorded as absent from asar.
 */
export function auditPackageTree({ root, unpackedDir, lock, executableName }) {
  const diagnostics = [];
  const absolute = resolveWithinRoot(root, unpackedDir);
  if (!absolute || !existsSync(absolute)) {
    return {
      ok: null,
      status: 'skipped',
      unpackedDir,
      fileCount: 0,
      byteCount: 0,
      asarEntryCount: null,
      missingRequired: [],
      missingRecommended: [],
      forbiddenHits: [],
      optionalNotInstalledPresent: [],
      diagnostics: [warning('PACKAGE_TREE_NOT_BUILT', unpackedDir, '未找到 unpacked 构建产物；先构建 NSIS 安装包或 --dir 中间产物。')]
    };
  }
  const walked = walkPackageTreeFiles(root, absolute, diagnostics);
  const actual = new Set(walked.paths);
  const required = [executableName, ...PACKAGE_TREE_STRICT_REQUIRED, ...PACKAGE_TREE_RUNTIME_REQUIRED]
    .map(normalize);
  const missingRequired = required.filter((path) => !actual.has(path));
  const missingRecommended = PACKAGE_TREE_RECOMMENDED.map(normalize).filter((path) => !actual.has(path));
  for (const path of missingRequired) {
    diagnostics.push(error('PACKAGE_TREE_REQUIRED_MISSING', `${unpackedDir}/${path}`, 'unpacked 必装文件缺失。'));
  }
  for (const path of missingRecommended) {
    diagnostics.push(warning('PACKAGE_TREE_RECOMMENDED_MISSING', `${unpackedDir}/${path}`, '推荐运行时文件缺失。'));
  }

  const forbiddenHits = [];
  for (const path of walked.paths) {
    const hit = forbiddenPathFinding(path, 'package-tree');
    if (hit) {
      forbiddenHits.push(hit.path);
      diagnostics.push(error('PACKAGE_TREE_FORBIDDEN', `${unpackedDir}/${hit.path}`, hit.message));
    }
  }

  const optionalNotInstalled = optionalNotInstalledPackageNames(root, lock, diagnostics);
  const optionalNotInstalledPresent = [];
  const asarRelative = 'resources/app.asar';
  let asarEntryCount = null;
  if (actual.has(asarRelative)) {
    const asarAbsolute = resolveWithinRoot(root, join(unpackedDir, asarRelative));
    try {
      const entries = listAsarEntries(asarAbsolute);
      asarEntryCount = entries.length;
      for (const entry of entries) {
        const normalizedEntry = normalize(entry);
        const hit = forbiddenPathFinding(normalizedEntry, 'package-tree-asar');
        if (hit) {
          diagnostics.push(error('PACKAGE_TREE_ASAR_FORBIDDEN', `app.asar:${hit.path}`, hit.message));
        }
        for (const packageName of optionalNotInstalled) {
          if (normalizedEntry === `node_modules/${packageName}`
            || normalizedEntry.startsWith(`node_modules/${packageName}/`)) {
            optionalNotInstalledPresent.push(packageName);
          }
        }
      }
      if (optionalNotInstalledPresent.length > 0) {
        diagnostics.push(error(
          'PACKAGE_TREE_OPTIONAL_PRESENT',
          'app.asar',
          `可选未安装平台包被误打包：${[...new Set(optionalNotInstalledPresent)].sort(compareText).join(', ')}。`
        ));
      }
    } catch (asarError) {
      diagnostics.push(error(
        'PACKAGE_TREE_ASAR_UNREADABLE',
        asarRelative,
        `无法读取 app.asar 内容清单：${asarError instanceof Error ? asarError.message : String(asarError)}。`
      ));
    }
  }

  const errors = diagnostics.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'passed' : 'failed',
    unpackedDir,
    fileCount: walked.paths.length,
    byteCount: walked.byteCount,
    asarEntryCount,
    missingRequired,
    missingRecommended,
    forbiddenHits,
    optionalNotInstalledPresent: [...new Set(optionalNotInstalledPresent)].sort(compareText),
    diagnostics
  };
}

/**
 * Build the installer compliance record: NSIS artifact hash/size, the source
 * build manifest fingerprint it was produced from, and the optional
 * not-installed package count that the package tree scan must honestly record.
 */
export async function createInstallerComplianceManifest({
  root,
  installerRelativePath,
  sourceManifestRelativePath = SOURCE_MANIFEST_RELATIVE_PATH
}) {
  const diagnostics = [];
  let installer = null;
  const installerAbsolute = resolveWithinRoot(root, installerRelativePath);
  if (!installerAbsolute || !existsSync(installerAbsolute)) {
    diagnostics.push(error('INSTALLER_MISSING', installerRelativePath, '缺少 NSIS 安装包；先构建 NSIS。'));
  } else {
    const stat = lstatSync(installerAbsolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      diagnostics.push(error('INSTALLER_NOT_REGULAR_FILE', installerRelativePath, 'NSIS 安装包必须是普通文件。'));
    } else {
      installer = {
        fileName: basename(installerRelativePath),
        size: stat.size,
        sha256: await sha256File(installerAbsolute)
      };
    }
  }

  let sourceManifest = null;
  const sourceManifestAbsolute = resolveWithinRoot(root, sourceManifestRelativePath);
  if (!sourceManifestAbsolute || !existsSync(sourceManifestAbsolute)) {
    diagnostics.push(error('INSTALLER_SOURCE_MANIFEST_MISSING', sourceManifestRelativePath, '缺少 source release manifest；先运行 npm run release:manifest。'));
  } else {
    let text;
    try {
      text = readFileSync(sourceManifestAbsolute, 'utf8');
    } catch {
      diagnostics.push(error('INSTALLER_SOURCE_MANIFEST_UNREADABLE', sourceManifestRelativePath, '无法读取 source release manifest。'));
    }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text);
        sourceManifest = {
          path: sourceManifestRelativePath,
          sha256: sha256Text(text),
          artifactFingerprint: parsed?.artifacts?.aggregateSha256 ?? null
        };
      } catch {
        diagnostics.push(error('INSTALLER_SOURCE_MANIFEST_INVALID', sourceManifestRelativePath, 'source release manifest 不是合法 JSON。'));
      }
    }
  }

  let lock = null;
  try {
    lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  } catch {
    diagnostics.push(error('PACKAGE_LOCK_INVALID', 'package-lock.json', '无法解析 package-lock.json。'));
  }
  const optionalNotInstalled = lock
    ? optionalNotInstalledPackageNames(root, lock, diagnostics)
    : [];

  return {
    schemaVersion: 1,
    authority: 'partial',
    scope: 'unsigned-win-x64-nsis-installer',
    installer,
    sourceManifest,
    optionalNotInstalledCount: optionalNotInstalled.length,
    diagnostics: diagnostics.map(({ severity, code, path, message }) => ({ severity, code, path, message }))
  };
}

/**
 * Verify the on-disk installer manifest (if any) still matches the current NSIS
 * artifact and the current source build manifest. A missing installer manifest
 * is only a structured warning so existing unpacked artifacts do not fail the
 * regression; once recorded, the hash and fingerprint link is enforced.
 */
export async function auditInstallerCompliance({ root, installerRelativePath }) {
  const expected = await createInstallerComplianceManifest({ root, installerRelativePath });
  const diagnostics = [...expected.diagnostics];
  const manifestPath = resolve(root, INSTALLER_MANIFEST_RELATIVE_PATH);
  let actual = null;
  let actualText = '';
  if (!existsSync(manifestPath)) {
    diagnostics.push(warning(
      'INSTALLER_MANIFEST_MISSING',
      INSTALLER_MANIFEST_RELATIVE_PATH,
      '缺少 installer compliance manifest；运行 release:installer:manifest 记录 NSIS 安装包 hash。'
    ));
  } else {
    try {
      actualText = readFileSync(manifestPath, 'utf8');
      actual = JSON.parse(actualText);
    } catch {
      diagnostics.push(error('INSTALLER_MANIFEST_INVALID', INSTALLER_MANIFEST_RELATIVE_PATH, 'installer compliance manifest 不是合法 JSON。'));
    }
    if (actual && expected.installer) {
      const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
      if (actualText !== expectedText) {
        diagnostics.push(error(
          'INSTALLER_MANIFEST_STALE',
          INSTALLER_MANIFEST_RELATIVE_PATH,
          'installer compliance manifest 与当前 NSIS 安装包或 source build manifest 不一致。'
        ));
      }
    }
  }
  const errors = diagnostics.filter((item) => item.severity === 'error');
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'passed' : 'failed',
    expected,
    actual,
    installerManifestSha256: actualText ? sha256Text(actualText) : null,
    diagnostics
  };
}

function walkPackageTreeFiles(root, absoluteDir, diagnostics) {
  const paths = [];
  let byteCount = 0;
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name))) {
      const absolute = join(directory, entry.name);
      const relativePath = normalize(prefix ? `${prefix}/${entry.name}` : entry.name);
      const relToRoot = normalize(relative(root, absolute));
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        diagnostics.push(error('PACKAGE_TREE_SYMLINK_FORBIDDEN', relToRoot, 'unpacked 产物不得包含 symlink/junction。'));
        continue;
      }
      if (stat.isDirectory()) {
        walk(absolute, relativePath);
      } else if (stat.isFile()) {
        paths.push(relativePath);
        byteCount += stat.size;
      }
    }
  };
  walk(absoluteDir, '');
  return { paths, byteCount };
}

function optionalNotInstalledPackageNames(root, lock, diagnostics) {
  const names = [];
  const packages = isRecord(lock) && isRecord(lock.packages) ? lock.packages : {};
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (!isRecord(metadata) || metadata.dev === true || metadata.link === true) continue;
    if (!lockPath.includes('node_modules/')) continue;
    const installed = existsSync(resolve(root, lockPath));
    if (metadata.optional === true && !installed) {
      names.push(packageNameFromLockPath(lockPath));
    }
  }
  return [...new Set(names)].sort(compareText);
}
