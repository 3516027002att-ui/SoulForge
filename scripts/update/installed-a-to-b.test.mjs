import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from './run-suite.mjs';
import { validateInstalledManifest } from './installed-a-to-b.mjs';
import * as installed from './installed-a-to-b.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('installed suite without actual A/B artifacts is explicitly blocked and never passes', async () => {
  const base = join(repositoryRoot, 'node_modules/.cache/update-installed-tests');
  await mkdir(base, { recursive: true });
  const outputRoot = await mkdtemp(join(base, 'run-'));
  try {
    const report = await runSuite('installed', { repositoryRoot, outputRoot, installedConfigPath: '' });
    assert.equal(report.status, 'blocked_environment');
    assert.equal(report.cases[0].status, 'blocked');
    assert.equal(report.cases[0].executed, false);
    assert.match(report.blockers.join(' '), /actual.*A\/B|Windows/i);
    assert.match(report.untestedClaims.join(' '), /automatic|自动/i);
  } finally { await rm(outputRoot, { recursive: true, force: true }); }
});

async function manifestFixture() {
  const base = join(repositoryRoot, 'node_modules/.cache/update-installed-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'manifest-'));
  const a = Buffer.alloc(64, 1), b = Buffer.alloc(64, 2); a.write('MZ'); b.write('MZ');
  await writeFile(join(root, 'a.exe'), a); await writeFile(join(root, 'b.exe'), b);
  const manifest = { schemaVersion: 1, execute: true, scope: 'unsigned-owned-identity-manual-nsis-a-to-b-same-source',
    identity: { appId: 'com.soulforge.validation.0123456789abcdef', productName: 'SoulForge Validation 01234567', shortcutName: 'SoulForge Validation 01234567',
      executableName: 'SoulForgeValidation-01234567', packageName: 'soulforge-validation-01234567' },
    a: { path: join(root, 'a.exe'), version: '0.9.2-validation.1', sha256: createHash('sha256').update(a).digest('hex') },
    b: { path: join(root, 'b.exe'), version: '0.9.2-validation.2', sha256: createHash('sha256').update(b).digest('hex') } };
  const toolRoot = join(root, 'toolchain'); await mkdir(toolRoot, { recursive: true });
  const toolPaths = {
    builderCli: join(toolRoot, 'electron-builder', 'cli.js'), builderPackagePath: join(toolRoot, 'electron-builder', 'package.json'),
    fileMatcherPath: join(toolRoot, 'app-builder-lib', 'fileMatcher.js'), builderFilterPath: join(toolRoot, 'app-builder-lib', 'filter.js'),
    asarModulePath: join(toolRoot, 'asar.cjs'), nodeExecutable: process.execPath
  };
  await mkdir(join(toolRoot, 'electron-builder'), { recursive: true }); await mkdir(join(toolRoot, 'app-builder-lib'), { recursive: true });
  await writeFile(toolPaths.builderCli, 'fixture builder cli'); await writeFile(toolPaths.builderPackagePath, JSON.stringify({ name: 'electron-builder', version: '26.16.1' }));
  await writeFile(toolPaths.fileMatcherPath, 'fixture FileMatcher'); await writeFile(toolPaths.builderFilterPath, 'fixture filter');
  await writeFile(toolPaths.asarModulePath, 'fixture ASAR module');
  const tools = { ...toolPaths, builderVersion: '26.16.1', nodeVersion: process.version,
    builderCliSha256: hash(await readFile(toolPaths.builderCli)), builderPackageSha256: hash(await readFile(toolPaths.builderPackagePath)),
    builderFileMatcherSha256: hash(await readFile(toolPaths.fileMatcherPath)), builderFilterSha256: hash(await readFile(toolPaths.builderFilterPath)),
    asarModuleSha256: hash(await readFile(toolPaths.asarModulePath)), nodeExecutableSha256: 'e'.repeat(64) };
  manifest.asarModulePath = tools.asarModulePath; manifest.asarModuleSha256 = tools.asarModuleSha256;
  const configs = {};
  for (const label of ['a', 'b']) {
    const config = { appId: manifest.identity.appId, productName: manifest.identity.productName, executableName: manifest.identity.executableName,
      nsis: { shortcutName: manifest.identity.shortcutName, uninstallDisplayName: manifest.identity.productName },
      extraMetadata: { name: manifest.identity.packageName, productName: manifest.identity.productName, version: manifest[label].version } };
    const bytes = Buffer.from(JSON.stringify(config));
    const path = join(root, `${label}.config.json`); await writeFile(path, bytes);
    configs[label] = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const buildInputs = { repositoryRoot: resolve(root), headSha: 'a'.repeat(40), trackedDiffSha256: 'b'.repeat(64),
    agentSourceSha256: 'c'.repeat(64), agentOutputSha256: 'd'.repeat(64), agentManifestSha256: '1'.repeat(64),
    bridgeSourceSha256: '2'.repeat(64), bridgeExecutableSha256: '3'.repeat(64), bridgeNativeLibrarySha256: '4'.repeat(64),
    bridgeHelperSha256: '5'.repeat(64), bridgeReceiptSha256: '6'.repeat(64), packagingConfigSha256: '7'.repeat(64),
    buildResourcesSha256: '8'.repeat(64), desktopFilesSha256: 'e'.repeat(64), extraResourcesSha256: '9'.repeat(64), desktopPackageSha256: 'a'.repeat(64),
    lockfileSha256: 'b'.repeat(64), prepareEntrypointSha256: 'c'.repeat(64), bindingHelperSha256: 'd'.repeat(64),
    builderCliSha256: tools.builderCliSha256, builderPackageSha256: tools.builderPackageSha256,
    builderFileMatcherSha256: tools.builderFileMatcherSha256, builderFilterSha256: tools.builderFilterSha256,
    asarModuleSha256: tools.asarModuleSha256, nodeExecutableSha256: tools.nodeExecutableSha256 };
  const payload = (version) => ({ payloadSha256: 'f'.repeat(64), fileCount: 4,
    packageMetadata: { name: manifest.identity.packageName, productName: manifest.identity.productName, version } });
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, builderVersion: '26.16.1', sourceHead: 'a'.repeat(40),
    trackedDiffSha256: 'b'.repeat(64), productionSourceHash: 'c'.repeat(64), productionOutputHash: 'd'.repeat(64),
    identity: manifest.identity, a: manifest.a, b: manifest.b, configs, buildInputs, tools,
    payloads: { a: payload(manifest.a.version), b: payload(manifest.b.version) } }));
  manifest.buildReceiptPath = join(root, 'build-receipt.json'); manifest.buildReceiptSha256 = createHash('sha256').update(receipt).digest('hex');
  await writeFile(manifest.buildReceiptPath, receipt);
  return { root, manifest };
}

