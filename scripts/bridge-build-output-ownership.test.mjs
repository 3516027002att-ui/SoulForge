import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const helperPath = resolve('scripts/bridge-build-output-ownership.mjs');
const runtimeIdentifier = process.platform === 'win32' ? 'win-x64' : 'linux-x64';
const matchingSdkText = `matching unknown${process.platform === 'win32' ? '\r\n' : '\n'}`;
const helperUrl = pathToFileURL(helperPath).href;
const helper = await import(helperUrl).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

async function fixture(body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sf-bridge-output-test-')));
  const project = join(root, 'Bridge.csproj');
  const bin = join(root, 'bin');
  const store = join(root, 'obj', '.soulforge-build-output-ownership');
  const output = framework => join(bin, 'Debug', framework, runtimeIdentifier);
  const declare = frameworks => writeFile(project, `<Project><PropertyGroup><TargetFrameworks>${frameworks}</TargetFrameworks></PropertyGroup></Project>`);
  const begin = framework => helper.beginBridgeBuild({ project, outputPath: output(framework), framework,
    configuration: 'Debug', runtimeIdentifier: runtimeIdentifier });
  try {
    await declare('net8.0');
    await body({ root, project, bin, store, output, declare, begin });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function put(path, bytes = 'writer output') { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, bytes); }
async function exists(path) { try { await readFile(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

async function fileSymlink(t, target, path) {
  let available = false;
  await t.test('file symlink support', async leg => {
    try { await symlink(target, path, 'file'); available = true; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      leg.skip('WINDOWS_FILE_SYMLINK_PRIVILEGE_UNAVAILABLE: this leg requires Windows file-link permission');
    }
  });
  return available;
}

test('stale cleanup deletes only unchanged recorded writer files, then only empty directories', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  assert.equal(typeof helper.completeBridgeBuild, 'function');
  await fixture(async f => {
    const lease = await f.begin('net8.0');
    const leaseText = await readFile(join(f.store, `${lease.token}.lease.json`), 'utf8');
    const leaseRecord = JSON.parse(leaseText);
    assert.match(leaseRecord.scope, /^[a-f0-9]{64}$/);
    assert.equal(leaseRecord.project, undefined);
    assert.equal(leaseText.includes(f.root), false, 'ownership metadata contains no absolute project path');
    assert.equal((await readdir(f.bin)).includes('.soulforge-build-output-ownership'), false);
    const owned = join(f.output('net8.0'), 'Bridge.dll');
    const changed = join(f.output('net8.0'), 'changed.dll');
    const unknown = join(f.output('net8.0'), 'user.dll');
    const legacy = join(f.bin, 'Release', 'net6.0', 'old.dll');
    const source = join(f.root, 'source.dll');
    const published = join(f.output('net8.0'), 'publish', 'Bridge.dll');
    await Promise.all([put(owned), put(changed), put(unknown), put(legacy), put(source), put(published)]);
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [owned, changed, source, published] });
    await writeFile(changed, 'user changed this');
    await f.declare('net10.0');
    const current = await f.begin('net10.0');
    assert.equal(await exists(owned), false);
    assert.equal(await readFile(changed, 'utf8'), 'user changed this');
    for (const file of [unknown, legacy, source, published]) assert.equal(await exists(file), true, file);
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
  await fixture(async f => {
    const lease = await f.begin('net8.0');
    const owned = join(f.output('net8.0'), 'Bridge.dll');
    await put(owned);
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [owned] });
    await f.declare('net10.0');
    const current = await f.begin('net10.0');
    assert.ok(!(await readdir(f.bin)).includes('Debug'), 'only empty output parents are removed');
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
});

test('multi-target outputs stay current and explicit non-default output paths are never adopted', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const lease = await f.begin('net8.0');
    const owned = join(f.output('net8.0'), 'Bridge.dll'); await put(owned);
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [owned] });
    await f.declare('net8.0;net10.0');
    const current = await f.begin('net10.0'); assert.equal(await exists(owned), true);
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
    await f.declare('net10.0');
    for (const outputPath of [join(f.root, 'deliverables'), join(f.bin, 'custom', 'net10.0', runtimeIdentifier)]) {
      const external = await helper.beginBridgeBuild({ project: f.project, outputPath, framework: 'net10.0',
        configuration: 'Debug', runtimeIdentifier: runtimeIdentifier });
      const sentinel = join(outputPath, 'sentinel.dll'); await put(sentinel);
      await helper.completeBridgeBuild({ project: f.project, token: external.token, fileWrites: [sentinel] });
      assert.equal(await exists(owned), true, 'non-default builds do not clean the default bin');
      assert.equal(await exists(sentinel), true);
    }
    const currentAgain = await f.begin('net10.0'); assert.equal(await exists(owned), false);
    await helper.completeBridgeBuild({ project: f.project, token: currentAgain.token, fileWrites: [] });
  });
});

