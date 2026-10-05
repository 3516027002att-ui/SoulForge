import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from '../subprocess-control.mjs';
import { validateInstalledManifest } from './installed-a-to-b.mjs';
import { prepareOwnedInstallers, inspectOwnedPackage } from './prepare-owned-installers.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// The builder/PE/ASAR ports below are unit stubs. No installer is executed and
// these files cannot establish NSIS, native, signing or installed acceptance.
async function fixture() {
  const parent = join(repositoryRoot, 'node_modules/.cache/update-prepare-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'case-'));
  const project = join(root, 'repo/apps/desktop'), tool = join(root, 'tools/node_modules/electron-builder');
  const asar = join(root, 'tools/node_modules/@electron/asar');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(tool, { recursive: true }), mkdir(asar, { recursive: true })]);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: '@soulforge/desktop', version: '0.9.2' }));
  await writeFile(join(project, 'electron-builder.json'), JSON.stringify({ appId: 'com.soulforge.app', productName: 'SoulForge', npmRebuild: false,
    directories: { output: 'release', buildResources: 'build' }, files: ['out/**/*'], win: { target: ['nsis'] }, nsis: { shortcutName: 'SoulForge' } }));
  await writeFile(join(tool, 'package.json'), JSON.stringify({ name: 'electron-builder', version: '26.16.1', bin: { 'electron-builder': './cli.js' } }));
  await writeFile(join(tool, 'cli.js'), '// unit builder stub; never an NSIS executable');
  await writeFile(join(asar, 'package.json'), JSON.stringify({ name: '@electron/asar', version: '3.4.1', main: 'asar.cjs' }));
  await writeFile(join(asar, 'asar.cjs'), 'module.exports = {};');
  const calls = [], configs = new Map();
  const state = { headSha: 'a'.repeat(40), agentSourceSha256: '1'.repeat(64), agentOutputSha256: '2'.repeat(64), bridgeSourceSha256: '3'.repeat(64) };
  const deps = {
    platform: 'win32',
    captureBuildState: async () => ({ ...state }),
    runProcess: async request => {
      calls.push(request);
      const config = JSON.parse(await readFile(request.args[request.args.indexOf('--config') + 1], 'utf8'));
      await mkdir(config.directories.output);
      const path = join(config.directories.output, 'installer.exe');
      const bytes = Buffer.alloc(64, calls.length); bytes.write('MZ');
      await writeFile(path, bytes); configs.set(path, config);
      return { code: 0, stdout: 'unit builder stub', stderr: '', timedOut: false, cancelled: false };
    },
    readInstallerVersionInfo: async paths => paths.map(path => ({ path, productName: configs.get(path).productName, productVersion: configs.get(path).extraMetadata.version })),
    inspectOwnedPackage: async (_root, identity, version) => ({ payloadSha256: '4'.repeat(64), fileCount: 3,
      packageMetadata: { name: identity.packageName, productName: identity.productName, version } })
  };
  return { root, project, tool, state, calls, configs, deps,
    options: { repositoryRoot: join(root, 'repo'), outputRoot: join(root, 'owned'), builderCli: join(tool, 'cli.js') },
    dispose: () => rm(root, { recursive: true, force: true }) };
}

