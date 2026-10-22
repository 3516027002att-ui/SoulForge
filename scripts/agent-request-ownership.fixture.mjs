// Complete production Agent adapter with controlled service ports. No provider,
// utility, worker, filesystem writes or native process is started by this fixture.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'apps/desktop/src/main/ipc/agent.ts');
const require = createRequire(import.meta.url);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function runtime() {
  let sessionDisposals = 0, embeddingDisposals = 0, operation;
  const handlers = new Map();
  const refuse = () => { throw new Error('unexpected model, worker or domain operation'); };
  const ports = {
    '../agentUtilityClient.js': { runAgentUtilitySession: refuse },
    electron: { app: { getPath: () => resolve('/owned-agent-fixture') }, dialog: { showMessageBox: refuse } },
    '@soulforge/core': { createConfiguredModelServiceAdapter: refuse },
    '@soulforge/shared': {},
    '../services/agentSessionService.js': { createAgentSessionService: () => ({ dispose() { sessionDisposals++; return Promise.resolve(); } }) },
    '../services/agentEvidenceService.js': { createAgentEvidenceService: () => ({}) },
    '../services/agentLocalService.js': { createAgentLocalService: () => ({ runTool: () => operation() }) },
    '../ragEmbedding.js': { InternalRagEmbeddingService: class { dispose() { embeddingDisposals++; return Promise.resolve(); } } }
  };
  const built = ts.transpileModule(readFileSync(sourcePath, 'utf8'), { fileName: sourcePath, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((built.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, require(name) {
    if (Object.hasOwn(ports, name)) return ports[name];
    if (['node:crypto', 'node:path'].includes(name)) return require(name);
    throw new Error('Unexpected Agent adapter import: ' + name);
  } });
  // Load the unchanged module, then exercise its public ai.runTool IPC adapter.
  vm.runInContext(built.outputText, context, { filename: sourcePath });
  exports.registerAgentIpcHandlers({ handle: (name, handler) => handlers.set(name, handler), webContents: { id: 1, once() {} } });
  return {
    own(port) { operation = port; return handlers.get('ai.runTool')({ sender: { id: 1 } }, 'owned-fixture', {}); },
    dispose: exports.disposeAgentIpcServices,
    // Read-only test observation of the actual module-owned set; never replace it.
    count: () => vm.runInContext('pendingAgentRequests.size', context),
    disposals: () => [sessionDisposals, embeddingDisposals]
  };
}

test('port starts synchronously only after its owned promise is registered', async () => {
  const host = runtime(), tail = deferred(); let entered = false, countInside = -1;
  const pending = host.own(() => { entered = true; countInside = host.count(); return tail.promise; });
  const enteredAtReturn = entered;
  tail.resolve({ ok: true }); await pending;
  assert.equal(enteredAtReturn, true, 'admission must not move past a caller workspace replacement');
  assert.equal(countInside, 1, 'even a reentrant host port must already have an owned promise');
  assert.equal(host.count(), 0);
});

test('shutdown immediately after admission drains the actual port tail and preserves its result', async () => {
  const host = runtime(), tail = deferred(); let calls = 0, drained = false;
  const pending = host.own(() => { calls++; return tail.promise; });
  const disposal = host.dispose(); disposal.then(() => { drained = true; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const drainedBeforeTail = drained;
  const outcome = { ok: true, committed: 'owned-fact' }; tail.resolve(outcome);
  const actual = await pending; await disposal;
  assert.equal(calls, 1, 'an admitted request captures/starts its real port synchronously');
  assert.equal(drainedBeforeTail, false);
  assert.equal(actual, outcome, 'shutdown cannot relabel a settled admitted result as pre-admission cancellation');
  assert.equal(host.count(), 0);
});

test('shutdown reentered from the port sees ownership and is idempotent', async () => {
  const host = runtime(), tail = deferred(); let disposal, drained = false, countInside = -1;
  const pending = host.own(() => { countInside = host.count(); disposal = host.dispose(); disposal.then(() => { drained = true; }); return tail.promise; });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(countInside, 1); assert.equal(drained, false); assert.equal(host.dispose(), disposal);
  tail.resolve({ ok: true }); await pending; await disposal;
  assert.deepEqual(host.disposals(), [1, 1]); assert.equal(host.count(), 0);
});

test('stopped admission never invokes a new port', async () => {
  const host = runtime(); await host.dispose(); let calls = 0;
  const value = await host.own(() => { calls++; return Promise.resolve({ ok: true }); });
  assert.equal(value.ok, false); assert.equal(value.error.code, 'AGENT_SERVICE_DISPOSED'); assert.equal(value.state, 'cancelled');
  assert.equal(calls, 0); assert.equal(host.count(), 0);
});

test('synchronous and asynchronous port failures retain rejection and release ownership', async () => {
  for (const synchronous of [true, false]) {
    const host = runtime(), sentinel = new Error('owned port failure'); let pending;
    assert.doesNotThrow(() => { pending = host.own(() => { if (synchronous) throw sentinel; return Promise.reject(sentinel); }); });
    await assert.rejects(pending, error => error === sentinel);
    assert.equal(host.count(), 0); await host.dispose();
  }
});