test('FileWrites does not adopt unchanged pre-existing files on an incremental build', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const unowned = join(f.output('net8.0'), 'pre-existing.dll'); await put(unowned, 'user binary');
    const lease = await f.begin('net8.0');
    const written = join(f.output('net8.0'), 'new.dll'); await put(written);
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [unowned, written] });
    await f.declare('net10.0');
    const current = await f.begin('net10.0');
    assert.equal(await readFile(unowned, 'utf8'), 'user binary'); assert.equal(await exists(written), false);
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
});

test('renamed and incremental builds retain unchanged ownership omitted from their latest FileWrites', async t => {
  await fixture(async f => {
    const initial = await f.begin('net8.0');
    const oldName = join(f.output('net8.0'), 'OldName.dll');
    const changed = join(f.output('net8.0'), 'Changed.dll');
    const linked = join(f.output('net8.0'), 'Linked.dll');
    await Promise.all([put(oldName), put(changed), put(linked)]);
    await helper.completeBridgeBuild({ project: f.project, token: initial.token, fileWrites: [oldName, changed, linked] });
    await writeFile(changed, 'user changed this');
    const outside = join(f.root, 'outside.dll'); await put(outside, 'outside');
    await rm(linked); const hasFileLink = await fileSymlink(t, outside, linked);
    const unknown = join(f.output('net8.0'), 'Unowned.dll'); await put(unknown, 'unknown');

    const renamed = await f.begin('net8.0');
    const newName = join(f.output('net8.0'), 'NewName.dll'); await put(newName);
    await helper.completeBridgeBuild({ project: f.project, token: renamed.token, fileWrites: [newName] });
    const incremental = await f.begin('net8.0');
    await helper.completeBridgeBuild({ project: f.project, token: incremental.token, fileWrites: [] });

    await f.declare('net10.0');
    const current = await f.begin('net10.0');
    assert.equal(await exists(oldName), false, 'the still-present old assembly remains writer-owned');
    assert.equal(await exists(newName), false, 'an incremental build does not lose ownership');
    assert.equal(await readFile(changed, 'utf8'), 'user changed this');
    if (hasFileLink) assert.equal(await readFile(linked, 'utf8'), 'outside');
    assert.equal(await readFile(outside, 'utf8'), 'outside');
    assert.equal(await readFile(unknown, 'utf8'), 'unknown');
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
});

test('fresh isolated outputs promote actual writes while matching unknown canonical files stay unowned', async () => {
  assert.equal(typeof helper.beginIsolatedBridgeBuild, 'function');
  assert.equal(typeof helper.promoteBridgeBuild, 'function');
  await fixture(async f => {
    const token = randomUUID(), runRoot = join(f.root, 'obj', '.soulforge-build-runs', token);
    const outputPath = join(runRoot, 'bin', 'Debug', 'net8.0', runtimeIdentifier);
    const matching = join(f.output('net8.0'), 'Matching.dll'); await put(matching, 'matching unknown');
    await helper.beginIsolatedBridgeBuild({ project: f.project, token, runRoot, outputPath,
      canonicalOutputPath: f.output('net8.0'), framework: 'net8.0', configuration: 'Debug', runtimeIdentifier: runtimeIdentifier });
    assert.equal((JSON.parse(await readFile(join(runRoot, '.soulforge-temporary-owner.json'), 'utf8'))).owner, 'bridge-build');
    const produced = join(outputPath, 'Bridge.dll'), stagedMatching = join(outputPath, 'Matching.dll');
    await put(produced, 'fresh actual writer'); await put(stagedMatching, 'matching unknown');
    await helper.promoteBridgeBuild({ project: f.project, token, runRoot, outputPath,
      canonicalOutputPath: f.output('net8.0'), fileWrites: [produced, stagedMatching] });
    assert.equal(await readFile(join(f.output('net8.0'), 'Bridge.dll'), 'utf8'), 'fresh actual writer');
    assert.equal(await exists(produced), true, 'the run remains available through publish');
    await f.declare('net10.0');
    // The test owns the live run; release its lease to exercise completed canonical ownership.
    await rm(join(f.store, `${token}.lease.json`));
    const current = await f.begin('net10.0');
    assert.equal(await exists(join(f.output('net8.0'), 'Bridge.dll')), false);
    assert.equal(await readFile(matching, 'utf8'), 'matching unknown');
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
});

test('traversal-like build properties and malformed lease baselines preserve uncertainty', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const first = await f.begin('net8.0'), owned = join(f.output('net8.0'), 'Bridge.dll'); await put(owned);
    await helper.completeBridgeBuild({ project: f.project, token: first.token, fileWrites: [owned] });
    await f.declare('net10.0');
    for (const properties of [{ configuration: '..' }, { runtimeIdentifier: '../outside' }, { framework: '..' }]) {
      const input = { project: f.project, framework: 'net10.0', configuration: 'Debug', runtimeIdentifier: runtimeIdentifier, ...properties };
      input.outputPath = join(f.bin, input.configuration, input.framework, input.runtimeIdentifier);
      const lease = await helper.beginBridgeBuild(input);
      await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [owned] });
      assert.equal(await exists(owned), true);
    }
    const current = await f.begin('net10.0');
    const sentinel = join(f.output('net10.0'), 'pre-existing.dll'); await put(sentinel, 'user');
    const leasePath = join(f.store, `${current.token}.lease.json`);
    const original = JSON.parse(await readFile(leasePath, 'utf8'));
    for (const baseline of [null, [], 'invalid', { arbitrary: ['invalid'] }]) {
      await writeFile(leasePath, JSON.stringify({ ...original, baseline }));
      await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [sentinel] });
      assert.equal(await readFile(sentinel, 'utf8'), 'user');
    }
    await writeFile(leasePath, '{broken json');
    const next = await f.begin('net10.0');
    await helper.completeBridgeBuild({ project: f.project, token: next.token, fileWrites: [] });
    assert.equal(await readFile(sentinel, 'utf8'), 'user');
    await rm(leasePath);
    await f.declare('net12.0');
    const later = await f.begin('net12.0');
    assert.equal(await readFile(sentinel, 'utf8'), 'user', 'malformed baseline never grants ownership');
    await helper.completeBridgeBuild({ project: f.project, token: later.token, fileWrites: [] });
  });
});

