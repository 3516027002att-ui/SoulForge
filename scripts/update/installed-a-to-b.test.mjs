import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSuite } from './run-suite.mjs';
import { validateInstalledManifest } from './installed-a-to-b.mjs';
import * as installed from './installed-a-to-b.mjs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { captureOwnedBuildInputs, resolveOwnedInstallerTools } from './owned-build-inputs.mjs';
import { writeAgentProductionBuildManifest } from '../agent-production-build-lib.mjs';
import { writeBridgeProductionBuildReceipt, BRIDGE_EXTERNAL_BUILD_INPUTS } from '../bridge-production-build.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
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
  const configs = {};
  for (const label of ['a', 'b']) {
    const config = { appId: manifest.identity.appId, productName: manifest.identity.productName, executableName: manifest.identity.executableName,
      nsis: { shortcutName: manifest.identity.shortcutName, uninstallDisplayName: manifest.identity.productName },
      extraMetadata: { name: manifest.identity.packageName, productName: manifest.identity.productName, version: manifest[label].version } };
    const bytes = Buffer.from(JSON.stringify(config));
    const path = join(root, `${label}.config.json`); await writeFile(path, bytes);
    configs[label] = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, builderVersion: '26.16.1', sourceHead: 'a'.repeat(40), identity: manifest.identity, a: manifest.a, b: manifest.b, configs }));
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

