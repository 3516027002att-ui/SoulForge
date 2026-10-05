import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, lstat, readdir, realpath, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import { withDesktopTestBuild } from './desktop-test-build.mjs';
import { runProcess } from './subprocess-control.mjs';
import { runOwnedProcess } from './owned-process.mjs';
import { runLinuxGuardianProcess } from './owned-process-linux-guardian.mjs';

const linux = process.platform === 'linux';
const linuxX64 = linux && process.arch === 'x64';
const tempModule = pathToFileURL(resolve('scripts/owned-temporary-directory.mjs')).href;
const processModule = pathToFileURL(resolve('scripts/subprocess-control.mjs')).href;
const ownedProcessModule = pathToFileURL(resolve('scripts/owned-process.mjs')).href;
const desktopModule = pathToFileURL(resolve('scripts/desktop-test-build.mjs')).href;
const delay = ms => new Promise(done => setTimeout(done, ms));

async function waitFor(read, description) {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function stop(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill(signal); await closed;
}

async function ownedPidStopped(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]);
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return true;
    throw error;
  }
}

async function ownedProcessGroupStopped(group) {
  try { process.kill(-group, 0); }
  catch (error) { if (error.code === 'ESRCH') return true; if (error.code === 'EPERM') return false; throw error; }
  let entries;
  try { entries = await readdir('/proc'); } catch { return false; }
  for (const pid of entries.filter(name => /^\d+$/.test(name))) {
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; return false; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0])) return false;
  }
  return true;
}