test('an unknown observer preserves its lease without waiting on a coincident local preparing PID', async () => {
  await fixture(async f => {
    const first = await f.begin('net8.0'), owned = join(f.output('net8.0'), 'Bridge.dll'); await put(owned);
    await helper.completeBridgeBuild({ project: f.project, token: first.token, fileWrites: [owned] });
    const foreign = await f.begin('net8.0'), leasePath = join(f.store, `${foreign.token}.lease.json`);
    const record = JSON.parse(await readFile(leasePath, 'utf8'));
    await writeFile(leasePath, JSON.stringify({ ...record, observer: 'unknown namespace', phase: 'preparing', preparingPid: process.pid }));
    await f.declare('net10.0');
    let timer;
    try {
      const next = await Promise.race([f.begin('net10.0'), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('waited for a PID from an unobserved namespace')), 2000);
      })]);
      assert.equal(await exists(owned), true);
      assert.equal(JSON.parse(await readFile(leasePath, 'utf8')).observer, 'unknown namespace');
      await helper.completeBridgeBuild({ project: f.project, token: next.token, fileWrites: [] });
    } finally { clearTimeout(timer); }
  });
});

test('symlinks at the file, output directory, bin root, and ownership store preserve their targets', async t => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const outside = join(f.root, 'outside'); await mkdir(outside);
    const sentinel = join(outside, 'sentinel.dll'); await put(sentinel, 'outside');
    const lease = await f.begin('net8.0');
    const replaced = join(f.output('net8.0'), 'replaced.dll'); await put(replaced);
    const linked = join(f.output('net8.0'), 'linked.dll'); if (!await fileSymlink(t, sentinel, linked)) return;
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [replaced, linked] });
    await rm(replaced); await symlink(sentinel, replaced);
    await f.declare('net10.0');
    const current = await f.begin('net10.0');
    assert.equal(await readFile(replaced, 'utf8'), 'outside'); assert.equal(await readFile(linked, 'utf8'), 'outside');
    await helper.completeBridgeBuild({ project: f.project, token: current.token, fileWrites: [] });
  });
  await fixture(async f => {
    const outside = join(f.root, 'outside'); await mkdir(outside);
    const sentinel = join(outside, 'sentinel.dll'); await put(sentinel, 'outside');
    await mkdir(f.bin); await f.declare('net10.0');
    await symlink(outside, join(f.bin, 'Debug'), process.platform === 'win32' ? 'junction' : 'dir');
    const parentLinked = await f.begin('net10.0');
    await helper.completeBridgeBuild({ project: f.project, token: parentLinked.token, fileWrites: [sentinel] });
    assert.equal(await readFile(sentinel, 'utf8'), 'outside');
    await rm(f.bin, { recursive: true });
    await symlink(outside, f.bin, process.platform === 'win32' ? 'junction' : 'dir');
    const binLinked = await f.begin('net10.0');
    await helper.completeBridgeBuild({ project: f.project, token: binLinked.token, fileWrites: [sentinel] });
    assert.deepEqual(await readdir(outside), ['sentinel.dll']);
  });
  await fixture(async f => {
    const outside = join(f.root, 'outside'); await mkdir(outside); await put(join(outside, 'sentinel'), 'outside');
    await mkdir(join(f.root, 'obj'));
    await symlink(outside, f.store, process.platform === 'win32' ? 'junction' : 'dir');
    const lease = await f.begin('net8.0');
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [] });
    assert.deepEqual(await readdir(outside), ['sentinel']);
  });
  await fixture(async f => {
    const outside = join(f.root, 'outside'); await mkdir(outside); await put(join(outside, 'sentinel'), 'outside');
    await symlink(outside, join(f.root, 'obj'), process.platform === 'win32' ? 'junction' : 'dir');
    const lease = await f.begin('net8.0');
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [] });
    assert.deepEqual(await readdir(outside), ['sentinel']);
  });
});

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
}