test('prepare binds current HEAD, two owned metadata versions, actual config/artifact hashes and default draft consent', async () => {
  const f = await fixture();
  try {
    const result = await prepareOwnedInstallers(f.options, f.deps);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    const receiptBytes = await readFile(manifest.buildReceiptPath), receipt = JSON.parse(receiptBytes);
    assert.equal(manifest.execute, false);
    assert.equal(manifest.scope, 'unsigned-owned-identity-manual-nsis-a-to-b-same-source');
    assert.equal(receipt.sourceHead, f.state.headSha);
    assert.equal(receipt.builderVersion, '26.16.1');
    assert.equal(receipt.tools.builderCli, f.options.builderCli);
    assert.equal(receipt.tools.asarModulePath, manifest.asarModulePath);
    assert.equal(receipt.tools.asarModuleSha256, manifest.asarModuleSha256);
    assert.equal(receipt.buildInputs.agentSourceSha256, f.state.agentSourceSha256);
    assert.equal(hash(receiptBytes), manifest.buildReceiptSha256);
    assert.equal(manifest.a.version, '0.9.2-validation.1'); assert.equal(manifest.b.version, '0.9.2-validation.2');
    assert.match(manifest.identity.appId, /^com\.soulforge\.validation\.[a-f0-9]{32}$/);
    assert.equal(f.calls.length, 2);
    for (const [index, label] of ['a', 'b'].entries()) {
      const call = f.calls[index], config = f.configs.get(manifest[label].path);
      assert.equal(call.command, process.execPath);
      assert.equal(call.args[0], f.options.builderCli);
      assert.deepEqual(call.args.slice(-5), ['--win', 'nsis', '--x64', '--publish', 'never']);
      assert.ok(call.owner && isAbsolute(call.owner.root));
      assert.equal(call.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
      assert.equal(config.nsis.perMachine, false); assert.equal(config.nsis.allowElevation, false);
      assert.equal(config.win.signAndEditExecutable, true);
      assert.equal(config.npmRebuild, false); assert.equal(config.nodeGypRebuild, false);
      assert.equal(config.extraMetadata.name, manifest.identity.packageName);
      assert.equal(config.executableName, manifest.identity.executableName);
      assert.equal(config.publish, null);
      assert.equal(hash(await readFile(manifest[label].path)), manifest[label].sha256);
      assert.equal(hash(await readFile(receipt.configs[label].path)), receipt.configs[label].sha256);
    }
    await assert.rejects(() => validateInstalledManifest(manifest, { expectedHeadSha: f.state.headSha }), /APPROVAL_REQUIRED/);
    assert.equal(await validateInstalledManifest({ ...manifest, execute: true }, { expectedHeadSha: f.state.headSha }) instanceof Object, true);
  } finally { await f.dispose(); }
});

test('independent generator exit retains durable artifacts and failure evidence while control scratch converges', async () => {
  const moduleUrl = pathToFileURL(join(repositoryRoot, 'scripts/update/prepare-owned-installers.mjs')).href;
  for (const failBuild of [false, true]) {
    // Real generator/ownership/exit handling in a separate process. Only the
    // existing builder/PE/ASAR unit ports are stubbed; no NSIS is built or run.
    const source = `
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { prepareOwnedInstallers } from ${JSON.stringify(moduleUrl)};
const repositoryRoot = ${JSON.stringify(repositoryRoot)};
const fixture = ${fixture.toString()};
const f = await fixture();
if (${failBuild}) f.deps.runProcess = async request => {
  f.calls.push(request);
  return { code: 1, stdout: 'partial output', stderr: 'unit failed builder', timedOut: false, cancelled: false };
};
let result, error;
try { result = await prepareOwnedInstallers(f.options, f.deps); }
catch (failure) { error = failure.code; process.exitCode = 1; }
process.stdout.write(JSON.stringify({ root: f.root, outputRoot: f.options.outputRoot,
  controlRoots: f.calls.map(call => call.owner.root), result, error }) + '\\n');
`;
    const child = await runProcess({ command: process.execPath, args: ['--input-type=module', '-e', source],
      cwd: repositoryRoot, timeoutMs: 10000 });
    assert.equal(child.code, failBuild ? 1 : 0, child.stderr);
    assert.doesNotMatch(child.stderr, /OWNED_TEMP_CLEANUP_FAILED/);
    const produced = JSON.parse(child.stdout);
    try {
      if (failBuild) {
        assert.equal(produced.error, 'UPDATE_PREPARE_BUILD_FAILED');
        assert.equal(JSON.parse(await readFile(join(produced.outputRoot, 'failure.json'), 'utf8')).code, produced.error);
        assert.equal(await readFile(join(produced.outputRoot, 'a.stderr.txt'), 'utf8'), 'unit failed builder');
        await assert.rejects(() => readFile(join(produced.outputRoot, 'manifest.json')), { code: 'ENOENT' });
      } else {
        const manifest = JSON.parse(await readFile(produced.result.manifestPath, 'utf8'));
        const receipt = JSON.parse(await readFile(manifest.buildReceiptPath, 'utf8'));
        assert.deepEqual(JSON.parse(await readFile(join(produced.outputRoot, 'identity.json'), 'utf8')), manifest.identity);
        await validateInstalledManifest({ ...manifest, execute: true }, { expectedHeadSha: receipt.sourceHead });
        for (const label of ['a', 'b']) {
          assert.equal(hash(await readFile(manifest[label].path)), manifest[label].sha256);
          assert.equal(hash(await readFile(receipt.configs[label].path)), receipt.configs[label].sha256);
          assert.match(await readFile(join(produced.outputRoot, `${label}.stdout.txt`), 'utf8'), /unit builder stub/);
        }
      }
      for (const root of produced.controlRoots) {
        assert.equal(root, join(produced.outputRoot, '.process-control'));
        await assert.rejects(() => readdir(root), { code: 'ENOENT' });
      }
    } finally { await rm(produced.root, { recursive: true, force: true }); }
  }
});

test('explicit execution approval binds only fresh generated artifacts and each build uses a new validation identity', async () => {
  const a = await fixture(), b = await fixture();
  try {
    const left = await prepareOwnedInstallers({ ...a.options, approveExecute: true }, a.deps);
    const right = await prepareOwnedInstallers({ ...b.options, approveExecute: true }, b.deps);
    assert.equal(left.manifest.execute, true); assert.equal(right.manifest.execute, true);
    assert.notEqual(left.manifest.identity.appId, right.manifest.identity.appId);
    assert.equal(left.manifest.identity.shortcutName, left.manifest.identity.productName);
    assert.equal(a.calls.length, 2); assert.equal(b.calls.length, 2);
  } finally { await a.dispose(); await b.dispose(); }
});

test('missing/relative/existing output and unsupported platform cannot write or build over unknown artifacts', async () => {
  const f = await fixture();
  try {
    for (const outputRoot of [undefined, 'relative-output', join(f.root, 'repo')]) {
      await assert.rejects(() => prepareOwnedInstallers({ ...f.options, outputRoot }, f.deps), /OUTPUT_REQUIRED|OUTPUT_EXISTS/);
    }
    await assert.rejects(() => prepareOwnedInstallers(f.options, { ...f.deps, platform: 'linux' }), /WINDOWS_REQUIRED/);
    assert.equal(f.calls.length, 0);
    assert.equal(JSON.parse(await readFile(join(f.project, 'package.json'))).name, '@soulforge/desktop');
  } finally { await f.dispose(); }
});

test('a linked output parent is rejected before any writer starts and target data is preserved', async () => {
  const f = await fixture();
  try {
    const target = join(f.root, 'private'), link = join(f.root, 'linked'); await mkdir(target);
    await writeFile(join(target, 'preserved.txt'), 'existing data');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => prepareOwnedInstallers({ ...f.options, outputRoot: join(link, 'owned') }, f.deps), /OUTPUT_UNSAFE|PARENT_INVALID/);
    assert.equal(f.calls.length, 0); assert.equal(await readFile(join(target, 'preserved.txt'), 'utf8'), 'existing data');
  } finally { await f.dispose(); }
});

