import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachOwnedTemporaryDirectory, createOwnedTemporaryDirectory, ownedTemporaryDirectoryIsIdle, recordOwnedProcess } from './owned-temporary-directory.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { runSuite, runPlannedSuite, OUTCOME } from './verify/runner.mjs';
import { runProcess } from './subprocess-control.mjs';
import { runOwnedTestOperation, resolveTestNpmCli } from './owned-test-environment.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inside = (root, path) => {
  const part = relative(root, path);
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};
const metadata = stdout => JSON.parse(Buffer.from(stdout.match(/OWNED_TEMP_META:([A-Za-z0-9+/=]+)/)?.[1] ?? '', 'base64').toString());

async function fixture(execute) {
  const owner = await createOwnedTemporaryDirectory('test-env-fixture');
  try {
    const temporaryParent = join(owner.root, 'temp');
    await mkdir(temporaryParent);
    await execute({ root: owner.root, temporaryParent, owner,
      env: { ...process.env, TMPDIR: temporaryParent, TMP: temporaryParent, TEMP: temporaryParent } });
  } finally { await owner.dispose(); }
}

test('actual check operation owns and removes uncooperative fixture TEMP without changing test outcome', async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const child = join(root, 'leaking.test.mjs');
    await writeFile(child, `import test from 'node:test';
      import {mkdtempSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
      test('real assertion and deliberately uncooperative temporary writer',()=>{
        const path=mkdtempSync(join(tmpdir(),'sf-leaked-fixture-'));writeFileSync(join(path,'data'),'owned');
        console.log('OWNED_TEMP_META:'+Buffer.from(JSON.stringify({path,temp:tmpdir()})).toString('base64'));
      });`);
    const result = await runSuite({ repoRoot, scriptName: 'test:owned-temp-probe', injectEnv: false,
      timeoutMs: 20_000, env, operation: { command: 'node', args: ['--test', child], cwd: root, validation: true } });
    assert.equal(result.outcome, OUTCOME.PASSED);
    const written = metadata(result.stdout);
    assert.ok(inside(temporaryParent, written.path), 'child stays inside the requested fixture parent');
    assert.equal(existsSync(written.path), false, 'completed check operation must remove its whole owned TEMP tree');
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('check-level SIGINT stops later suite admission instead of continuing no-bail work', async () => {
  await fixture(async ({ root, env, owner }) => {
    const ready = join(root, 'ready'), later = join(root, 'later');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:first': 'node first.cjs', 'test:second': 'node second.cjs' } }));
    await writeFile(join(root, 'first.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`);
    await writeFile(join(root, 'second.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(later)},'MUST NOT RUN');console.log(JSON.stringify({ok:true}));`);
    const check = new URL('./check.mjs', import.meta.url);
    const driver = join(root, 'interrupt.mjs');
    await writeFile(driver, `import {existsSync} from 'node:fs';
      process.argv=[process.execPath,${JSON.stringify(fileURLToPath(check))},'--suite','test:first,test:second','--no-bail'];
      const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(timer);
        // Windows TerminateProcess is not a console SIGINT. Exercise the actual
        // command's SIGINT handler event; POSIX also verifies OS delivery.
        if(process.platform==='win32')process.emit('SIGINT');else process.kill(process.pid,'SIGINT');}},10);
      try{await import(${JSON.stringify(check.href)});}finally{clearInterval(timer);}`);
    const result = await runProcess({ command: process.execPath, args: [driver], cwd: root, env, owner, timeoutMs: 30_000,
      outputLimitBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(existsSync(later), false, 'cancelled check must not start another actual suite');
    const report = JSON.parse(result.stdout);
    assert.equal(report.results.find(result => result.scriptName === 'test:second').status, 'not_run');
    assert.equal(report.results.find(result => result.scriptName === 'test:second').reason, 'cancelled');
    assert.equal(report.completionVerified, false);
  });
});

test('actual check to root npm test to owned fixture does not recursively lengthen TEMP', async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const wrapper = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
    const temporaryHelper = new URL('./owned-temporary-directory.mjs', import.meta.url).href;
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: `node "${wrapper}" -- npm run soulforge:test-body --silent --`,
      'soulforge:test-body': 'node child.mjs'
    } }));
    await writeFile(join(root, 'child.mjs'), `import {createOwnedTemporaryDirectory} from ${JSON.stringify(temporaryHelper)};
      import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
      const owner=await createOwnedTemporaryDirectory('nested-fixture-${'x'.repeat(35)}');
      try{const path=mkdtempSync(join(owner.root,'leaf-'));console.log('OWNED_TEMP_META:'+Buffer.from(JSON.stringify({path,temp:tmpdir()})).toString('base64'));console.log(JSON.stringify({ok:true,assertions:1}));}
      finally{await owner.dispose();}`);
    const result = await runSuite({ repoRoot, scriptName: 'test', injectEnv: false, timeoutMs: 30_000, env,
      operation: { command: 'npm', args: ['run', 'test', '--silent'], cwd: root, validation: true } });
    assert.equal(result.outcome, OUTCOME.PASSED, result.stderr);
    const written = metadata(result.stdout);
    assert.ok(inside(temporaryParent, written.path));
    assert.equal(existsSync(written.path), false);
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

for (const termination of ['cancel', 'timeout']) test(`nested root npm wrapper ${termination} cleans its explicitly owned sibling TEMP`, async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const wrapper = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
    const check = new URL('./check.mjs', import.meta.url), ready = join(root, 'nested-ready.json');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: `node "${wrapper}" -- npm run soulforge:test-body --silent --`,
      'soulforge:test-body': 'node blocked.cjs'
    } }));
    await writeFile(join(root, 'blocked.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({
      root:process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT,token:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN}));setInterval(()=>{},100);`);
    const driver = join(root, 'nested-interrupt.mjs');
    await writeFile(driver, `import {existsSync} from 'node:fs';
      process.argv=[process.execPath,${JSON.stringify(fileURLToPath(check))},'--suite','test','--timeout-ms',${JSON.stringify(termination === 'timeout' ? '3500' : '20000')}];
      const timer=${termination === 'cancel' ? `setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(timer);if(process.platform==='win32')process.emit('SIGINT');else process.kill(process.pid,'SIGINT');}},10)` : 'null'};
      try{await import(${JSON.stringify(check.href)});}finally{clearInterval(timer);}`);
    const result = await runProcess({ command: process.execPath, args: [driver], cwd: root, env, owner,
      timeoutMs: 30_000, outputLimitBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(existsSync(ready), true, `interruption must occur after the real nested wrapper and fixture started\n${result.stdout.slice(-8000)}\n${result.stderr.slice(-2000)}`);
    const nested = JSON.parse(await readFile(ready, 'utf8'));
    try {
      const report = JSON.parse(result.stdout);
      assert.equal(termination === 'cancel' ? report.cancelled : report.results[0].timedOut, true);
      assert.deepEqual(await readdir(temporaryParent), [], 'outer completion must not hide a killed nested sibling owner');
    } finally {
      // Old-code red leaves exactly this fixture-recorded child. Verify its
      // token and stopped tree rather than sweeping any sibling or temp root.
      if (existsSync(nested.root)) {
        assert.ok(inside(temporaryParent, nested.root));
        const record = JSON.parse(await readFile(join(nested.root, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.equal(record.token, nested.token);
        await (await attachOwnedTemporaryDirectory(nested.root)).dispose();
      }
    }
  });
});

test('direct npm test preserves pre/body/post order, cwd, extra argv and failed && tails in one TEMP', async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const wrapper = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
    const log = join(root, 'phases.jsonl');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: `node "${wrapper}" -- npm run soulforge:test-body --silent --`,
      'presoulforge:test-body': 'node phase.cjs pre',
      'soulforge:test-body': 'node phase.cjs body && node phase.cjs tail',
      'postsoulforge:test-body': 'node phase.cjs post'
    } }));
    await writeFile(join(root, 'phase.cjs'), `const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
      const phase=process.argv[2],temp=os.tmpdir(),created=fs.mkdtempSync(path.join(temp,'phase-'));
      fs.appendFileSync(process.env.PHASE_LOG,JSON.stringify({phase,temp,created,cwd:process.cwd(),args:process.argv.slice(3)})+'\\n');
      if(process.env.FAIL_PHASE===phase)process.exit(7);`);
    const invoke = failure => runProcess({ command: process.execPath,
      args: [resolveTestNpmCli(env), 'run', 'test', '--silent', '--', '--extra', 'two words'], cwd: root, owner, timeoutMs: 20_000,
      env: { ...env, PHASE_LOG: log, FAIL_PHASE: failure, npm_config_cache: join(root, 'npm-cache'), NODE_DISABLE_COMPILE_CACHE: '1' }, outputLimitBytes: Number.MAX_SAFE_INTEGER });
    const passed = await invoke('');
    assert.equal(passed.code, 0, passed.stderr);
    let phases = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(phases.map(item => item.phase), ['pre', 'body', 'tail', 'post']);
    assert.deepEqual(phases.find(item => item.phase === 'tail').args, ['--extra', 'two words']);
    assert.ok(phases.every(item => item.cwd === root && item.temp === phases[0].temp && !existsSync(item.created)));
    assert.ok(inside(temporaryParent, phases[0].temp));
    await writeFile(log, '');
    const failed = await invoke('body');
    assert.equal(failed.code, 7, failed.stderr);
    phases = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(phases.map(item => item.phase), ['pre', 'body']);
    assert.ok(phases.every(item => !existsSync(item.created)));
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('complete output keeps a skip before a greater-than-2MiB tail visible to the real classifier', async () => {
  await fixture(async ({ root, env }) => {
    const child = join(root, 'large.test.mjs');
    await writeFile(child, `import test from 'node:test';test('actual child assertion',()=>{
      console.log(JSON.stringify({status:'skipped',reason:'EARLY_SKIP_MUST_SURVIVE'}));console.log('x'.repeat(2*1024*1024+4096));});`);
    const result = await runSuite({ repoRoot, scriptName: 'test:large-owned-output', injectEnv: false, timeoutMs: 20_000, env,
      operation: { command: 'node', args: ['--test', child], cwd: root, validation: true } });
    assert.ok(result.stdout.length > 2 * 1024 * 1024, JSON.stringify({length:result.stdout.length,code:result.exitCode,stderr:result.stderr.slice(-1000),head:result.stdout.slice(0,100)}));
    assert.ok(result.stdout.includes('EARLY_SKIP_MUST_SURVIVE'));
    assert.notEqual(result.outcome, OUTCOME.PASSED);
    assert.equal(result.temporaryOwnership.state, 'cleaned');
  });
});

test('pre-cancelled admission does not allocate, spawn, or reuse a cached pass', async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const controller = new AbortController(); controller.abort();
    const result = await runOwnedTestOperation({ command: 'must-not-spawn', cwd: root, env, signal: controller.signal });
    assert.equal(result.cancelled, true);
    assert.equal(result.temporaryOwnership, undefined);
    assert.deepEqual(await readdir(temporaryParent), []);
    const operation = { key: 'cached', command: 'node', args: ['must-not-run'], cwd: root, kind: 'test' };
    const cache = new Map([['cached', { outcome: OUTCOME.PASSED, exitCode: 0, stdout: '', stderr: '' }]]);
    const planned = await runPlannedSuite({ repoRoot, entry: { scriptName: 'test:cancelled', steps: [operation] },
      timeoutMs: 1000, cache, signal: controller.signal, execute: () => { throw new Error('cancelled execution'); } });
    assert.equal(planned.outcome, OUTCOME.NOT_ATTEMPTED);
    assert.equal(planned.steps[0].execution, 'not_run');
    assert.equal(cache.size, 0);
  });
});

test('a timed-out actual suite does not cancel a later independent suite', async () => {
  await fixture(async ({ root, env, owner }) => {
    const ready = join(root, 'ready'), later = join(root, 'later');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:first': 'node first.cjs', 'test:second': 'node second.cjs' } }));
    await writeFile(join(root, 'first.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},100);`);
    await writeFile(join(root, 'second.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(later)},'ran');console.log(JSON.stringify({ok:true}));`);
    const result = await runProcess({ command: process.execPath,
      args: [fileURLToPath(new URL('./check.mjs', import.meta.url)), '--suite', 'test:first,test:second', '--timeout-ms', '3000'],
      cwd: root, env, owner, timeoutMs: 20_000, outputLimitBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(result.code, 1, result.stderr);
    assert.equal(existsSync(ready), true);
    assert.equal(existsSync(later), true);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results.find(result => result.scriptName === 'test:first').timedOut, true);
    assert.equal(report.results.find(result => result.scriptName === 'test:second').status, 'passed');
    assert.equal(report.cancelled, undefined);
  });
});