async function preparingBuild(f, ownerPid) {
  const owned = Array.from({ length: 512 }, (_, index) => join(f.output('net8.0'), `writer-${index}.dll`));
  const initial = await f.begin('net8.0'); await Promise.all(owned.map(path => put(path)));
  await helper.completeBridgeBuild({ project: f.project, token: initial.token, fileWrites: owned });
  await f.declare('net10.0');
  const token = randomUUID();
  const input = { project: f.project, outputPath: f.output('net10.0'), framework: 'net10.0',
    configuration: 'Debug', runtimeIdentifier: runtimeIdentifier, token, ...(ownerPid ? { ownerPid } : {}) };
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { beginBridgeBuild } from ${JSON.stringify(helperUrl)};
    await beginBridgeBuild(${JSON.stringify(input)});
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  const leasePath = join(f.store, `${token}.lease.json`);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await exists(leasePath) && JSON.parse(await readFile(leasePath, 'utf8')).phase === 'preparing') return { child, leasePath };
    if (child.exitCode !== null) break;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  }
  await stop(child); throw new Error('did not observe the real cleanup helper preparing');
}

test('a concurrent newcomer waits until real stale cleanup finishes before entering its writer', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const preparing = await preparingBuild(f);
    try {
      const newcomer = await f.begin('net10.0');
      assert.equal(JSON.parse(await readFile(preparing.leasePath, 'utf8')).phase, 'building');
      await helper.completeBridgeBuild({ project: f.project, token: newcomer.token, fileWrites: [] });
    } finally { await stop(preparing.child); }
  });
});

test('interrupting a cleanup helper does not make a surviving MSBuild owner block future builds', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const preparing = await preparingBuild(f, process.pid);
    await stop(preparing.child);
    let timer;
    try {
      const next = await Promise.race([f.begin('net10.0'), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dead cleanup helper blocked a new build')), 2000);
      })]);
      await helper.completeBridgeBuild({ project: f.project, token: next.token, fileWrites: [] });
    } finally { clearTimeout(timer); }
  });
});

test('a real concurrent build lease protects marked outputs until its owner dies; failed outputs stay unknown', async () => {
  assert.equal(typeof helper.beginBridgeBuild, 'function');
  await fixture(async f => {
    const lease = await f.begin('net8.0');
    const owned = join(f.output('net8.0'), 'Bridge.dll'); await put(owned);
    await helper.completeBridgeBuild({ project: f.project, token: lease.token, fileWrites: [owned] });
    const partial = join(f.output('net8.0'), 'interrupted.dll');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { beginBridgeBuild } from ${JSON.stringify(helperUrl)};
      import { writeFile } from 'node:fs/promises';
      const lease = await beginBridgeBuild(${JSON.stringify({ project: f.project, outputPath: f.output('net8.0'), framework: 'net8.0', configuration: 'Debug', runtimeIdentifier: runtimeIdentifier })});
      await writeFile(${JSON.stringify(partial)}, 'unfinished writer');
      process.send(lease.token);
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); })]);
      await f.declare('net10.0');
      const concurrent = await f.begin('net10.0'); assert.equal(await exists(owned), true);
      await helper.completeBridgeBuild({ project: f.project, token: concurrent.token, fileWrites: [] });
      await stop(child);
      const resumed = await f.begin('net10.0');
      assert.equal(await exists(owned), false); assert.equal(await readFile(partial, 'utf8'), 'unfinished writer');
      await helper.completeBridgeBuild({ project: f.project, token: resumed.token, fileWrites: [] });
    } finally { await stop(child); }
  });
});

const dotnet = process.env.SOULFORGE_DOTNET || 'dotnet';
const dotnetAvailable = spawnSync(dotnet, ['--version'], { encoding: 'utf8', timeout: 10000 }).status === 0;

const sdkSkip = !dotnetAvailable && 'dotnet SDK unavailable';

