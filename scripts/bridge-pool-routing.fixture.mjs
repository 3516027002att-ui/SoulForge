// Exercise the actual production pool module with deferred startup promises.
// The seam replaces child-process startup only; no native/Electron process runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(root, 'packages/core/src/bridge/runBridge.ts');
const fixtureRoot = path.join(root, 'owned-pool-fixture');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settleTurns() { await turn(); await turn(); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function harness(startup = () => undefined) {
  const starts = [], requests = [], disposed = [];
  class BridgeDaemonError extends Error {
    constructor(code, message, retryable = false) { super(message); this.code = code; this.retryable = retryable; }
  }
  const makeClient = options => ({
    options, isClosed: false, isIdle: true,
    async request(input) {
      requests.push({ client: this, input });
      return { result: { parseStatus: 'partial', diagnostics: [], data: { ownedFixture: true } } };
    },
    async dispose() { this.isClosed = true; disposed.push(this); }
  });
  const BridgeDaemonClient = {
    start(options) {
      starts.push(options);
      return startup(options, starts.length, makeClient) ?? Promise.resolve(makeClient(options));
    }
  };
  const source = fs.readFileSync(modulePath, 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL('../packages/core/src/bridge/runBridge.ts', import.meta.url).href));
  const built = ts.transpileModule(source, { fileName: modulePath, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  vm.runInNewContext(built.outputText + '\nexports.fixturePool = clients; exports.fixtureLeases = client => activeClientUses.get(client) ?? 0;', {
    exports, module: { exports }, process, Buffer, Error,
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === './bridgeDaemonClient.js') return { BridgeDaemonClient, BridgeDaemonError };
      if (name === './bridgeTransportTiming.js') return { createBridgeTransportTimingCollector() { throw new Error('Unexpected timing capability'); } };
      throw new Error(`Unexpected pool runtime import: ${name}`);
    }
  }, { filename: modulePath });
  const options = overrides => ({ bridgeProjectPath: path.join(fixtureRoot, 'Bridge.csproj'),
    bridgeExecutablePath: path.join(fixtureRoot, 'Bridge'), command: 'read-luabnd-script',
    filePath: path.join(fixtureRoot, 'sample.luabnd'), allowedRoots: [fixtureRoot],
    workspaceSessionId: 'save-session', timeoutMs: 120_000, maxFrameBytes: 32 * 1024 * 1024,
    ...overrides });
  return { ...exports, starts, requests, disposed, makeClient, BridgeDaemonError, options };
}

for (const [name, firstOptions, secondOptions] of [
  ['executable', { bridgeExecutablePath: path.join(fixtureRoot, 'DifferentBridge') }, {}],
  ['launch arguments', { bridgeExecutablePath: undefined, bridgeProjectPath: path.join(fixtureRoot, 'project-a/Bridge.csproj') },
    { bridgeExecutablePath: undefined, bridgeProjectPath: path.join(fixtureRoot, 'project-b/Bridge.csproj') }],
  ['workspace session', { workspaceSessionId: 'other-session' }, {}],
  ['read roots', { allowedRoots: [path.join(fixtureRoot, 'other')] }, {}],
  ['write roots', {}, { writableRoots: [path.join(fixtureRoot, 'stage')] }],
  ['Oodle scope', { oodleRuntimeRoot: path.join(fixtureRoot, 'base-a') }, { oodleRuntimeRoot: path.join(fixtureRoot, 'base-b') }],
  ['frame budget', { maxFrameBytes: 16 * 1024 * 1024 }, {}],
  ['concurrency budget', { maxConcurrency: 1 }, { maxConcurrency: 2 }]
]) test(`an incompatible pending ${name} startup cannot block another save request`, async () => {
  const pending = deferred();
  const h = harness((_options, index) => index === 1 ? pending.promise : undefined);
  const first = h.runBridge(h.options(firstOptions));
  await settleTurns();
  assert.equal(h.starts.length, 1);
  let settled = false;
  const second = h.runBridge(h.options(secondOptions)).then(result => { settled = true; return result; });
  try {
    await settleTurns();
    assert.equal(settled, true, 'request waited for a provably incompatible startup');
    assert.equal(h.starts.length, 2);
    assert.equal((await second).parseStatus, 'partial');
    assert.equal(h.requests[0].input.timeoutMs, 120_000);
  } finally {
    pending.resolve(h.makeClient(h.starts[0]));
    await Promise.all([first, second]);
    await h.disposeBridgeDaemonPool();
  }
});

test('matching pending callers share exactly one startup and release both leases', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const first = h.runBridge(h.options());
  await settleTurns();
  const second = h.runBridge(h.options());
  await settleTurns();
  assert.equal(h.starts.length, 1);
  const client = h.makeClient(h.starts[0]);
  pending.resolve(client);
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.parseStatus === 'partial'));
  assert.equal(h.requests.length, 2);
  assert.equal(h.fixtureLeases(client), 0);
  await h.disposeBridgeDaemonPool();
  assert.equal(h.disposed.length, 1);
});

