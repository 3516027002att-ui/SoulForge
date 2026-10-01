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

test('an owned subprocess is recorded before writing and survives its wrapper being killed', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-process-test-'));
  const writer = await fakeWriter(root);
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
    import {runProcess} from ${JSON.stringify(processModule)};
    const owner=await createOwnedTemporaryDirectory('process-test',{parent:${JSON.stringify(root)}});
    await runProcess({command:process.execPath,args:[${JSON.stringify(writer.script)}],cwd:owner.root,
      env:process.env,owner,timeoutMs:10000});
    await owner.dispose();`], { env: writer.env, stdio: ['ignore', 'ignore', 'inherit'] });
  let info;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'writer start');
    const marker = JSON.parse(await readFile(join(info.root, '.soulforge-temporary-owner.json'), 'utf8'));
    assert.ok(marker.childPids.length, 'ownership must be persisted before the child writer runs');
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
    const resumed = await createOwnedTemporaryDirectory('process-test', { parent: root }); await resumed.dispose();
    await assert.rejects(lstat(info.root), { code: 'ENOENT' });
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
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

test('owned cancellation and timeout terminate the writer group and permit cleanup', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-owned-cancellation-test-'));
  try {
    for (const kind of ['cancelled', 'timeout']) {
      const writer = await fakeWriter(root);
      const owner = await createOwnedTemporaryDirectory('cancel-test', { parent: root });
      const controller = new AbortController();
      const work = runProcess({ command: process.execPath, args: [writer.script], cwd: owner.root,
        env: writer.env, owner, signal: controller.signal, timeoutMs: kind === 'timeout' ? 200 : 5000 });
      await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'cancellable writer');
      if (kind === 'cancelled') controller.abort();
      const result = await work;
      assert.equal(result.terminationReason, kind);
      assert.equal(result.cancelled, kind === 'cancelled');
      assert.equal(result.timedOut, kind === 'timeout');
      await owner.dispose(); await assert.rejects(lstat(owner.root), { code: 'ENOENT' });
      await rm(writer.ready, { force: true });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('desktop npm child retains owned output after wrapper interruption', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-desktop-process-test-'));
  const writer = await fakeWriter(root);
  await mkdir(join(root, 'apps/desktop'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/desktop'] }));
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ name: '@soulforge/desktop', scripts: { build: 'node ../../writer.cjs' } }));
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', `
    import {withDesktopTestBuild} from ${JSON.stringify(desktopModule)};
    await withDesktopTestBuild('database',async()=>{}, {repositoryRoot:${JSON.stringify(root)}});`],
    { env: writer.env, stdio: ['ignore', 'ignore', 'inherit'] });
  let info;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'npm child');
    await stop(wrapper);
    await withDesktopTestBuild('database', async () => assert.ok((await lstat(info.root)).isDirectory()), { repositoryRoot: root, build: false });
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      await withDesktopTestBuild('database', async () => {}, { repositoryRoot: root, build: false });
      return !(await readdir(join(root, 'output/desktop-smoke-builds'))).length;
    }, 'desktop restart reclamation');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('hksc fake compiler retains scratch after wrapper interruption and restart reclaims it', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-hksc-process-test-'));
  const writer = await fakeWriter(root);
  const cc = join(root, 'fake-cc');
  await writeFile(cc, `#!/bin/sh\nexec ${process.execPath} ${writer.script}\n`); await chmod(cc, 0o700);
  const wrapper = spawn(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', join(root, 'output')], {
    env: { ...writer.env, SOULFORGE_CC: cc, TMPDIR: root }, stdio: ['ignore', 'ignore', 'inherit']
  });
  let info;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'compiler start');
    await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('hksc-build', { parent: root }); await next.dispose();
    assert.ok((await lstat(info.root)).isDirectory(), 'live compiler retains its working directory');
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      const resumed = await createOwnedTemporaryDirectory('hksc-build', { parent: root }); await resumed.dispose();
      try { await lstat(info.root); return false; } catch (error) { return error.code === 'ENOENT'; }
    }, 'compiler restart reclamation');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('desktop launched runtime retains its profile/output after wrapper interruption', { skip: !linux }, async () => {
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
  let info;
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'desktop runtime');
    await stop(wrapper);
    await withDesktopTestBuild('database', async () => {
      assert.ok((await lstat(info.root)).isDirectory());
      assert.ok((await lstat(join(info.root, '.runtime/electron-user-data'))).isDirectory());
    }, { repositoryRoot: root, build: false });
    await writeFile(writer.release, 'done');
    await waitFor(async () => {
      await withDesktopTestBuild('database', async () => {}, { repositoryRoot: root, build: false });
      return !(await readdir(join(root, 'output/desktop-smoke-builds'))).length;
    }, 'runtime restart reclamation');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
});

test('hksc forwards supported termination and cleans its compiler scratch', { skip: !linux }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-hksc-cancellation-test-'));
  const writer = await fakeWriter(root);
  const cc = join(root, 'fake-cc');
  await writeFile(cc, `#!/bin/sh\nexec ${process.execPath} ${writer.script}\n`); await chmod(cc, 0o700);
  const wrapper = spawn(process.execPath, [resolve('scripts/build-first-party-hksc-native.mjs'), '--output', join(root, 'output')], {
    env: { ...writer.env, SOULFORGE_CC: cc, TMPDIR: root }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let info, stderr = ''; wrapper.stderr.on('data', chunk => { stderr += chunk; });
  try {
    info = await waitFor(async () => JSON.parse(await readFile(writer.ready, 'utf8')), 'hksc cancellation');
    const closed = once(wrapper, 'close'); wrapper.kill('SIGTERM');
    const [code] = await closed;
    assert.equal(code, 1); assert.match(stderr, /cancelled/);
    await assert.rejects(lstat(info.root), { code: 'ENOENT' });
    const stat = await readFile(`/proc/${info.pid}/stat`, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    assert.ok(stat === null || stat.split(') ')[1].startsWith('Z '), 'compiler must be stopped');
  } finally {
    await writeFile(writer.release, 'done'); await stop(wrapper);
    if (info) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
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

test('Windows owner interruption preserves an assigned job until its writer ends', { skip: process.platform !== 'win32' && 'Windows job API unavailable' }, async () => {
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
    await stop(wrapper);
    const next = await createOwnedTemporaryDirectory('windows-interruption', { parent: root }); await next.dispose();
    assert.ok((await lstat(info.root)).isDirectory());
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
