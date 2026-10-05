/** Read-only binding shared by owned installer preparation and actual execution. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAgentProductionBuildFresh } from '../agent-production-build-lib.mjs';
import { assertBridgeProductionBuildFresh } from '../bridge-production-build.mjs';
import { runProcess, processSucceeded } from '../subprocess-control.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async path => hash(await regularFile(path));
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const within = (root, path) => { const value = relative(root, path); return value && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\') && !isAbsolute(value); };

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'A bound input must be a regular file.');
  return readFile(path);
}

export async function resolveOwnedInstallerTools(builderCli) {
  if (!isAbsolute(builderCli ?? '')) throw fail('UPDATE_PREPARE_BUILDER_REQUIRED', 'Use an absolute electron-builder 26.16.1 cli.js path.');
  builderCli = resolve(builderCli);
  const bytes = await regularFile(builderCli), packageBytes = await regularFile(join(dirname(builderCli), 'package.json'));
  const metadata = JSON.parse(packageBytes);
  if (metadata.name !== 'electron-builder' || metadata.version !== '26.16.1' || builderCli !== join(dirname(builderCli), 'cli.js')) {
    throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Only the pinned electron-builder 26.16.1 CLI is supported.');
  }
  const asarModulePath = createRequire(builderCli).resolve('@electron/asar');
  const asarModuleSha256 = hash(await regularFile(asarModulePath));
  return { builderCli, builderVersion: metadata.version, builderCliSha256: hash(bytes), builderPackageSha256: hash(packageBytes),
    asarModulePath, asarModuleSha256 };
}

async function filesUnder(root, repositoryRoot, filter) {
  const rows = [];
  const visit = async path => {
    const stat = await lstat(path);
    // Match before inspecting/traversing selected content, as builder-util.walk
    // does. Excluded compiler caches and Windows aliases are not package input.
    if (filter && !filter(path, stat)) return;
    const label = relative(repositoryRoot, path).replaceAll('\\', '/') || '.';
    if (stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `Packaged inputs cannot contain links: ${label}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) rows.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: await hashFile(path), bytes: stat.size });
    else throw fail('UPDATE_PREPARE_INPUT_UNSAFE', `Packaged inputs must be regular files/directories: ${label}`);
  };
  await visit(root); return rows;
}

export async function captureOwnedBuildInputs(repositoryRoot, tools) {
  const head = await runProcess({ command: 'git', args: ['rev-parse', 'HEAD'], cwd: repositoryRoot, timeoutMs: 10000 });
  if (!processSucceeded(head) || !/^[a-f0-9]{40}$/i.test(head.stdout.trim())) throw fail('UPDATE_PREPARE_HEAD_REQUIRED', 'Current HEAD could not be read.');
  const [agent, bridge] = await Promise.all([
    assertAgentProductionBuildFresh(repositoryRoot), assertBridgeProductionBuildFresh(repositoryRoot, { runtimeIdentifier: 'win-x64' })
  ]);
  const configBytes = await regularFile(join(repositoryRoot, 'apps/desktop/electron-builder.json'));
  const config = JSON.parse(configBytes), project = join(repositoryRoot, 'apps/desktop');
  const buildResourcesRoot = resolve(project, config.directories?.buildResources ?? 'build');
  if (!within(repositoryRoot, buildResourcesRoot)) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Build resources must remain within this checkout.');
  const buildResourcesSha256 = hash(JSON.stringify(await filesUnder(buildResourcesRoot, repositoryRoot)));
  const toolRequire = createRequire(tools.builderCli);
  const matcherPath = toolRequire.resolve('app-builder-lib/out/fileMatcher.js');
  const filterPath = join(dirname(matcherPath), 'util/filter.js');
  const { FileMatcher } = toolRequire(matcherPath);
  if (typeof FileMatcher !== 'function') throw fail('UPDATE_PREPARE_BUILDER_INVALID', 'Pinned electron-builder FileMatcher is required.');
  const expand = pattern => {
    if (pattern.includes('${')) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Resource macros require an explicit owned A/B binding.');
    return pattern;
  };
  const resources = [];
  for (const resource of [...(config.extraResources ?? []), ...(config.win?.extraResources ?? [])]) {
    if (typeof resource !== 'object' || typeof resource.from !== 'string') throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Extra resources require explicit source paths.');
    const path = resolve(project, resource.from);
    if (!within(repositoryRoot, path)) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Packaging resources must remain within this checkout.');
    const sourceStat = await lstat(path);
    let filter;
    // electron-builder copyFiles copies an explicit single-file source directly.
    // Directory sources use FileMatcher, including its all/ignore defaults.
    if (sourceStat.isDirectory()) {
      const matcher = new FileMatcher(path, path, expand, resource.filter);
      if (matcher.isEmpty() || matcher.containsOnlyIgnore()) matcher.prependPattern('**/*');
      filter = matcher.createFilter();
    }
    resources.push({ source: relative(repositoryRoot, path).replaceAll('\\', '/'), files: await filesUnder(path, repositoryRoot, filter) });
  }
  return { headSha: head.stdout.trim().toLowerCase(), agentSourceSha256: agent.current.source.sha256, agentOutputSha256: agent.current.output.sha256,
    agentManifestSha256: await hashFile(agent.manifestPath), bridgeSourceSha256: bridge.current.source.sha256,
    bridgeExecutableSha256: bridge.current.executable.sha256, bridgeNativeLibrarySha256: bridge.current.nativeLibrary.sha256,
    bridgeHelperSha256: bridge.current.helper.sha256, bridgeReceiptSha256: await hashFile(bridge.manifestPath),
    packagingConfigSha256: hash(configBytes), buildResourcesSha256, extraResourcesSha256: hash(JSON.stringify(resources)),
    desktopPackageSha256: await hashFile(join(project, 'package.json')), lockfileSha256: await hashFile(join(repositoryRoot, 'package-lock.json')),
    prepareEntrypointSha256: await hashFile(fileURLToPath(new URL('./prepare-owned-installers.mjs', import.meta.url))),
    bindingHelperSha256: await hashFile(fileURLToPath(import.meta.url)), builderCliSha256: await hashFile(tools.builderCli),
    builderFileMatcherSha256: await hashFile(matcherPath), builderFilterSha256: await hashFile(filterPath),
    builderPackageSha256: await hashFile(join(dirname(tools.builderCli), 'package.json')), asarModuleSha256: await hashFile(tools.asarModulePath) };
}
