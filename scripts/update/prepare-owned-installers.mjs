/** Build unsigned, same-source NSIS A/B under a fresh validation identity.
 * This entrypoint never installs/launches/uninstalls either artifact. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, lstat, realpath, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { initializeOwnedTemporaryDirectory } from '../owned-temporary-directory.mjs';
import { runProcess, processSucceeded, createProcessCancellation } from '../subprocess-control.mjs';
import { validateInstalledManifest, readInstallerVersionInfo, assertInstallerProductNames } from './installed-a-to-b.mjs';
import { captureOwnedBuildInputs, resolveOwnedInstallerTools } from './owned-build-inputs.mjs';

const repositoryRootDefault = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const within = (root, path) => { const value = relative(root, path); return value && value !== '..' && !value.startsWith('../') && !value.startsWith('..\\') && !isAbsolute(value); };
const hashFile = async path => hash(await readFile(path));

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'A bound input must be a regular file.');
  return readFile(path);
}

async function assertUnlinkedAncestors(path) {
  for (let current = resolve(path);;) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_OUTPUT_UNSAFE', 'Output ancestors must be unlinked directories.');
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

async function filesUnder(root) {
  const rows = [];
  const visit = async path => {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Packaged inputs cannot contain links.');
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) rows.push({ path: relative(root, path).replaceAll('\\', '/'), sha256: await hashFile(path), bytes: stat.size });
    else throw fail('UPDATE_PREPARE_INPUT_UNSAFE', 'Packaged inputs must be regular files/directories.');
  };
  await visit(root); return rows;
}

export async function inspectOwnedPackage(legRoot, identity, version, tools) {
  const asar = createRequire(import.meta.url)(tools.asarModulePath);
  const resourcesRoot = join(legRoot, 'win-unpacked/resources'), asarPath = join(resourcesRoot, 'app.asar');
  await regularFile(asarPath);
  assert.ok(within(legRoot, await realpath(asarPath)), 'packaged ASAR must remain within the owned output');
  const rows = [];
  let packageMetadata;
  for (const name of asar.listPackage(asarPath).sort()) {
    const path = name.replaceAll('\\', '/').replace(/^\/+/, '');
    if (!path || path.split('/').includes('..') || path.includes('\0')) throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'Invalid ASAR entry identity.');
    // The official ASAR library uses host path separators for nested lookups.
    const nativePath = path.split('/').join(sep);
    const stat = asar.statFile(asarPath, nativePath, false);
    if (stat.files) continue;
    if (stat.link) throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'ASAR links cannot establish identical payloads.');
    const bytes = asar.extractFile(asarPath, nativePath);
    if (path === 'package.json') {
      packageMetadata = JSON.parse(bytes.toString('utf8'));
      const { version: _version, ...unchanged } = packageMetadata;
      rows.push({ path, sha256: hash(JSON.stringify(unchanged)) });
    } else rows.push({ path, sha256: hash(bytes) });
  }
  if (!packageMetadata || !rows.some(row => row.path === 'out/main/index.js') || !rows.some(row => row.path.startsWith('out/preload/'))
    || !rows.some(row => row.path === 'out/renderer/index.html')) throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'Packaged production main/preload/renderer are required.');
  if (packageMetadata.name !== identity.packageName || packageMetadata.productName !== identity.productName || packageMetadata.version !== version) {
    throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'Packaged ASAR identity/version differs from the approved config.');
  }
  for (const row of await filesUnder(resourcesRoot)) if (row.path !== 'app.asar' && !row.path.startsWith('app.asar.unpacked/')) rows.push({ path: `resources/${row.path}`, sha256: row.sha256 });
  return { packageMetadata, payloadSha256: hash(JSON.stringify(rows)), fileCount: rows.length };
}

export async function prepareOwnedInstallers(options, ports = {}) {
  const platform = ports.platform ?? process.platform;
  if (platform !== 'win32' || process.arch !== 'x64') throw fail('UPDATE_PREPARE_WINDOWS_REQUIRED', 'Build actual Windows x64 NSIS A/B on Windows x64.');
  if (!isAbsolute(options.outputRoot ?? '')) throw fail('UPDATE_PREPARE_OUTPUT_REQUIRED', 'A fresh absolute --output-root is required.');
  const repositoryRoot = resolve(options.repositoryRoot ?? repositoryRootDefault), outputRoot = resolve(options.outputRoot);
  try { await lstat(outputRoot); throw fail('UPDATE_PREPARE_OUTPUT_EXISTS', 'Existing output is preserved; select a new owned root.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await assertUnlinkedAncestors(dirname(outputRoot));
  const tools = await resolveOwnedInstallerTools(options.builderCli);
  const capture = ports.captureBuildState ?? captureOwnedBuildInputs;
  const before = await capture(repositoryRoot, tools);
  if (!/^[a-f0-9]{40}$/i.test(before.headSha ?? '')) throw fail('UPDATE_PREPARE_HEAD_REQUIRED', 'Current HEAD must bind the build.');
  const project = join(repositoryRoot, 'apps/desktop');
  const base = JSON.parse(await regularFile(join(project, 'electron-builder.json')));
  const packageMetadata = JSON.parse(await regularFile(join(project, 'package.json'))), parsedVersion = semver.parse(packageMetadata.version);
  if (!parsedVersion) throw fail('UPDATE_PREPARE_VERSION_INVALID', 'Desktop package version must be valid semver.');
  const baseVersion = `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}`;
  const id = randomUUID().replaceAll('-', ''), suffix = id.slice(0, 12);
  const identity = { appId: `com.soulforge.validation.${id}`, productName: `SoulForge Validation ${suffix}`, shortcutName: `SoulForge Validation ${suffix}`,
    executableName: `SoulForgeValidation-${suffix}`, packageName: `soulforge-validation-${suffix}` };
  const timeoutMs = options.timeoutMs ?? 25 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60 * 60_000) throw fail('UPDATE_PREPARE_TIMEOUT_INVALID', 'Timeout must be 100..3600000 milliseconds per leg.');
  await mkdir(outputRoot); // No reuse, removal, or replacement of pre-existing output.
  const owner = await initializeOwnedTemporaryDirectory('update-installers', outputRoot), cancellation = createProcessCancellation();
  const configs = {}, artifacts = {}, payloads = {}, commands = [];
  const sameInputs = async () => {
    const after = await capture(repositoryRoot, tools);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw fail('UPDATE_PREPARE_INPUT_CHANGED', 'HEAD/source/runtime/tool/packaging inputs changed during the build.');
  };
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_CACHE: join(outputRoot, 'cache/electron-builder'),
    electron_config_cache: join(outputRoot, 'cache/electron'), npm_config_cache: join(outputRoot, 'cache/npm') };
  // Signing authority/credentials are never needed for these unsigned artifacts.
  for (const key of Object.keys(env)) if (/^(?:WIN_)?CSC_(?:LINK|KEY_PASSWORD|NAME)$/i.test(key)) delete env[key];
  try {
    await writeFile(join(outputRoot, 'identity.json'), JSON.stringify(identity, null, 2), { flag: 'wx' });
    for (const [index, label] of ['a', 'b'].entries()) {
      await sameInputs();
      const version = `${baseVersion}-validation.${index + 1}`, legRoot = join(outputRoot, label);
      const config = { ...base, appId: identity.appId, productName: identity.productName, executableName: identity.executableName, publish: null,
        npmRebuild: false, nodeGypRebuild: false,
        directories: { ...base.directories, output: legRoot },
        extraMetadata: { ...base.extraMetadata, name: identity.packageName, productName: identity.productName, version },
        nsis: { ...base.nsis, shortcutName: identity.shortcutName, uninstallDisplayName: identity.productName, perMachine: false, allowElevation: false },
        win: { ...base.win, signAndEditExecutable: true } };
      const configPath = join(outputRoot, `config-${label}.json`), bytes = Buffer.from(JSON.stringify(config, null, 2));
      await writeFile(configPath, bytes, { flag: 'wx' }); configs[label] = { path: configPath, sha256: hash(bytes) };
      const args = [tools.builderCli, '--projectDir', project, '--config', configPath, '--win', 'nsis', '--x64', '--publish', 'never'];
      const result = await (ports.runProcess ?? runProcess)({ command: process.execPath, args, cwd: project, env, owner, signal: cancellation.signal, timeoutMs });
      await writeFile(join(outputRoot, `${label}.stdout.txt`), result.stdout ?? '', { flag: 'wx' });
      await writeFile(join(outputRoot, `${label}.stderr.txt`), result.stderr ?? '', { flag: 'wx' });
      commands.push({ argv: [process.execPath, ...args], exitCode: result.code, timedOut: result.timedOut === true, cancelled: result.cancelled === true });
      if (!processSucceeded(result)) throw fail('UPDATE_PREPARE_BUILD_FAILED', `${label.toUpperCase()} packaging failed: ${result.terminationReason ?? result.code}. Logs/output are retained.`);
      await sameInputs();
      const names = (await readdir(legRoot)).filter(name => name.toLowerCase().endsWith('.exe'));
      if (names.length !== 1) throw fail('UPDATE_PREPARE_ARTIFACT_INVALID', 'Each leg must produce exactly one installer.');
      const path = join(legRoot, names[0]);
      if (!within(outputRoot, await realpath(path))) throw fail('UPDATE_PREPARE_ARTIFACT_INVALID', 'Installer escaped its owned root.');
      artifacts[label] = { path, version, sha256: hash(await regularFile(path)) };
      payloads[label] = await (ports.inspectOwnedPackage ?? inspectOwnedPackage)(legRoot, identity, version, tools);
      const actual = payloads[label].packageMetadata;
      if (actual?.name !== identity.packageName || actual?.productName !== identity.productName || actual?.version !== version) {
        throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'Packaged ASAR identity/version differs from the approved config.');
      }
    }
    if (payloads.a.payloadSha256 !== payloads.b.payloadSha256 || payloads.a.fileCount !== payloads.b.fileCount) {
      throw fail('UPDATE_PREPARE_PAYLOAD_CHANGED', 'A/B payload differs beyond package version metadata.');
    }
    const manifest = { schemaVersion: 1, execute: options.approveExecute === true, scope: 'unsigned-owned-identity-manual-nsis-a-to-b-same-source', identity,
      ...artifacts, asarModulePath: tools.asarModulePath, asarModuleSha256: tools.asarModuleSha256, buildReceiptPath: join(outputRoot, 'build-receipt.json') };
    const binaryInfo = await (ports.readInstallerVersionInfo ?? readInstallerVersionInfo)([artifacts.a.path, artifacts.b.path]);
    assertInstallerProductNames(manifest, binaryInfo);
    for (const [index, label] of ['a', 'b'].entries()) if (binaryInfo[index].productVersion !== artifacts[label].version) {
      throw fail('UPDATE_PREPARE_PACKAGE_INVALID', 'Actual installer PE version differs from its approved version.');
    }
    await sameInputs();
    const receipt = { schemaVersion: 1, builderVersion: tools.builderVersion, sourceHead: before.headSha, identity, ...artifacts, configs,
      buildInputs: before, tools, payloads, commands, binaryInfo, generatedAt: new Date().toISOString() };
    const receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
    await writeFile(manifest.buildReceiptPath, receiptBytes, { flag: 'wx' }); manifest.buildReceiptSha256 = hash(receiptBytes);
    // Input-only validation; consent does not execute any artifact in this tool.
    await validateInstalledManifest({ ...manifest, execute: true }, { expectedHeadSha: before.headSha });
    const manifestPath = join(outputRoot, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return { status: 'built', installedExecuted: false, manifestPath, manifest };
  } catch (error) {
    await writeFile(join(outputRoot, 'failure.json'), JSON.stringify({ code: error.code ?? 'UPDATE_PREPARE_FAILED', message: error.message,
      installedExecuted: false, sourceHead: before.headSha, commands }, null, 2), { flag: 'wx' });
    throw error;
  } finally {
    cancellation.dispose();
    // Retain owned artifacts and diagnostics for the separate installed probe.
    // No cleanup of a live/uncertain writer or an unrelated output is inferred.
  }
}

const usage = 'Usage: node scripts/update/prepare-owned-installers.mjs --output-root <new-absolute-path> --builder-cli <electron-builder-26.16.1/cli.js> [--approve-execute] [--timeout-ms <100..3600000>]\nBuilds unsigned same-source A/B only. Default manifest execute:false; --approve-execute approves only the generated owned identity/hash/receipt. No installation is performed.\n';
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {}, args = process.argv.slice(2);
    let help = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--help') help = true;
      else if (arg === '--approve-execute') options.approveExecute = true;
      else if (['--output-root', '--builder-cli', '--timeout-ms'].includes(arg)) {
        const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(usage);
        const key = arg === '--output-root' ? 'outputRoot' : arg === '--builder-cli' ? 'builderCli' : 'timeoutMs';
        if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: ${arg}`);
        options[key] = key === 'timeoutMs' ? Number(value) : value;
      } else throw new Error(`Unknown option: ${arg}\n${usage}`);
    }
    if (help) process.stdout.write(usage);
    else {
      if (!options.outputRoot || !options.builderCli) throw new Error(usage);
      const result = await prepareOwnedInstallers(options);
      process.stdout.write(JSON.stringify({ status: result.status, installedExecuted: false, manifestPath: result.manifestPath,
        execute: result.manifest.execute, source: result.manifest.buildReceiptPath }) + '\n');
    }
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