async function sdkFixture(body) {
  const validationRoot = resolve('.local-validation'); await mkdir(validationRoot, { recursive: true });
  const root = await mkdtemp(join(validationRoot, 'bridge-ownership-'));
  try {
    const project = join(root, 'Bridge.csproj');
    const original = await readFile('bridge/SoulForge.Bridge/SoulForge.Bridge.csproj', 'utf8');
    const nativeFileWrites = original.match(/<Target Name="BuildFirstPartyHksNative"[\s\S]*?(<ItemGroup>[\s\S]*?<\/ItemGroup>)/)?.[1];
    const nativeName = process.platform === 'win32' ? 'SoulForge.Hksc.Native.dll' : 'libSoulForge.Hksc.Native.so';
    const extraFiles = Array.from({ length: 512 }, (_, i) => `<_FixtureFile Include="$(OutputPath)fixture-${i}.dll" />`).join('');
    let source = original.replaceAll('$(MSBuildProjectDirectory)/../../scripts/bridge-build-output-ownership.mjs', helperPath)
      .replace(/<ItemGroup>\s*<EmbeddedResource[\s\S]*?<\/ItemGroup>/, '')
      .replace(/<SelfContained>true<\/SelfContained>/, '<SelfContained>false</SelfContained><UseAppHost>false</UseAppHost>')
      .replace(/<PublishSingleFile>true<\/PublishSingleFile>/, '<PublishSingleFile>false</PublishSingleFile>')
      .replace(/<Target Name="BuildFirstPartyHksNative"[\s\S]*?<\/Target>/, `<Target Name="BuildFirstPartyHksNative" BeforeTargets="Build">
        <WriteLinesToFile File="$(OutputPath)${nativeName}" Lines="native writer" Overwrite="true" />${nativeFileWrites}
        <WriteLinesToFile File="$(OutputPath)Matching.dll" Lines="matching unknown" Overwrite="true" />
        <ItemGroup><FileWrites Include="$(OutputPath)Matching.dll" /></ItemGroup>
        <ItemGroup Condition="'$(FixtureManyFiles)' == 'true'">${extraFiles}</ItemGroup>
        <WriteLinesToFile File="%(_FixtureFile.Identity)" Lines="promotion writer" Overwrite="true" Condition="'$(FixtureManyFiles)' == 'true'" />
        <ItemGroup><FileWrites Include="@(_FixtureFile)" /></ItemGroup>
      </Target>`)
      .replace(/<Target Name="PublishFirstPartyHksNative"[\s\S]*?<\/Target>/, `<Target Name="PublishFirstPartyHksNative" AfterTargets="Publish"><WriteLinesToFile File="$(PublishDir)${nativeName}" Lines="published native" Overwrite="true" /></Target>`)
      .replace('</Project>', `<Target Name="PauseBeforeOutput" AfterTargets="BeginBridgeBuildOutputOwnership" Condition="'$(FixturePause)' == 'true'">
        <WriteLinesToFile File="$(MSBuildProjectDirectory)/ready.txt" Lines="$(_SoulForgeBuildRunRoot)" Overwrite="true" />
        <Exec Command="node &quot;$(MSBuildProjectDirectory)/pause.mjs&quot; &quot;$(_SoulForgeBuildRunRoot)&quot;" />
      </Target><Target Name="PauseManagedWriter" BeforeTargets="CoreCompile" Condition="'$(FixtureManagedPause)' == 'true'">
        <Exec Command="node &quot;$(MSBuildProjectDirectory)/pause.mjs&quot; &quot;$(_SoulForgeBuildRunRoot)&quot; managed" />
      </Target><ItemGroup><EmbeddedResource Include="resource.txt" LogicalName="FixtureResource" /></ItemGroup></Project>`);
    await writeFile(project, source);
    await writeFile(join(root, 'resource.txt'), 'fixture resource');
    await writeFile(join(root, 'Program.cs'), 'public static class Program { public static void Main() { using var stream = typeof(Program).Assembly.GetManifestResourceStream("FixtureResource"); using var reader = new System.IO.StreamReader(stream!); if (reader.ReadToEnd() != "fixture resource") throw new System.Exception("resource changed"); } }');
    await writeFile(join(root, 'pause.mjs'), `
      import { mkdir, writeFile, access } from 'node:fs/promises';
      const run = process.argv[2];
      if (process.argv[3] === 'managed') {
        await mkdir(run + '/managed', { recursive: true });
        await writeFile(run + '/managed/writer.dll', 'live managed writer');
        await writeFile(${JSON.stringify(join(root, 'managed-ready.json'))}, JSON.stringify({ run, pid: process.pid }));
      }
      setInterval(async () => { try { await access(${JSON.stringify(join(root, 'release-writer'))}); process.exit(0); } catch {} }, 20);
    `);
    await writeFile(join(root, 'NuGet.Config'), '<configuration><packageSources><clear /></packageSources></configuration>');
    const env = { ...process.env, DOTNET_CLI_HOME: join(root, 'dotnet-home'), NUGET_PACKAGES: join(root, 'nuget'),
      DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_GENERATE_ASPNET_CERTIFICATE: 'false' };
    const args = more => ['msbuild', project, '-nologo', '-v:minimal', '-m:1', ...more];
    const run = more => {
      const result = spawnSync(dotnet, args(more), { cwd: root, encoding: 'utf8', timeout: 60000, env, detached: process.platform !== 'win32' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result.stdout;
    };
    const start = more => {
      const child = spawn(dotnet, args(more), { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
      return { child, output: () => output };
    };
    const properties = more => JSON.parse(run(['-getProperty:OutputPath,OutDir,TargetPath,PublishDir,IntermediateOutputPath,MSBuildProjectExtensionsPath,_SoulForgeBuildRunRoot,_SoulForgeBuildOutputToken', ...more])).Properties;
    await body({ root, project, source, nativeName, env, run, start, properties });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('SDK evaluation aligns isolated output paths and preserves explicit output settings', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const first = f.properties([]), second = f.properties([]);
    assert.notEqual(first._SoulForgeBuildRunRoot, second._SoulForgeBuildRunRoot);
    assert.ok(first.OutputPath.includes(first._SoulForgeBuildOutputToken));
    assert.ok(first.OutDir.includes(first._SoulForgeBuildOutputToken));
    assert.ok(first.TargetPath.includes(first._SoulForgeBuildOutputToken));
    assert.ok(first.IntermediateOutputPath.includes(first._SoulForgeBuildOutputToken));
    assert.equal(resolve(first.PublishDir), join(f.root, 'bin', 'Debug', 'net10.0', runtimeIdentifier, 'publish'));
    assert.equal(first.MSBuildProjectExtensionsPath.replace(/[\\/]+$/, ''), join(f.root, 'obj'));
    for (const option of ['-p:OutputPath=custom-output/', '-p:OutDir=custom-outdir/', '-p:BaseOutputPath=custom-base/', '-p:NoBuild=true']) {
      const explicit = f.properties([option]);
      assert.equal(explicit._SoulForgeBuildRunRoot, '', option);
      assert.equal(explicit.OutputPath.includes('.soulforge-build-runs'), false, option);
    }
    f.run(['-t:Clean']);
    for (const name of await readdir(join(f.root, 'obj', '.soulforge-build-runs'))) {
      assert.equal(await exists(join(f.root, 'obj', '.soulforge-build-runs', name, '.soulforge-temporary-owner.json')), true, 'Clean marks its intermediate allocator first');
    }
  });
});

test('direct SDK build promotes exact outputs, retains publish inputs, and supports no-build publish', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const canonical = join(f.root, 'bin', 'Debug', 'net10.0', runtimeIdentifier);
    await put(join(canonical, 'Matching.dll'), matchingSdkText);
    f.run(['-restore', '-t:Build']);
    assert.equal(await exists(join(canonical, 'Bridge.dll')), true);
    assert.equal(await exists(join(canonical, f.nativeName)), true);
    const runs = join(f.root, 'obj', '.soulforge-build-runs'), builtRuns = await readdir(runs);
    assert.equal(builtRuns.length, 1);
    const run = join(runs, builtRuns[0]);
    assert.equal(await exists(join(run, 'bin', 'Debug', 'net10.0', runtimeIdentifier, 'Bridge.dll')), true);
    f.run(['-t:Publish', '-p:NoBuild=true']);
    assert.equal(await exists(join(canonical, 'publish', 'Bridge.dll')), true);
    assert.equal(await exists(join(canonical, 'publish', f.nativeName)), true);
    assert.deepEqual(await readdir(runs), builtRuns, 'no-build publish does not allocate a fresh empty run');
    f.run(['-t:Publish']);
    assert.equal(await exists(join(canonical, 'publish', 'Bridge.dll')), true);
    assert.equal((await readdir(runs)).includes(builtRuns[0]), false, 'a default build reclaims the marked dead predecessor');
    for (const name of await readdir(join(canonical, 'publish'))) assert.equal(name.includes('soulforge-'), false);
    f.run(['-restore', '-t:Build', '-p:UseAppHost=true']);
    f.run(['-t:Publish', '-p:UseAppHost=true', '-p:NoBuild=true']);
    assert.equal(await exists(join(canonical, 'publish', process.platform === 'win32' ? 'Bridge.exe' : 'Bridge')), true);
  });
});