test('matching startup failure is reported once per caller and only a later independent request recovers', async () => {
  const pending = deferred();
  const h = harness((_options, index) => index === 1 ? pending.promise : undefined);
  const first = h.runBridge(h.options());
  await settleTurns();
  const second = h.runBridge(h.options());
  await settleTurns();
  pending.reject(new h.BridgeDaemonError('BRIDGE_SPAWN_FAILED', 'owned startup failed', true));
  const results = await Promise.all([first, second]);
  assert.equal(h.starts.length, 1, 'matching failure was silently retried');
  assert.ok(results.every(result => result.diagnostics.some(item => item.code === 'BRIDGE_SPAWN_FAILED')));
  assert.equal(h.fixturePool.size, 0);
  assert.equal(h.requests.length, 0);
  const recovered = await h.runBridge(h.options());
  assert.equal(recovered.parseStatus, 'partial');
  assert.equal(h.starts.length, 2, 'only the explicit independent request may start a replacement');
  await h.disposeBridgeDaemonPool();
});

test('a startup adapter cannot widen the immutable pending root and argument proof', async () => {
  const pending = deferred();
  const h = harness((options, index) => {
    if (index !== 1) return undefined;
    options.allowedRoots.push(fixtureRoot);
    options.args.push('adapter-mutated');
    return pending.promise;
  });
  const first = h.runBridge(h.options({ allowedRoots: [path.join(fixtureRoot, 'narrow')] }));
  await settleTurns();
  let settled = false;
  const second = h.runBridge(h.options()).then(result => { settled = true; return result; });
  try {
    await settleTurns();
    assert.equal(settled, true, 'adapter mutation widened a pending routing proof');
    assert.equal((await second).parseStatus, 'partial');
    assert.equal(h.starts.length, 2);
  } finally {
    pending.resolve(h.makeClient(h.starts[0]));
    await Promise.all([first, second]);
    await h.disposeBridgeDaemonPool();
  }
});

test('a ready covering client retains read/write scope and active leases during idle pruning', async () => {
  const h = harness();
  await h.runBridge(h.options({ writableRoots: [path.join(fixtureRoot, 'stage')] }));
  const client = h.requests[0].client;
  const hold = deferred();
  client.isIdle = false;
  client.request = async input => { h.requests.push({ client, input }); await hold.promise;
    return { result: { parseStatus: 'partial', diagnostics: [], data: {} } }; };
  const request = h.runBridge(h.options({ allowedRoots: [path.join(fixtureRoot, 'stage/child')],
    writableRoots: [path.join(fixtureRoot, 'stage/child')] }));
  await settleTurns();
  assert.equal(h.starts.length, 1);
  assert.equal(h.fixtureLeases(client), 1);
  assert.equal((await h.disposeIdleBridgeDaemonPool()).activeClientCount, 1);
  assert.equal(client.isClosed, false);
  hold.resolve();
  await request;
  assert.equal(h.fixtureLeases(client), 0);
  client.isIdle = true;
  assert.equal((await h.disposeIdleBridgeDaemonPool()).disposedClientCount, 1);
  assert.equal(h.fixturePool.size, 0);
});

test('an obsolete startup cannot acquire a lease after its pool entry was replaced', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const request = h.runBridge(h.options());
  await settleTurns();
  const key = h.fixturePool.keys().next().value;
  const obsolete = h.makeClient(h.starts[0]);
  const replacement = h.makeClient(h.starts[0]);
  h.fixturePool.set(key, Promise.resolve(replacement));
  pending.resolve(obsolete);
  assert.equal((await request).parseStatus, 'partial');
  assert.equal(h.requests[0].client, replacement);
  assert.equal(h.fixtureLeases(obsolete), 0);
  assert.equal(h.fixtureLeases(replacement), 0);
  await h.disposeBridgeDaemonPool();
});

test('startup failure reports immediately while preserving a pending replacement', async () => {
  const initial = deferred(), replacementStart = deferred();
  const h = harness(() => initial.promise);
  let settled = false;
  const request = h.runBridge(h.options()).then(result => { settled = true; return result; });
  await settleTurns();
  const key = h.fixturePool.keys().next().value;
  h.fixturePool.set(key, replacementStart.promise);
  initial.reject(new h.BridgeDaemonError('BRIDGE_SPAWN_FAILED', 'owned initial startup failed', true));
  try {
    await settleTurns();
    assert.equal(settled, true, 'failed caller waited for the replacement startup');
    assert.ok((await request).diagnostics.some(item => item.code === 'BRIDGE_SPAWN_FAILED'));
    assert.equal(h.fixturePool.get(key), replacementStart.promise);
  } finally {
    replacementStart.resolve(h.makeClient(h.starts[0]));
    await request;
    await h.disposeBridgeDaemonPool();
  }
});

