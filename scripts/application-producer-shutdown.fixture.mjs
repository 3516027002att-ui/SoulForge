// Source-level execution with owned Promise ports: no Electron/provider/DB/worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const tick = () => new Promise(done => setImmediate(done));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const root = new URL('../', import.meta.url);
function sourceFor(relative) {
  const replacement = process.env.SOULFORGE_SHUTDOWN_RED_SOURCE;
  return fs.readFileSync(replacement ? path.join(replacement, path.basename(relative)) : new URL(relative, root), 'utf8');
}
function execute(source, context) {
  const exports = {};
  const built = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(built.outputText, { exports, module: { exports }, console, ...context });
  return exports;
}

function ipcHarness(pauseAt) {
  const calls = [], handlers = new Map(), start = deferred(), wait = deferred();
  async function port(name) { calls.push(name); if (pauseAt === name) { start.resolve(); await wait.promise; } }
  const sessions = { dispose: () => port('session.dispose'), run: async () => { calls.push('run'); return { ok: true, sessionId: 'owned' }; },
    loadResume: async () => { await port('resume'); return undefined; }, closeOwner() {}, clearState() {} };
  const sender = new EventEmitter(); Object.assign(sender, { id: 1, isDestroyed: () => false });
  class Embedding { dispose() { return port('embedding.dispose'); } close() { return Promise.resolve(); } }
  const api = execute(sourceFor('apps/desktop/src/main/ipc/agent.ts'), { require(name) {
    if (name.startsWith('node:')) return require(name);
    if (name === 'electron') return { app: { getPath: () => path.resolve('owned-user-data') }, dialog: { showMessageBox: async () => { await port('dialog'); return { response: 0 }; } } };
    if (name === '@soulforge/core') return { createConfiguredModelServiceAdapter: () => { calls.push('adapter'); return { ok: true, adapter: {} }; } };
    if (name === '@soulforge/shared' || name === '../rendererDto.js') return {};
    if (name === '../agentUtilityClient.js') return { runAgentUtilitySession: () => assert.fail('real model/utility forbidden') };
    if (name === '../services/agentSessionService.js') return { createAgentSessionService: () => sessions };
    if (name === '../services/agentEvidenceService.js') return { createAgentEvidenceService: () => ({}) };
    if (name === '../services/agentLocalService.js') return { createAgentLocalService: () => ({}) };
    if (name === '../ragEmbedding.js') return { InternalRagEmbeddingService: Embedding };
    throw new Error(`Unexpected IPC shutdown import ${name}`);
  } });
  api.registerAgentIpcHandlers({ webContents: sender, handle: (channel, listener) => handlers.set(channel, listener),
    modelServiceVault: {
      listConfigs: async () => { await port('configs'); return [{ id: 'owned', hasCredential: true, model: 'owned' }]; },
      resolveApiKey: async () => { await port('credential'); return 'synthetic-fixture-key'; }
    }, operationLogUtility: { openAppDatabase: () => port('database') }
  });
  return { api, calls, start, wait, invoke: (channel, input) => handlers.get(channel)({ sender }, input),
    request: () => handlers.get('ai.agent.run')({ sender }, { configId: 'owned', prompt: 'owned', resumeSessionPath: 'owned.jsonl' }) };
}

for (const stage of ['configs', 'credential', 'resume', 'database']) {
  test(`IPC shutdown owns delayed ${stage} preparation and forbids late Agent launch`, async () => {
    const h = ipcHarness(stage), run = h.request(); await h.start.promise;
    let disposed = false, disposal;
    try {
      disposal = h.api.disposeAgentIpcServices(); assert.equal(h.api.disposeAgentIpcServices(), disposal);
      void disposal.then(() => { disposed = true; });
      assert.ok(h.calls.includes('session.dispose')); assert.ok(h.calls.includes('embedding.dispose'));
      assert.equal((await h.request()).error.code, 'AGENT_SERVICE_DISPOSED');
      await tick(); assert.equal(disposed, false);
    } finally { h.wait.resolve(); await run; await disposal; }
    assert.equal((await run).error.code, 'AGENT_SERVICE_DISPOSED');
    assert.equal(h.calls.includes('run'), false);
    assert.equal(h.calls.filter(value => value === 'database').length, stage === 'database' ? 1 : 0);
    assert.throws(() => h.api.registerAgentIpcHandlers({}), { code: 'AGENT_SERVICE_DISPOSED' });
  });
}

test('a permission dialog completing after shutdown cannot mint a grant', async () => {
  const h = ipcHarness('dialog');
  const grant = h.invoke('ai.agent.permission.request', 'fullPermission'); await h.start.promise;
  try { await h.api.disposeAgentIpcServices(); }
  finally { h.wait.resolve(); }
  assert.equal((await grant).error.code, 'AGENT_SERVICE_DISPOSED');
});

test('quit synchronously stops every producer and waits all tails before Bridge/database disposal', async () => {
  const ipc = sourceFor('apps/desktop/src/main/ipc.ts'), ipcAst = ts.createSourceFile('ipc.ts', ipc, ts.ScriptTarget.Latest, true);
  const declarations = ipcAst.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'disposeApplicationProducers'
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ipcAst) === 'applicationProducerDisposal'));
  assert.equal(declarations.length, 2, 'actual composition root owns the producer barrier');
  const calls = [], tails = [deferred(), deferred(), deferred()];
  const coordinator = execute(declarations.map(node => node.getText(ipcAst)).join('\n'), {
    semanticRefresh: { dispose: () => { calls.push('semantic.stop'); return tails[0].promise; } },
    disposeAgentIpcServices: () => { calls.push('agent.stop'); return tails[1].promise; },
    disposeWorkspaceService: () => { calls.push('workspace.stop'); return tails[2].promise; }
  });
  const main = sourceFor('apps/desktop/src/main/index.ts'), mainAst = ts.createSourceFile('index.ts', main, ts.ScriptTarget.Latest, true);
  const quit = mainAst.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(mainAst) === 'app.on' && node.expression.arguments[0]?.text === 'before-quit');
  assert.ok(quit);
  let beforeQuit;
  execute(`let bridgeShutdownStarted=false,bridgeShutdownFinished=false;\n${quit.getText(mainAst)}`, {
    app: { on: (_name, listener) => { beforeQuit = listener; }, quit: () => calls.push('quit') },
    disposeAuxiliaryServices: () => calls.push('aux.stop'),
    disposeApplicationProducers: coordinator.disposeApplicationProducers,
    disposeBridgeDaemonPool: async () => calls.push('bridge.dispose'),
    disposeOperationLogUtility: async () => calls.push('database.dispose')
  });
  const event = { preventDefault() {} }; beforeQuit(event); beforeQuit(event);
  assert.deepEqual(calls, ['aux.stop', 'semantic.stop', 'agent.stop', 'workspace.stop']);
  tails[0].resolve(); tails[2].resolve(); await tick(); assert.equal(calls.includes('bridge.dispose'), false);
  tails[1].resolve(); await tick();
  assert.deepEqual(calls, ['aux.stop', 'semantic.stop', 'agent.stop', 'workspace.stop', 'bridge.dispose', 'database.dispose', 'quit']);
});