async function retireStoppedTestRoot(root, expectedToken) {
  try { await lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const marker = JSON.parse(await readFile(join(root, '.soulforge-temporary-owner.json'), 'utf8'));
  if (expectedToken) assert.equal(marker.token, expectedToken, 'manual cleanup must be bound to this fixture owner');
  const pids = [...new Set([...(marker.pid === process.pid ? [] : [marker.pid]), ...(marker.childPids ?? []), ...(marker.uncertainTrees ?? [])])];
  const groups = [...new Set(marker.processGroups ?? [])];
  await waitFor(async () => (await Promise.all(pids.map(ownedPidStopped))).every(Boolean)
    && (await Promise.all(groups.map(ownedProcessGroupStopped))).every(Boolean), 'fixture-owned processes and groups to stop before cleanup');
  const current = JSON.parse(await readFile(join(root, '.soulforge-temporary-owner.json'), 'utf8'));
  if (expectedToken) assert.equal(current.token, expectedToken, 'owner identity must still match immediately before manual cleanup');
  // This is test-only retirement after every PID in this exact owner receipt
  // has been observed stopped. It does not clear or weaken product retention.
  await rm(root, { recursive: true, force: true });
}

async function runIsolatedSupervisorCloseScenario(parent, scenario) {
  const childSource = `import childProcess from 'node:child_process';
    import {existsSync} from 'node:fs';
    import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
    import {syncBuiltinESMExports} from 'node:module';
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {processSucceeded} from ${JSON.stringify(processModule)};
    const scenario=JSON.parse(process.env.SCENARIO),originalFork=childProcess.fork;
    class FakeSupervisor extends EventEmitter {
      constructor(){super();this.pid=99999999;this.connected=true;this.stdout=new PassThrough();this.stderr=new PassThrough();}
      send(message){if(message.type==='start')queueMicrotask(()=>{
        if(scenario.includeResult)this.emit('message',{type:'result',result:scenario.result});
        this.connected=false;this.stdout.end();this.stderr.end();this.emit('close',scenario.closeCode,scenario.closeSignal);
      });return true;}
      kill(){return true;}
    }
    childProcess.fork=()=>new FakeSupervisor();syncBuiltinESMExports();
    try{
      const {runOwnedProcess}=await import(${JSON.stringify(ownedProcessModule)});
      const owners=[];for(let i=0;i<(scenario.ownerCount??1);i++)owners.push(await createOwnedTemporaryDirectory('close-receipt',{parent:process.env.ROOT}));
      const owner=owners.length===1?owners[0]:{trackProcess:async(...args)=>Promise.all(owners.map(value=>value.trackProcess(...args)))};
      const result=await runOwnedProcess({owner,command:process.execPath,args:['-e','process.exit(0)'],cwd:process.cwd(),env:process.env});
      const disposal=[];for(const value of owners){let error=null;try{await value.dispose();}catch(failure){error=failure.message;}disposal.push(error);}
      const roots=owners.map(value=>({root:value.root,exists:existsSync(value.root)}));
      console.log(JSON.stringify({result,success:processSucceeded(result),disposal,roots}));
    }finally{childProcess.fork=originalFork;syncBuiltinESMExports();}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: parent, env: { ...process.env, ROOT: parent, SCENARIO: JSON.stringify(scenario) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  return { code, signal, stdout, stderr };
}

async function fakeWriter(root) {
  const ready = join(root, 'ready.json'), release = join(root, 'release');
  const script = join(root, 'writer.cjs');
  await writeFile(script, `const fs=require('node:fs');
    const root=process.env.SOULFORGE_TEST_BUILD_ROOT || process.cwd();
    fs.writeFileSync(process.env.READY, JSON.stringify({root,pid:process.pid}));
    const timer=setInterval(()=>{fs.writeFileSync(root+'/still-writing','live');console.log('writer live');
      if(fs.existsSync(process.env.RELEASE)){clearInterval(timer);process.exit(0);}},25);`);
  return { ready, release, script, env: { ...process.env, READY: ready, RELEASE: release } };
}

test('Linux C Guardian capability, child-list and wait-owner faults fail closed',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-guardian-native-faults-'));
  assert.equal(await realpath(root), root, 'fault-injection artifacts stay in the unique canonical fixture root');
  const helper = join(root, 'owned-process-linux-guardian-test');
  let orphanWriterPid, buildOwner, buildOwnerDisposed = false, safeToRemoveRoot = true;
  try {
    buildOwner = await createOwnedTemporaryDirectory('guardian-test-build', { parent: root });
    const source = join(buildOwner.root, 'owned-process-linux-guardian-test.c');
    await writeFile(source, await readFile(new URL('./owned-process-linux-guardian.c', import.meta.url)), { flag: 'wx', mode: 0o600 });
    const compiler = process.env.SOULFORGE_OWNED_PROCESS_GUARDIAN_CC || process.env.CC || 'cc';
    const flags = ['-D_GNU_SOURCE', '-DSOULFORGE_GUARDIAN_TEST_HOOKS', '-DCLEANUP_DEADLINE_MS=250',
      '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
    const compilerVersion = await runProcess({ command: compiler, args: ['--version'], cwd: buildOwner.root,
      owner: buildOwner, timeoutMs: 15_000, outputLimitBytes: 8192 });
    const build = await runProcess({ command: compiler,
      args: [...flags, source, '-o', helper], cwd: buildOwner.root, owner: buildOwner,
      timeoutMs: 30_000, outputLimitBytes: 32 * 1024 });
    let binaryHash = null;
    try {
      const binaryInfo = await lstat(helper);
      if (binaryInfo.isFile() && !binaryInfo.isSymbolicLink() && binaryInfo.nlink === 1) {
        await chmod(helper, 0o700);
        binaryHash = createHash('sha256').update(await readFile(helper)).digest('hex');
      }
    } catch { /* The manifest records a missing build output; the assertion below fails. */ }
    const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
    const testHelperManifest = {
      schema: 'soulforge.owned-process-guardian.test-build.v1',
      protocol: 'soulforge.owned-process-guardian.v1', protocolVersion: 1,
      platform: process.platform, arch: process.arch, sourceSha256: sourceHash, binarySha256: binaryHash,
      compiler: { command: compiler, version: compilerVersion.stdout, flags },
      compilerVersionResult: { code: compilerVersion.code, treeStopped: compilerVersion.treeStopped,
        descendantsObserved: compilerVersion.descendantsObserved, stderr: compilerVersion.stderr },
      compileResult: { code: build.code, treeStopped: build.treeStopped, descendantsObserved: build.descendantsObserved,
        childExitCode: build.childExitCode, stderr: build.stderr }
    };
    await writeFile(join(root, 'test-helper-build-manifest.json'), JSON.stringify(testHelperManifest, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`OWNED_PROCESS_GUARDIAN_TEST_VARIANT ${JSON.stringify({ schema: testHelperManifest.schema,
      platform: testHelperManifest.platform, arch: testHelperManifest.arch, sourceSha256: testHelperManifest.sourceSha256,
      binarySha256: testHelperManifest.binarySha256,
      compilerVersion: testHelperManifest.compiler.version.slice(0, 1024), flags: testHelperManifest.compiler.flags,
      versionCode: compilerVersion.code, versionTreeStopped: compilerVersion.treeStopped,
      compileCode: build.code, compileTreeStopped: build.treeStopped })}`);
    await buildOwner.dispose();
    buildOwnerDisposed = true;
    assert.equal(compilerVersion.code, 0, compilerVersion.stderr);
    assert.equal(compilerVersion.treeStopped, true, 'compiler version probe must include complete child cleanup proof');
    assert.equal(build.code, 0, build.stderr);
    assert.equal(build.treeStopped, true, 'fault-helper compilation needs a complete guardian proof');
    assert.ok(binaryHash, 'compiled test helper must be a private regular file');

    const runGuardian = async (faultArgs, command, args, env = process.env) => {
      const nonce = randomUUID();
      const child = spawn(helper, ['--nonce', nonce, '--timeout-ms', '0', ...faultArgs, '--', command, ...args], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '', receiptRaw = '', timedOut = false;
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.stdio[3].on('data', chunk => { receiptRaw += chunk.toString(); });
      child.on('error', error => { stderr += `${error.message}\n`; });
      const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 8_000);
      const [code, signal] = await once(child, 'close');
      clearTimeout(watchdog);
      let receipt = null;
      try { receipt = JSON.parse(receiptRaw); } catch { /* Missing receipt is itself non-success. */ }
      return { code, signal, stdout, stderr, receipt, nonce, timedOut };
    };

    const fdMarker = join(root, 'child-result-fd-closed');
    const fdCheck = await runGuardian([], '/bin/sh', ['-c',
      'if [ -e /proc/self/fd/3 ]; then printf open > "$1"; else printf closed > "$1"; fi', 'guardian-test', fdMarker]);
    assert.equal(fdCheck.timedOut, false);
    assert.equal(fdCheck.code, 0, fdCheck.stderr);
    assert.equal(fdCheck.receipt?.treeStopped, true);
    assert.equal(await readFile(fdMarker, 'utf8'), 'closed', 'receipt FD 3 must not survive target exec');

    const capabilityMarker = join(root, 'pidfd-target-ran');
    const noPidfd = await runGuardian(['--test-pidfd-preflight-failure'], process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(capabilityMarker)},'ran')`]);
    assert.equal(noPidfd.timedOut, false);
    assert.equal(noPidfd.code, 1);
    assert.equal(noPidfd.receipt?.nonce, noPidfd.nonce);
    assert.equal(noPidfd.receipt?.terminationReason, 'guardian-capability-unavailable');
    assert.equal(noPidfd.receipt?.treeStopped, false);
    await assert.rejects(readFile(capabilityMarker), error => error.code === 'ENOENT', 'failed capability preflight must not spawn the target');

    const waitOwnerMarker = join(root, 'wait-owner-target-ran');
    const lostWaitOwnership = await runGuardian(['--test-echild-after-waitid'], process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(waitOwnerMarker)},'ran')`]);
    assert.equal(lostWaitOwnership.timedOut, false);
    assert.equal(lostWaitOwnership.code, 1);
    assert.equal(lostWaitOwnership.receipt?.treeStopped, false, 'specific waitpid ECHILD after waitid is not global proof');
    assert.equal(lostWaitOwnership.receipt?.terminationReason, 'tree-unproven');
    assert.equal(await readFile(waitOwnerMarker, 'utf8'), 'ran');

    const churn = await runGuardian(['--test-reaper-churn'], process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(churn.timedOut, false, 'the Guardian deadline must stop repeated waitpid-success cycles before the outer watchdog');
    assert.equal(churn.code, 1);
    assert.equal(churn.receipt?.childExitCode, 0);
    assert.equal(churn.receipt?.treeStopped, false, 'short-lived reaped children do not bypass the hard post-exit deadline');
    assert.equal(churn.receipt?.terminationReason, 'tree-unproven');
    assert.match(churn.stderr, /TEST_REAPER_CHURN_COUNT=[1-9][0-9]*/);

    const writerPidFile = join(root, 'hidden-live-child.pid');
    const writerCode = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(writerPidFile)},String(process.pid));setTimeout(()=>process.exit(0),1500);`;
    const targetCode = `const fs=require('node:fs');const {spawn}=require('node:child_process');` +
      `spawn(process.execPath,['-e',${JSON.stringify(writerCode)}],{stdio:'ignore'});` +
      `const end=Date.now()+1000,wait=new Int32Array(new SharedArrayBuffer(4));` +
      `while(!fs.existsSync(${JSON.stringify(writerPidFile)})&&Date.now()<end)Atomics.wait(wait,0,0,5);process.exit(0);`;
    const hiddenChildren = await runGuardian(['--test-hide-children-after-target'], process.execPath, ['-e', targetCode]);
    orphanWriterPid = Number(await readFile(writerPidFile, 'utf8'));
    if (!Number.isSafeInteger(orphanWriterPid) || orphanWriterPid <= 0) safeToRemoveRoot = false;
    assert.ok(Number.isSafeInteger(orphanWriterPid) && orphanWriterPid > 0);
    assert.equal(hiddenChildren.timedOut, false);
    assert.equal(hiddenChildren.code, 1);
    assert.equal(hiddenChildren.receipt?.childExitCode, 0);
    assert.equal(hiddenChildren.receipt?.treeStopped, false, 'an empty proc child listing plus waitpid 0 must time out without proof');
    assert.equal(hiddenChildren.receipt?.terminationReason, 'tree-unproven');
    assert.equal(await ownedPidStopped(orphanWriterPid), false, 'a hidden live child demonstrates the deadline fail-closed case');
    await waitFor(() => ownedPidStopped(orphanWriterPid), 'fault-injection child natural exit');
  } finally {
    if (orphanWriterPid && !(await ownedPidStopped(orphanWriterPid))) {
      try { await waitFor(() => ownedPidStopped(orphanWriterPid), 'fault-injection child cleanup'); }
      catch { safeToRemoveRoot = false; }
    }
    if (buildOwner && !buildOwnerDisposed) {
      try { await buildOwner.dispose(); buildOwnerDisposed = true; }
      catch { safeToRemoveRoot = false; }
    }
    if (safeToRemoveRoot) await rm(root, { recursive: true, force: true });
  }
});

