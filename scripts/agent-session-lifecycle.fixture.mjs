// Execute the production coordinator with deferred, in-memory host ports only.
// No Electron, provider, worker, database, native resource or build is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { BoundedEventHistory } from '../packages/agent/src/eventHistory.mjs';

const require = createRequire(import.meta.url);
const source = new URL('../apps/desktop/src/main/services/agentSessionService.ts', import.meta.url);
const tick = () => new Promise(done => setImmediate(done));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const terminal = { rolloutPath: path.resolve('owned-sessions/owned.jsonl') };

function harness(options = {}) {
  const calls = [], events = [];
  const coreSession = { close() { calls.push('close'); return options.close?.(); } };
  const core = {
    openAgentCoreToolSession: async input => { calls.push('open'); await options.open?.(input); return coreSession; },
    createAgentToolContextProvider: () => () => ({}),
    createAgentToolBridge: () => ({ executeTool: () => assert.fail('real tools are forbidden') }),
    createAgentRunAssembly: () => { calls.push('assembly'); return {
      async waitForHostOperations() { calls.push('host'); await options.host?.(); }
    }; },
    createAgentRagSearch: () => assert.fail('real RAG search is forbidden')
  };
  const exports = {};
  const built = ts.transpileModule(fs.readFileSync(source, 'utf8'), { fileName: source.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(built.outputText, { exports, module: { exports }, AbortController, console, setTimeout, clearTimeout,
    require(name) {
      if (name.startsWith('node:')) return require(name);
      if (name === '@soulforge/core') return core;
      if (name.endsWith('/eventHistory.mjs')) return { BoundedEventHistory };
      if (name === '../rendererDto.js') return { sanitizeRendererValue: value => structuredClone(value) };
      if (name === '../agentSessionOutcome.js') return { agentSessionOutcomeEvents: () => [{ type: 'session-done' }] };
      if (name === '../ipc/agentBridgeContext.js') return { createAgentBridgeBaseContext: () => ({}) };
      if (name === '../ipc/generatedTextDiffCounts.js') return {};
      throw new Error(`Unexpected lifecycle import ${name}`);
    }
  }, { filename: source.pathname });
  const service = exports.createAgentSessionService({
    sessionsDir: path.resolve('owned-sessions'), toolRegistry: { list: () => [] },
    memoryManager: { getFullMemoryForSystemPrompt: () => '' }, operationLogUtility: {},
    getActiveSession: () => ({ meta: { workspaceId: 'owned' } }), getActiveIndex: () => null,
    getActiveWorkspaceSessionId: () => 'owned', currentToolContext: () => ({}),
    waitForWorkspaceIndexing: () => assert.fail('real indexing is forbidden'),
    ensureActiveOperationLog: async () => { calls.push('database'); return {}; },
    durableStoragePaths: () => ({}), readSystemPrompt: () => '', ownerAvailable: () => true,
    publishEvent: (_owner, event) => events.push(event), sessionRunner: () => assert.fail('model execution is forbidden'),
    evidence: { hasRagSearchCorpus: async () => { calls.push('rag'); return options.rag ? options.rag() : false; } }
  });
  let invocation;
  function run(sessionId = 'owned', useRagSearch = false) {
    return service.run({ ownerId: 1, sessionId, mode: 'plan', citationLines: [], request: { prompt: 'owned', useRagSearch },
      authorization: { serviceId: 'owned', model: 'owned', sampling: {},
        bindTarget() { calls.push('bind'); options.bind?.(service); },
        requestWriteConfirmation: () => assert.fail('dialogs are forbidden'),
        execute: (_assembly, input) => { invocation = input; calls.push('execute'); return options.execute ? options.execute(input) : Promise.resolve(terminal); }
      }
    });
  }
  return { service, run, calls, events, get invocation() { return invocation; } };
}

test('Agent dispose closes preparation admission synchronously and drains its pending core session', async () => {
  const start = deferred(), wait = deferred();
  const h = harness({ open: async () => { start.resolve(); await wait.promise; } });
  const run = h.run(); await start.promise;
  let done = false, disposal;
  try {
    disposal = h.service.dispose(); assert.equal(h.service.dispose(), disposal);
    void disposal.then(() => { done = true; });
    assert.equal((await h.run('late')).error.code, 'AGENT_SERVICE_DISPOSED');
    await tick(); assert.equal(done, false);
  } finally { wait.resolve(); await run; await disposal; h.service.clearState(); }
  assert.equal(h.calls.filter(value => value === 'close').length, 1);
  assert.equal(h.calls.includes('bind'), false); assert.equal(h.calls.includes('execute'), false);
});

test('Agent dispose aborts execution immediately but drains execution, host operations and core close', async () => {
  const executeStart = deferred(), executeWait = deferred(), hostStart = deferred(), hostWait = deferred(), closeWait = deferred();
  const h = harness({ execute: async () => { executeStart.resolve(); await executeWait.promise; return terminal; },
    host: async () => { hostStart.resolve(); await hostWait.promise; }, close: () => closeWait.promise });
  await h.run(); await executeStart.promise; let done = false, disposal;
  try {
    disposal = h.service.dispose(); void disposal.then(() => { done = true; });
    assert.equal(h.invocation.signal.aborted, true); await tick(); assert.equal(done, false);
    executeWait.resolve(); await hostStart.promise;
    assert.equal(h.service.hasActiveRuns(), false, 'terminal delivery is not a host-tail drain');
    assert.equal(done, false); hostWait.resolve(); await tick(); assert.equal(done, false, 'core close remains owned');
  } finally { executeWait.resolve(); hostWait.resolve(); closeWait.resolve(); await disposal; h.service.clearState(); }
  assert.equal(h.calls.filter(value => value === 'close').length, 1);
  assert.equal(h.events.filter(value => value.event.type === 'session-done').length, 1, 'committed terminal outcome is not erased');
});

test('Agent dispose still waits a host tail after the active map became empty', async () => {
  const start = deferred(), wait = deferred();
  const h = harness({ host: async () => { start.resolve(); await wait.promise; } });
  await h.run(); await start.promise; assert.equal(h.service.hasActiveRuns(), false);
  let done = false, disposal;
  try { disposal = h.service.dispose(); void disposal.then(() => { done = true; }); await tick(); assert.equal(done, false); }
  finally { wait.resolve(); await disposal; h.service.clearState(); }
});

test('Agent shutdown during deferred RAG preparation cannot create an assembly or execute', async () => {
  const start = deferred(), wait = deferred();
  const h = harness({ rag: async () => { start.resolve(); await wait.promise; return false; } });
  await h.run('owned', true); await start.promise; let done = false, disposal;
  try { disposal = h.service.dispose(); void disposal.then(() => { done = true; }); await tick(); assert.equal(done, false); }
  finally { wait.resolve(); await disposal; await tick(); h.service.clearState(); }
  assert.equal(h.calls.includes('assembly'), false); assert.equal(h.calls.includes('execute'), false);
  assert.equal(h.calls.filter(value => value === 'close').length, 1);
});

test('Agent dispose rejects parked and late approvals without waiting for approval timeout', async () => {
  const start = deferred(), hostWait = deferred(); let decision;
  const h = harness({ execute: async input => {
    const pending = input.requestApproval({ callId: 'owned' }); start.resolve(); decision = await pending; return terminal;
  }, host: () => hostWait.promise });
  await h.run(); await start.promise; let disposal;
  try {
    disposal = h.service.dispose(); await tick(); assert.equal(decision.decision, 'reject');
    assert.equal((await h.invocation.requestApproval({ callId: 'late' })).decision, 'reject');
  } finally { hostWait.resolve(); await disposal; h.service.clearState(); }
});

test('ordinary cancel stays immediate and clearState does not permanently stop admission', async () => {
  const start = deferred(), wait = deferred();
  const h = harness({ execute: async () => { start.resolve(); await wait.promise; return terminal; } });
  await h.run(); await start.promise;
  assert.equal((await h.service.cancel(1, 'owned')).ok, true);
  assert.equal(h.invocation.signal.aborted, true); h.service.clearState();
  assert.equal((await h.run('second')).ok, true);
  wait.resolve(); await tick(); await h.service.dispose(); h.service.clearState();
});
