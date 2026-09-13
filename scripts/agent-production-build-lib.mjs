import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, join, relative, resolve } from 'node:path';

export const AGENT_PRODUCTION_BUILD_SCHEMA_VERSION = 1;
export const AGENT_PRODUCTION_BUILD_MANIFEST = 'apps/desktop/out/agent-production-build.json';
export const AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_SCHEMA_VERSION = 1;
export const AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST = 'agent-production-snapshot.json';
export const AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_PARENT = 'output/agent-production-snapshots';

const execFileAsync = promisify(execFile);

const SOURCE_DIRECTORIES = [
  'packages/shared/src',
  'packages/core/src',
  'apps/desktop/src'
];

const SOURCE_FILES = [
  'tsconfig.base.json',
  'scripts/prepare-electron-sqlite-binding.mjs',
  'prompt/system.md',
  'package.json',
  'package-lock.json',
  'packages/shared/package.json',
  'packages/shared/tsconfig.json',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'apps/desktop/package.json',
  'apps/desktop/tsconfig.json',
  'apps/desktop/electron.vite.config.ts'
];

const OUTPUT_DIRECTORIES = [
  'apps/desktop/out/main',
  'apps/desktop/out/preload',
  'apps/desktop/out/renderer',
  // Electron's production main loads the ABI-matched SQLite binding from
  // this directory at runtime; a snapshot without it fails during the first
  // workspace.scan despite having a complete out/ tree.
  'apps/desktop/.native'
];

/**
 * These are the files that make up a runnable Electron + native Bridge
 * artifact.  Keep the paths mirrored under the snapshot root: the bundled
 * main process resolves its Bridge project by walking up from cwd/moduleDir.
 */
const SNAPSHOT_DIRECTORY_PATHS = [
  'apps/desktop/.native',
  'apps/desktop/out/main',
  'apps/desktop/out/preload',
  'apps/desktop/out/renderer',
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish'
];

const SNAPSHOT_FILE_PATHS = [
  AGENT_PRODUCTION_BUILD_MANIFEST,
  'apps/desktop/out/release-compliance.json',
  'apps/desktop/e2e/playwright/production-main.mjs',
  'scripts/map-native-timing-aggregate.mjs',
  'scripts/character-native-timing-aggregate.mjs',
  'scripts/character-main-timing-aggregate.mjs',
  'scripts/bridge-transport-timing-aggregate.mjs',
  'prompt/system.md',
  'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'
];

const OPTIONAL_SNAPSHOT_FILE_PATHS = ['mutter.md'];

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

async function walkFiles(directory) {
  const files = [];
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  };
  await visit(directory);
  return files;
}

async function assertNoSymlinks(directory) {
  const visit = async (current) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`production artifact 不能包含符号链接：${absolute}`);
      }
      if (metadata.isDirectory()) await visit(absolute);
    }
  };
  await visit(directory);
}