test('missing Linux Guardian fails before the user command is spawned', { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-missing-guardian-'));
  const marker = join(root, 'command-ran');
  try {
    const result = await runLinuxGuardianProcess({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], cwd: root,
      env: { ...process.env, GUARDIAN_TEST_MARKER: marker } }, join(root, 'not-prepared'));
    assert.equal(result.code, 1);
    assert.equal(result.treeStopped, false);
    assert.match(result.outputError, /GUARDIAN_UNAVAILABLE/);
    await assert.rejects(readFile(marker), error => error.code === 'ENOENT', 'fail-closed preflight must not run the target');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Linux Guardian adapter preserves split UTF-8 output and raw callback buffers',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-guardian-utf8-output-'));
  const artifactDirectory = join(root, 'linux-x64');
  const binaryFile = `soulforge-owned-process-guardian.${randomUUID()}`;
  const helperPath = join(artifactDirectory, binaryFile);
  const text = '仓库🙂';
  const bytes = Buffer.from(text, 'utf8');
  const encoded = bytes.toString('base64');
  const stdoutChunks = [], stderrChunks = [];
  const splitTestHelper = `#!/usr/bin/env node
const fs = require('node:fs');
const nonce = process.argv[3];
const bytes = Buffer.from(${JSON.stringify(encoded)}, 'base64');
let offset = 0;
function writeNextByte() {
  if (offset >= bytes.length) {
    fs.writeSync(3, JSON.stringify({
      protocol: 'soulforge.owned-process-guardian.v1', nonce, code: 0, signal: null,
      childExitCode: 0, treeStopped: true, descendantsObserved: false,
      terminationReason: null, spawnErrno: 0
    }) + '\\n');
    return;
  }
  const part = bytes.subarray(offset, offset + 1);
  offset += 1;
  process.stdout.write(part);
  process.stderr.write(part);
  setTimeout(writeNextByte, 25);
}
writeNextByte();
`;
  try {
    await mkdir(artifactDirectory);
    const helperBytes = Buffer.from(splitTestHelper);
    await writeFile(helperPath, helperBytes, { flag: 'wx', mode: 0o700 });
    await chmod(helperPath, 0o700);
    const sourceBytes = await readFile(new URL('./owned-process-linux-guardian.c', import.meta.url));
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    await writeFile(join(artifactDirectory, 'soulforge-owned-process-guardian.manifest.json'), JSON.stringify({
      schema: 'soulforge.owned-process-guardian-build.v2',
      protocol: 'soulforge.owned-process-guardian.v1', protocolVersion: 1,
      platform: 'linux', arch: 'x64', binaryFile,
      sourceSha256: sha256(sourceBytes), binarySha256: sha256(helperBytes),
      compiler: { command: process.execPath, version: process.version,
        flags: ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'] }
    }), { flag: 'wx', mode: 0o600 });

    const result = await runLinuxGuardianProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'],
      cwd: root, env: process.env, timeoutMs: 5_000, outputLimitBytes: 64,
      onStdout: chunk => {
        assert.ok(Buffer.isBuffer(chunk), 'Linux Guardian stdout callback must receive a Buffer');
        stdoutChunks.push(Buffer.from(chunk));
      },
      onStderr: chunk => {
        assert.ok(Buffer.isBuffer(chunk), 'Linux Guardian stderr callback must receive a Buffer');
        stderrChunks.push(Buffer.from(chunk));
      } }, artifactDirectory);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.treeStopped, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, false);
    assert.equal(result.stdout, text);
    assert.equal(result.stderr, text);
    assert.ok(stdoutChunks.length > 1);
    assert.ok(stderrChunks.length > 1);
    assert.deepEqual(Buffer.concat(stdoutChunks), bytes);
    assert.deepEqual(Buffer.concat(stderrChunks), bytes);
    const splitsInsideCodePoint = chunks => {
      let byteOffset = 0;
      for (const chunk of chunks.slice(0, -1)) {
        byteOffset += chunk.length;
        if (byteOffset < bytes.length && (bytes[byteOffset] & 0xc0) === 0x80) return true;
      }
      return false;
    };
    assert.equal(splitsInsideCodePoint(stdoutChunks), true);
    assert.equal(splitsInsideCodePoint(stderrChunks), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an exited helper with live descendants holding inherited pipes returns incomplete proof',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-guardian-open-pipe-test-'));
  const artifactDirectory = join(root, 'linux-x64');
  const binaryFile = `soulforge-owned-process-guardian.${randomUUID()}`;
  const helper = join(artifactDirectory, binaryFile);
  const holdPidFile = join(root, 'pipe-holder.pid');
  const commandMarker = join(root, 'user-command-ran');
  let holderPid;
  try {
    await mkdir(artifactDirectory);
    const helperBytes = Buffer.from(`#!/bin/sh\n"$GUARDIAN_TEST_NODE" -e 'setTimeout(()=>process.exit(0),2500)' &\necho $! > "$GUARDIAN_TEST_CHILD_PID_FILE"\nexit 1\n`);
    const sourceBytes = await readFile(new URL('./owned-process-linux-guardian.c', import.meta.url));
    await writeFile(helper, helperBytes, { mode: 0o700 });
    await chmod(helper, 0o700);
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    await writeFile(join(artifactDirectory, 'soulforge-owned-process-guardian.manifest.json'), JSON.stringify({
      schema: 'soulforge.owned-process-guardian-build.v2',
      protocol: 'soulforge.owned-process-guardian.v1', protocolVersion: 1,
      platform: 'linux', arch: 'x64', binaryFile, sourceSha256: sha256(sourceBytes), binarySha256: sha256(helperBytes),
      compiler: { command: 'fixture-only', version: 'bounded pipe fixture',
        flags: ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'] }
    }), { flag: 'wx', mode: 0o600 });

    const result = await runLinuxGuardianProcess({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'ran')`], cwd: root,
      env: { ...process.env, GUARDIAN_TEST_CHILD_PID_FILE: holdPidFile, GUARDIAN_TEST_NODE: process.execPath } }, artifactDirectory);
    holderPid = Number(await readFile(holdPidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(holderPid) && holderPid > 0);
    assert.equal(result.code, 1);
    assert.equal(result.treeStopped, false, 'manual closure of parent read ends is not a tree proof');
    assert.equal(result.outputError, 'OWNED_PROCESS_GUARDIAN_STDIO_NOT_CLOSED');
    assert.equal(await ownedPidStopped(holderPid), false, 'the descendant must still be alive when the incomplete result returns');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT', 'fake helper must not execute target argv');
    await waitFor(() => ownedPidStopped(holderPid), 'fake pipe holder natural exit');

    const manifestPath = join(artifactDirectory, 'soulforge-owned-process-guardian.manifest.json');
    const validManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const runPreflight = () => runLinuxGuardianProcess({ command: process.execPath,
      args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'ran')`], cwd: root,
      env: process.env }, artifactDirectory);

    const legacyManifest = { ...validManifest, schema: 'soulforge.owned-process-guardian-build.v1' };
    delete legacyManifest.binaryFile;
    await writeFile(manifestPath, JSON.stringify(legacyManifest));
    const legacy = await runPreflight();
    assert.equal(legacy.code, 1);
    assert.equal(legacy.outputError, 'OWNED_PROCESS_GUARDIAN_STALE', 'the old fixed-name manifest is unavailable, not guessed');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT');

    await writeFile(manifestPath, JSON.stringify({ ...validManifest, binaryFile: '../outside-helper' }));
    const unsafePath = await runPreflight();
    assert.equal(unsafePath.outputError, 'OWNED_PROCESS_GUARDIAN_STALE', 'manifest paths cannot escape the artifact directory');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT');

    const symlinkName = `soulforge-owned-process-guardian.${randomUUID()}`;
    await symlink(helper, join(artifactDirectory, symlinkName));
    await writeFile(manifestPath, JSON.stringify({ ...validManifest, binaryFile: symlinkName }));
    const symlinkBinary = await runPreflight();
    assert.equal(symlinkBinary.outputError, 'OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT');
    await rm(join(artifactDirectory, symlinkName));

    const hardlinkName = `soulforge-owned-process-guardian.${randomUUID()}`;
    await link(helper, join(artifactDirectory, hardlinkName));
    await writeFile(manifestPath, JSON.stringify({ ...validManifest, binaryFile: hardlinkName }));
    const hardlinkBinary = await runPreflight();
    assert.equal(hardlinkBinary.outputError, 'OWNED_PROCESS_GUARDIAN_ARTIFACT_INVALID', 'linked binaries are not trusted');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT');
    await rm(join(artifactDirectory, hardlinkName));

    await writeFile(manifestPath, JSON.stringify({ ...validManifest, binarySha256: '0'.repeat(64) }));
    const binaryHashMismatch = await runPreflight();
    assert.equal(binaryHashMismatch.outputError, 'OWNED_PROCESS_GUARDIAN_STALE', 'the selected binary hash remains authoritative');
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT');

    const staleManifest = { ...validManifest };
    staleManifest.sourceSha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(staleManifest));
    const stale = await runPreflight();
    assert.equal(stale.code, 1);
    assert.equal(stale.outputError, 'OWNED_PROCESS_GUARDIAN_STALE');
    assert.match(stale.stderr, /npm run prepare:owned-process-guardian/);
    await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT', 'stale helper preflight must not run the target');
  } finally {
    if (holderPid && !(await ownedPidStopped(holderPid))) await waitFor(() => ownedPidStopped(holderPid), 'fixture holder cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

test('Linux adapter rejects contradictory Guardian receipts before retiring tree proof',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-guardian-receipt-contract-'));
  const artifactDirectory = join(root, 'linux-x64');
  const binaryFile = `soulforge-owned-process-guardian.${randomUUID()}`;
  const helper = join(artifactDirectory, binaryFile);
  const commandMarker = join(root, 'user-command-ran');
  const invalidReceipts = [
    ['failure-reason-with-proof', { code: 0, signal: null, childExitCode: 0, treeStopped: true,
      descendantsObserved: false, terminationReason: 'tree-unproven', spawnErrno: 0 }],
    ['capability-with-proof', { code: 0, signal: null, childExitCode: 0, treeStopped: true,
      descendantsObserved: false, terminationReason: 'guardian-capability-unavailable', spawnErrno: 38 }],
    ['child-state-with-proof', { code: 0, signal: null, childExitCode: 0, treeStopped: true,
      descendantsObserved: false, terminationReason: 'guardian-child-state-unavailable', spawnErrno: 5 }],
    ['spawn-error-zero', { code: 0, signal: null, childExitCode: 0, treeStopped: true,
      descendantsObserved: false, terminationReason: 'spawn-error', spawnErrno: 2 }],
    ['spawn-error-with-descendant', { code: 127, signal: null, childExitCode: 127, treeStopped: true,
      descendantsObserved: true, terminationReason: 'spawn-error', spawnErrno: 2 }],
    ['signal-code-mismatch', { code: 0, signal: 'SIGTERM', childExitCode: null, treeStopped: true,
      descendantsObserved: false, terminationReason: null, spawnErrno: 0 }],
    ['unlabelled-descendant', { code: 0, signal: null, childExitCode: 0, treeStopped: true,
      descendantsObserved: true, terminationReason: null, spawnErrno: 0 }],
    ['child-exit-code-mismatch', { code: 0, signal: null, childExitCode: 7, treeStopped: true,
      descendantsObserved: false, terminationReason: null, spawnErrno: 0 }]
  ];
  try {
    await mkdir(artifactDirectory);
    const cases = invalidReceipts.map(([kind, receipt]) => {
      const fields = { protocol: 'soulforge.owned-process-guardian.v1', nonce: '%s', ...receipt };
      return `  ${kind}) printf '${JSON.stringify(fields)}\\n' "$nonce" >&3 ;;`;
    }).join('\n');
    const helperBytes = Buffer.from(`#!/bin/sh\nnonce="$2"\ncase "$GUARDIAN_TEST_RECEIPT_KIND" in\n${cases}\n  *) exit 2 ;;\nesac\nexit 0\n`);
    const sourceBytes = await readFile(new URL('./owned-process-linux-guardian.c', import.meta.url));
    await writeFile(helper, helperBytes, { flag: 'wx', mode: 0o700 });
    await chmod(helper, 0o700);
    const sha256 = value => createHash('sha256').update(value).digest('hex');
    await writeFile(join(artifactDirectory, 'soulforge-owned-process-guardian.manifest.json'), JSON.stringify({
      schema: 'soulforge.owned-process-guardian-build.v2',
      protocol: 'soulforge.owned-process-guardian.v1', protocolVersion: 1,
      platform: 'linux', arch: 'x64', binaryFile, sourceSha256: sha256(sourceBytes), binarySha256: sha256(helperBytes),
      compiler: { command: 'fixture-only', version: 'receipt contract fixture',
        flags: ['-D_GNU_SOURCE', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'] }
    }), { flag: 'wx', mode: 0o600 });

    for (const [kind] of invalidReceipts) {
      const result = await runLinuxGuardianProcess({ command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'ran')`], cwd: root,
        env: { ...process.env, GUARDIAN_TEST_RECEIPT_KIND: kind } }, artifactDirectory);
      assert.equal(result.code, 1, `${kind} must never return successful driver status`);
      assert.equal(result.treeStopped, false, `${kind} cannot publish a tree proof`);
      assert.equal(result.outputError, 'OWNED_PROCESS_GUARDIAN_RECEIPT_INVALID', `${kind} must fail strict receipt validation`);
      await assert.rejects(readFile(commandMarker), error => error.code === 'ENOENT', 'fake Guardian never launches target argv');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an owned subprocess remains uncertain after its owner is killed and cannot be swept by a later owner', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-process-test-'));
  const writer = await fakeWriter(root);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {runProcess} from ${JSON.stringify(processModule)};
    const owner=await createOwnedTemporaryDirectory('process-test',{parent:${JSON.stringify(root)}});
    await runProcess({command:process.execPath,args:[${JSON.stringify(writer.script)}],cwd:owner.root,
      env:process.env,owner,timeoutMs:10000});
    await owner.dispose();`], { env: writer.env, stdio: ['ignore', 'ignore', 'inherit'] });
  let info, marker;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'writer start');
    marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    assert.ok(marker.childPids.length, 'ownership must be persisted before the child writer runs');
    assert.ok(marker.uncertainTrees.length, 'the Linux tree guard is armed before the child writer starts');
    await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('process-test', { parent: root }); await next.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'live orphan writer keeps its cwd');
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      try {
        const state = (await readFile(`/proc/${marker.childPids[0]}/stat`, 'utf8')).split(') ')[1].split(' ')[0];
        return state === 'Z';
      }
      catch (error) { return ['ENOENT', 'ESRCH'].includes(error.code); }
    }, 'supervisor completion');
    const afterWorkerExit = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    assert.ok(afterWorkerExit.uncertainTrees.length, 'a dead owner cannot publish the final normal-result receipt');
    const resumed = await createOwnedTemporaryDirectory('process-test', { parent: root }); await resumed.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'a later owner must not erase uncertainty left by the killed owner');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info && marker) {
      await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'interrupted fixture process exit');
      await retireStoppedTestRoot(info.root, marker.token);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a zero-exit supervisor with no result receipt is failed and retains its owned root', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-missing-result-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, { includeResult: false, closeCode: 0, closeSignal: null });
    assert.equal(closed.code, 1, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.notEqual(report.result.code, 0, 'a zero-exit close without a result is never a successful operation');
    assert.equal(report.success, false, 'processSucceeded must reject missing supervisor receipts');
    assert.match(report.result.terminationReason, /supervisor-exit/);
    assert.match(report.disposal[0], /OWNED_TEMP_PROCESS_UNCERTAIN/);
    assert.equal(report.roots[0].exists, true, 'uncertainty remains until an explicit proof exists');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a supervisor that sends a result but closes abnormally cannot release Linux uncertainty', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-close-mismatch-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 2, closeSignal: null,
      result: { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: null, treeStopped: true, descendantsObserved: false, childExitCode: 0 }
    });
    assert.equal(closed.code, 1, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 1);
    assert.match(report.result.terminationReason, /supervisor-exit/);
    assert.equal(report.success, false);
    assert.match(report.disposal[0], /OWNED_TEMP_PROCESS_UNCERTAIN/);
    assert.equal(report.roots[0].exists, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a normal nonzero child result with a complete composite-owner receipt keeps failure status and cleans normally', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-normal-receipt-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 7, closeSignal: null, ownerCount: 2,
      result: { code: 7, stdout: '', stderr: 'ordinary child failure', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: null, treeStopped: true, descendantsObserved: false, childExitCode: 7 }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 7);
    assert.equal(report.success, false, 'an ordinary nonzero driver remains a failure');
    assert.deepEqual(report.disposal, [null, null]);
    assert.deepEqual(report.roots.map(value => value.exists), [false, false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a normally signaled driver with complete tree proof remains a failure but can release Linux owners', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-normal-signal-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 143, closeSignal: null,
      result: { code: 143, childExitCode: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: 'SIGTERM', terminationReason: null,
        treeStopped: true, descendantsObserved: false }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 143);
    assert.equal(report.result.signal, 'SIGTERM');
    assert.equal(report.success, false, 'a normal signal exit remains an operation failure');
    assert.deepEqual(report.disposal, [null], 'complete ECHILD proof permits safe owner cleanup');
    assert.deepEqual(report.roots.map(value => value.exists), [false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: 'exit-zero', args: ['-e', 'process.exit(0)'], code: 0, childExitCode: 0, signal: null, reason: null },
  { name: 'exit-seven', args: ['-e', 'process.exit(7)'], code: 7, childExitCode: 7, signal: null, reason: null },
  { name: 'signal-term', args: ['-e', 'process.kill(process.pid, "SIGTERM")'], code: 143,
    childExitCode: null, signal: 'SIGTERM', reason: null },
  { name: 'exec-missing', missingCommand: true, args: [], code: 127, childExitCode: 127,
    signal: null, reason: 'spawn-error', outputError: 'OWNED_PROCESS_GUARDIAN_SPAWN_ERROR' }
]) {
  test(`real Linux Guardian ${scenario.name} carries tree proof and retires its owner`,
    { skip: !linuxX64 && 'Linux x64 Guardian only' }, async () => {
    const root = await mkdtemp(join(tmpdir(), `sf-owned-real-exit-${scenario.name}-`));
    let owner, disposed = false, safeToRemoveRoot = true;
    try {
      owner = await createOwnedTemporaryDirectory('real-exit-proof', { parent: root });
      const command = scenario.missingCommand ? join(root, `missing-executable-${randomUUID()}`) : process.execPath;
      const result = await runProcess({ command, args: scenario.args, cwd: owner.root, env: process.env,
        owner, timeoutMs: 15_000 });
      assert.equal(result.code, scenario.code, result.stderr);
      assert.equal(result.childExitCode, scenario.childExitCode);
      assert.equal(result.signal, scenario.signal);
      assert.equal(result.terminationReason, scenario.reason);
      assert.equal(result.treeStopped, true, 'only Guardian completion proof permits owner retirement');
      assert.equal(result.descendantsObserved, false);
      assert.equal(result.outputError, scenario.outputError);
      await owner.dispose();
      disposed = true;
      await assert.rejects(lstat(owner.root), error => error.code === 'ENOENT');
    } finally {
      if (owner && !disposed) {
        try { await owner.dispose(); disposed = true; }
        catch { safeToRemoveRoot = false; }
      }
      if (safeToRemoveRoot) await rm(root, { recursive: true, force: true });
    }
  });
}

