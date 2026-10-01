import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_PRODUCTION_BUILD_SCHEMA_VERSION = 2;
export const BRIDGE_PROJECT_RELATIVE_PATH = 'bridge/SoulForge.Bridge';
export const BRIDGE_PUBLISH_RELATIVE_PATH = `${BRIDGE_PROJECT_RELATIVE_PATH}/bin/Release/net10.0/win-x64/publish`;
export const BRIDGE_PUBLISH_EXECUTABLE_RELATIVE_PATH = `${BRIDGE_PUBLISH_RELATIVE_PATH}/SoulForge.Bridge.exe`;
export const BRIDGE_PRODUCTION_BUILD_RECEIPT = `${BRIDGE_PUBLISH_RELATIVE_PATH}/bridge-production-build.json`;
export const BRIDGE_EXTERNAL_BUILD_INPUTS = Object.freeze(['global.json', 'scripts/run-dotnet.mjs', 'scripts/build-first-party-hksc-native.mjs', 'scripts/dotnet-runtime-notices.mjs']);
export const BRIDGE_NATIVE_SOURCE_RELATIVE_PATH = 'bridge/native/hksc';
export const BRIDGE_PUBLISH_SCRIPT_INPUT = 'package.json#scripts.bridge:publish';

/** Keep the legacy Windows API default; Linux callers select their target explicitly. */
export function bridgeBuildTarget({ runtimeIdentifier = 'win-x64' } = {}) {
  if (!['win-x64', 'linux-x64'].includes(runtimeIdentifier)) {
    throw new Error(`Unsupported Bridge runtime: ${runtimeIdentifier}`);
  }
  const linux = runtimeIdentifier === 'linux-x64';
  const publish = `${BRIDGE_PROJECT_RELATIVE_PATH}/bin/Release/net10.0/${runtimeIdentifier}/publish`;
  const script = linux ? 'bridge:publish:linux' : 'bridge:publish';
  return {
    runtimeIdentifier, publish, script,
    executable: `${publish}/${linux ? 'SoulForge.Bridge' : 'SoulForge.Bridge.exe'}`,
    nativeLibrary: `${publish}/${linux ? 'libSoulForge.Hksc.Native.so' : 'SoulForge.Hksc.Native.dll'}`,
    receipt: `${publish}/bridge-production-build.json`,
    scriptInput: `package.json#scripts.${script}`
  };
}

const IGNORED_SOURCE_DIRECTORIES = new Set(['bin', 'obj', '.git']);
const HELPER_RELATIVE_PATH = 'scripts/bridge-production-build.mjs';
const HELPER_SOURCE_PATH = fileURLToPath(import.meta.url);

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function staleError(message, details = {}, cause) {
  const error = new Error(message);
  error.code = 'BRIDGE_PRODUCTION_BUILD_STALE';
  error.details = {
    ...details,
    ...(cause ? { cause: cause instanceof Error ? cause.message : String(cause) } : {})
  };
  return error;
}