test('simultaneous exact-key waiters preserve and reuse a replacement without a third startup', async () => {
  const initial = deferred(), replacementStart = deferred();
  const h = harness((_options, index) => index === 1 ? initial.promise : undefined);
  const first = h.runBridge(h.options());
  const second = h.runBridge(h.options());
  await settleTurns();
  assert.equal(h.starts.length, 1);
  const key = h.fixturePool.keys().next().value;
  const obsolete = h.makeClient(h.starts[0]);
  const replacement = h.makeClient(h.starts[0]);
  h.fixturePool.set(key, replacementStart.promise);
  initial.resolve(obsolete);
  try {
    await settleTurns();
    assert.equal(h.fixturePool.get(key), replacementStart.promise, 'an obsolete exact-key waiter deleted the replacement');
    assert.equal(h.starts.length, 1);
    replacementStart.resolve(replacement);
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.parseStatus === 'partial'));
    assert.ok(h.requests.every(request => request.client === replacement));
    assert.equal(h.fixtureLeases(obsolete), 0);
    assert.equal(h.fixtureLeases(replacement), 0);
  } finally {
    replacementStart.resolve(replacement);
    await Promise.all([first, second]);
    await h.disposeBridgeDaemonPool();
  }
});

test('a closed leased client reports its error and releases its lease without touching a pending replacement', async () => {
  const h = harness();
  await h.runBridge(h.options());
  const client = h.requests[0].client;
  const requestFailure = deferred(), replacementStart = deferred();
  client.request = async () => requestFailure.promise;
  let settled = false;
  const request = h.runBridge(h.options()).then(result => { settled = true; return result; });
  await settleTurns();
  assert.equal(h.fixtureLeases(client), 1);
  const key = h.fixturePool.keys().next().value;
  h.fixturePool.set(key, replacementStart.promise);
  client.isClosed = true;
  requestFailure.reject(new h.BridgeDaemonError('BRIDGE_PROCESS_EXITED', 'owned request process exited', true));
  try {
    await settleTurns();
    assert.equal(settled, true);
    assert.ok((await request).diagnostics.some(item => item.code === 'BRIDGE_PROCESS_EXITED'));
    assert.equal(h.fixturePool.get(key), replacementStart.promise);
    assert.equal(h.fixtureLeases(client), 0);
  } finally {
    replacementStart.resolve(h.makeClient(h.starts[0]));
    await request;
    await h.disposeBridgeDaemonPool();
  }
});

test(`read root case follows the actual ${process.platform} filesystem comparison`, async () => {
  const h = harness();
  const lower = path.join(fixtureRoot, 'resource'), upper = path.join(fixtureRoot, 'Resource');
  try {
    await h.runBridge(h.options({ allowedRoots: [lower], filePath: path.join(lower, 'sample.luabnd') }));
    await h.runBridge(h.options({ allowedRoots: [upper], filePath: path.join(upper, 'sample.luabnd') }));
    assert.equal(h.starts.length, process.platform === 'win32' ? 1 : 2,
      'case-different sibling roots were treated as the same POSIX root');
  } finally { await h.disposeBridgeDaemonPool(); }
});

test(`write root case follows the actual ${process.platform} filesystem comparison`, async () => {
  const h = harness();
  try {
    await h.runBridge(h.options({ writableRoots: [path.join(fixtureRoot, 'stage')] }));
    await h.runBridge(h.options({ writableRoots: [path.join(fixtureRoot, 'Stage')] }));
    assert.equal(h.starts.length, process.platform === 'win32' ? 1 : 2,
      'case-different sibling writable roots were treated as the same POSIX root');
  } finally { await h.disposeBridgeDaemonPool(); }
});

test('exact read/write roots and real descendants reuse the same startup', async () => {
  const h = harness();
  const base = path.join(fixtureRoot, 'stage');
  try {
    const options = h.options({ allowedRoots: [base], writableRoots: [base] });
    await h.runBridge(options);
    await h.runBridge(options);
    await h.runBridge(h.options({ allowedRoots: [path.join(base, 'child')], writableRoots: [path.join(base, 'child')] }));
    assert.equal(h.starts.length, 1);
    assert.equal(h.requests.length, 3);
  } finally { await h.disposeBridgeDaemonPool(); }
});

test('a root name prefix cannot cover a sibling without a directory separator', async () => {
  const h = harness();
  try {
    await h.runBridge(h.options({ allowedRoots: [path.join(fixtureRoot, 'resource')] }));
    await h.runBridge(h.options({ allowedRoots: [path.join(fixtureRoot, 'resource-other')] }));
    assert.equal(h.starts.length, 2);
  } finally { await h.disposeBridgeDaemonPool(); }
});
