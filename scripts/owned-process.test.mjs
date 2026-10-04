import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import { withDesktopTestBuild } from './desktop-test-build.mjs';
import { runProcess } from './subprocess-control.mjs';

const linux = process.platform === 'linux';
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
        cancelled: false, timedOut: false, signal: null, terminationReason: null }
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
        cancelled: false, timedOut: false, signal: null, terminationReason: null }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 7);
    assert.equal(report.success, false, 'an ordinary nonzero driver remains a failure');
    assert.deepEqual(report.disposal, [null, null]);
    assert.deepEqual(report.roots.map(value => value.exists), [false, false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a complete normal zero result clears each composite Linux owner after normal supervisor close', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-normal-success-test-'));
  try {
    const closed = await runIsolatedSupervisorCloseScenario(root, {
      includeResult: true, closeCode: 0, closeSignal: null, ownerCount: 2,
      result: { code: 0, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false,
        cancelled: false, timedOut: false, signal: null, terminationReason: null }
    });
    assert.equal(closed.code, 0, closed.stderr);
    const report = JSON.parse(closed.stdout.trim());
    assert.equal(report.result.code, 0);
    assert.equal(report.success, true);
    assert.deepEqual(report.disposal, [null, null]);
    assert.deepEqual(report.roots.map(value => value.exists), [false, false]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an inherited descendant keeps the owned process group alive after its driver exits', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-descendant-test-'));
  const writer = await fakeWriter(root);
  const driver = join(root, 'driver.cjs');
  await writeFile(driver, `require('node:child_process').spawn(process.execPath,[${JSON.stringify(writer.script)}],{stdio:'ignore',env:process.env});process.exit(0);`);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {runProcess} from ${JSON.stringify(processModule)};
    const owner=await createOwnedTemporaryDirectory('descendant-test',{parent:${JSON.stringify(root)}});
    await runProcess({command:process.execPath,args:[${JSON.stringify(driver)}],cwd:owner.root,env:process.env,owner,timeoutMs:10000});
    process.send(owner.root);setInterval(()=>{},1000);`], { env: writer.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let info;
  try {
    const completed = once(wrapper, 'message');
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'inherited descendant');
    await completed; await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('descendant-test', { parent: root }); await next.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'a dead driver does not imply a dead inherited group');
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      const resumed = await createOwnedTemporaryDirectory('descendant-test', { parent: root }); await resumed.dispose();
      try { await lstat(info.root); return false; } catch (error) { return error.code === 'ENOENT'; }
    }, 'dead inherited group reclamation');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
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