async function walkSourceFiles(current, files = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (IGNORED_SOURCE_DIRECTORIES.has(entry.name.toLowerCase())) continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkSourceFiles(absolute, files);
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function fingerprintFiles(repoRoot, files, inlineEntries = []) {
  const root = resolve(repoRoot);
  const ordered = [
    ...files.map((absolute) => ({
      path: portablePath(relative(root, absolute)),
      read: () => readFile(absolute)
    })),
    ...inlineEntries.map(({ path, content }) => ({
      path: portablePath(path),
      read: async () => Buffer.from(content, 'utf8')
    }))
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const digest = createHash('sha256');
  const entries = [];
  for (const entry of ordered) {
    const bytes = await entry.read();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    entries.push({ path: entry.path, bytes: bytes.length, sha256 });
    digest.update(entry.path, 'utf8');
    digest.update('\0', 'utf8');
    digest.update(String(bytes.length), 'utf8');
    digest.update('\0', 'utf8');
    digest.update(bytes);
    digest.update('\0', 'utf8');
  }
  return {
    sha256: digest.digest('hex'),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries
  };
}

async function readBridgePublishScript(repoRoot, target) {
  const root = resolve(repoRoot);
  const packagePath = resolve(root, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (error) {
    throw staleError('无法读取根 package.json，拒绝生成或复用 Bridge 构建 receipt。', {
      packagePath: portablePath(relative(root, packagePath))
    }, error);
  }
  const publishScript = packageJson?.scripts?.[target.script];
  if (typeof publishScript !== 'string' || publishScript.trim().length === 0) {
    throw staleError('根 package.json 缺少有效的 scripts["bridge:publish"]。', {
      packagePath: portablePath(relative(root, packagePath)),
      input: target.scriptInput
    });
  }
  return publishScript;
}

/** Fingerprint Bridge project inputs, excluding generated output and VCS data. */
export async function computeBridgeSourceFingerprint(repoRoot, options) {
  const target = bridgeBuildTarget(options);
  const root = resolve(repoRoot);
  const sourceRoot = resolve(root, BRIDGE_PROJECT_RELATIVE_PATH);
  const files = await walkSourceFiles(sourceRoot);
  if (files.length === 0) {
    throw staleError('Bridge 源码目录为空，拒绝生成或复用构建 receipt。', {
      sourceRoot: portablePath(relative(root, sourceRoot))
    });
  }
  const nativeFiles = await walkSourceFiles(resolve(root, BRIDGE_NATIVE_SOURCE_RELATIVE_PATH));
  if (nativeFiles.length === 0) throw staleError('HKS native compiler sources are empty.');
  const externalInputs = BRIDGE_EXTERNAL_BUILD_INPUTS.map((path) => resolve(root, path));
  const publishScript = await readBridgePublishScript(root, target);
  return fingerprintFiles(root, [...files, ...nativeFiles, ...externalInputs], [{
    path: target.scriptInput,
    content: publishScript
  }]);
}

async function computeHelperFingerprint() {
  const bytes = await readFile(HELPER_SOURCE_PATH);
  return {
    path: HELPER_RELATIVE_PATH,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function fingerprintExecutable(repoRoot, target, path = target.executable) {
  const root = resolve(repoRoot);
  const executablePath = resolve(root, path);
  let metadata;
  try {
    metadata = await lstat(executablePath);
  } catch (error) {
    throw staleError('Bridge Release publish 可执行文件缺失或不可读。', {
      executablePath: portablePath(relative(root, executablePath))
    }, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw staleError('Bridge Release publish 可执行文件必须是普通文件。', {
      executablePath: portablePath(relative(root, executablePath))
    });
  }
  const bytes = await readFile(executablePath);
  return {
    path: portablePath(relative(root, executablePath)),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

function receiptPath(repoRoot, target) {
  return resolve(repoRoot, target.receipt);
}

function comparableSource(source) {
  if (!isRecord(source) || typeof source.sha256 !== 'string'
    || !Number.isInteger(source.fileCount) || !Number.isInteger(source.totalBytes)
    || !Array.isArray(source.entries)) return null;
  return {
    sha256: source.sha256,
    fileCount: source.fileCount,
    totalBytes: source.totalBytes,
    entries: source.entries.map((entry) => ({
      path: entry?.path,
      bytes: entry?.bytes,
      sha256: entry?.sha256
    }))
  };
}

function comparableExecutable(executable, target, path = target.executable) {
  if (!isRecord(executable) || executable.path !== path
    || !Number.isInteger(executable.bytes) || typeof executable.sha256 !== 'string') return null;
  return {
    path: executable.path,
    bytes: executable.bytes,
    sha256: executable.sha256
  };
}

function assertReceiptShape(receipt, manifestPath, target) {
  if (!isRecord(receipt) || receipt.schemaVersion !== BRIDGE_PRODUCTION_BUILD_SCHEMA_VERSION) {
    throw staleError('Bridge production receipt schema 无效，请重新发布 Bridge。', { manifestPath });
  }
  const excludedDirectories = Array.isArray(receipt.source?.excludedDirectories)
    ? receipt.source.excludedDirectories
    : null;
  if (receipt.source?.root !== BRIDGE_PROJECT_RELATIVE_PATH
    || !excludedDirectories
    || !excludedDirectories.every((item) => typeof item === 'string')
    || !sameJson([...excludedDirectories].sort(), [...IGNORED_SOURCE_DIRECTORIES].sort())) {
    throw staleError('Bridge production receipt 的源码范围无效，请重新发布 Bridge。', { manifestPath });
  }
  if (!isRecord(receipt.source) || !Array.isArray(receipt.source.externalInputs)
    || !sameJson(receipt.source.externalInputs, [...BRIDGE_EXTERNAL_BUILD_INPUTS])
    || receipt.source.nativeRoot !== BRIDGE_NATIVE_SOURCE_RELATIVE_PATH
    || receipt.source.publishScriptInput !== target.scriptInput) {
    throw staleError('Bridge production receipt 的外部构建输入无效，请重新发布 Bridge。', { manifestPath });
  }
  if (!isRecord(receipt.helper)
    || receipt.helper.path !== HELPER_RELATIVE_PATH
    || !Number.isInteger(receipt.helper.bytes)
    || typeof receipt.helper.sha256 !== 'string') {
    throw staleError('Bridge production receipt 的 helper 指纹无效，请重新发布 Bridge。', { manifestPath });
  }
  const source = comparableSource(receipt.source);
  const executable = comparableExecutable(receipt.executable, target);
  const nativeLibrary = comparableExecutable(receipt.nativeLibrary, target, target.nativeLibrary);
  if (!source || !executable || !nativeLibrary) {
    throw staleError('Bridge production receipt 字段无效，请重新发布 Bridge。', { manifestPath });
  }
  return { source, executable, nativeLibrary };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Write a receipt after a successful Release self-contained Bridge publish. */
export async function writeBridgeProductionBuildReceipt(repoRoot, options) {
  const target = bridgeBuildTarget(options);
  const root = resolve(repoRoot);
  const source = await computeBridgeSourceFingerprint(root, options);
  const executable = await fingerprintExecutable(root, target);
  const nativeLibrary = await fingerprintExecutable(root, target, target.nativeLibrary);
  const helper = await computeHelperFingerprint();
  const manifestPath = receiptPath(root, target);
  const receipt = {
    schemaVersion: BRIDGE_PRODUCTION_BUILD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      root: BRIDGE_PROJECT_RELATIVE_PATH,
      nativeRoot: BRIDGE_NATIVE_SOURCE_RELATIVE_PATH,
      excludedDirectories: [...IGNORED_SOURCE_DIRECTORIES].sort(),
      externalInputs: [...BRIDGE_EXTERNAL_BUILD_INPUTS],
      publishScriptInput: target.scriptInput,
      ...source
    },
    helper,
    executable,
    nativeLibrary
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { manifestPath, receipt };
}

/** Verify that the Bridge build inputs, helper rules, and published executable still match the receipt. */
export async function assertBridgeProductionBuildFresh(repoRoot, options) {
  const target = bridgeBuildTarget(options);
  const root = resolve(repoRoot);
  const manifestPath = receiptPath(root, target);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw staleError('缺少或无法读取 Bridge production receipt，请先运行 bridge:publish。', {
      manifestPath
    }, error);
  }
  const expected = assertReceiptShape(receipt, manifestPath, target);
  let currentSource;
  let currentExecutable;
  let currentHelper;
  let currentNativeLibrary;
  try {
    [currentSource, currentExecutable, currentHelper, currentNativeLibrary] = await Promise.all([
      computeBridgeSourceFingerprint(root, options),
      fingerprintExecutable(root, target),
      computeHelperFingerprint(),
      fingerprintExecutable(root, target, target.nativeLibrary)
    ]);
  } catch (error) {
    if (error?.code === 'BRIDGE_PRODUCTION_BUILD_STALE') throw error;
    throw staleError('无法读取当前 Bridge 源码或发布可执行文件。', { manifestPath }, error);
  }
  const sourceMatches = sameJson(expected.source, currentSource);
  const executableMatches = sameJson(expected.executable, currentExecutable);
  const helperMatches = sameJson(receipt.helper, currentHelper);
  const nativeLibraryMatches = sameJson(expected.nativeLibrary, currentNativeLibrary);
  if (!sourceMatches || !executableMatches || !helperMatches || !nativeLibraryMatches) {
    throw staleError('Bridge 构建输入、helper 规则或 Release publish 可执行文件已变化，拒绝复用旧构建。', {
      manifestPath,
      sourceMatches,
      executableMatches,
      helperMatches,
      nativeLibraryMatches,
      receiptSourceHash: expected.source.sha256,
      currentSourceHash: currentSource.sha256,
      receiptExecutableHash: expected.executable.sha256,
      currentExecutableHash: currentExecutable.sha256,
      receiptHelperHash: receipt.helper.sha256,
      currentHelperHash: currentHelper.sha256
    });
  }
  return {
    manifestPath,
    receipt,
    current: { source: currentSource, executable: currentExecutable, helper: currentHelper, nativeLibrary: currentNativeLibrary }
  };
}

function repoRootFromScript() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

async function runCli() {
  const args = process.argv.slice(2);
  const options = {};
  let assertFresh = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--assert-fresh') assertFresh = true;
    else if (args[i] === '--runtime' && args[i + 1]) options.runtimeIdentifier = args[++i];
    else throw new Error('用法：node scripts/bridge-production-build.mjs [--assert-fresh] [--runtime win-x64|linux-x64]');
  }
  const root = repoRootFromScript();
  if (assertFresh) {
    const result = await assertBridgeProductionBuildFresh(root, options);
    console.log(JSON.stringify({
      ok: true,
      status: 'fresh',
      receiptPath: result.manifestPath,
      sourceHash: result.current.source.sha256,
      executableHash: result.current.executable.sha256,
      helperHash: result.current.helper.sha256
    }));
    return;
  }
  const result = await writeBridgeProductionBuildReceipt(root, options);
  console.log(JSON.stringify({
    ok: true,
    status: 'written',
    receiptPath: result.manifestPath,
    sourceHash: result.receipt.source.sha256,
    executableHash: result.receipt.executable.sha256,
    helperHash: result.receipt.helper.sha256
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: error?.code ?? 'BRIDGE_PRODUCTION_BUILD_FAILED',
      message: error instanceof Error ? error.message : String(error),
      ...(error?.details ? { details: error.details } : {})
    }, null, 2));
    process.exitCode = 1;
  });
}