test('cleanup ownership failure cannot convert a successful child into a passed operation', async () => {
  await fixture(async ({ root, env, temporaryParent }) => {
    const backup = join(root, 'original-owner.json'), child = join(root, 'tamper.cjs');
    await writeFile(child, `const fs=require('node:fs'),path=require('node:path');
      const marker=path.join(process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT,'.soulforge-temporary-owner.json');
      fs.copyFileSync(marker,${JSON.stringify(backup)});fs.unlinkSync(marker);console.log(JSON.stringify({ok:true}));`);
    const result = await runSuite({ repoRoot, scriptName: 'test:owned-cleanup-negative', injectEnv: false, timeoutMs: 20_000, env,
      operation: { command: 'node', args: [child], cwd: root, validation: true } });
    const retained = result.temporaryOwnership.root;
    try {
      assert.equal(result.outcome, OUTCOME.FAILED);
      assert.equal(result.childExitCode, 0);
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.ok(result.cleanupError.includes('OWNED_TEMP_OWNERSHIP_CHANGED'));
      assert.ok(inside(temporaryParent, retained));
      assert.equal(existsSync(retained), true);
    } finally {
      // Restore only the exact fixture marker we intentionally removed, then
      // let the production ownership + stopped-Job checks authorize cleanup.
      await writeFile(join(retained, '.soulforge-temporary-owner.json'), await readFile(backup), { flag: 'wx' });
      await (await attachOwnedTemporaryDirectory(retained)).dispose();
    }
  });
});