async function fingerprintFiles(repoRoot, paths) {
  const root = resolve(repoRoot);
  const unique = [...new Set(paths.map((file) => resolve(file)))];
  unique.sort((left, right) => portablePath(relative(root, left)).localeCompare(
    portablePath(relative(root, right)),
    'en'
  ));
  const digest = createHash('sha256');
  const entries = [];
  for (const absolute of unique) {
    const relativePath = portablePath(relative(root, absolute));
    const bytes = await readFile(absolute);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    entries.push({ path: relativePath, bytes: bytes.length, sha256 });
    digest.update(relativePath, 'utf8');
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

async function expandInputs(repoRoot, directories, files = []) {
  const expanded = files.map((file) => resolve(repoRoot, file));
  for (const directory of directories) {
    expanded.push(...await walkFiles(resolve(repoRoot, directory)));
  }
  return expanded;
}

export async function computeAgentProductionBuildFingerprint(repoRoot) {
  const [sourcePaths, outputPaths] = await Promise.all([
    expandInputs(repoRoot, SOURCE_DIRECTORIES, SOURCE_FILES),
    expandInputs(repoRoot, OUTPUT_DIRECTORIES)
  ]);
  const [source, output] = await Promise.all([
    fingerprintFiles(repoRoot, sourcePaths),
    fingerprintFiles(repoRoot, outputPaths)
  ]);
  return { source, output };
}

export async function writeAgentProductionBuildManifest(repoRoot) {
  const root = resolve(repoRoot);
  const fingerprint = await computeAgentProductionBuildFingerprint(root);
  const manifest = {
    schemaVersion: AGENT_PRODUCTION_BUILD_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: fingerprint.source,
    output: fingerprint.output
  };
  const manifestPath = resolve(root, AGENT_PRODUCTION_BUILD_MANIFEST);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifestPath, manifest };
}

function staleBuildError(message, details) {
  const error = new Error(message);
  error.code = 'AGENT_PRODUCTION_BUILD_STALE';
  error.details = details;
  return error;
}

function snapshotError(message, details) {
  const error = new Error(message);
  error.code = 'AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_STALE';
  error.details = details;
  return error;
}

function isWithin(root, candidate) {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedCandidate = resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${process.platform === 'win32' ? '\\' : '/'}`);
}

function safeSnapshotLabel(value) {
  const normalized = String(value ?? 'production')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'production';
}

async function gitValue(root, args) {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      windowsHide: true,
      maxBuffer: 16 * 1024
    });
    const value = String(result.stdout ?? '').trim();
    return value || null;
  } catch {
    return null;
  }
}

async function copySnapshotPath(root, stagingRoot, item) {
  const source = resolve(root, item.source);
  const target = resolve(stagingRoot, item.target);
  if (!isWithin(stagingRoot, target)) {
    throw new Error(`production artifact target 越界：${item.target}`);
  }
  try {
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink()) throw new Error(`source 是符号链接：${item.source}`);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: metadata.isDirectory(), force: false, errorOnExist: true });
  } catch (error) {
    if (item.optional && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) return false;
    throw error;
  }
  return true;
}

function snapshotManifestPath(snapshotRoot) {
  return resolve(snapshotRoot, AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST);
}

async function snapshotFileList(snapshotRoot) {
  const files = await walkFiles(snapshotRoot);
  return files
    .map((file) => portablePath(relative(snapshotRoot, file)))
    .filter((path) => path !== AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

async function computeSnapshotRuntimeRaceFingerprint(root) {
  const bridgePublish = 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish';
  const paths = await expandInputs(root, [bridgePublish, 'apps/desktop/.native'], [
    'apps/desktop/e2e/playwright/production-main.mjs',
    'scripts/map-native-timing-aggregate.mjs',
    'scripts/character-native-timing-aggregate.mjs',
    'scripts/character-main-timing-aggregate.mjs',
    'scripts/bridge-transport-timing-aggregate.mjs',
    'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj'
  ]);
  return fingerprintFiles(root, paths);
}

function computeArtifactId(filesHash, sourceHash, outputHash) {
  return createHash('sha256')
    .update(filesHash, 'utf8')
    .update('\0', 'utf8')
    .update(sourceHash, 'utf8')
    .update('\0', 'utf8')
    .update(outputHash, 'utf8')
    .digest('hex');
}

export async function assertAgentProductionBuildFresh(repoRoot) {
  const root = resolve(repoRoot);
  const manifestPath = resolve(root, AGENT_PRODUCTION_BUILD_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw staleBuildError(
      '缺少或无法读取 Agent 生产构建清单；请先运行 npm run build。',
      { manifestPath, cause: error instanceof Error ? error.message : String(error) }
    );
  }
  if (manifest?.schemaVersion !== AGENT_PRODUCTION_BUILD_SCHEMA_VERSION
    || typeof manifest?.source?.sha256 !== 'string'
    || typeof manifest?.output?.sha256 !== 'string') {
    throw staleBuildError('Agent 生产构建清单格式无效；请重新运行 npm run build。', { manifestPath });
  }
  const current = await computeAgentProductionBuildFingerprint(root);
  const sourceMatches = current.source.sha256 === manifest.source.sha256;
  const outputMatches = current.output.sha256 === manifest.output.sha256;
  if (!sourceMatches || !outputMatches) {
    throw staleBuildError(
      '源码、系统提示或 Electron 产物已与 Agent 生产构建清单不一致；拒绝运行可能过期的 agent:simulate。',
      {
        sourceMatches,
        outputMatches,
        manifestSourceHash: manifest.source.sha256,
        currentSourceHash: current.source.sha256,
        manifestOutputHash: manifest.output.sha256,
        currentOutputHash: current.output.sha256
      }
    );
  }
  return { manifestPath, manifest, current };
}

/**
 * Freeze the exact runnable app + Bridge used by a real Agent/MAP run.
 *
 * The live Electron output is deliberately never used as the snapshot's
 * runtime root.  A caller must first pass the normal build freshness check;
 * this function repeats it immediately before copying so a source edit or a
 * stale manifest cannot be hidden by the copy operation.
 */
export async function createAgentProductionArtifactSnapshot(repoRoot, options = {}) {
  const root = resolve(repoRoot);
  const fresh = await assertAgentProductionBuildFresh(root);
  const requiredSources = [
    ...SNAPSHOT_DIRECTORY_PATHS,
    ...SNAPSHOT_FILE_PATHS
  ];
  for (const path of requiredSources) {
    const absolute = resolve(root, path);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`production artifact source 是符号链接：${path}`);
  }
  const runtimeBefore = await computeSnapshotRuntimeRaceFingerprint(root);

  const parent = resolve(root, options.parent ?? AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_PARENT);
  await mkdir(parent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[^0-9TZ-]/g, '').replace(/Z$/, 'Z');
  const label = safeSnapshotLabel(options.label);
  const stagingRoot = await mkdtemp(join(parent, `${label}-${stamp}-`));

  try {
    for (const source of SNAPSHOT_DIRECTORY_PATHS) {
      await copySnapshotPath(root, stagingRoot, { source, target: source });
    }
    for (const source of SNAPSHOT_FILE_PATHS) {
      await copySnapshotPath(root, stagingRoot, { source, target: source });
    }
    let hasMutter = false;
    for (const source of OPTIONAL_SNAPSHOT_FILE_PATHS) {
      hasMutter = (await copySnapshotPath(root, stagingRoot, { source, target: source, optional: true })) || hasMutter;
    }
    await assertNoSymlinks(stagingRoot);

    // A build must not start halfway through the copy.  Re-read the live
    // freshness receipt and compare it with the receipt captured before the
    // copy; otherwise the snapshot could contain a valid hash manifest but a
    // mixed main/preload/renderer generation.
    const afterCopyFresh = await assertAgentProductionBuildFresh(root);
    if (afterCopyFresh.current.source.sha256 !== fresh.current.source.sha256
      || afterCopyFresh.current.output.sha256 !== fresh.current.output.sha256) {
      throw staleBuildError(
        'production artifact snapshot 捕获期间源码或 Electron 产物发生变化；已拒绝混版快照。',
        {
          beforeSourceHash: fresh.current.source.sha256,
          afterSourceHash: afterCopyFresh.current.source.sha256,
          beforeOutputHash: fresh.current.output.sha256,
          afterOutputHash: afterCopyFresh.current.output.sha256
        }
      );
    }
    const runtimeAfter = await computeSnapshotRuntimeRaceFingerprint(root);
    if (runtimeAfter.sha256 !== runtimeBefore.sha256) {
      throw staleBuildError(
        'production artifact snapshot 捕获期间 production harness 或 Bridge publish 发生变化；已拒绝混版快照。',
        {
          beforeRuntimeHash: runtimeBefore.sha256,
          afterRuntimeHash: runtimeAfter.sha256
        }
      );
    }

    const files = await snapshotFileList(stagingRoot);
    const fingerprint = await fingerprintFiles(stagingRoot, files.map((path) => resolve(stagingRoot, path)));
    const sourceHead = await gitValue(root, ['rev-parse', 'HEAD']);
    const sourceBranch = await gitValue(root, ['branch', '--show-current']);
    const artifactId = computeArtifactId(
      fingerprint.sha256,
      fresh.manifest.source.sha256,
      fresh.manifest.output.sha256
    );
    const manifest = {
      schemaVersion: AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
      artifactId,
      generatedAt: new Date().toISOString(),
      label,
      sourceRevision: sourceHead,
      sourceBranch,
      liveBuild: {
        manifest: AGENT_PRODUCTION_BUILD_MANIFEST,
        generatedAt: fresh.manifest.generatedAt ?? null,
        sourceSha256: fresh.manifest.source.sha256,
        outputSha256: fresh.manifest.output.sha256
      },
      runtime: {
        outRoot: 'apps/desktop/out',
        productionMain: 'apps/desktop/e2e/playwright/production-main.mjs',
        bridgeProject: 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj',
        bridgeExecutable: 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
        systemPrompt: 'prompt/system.md',
        mutter: hasMutter ? OPTIONAL_SNAPSHOT_FILE_PATHS[0] : null
      },
      files: fingerprint,
      immutability: {
        verification: 'sha256-content-manifest-v1',
        manifestExcludedFromFiles: true,
        liveOutputIsNotUsed: true
      }
    };
    await writeFile(snapshotManifestPath(stagingRoot), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const verified = await assertAgentProductionArtifactSnapshotFresh(stagingRoot);
    return {
      snapshotRoot: stagingRoot,
      manifestPath: snapshotManifestPath(stagingRoot),
      manifest: verified.manifest,
      liveBuild: fresh
    };
  } catch (error) {
    // A partial snapshot must never be mistaken for a runnable immutable
    // artifact.  This directory is uniquely allocated and remains outside
    // the source/out roots, so cleanup is safe and recoverable.
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch {
      // Preserve the original failure; callers still receive a structured
      // stale/build diagnostic rather than a cleanup error.
    }
    throw error;
  }
}

/** Acquire one immutable receipt, reusing an explicitly supplied root. */
export async function acquireAgentProductionArtifactSnapshot(repoRoot, options = {}) {
  const configuredRoot = options.snapshotRoot?.trim?.()
    || process.env.SF_PRODUCTION_ARTIFACT_SNAPSHOT_ROOT?.trim();
  if (configuredRoot) return assertAgentProductionArtifactSnapshotFresh(configuredRoot);
  return createAgentProductionArtifactSnapshot(repoRoot, options);
}

/** Verify every byte in a previously-created production artifact snapshot. */
export async function assertAgentProductionArtifactSnapshotFresh(snapshotRootOrManifest) {
  const supplied = resolve(snapshotRootOrManifest);
  const snapshotRoot = supplied.toLowerCase().endsWith(`\\${AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST}`.toLowerCase())
    || supplied.toLowerCase().endsWith(`/${AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST}`.toLowerCase())
    ? dirname(supplied)
    : supplied;
  const manifestPath = snapshotManifestPath(snapshotRoot);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw snapshotError('production artifact snapshot 清单缺失或不可读。', {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (manifest?.schemaVersion !== AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_SCHEMA_VERSION
    || typeof manifest?.artifactId !== 'string'
    || typeof manifest?.files?.sha256 !== 'string'
    || typeof manifest?.liveBuild?.sourceSha256 !== 'string'
    || typeof manifest?.liveBuild?.outputSha256 !== 'string'
    || !Array.isArray(manifest?.files?.entries)) {
    throw snapshotError('production artifact snapshot 清单格式无效。', { manifestPath });
  }
  const expectedArtifactId = computeArtifactId(
    manifest.files.sha256,
    manifest.liveBuild?.sourceSha256,
    manifest.liveBuild?.outputSha256
  );
  if (expectedArtifactId !== manifest.artifactId) {
    throw snapshotError('production artifact snapshot artifactId 与 receipt 内容不一致。', {
      manifestPath,
      expectedArtifactId,
      actualArtifactId: manifest.artifactId
    });
  }
  const entries = manifest.files.entries;
  const expectedPaths = entries.map((entry) => {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0
      || !isWithin(snapshotRoot, resolve(snapshotRoot, entry.path))
      || entry.path.startsWith('../') || entry.path.includes('/../')
      || entry.path === AGENT_PRODUCTION_ARTIFACT_SNAPSHOT_MANIFEST) {
      throw snapshotError('production artifact snapshot 清单包含越界或非法路径。', { entry });
    }
    return portablePath(entry.path);
  }).sort((left, right) => left.localeCompare(right, 'en'));
  try {
    await assertNoSymlinks(snapshotRoot);
  } catch (error) {
    throw snapshotError('production artifact snapshot 不能包含符号链接。', {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  let actualPaths;
  try {
    actualPaths = await snapshotFileList(snapshotRoot);
  } catch (error) {
    throw snapshotError('production artifact snapshot 文件集合不可读。', {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    throw snapshotError('production artifact snapshot 文件集合已变化。', {
      expectedPaths,
      actualPaths
    });
  }
  let current;
  try {
    current = await fingerprintFiles(
      snapshotRoot,
      expectedPaths.map((path) => resolve(snapshotRoot, path))
    );
  } catch (error) {
    throw snapshotError('production artifact snapshot 文件内容不可读。', {
      manifestPath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (current.sha256 !== manifest.files.sha256
    || current.fileCount !== manifest.files.fileCount
    || current.totalBytes !== manifest.files.totalBytes
    || current.entries.some((entry, index) => {
      const expected = entries.slice().sort((left, right) => String(left.path).localeCompare(String(right.path), 'en'))[index];
      return !expected
        || entry.path !== expected.path
        || entry.bytes !== expected.bytes
        || entry.sha256 !== expected.sha256;
    })) {
    throw snapshotError('production artifact snapshot 内容已变化，拒绝运行混版产物。', {
      manifestPath,
      expectedSha256: manifest.files.sha256,
      currentSha256: current.sha256,
      expectedFileCount: manifest.files.fileCount,
      currentFileCount: current.fileCount
    });
  }
  return { snapshotRoot, manifestPath, manifest, current };
}
