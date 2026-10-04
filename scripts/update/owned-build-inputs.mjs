/** Read-only source, packaging-input, and tool binding for owned installer A/B. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentProductionBuildFresh } from '../agent-production-build-lib.mjs';
import { assertBridgeProductionBuildFresh } from '../bridge-production-build.mjs';
import { runProcess, processSucceeded } from '../subprocess-control.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

export const OWNED_BUILD_INPUT_HASH_FIELDS = Object.freeze([
  'trackedDiffSha256', 'agentSourceSha256', 'agentOutputSha256', 'agentManifestSha256',
  'bridgeSourceSha256', 'bridgeExecutableSha256', 'bridgeNativeLibrarySha256', 'bridgeHelperSha256', 'bridgeReceiptSha256',
  'packagingConfigSha256', 'buildResourcesSha256', 'extraResourcesSha256', 'desktopPackageSha256', 'lockfileSha256',
  'prepareEntrypointSha256', 'bindingHelperSha256', 'builderCliSha256', 'builderPackageSha256',
  'builderFileMatcherSha256', 'builderFilterSha256', 'asarModuleSha256', 'nodeExecutableSha256'
]);

export const OWNED_BUILD_TOOL_HASH_FIELDS = Object.freeze([
  'builderCliSha256', 'builderPackageSha256', 'builderFileMatcherSha256', 'builderFilterSha256',
  'asarModuleSha256', 'nodeExecutableSha256'
]);

export async function regularOwnedFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `A bound input must be a regular file: ${path}`);
  return readFile(path);
}

const hashFile = async path => hash(await regularOwnedFile(path));

function inside(root, path) {
  const value = relative(root, path);
  return value !== '' && value !== '..' && !value.startsWith('..\\') && !value.startsWith('../') && !isAbsolute(value);
}

async function assertUnlinkedPath(path, repositoryRoot) {
  const root = resolve(repositoryRoot), target = resolve(path);
  if (!inside(root, target)) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `A packaged input escaped this checkout: ${target}`);
  for (let current = target;; current = dirname(current)) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `A selected packaging root cannot be linked: ${current}`);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `A packaging root escaped this checkout: ${target}`);
  }
  if (resolve(await realpath(target)) !== target) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `A selected packaging root changed identity: ${target}`);
}

/** Match the builder's file filter before traversing or rejecting descendants. */
export async function captureOwnedFiles(root, repositoryRoot, filter) {
  const rows = [];
  const visit = async path => {
    const stat = await lstat(path);
    if (filter && !filter(path, stat)) return;
    const label = relative(repositoryRoot, path).replaceAll('\\', '/') || '.';
    if (stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `Selected packaging inputs cannot contain links: ${label}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) {
      const bytes = await regularOwnedFile(path);
      rows.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: hash(bytes), bytes: bytes.length });
    } else throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `Selected packaging inputs must be regular files/directories: ${label}`);
  };
  await visit(root);
  return rows;
}

/** Resolve only the pinned builder and its exact filter/ASAR implementation. */
export async function resolveOwnedInstallerTools(repositoryRoot) {
  const root = resolve(repositoryRoot), toolsRoot = join(root, '.local-validation', 'update-tools');
  const toolsRequire = createRequire(join(toolsRoot, 'package.json'));
  let builderCli, builderPackagePath, asarModulePath;
  try {
    builderCli = resolve(toolsRequire.resolve('electron-builder/cli.js'));
    builderPackagePath = resolve(toolsRequire.resolve('electron-builder/package.json'));
    asarModulePath = resolve(toolsRequire.resolve('@electron/asar'));
  } catch (error) { throw fail('UPDATE_PREPARE_BUILDER_INVALID', `Pinned electron-builder/@electron/asar tools are unavailable: ${error.message}`); }
  const builderPackage = JSON.parse((await regularOwnedFile(builderPackagePath)).toString('utf8'));
  if (builderPackage.name !== 'electron-builder' || builderPackage.version !== '26.16.1'
    || builderCli !== join(dirname(builderPackagePath), 'cli.js')) {
    throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Only the pinned electron-builder 26.16.1 CLI is supported.');
  }
  const builderRequire = createRequire(builderCli);
  const fileMatcherPath = resolve(builderRequire.resolve('app-builder-lib/out/fileMatcher.js'));
  const builderFilterPath = resolve(join(dirname(fileMatcherPath), 'util/filter.js'));
  const { FileMatcher } = builderRequire(fileMatcherPath);
  if (typeof FileMatcher !== 'function') throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Pinned electron-builder FileMatcher is required.');
  const nodeExecutable = resolve(process.execPath);
  return {
    builderCli, builderVersion: builderPackage.version, builderPackagePath, fileMatcherPath, builderFilterPath,
    asarModulePath, nodeExecutable, nodeVersion: process.version,
    builderCliSha256: await hashFile(builderCli), builderPackageSha256: hash(await regularOwnedFile(builderPackagePath)),
    builderFileMatcherSha256: await hashFile(fileMatcherPath), builderFilterSha256: await hashFile(builderFilterPath),
    asarModuleSha256: await hashFile(asarModulePath), nodeExecutableSha256: await hashFile(nodeExecutable)
  };
}

export async function captureOwnedBuildInputs(repositoryRoot, tools, ports = {}) {
  const root = resolve(await realpath(repositoryRoot));
  const run = ports.runProcess ?? runProcess;
  const git = async args => {
    const result = await run({ command: 'git', args, cwd: root, timeoutMs: 15000, outputLimitBytes: 16 * 1024 * 1024 });
    if (!processSucceeded(result) || result.stdoutTruncated || result.stderrTruncated) {
      throw fail('UPDATE_PREPARE_SOURCE_IDENTITY_UNAVAILABLE', `git ${args.join(' ')} did not complete safely.`);
    }
    return result.stdout.trim();
  };
  const headSha = await git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(headSha)) throw fail('UPDATE_PREPARE_HEAD_REQUIRED', 'Current checkout HEAD is unavailable.');
  const diff = await run({ command: 'git', args: ['diff', 'HEAD', '--binary'], cwd: root, timeoutMs: 15000,
    outputLimitBytes: 16 * 1024 * 1024 });
  if (!processSucceeded(diff) || diff.stdoutTruncated || diff.stderrTruncated) {
    throw fail('UPDATE_PREPARE_SOURCE_IDENTITY_UNAVAILABLE', 'Tracked source diff could not be fingerprinted completely.');
  }

  const [agent, bridge] = await Promise.all([
    (ports.assertAgentProductionBuildFresh ?? assertAgentProductionBuildFresh)(root),
    (ports.assertBridgeProductionBuildFresh ?? assertBridgeProductionBuildFresh)(root, { runtimeIdentifier: 'win-x64' })
  ]);
  const project = join(root, 'apps/desktop');
  const configPath = join(project, 'electron-builder.json'), configBytes = await regularOwnedFile(configPath);
  const config = JSON.parse(configBytes.toString('utf8'));
  const buildResourcesRoot = resolve(project, config.directories?.buildResources ?? 'build');
  await assertUnlinkedPath(buildResourcesRoot, root);
  const buildResources = await captureOwnedFiles(buildResourcesRoot, root);
  const toolRequire = createRequire(tools.builderCli);
  const matcherPath = resolve(toolRequire.resolve('app-builder-lib/out/fileMatcher.js'));
  if (matcherPath !== tools.fileMatcherPath) throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Pinned FileMatcher path changed during input capture.');
  const { FileMatcher } = toolRequire(matcherPath);
  const expand = pattern => {
    if (typeof pattern !== 'string' || pattern.includes('${')) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Unbound electron-builder resource macros are not supported.');
    return pattern;
  };
  if (config.extraResources !== undefined && !Array.isArray(config.extraResources)) {
    throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'extraResources must be an explicit array.');
  }
  if (config.win?.extraResources !== undefined && !Array.isArray(config.win.extraResources)) {
    throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'win.extraResources must be an explicit array.');
  }
  const resources = [];
  for (const resource of [...(config.extraResources ?? []), ...(config.win?.extraResources ?? [])]) {
    if (!resource || typeof resource.from !== 'string' || (resource.to !== undefined && typeof resource.to !== 'string')) {
      throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'extraResources must declare explicit string from/to paths.');
    }
    expand(resource.from); if (resource.to) expand(resource.to);
    if (resource.filter !== undefined && (!Array.isArray(resource.filter) || !resource.filter.every(value => typeof value === 'string'))) {
      throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'extraResources filters must be arrays of explicit string patterns.');
    }
    for (const pattern of resource.filter ?? []) expand(pattern);
    const path = resolve(project, resource.from);
    await assertUnlinkedPath(path, root);
    const stat = await lstat(path);
    let filter;
    if (stat.isDirectory()) {
      const matcher = new FileMatcher(path, path, expand, resource.filter);
      if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*');
      filter = matcher.createFilter();
      if (typeof filter !== 'function') throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Pinned FileMatcher did not create a filter.');
    }
    resources.push({ source: relative(root, path).replaceAll('\\', '/'), to: resource.to ?? null,
      files: await captureOwnedFiles(path, root, filter) });
  }
  const currentTools = await resolveOwnedInstallerTools(root);
  if (JSON.stringify(currentTools) !== JSON.stringify(tools)) throw fail('UPDATE_PREPARE_INPUT_CHANGED', 'Builder/tool bytes changed while capturing package inputs.');
  return {
    repositoryRoot: root, headSha: headSha.toLowerCase(), trackedDiffSha256: hash(diff.stdout),
    agentSourceSha256: agent.current.source.sha256, agentOutputSha256: agent.current.output.sha256,
    agentManifestSha256: await hashFile(agent.manifestPath), bridgeSourceSha256: bridge.current.source.sha256,
    bridgeExecutableSha256: bridge.current.executable.sha256, bridgeNativeLibrarySha256: bridge.current.nativeLibrary.sha256,
    bridgeHelperSha256: bridge.current.helper.sha256, bridgeReceiptSha256: await hashFile(bridge.manifestPath),
    packagingConfigSha256: hash(configBytes), buildResourcesSha256: hash(JSON.stringify(buildResources)),
    extraResourcesSha256: hash(JSON.stringify(resources)), desktopPackageSha256: await hashFile(join(project, 'package.json')),
    lockfileSha256: await hashFile(join(root, 'package-lock.json')),
    prepareEntrypointSha256: await hashFile(fileURLToPath(new URL('./prepare-owned-installers.mjs', import.meta.url))),
    bindingHelperSha256: await hashFile(fileURLToPath(import.meta.url)),
    builderCliSha256: currentTools.builderCliSha256, builderPackageSha256: currentTools.builderPackageSha256,
    builderFileMatcherSha256: currentTools.builderFileMatcherSha256, builderFilterSha256: currentTools.builderFilterSha256,
    asarModuleSha256: currentTools.asarModuleSha256, nodeExecutableSha256: currentTools.nodeExecutableSha256
  };
}
