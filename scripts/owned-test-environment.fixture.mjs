import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

async function waitFor(read, description) {
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    try { const value = await read(); if (value) return value; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function fixture(execute) {
  const owner = await createOwnedTemporaryDirectory('test-env-fixture');
  let preserve = false;
  try {
    const temporaryParent = join(owner.root, 'temp');
    await mkdir(temporaryParent);
    await execute({ root: owner.root, temporaryParent, owner,
      env: { ...process.env, TMPDIR: temporaryParent, TMP: temporaryParent, TEMP: temporaryParent },
      preserve: () => { preserve = true; } });
  } finally { if (!preserve) await owner.dispose(); }
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

async function retireStoppedFixtureOwner(root, expectedToken) {
  if (!existsSync(root)) return;
  const marker = JSON.parse(await readFile(join(root, '.soulforge-temporary-owner.json'), 'utf8'));
  assert.equal(marker.token, expectedToken, 'manual cleanup must target this fixture-owned root');
  const pids = [...new Set([...(marker.pid === process.pid ? [] : [marker.pid]), ...(marker.childPids ?? []), ...(marker.uncertainTrees ?? [])])];
  const groups = [...new Set(marker.processGroups ?? [])];
  await waitFor(async () => (await Promise.all(pids.map(ownedPidStopped))).every(Boolean)
    && (await Promise.all(groups.map(ownedProcessGroupStopped))).every(Boolean), 'fixture-owned processes and groups to stop before manual cleanup');
  const current = JSON.parse(await readFile(join(root, '.soulforge-temporary-owner.json'), 'utf8'));
  assert.equal(current.token, expectedToken, 'owner identity must still match immediately before manual cleanup');
  // Fixture-only cleanup: all recorded processes are stopped and the exact
  // generated root/token were captured before cancellation. Product evidence
  // remains latched; this does not authorize a production sweep.
  await rm(root, { recursive: true, force: true });
}

async function runNestedCompletionFixture({ root, env, mutation = 'none' }) {
  const child = join(root, `nested-completion-${mutation}.mjs`);
  const environmentModule = new URL('./owned-test-environment.mjs', import.meta.url).href;
  let mutationSource = '';
  if (mutation === 'recreate-root') mutationSource = `const recreatedRootPath=childReceipt.root;
      await mkdir(recreatedRootPath);await writeFile(join(recreatedRootPath,'completion-root-fixture-sentinel'),'owned-by-this-fixture');`;
  else if (mutation === 'missing') mutationSource = `try{await unlink(completionPath);}catch(error){if(error.code!=='ENOENT')throw error;}`;
  else if (mutation === 'partial') mutationSource = `await writeFile(completionPath,'{');`;
  else if (['id', 'parentToken', 'childToken', 'root', 'state'].includes(mutation)) {
    // If the baseline producer has no record, create a deliberately invalid
    // test-only receipt so each binding negative independently exercises the reader.
    const replacement = mutation === 'state' ? 'unknown' : 'not-the-recorded-value';
    mutationSource = `completion??={schema:'soulforge.test-temporary-child-completion.v1',state:'disposed',
      id:pending.id,parentToken:pending.parentToken,childToken:childReceipt.token,root:childReceipt.root};
      completion[${JSON.stringify(mutation)}]=${JSON.stringify(replacement)};
      await writeFile(completionPath,JSON.stringify(completion));`;
  }
  await writeFile(child, `import {existsSync} from 'node:fs';
    import {mkdir,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    import {runOwnedTestOperation} from ${JSON.stringify(environmentModule)};
    const nested=await runOwnedTestOperation({command:process.execPath,args:['-e','process.exit(0)'],
      cwd:process.cwd(),env:process.env,timeoutMs:15000});
    if(nested.code!==0||nested.cleanupError||nested.temporaryOwnership?.state!=='cleaned')
      throw new Error('nested owned operation did not finish cleanly: '+JSON.stringify(nested));
    const parentRoot=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
    const parentOwner=JSON.parse(await readFile(join(parentRoot,'.soulforge-temporary-owner.json'),'utf8'));
    const pendingName=(await readdir(parentRoot)).find(name=>/^\\.soulforge-test-child\\.[a-f0-9-]{36}\\.pending\\.json$/.test(name));
    if(!pendingName)throw new Error('parent child ledger missing');
    const base=join(parentRoot,pendingName.slice(0,-'.pending.json'.length));
    const pending=JSON.parse(await readFile(base+'.pending.json','utf8'));
    const childReceipt=JSON.parse(await readFile(base+'.json','utf8'));
    const completionPath=base+'.completed.json';
    let completion;
    try{completion=JSON.parse(await readFile(completionPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    ${mutationSource}
    const evidence={parentRoot,parentToken:parentOwner.token,parentRootExistsAtPublication:existsSync(parentRoot),pending,childReceipt,completion,
      recreatedRootPath:typeof recreatedRootPath==='undefined'?undefined:recreatedRootPath,
      childRootExists:existsSync(childReceipt.root),nestedState:nested.temporaryOwnership.state};
    process.stdout.write('OWNED_TEST_CHILD_COMPLETION:'+Buffer.from(JSON.stringify(evidence)).toString('base64')+'\\n');`);
  return runOwnedTestOperation({ command: process.execPath, args: [child], cwd: root, env, timeoutMs: 20_000 });
}

function nestedCompletionEvidence(stdout) {
  const encoded = stdout.match(/OWNED_TEST_CHILD_COMPLETION:([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(encoded, 'nested wrapper must report its completion evidence');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

async function loadOwnedTestEnvironmentWithClosedMarkerRemovalHook(root) {
  const sourcePath = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
  const source = await readFile(sourcePath, 'utf8');
  const fsPromisesImport = "import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';";
  assert.equal(source.split(fsPromisesImport).length - 1, 1, 'the controlled I/O seam is pinned to one known import');
  let instrumented = source.replace(fsPromisesImport, `import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile as nativeWriteFile } from 'node:fs/promises';
    async function writeFile(...args) {
      const result = await nativeWriteFile(...args);
      const path = args[0];
      if (typeof path === 'string' && basename(path) === '.soulforge-test-children-closed.json') {
        await rm(dirname(path), { recursive: true, force: true });
      }
      return result;
    }`);
  instrumented = instrumented.replace("from './owned-temporary-directory.mjs'",
    `from ${JSON.stringify(new URL('./owned-temporary-directory.mjs', import.meta.url).href)}`);
  instrumented = instrumented.replace("from './subprocess-control.mjs'",
    `from ${JSON.stringify(new URL('./subprocess-control.mjs', import.meta.url).href)}`);
  const instrumentedPath = join(root, 'owned-test-environment-root-drop-hook.mjs');
  await writeFile(instrumentedPath, instrumented);
  return await import(pathToFileURL(instrumentedPath).href);
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

for (const termination of ['cancel', 'timeout']) test(`nested root npm wrapper ${termination} retains Linux unproven TEMP but preserves Windows Job cleanup`, async () => {
  await fixture(async ({ root, temporaryParent, env, owner, preserve }) => {
    const wrapper = fileURLToPath(new URL('./owned-test-environment.mjs', import.meta.url));
    const check = new URL('./check.mjs', import.meta.url), ready = join(root, 'nested-ready.json');
    const release = join(root, 'nested-release'), cancelNow = join(root, 'cancel-now');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      test: `node "${wrapper}" -- npm run soulforge:test-body --silent --`,
      'soulforge:test-body': 'node blocked.cjs'
    } }));
    await writeFile(join(root, 'blocked.cjs'), `const fs=require('node:fs');
      const ready=${JSON.stringify(ready)},release=${JSON.stringify(release)};
      const root=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
      const parent=JSON.parse(fs.readFileSync(require('node:path').join(root,'.soulforge-test-parent.json'),'utf8'));
      fs.writeFileSync(ready,JSON.stringify({root,token:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN,
        parentRoot:parent.parentRoot,parentToken:parent.parentToken,pid:process.pid}));
      const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);process.exit(0);}},10);`);
    const driver = join(root, 'nested-interrupt.mjs');
    await writeFile(driver, `import {existsSync} from 'node:fs';
      process.argv=[process.execPath,${JSON.stringify(fileURLToPath(check))},'--suite','test','--timeout-ms',${JSON.stringify(termination === 'timeout' ? '3500' : '20000')}];
      const timer=${termination === 'cancel' ? `setInterval(()=>{if(existsSync(${JSON.stringify(cancelNow)})){clearInterval(timer);if(process.platform==='win32')process.emit('SIGINT');else process.kill(process.pid,'SIGINT');}},10)` : 'null'};
      try{await import(${JSON.stringify(check.href)});}finally{clearInterval(timer);}`);
    const controller = new AbortController();
    const run = runProcess({ command: process.execPath, args: [driver], cwd: root, env, owner, signal: controller.signal,
      timeoutMs: 30_000, outputLimitBytes: Number.MAX_SAFE_INTEGER });
    let nested;
    try {
      await waitFor(async () => JSON.parse(await readFile(ready, 'utf8')), 'nested owned child readiness');
      nested = JSON.parse(await readFile(ready, 'utf8'));
      if (termination === 'cancel') await writeFile(cancelNow, 'cancel');
      const result = await run;
      assert.equal(result.code, 1, result.stderr);
      assert.equal(existsSync(ready), true, `interruption must occur after the real nested wrapper and fixture started\n${result.stdout.slice(-8000)}\n${result.stderr.slice(-2000)}`);
      const report = JSON.parse(result.stdout);
      assert.equal(termination === 'cancel' ? report.cancelled : report.results[0].timedOut, true);
      if (process.platform === 'linux') {
        assert.ok(existsSync(nested.root), 'the cancelled/timeout child root must be retained');
        const record = JSON.parse(await readFile(join(nested.root, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.equal(record.token, nested.token);
        assert.ok(record.uncertainTrees.length, 'the nested supervisor remains an unproven tree after interruption');
        assert.ok(existsSync(nested.parentRoot), 'the ancestor root must remain while recursive disposal is blocked');
        assert.match(JSON.stringify(report), /OWNED_TEMP_PROCESS_UNCERTAIN/, 'the check report must surface cleanup failure');
        assert.notDeepEqual(await readdir(temporaryParent), [], 'a retained owned root is not reported as cleaned');
      } else {
        assert.deepEqual(await readdir(temporaryParent), [], 'Windows Job proof still permits cleanup after termination');
      }
    } finally {
      await writeFile(release, 'done');
      if (!nested) {
        controller.abort();
        try { await run; } catch { /* preserve the fixture root when no ownership receipt was captured */ }
        preserve();
      } else if (process.platform === 'linux') {
        try {
          await retireStoppedFixtureOwner(nested.root, nested.token);
          await retireStoppedFixtureOwner(nested.parentRoot, nested.parentToken);
        } catch (error) {
          preserve();
          throw error;
        }
      } else if (existsSync(nested.root)) {
        assert.ok(inside(temporaryParent, nested.root));
        const record = JSON.parse(await readFile(join(nested.root, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.equal(record.token, nested.token);
        await (await attachOwnedTemporaryDirectory(nested.root)).dispose();
      }
    }
  });
});

test('a leaf uncertain tree propagates across three owners and blocks direct ancestor disposal', { skip: process.platform !== 'linux' }, async () => {
  await fixture(async ({ root, temporaryParent, env, preserve }) => {
    const chainPath = join(root, 'three-owner-chain.json');
    const temporaryModule = new URL('./owned-temporary-directory.mjs', import.meta.url).href;
    const child = `import {randomUUID} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';
      import {dirname,join} from 'node:path';import {attachOwnedTemporaryDirectory,createOwnedTemporaryDirectory} from ${JSON.stringify(temporaryModule)};
      const schema='soulforge.test-temporary-child.v1',ownerFile='.soulforge-temporary-owner.json';
      async function addChild(parentRoot,parentToken){
        const parent=await attachOwnedTemporaryDirectory(parentRoot);await parent.retain('OWNED_TEST_CHILD_ADMISSION_PENDING');
        const id=randomUUID(),receipt={schema,id,parentToken},base=join(parentRoot,'.soulforge-test-child.'+id);
        await writeFile(base+'.pending.json',JSON.stringify(receipt),{flag:'wx',mode:0o600});
        const owner=await createOwnedTemporaryDirectory('test-operation',{parent:dirname(parentRoot),compact:true});
        const record=JSON.parse(await readFile(join(owner.root,ownerFile),'utf8'));
        await writeFile(join(owner.root,'.soulforge-test-parent.json'),JSON.stringify({...receipt,parentRoot,childToken:record.token}),{flag:'wx',mode:0o600});
        await writeFile(base+'.json',JSON.stringify({...receipt,root:owner.root,token:record.token}),{flag:'wx',mode:0o600});
        return {root:owner.root,token:record.token};
      }
      const a={root:process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT,token:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN};
      const b=await addChild(a.root,a.token),c=await addChild(b.root,b.token);
      const leaf=await attachOwnedTemporaryDirectory(c.root);await leaf.trackProcess(99999999,{uncertainTree:true});
      await writeFile(${JSON.stringify(chainPath)},JSON.stringify({a,b,c,uncertainPid:99999999}));
      console.log(JSON.stringify({ok:true}));`;
    let chain;
    try {
      const result = await runOwnedTestOperation({ command: process.execPath, args: ['--input-type=module', '-e', child], cwd: root, env });
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.match(result.cleanupError, /OWNED_TEMP_PROCESS_UNCERTAIN/);
      chain = JSON.parse(await readFile(chainPath, 'utf8'));
      for (const node of [chain.a, chain.b, chain.c]) assert.ok(inside(temporaryParent, node.root));
      const ancestorRecord = JSON.parse(await readFile(join(chain.a.root, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.ok(ancestorRecord.uncertainTrees.includes(chain.uncertainPid), 'the leaf PID must propagate from the latest recursive child record to the root');
      assert.equal(await ownedTemporaryDirectoryIsIdle(chain.a.root, 'test-operation', chain.a.token), false);
      const next = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent, compact: true });
      try { for (const node of [chain.a, chain.b, chain.c]) assert.ok(existsSync(node.root), 'a later sweep must preserve each unproven owner'); }
      finally { await next.dispose(); }
      await assert.rejects((await attachOwnedTemporaryDirectory(chain.a.root)).dispose(), /OWNED_TEMP_PROCESS_UNCERTAIN/,
        'direct dispose must not bypass a recursively retained leaf');
    } finally {
      if (chain) {
        try {
          await retireStoppedFixtureOwner(chain.c.root, chain.c.token);
          await retireStoppedFixtureOwner(chain.b.root, chain.b.token);
          await retireStoppedFixtureOwner(chain.a.root, chain.a.token);
        } catch (error) {
          preserve();
          throw error;
        }
      } else preserve();
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
  await fixture(async ({ root, env, temporaryParent, preserve }) => {
    const backup = join(root, 'original-owner.json'), child = join(root, 'tamper.cjs');
    await writeFile(child, `const fs=require('node:fs'),path=require('node:path');
      const marker=path.join(process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT,'.soulforge-temporary-owner.json');
      fs.copyFileSync(marker,${JSON.stringify(backup)});fs.unlinkSync(marker);console.log(JSON.stringify({ok:true}));`);
    const result = await runSuite({ repoRoot, scriptName: 'test:owned-cleanup-negative', injectEnv: false, timeoutMs: 20_000, env,
      operation: { command: 'node', args: [child], cwd: root, validation: true } });
    const retained = result.temporaryOwnership.root;
    const originalOwner = JSON.parse(await readFile(backup, 'utf8'));
    try {
      assert.equal(result.outcome, OUTCOME.FAILED);
      assert.match(result.stdout, /\{"ok":true\}/, 'the fixture command emitted its success payload before ownership evidence was rejected');
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.ok(result.cleanupError.includes('OWNED_TEMP_OWNERSHIP_CHANGED'));
      assert.ok(inside(temporaryParent, retained));
      assert.equal(existsSync(retained), true);
    } finally {
      // Restore only this fixture's exact marker. Linux still has an
      // intentionally latched uncertain-tree proof, so cleanup below checks
      // the recorded fixture processes and retires only this captured root.
      await writeFile(join(retained, '.soulforge-temporary-owner.json'), await readFile(backup), { flag: 'wx' });
      if (process.platform === 'linux') {
        try { await retireStoppedFixtureOwner(retained, originalOwner.token); }
        catch (error) { preserve(); throw error; }
      } else await (await attachOwnedTemporaryDirectory(retained)).dispose();
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

test('missing owner root is failed as unproven instead of idempotently cleaned', { skip: process.platform !== 'linux' && 'fixture depends on POSIX removal of a non-cwd owner root' }, async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const child = join(root, 'remove-owner-root.cjs');
    await writeFile(child, `const fs=require('node:fs'),os=require('node:os');
      const ownerRoot=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;process.chdir(os.tmpdir());
      fs.rmSync(ownerRoot,{recursive:true,force:true});
      if(fs.existsSync(ownerRoot))throw new Error('owner root removal did not complete');`);
    const result = await runOwnedTestOperation({ command: process.execPath, args: [child], cwd: root, env, timeoutMs: 15_000 });
    assert.equal(result.code, 1);
    assert.equal(result.temporaryOwnership.state, 'unproven');
    assert.match(result.cleanupError, /OWNED_TEST_OWNER_ROOT_MISSING_UNPROVEN/);
    assert.equal(existsSync(result.temporaryOwnership.root), false);
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

test('normally disposed nested wrappers publish a bound completion before the parent ledger is removed', async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const result = await runNestedCompletionFixture({ root, env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.temporaryOwnership.state, 'cleaned');
    const evidence = nestedCompletionEvidence(result.stdout);
    assert.equal(evidence.nestedState, 'cleaned');
    assert.equal(evidence.childRootExists, false);
    assert.equal(evidence.completion.schema, 'soulforge.test-temporary-child-completion.v1');
    assert.equal(evidence.completion.state, 'disposed');
    assert.equal(evidence.completion.id, evidence.pending.id);
    assert.equal(evidence.completion.id, evidence.childReceipt.id);
    assert.equal(evidence.completion.parentToken, evidence.parentToken);
    assert.equal(evidence.completion.parentToken, evidence.pending.parentToken);
    assert.equal(evidence.completion.parentToken, evidence.childReceipt.parentToken);
    assert.equal(evidence.completion.childToken, evidence.childReceipt.token);
    assert.equal(evidence.completion.root, evidence.childReceipt.root);
    assert.equal(evidence.parentRootExistsAtPublication, true, 'the parent is still live while its nested child publishes completion');
    assert.equal(existsSync(evidence.parentRoot), false, 'the outer wrapper removes the parent only after consuming its completion proof');
    assert.deepEqual(await readdir(temporaryParent), [], 'parent cleanup consumes the completed child ledger only after the child root is gone');
  });
});

for (const mutation of ['missing', 'partial', 'id', 'parentToken', 'childToken', 'root', 'state']) test(`missing nested root with ${mutation} completion proof remains failed and preserves the parent ledger`, async () => {
  await fixture(async ({ root, temporaryParent, env, preserve }) => {
    let result;
    try {
      result = await runNestedCompletionFixture({ root, env, mutation });
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.match(result.cleanupError, /OWNED_TEST_CHILD_ROOT_MISSING_UNPROVEN/);
      const parentRoot = result.temporaryOwnership.root;
      assert.equal(existsSync(parentRoot), true, 'a missing or untrusted completion must retain the parent owner ledger');
      const parent = JSON.parse(await readFile(join(parentRoot, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(parent.retention.schema, 'soulforge.temporary-retention.v1');
      assert.match(parent.retention.reason, /OWNED_TEST_CHILD_ADMISSION_PENDING/);
      const names = await readdir(parentRoot);
      const pendingName = names.find(name => /^\.soulforge-test-child\.[a-f0-9-]{36}\.pending\.json$/.test(name));
      assert.ok(pendingName, 'pending parent ledger entry is retained');
      const base = join(parentRoot, pendingName.slice(0, -'.pending.json'.length));
      const pending = JSON.parse(await readFile(`${base}.pending.json`, 'utf8'));
      const child = JSON.parse(await readFile(`${base}.json`, 'utf8'));
      assert.equal(pending.id, child.id);
      assert.equal(pending.parentToken, parent.token);
      assert.equal(existsSync(child.root), false, 'the missing child root is not recreated to satisfy the ledger');
      if (mutation === 'missing') await assert.rejects(readFile(`${base}.completed.json`, 'utf8'), { code: 'ENOENT' });
      else if (mutation === 'partial') {
        const partial = await readFile(`${base}.completed.json`, 'utf8');
        assert.throws(() => JSON.parse(partial), SyntaxError);
      }
      else {
        const completion = JSON.parse(await readFile(`${base}.completed.json`, 'utf8'));
        const expected = { id: pending.id, parentToken: pending.parentToken, childToken: child.token,
          root: child.root, state: 'disposed' }[mutation];
        assert.notEqual(completion[mutation], expected);
      }
    } finally {
      const retained = result?.temporaryOwnership?.root;
      if (retained && existsSync(retained)) {
        try {
          const marker = JSON.parse(await readFile(join(retained, '.soulforge-temporary-owner.json'), 'utf8'));
          if (process.platform === 'linux') await retireStoppedFixtureOwner(retained, marker.token);
          else await (await attachOwnedTemporaryDirectory(retained)).dispose();
        } catch (error) { preserve(); throw error; }
      }
    }
  });
});

test('a valid completion cannot authorize cleanup after its child root is recreated', async () => {
  await fixture(async ({ root, temporaryParent, env, preserve }) => {
    let result, evidence, recreatedPath;
    const sentinelName = 'completion-root-fixture-sentinel', sentinelValue = 'owned-by-this-fixture';
    try {
      result = await runNestedCompletionFixture({ root, env, mutation: 'recreate-root' });
      evidence = nestedCompletionEvidence(result.stdout);
      recreatedPath = evidence.recreatedRootPath;
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.temporaryOwnership.state, 'retained');
      assert.match(result.cleanupError, /OWNED_TEST_CHILD_COMPLETION_CONTRADICTED/);
      assert.equal(evidence.childRootExists, true);
      assert.equal(recreatedPath, evidence.childReceipt.root);
      assert.equal(evidence.completion.schema, 'soulforge.test-temporary-child-completion.v1');
      assert.equal(evidence.completion.state, 'disposed');
      assert.equal(evidence.completion.id, evidence.pending.id);
      assert.equal(evidence.completion.parentToken, evidence.parentToken);
      assert.equal(evidence.completion.childToken, evidence.childReceipt.token);
      assert.equal(evidence.completion.root, evidence.childReceipt.root);
      assert.equal(inside(temporaryParent, recreatedPath), true, "only the fixture-owned temp parent's exact child path is eligible for teardown");
      assert.deepEqual(await readdir(recreatedPath), [sentinelName]);
      assert.equal(await readFile(join(recreatedPath, sentinelName), 'utf8'), sentinelValue);

      const parentRoot = result.temporaryOwnership.root;
      assert.equal(existsSync(parentRoot), true, 'a contradiction retains the parent ledger');
      const parent = JSON.parse(await readFile(join(parentRoot, '.soulforge-temporary-owner.json'), 'utf8'));
      assert.equal(parent.retention.schema, 'soulforge.temporary-retention.v1');
      const names = await readdir(parentRoot);
      const pendingName = names.find(name => /^\.soulforge-test-child\.[a-f0-9-]{36}\.pending\.json$/.test(name));
      assert.ok(pendingName);
      const base = join(parentRoot, pendingName.slice(0, -'.pending.json'.length));
      assert.equal(JSON.parse(await readFile(`${base}.json`, 'utf8')).root, recreatedPath);
      assert.equal(JSON.parse(await readFile(`${base}.completed.json`, 'utf8')).root, recreatedPath);
    } finally {
      if (!evidence) preserve();
      else {
        if (recreatedPath && existsSync(recreatedPath)) {
          try {
            assert.equal(inside(temporaryParent, recreatedPath), true);
            assert.equal(recreatedPath, evidence.childReceipt.root,
              'teardown must use only the exact child root recorded in this fixture parent ledger');
            assert.equal(existsSync(join(recreatedPath, '.soulforge-temporary-owner.json')), false,
              'the recreated path is not an owner root and must not be adopted');
            assert.deepEqual(await readdir(recreatedPath), [sentinelName]);
            assert.equal(await readFile(join(recreatedPath, sentinelName), 'utf8'), sentinelValue);
            await rm(recreatedPath, { recursive: true, force: true });
          } catch (error) { preserve(); throw error; }
        }
        const retained = result?.temporaryOwnership?.root;
        if (retained && existsSync(retained)) {
          try {
            const marker = JSON.parse(await readFile(join(retained, '.soulforge-temporary-owner.json'), 'utf8'));
            if (process.platform === 'linux') await retireStoppedFixtureOwner(retained, marker.token);
            else await (await attachOwnedTemporaryDirectory(retained)).dispose();
          } catch (error) { preserve(); throw error; }
        }
      }
    }
  });
});

test('cleanup failure marks a vanished root unproven and preserves an explicit null SIGTERM child exit', { skip: process.platform !== 'linux' && 'Linux Guardian signal receipt required' }, async () => {
  await fixture(async ({ root, temporaryParent, env }) => {
    const ready = join(root, 'sigterm-child-ready.json'), child = join(root, 'sigterm-child.cjs');
    await writeFile(child, `const fs=require('node:fs');
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));
      setTimeout(()=>process.kill(process.pid,'SIGTERM'),25);setInterval(()=>{},1000);`);
    const { runOwnedTestOperation: runInstrumented } = await loadOwnedTestEnvironmentWithClosedMarkerRemovalHook(root);
    const result = await runInstrumented({ command: process.execPath, args: [child], cwd: root, env, timeoutMs: 15_000 });
    assert.equal(existsSync(ready), true);
    assert.equal(result.signal, 'SIGTERM', result.stderr);
    assert.equal(Object.hasOwn(result, 'childExitCode'), true);
    assert.equal(result.childExitCode, null, 'cleanup failure must not replace a known signal exit with the wrapper failure code');
    assert.notEqual(result.code, 0);
    assert.equal(result.temporaryOwnership.state, 'unproven', 'the cleanup hook deletes the owner after identity validation but before readdir');
    assert.match(result.cleanupError, /ENOENT/);
    assert.equal(existsSync(result.temporaryOwnership.root), false);
    assert.deepEqual(await readdir(temporaryParent), []);
  });
});

for (const mode of ['cli-exit', 'restart-sweep']) test(`uncertain child admission remains retained through ${mode}`, async () => {
  await fixture(async ({ root, temporaryParent, env, owner, preserve }) => {
    const fixtureToken = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8')).token;
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
        if (process.platform === 'linux') {
          try {
            await retireStoppedFixtureOwner(before.child, before.childRecord.token);
            await retireStoppedFixtureOwner(before.parent, before.parentRecord.token);
            await retireStoppedFixtureOwner(owner.root, fixtureToken);
          } catch (error) { preserve(); throw error; }
        } else {
          if (mode === 'restart-sweep') recordOwnedProcess({ root: before.child, token: before.childRecord.token }, before.actorPid, { finished: true });
          await (await attachOwnedTemporaryDirectory(before.child)).dispose();
          if (existsSync(before.parent)) {
            await writeFile(join(before.parent, `.soulforge-test-child.${before.id}.json`), JSON.stringify({
              schema: 'soulforge.test-temporary-child.v1', id: before.id, parentToken: before.parentRecord.token,
              root: before.child, token: before.childRecord.token
            }), { flag: 'wx', mode: 0o600 });
            await (await attachOwnedTemporaryDirectory(before.parent)).dispose();
          }
        }
      }
    }
    if (process.platform === 'linux' && before) assert.equal(existsSync(owner.root), false, 'manual teardown removes only this verified fixture owner');
    else assert.deepEqual(await readdir(temporaryParent), []);
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

test('real child admission retains evidence after a forced stop and requires platform-specific tree proof', async () => {
  await fixture(async ({ root, temporaryParent, env, owner, preserve }) => {
    const fixtureToken = JSON.parse(await readFile(join(owner.root, '.soulforge-temporary-owner.json'), 'utf8')).token;
    const ready = join(root, 'admitted.json'), release = join(root, 'release'), actor = join(root, 'admitted.cjs');
    await writeFile(actor, `const fs=require('node:fs'),path=require('node:path');const root=process.env.SOULFORGE_TEST_TEMP_OWNER_ROOT;
      const parent=JSON.parse(fs.readFileSync(path.join(root,'.soulforge-test-parent.json'),'utf8'));
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({root,token:process.env.SOULFORGE_TEST_TEMP_OWNER_TOKEN,parent,pid:process.pid}));
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
      // the known fixture actor finish, but absence of a supervisor receipt
      // still means the owned tree is not proven idle.
      await writeFile(release, 'done');
      if (process.platform === 'linux') {
        await waitFor(() => ownedPidStopped(info.pid), 'known fixture actor to stop after release');
        assert.equal(await ownedTemporaryDirectoryIsIdle(info.parent.parentRoot, 'test-operation', info.parent.parentToken), false,
          'stopping the writer is not a replacement for the missing Linux supervisor completion receipt');
      } else {
        await waitFor(() => ownedTemporaryDirectoryIsIdle(info.parent.parentRoot, 'test-operation', info.parent.parentToken),
          'Windows Job proof to confirm the owned tree stopped');
        assert.equal(await ownedTemporaryDirectoryIsIdle(info.parent.parentRoot, 'test-operation', info.parent.parentToken), true,
          'Windows may use its independent Job proof to establish stopped state');
      }
      const next = await createOwnedTemporaryDirectory('test-operation', { parent: temporaryParent });
      try {
        assert.equal(existsSync(info.parent.parentRoot), true, 'automatic reclaim must not erase admission evidence after the tree stops');
        const record = JSON.parse(await readFile(join(info.parent.parentRoot, '.soulforge-temporary-owner.json'), 'utf8'));
        assert.equal(record.retention.reason, 'OWNED_TEST_CHILD_ADMISSION_PENDING');
      } finally { await next.dispose(); }
    } finally {
      await writeFile(release, 'done');
      if (info && process.platform === 'linux') {
        try {
          await retireStoppedFixtureOwner(info.root, info.token);
          await retireStoppedFixtureOwner(info.parent.parentRoot, info.parent.parentToken);
          await retireStoppedFixtureOwner(owner.root, fixtureToken);
        } catch (error) { preserve(); throw error; }
      } else if (info) {
        if (existsSync(info.root)) await (await attachOwnedTemporaryDirectory(info.root)).dispose();
        if (existsSync(info.parent.parentRoot)) await (await attachOwnedTemporaryDirectory(info.parent.parentRoot)).dispose();
      }
    }
    if (process.platform === 'linux' && info) assert.equal(existsSync(owner.root), false, 'manual teardown retires only this verified fixture owner');
    else assert.deepEqual(await readdir(temporaryParent), []);
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