test('selected isolation stops before SDK writers when its run parent is linked', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const outside = join(f.root, 'outside'); await put(join(outside, 'sentinel'), 'user');
    await mkdir(join(f.root, 'obj'));
    await symlink(outside, join(f.root, 'obj', '.soulforge-build-runs'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(dotnet, ['msbuild', f.project, '-t:PrepareForBuild', '-nologo', '-v:minimal', '-m:1'], {
      cwd: f.root, env: f.env, encoding: 'utf8', timeout: 30000, detached: process.platform !== 'win32'
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /BRIDGE_OUTPUT_BOUNDARY_INVALID/);
    assert.deepEqual(await readdir(outside), ['sentinel']);
  });
});

async function stopBuild(build) {
  const running = build.child.exitCode === null && build.child.signalCode === null;
  const exit = running ? once(build.child, 'exit') : null;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(build.child.pid), '/T', '/F']);
  else try { process.kill(-build.child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (exit) await exit;
}

async function until(predicate, build) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await predicate(); if (result) return result;
    if (build.child.exitCode !== null || build.child.signalCode !== null) throw new Error(`MSBuild exited before the observation: ${build.output()}`);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5));
  }
  throw new Error(`MSBuild observation timed out: ${build.output()}`);
}

test('real MSBuild interruption before output reclaims only its fresh marked run', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const unknown = join(f.root, 'obj', '.soulforge-build-runs', randomUUID()); await put(join(unknown, 'sentinel'), 'user');
    const build = f.start(['-t:PrepareForBuild', '-p:FixturePause=true']);
    try {
      const run = await until(async () => await exists(join(f.root, 'ready.txt')) && (await readFile(join(f.root, 'ready.txt'), 'utf8')).trim(), build);
      assert.equal((await readdir(run)).includes('.soulforge-temporary-owner.json'), true);
      assert.equal(await exists(join(run, 'bin', 'Debug', 'net10.0', runtimeIdentifier, 'Bridge.dll')), false);
      await stopBuild(build);
      f.run(['-t:PrepareForBuild']);
      assert.equal(await exists(join(run, '.soulforge-temporary-owner.json')), false);
      assert.equal(await readFile(join(unknown, 'sentinel'), 'utf8'), 'user');
    } finally { await stopBuild(build); }
  });
});