test('unapproved builder version and failed source freshness cannot create an executable manifest', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.tool, 'package.json'), JSON.stringify({ name: 'electron-builder', version: '26.16.0' }));
    await assert.rejects(() => prepareOwnedInstallers(f.options, f.deps), /BUILDER_INVALID/);
    await writeFile(join(f.tool, 'package.json'), JSON.stringify({ name: 'electron-builder', version: '26.16.1' }));
    await assert.rejects(() => prepareOwnedInstallers(f.options, { ...f.deps, captureBuildState: async () => { throw new Error('AGENT_PRODUCTION_BUILD_STALE'); } }), /BUILD_STALE/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(() => readFile(join(f.options.outputRoot, 'manifest.json')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('HEAD or runtime changes during a leg fail before manifest approval, preserving diagnostics', async () => {
  for (const field of ['headSha', 'agentOutputSha256']) {
    const f = await fixture();
    try {
      const runner = f.deps.runProcess;
      await assert.rejects(() => prepareOwnedInstallers({ ...f.options, approveExecute: true }, { ...f.deps,
        runProcess: async request => { const result = await runner(request); f.state[field] = 'b'.repeat(field === 'headSha' ? 40 : 64); return result; } }), /INPUT_CHANGED/);
      assert.equal(f.calls.length, 1);
      await assert.rejects(() => readFile(join(f.options.outputRoot, 'manifest.json')), { code: 'ENOENT' });
      assert.match(await readFile(join(f.options.outputRoot, 'a.stdout.txt'), 'utf8'), /unit builder/);
    } finally { await f.dispose(); }
  }
});

test('formal binary identity, wrong metadata version and different A/B payload cannot enter a generated approved manifest', async () => {
  for (const fault of ['identity', 'version', 'payload']) {
    const f = await fixture();
    try {
      const deps = { ...f.deps };
      if (fault === 'identity') deps.readInstallerVersionInfo = async paths => paths.map(path => ({ path, productName: 'SoulForge', productVersion: '0.9.2' }));
      if (fault === 'version') deps.inspectOwnedPackage = async (_root, identity) => ({ payloadSha256: '4'.repeat(64), fileCount: 3,
        packageMetadata: { name: identity.packageName, productName: identity.productName, version: '0.0.0' } });
      if (fault === 'payload') deps.inspectOwnedPackage = async (_root, identity, version) => ({ payloadSha256: (version.endsWith('.1') ? '4' : '5').repeat(64), fileCount: 3,
        packageMetadata: { name: identity.packageName, productName: identity.productName, version } });
      await assert.rejects(() => prepareOwnedInstallers({ ...f.options, approveExecute: true }, deps), /BINARY_IDENTITY_UNSAFE|PACKAGE_INVALID|PAYLOAD_CHANGED/);
      await assert.rejects(() => readFile(join(f.options.outputRoot, 'manifest.json')), { code: 'ENOENT' });
    } finally { await f.dispose(); }
  }
});

test('failed or timed out builder retains logs and produces no approval or installed pass', async () => {
  for (const timedOut of [false, true]) {
    const f = await fixture();
    try {
      await assert.rejects(() => prepareOwnedInstallers({ ...f.options, approveExecute: true }, { ...f.deps,
        runProcess: async request => { f.calls.push(request); return { code: timedOut ? 0 : 1, stdout: 'partial', stderr: 'failed builder', timedOut, cancelled: false }; } }), /BUILD_FAILED/);
      assert.equal(f.calls.length, 1);
      assert.equal(await readFile(join(f.options.outputRoot, 'a.stderr.txt'), 'utf8'), 'failed builder');
      await assert.rejects(() => readFile(join(f.options.outputRoot, 'manifest.json')), { code: 'ENOENT' });
    } finally { await f.dispose(); }
  }
});

test('the package inspector uses native ASAR paths and compares all bytes except the package version', async () => {
  const f = await fixture();
  try {
    const asarPath = join(f.root, 'tools/node_modules/@electron/asar/asar.cjs');
    await writeFile(asarPath, `
const fs=require('node:fs'), path=require('node:path');
const read=archive=>JSON.parse(fs.readFileSync(archive,'utf8'));
const portable=name=>{if(path.sep==='\\\\'&&name.includes('/'))throw new Error('nested ASAR lookup needs native separators');return name.split(path.sep).join('/');};
exports.listPackage=archive=>Object.keys(read(archive)).map(name=>path.sep+name.split('/').join(path.sep));
exports.statFile=(archive,name)=>{if(!Object.hasOwn(read(archive),portable(name)))throw new Error('missing entry');return {};};
exports.extractFile=(archive,name)=>Buffer.from(read(archive)[portable(name)]);
`);
    const identity = { packageName: 'soulforge-validation-01234567', productName: 'SoulForge Validation 01234567' };
    const legs = [];
    for (const [index, label] of ['a', 'b'].entries()) {
      const root = join(f.root, label), resources = join(root, 'win-unpacked/resources');
      await mkdir(resources, { recursive: true });
      const version = `0.9.2-validation.${index + 1}`;
      await writeFile(join(resources, 'app.asar'), JSON.stringify({
        'package.json': JSON.stringify({ name: identity.packageName, productName: identity.productName, version }),
        'out/main/index.js': 'same main', 'out/preload/index.cjs': 'same preload', 'out/renderer/index.html': 'same renderer',
        'node_modules/@codemirror/autocomplete/dist/index.js': 'nested dependency'
      }));
      await writeFile(join(resources, 'native.node'), 'same native');
      legs.push({ root, resources, version });
    }
    const inspect = leg => inspectOwnedPackage(leg.root, identity, leg.version, { asarModulePath: asarPath });
    const a = await inspect(legs[0]), b = await inspect(legs[1]);
    assert.equal(a.fileCount, 6); assert.equal(a.payloadSha256, b.payloadSha256);
    await writeFile(join(legs[1].resources, 'native.node'), 'changed native');
    assert.notEqual((await inspect(legs[1])).payloadSha256, a.payloadSha256);
    const archive = JSON.parse(await readFile(join(legs[0].resources, 'app.asar')));
    archive['out/main/index.js'] = 'changed main';
    await writeFile(join(legs[0].resources, 'app.asar'), JSON.stringify(archive));
    assert.notEqual((await inspect(legs[0])).payloadSha256, a.payloadSha256);
  } finally { await f.dispose(); }
});

test('prepare CLI help and invalid flags cannot start packaging or silently approve execution', async () => {
  const script = join(repositoryRoot, 'scripts/update/prepare-owned-installers.mjs');
  const help = await runProcess({ command: process.execPath, args: [script, '--help'], cwd: repositoryRoot, timeoutMs: 10000 });
  assert.equal(help.code, 0); assert.match(help.stdout, /--output-root/); assert.match(help.stdout, /--approve-execute/);
  for (const args of [[], ['--approve-exectue'], ['--output-root', 'relative'], ['--help', '--approve-exectue']]) {
    const result = await runProcess({ command: process.execPath, args: [script, ...args], cwd: repositoryRoot, timeoutMs: 10000 });
    assert.notEqual(result.code, 0); assert.match(result.stderr, /Usage|Unknown|OUTPUT_REQUIRED|BUILDER_REQUIRED/);
  }
});