test('forged inherited ownership and redirected TEMP fail before launching a child', async () => {
  await fixture(async ({ root, env, temporaryParent }) => {
    const inherited = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent });
    try {
      await mkdir(join(inherited.root, 'tmp'));
      const result = await runOwnedTestOperation({ command: 'must-not-spawn', cwd: root, env: {
        ...env, TEMP: join(inherited.root, 'tmp'), TMP: join(inherited.root, 'tmp'), TMPDIR: join(inherited.root, 'tmp'),
        SOULFORGE_TEST_TEMP_OWNER_ROOT: inherited.root, SOULFORGE_TEST_TEMP_OWNER_TOKEN: 'wrong-token'
      } });
      assert.match(result.spawnError, /OWNED_TEST_INHERITED_OWNER_INVALID/);
      assert.equal(result.temporaryOwnership, undefined);
    } finally { await inherited.dispose(); }
    const redirected = join(root, 'redirected');
    await symlink(temporaryParent, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await runOwnedTestOperation({ command: 'must-not-spawn', cwd: root,
      env: { ...env, TEMP: redirected, TMP: redirected, TMPDIR: redirected } });
    assert.match(result.spawnError, /OWNED_TEMP_PARENT_INVALID/);
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

for (const forgery of ['incomplete', 'unrelated']) test(`child ledger ${forgery} admission cannot authorize cleanup or a pass`, async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const unrelated = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent });
    const unrelatedRecord = JSON.parse(await readFile(join(unrelated.root, '.soulforge-temporary-owner.json'), 'utf8'));
    const sentinel = join(unrelated.root, 'independent-data');
    await writeFile(sentinel, 'must remain');
    let result;
    try {
      const child = join(root, 'forge-ledger.cjs');
      await writeFile(child, `const fs=require('node:fs'),path=require('node:path'),id=require('node:crypto').randomUUID();
        const receipt={schema:'soulforge.test-temporary-child.v1',id,parentToken:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN};
        const base=path.join(process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT,'.soulforge-test-child.'+id);
        fs.writeFileSync(base+'.pending.json',JSON.stringify(receipt));
        ${forgery === 'unrelated' ? `fs.writeFileSync(base+'.json',JSON.stringify({...receipt,root:${JSON.stringify(unrelated.root)},token:${JSON.stringify(unrelatedRecord.token)}}));` : ''}
        console.log(JSON.stringify({ok:true}));`);
      result = await runSuite({ repoRoot, scriptName: 'test:ledger-negative', injectEnv: false, env, timeoutMs: 20_000,
        operation: { command: 'node', args: [child], cwd: root, validation: true } });
      assert.equal(result.outcome, OUTCOME.FAILED);
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.equal(existsSync(sentinel), true, 'an unrelated sibling must never be adopted by a forged forward record');
      assert.match(result.cleanupError, forgery === 'incomplete' ? /OWNED_TEST_CHILD_ADMISSION_UNCERTAIN/ : /OWNED_TEST_CHILD_RECEIPT_INVALID/);
    } finally {
      // Only this test's own root is retired; original ownership/Job checks
      // still protect it. No cleanup traverses the deliberately forged ledger.
      if (result?.temporaryOwnership && existsSync(result.temporaryOwnership.root)) {
        await (await attachOwnedTemporaryDirectory(result.temporaryOwnership.root)).dispose();
      }
      await unrelated.dispose();
    }
  });
});

