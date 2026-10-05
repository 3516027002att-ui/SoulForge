import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const linuxX64 = process.platform === 'linux' && process.arch === 'x64';
const binaryName = 'soulforge-owned-process-guardian';
const manifestName = `${binaryName}.manifest.json`;
const flags = ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
const hash = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

async function waitForFile(path, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function writeFakeCompiler(path) {
  const source = `#!/usr/bin/env node
import { appendFile, chmod, writeFile } from 'node:fs/promises';
const args=process.argv.slice(2);
await appendFile(process.env.FAKE_COMPILER_MARKER, JSON.stringify(args)+'\\n');
if(args.length===1&&args[0]==='--version'){
  if(process.env.FAKE_COMPILER_MODE==='version-fail'){process.stderr.write('fixture version failure\\n');process.exitCode=23;}
  else process.stdout.write('fixture compiler 1.0\\n');
}else if(process.env.FAKE_COMPILER_MODE==='compile-fail'){
  process.stderr.write('fixture compile failure\\n');process.exitCode=24;
}else{
  const output=args[args.indexOf('-o')+1];
  if(!output)throw new Error('fake compiler did not receive -o');
  await writeFile(output, '#!/bin/sh\\n# '+process.env.FAKE_BUILD_ID+'\\nexit 0\\n', {mode:0o600});
  await chmod(output,0o700);
}
`;
  await writeFile(path, source, { flag: 'wx', mode: 0o700 });
  await chmod(path, 0o700);
}

async function createFixture(parent, { seedArtifact = true } = {}) {
  const repo = join(parent, `repo-${randomUUID()}`);
  const scripts = join(repo, 'scripts');
  const artifactRoot = join(repo, '.local-validation', 'owned-process-guardian');
  const artifactDirectory = join(artifactRoot, 'linux-x64');
  const attemptsDirectory = join(artifactRoot, 'attempts');
  const builderPath = join(scripts, 'build-owned-process-guardian.mjs');
  const sourcePath = join(scripts, 'owned-process-linux-guardian.c');
  const compilerPath = join(parent, `fake-compiler-${randomUUID()}.mjs`);
  const compilerMarker = join(parent, `fake-compiler-${randomUUID()}.log`);
  const builderSourceBytes = await readFile(new URL('./build-owned-process-guardian.mjs', import.meta.url));
  const builderSource = builderSourceBytes.toString('utf8');
  const legacySchema = builderSource.includes("schema: 'soulforge.owned-process-guardian-build.v1'");
  const versionedSchema = builderSource.includes("schema: 'soulforge.owned-process-guardian-build.v2'");
  assert.notEqual(legacySchema, versionedSchema, 'seed only a known v1 fixed-file or v2 versioned-file contract');
  const manifestSchema = legacySchema ? 'soulforge.owned-process-guardian-build.v1' : 'soulforge.owned-process-guardian-build.v2';
  await mkdir(scripts, { recursive: true, mode: 0o700 });
  await writeFile(builderPath, builderSourceBytes, { flag: 'wx', mode: 0o600 });
  await copyFile(new URL('./subprocess-control.mjs', import.meta.url), join(scripts, 'subprocess-control.mjs'));
  await copyFile(new URL('./owned-process-linux-guardian.c', import.meta.url), sourcePath);
  await writeFakeCompiler(compilerPath);

  let seed = null;
  if (seedArtifact) {
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const activeBinaryFile = versionedSchema
      ? `${binaryName}.11111111-1111-4111-8111-111111111111` : binaryName;
    const binaryBytes = Buffer.from('#!/bin/sh\n# previous-success\nexit 0\n');
    const sourceBytes = await readFile(sourcePath);
    const manifest = {
      schema: manifestSchema,
      protocol: 'soulforge.owned-process-guardian.v1', protocolVersion: 1,
      platform: 'linux', arch: 'x64',
      ...(versionedSchema ? { binaryFile: activeBinaryFile } : {}),
      sourceSha256: hash(sourceBytes), binarySha256: hash(binaryBytes),
      compiler: { command: 'previous-fixture-compiler', version: 'fixture previous build', flags }
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const activeBinaryPath = join(artifactDirectory, activeBinaryFile);
    await writeFile(activeBinaryPath, binaryBytes, { flag: 'wx', mode: 0o700 });
    await chmod(activeBinaryPath, 0o700);
    await writeFile(join(artifactDirectory, manifestName), manifestBytes, { flag: 'wx', mode: 0o600 });
    seed = { manifestSchema, activeBinaryFile, binaryBytes, manifestBytes };
  }
  return { repo, scripts, artifactRoot, artifactDirectory, attemptsDirectory, builderPath, sourcePath,
    compilerPath, compilerMarker, seed };
}

function compilerEnvironment(fixture, mode = 'success') {
  return { ...process.env,
    SOULFORGE_OWNED_PROCESS_GUARDIAN_CC: fixture.compilerPath,
    FAKE_COMPILER_MODE: mode,
    FAKE_COMPILER_MARKER: fixture.compilerMarker,
    FAKE_BUILD_ID: `generated-${randomUUID()}` };
}

async function runBuilder(fixture, mode) {
  const child = spawn(process.execPath, [fixture.builderPath], {
    cwd: fixture.repo, env: compilerEnvironment(fixture, mode), stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

function activeBinaryNameFromManifest(manifest, seed) {
  assert.equal(manifest.schema, seed.manifestSchema);
  if (manifest.schema === 'soulforge.owned-process-guardian-build.v1') {
    assert.equal(Object.hasOwn(manifest, 'binaryFile'), false, 'v1 explicitly selects the fixed helper name');
    assert.equal(seed.activeBinaryFile, binaryName);
    return binaryName;
  }
  if (manifest.schema === 'soulforge.owned-process-guardian-build.v2') {
    assert.equal(manifest.binaryFile, seed.activeBinaryFile, 'v2 explicitly selects its versioned helper');
    return manifest.binaryFile;
  }
  assert.fail(`unexpected Guardian manifest schema: ${manifest.schema}`);
}

async function assertSeedPairUnchanged(fixture) {
  assert.ok(fixture.seed, 'the fixture must have a prior successful artifact');
  const activeManifestBytes = await readFile(join(fixture.artifactDirectory, manifestName));
  assert.deepEqual(activeManifestBytes, fixture.seed.manifestBytes,
    'the active success manifest must remain byte-identical');
  const activeManifest = JSON.parse(activeManifestBytes.toString('utf8'));
  const activeBinaryFile = activeBinaryNameFromManifest(activeManifest, fixture.seed);
  assert.equal(activeBinaryFile, fixture.seed.activeBinaryFile);
  assert.deepEqual(await readFile(join(fixture.artifactDirectory, activeBinaryFile)), fixture.seed.binaryBytes,
    'the binary selected by the unchanged manifest must remain byte-identical');
}

async function injectFixtureOnlyPublishPause(builderPath) {
  const source = await readFile(builderPath, 'utf8');
  const pattern = /^([ \t]*)await rename\(manifestNext,.*\);$/gm;
  const matches = [...source.matchAll(pattern)];
  assert.equal(matches.length, 1, 'test-only seam must bind to the single manifest commit rename');
  const [match] = matches;
  const indent = match[1];
  const pause = `${indent}if (process.env.SOULFORGE_TEST_PUBLISH_READY) {\n`
    + `${indent}  await writeFile(process.env.SOULFORGE_TEST_PUBLISH_READY, 'ready', { flag: 'wx', mode: 0o600 });\n`
    + `${indent}  for (;;) {\n`
    + `${indent}    try { await readFile(process.env.SOULFORGE_TEST_PUBLISH_RELEASE); break; }\n`
    + `${indent}    catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolvePause => setTimeout(resolvePause, 10)); }\n`
    + `${indent}  }\n`
    + `${indent}}\n`
    + match[0];
  await writeFile(builderPath, source.replace(match[0], pause));
}

async function stopExactChild(child, closePromise) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closePromise;
}

test('failed Guardian compiler stages preserve the previous success pair and retain failure attempts',
  { skip: !linuxX64 && 'Linux x64 build protocol only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-guardian-build-failure-'));
  try {
    const fixture = await createFixture(root);
    for (const [mode, stage] of [['version-fail', 'compiler-version'], ['compile-fail', 'compile']]) {
      const before = await readdir(fixture.attemptsDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const result = await runBuilder(fixture, mode);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 1, result.stderr);
      await assertSeedPairUnchanged(fixture);
      const after = await readdir(fixture.attemptsDirectory);
      const added = after.filter(name => !before.includes(name));
      assert.equal(added.length, 1, `${stage} failure leaves its own retained attempt`);
      const attempt = join(fixture.attemptsDirectory, added[0]);
      const failure = JSON.parse(await readFile(join(attempt, 'failure.json'), 'utf8'));
      assert.equal(failure.stage, stage);
      assert.ok((await lstat(join(attempt, 'owned-process-linux-guardian.c'))).isFile());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardian prepare rejects artifact-directory links before writing through them',
  { skip: !linuxX64 && 'Linux x64 filesystem contract only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-guardian-artifact-link-'));
  try {
    const fixture = await createFixture(root, { seedArtifact: false });
    const outside = join(root, 'outside-artifacts');
    await mkdir(outside);
    await writeFile(join(outside, 'sentinel'), 'untouched');
    await mkdir(dirname(fixture.artifactDirectory), { recursive: true });
    await symlink(outside, fixture.artifactDirectory, 'dir');
    const result = await runBuilder(fixture, 'success');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /OWNED_PROCESS_GUARDIAN_BUILD_PATH_NOT_PRIVATE/);
    assert.deepEqual(await readdir(outside), ['sentinel']);
    await assert.rejects(readFile(fixture.compilerMarker), error => error.code === 'ENOENT', 'link rejection precedes compiler execution');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Guardian prepare rejects source links before compiler execution and preserves old output',
  { skip: !linuxX64 && 'Linux x64 filesystem contract only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-guardian-source-link-'));
  try {
    const fixture = await createFixture(root);
    const outsideSource = join(root, 'outside-source.c');
    await copyFile(fixture.sourcePath, outsideSource);
    await rm(fixture.sourcePath);
    await symlink(outsideSource, fixture.sourcePath, 'file');
    const result = await runBuilder(fixture, 'success');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /OWNED_PROCESS_GUARDIAN_SOURCE_NOT_PRIVATE/);
    await assertSeedPairUnchanged(fixture);
    await assert.rejects(readFile(fixture.compilerMarker), error => error.code === 'ENOENT', 'source-link rejection precedes compiler execution');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('interrupted Guardian prepare retains the old active manifest/binary pair until atomic manifest commit',
  { skip: !linuxX64 && 'Linux x64 publication contract only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-guardian-build-interrupt-'));
  let child;
  let closePromise;
  try {
    const fixture = await createFixture(root);
    const readyPath = join(root, 'publish-ready');
    const releasePath = join(root, 'publish-release');
    await injectFixtureOnlyPublishPause(fixture.builderPath);
    child = spawn(process.execPath, [fixture.builderPath], {
      cwd: fixture.repo,
      env: { ...compilerEnvironment(fixture), SOULFORGE_TEST_PUBLISH_READY: readyPath,
        SOULFORGE_TEST_PUBLISH_RELEASE: releasePath },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    closePromise = once(child, 'close');
    await waitForFile(readyPath, 'fixture-only manifest publication gate');
    assert.equal(child.kill('SIGKILL'), true, 'only the exact prepared child is interrupted');
    const [code, signal] = await closePromise;
    assert.equal(signal, 'SIGKILL', stderr);
    assert.notEqual(code, 0);

    await assertSeedPairUnchanged(fixture);
    const attempts = await readdir(fixture.attemptsDirectory);
    assert.equal(attempts.length, 1, 'the interrupted attempt is retained, not recursively deleted');
    const files = await readdir(join(fixture.attemptsDirectory, attempts[0]));
    assert.ok(files.includes('owned-process-linux-guardian.c'));
    assert.ok(files.includes(binaryName));
    assert.ok(files.includes(`${binaryName}.manifest.json`));
    const activeBytes = await readFile(join(fixture.artifactDirectory, manifestName));
    const active = JSON.parse(activeBytes.toString('utf8'));
    const activeBinaryFile = activeBinaryNameFromManifest(active, fixture.seed);
    assert.equal(activeBinaryFile, fixture.seed.activeBinaryFile,
      'the previous manifest remains bound to its schema-selected active binary');
    const activeBinaryBytes = await readFile(join(fixture.artifactDirectory, activeBinaryFile));
    assert.deepEqual(activeBinaryBytes, fixture.seed.binaryBytes);
    assert.equal(hash(activeBinaryBytes), active.binarySha256);
  } finally {
    if (child && closePromise) await stopExactChild(child, closePromise);
    await rm(root, { recursive: true, force: true });
  }
});
