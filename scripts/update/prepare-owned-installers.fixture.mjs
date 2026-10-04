import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../subprocess-control.mjs';
import { writeAgentProductionBuildManifest } from '../agent-production-build-lib.mjs';
import { BRIDGE_EXTERNAL_BUILD_INPUTS, writeBridgeProductionBuildReceipt } from '../bridge-production-build.mjs';
import { captureOwnedBuildInputs, resolveOwnedInstallerTools } from './owned-build-inputs.mjs';
import { inspectOwnedPackage, prepareOwnedInstallers } from './prepare-owned-installers.mjs';
import { validateInstalledManifest } from './installed-a-to-b.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireOk = result => { assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
async function withoutGithubEnv(run) {
  const previous = process.env.GITHUB_ENV;
  delete process.env.GITHUB_ENV;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.GITHUB_ENV; else process.env.GITHUB_ENV = previous; }
}

const sourceFiles = [
  'tsconfig.base.json', 'scripts/prepare-electron-sqlite-binding.mjs', 'prompt/system.md', 'package.json', 'package-lock.json',
  'packages/shared/package.json', 'packages/shared/tsconfig.json', 'packages/shared/src/index.ts',
  'packages/core/package.json', 'packages/core/tsconfig.json', 'packages/core/src/index.ts',
  'packages/agent/package.json', 'packages/agent/src/index.mjs', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json',
  'apps/desktop/electron.vite.config.ts', 'apps/desktop/src/main/index.ts', 'apps/desktop/.native/better_sqlite3.node',
  'apps/desktop/.native/better_sqlite3.json', 'apps/desktop/out/main/index.js', 'apps/desktop/out/preload/index.cjs',
  'apps/desktop/out/renderer/index.html', 'bridge/SoulForge.Bridge/Program.cs', 'bridge/SoulForge.Bridge/SoulForge.Bridge.csproj',
  'bridge/native/hksc/compiler.c', 'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe',
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Hksc.Native.dll',
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/runtime-notices/LICENSE.txt',
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/runtime-notices/THIRD-PARTY-NOTICES.txt',
  'bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/runtime-notices/runtime-notices.json',
  ...BRIDGE_EXTERNAL_BUILD_INPUTS
];

function fakeFileMatcherSource() {
  return `const path=require('node:path');
function matches(pattern,name,stat){
  const value=pattern.replaceAll('\\\\','/');
  if(value==='**/*'||value==='**')return true;
  if(value.endsWith('/**/*')){const base=value.slice(0,-5);return name===base||name.startsWith(base+'/');}
  if(value.endsWith('/**')){const base=value.slice(0,-3);return name===base||name.startsWith(base+'/');}
  if(value===name)return true;
  return stat.isDirectory()&&value.startsWith(name+'/');
}
exports.FileMatcher=class {
  constructor(from,to,expand,patterns){this.from=from;this.patterns=patterns||[];}
  isEmpty(){return this.patterns.length===0;}
  containsOnlyIgnore(){return this.patterns.length>0&&this.patterns.every(value=>value.startsWith('!'));}
  prependPattern(value){this.patterns.unshift(value);}
  createFilter(){return (file,stat)=>{
    if(file===this.from)return true;
    const name=path.relative(this.from,file).split(path.sep).join('/');let included=false;
    for(const pattern of this.patterns){const ignore=pattern.startsWith('!'),body=ignore?pattern.slice(1):pattern;
      if(matches(body,name,stat))included=!ignore;}
    return included;
  };}
};`;
}

function fakeAsarSource() {
  return `const fs=require('node:fs'),path=require('node:path');
const read=archive=>JSON.parse(fs.readFileSync(archive,'utf8'));
const portable=name=>name.split(path.sep).join('/');
exports.listPackage=archive=>Object.keys(read(archive)).map(name=>path.sep+name.split('/').join(path.sep));
exports.statFile=(archive,name)=>Object.hasOwn(read(archive),portable(name))?{}:null;
exports.extractFile=(archive,name)=>Buffer.from(read(archive)[portable(name)]);`;
}