for (const mode of ['cli-exit', 'restart-sweep']) test(`uncertain child admission remains retained through ${mode}`, async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const beforePath = join(root, 'before.json'), returnedPath = join(root, 'returned.json');
    const tempModule = new URL('./owned-temporary-directory.mjs', import.meta.url).href;
    const actor = `import {readFile,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';
      import {randomUUID} from 'node:crypto';import {createOwnedTemporaryDirectory} from ${JSON.stringify(tempModule)};
      const parent=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
      const parentRecord=JSON.parse(await readFile(join(parent,'.soulforge-temporary-owner.json'),'utf8'));
      const id=randomUUID();await writeFile(join(parent,'.soulforge-test-child.'+id+'.pending.json'),
        JSON.stringify({schema:'soulforge.test-temporary-child.v1',id,parentToken:parentRecord.token}),{flag:'wx'});
      const child=await createOwnedTemporaryDirectory('test-operation',{parent:dirname(parent)});
      ${mode === 'restart-sweep' ? 'await child.trackProcess(process.pid,{uncertainTree:true});' : ''}
      const childRecord=JSON.parse(await readFile(join(child.root,'.soulforge-temporary-owner.json'),'utf8'));
      await writeFile(${JSON.stringify(beforePath)},JSON.stringify({parent,parentRecord,child:child.root,childRecord,actorPid:process.pid,id}));
      process.kill(process.pid,'SIGKILL');`;
    const args = mode === 'cli-exit'
      ? [fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url)), '--', process.execPath, '--input-type=module', '-e', actor]
      : ['--input-type=module', '-e', `import {writeFile} from 'node:fs/promises';
        import {runSuite} from ${JSON.stringify(new URL('./verify/runner.mjs', import.meta.url).href)};
        const result=await runSuite({repoRoot:${JSON.stringify(repoRoot)},scriptName:'test:retention',injectEnv:false,timeoutMs:15000,
          operation:{command:'node',args:['--input-type=module','-e',${JSON.stringify(actor)}],cwd:${JSON.stringify(root)},validation:true}});
        await writeFile(${JSON.stringify(returnedPath)},JSON.stringify(result));process.kill(process.pid,'SIGKILL');`];
    let before;
    try {
      const result = await runProcess({ command: process.execPath, args, cwd: root, env, owner, timeoutMs: 20_000 });
      assert.notEqual(result.code, 0);
      before = JSON.parse(await readFile(beforePath, 'utf8'));
      assert.equal(dirname(before.parent), temporaryParent);
      assert.equal(dirname(before.child), temporaryParent);
      if (mode === 'cli-exit') assert.match(result.stderr, /OWNED_TEST_CHILD_ADMISSION_UNCERTAIN/);
      else {
        const returned = JSON.parse(await readFile(returnedPath, 'utf8'));
        assert.equal(returned.outcome, OUTCOME.FAILED);
        assert.equal(returned.temporaryOwnership.state, 'retained');
      }
      assert.equal(existsSync(before.parent), true, 'CLI exit must preserve the failed parent ledger');
      if (mode === 'restart-sweep') {
        const next = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent });
        try {
          assert.equal(existsSync(before.parent), true, 'next admission must preserve explicitly retained evidence');
          assert.equal(existsSync(before.child), true, 'uncertain child proof still cannot authorize deletion');
        } finally { await next.dispose(); }
      }
      const current = JSON.parse(await readFile(join(before.parent, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(current.retention.schema, 'soulforge.temporary-retention.v1');
      assert.match(current.retention.reason, /OWNED_TEST_CHILD_ADMISSION_UNCERTAIN/);
      assert.ok(current.retention.reason.length <= 512);
    } finally {
      if (before) {
        assert.throws(() => process.kill(before.actorPid, 0), { code: 'ESRCH' });
        if (mode === 'restart-sweep') recordOwnedProcess({ root: before.child, token: before.childRecord.token }, before.actorPid, { finished: true });
        await (await attachOwnedTemporaryDirectory(before.child)).dispose();
        if (existsSync(before.parent)) {
          // The sole interrupted actor and its exact child have now been
          // observed stopped and retired. Repair that evidence, then explicitly
          // dispose through the original token/Job/group boundary.
          await writeFile(join(before.parent, `.soulforge-test-child.${before.id}.json`), JSON.stringify({
            schema: 'soulforge.test-temporary-child.v1', id: before.id, parentToken: before.parentRecord.token,
            root: before.child, token: before.childRecord.token
          }), { flag: 'wx' });
          await (await attachOwnedTemporaryDirectory(before.parent)).dispose();
        }
      }
    }
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('durable retain is bounded and idempotent but cannot replace stopped-tree proof', async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const retained = await createOwnedTemporaryDirectory('retention-proof', { parent: temporaryParent });
    let ticket, pid;
    try {
      await retained.retain('expected-retention-'.repeat(100));
      const markerPath = join(retained.root, '.soulforge-temporary-owner.json');
      const first = JSON.parse(await readFile(markerPath, 'utf8')).retention;
      assert.equal(first.schema, 'soulforge.temporary-retention.v1');
      assert.equal(first.reason.length, 512);
      await retained.retain('second reason must not overwrite the original');
      assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')).retention, first);
      await assert.rejects(retained.retain(''), /OWNED_TEMP_RETENTION_INVALID/);
      const exited = await runProcess({ command: process.execPath, args: ['-e', 'console.log(process.pid)'], cwd: root, env, timeoutMs: 10_000 });
      assert.equal(exited.code, 0);
      pid = Number(exited.stdout.trim());
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      ticket = await retained.trackProcess(pid, { uncertainTree: true });
      await assert.rejects(retained.dispose(), /OWNED_TEMP_PROCESS_UNCERTAIN/);
      assert.equal(existsSync(retained.root), true);
    } finally {
      // This exact fixture actor was observed exited; completing its original
      // ticket restores the proof. Retention itself never bypasses that proof.
      if (ticket) recordOwnedProcess(ticket, pid, { finished: true });
      await retained.dispose();
    }
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('compact allocation retains the full scope and exact owner marker without changing the default', async () => {
  await fixture(async ({ temporaryParent }) => {
    const regular = await createOwnedTemporaryDirectory('compact-option', { parent: temporaryParent });
    const compact = await createOwnedTemporaryDirectory('compact-option', { parent: temporaryParent, compact: true });
    try {
      const record = JSON.parse(await readFile(join(compact.root, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(record.owner, 'compact-option');
      assert.equal(record.directory, basename(compact.root));
      assert.equal(record.scope.length, 16);
      assert.match(basename(compact.root), new RegExp(`^sft-${record.scope}-[A-Za-z0-9]{6}$`));
      assert.ok(basename(regular.root).startsWith(`sf-owned-${record.scope}-compact-option-`));
      await assert.rejects(createOwnedTemporaryDirectory('compact-option', { parent: temporaryParent, compact: 'yes' }), /OWNED_TEMP_COMPACT_INVALID/);
    } finally { await compact.dispose(); await regular.dispose(); }
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('real child admission retains its parent before a forced stop can bypass cleanup', async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const ready = join(root, 'admitted.json'), release = join(root, 'release'), actor = join(root, 'admitted.cjs');
    await writeFile(actor, `const fs=require('node:fs'),path=require('node:path');const root=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
      const parent=JSON.parse(fs.readFileSync(path.join(root,'.soulforge-test-parent.json'),'utf8'));
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({root,token:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN,parent}));
      const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.exit(0);}},20);`);
    const driver = join(root, 'admission-driver.mjs');
    await writeFile(driver, `import {existsSync} from 'node:fs';import {runOwnedTestOperation} from ${JSON.stringify(new URL('./owned-test-environment.mjs', import.meta.url).href)};
      const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)}))process.kill(process.pid,'SIGKILL');},10);
      try{await runOwnedTestOperation({command:process.execPath,args:[${JSON.stringify(fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url)))},'--',process.execPath,${JSON.stringify(actor)}],cwd:process.cwd()});}
      finally{clearInterval(timer);}`);
    let info;
    try {
      const result = await runProcess({ command: process.execPath, args: [driver], cwd: root, env, owner, timeoutMs: 20_000 });
      assert.notEqual(result.code, 0);
      info = JSON.parse(await readFile(ready, 'utf8'));
      assert.equal(dirname(info.parent.parentRoot), temporaryParent);
      assert.equal(dirname(info.root), temporaryParent);
      // POSIX owned supervisors may correctly outlive the killed driver. Let
      // the known fixture actor finish and consult only the original proof.
      await writeFile(release, 'done');
      let idle = false;
      for (let attempt = 0; attempt < 250; attempt++) {
        if (await ownedTemporaryDirectoryIsIdle(info.parent.parentRoot, 'test-operation', info.parent.parentToken)) { idle = true; break; }
        await delay(20);
      }
      assert.equal(idle, true);
      const next = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent });
      try {
        assert.equal(existsSync(info.parent.parentRoot), true, 'automatic reclaim must not erase admission evidence after the tree stops');
        const record = JSON.parse(await readFile(join(info.parent.parentRoot, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.equal(record.retention.reason, 'OWNED_TEST_CHILD_ADMISSION_PENDING');
      } finally { await next.dispose(); }
    } finally {
      await writeFile(release, 'done');
      if (info) {
        if (existsSync(info.root)) await (await attachOwnedTemporaryDirectory(info.root)).dispose();
        if (existsSync(info.parent.parentRoot)) await (await attachOwnedTemporaryDirectory(info.parent.parentRoot)).dispose();
      }
    }
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('an unavailable npm program is a structured failed child and never triggers binding repair', async () => {
  await fixture(async ({ root, env, temporaryParent }) => {
    const absent = join(root, 'absent-npm.cjs');
    // An actual selected CLI that cannot load npm is not replaced by another
    // shell, an installation, or a rebuild.
    await writeFile(absent, 'require("./npm-program-is-not-installed.cjs");');
    const result = await runOwnedTestOperation({ command: 'npm', args: ['run', 'test'], cwd: root,
      env: { ...env, npm_execpath: absent }, timeoutMs: 20_000 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /MODULE_NOT_FOUND/);
    assert.equal(result.temporaryOwnership.state, 'cleaned');
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('absent npm resolution returns structured failure from both direct operation and suite APIs', async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const child = join(root, 'no-npm.mjs');
    await writeFile(child, `import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      import {runOwnedTestOperation} from ${JSON.stringify(new URL('./owned-test-environment.mjs', import.meta.url).href)};
      import {runSuite,OUTCOME} from ${JSON.stringify(new URL('./verify/runner.mjs', import.meta.url).href)};
      // Isolate locator absence from an installed host npm. Only its synchronous
      // existence probe is replaced; real owner allocation/cleanup still run.
      const original=fs.existsSync;fs.existsSync=()=>false;syncBuiltinESMExports();
      try{const direct=await runOwnedTestOperation({command:'npm',cwd:process.cwd()});
        assert.equal(direct.spawnError,'OWNED_TEST_NPM_UNAVAILABLE');assert.equal(direct.temporaryOwnership.state,'cleaned');
        const suite=await runSuite({repoRoot:process.cwd(),scriptName:'test',injectEnv:false,timeoutMs:1000});
        assert.equal(suite.outcome,OUTCOME.FAILED);assert.equal(suite.spawnError,'OWNED_TEST_NPM_UNAVAILABLE');
        console.log(JSON.stringify({ok:true,assertions:4}));
      }finally{fs.existsSync=original;syncBuiltinESMExports();}`);
    const result = await runProcess({ command: process.execPath, args: [child], cwd: root, env, owner, timeoutMs: 20_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"assertions":4/);
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('same-package npm delegation preserves command resolution and unknown PATH entries without changing unmatched calls', async () => {
  await fixture(async ({ root, env }) => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { body: 'node unused.cjs' } }));
    await writeFile(join(root, 'other.json'), '{}');
    const npm = join(root, 'npm-probe.cjs');
    await writeFile(npm, `const key=Object.keys(process.env).find(key=>key.toLowerCase()==='path');console.log('OWNED_TEMP_META:'+Buffer.from(JSON.stringify({path:process.env[key]})).toString('base64'));`);
    const key = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const bins = [];
    for (let directory = root;; directory = dirname(directory)) {
      bins.push(join(directory, 'node_modules', '.bin'));
      if (dirname(directory) === directory) break;
    }
    const alias = `${bins[0]}${sep}..${sep}.bin`, unknown = join(root, 'unrelated-tools');
    const original = [unknown, bins[0], alias, bins[1], env[key]].join(delimiter);
    const common = { ...env, [key]: original, npm_execpath: npm, npm_lifecycle_event: 'test', npm_package_json: join(root, 'package.json') };
    const call = async (override = {}, args = ['run', 'body', '--silent', '--']) => {
      const result = await runOwnedTestOperation({ command: 'npm', args, cwd: root, env: { ...common, ...override }, timeoutMs: 20_000 });
      assert.equal(result.code, 0, result.stderr);
      return metadata(result.stdout).path;
    };
    const delegated = await call();
    const expected = original.split(delimiter).filter(value => !bins.includes(value)).join(delimiter);
    assert.equal(delegated, expected);
    assert.ok(delegated.split(delimiter).includes(alias));
    assert.ok(delegated.split(delimiter).includes(unknown));
    // npm re-adds the same ancestor bins in this order. First-hit executable
    // resolution is identical even though redundant spellings are removed.
    const search = path => [...new Set([...bins, ...path.split(delimiter)])];
    assert.deepEqual(search(delegated), search(original));
    assert.equal(await call({ npm_package_json: join(root, 'other.json') }), original);
    assert.equal(await call({ npm_lifecycle_event: '' }), original);
    assert.equal(await call({}, ['run', 'body', '--prefix', root]), original);
  });
});

test('the real CLI node command uses the current runtime without requiring PATH lookup', async () => {
  await fixture(async ({ root, temporaryParent, env, owner }) => {
    const wrapper = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
    const result = await runProcess({ command: process.execPath,
      args: [wrapper, '--', 'node', '-e', 'console.log(JSON.stringify({ok:true,execPath:process.execPath}))'],
      cwd: root, env, owner, timeoutMs: 20_000, outputLimitBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, execPath: process.execPath });
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});