test('installed probe rejects a receipt from a different HEAD before installation', async () => {
  const { root, manifest } = await manifestFixture();
  try {
    assert.equal(await validateInstalledManifest(manifest, { expectedHeadSha: 'a'.repeat(40) }), manifest);
    await assert.rejects(() => validateInstalledManifest(manifest, { expectedHeadSha: 'b'.repeat(40) }),
      /UPDATE_INSTALLED_BUILD_RECEIPT_INVALID.*current HEAD/i);
    await assert.rejects(() => validateInstalledManifest(manifest, { expectedHeadSha: '' }),
      /UPDATE_INSTALLED_BUILD_RECEIPT_INVALID/);
    if (process.platform === 'win32') {
      const manifestPath = join(root, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const probe = await installed.runInstalledProbe({ repositoryRoot, evidenceRoot: join(root, 'evidence'),
        runId: 'stale-head-fixture', headSha: 'b'.repeat(40), installedConfigPath: manifestPath });
      assert.equal(probe.status, 'blocked_environment');
      assert.equal(probe.cases[0].executed, false);
      assert.equal(probe.commands.length, 0);
      assert.match(probe.blockers.join(' '), /BUILD_RECEIPT_INVALID.*current HEAD/i);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function sourceBoundManifestFixture() {
  const fixture = await manifestFixture(), repo = join(fixture.root, 'repo');
  const seed = async (path, content = `unit fixture ${path}`) => {
    const absolute = join(repo, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, content);
  };
  for (const path of ['tsconfig.base.json', 'scripts/prepare-electron-sqlite-binding.mjs', 'prompt/system.md', 'package-lock.json',
    'packages/shared/package.json', 'packages/shared/tsconfig.json', 'packages/shared/src/index.ts', 'packages/core/package.json',
    'packages/core/tsconfig.json', 'packages/core/src/index.ts', 'packages/agent/package.json', 'packages/agent/src/index.mjs',
    'apps/desktop/tsconfig.json', 'apps/desktop/electron.vite.config.ts', 'apps/desktop/src/main/index.ts',
    'apps/desktop/.native/better_sqlite3.node', 'apps/desktop/.native/better_sqlite3.json', 'apps/desktop/out/main/index.js',
    'apps/desktop/out/preload/index.cjs', 'apps/desktop/out/renderer/index.html', 'bridge/SoulForge.Bridge/Program.cs',
    'bridge/native/hksc/compiler.c', 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
    'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Hksc.Native.dll', ...BRIDGE_EXTERNAL_BUILD_INPUTS]) await seed(path);
  await seed('package.json', JSON.stringify({ scripts: { 'bridge:publish': 'fixture bridge publish' } }));
  await seed('apps/desktop/package.json', JSON.stringify({ name: '@soulforge/desktop', version: '0.9.2' }));
  await seed('apps/desktop/electron-builder.json', JSON.stringify({ extraResources: [{ from: '../../prompt', to: 'prompt' }] }));
  await seed('apps/desktop/build/icon.ico', 'unit build resource bytes');
  await seed('prompt/owned-fixture-note.txt', 'unit extra resource bytes');
  // A detached fixture HEAD supports a real git read without committing product code.
  await mkdir(join(repo, '.git/objects'), { recursive: true }); await mkdir(join(repo, '.git/refs'), { recursive: true });
  await seed('.git/HEAD', `${'a'.repeat(40)}\n`);
  const tool = join(fixture.root, 'tools/node_modules/electron-builder'), asar = join(fixture.root, 'tools/node_modules/@electron/asar');
  await mkdir(tool, { recursive: true }); await mkdir(asar, { recursive: true });
  await writeFile(join(tool, 'package.json'), JSON.stringify({ name: 'electron-builder', version: '26.16.1' }));
  await writeFile(join(tool, 'cli.js'), '// unit fixture; never a builder execution');
  await writeFile(join(asar, 'package.json'), JSON.stringify({ name: '@electron/asar', main: 'asar.cjs' }));
  await writeFile(join(asar, 'asar.cjs'), 'exports.extractFile=()=>{throw new Error("unit archive must never execute");};');
  await writeAgentProductionBuildManifest(repo); await writeBridgeProductionBuildReceipt(repo);
  const tools = await resolveOwnedInstallerTools(join(tool, 'cli.js'));
  const inputs = await captureOwnedBuildInputs(repo, tools);
  fixture.manifest.asarModulePath = tools.asarModulePath; fixture.manifest.asarModuleSha256 = tools.asarModuleSha256;
  const receipt = JSON.parse(await readFile(fixture.manifest.buildReceiptPath));
  receipt.tools = tools; receipt.buildInputs = inputs;
  const receiptBytes = Buffer.from(JSON.stringify(receipt)); await writeFile(fixture.manifest.buildReceiptPath, receiptBytes);
  fixture.manifest.buildReceiptSha256 = createHash('sha256').update(receiptBytes).digest('hex');
  return { ...fixture, repo, seed, tools, inputs };
}

test('same HEAD cannot accept an installed manifest after actual source/runtime/packaging inputs change', async () => {
  for (const path of ['packages/core/src/index.ts', 'apps/desktop/out/main/index.js', 'apps/desktop/.native/better_sqlite3.node',
    'bridge/SoulForge.Bridge/Program.cs', 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
    'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Hksc.Native.dll', 'prompt/system.md',
    'prompt/owned-fixture-note.txt', 'apps/desktop/build/icon.ico', 'apps/desktop/electron-builder.json']) {
    const f = await sourceBoundManifestFixture();
    try {
      const context = { expectedHeadSha: f.inputs.headSha, repositoryRoot: f.repo };
      assert.equal(await validateInstalledManifest(f.manifest, context), f.manifest);
      await f.seed(path, path.endsWith('electron-builder.json')
        ? JSON.stringify({ compression: 'store', extraResources: [{ from: '../../prompt', to: 'prompt' }] })
        : 'same HEAD; actual bytes changed');
      await assert.rejects(() => validateInstalledManifest(f.manifest, context), /BUILD_RECEIPT_INVALID.*(?:BUILD_STALE|INPUT_CHANGED)/i, path);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  }
});

test('actual installed probe cannot use a legacy receipt lacking runtime and packaging input bindings', async () => {
  const f = await manifestFixture();
  try {
    await assert.rejects(() => validateInstalledManifest(f.manifest, { expectedHeadSha: 'a'.repeat(40), repositoryRoot }),
      /BUILD_RECEIPT_INVALID.*buildInputs/i);
    if (process.platform === 'win32') {
      const manifestPath = join(f.root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(f.manifest));
      const report = await installed.runInstalledProbe({ repositoryRoot, evidenceRoot: join(f.root, 'evidence'),
        runId: 'missing-build-inputs-fixture', headSha: 'a'.repeat(40), installedConfigPath: manifestPath });
      assert.equal(report.status, 'blocked_environment'); assert.equal(report.cases[0].executed, false);
      assert.equal(report.commands.length, 0); assert.match(report.blockers.join(' '), /BUILD_RECEIPT_INVALID.*buildInputs/i);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fresh replacement receipts at the same HEAD do not rebind old installers; real probe blocks before any execution', async () => {
  const f = await sourceBoundManifestFixture();
  try {
    await f.seed('apps/desktop/out/main/index.js', 'replacement runtime at same HEAD');
    await writeAgentProductionBuildManifest(f.repo); await writeBridgeProductionBuildReceipt(f.repo);
    await assert.rejects(() => validateInstalledManifest(f.manifest, { expectedHeadSha: f.inputs.headSha, repositoryRoot: f.repo }),
      /BUILD_RECEIPT_INVALID.*INPUT_CHANGED/i);
    if (process.platform === 'win32') {
      const manifestPath = join(f.root, 'manifest.json'); await writeFile(manifestPath, JSON.stringify(f.manifest));
      const report = await installed.runInstalledProbe({ repositoryRoot: f.repo, evidenceRoot: join(f.root, 'evidence'),
        runId: 'same-head-runtime-fixture', headSha: f.inputs.headSha, installedConfigPath: manifestPath });
      assert.equal(report.status, 'blocked_environment'); assert.equal(report.cases[0].executed, false);
      assert.equal(report.commands.length, 0); assert.match(report.blockers.join(' '), /BUILD_RECEIPT_INVALID.*INPUT_CHANGED/i);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
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