async function createFixture() {
  const scratchParent = join(repositoryRoot, 'node_modules/.cache/update-installer-input-fixtures');
  await mkdir(scratchParent, { recursive: true });
  const scratch = await mkdtemp(join(scratchParent, 'case-'));
  const repo = join(scratch, 'repo');
  const seed = async (path, content = `fixture:${path}`) => {
    const target = join(repo, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
  };
  for (const path of sourceFiles) await seed(path);
  await seed('.gitignore', '.local-validation/\napps/desktop/out/\nbridge/SoulForge.Bridge/bin/\n');
  await seed('package.json', JSON.stringify({ scripts: { 'bridge:publish': 'node fixture bridge publish' } }));
  await seed('package-lock.json', JSON.stringify({ name: 'soulforge-fixture', lockfileVersion: 3 }));
  await seed('apps/desktop/package.json', JSON.stringify({ name: '@soulforge/desktop', version: '0.9.2' }));
  const baseConfig = {
    appId: 'com.soulforge.app', productName: 'SoulForge', npmRebuild: false,
    directories: { output: 'release', buildResources: 'build' }, files: ['out/**/*'],
    extraResources: [
      { from: '.native', to: 'native', filter: ['better_sqlite3.node', 'better_sqlite3.json'] },
      { from: '../../prompt', to: 'prompt', filter: ['system.md'] }
    ],
    win: { target: ['nsis'], extraResources: [
      { from: '../../bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Bridge.exe', to: 'bridge/SoulForge.Bridge.exe', filter: ['SoulForge.Bridge.exe'] },
      { from: '../../bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/SoulForge.Hksc.Native.dll', to: 'bridge/SoulForge.Hksc.Native.dll', filter: ['SoulForge.Hksc.Native.dll'] },
      { from: '../../bridge/SoulForge.Bridge/bin/Release/net10.0/win-x64/publish/runtime-notices', to: 'bridge/runtime-notices',
        filter: ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt', 'runtime-notices.json'] }
    ] },
    nsis: { shortcutName: 'SoulForge', perMachine: true, allowElevation: true },
    extraMetadata: { name: 'soulforge', version: '0.9.2' }
  };
  await seed('apps/desktop/electron-builder.json', JSON.stringify(baseConfig));
  await seed('apps/desktop/build/icon.ico', 'fixture installer icon');
  await seed('prompt/owned-fixture-note.txt', 'filtered out by builder FileMatcher');

  const toolsRoot = join(repo, '.local-validation/update-tools');
  const builderRoot = join(toolsRoot, 'node_modules/electron-builder');
  const asarRoot = join(toolsRoot, 'node_modules/@electron/asar');
  const matcherRoot = join(toolsRoot, 'node_modules/app-builder-lib/out');
  await mkdir(builderRoot, { recursive: true }); await mkdir(asarRoot, { recursive: true }); await mkdir(matcherRoot, { recursive: true });
  await seed('.local-validation/update-tools/package.json', JSON.stringify({ name: 'fixture-tools' }));
  await seed('.local-validation/update-tools/node_modules/electron-builder/package.json', JSON.stringify({ name: 'electron-builder', version: '26.16.1' }));
  await seed('.local-validation/update-tools/node_modules/electron-builder/cli.js', '// fixture only; never invoked as a builder');
  await seed('.local-validation/update-tools/node_modules/@electron/asar/package.json', JSON.stringify({ name: '@electron/asar', main: 'index.cjs' }));
  await seed('.local-validation/update-tools/node_modules/@electron/asar/index.cjs', fakeAsarSource());
  await seed('.local-validation/update-tools/node_modules/app-builder-lib/package.json', JSON.stringify({ name: 'app-builder-lib', version: '26.16.1' }));
  await seed('.local-validation/update-tools/node_modules/app-builder-lib/out/fileMatcher.js', fakeFileMatcherSource());
  await seed('.local-validation/update-tools/node_modules/app-builder-lib/out/util/filter.js', '// fixture filter implementation');

  await writeAgentProductionBuildManifest(repo);
  await writeBridgeProductionBuildReceipt(repo, { runtimeIdentifier: 'win-x64' });
  const git = async (...args) => requireOk(await runProcess({ command: 'git', args: ['-C', repo, ...args], cwd: repo, timeoutMs: 15000 }));
  await git('init', '--quiet'); await git('add', '-A');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture source');

  const tools = await resolveOwnedInstallerTools(repo);
  const calls = [], configs = new Map(); let variation = null;
  const runProcessPort = async request => {
    calls.push(request);
    assert.equal(request.command, process.execPath);
    const configIndex = request.args.indexOf('--config');
    assert.notEqual(configIndex, -1);
    const config = JSON.parse(await readFile(request.args[configIndex + 1], 'utf8'));
    await mkdir(config.directories.output, { recursive: true });
    const artifactPath = join(config.directories.output, `${config.productName}-${config.extraMetadata.version}.exe`);
    const bytes = Buffer.alloc(96, calls.length); bytes.write('MZ'); await writeFile(artifactPath, bytes);
    configs.set(artifactPath, config);
    const resources = join(config.directories.output, 'win-unpacked/resources'); await mkdir(resources, { recursive: true });
    const main = variation === 'different-b-payload' && calls.length === 2 ? 'different B main payload' : 'identical main payload';
    const packageFiles = {
      'package.json': JSON.stringify({ name: config.extraMetadata.name, productName: config.productName, version: config.extraMetadata.version }),
      'out/main/index.js': main, 'out/preload/index.cjs': 'identical preload payload', 'out/renderer/index.html': 'identical renderer payload'
    };
    await writeFile(join(resources, 'app.asar'), JSON.stringify(packageFiles));
    await writeFile(join(resources, 'external-resource.dat'), 'identical packaged extra resource');
    if (variation === 'change-input-after-a' && calls.length === 1) await writeFile(join(repo, 'prompt/system.md'), 'modified during first installer leg');
    return { code: 0, stdout: 'fake owned builder; no process was launched', stderr: '', timedOut: false, cancelled: false };
  };
  const readInstallerVersionInfoPort = async paths => paths.map(path => ({ path,
    productName: configs.get(path)?.productName, productVersion: configs.get(path)?.extraMetadata.version }));
  const ports = { platform: 'win32', arch: 'x64', runProcess: runProcessPort, readInstallerVersionInfo: readInstallerVersionInfoPort };
  const options = { repositoryRoot: repo, allowOwnedInstallation: true };
  const dispose = async () => rm(scratch, { recursive: true, force: true });
  return { scratch, repo, seed, tools, calls, configs, ports, options, setVariation: value => { variation = value; }, dispose };
}

test('owned installer capture binds HEAD, fresh Agent/Bridge outputs, filtered resources, build resources, and pinned tools', async () => {
  const fixture = await createFixture();
  try {
    const before = await captureOwnedBuildInputs(fixture.repo, fixture.tools);
    assert.match(before.headSha, /^[a-f0-9]{40}$/);
    assert.equal(before.repositoryRoot, fixture.repo);
    assert.equal(before.agentSourceSha256.length, 64); assert.equal(before.agentOutputSha256.length, 64);
    assert.equal(before.bridgeSourceSha256.length, 64); assert.equal(before.bridgeExecutableSha256.length, 64);
    await fixture.seed('apps/desktop/.native/electron-rebuild/cache/header.h', 'excluded compiler cache bytes');
    assert.deepEqual(await captureOwnedBuildInputs(fixture.repo, fixture.tools), before, 'FileMatcher-excluded cache content is not an input');
    const target = join(fixture.scratch, 'outside-target'); await mkdir(target); await writeFile(join(target, 'keep.txt'), 'untouched');
    await symlink(target, join(fixture.repo, 'apps/desktop/.native/electron-rebuild/windows-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.deepEqual(await captureOwnedBuildInputs(fixture.repo, fixture.tools), before, 'an excluded Windows alias is not followed');
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'untouched');

    await fixture.seed('apps/desktop/build/icon.ico', 'changed build resource');
    const changedBuildResource = await captureOwnedBuildInputs(fixture.repo, fixture.tools);
    assert.notEqual(changedBuildResource.buildResourcesSha256, before.buildResourcesSha256);
    await fixture.seed('apps/desktop/build/icon.ico', 'fixture installer icon');
    await fixture.seed('apps/desktop/.native/better_sqlite3.node', 'changed selected native input');
    await writeAgentProductionBuildManifest(fixture.repo);
    const changedSelectedResource = await captureOwnedBuildInputs(fixture.repo, fixture.tools);
    assert.notEqual(changedSelectedResource.extraResourcesSha256, before.extraResourcesSha256);
    await fixture.seed('apps/desktop/.native/better_sqlite3.node'); await writeAgentProductionBuildManifest(fixture.repo);

    const config = JSON.parse(await readFile(join(fixture.repo, 'apps/desktop/electron-builder.json'), 'utf8'));
    config.extraResources[0].filter.push('selected-link');
    await fixture.seed('apps/desktop/electron-builder.json', JSON.stringify(config));
    await symlink(target, join(fixture.repo, 'apps/desktop/.native/selected-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => captureOwnedBuildInputs(fixture.repo, fixture.tools), /UPDATE_PREPARE_INPUT_UNSAFE.*selected-link/);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'untouched');
  } finally { await fixture.dispose(); }
});

test('owned A/B orchestration persists old and new bindings and accepts only a package.version difference', async () => {
  const fixture = await createFixture();
  try {
    const result = await withoutGithubEnv(() => prepareOwnedInstallers(fixture.options, fixture.ports));
    assert.equal(result.status, 'built'); assert.equal(fixture.calls.length, 2);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const receipt = JSON.parse(await readFile(manifest.buildReceiptPath, 'utf8'));
    assert.equal(manifest.execute, true);
    assert.match(result.manifestPath, /\.local-validation[\\/]owned-update-installers[\\/]run-/);
    assert.equal(receipt.trackedDiffSha256, receipt.buildInputs.trackedDiffSha256);
    assert.equal(receipt.productionSourceHash, receipt.buildInputs.agentSourceSha256);
    assert.equal(receipt.productionOutputHash, receipt.buildInputs.agentOutputSha256);
    assert.deepEqual(receipt.identity, manifest.identity); assert.equal(receipt.builderVersion, '26.16.1');
    assert.equal(receipt.tools.builderCliSha256, receipt.buildInputs.builderCliSha256);
    assert.equal(receipt.tools.builderFileMatcherSha256, receipt.buildInputs.builderFileMatcherSha256);
    assert.equal(receipt.tools.asarModuleSha256, manifest.asarModuleSha256);
    assert.equal(receipt.payloads.a.payloadSha256, receipt.payloads.b.payloadSha256);
    assert.equal(receipt.payloads.a.packageMetadata.version, manifest.a.version);
    assert.equal(receipt.payloads.b.packageMetadata.version, manifest.b.version);
    await validateInstalledManifest(manifest, { expectedHeadSha: receipt.sourceHead, repositoryRoot: fixture.repo });
  } finally { await fixture.dispose(); }
});

test('input mutation during an installer leg leaves failure evidence and no approved manifest', async () => {
  const fixture = await createFixture(); fixture.setVariation('change-input-after-a');
  try {
    await assert.rejects(() => withoutGithubEnv(() => prepareOwnedInstallers(fixture.options, fixture.ports)), /UPDATE_PREPARE_INPUT_CHANGED/);
    assert.equal(fixture.calls.length, 1, 'the next A/B leg must not start after its inputs change');
    const parent = join(fixture.repo, '.local-validation/owned-update-installers');
    const run = join(parent, (await readdir(parent)).find(name => name.startsWith('run-')));
    const failure = JSON.parse(await readFile(join(run, 'failure.json'), 'utf8'));
    assert.match(failure.message, /UPDATE_PREPARE_INPUT_CHANGED/);
    assert.match(await readFile(join(run, 'a.stdout.log'), 'utf8'), /fake owned builder/);
    await assert.rejects(() => readFile(join(run, 'manifest.json')), { code: 'ENOENT' });
    await assert.rejects(() => readFile(join(parent, 'current-manifest-path.txt')), { code: 'ENOENT' },
      'the current manifest pointer must not be published when the complete manifest is absent');
  } finally { await fixture.dispose(); }
});

test('non-version A/B ASAR payload differences fail with retained diagnostics and no manifest', async () => {
  const fixture = await createFixture(); fixture.setVariation('different-b-payload');
  try {
    await assert.rejects(() => withoutGithubEnv(() => prepareOwnedInstallers(fixture.options, fixture.ports)), /UPDATE_PREPARE_PAYLOAD_CHANGED/);
    assert.equal(fixture.calls.length, 2);
    const parent = join(fixture.repo, '.local-validation/owned-update-installers');
    const run = join(parent, (await readdir(parent)).find(name => name.startsWith('run-')));
    assert.match(JSON.parse(await readFile(join(run, 'failure.json'), 'utf8')).message, /UPDATE_PREPARE_PAYLOAD_CHANGED/);
    await assert.rejects(() => readFile(join(run, 'manifest.json')), { code: 'ENOENT' });
  } finally { await fixture.dispose(); }
});