test('a complete normal zero result clears each composite Linux owner after normal supervisor close', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-normal-success-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 0, closeSignal: null, ownerCount: 2,
      result: { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: null, treeStopped: true, descendantsObserved: false, childExitCode: 0 }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 0);
    assert.equal(report.success, true);
    assert.deepEqual(report.disposal, [null, null]);
    assert.deepEqual(report.roots.map(value => value.exists), [false, false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a zero-exit receipt without Guardian ECHILD proof is failed and retains Linux owners', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-no-tree-proof-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 0, closeSignal: null,
      result: { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: null }
    });
    assert.equal(closed.code, 1, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 1);
    assert.equal(report.result.outputError, 'OWNED_PROCESS_TREE_UNPROVEN');
    assert.equal(report.success, false);
    assert.match(report.disposal[0], /OWNED_TEMP_PROCESS_UNCERTAIN/);
    assert.equal(report.roots[0].exists, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a contradictory complete IPC treeStopped receipt cannot pass or release composite Linux owners', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-contradictory-tree-proof-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 0, closeSignal: null, ownerCount: 2,
      result: { code: 0, childExitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: 'tree-unproven',
        treeStopped: true, descendantsObserved: false }
    });
    assert.equal(closed.code, 1, closed.stderr);
    assert.match(closed.stderr, /OWNED_TEMP_PROCESS_UNCERTAIN/);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 1);
    assert.equal(report.result.treeStopped, false, 'contradictory IPC cannot retain a proof-shaped success field');
    assert.equal(report.result.terminationReason, 'tree-unproven');
    assert.equal(report.result.outputError, 'OWNED_PROCESS_TREE_UNPROVEN');
    assert.equal(report.success, false);
    assert.equal(report.disposal.length, 2);
    assert.ok(report.disposal.every(error => /OWNED_TEMP_PROCESS_UNCERTAIN/.test(error ?? '')));
    assert.deepEqual(report.roots.map(value => value.exists), [true, true], 'all composite owners remain retained');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reaped descendant receipt fails the operation but permits safe owner cleanup', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-descendant-proof-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 1, closeSignal: null,
      result: { code: 1, childExitCode: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: 'descendant-leak',
        outputError: 'OWNED_TEST_DESCENDANT_LEAKED', treeStopped: true, descendantsObserved: true }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 1);
    assert.equal(report.result.childExitCode, 0);
    assert.equal(report.success, false);
    assert.deepEqual(report.disposal, [null]);
    assert.deepEqual(report.roots.map(value => value.exists), [false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an inherited descendant fails the run but Guardian proof permits owner cleanup',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-inherited-descendant-test-'));
  const writer = await fakeWriter(root);
  const driver = join(root, 'driver.cjs');
  await writeFile(driver, `const fs=require('node:fs');const {spawn}=require('node:child_process');` +
    `const child=spawn(process.execPath,[${JSON.stringify(writer.script)}],{stdio:'ignore',env:process.env});child.unref();` +
    `const until=Date.now()+5000,wait=new Int32Array(new SharedArrayBuffer(4));` +
    `while(!fs.existsSync(process.env.READY)&&Date.now()<until)Atomics.wait(wait,0,0,10);` +
    `process.exit(fs.existsSync(process.env.READY)?0:2);`);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {runProcess} from ${JSON.stringify(processModule)};
    const owner=await createOwnedTemporaryDirectory('inherited-descendant-test',{parent:${JSON.stringify(root)}});
    const result=await runProcess({command:process.execPath,args:[${JSON.stringify(driver)}],cwd:owner.root,
      env:process.env,owner,timeoutMs:10000});
    process.send({type:'result',root:owner.root,result});
    await new Promise(resolve=>process.once('message',resolve));
    let disposeError=null;try{await owner.dispose();}catch(error){disposeError=error.message;}
    process.send({type:'disposed',disposeError});setInterval(()=>{},1000);`],
    { env: writer.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const resultMessage = once(wrapper, 'message');
  let info, report, disposed = false, safeToRemoveRoot = true;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'inherited descendant');
    [report] = await resultMessage;
    assert.equal(report.type, 'result');
    assert.equal(report.result.code, 1, 'driver success does not hide the surviving inherited descendant');
    assert.equal(report.result.childExitCode, 0);
    assert.equal(report.result.terminationReason, 'descendant-leak');
    assert.equal(report.result.outputError, 'OWNED_TEST_DESCENDANT_LEAKED');
    assert.equal(report.result.treeStopped, true, 'treeStopped requires Guardian ECHILD, not group state');
    assert.equal(report.result.descendantsObserved, true);
    assert.equal(await ownedPidStopped(info.pid), true, 'inherited descendant is reaped before the failed result returns');
    assert.ok((await lstat(report.root)).isDirectory(), 'the owner remains until its explicit disposal step');

    const disposedMessage = once(wrapper, 'message');
    wrapper.send({ type: 'dispose' });
    const [disposal] = await disposedMessage;
    assert.equal(disposal.type, 'disposed');
    assert.equal(disposal.disposeError, null, 'full proof permits safe cleanup despite a failed operation result');
    disposed = true;
    await assert.rejects(lstat(report.root), error => error.code === 'ENOENT');
  } finally {
    await writeFile(writer.release, 'done');
    if (info && !(await ownedPidStopped(info.pid))) {
      try { await waitFor(() => ownedPidStopped(info.pid), 'inherited descendant natural fixture stop'); }
      catch { safeToRemoveRoot = false; }
    }
    await stop(wrapper);
    if (!disposed) safeToRemoveRoot = false;
    if (safeToRemoveRoot) await rm(root, { recursive: true, force: true });
  }
});

test('successful driver with a multi-generation setsid descendant fails after Guardian reaps a TERM-ignoring writer',
  { skip: !linuxX64 && 'Linux x64 guardian only' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-setsid-descendant-test-'));
  const writer = await fakeWriter(root);
  const leaderReady = join(root, 'leader-ready.json');
  const leader = join(root, 'session-leader.cjs');
  const driver = join(root, 'driver.cjs');
  // The writer deliberately ignores TERM but exits by itself shortly afterward.
  // A broken pre-guardian path therefore has a bounded cleanup window without
  // converting the actual escaped-process assertion into a silent timeout.
  await writeFile(writer.script, `const fs=require('node:fs');
    const root=process.env.SOULFORGE_TEST_BUILD_ROOT || process.cwd();
    process.on('SIGTERM',()=>{});
    fs.writeFileSync(process.env.READY, JSON.stringify({root,pid:process.pid}));
    const stopAt=Date.now()+3000;
    const timer=setInterval(()=>{fs.writeFileSync(root+'/still-writing','live');
      if(fs.existsSync(process.env.RELEASE)||Date.now()>=stopAt){clearInterval(timer);process.exit(0);}},25);`);
  await writeFile(leader, `const fs=require('node:fs');
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,[${JSON.stringify(writer.script)}],{stdio:'ignore',env:process.env,detached:false});
    child.unref();
    fs.writeFileSync(process.env.LEADER_READY,JSON.stringify({pid:process.pid,childPid:child.pid}));
    const stopAt=Date.now()+3000;setInterval(()=>{if(Date.now()>=stopAt)process.exit(0);},25);`);
  await writeFile(driver, `const fs=require('node:fs');
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,[${JSON.stringify(leader)}],{stdio:'ignore',env:process.env,detached:true});
    child.unref();
    const until=Date.now()+5000, wait=new Int32Array(new SharedArrayBuffer(4));
    while((!fs.existsSync(process.env.READY)||!fs.existsSync(process.env.LEADER_READY)) && Date.now()<until) Atomics.wait(wait,0,0,10);
    process.exit(fs.existsSync(process.env.READY)&&fs.existsSync(process.env.LEADER_READY)?0:2);`);
  const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  let owner, info, leaderInfo, removeFixture = true;
  try {
    owner = await createOwnedTemporaryDirectory('setsid-descendant-test', { parent: root });
    const result = await runOwnedProcess({ command: process.execPath, args: [driver], cwd: owner.root,
      env: { ...writer.env, LEADER_READY: leaderReady, SOULFORGE_TEST_BUILD_ROOT: owner.root }, owner, timeoutMs: 10_000 });
    info = JSON.parse(await readFile(writer.ready, 'utf8'));
    leaderInfo = JSON.parse(await readFile(leaderReady, 'utf8'));
    assert.equal(info.root, owner.root);
    assert.equal(result.code, 1, 'successful driver with an escaped live descendant is not a pass');
    assert.equal(result.childExitCode, 0, 'retain the driver exit fact in the failed result');
    assert.equal(result.outputError, 'OWNED_TEST_DESCENDANT_LEAKED');
    assert.equal(result.terminationReason, 'descendant-leak');
    assert.equal(result.treeStopped, true, 'only a completed Guardian ECHILD proof can release this tree');
    assert.equal(result.descendantsObserved, true);
    assert.equal(await ownedPidStopped(leaderInfo.pid), true, 'the detached session leader must be stopped before return');
    assert.equal(await ownedPidStopped(info.pid), true, 'the TERM-ignoring grandchild must be reaped before return');
    assert.equal(await ownedPidStopped(neighbor.pid), false, 'a process outside the Guardian child tree must survive');
    await owner.dispose();
    await assert.rejects(lstat(owner.root), error => error.code === 'ENOENT');
  } finally {
    await writeFile(writer.release, 'done');
    if ((leaderInfo && !(await ownedPidStopped(leaderInfo.pid))) || (info && !(await ownedPidStopped(info.pid)))) {
      try { await waitFor(async () => (!leaderInfo || await ownedPidStopped(leaderInfo.pid))
        && (!info || await ownedPidStopped(info.pid)), 'bounded multi-generation fixture natural stop'); }
      catch { removeFixture = false; }
    }
    await stop(neighbor);
    if (owner) {
      try { await owner.dispose(); }
      catch {
        if (!info || !(await ownedPidStopped(info.pid)) || (leaderInfo && !(await ownedPidStopped(leaderInfo.pid)))) removeFixture = false;
        else {
          const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
          try { await retireStoppedTestRoot(owner.root, marker.token); }
          catch { removeFixture = false; }
        }
      }
      try { await lstat(owner.root); removeFixture = false; } catch (error) { if (error.code !== 'ENOENT') removeFixture = false; }
    }
    if (removeFixture) await rm(root, { recursive: true, force: true });
  }
});

test('owned Linux cancellation and timeout retain the tree until stopped evidence is explicitly repaired', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-cancellation-test-'));
  let safeToRemoveRoot = true;
  try {
    for (const kind of ['cancelled', 'timeout']) {
      const writer = await fakeWriter(root);
      const owner = await createOwnedTemporaryDirectory('cancel-test', { parent: root });
      const ticket = { root: owner.root, token: JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8')).token };
      const controller = new AbortController();
      let work;
      try {
        work = runProcess({ command: process.execPath, args: [writer.script], cwd: owner.root,
        env: writer.env, owner, signal: controller.signal, timeoutMs: kind === 'timeout' ? 200 : 5000 });
        await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'cancellable writer');
        if (kind === 'cancelled') controller.abort();
        const result = await work;
        assert.equal(result.terminationReason, kind);
        assert.equal(result.cancelled, kind === 'cancelled');
        assert.equal(result.timedOut, kind === 'timeout');
        const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.ok(Array.isArray(marker.uncertainTrees) && marker.uncertainTrees.length > 0,
          'an interrupted Linux owner remains explicitly uncertain');
        await assert.rejects(owner.dispose(), /OWNED_TEMP_PROCESS_UNCERTAIN/);
        assert.equal((await lstat(owner.root)).isDirectory(), true, 'cancel/timeout must retain its owned root');
      } finally {
        controller.abort();
        if (work) await work;
        try { await retireStoppedTestRoot(owner.root, ticket.token); }
        catch (error) { safeToRemoveRoot = false; throw error; }
        await rm(writer.ready, { force: true });
      }
    }
  } finally { if (safeToRemoveRoot) await rm(root, { recursive: true, force: true }); }
});

test('desktop npm child retains owned output after its owner loses the completion receipt', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-desktop-process-test-'));
  const writer = await fakeWriter(root);
  await mkdir(join(root, 'apps/desktop'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/desktop'] }));
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ name: '@soulforge/desktop', scripts: { build: 'node ../../writer.cjs' } }));
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withDesktopTestBuild} from ${JSON.stringify(desktopModule)};
    await withDesktopTestBuild('database',async()=>{}, {repositoryRoot:${JSON.stringify(root)}});`],
    { env: writer.env, stdio: ['ignore', 'ignore', 'inherit'] });
  let info, marker;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'npm child');
    marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    await stop(wrapper);
    await withDesktopTestBuild('database', async () => assert.ok((await lstat(info.root)).isDirectory()), { repositoryRoot: root, build: false });
    await writeFile(writer.release, 'done');
    await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'desktop fixture process exit');
    await withDesktopTestBuild('database', async () => {}, { repositoryRoot: root, build: false });
    assert.ok((await lstat(info.root)).isDirectory(), 'the interrupted owner has no completion receipt, so restart sweep must retain it');
    assert.ok(JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8')).uncertainTrees.length);
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info && marker) {
      await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'desktop fixture process exit before cleanup');
      await retireStoppedTestRoot(info.root, marker.token);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('hksc fake compiler retains scratch after wrapper interruption without a completion receipt', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-hksc-process-test-'));
  const writer = await fakeWriter(root);
  const cc = join(root, 'fake-cc');
  await writeFile(cc, `#!/bin/sh\nexec ${process.execPath} ${writer.script}\n`); await chmod(cc, 0o700);
  const wrapper = spawn(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', join(root, 'output')], {
    env: { ...writer.env, SOULFORGE_CC: cc, TMPDIR: root }, stdio: ['ignore', 'ignore', 'inherit']
  });
  let info, marker;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'compiler start');
    marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('hksc-build', { parent: root }); await next.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'live compiler retains its working directory');
    await writeFile(writer.release, 'done');
    await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'fake compiler process exit');
    const resumed = await createOwnedTemporaryDirectory('hksc-build', { parent: root }); await resumed.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'the killed owner cannot release uncertainty after its writer exits');
    assert.ok(JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8')).uncertainTrees.length);
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info && marker) {
      await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'fake compiler process exit before cleanup');
      await retireStoppedTestRoot(info.root, marker.token);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('desktop launched runtime retains its profile/output after owner interruption without a receipt', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-desktop-runtime-test-'));
  const writer = await fakeWriter(root);
  await mkdir(join(root, 'apps/desktop'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/desktop'] }));
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ name: '@soulforge/desktop', scripts: { build: 'node ../../build.cjs' } }));
  await writeFile(join(root, 'build.cjs'), `const fs=require('node:fs');const path=require('node:path');
    const main=path.join(process.env.SOULFORGE_TEST_BUILD_ROOT,'main');fs.mkdirSync(main,{recursive:true});
    fs.copyFileSync(${JSON.stringify(writer.script)},path.join(main,'runtime.cjs'));`);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {runDesktopSmoke} from ${JSON.stringify(desktopModule)};
    await runDesktopSmoke('database','runtime.cjs',process.execPath,{repositoryRoot:${JSON.stringify(root)}});`],
    { env: writer.env, stdio: ['ignore', 'ignore', 'inherit'] });
  let info, marker;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'desktop runtime');
    marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    await stop(wrapper);
    await withDesktopTestBuild('database', async () => {
      assert.ok((await lstat(info.root)).isDirectory());
      assert.ok((await lstat(join(info.root, '.runtime/electron-user-data'))).isDirectory());
    }, { repositoryRoot: root, build: false });
    await writeFile(writer.release, 'done');
    await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'desktop runtime process exit');
    await withDesktopTestBuild('database', async () => {}, { repositoryRoot: root, build: false });
    assert.ok((await lstat(info.root)).isDirectory(), 'restart cleanup must preserve an owner without a completion receipt');
    assert.ok(JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8')).uncertainTrees.length);
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info && marker) {
      await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'desktop runtime process exit before cleanup');
      await retireStoppedTestRoot(info.root, marker.token);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('hksc forwards termination and retains scratch without a normal result receipt', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-hksc-cancellation-test-'));
  const writer = await fakeWriter(root);
  const cc = join(root, 'fake-cc');
  await writeFile(cc, `#!/bin/sh\nexec ${process.execPath} ${writer.script}\n`); await chmod(cc, 0o700);
  const wrapper = spawn(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', join(root, 'output')], {
    env: { ...writer.env, SOULFORGE_CC: cc, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let info, marker, stderr = ''; wrapper.stderr.on('data', chunk => { stderr += chunk; });
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'hksc cancellation');
    marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    const closed = once(wrapper, 'close'); wrapper.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 1);
    assert.match(stderr, /cancelled/, 'cleanup failure must not erase the original cancellation fact');
    assert.match(stderr, /OWNED_TEMP_PROCESS_UNCERTAIN/, 'the retained scratch cleanup failure must remain visible too');
    assert.ok((await lstat(info.root)).isDirectory(), 'cancellation without a normal receipt must retain compiler scratch');
    assert.ok(marker.uncertainTrees.length);
    await writeFile(writer.release, 'done');
    await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'cancelled compiler process exit');
    const resumed = await createOwnedTemporaryDirectory('hksc-build', { parent: root }); await resumed.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'a later owner cannot infer the detached tree is safe to delete');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info && marker) {
      await waitFor(async () => (await Promise.all(marker.childPids.map(ownedPidStopped))).every(Boolean), 'cancelled compiler process exit before cleanup');
      await retireStoppedTestRoot(info.root, marker.token);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('Windows normal driver completion atomically records a finished proof in a Unicode path', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf Windows 完成 proof '));
  try {
    const owner = await createOwnedTemporaryDirectory('windows-completion', { parent: root });
    try {
      const result = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'],
        cwd: owner.root, env: process.env, owner, timeoutMs: 15000 });
      assert.equal(result.code, 0, result.stderr);
      const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(marker.windowsJobs.length, 1);
      const proof = JSON.parse(await readFile(join(owner.root, `.soulforge-windows-job.${marker.windowsJobs[0].id}.json`), 'utf8'));
      assert.equal(proof.state, 'finished');
      assert.equal(proof.killOnClose, true);
      assert.ok(!(await readdir(owner.root)).some(name => name.endsWith('.next')));
    } finally { await owner.dispose(); }
    await assert.rejects(lstat(owner.root), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows finished proof uses a short pending path when the legacy name exceeds MAX_PATH', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
  const outer = await mkdtemp(join(tmpdir(), 'sf-wjob-max-path-'));
  let owner, ownerRoot;
  try {
    // The checker gives each operation a private TEMP. Choose a fixed parent
    // length so the final proof remains below MAX_PATH while the old appended
    // GUID suffix would put the pending sibling above it.
    const base = resolve(outer), parentLength = 125;
    const paddingLength = parentLength - base.length - 1;
    assert.ok(paddingLength > 0 && paddingLength < 240, 'the owned test TEMP must leave room for a bounded path probe');
    const parent = join(base, 'p'.repeat(paddingLength));
    assert.equal(parent.length, parentLength);
    await mkdir(parent);
    owner = await createOwnedTemporaryDirectory('windows-job-path-limit', { parent });
    ownerRoot = owner.root;
    const sentinelId = '00000000-0000-0000-0000-000000000000';
    const legacyProof = join(owner.root, '.soulforge-windows-job.' + sentinelId + '.json');
    const legacyPending = legacyProof + '.' + sentinelId + '.next';
    const shortPending = join(owner.root, '.sf-wjob.' + sentinelId + '.next');
    assert.ok(legacyProof.length < 260, 'the owner identity and published proof path must remain valid');
    assert.ok(legacyPending.length > 260, 'the former appended-GUID pending name must cross MAX_PATH');
    assert.ok(shortPending.length < 260, 'the same-directory random pending basename must remain bounded');

    const result = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'],
      cwd: owner.root, env: process.env, owner, timeoutMs: 15000 });
    assert.equal(result.code, 0, result.stderr);
    const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
    assert.equal(marker.windowsJobs.length, 1);
    const proofPath = join(owner.root, '.soulforge-windows-job.' + marker.windowsJobs[0].id + '.json');
    assert.ok(proofPath.length < 260);
    assert.equal(JSON.parse(await readFile(proofPath, 'utf8')).state, 'finished');
    assert.ok(!(await readdir(owner.root)).some(name => name.endsWith('.next')));
    await owner.dispose(); owner = undefined;
    await assert.rejects(lstat(ownerRoot), { code: 'ENOENT' });
  } finally {
    if (owner) await owner.dispose();
    await rm(outer, { recursive: true, force: true });
  }
});
test('Windows finished proof survives a temporary reader without exposing partial JSON', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-windows-proof-reader-'));
  const owner = await createOwnedTemporaryDirectory('windows-proof-reader', { parent: root });
  const driverReady = join(root, 'driver-ready'), driverRelease = join(root, 'driver-release');
  const readerReady = join(root, 'reader-ready'), readerRelease = join(root, 'reader-release');
  let reader, running, readerClosed;
  try {
    running = runProcess({ command: process.execPath, args: ['-e', `
      const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(driverReady)},'ready');
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(driverRelease)})){clearInterval(timer);process.exit(0);}},10);`],
      cwd: owner.root, env: process.env, owner, timeoutMs: 15000 });
    await waitFor(() => readFile(driverReady, 'utf8'), 'driver behind assigned proof');
    const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
    const path = join(owner.root, `.soulforge-windows-job.${marker.windowsJobs[0].id}.json`);
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const source = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
      $reader=[IO.File]::Open(${quote(path)},[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);
      try {[IO.File]::WriteAllText(${quote(readerReady)},'ready');$until=[DateTime]::UtcNow.AddSeconds(10);
        while(-not [IO.File]::Exists(${quote(readerRelease)})) {
          if([DateTime]::UtcNow -gt $until){throw 'reader release timed out'};[Threading.Thread]::Sleep(10)
        }
      } finally {$reader.Dispose()}`;
    reader = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    readerClosed = once(reader, 'close');
    let readerError = ''; reader.stderr.on('data', chunk => { readerError += chunk; });
    await waitFor(() => readFile(readerReady, 'utf8'), 'proof reader lock');
    await writeFile(driverRelease, 'done');
    const observation = await Promise.race([
      waitFor(async () => (await readdir(owner.root)).find(name => name.startsWith('.sf-wjob.') && name.endsWith('.next')), 'pending finished proof')
        .then(pending => ({ kind: 'pending', pending }), error => ({ kind: 'timeout', error })),
      running.then(result => ({ kind: 'writer', result }), error => ({ kind: 'writer-error', error }))
    ]);
    if (observation.kind !== 'pending') {
      // Do not hide an early PowerShell failure behind the pending-file timeout.
      await writeFile(readerRelease, 'done');
      await readerClosed;
      const result = observation.kind === 'writer' ? observation.result
        : await running.catch(error => ({ code: null, stderr: error.message }));
      let finalState;
      try { finalState = JSON.parse(await readFile(path, 'utf8')).state; }
      catch (error) { finalState = 'unreadable: ' + error.message; }
      const cause = observation.kind === 'timeout' ? observation.error.message
        : observation.kind === 'writer-error' ? observation.error.message : 'writer completed before pending was visible';
      throw new Error(cause + '; writer code=' + result.code + '; stderr=' + result.stderr + '; final proof=' + finalState);
    }
    const pending = observation.pending;
    // The reader denies delete-sharing. Publication must keep the old receipt
    // intact until an atomic replacement can succeed, not truncate/delete it.
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'assigned');
    assert.equal(JSON.parse(await readFile(join(owner.root, pending), 'utf8')).state, 'finished');
    await delay(75);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'assigned');
    await writeFile(readerRelease, 'done');
    assert.equal((await readerClosed)[0], 0, readerError);
    const result = await running;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'finished');
    assert.ok(!(await readdir(owner.root)).some(name => name.endsWith('.next')));
  } finally {
    await writeFile(readerRelease, 'done'); await writeFile(driverRelease, 'done');
    await stop(reader); if (running) await running.catch(() => {});
    await owner.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test('Windows owned job ends lingering descendants after successful and failed drivers', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-windows-job-test-'));
  try {
    for (const code of [0, 9]) {
      const owner = await createOwnedTemporaryDirectory('windows-job', { parent: root });
      const ready = join(root, `descendant-${code}.json`);
      const descendant = join(root, `descendant-${code}.cjs`), driver = join(root, `driver-${code}.cjs`);
      await writeFile(descendant, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>fs.writeFileSync('still-writing','live'),25);`);
      await writeFile(driver, `const fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(t);process.exit(${code});}},20);`);
      const result = await runProcess({ command: process.execPath, args: [driver], cwd: owner.root,
        env: process.env, owner, timeoutMs: 15000 });
      assert.equal(result.code, code, result.stderr);
      const { pid } = JSON.parse(await readFile(ready, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'job termination includes the descendant after driver exit');
      const marker = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(marker.windowsJobs.length, 1);
      const proof = JSON.parse(await readFile(join(owner.root, `.soulforge-windows-job.${marker.windowsJobs[0].id}.json`), 'utf8'));
      assert.equal(proof.state, 'finished'); assert.equal(proof.killOnClose, true);
      await owner.dispose(); await assert.rejects(lstat(owner.root), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows owner interruption preserves live writers and reclaims only a stopped owned job', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-windows-interruption-'));
  const writer = await fakeWriter(root);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {runProcess} from ${JSON.stringify(processModule)};
    const owner=await createOwnedTemporaryDirectory('windows-interruption',{parent:${JSON.stringify(root)}});
    await runProcess({command:process.execPath,args:[${JSON.stringify(writer.script)}],cwd:owner.root,env:process.env,owner,timeoutMs:15000});
    await owner.dispose();`], { env: writer.env, stdio: ['ignore', 'ignore', 'pipe'] });
  let info, stderr = ''; wrapper.stderr.on('data', chunk => { stderr += chunk; });
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), `Windows job assignment: ${stderr}`);
    const marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    assert.equal(marker.windowsJobs.length, 1);
    const proof = JSON.parse(await readFile(join(info.root, `.soulforge-windows-job.${marker.windowsJobs[0].id}.json`), 'utf8'));
    assert.equal(proof.state, 'assigned');
    assert.equal(proof.killOnClose, true);
    await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('windows-interruption', { parent: root }); await next.dispose();
    let retained;
    try { retained = (await lstat(info.root)).isDirectory(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; retained = false; }
    if (!retained) {
      // The sole guardian can also stop on owner interruption. Its kill-on-close
      // job makes reclamation safe only after both driver and writer have ended.
      for (const pid of new Set([info.pid, proof.driverPid, proof.guardianPid])) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `reclaimed root still has live job PID ${pid}`);
      }
    } else {
      assert.ok((await lstat(info.root)).isDirectory(), 'an unfinished job keeps its owned root');
    }
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      const resumed = await createOwnedTemporaryDirectory('windows-interruption', { parent: root }); await resumed.dispose();
      try { await lstat(info.root); return false; } catch (error) { return error.code === 'ENOENT'; }
    }, 'Windows job restart reclamation');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});