test('a real inherited managed writer guards its run after only MSBuild is killed', { skip: sdkSkip || (process.platform !== 'linux' && 'requires observed Linux process groups') }, async () => {
  await sdkFixture(async f => {
    const temporary = await import(pathToFileURL(resolve('scripts/owned-temporary-directory.mjs')).href);
    const build = f.start(['-restore', '-t:Build', '-p:FixtureManagedPause=true']);
    try {
      const writer = await until(async () => await exists(join(f.root, 'managed-ready.json')) && JSON.parse(await readFile(join(f.root, 'managed-ready.json'), 'utf8')), build);
      const exited = once(build.child, 'exit'); build.child.kill('SIGKILL'); await exited;
      f.run(['-t:PrepareForBuild']);
      assert.equal(await readFile(join(writer.run, 'managed', 'writer.dll'), 'utf8'), 'live managed writer');
      await writeFile(join(f.root, 'release-writer'), 'release');
      const deadline = Date.now() + 5000;
      while (!await temporary.ownedTemporaryDirectoryIsIdle(writer.run, 'bridge-build', writer.run.split(/[\\/]/).at(-1))) {
        if (Date.now() > deadline) throw new Error('released writer did not become idle');
        await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      }
      f.run(['-t:PrepareForBuild']);
      assert.equal(await exists(join(writer.run, 'managed', 'writer.dll')), false);
    } finally { await stopBuild(build); }
  });
});

test('real MSBuild interruption after rename recovers identity-proven outputs without adopting planned matches', { skip: sdkSkip || (process.platform !== 'linux' && 'requires reliable Linux rename identity proof') }, async () => {
  await sdkFixture(async f => {
    const canonical = join(f.root, 'bin', 'Debug', 'net10.0', runtimeIdentifier);
    const matching = join(canonical, 'Matching.dll'); await put(matching, matchingSdkText);
    const signal = join(f.root, 'renamed.json'), preload = join(f.root, 'pause-after-rename.mjs');
    // Instrument the real filesystem operation only to hold the interruption
    // window open after its successful rename and before the journal update.
    await writeFile(preload, `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        await rename(from, to);
        if (String(from).replaceAll('\\\\', '/').includes('/promotion/')) {
          await fs.writeFile(${JSON.stringify(signal)}, JSON.stringify({ destination: String(to) }));
          await new Promise(() => { setInterval(() => {}, 1000); });
        }
      };
      syncBuiltinESMExports();
    `);
    f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    const build = f.start(['-restore', '-t:Build']);
    try {
      const renamed = await until(async () => await exists(signal) && JSON.parse(await readFile(signal, 'utf8')), build);
      const store = join(f.root, 'obj', '.soulforge-build-output-ownership');
      const names = (await readdir(store)).filter(name => name.endsWith('.outputs.json'));
      assert.equal(names.length, 1);
      await stopBuild(build); delete f.env.NODE_OPTIONS;
      const stable = JSON.parse(await readFile(join(store, names[0]), 'utf8'));
      assert.equal(stable.status, 'promoting');
      assert.equal(stable.files.length, 0, 'the rename completed before its completed entry was persisted');
      assert.equal(stable.renaming.length, 1);
      assert.match(stable.renaming[0].dev, /^[0-9]+$/); assert.match(stable.renaming[0].ino, /^[1-9][0-9]*$/);
      assert.equal(await exists(renamed.destination), true, 'the actual canonical rename happened');
      assert.equal(stable.planned.some(file => file.path.endsWith('/Matching.dll')), true);
      await writeFile(f.project, f.source.replace('<TargetFramework>net10.0</TargetFramework>', '<TargetFramework>net8.0</TargetFramework>'));
      f.run(['-t:PrepareForBuild']);
      assert.equal(await exists(join(f.root, 'obj', '.soulforge-build-runs', stable.token, '.soulforge-temporary-owner.json')), false);
      assert.equal(await exists(renamed.destination), false, 'identity proof recovers and cleans the unjournaled canonical rename');
      assert.equal(await readFile(matching, 'utf8'), matchingSdkText);
      for (const file of stable.files) assert.equal(await exists(join(f.root, file.area ?? 'bin', ...file.path.split('/'))), false);
    } finally { delete f.env.NODE_OPTIONS; await stopBuild(build); }
  });
});