test('manifest refuses official identities, mismatched package identity and absent execution consent', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    assert.equal(await validateInstalledManifest(manifest), manifest); // validates input only; these are not NSIS artifacts and are never executed
    for (const identity of [{ ...manifest.identity, appId: 'com.soulforge.app' }, { ...manifest.identity, productName: 'SoulForge' },
      { ...manifest.identity, packageName: 'soulforge-validation-abcdef00' }]) {
      await assert.rejects(() => validateInstalledManifest({ ...manifest, identity }), /IDENTITY_UNSAFE/);
    }
    await assert.rejects(() => validateInstalledManifest({ ...manifest, execute: false }), /APPROVAL_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manifest refuses unchanged/downgrade versions and changed or reused installer bytes', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    for (const version of [manifest.a.version, '0.9.1', 'bogus']) await assert.rejects(() => validateInstalledManifest({ ...manifest, b: { ...manifest.b, version } }), /VERSION_INVALID/);
    await assert.rejects(() => validateInstalledManifest({ ...manifest, b: { ...manifest.b, sha256: '0'.repeat(64) } }), /ARTIFACT_INVALID/);
    await assert.rejects(() => validateInstalledManifest({ ...manifest, b: { ...manifest.a, version: manifest.b.version } }), /same installer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('explicit ASAR tool must have the approved hash before any installer can execute', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    await assert.rejects(() => validateInstalledManifest({ ...manifest, asarModulePath: import.meta.filename }), /TOOL_INVALID/);
    await assert.rejects(() => validateInstalledManifest({ ...manifest, asarModulePath: import.meta.filename, asarModuleSha256: '0'.repeat(64) }), /TOOL_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('approved artifact manifest must bind an actual builder receipt and matching config bytes', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    await assert.rejects(() => validateInstalledManifest({ ...manifest, buildReceiptPath: undefined }), /BUILD_RECEIPT/);
    await writeFile(join(root, 'a.config.json'), '{}');
    await assert.rejects(() => validateInstalledManifest(manifest), /BUILD_RECEIPT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy valid-looking installer receipt without build-input and tool bindings is rejected', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    const receipt = JSON.parse(await readFile(manifest.buildReceiptPath, 'utf8'));
    delete receipt.buildInputs; delete receipt.tools; delete receipt.payloads;
    const bytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(manifest.buildReceiptPath, bytes);
    manifest.buildReceiptSha256 = hash(bytes);
    await assert.rejects(() => validateInstalledManifest(manifest), /BUILD_RECEIPT.*(?:buildInputs|tools)/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build receipt requires the selected desktop output fingerprint', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    const receipt = JSON.parse(await readFile(manifest.buildReceiptPath, 'utf8'));
    delete receipt.buildInputs.desktopFilesSha256;
    const bytes = Buffer.from(JSON.stringify(receipt));
    await writeFile(manifest.buildReceiptPath, bytes);
    manifest.buildReceiptSha256 = hash(bytes);
    await assert.rejects(() => validateInstalledManifest(manifest), /BUILD_RECEIPT.*desktopFilesSha256/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed probe blocks a foreign checkout or stale supplied HEAD before any installer command', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    const manifestPath = join(root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(manifest));
    const foreign = await installed.runInstalledProbe({ repositoryRoot: root, evidenceRoot: join(root, 'foreign-evidence'),
      runId: 'foreign-checkout', headSha: 'a'.repeat(40), installedConfigPath: manifestPath }, { platform: 'win32' });
    assert.equal(foreign.status, 'blocked_environment'); assert.equal(foreign.commands.length, 0);
    assert.match(foreign.blockers.join(' '), /REPOSITORY_MISMATCH/);
    const stale = await installed.runInstalledProbe({ repositoryRoot, evidenceRoot: join(root, 'stale-head-evidence'),
      runId: 'stale-current-head', headSha: '0'.repeat(40), installedConfigPath: manifestPath }, { platform: 'win32' });
    assert.equal(stale.status, 'blocked_environment'); assert.equal(stale.commands.length, 0);
    assert.match(stale.blockers.join(' '), /HEAD_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installer acceptance refuses a receipt without actual source and production-output fingerprints', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    const baseline = JSON.parse(await readFile(manifest.buildReceiptPath, 'utf8'));
    for (const name of ['trackedDiffSha256', 'productionSourceHash', 'productionOutputHash']) {
      const receipt = { ...baseline }; delete receipt[name];
      const bytes = Buffer.from(JSON.stringify(receipt)); await writeFile(manifest.buildReceiptPath, bytes);
      await assert.rejects(() => validateInstalledManifest({ ...manifest, buildReceiptSha256: createHash('sha256').update(bytes).digest('hex') }), /BUILD_RECEIPT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registry matching includes versioned official names without including validation installations', () => {
  assert.equal(typeof installed.registryDisplayMatches, 'function');
  assert.equal(installed.registryDisplayMatches('SoulForge 0.9.2', 'SoulForge'), true);
  assert.equal(installed.registryDisplayMatches('SoulForge', 'SoulForge'), true);
  assert.equal(installed.registryDisplayMatches('SoulForge Validation 01234567', 'SoulForge'), false);
  assert.equal(installed.registryDisplayMatches('SoulForge Validation 01234567 0.9.2-validation.1', 'SoulForge Validation 01234567'), true);
});

test('the actual finally cleanup removes only its empty owned scratch and refuses a different parent', async () => {
  assert.equal(typeof installed.removeOwnedEmptyScratch, 'function');
  const base = join(repositoryRoot, 'node_modules/.cache/update-installed-tests'); await mkdir(base, { recursive: true });
  const parent = await mkdtemp(join(base, 'cleanup-')), scratch = await mkdtemp(join(parent, 'owned-'));
  try {
    await assert.rejects(() => installed.removeOwnedEmptyScratch(scratch, join(parent, 'other')), /parent|owned|outside/i);
    await installed.removeOwnedEmptyScratch(scratch, parent);
    await assert.rejects(() => import('node:fs/promises').then(fs => fs.lstat(scratch)), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('pre-execution PE guard rejects a formal or unverified installer even with owned manifest claims', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    const owned = ['a', 'b'].map(label => ({ path: manifest[label].path, productName: manifest.identity.productName }));
    installed.assertInstallerProductNames(manifest, owned);
    for (const productName of ['SoulForge', '', undefined]) {
      assert.throws(() => installed.assertInstallerProductNames(manifest, [{ ...owned[0], productName }, owned[1]]), /BINARY_IDENTITY_UNSAFE/);
    }
    assert.throws(() => installed.assertInstallerProductNames(manifest, [owned[0]]), /BINARY_IDENTITY_UNSAFE/);
    if (process.platform === 'win32') {
      // Real read-only Windows PE metadata, never an installer execution.
      const actual = await installed.readInstallerVersionInfo([process.execPath, process.execPath]);
      assert.equal(actual.length, 2); assert.ok(actual[0].productName);
      assert.throws(() => installed.assertInstallerProductNames({ ...manifest, a: { path: process.execPath }, b: { path: process.execPath } }, actual), /BINARY_IDENTITY_UNSAFE/);
      const registry = await installed.registrySnapshot('SoulForge');
      assert.ok(Array.isArray(registry));
      assert.ok(registry.every(row => /^HKEY_/.test(row.key) && installed.registryDisplayMatches(row.displayName, 'SoulForge') && row.values));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing the owned Electron application checks the captured child after dispatcher disposal', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  let disposed = false;
  const application = {
    process() { if (disposed) throw new TypeError("Cannot read properties of undefined (reading '_object')"); return child; },
    async close() { disposed = true; const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  };
  try {
    const captured = application.process();
    await installed.closeOwnedElectronApplication(application, captured);
    assert.equal(disposed, true); assert.equal(child.exitCode, 0);
    assert.throws(() => application.process(), /_object/);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});

test('owned profile binds logical identity to the physically resolved leaf under host redirection', async () => {
  const logicalRoot = resolve('owned-logical-roaming'), productName = 'SoulForge Validation abcdef12';
  const logical = join(logicalRoot, productName), physicalParent = resolve('owned-physical-roaming'), physical = join(physicalParent, productName);
  const checked = [];
  const files = { realpath: async path => path === logical ? physical : path,
    assertUnlinkedDirectory: async path => { checked.push(path); } };
  const profile = await installed.resolveOwnedProfile(logicalRoot, productName, logical, files);
  assert.equal(profile.logical, logical); assert.equal(profile.physical, physical); assert.equal(profile.parent, physicalParent);
  assert.deepEqual(checked, [logical, physicalParent]);
  await assert.rejects(() => installed.resolveOwnedProfile(logicalRoot, productName, physical, files), /owned identity/);
});

test('owned profile rejects a junction leaf and a changed physical leaf without removing their data', async () => {
  const base = join(repositoryRoot, 'node_modules/.cache/update-installed-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'profile-')), productName = 'SoulForge Validation abcdef12';
  const target = join(root, 'private'), logical = join(root, productName); await mkdir(target);
  await writeFile(join(target, 'preserved.txt'), 'owned test data');
  try {
    await symlink(target, logical, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => installed.resolveOwnedProfile(root, productName, logical), /unlinked|profile/i);
    await rm(logical, { recursive: true }); await mkdir(logical);
    const profile = await installed.resolveOwnedProfile(root, productName, logical);
    await assert.rejects(() => installed.removeOwnedProfile({ ...profile, physical: target }), /physical leaf/);
    await installed.removeOwnedProfile(profile);
    assert.equal(await import('node:fs/promises').then(fs => fs.readFile(join(target, 'preserved.txt'), 'utf8')), 'owned test data');
  } finally { await rm(root, { recursive: true, force: true }); }
});
