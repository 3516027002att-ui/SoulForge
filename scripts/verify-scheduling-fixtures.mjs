import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaces, resolveScriptEntries } from './verify/scriptGraph.mjs';
import { operationKey, planScript, tokenizeCommands } from './verify/commandPlan.mjs';
import { runPlannedSuite } from './verify/runner.mjs';

const root = mkdtempSync(join(tmpdir(), 'soulforge-scheduling-'));
const write = (path, text) => writeFileSync(join(root, path), text);
try {
  mkdirSync(join(root, 'packages/a'), { recursive: true });
  mkdirSync(join(root, 'packages/b'), { recursive: true });
  mkdirSync(join(root, 'packages/a/src'), { recursive: true });
  const pkg = { workspaces: ['packages/*'], scripts: {
    'test': 'npm run test --workspaces --if-present && npm run test:one && npm run test:one',
    'test:one': 'node "pass file.mjs"',
    'test:unbuilt': 'node packages/a/dist/helper.js',
    'test:flag': 'node --enable-source-maps "pass file.mjs"',
    'test:fail': 'node fail.mjs && node never.mjs',
    'test:skip': 'node skip.mjs',
    'test:partial': 'node "pass file.mjs" && node skip.mjs',
    'test:quiet': 'node quiet.mjs',
    'test:timeout': 'node timeout.mjs',
    'test:hook': 'node "pass file.mjs"',
    'pretest:hook': 'node hook.mjs',
    'test:cycle': 'npm run test:cycle',
    'build': 'node "pass file.mjs"',
    'test:barrier': 'npm run test:one && npm run build && npm run test:one',
    'test:unknown': 'node -e "console.log(1)"'
  } };
  write('package.json', JSON.stringify(pkg));
  write('packages/a/package.json', JSON.stringify({ name: '@fixture/a', scripts: { test: 'node probe.mjs' } }));
  write('packages/b/package.json', JSON.stringify({ name: '@fixture/b' }));
  write('packages/a/probe.mjs', 'console.log(JSON.stringify({ok:true,cwd:process.cwd()}));');
  write('packages/a/src/helper.ts', 'export const fixture = true;');
  write('pass file.mjs', `import {appendFileSync} from 'node:fs'; appendFileSync('count.txt', 'x'); console.log(JSON.stringify({ok:true,mode:process.env.SF_FIXTURE_MODE??null,args:process.argv.slice(2)}));`);
  write('fail.mjs', 'console.error("expected failure"); process.exit(7);');
  write('never.mjs', 'throw new Error("must not execute after failure");');
  write('skip.mjs', 'console.log(JSON.stringify({status:"skipped"}));');
  write('quiet.mjs', '// deliberately produces no evidence');
  write('timeout.mjs', 'setTimeout(() => console.log("too late"), 60000);');
  write('hook.mjs', 'console.log("HOOK_EXECUTED");');
  const workspaces = loadWorkspaces(root);
  const entry = (name, options) => ({ scriptName: name, steps: planScript(root, workspaces, name, options) });
  const run = (e, cache = new Map()) => runPlannedSuite({ repoRoot: root, entry: e, timeoutMs: 15000, cache, injectEnv: false });
  assert.deepEqual(resolveScriptEntries(root, workspaces, 'test').cycles, []);
  assert.equal(resolveScriptEntries(root, workspaces, 'test').entryFiles.length, 2);
  assert.deepEqual(resolveScriptEntries(root, workspaces, 'test:unbuilt').entryFiles, [join(root, 'packages/a/src/helper.ts')]);
  assert.throws(() => entry('test:cycle'), /cycle/);
  assert.equal(tokenizeCommands('node a.mjs | node b.mjs'), null);
  assert.equal(tokenizeCommands('node "$TOKEN"'), null);
  assert.equal(entry('test:unknown').steps[0].command, 'npm');
  const cache = new Map();
  const aggregate = await run(entry('test'), cache);
  assert.equal(aggregate.outcome, 'passed');
  assert.equal(aggregate.steps.filter((s) => s.execution === 'executed').length, 2);
  assert.equal(aggregate.steps.filter((s) => s.execution === 'reused').length, 1);
  const alias = await run(entry('test:one'), cache);
  assert.equal(alias.steps[0].execution, 'reused');
  assert.equal(readFileSync(join(root, 'count.txt'), 'utf8'), 'x');
  const changedEnv = await run(entry('test:one', { env: { SF_FIXTURE_MODE: 'native' } }), cache);
  assert.equal(changedEnv.steps[0].execution, 'executed');
  assert.match(changedEnv.stdout, /native/);
  const changedArgs = await run(entry('test:one', { args: ['--mode', 'fixture value'] }), cache);
  assert.equal(changedArgs.steps[0].execution, 'executed');
  assert.match(changedArgs.stdout, /fixture value/);
  const flag = await run(entry('test:flag'), cache);
  assert.equal(flag.steps[0].command, 'node');
  assert.equal(flag.steps[0].execution, 'executed');
  const step = entry('test:one').steps[0];
  assert.notEqual(operationKey(step), operationKey({ ...step, cwd: join(root, 'packages/a') }));
  const failed = await run(entry('test:fail'));
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.steps.length, 1);
  assert.equal((await run(entry('test:skip'))).outcome, 'skipped');
  assert.equal((await run(entry('test:partial'))).outcome, 'partial');
  assert.equal((await run(entry('test:quiet'))).outcome, 'skipped');
  const skipCache = new Map();
  await run(entry('test:skip'), skipCache);
  assert.equal((await run(entry('test:skip'), skipCache)).steps[0].execution, 'executed');
  const hookCache = new Map();
  const hook = await run(entry('test:hook'), hookCache);
  assert.match(hook.stdout, /HOOK_EXECUTED/);
  assert.equal(hook.steps.length, 1);
  assert.equal((await run(entry('test:hook'), hookCache)).steps[0].execution, 'executed');
  const timed = await runPlannedSuite({ repoRoot: root, entry: entry('test:timeout'), timeoutMs: 300, cache: new Map(), injectEnv: false });
  assert.equal(timed.outcome, 'failed');
  assert.equal(timed.timedOut, true);
  const barrier = await run(entry('test:barrier'));
  assert.equal(barrier.steps.filter((s) => s.execution === 'reused').length, 0);
  console.log(JSON.stringify({ ok: true, checks: 30, message: '调度实际进程、workspace、复用隔离、生命周期、超时/失败/跳过边界通过' }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