test('SDK ProjectReference resolves the assembly built in the referenced fresh run', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const consumer = await mkdtemp(join(resolve('.local-validation'), 'bridge-consumer-'));
    try {
      const escaped = f.project.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
      await writeFile(join(consumer, 'Consumer.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><UseAppHost>false</UseAppHost><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup><ItemGroup><ProjectReference Include="${escaped}" /></ItemGroup></Project>`);
      await writeFile(join(consumer, 'Entry.cs'), 'namespace Consumer { public static class Entry { public static void Main() { global::Program.Main(); } } }');
      const result = spawnSync(dotnet, ['msbuild', join(consumer, 'Consumer.csproj'), '-restore', '-t:Build', '-nologo', '-v:minimal', '-m:1', `-p:RestoreConfigFile=${join(f.root, 'NuGet.Config')}`], {
        cwd: consumer, env: f.env, detached: process.platform !== 'win32', encoding: 'utf8', timeout: 60000
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const execution = spawnSync(dotnet, [join(consumer, 'bin', 'Debug', 'net10.0', 'Consumer.dll')], { cwd: consumer, env: f.env, encoding: 'utf8', timeout: 10000 });
      assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
    } finally { await rm(consumer, { recursive: true, force: true }); }
  });
});

test('SDK Clean removes unchanged promoted canonical files and preserves unknown binaries', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const canonical = join(f.root, 'bin', 'Debug', 'net10.0', runtimeIdentifier);
    await put(join(canonical, 'Matching.dll'), matchingSdkText);
    await put(join(canonical, 'User.dll'), 'unknown user');
    f.run(['-restore', '-t:Build']);
    assert.equal(await exists(join(canonical, 'Bridge.dll')), true);
    const store = join(f.root, 'obj', '.soulforge-build-output-ownership');
    for (const name of (await readdir(store)).filter(name => name.endsWith('.outputs.json'))) {
      const record = JSON.parse(await readFile(join(store, name), 'utf8'));
      assert.equal(record.files.some(file => file.path.endsWith('/Matching.dll')), false,
        'the byte-identical unknown file must remain unowned before Clean');
    }
    f.run(['-t:Clean']);
    assert.equal(await exists(join(canonical, 'Bridge.dll')), false);
    assert.equal(await exists(join(canonical, 'Bridge.pdb')), false);
    assert.equal(await exists(join(f.root, 'obj', 'Debug', 'net10.0', runtimeIdentifier, 'Bridge.dll')), false);
    assert.equal(await readFile(join(canonical, 'Matching.dll'), 'utf8'), matchingSdkText);
    assert.equal(await readFile(join(canonical, 'User.dll'), 'utf8'), 'unknown user');
  });
});

test('Release PE, portable PDB and apphost omit private run paths while resources remain usable', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    const canonical = join(f.root, 'bin', 'Release', 'net10.0', runtimeIdentifier);
    const beforeMapping = f.source.replace(/<PropertyGroup Condition="'\$\(_SoulForgeIsolatedBuild\)' == 'true' And '\$\(Configuration\)' == 'Release'">[\s\S]*?<\/PropertyGroup>/, '');
    await writeFile(f.project, beforeMapping);
    f.run(['-restore', '-t:Build', '-p:Configuration=Release', '-p:UseAppHost=true']);
    const baseline = await readFile(join(canonical, 'Bridge.dll'));
    assert.equal(baseline.includes(Buffer.from('.soulforge-build-runs')), true, 'the unmapped compiler embeds the private build path');
    await writeFile(f.project, f.source);
    const token = randomUUID();
    // MSBuild composes this prefix with forward slashes on Windows. Repeated
    // separators also reproduce a raw-vs-physical prefix mismatch on Linux.
    f.run(['-t:Publish', '-p:Configuration=Release', '-p:UseAppHost=true',
      `-p:_SoulForgeBuildOutputToken=${token}`, `-p:_SoulForgeBuildRunRoot=${f.root}/obj//.soulforge-build-runs/${token}`]);
    const tokens = await readdir(join(f.root, 'obj', '.soulforge-build-runs'));
    const executable = process.platform === 'win32' ? 'Bridge.exe' : 'Bridge';
    for (const directory of [canonical, join(canonical, 'publish')]) {
      for (const name of ['Bridge.dll', 'Bridge.pdb', executable]) {
        const bytes = await readFile(join(directory, name));
        for (const privatePath of ['.soulforge-build-runs', f.root, ...tokens]) assert.equal(bytes.includes(Buffer.from(privatePath)), false, `${name} embeds ${privatePath}`);
      }
    }
    const execution = spawnSync(dotnet, [join(canonical, 'publish', 'Bridge.dll')], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  });
});


test('dotnet run launches promoted canonical output for apphost and DLL modes', { skip: sdkSkip }, async () => {
  await sdkFixture(async f => {
    for (const useAppHost of [true, false]) {
      const result = spawnSync(dotnet, ['run', '--project', f.project,
        '-p:UseAppHost=' + useAppHost, '-p:RestoreConfigFile=' + join(f.root, 'NuGet.Config')],
        { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 120000 });
      assert.equal(result.status, 0, 'apphost=' + useAppHost + ': ' + result.stdout + '\n' + result.stderr);
    }
  });
});
