// Actual Agent trusted adapter/application callbacks and shared finite assembly.
// Provider/utility/window/embedding ports are owned fixtures, with zero network,
// private credentials, native processes or original game resources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import * as realCore from '../packages/core/dist/index.js';
import * as realShared from '../packages/shared/dist/index.js';
import { BoundedEventHistory } from '../packages/agent/src/eventHistory.mjs';
import { noteOperationStarted, journalStateWithRequest } from '../packages/core/dist/runtime/operationOutcome.js';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapterPath = path.join(root, 'apps/desktop/src/main/ipc/agent.ts');
const sessionServicePath = path.join(root, 'apps/desktop/src/main/services/agentSessionService.ts');
const evidenceServicePath = path.join(root, 'apps/desktop/src/main/services/agentEvidenceService.ts');
const localServicePath = path.join(root, 'apps/desktop/src/main/services/agentLocalService.ts');
const channels = ['ai.agent.permission.request', 'ai.tools', 'ai.memory.list', 'ai.memory.save', 'ai.memory.delete',
  'ai.sidebarDraft', 'ai.runTool', 'rag.embed', 'rag.localModelStatus', 'rag.searchEvidence', 'ai.agent.run',
  'ai.agent.events', 'ai.agent.cancel', 'ai.agent.approval.respond', 'agent.approval.decide', 'ai.agent.sessions',
  'ai.agent.session.load', 'agent.resourceReference.create', 'agent.citation.create', 'agent.attachment.create'];
const response = text => ({ message: { role: 'assistant', content: text }, finishReason: 'stop', diagnostics: [], usage: { inputTokens: 1, outputTokens: 1 } });
const plain = value => JSON.parse(JSON.stringify(value));
const sourceOwnerMatches = (actual, expected, pathApi = path) => pathApi.normalize(actual) === pathApi.normalize(expected);
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function harness(options = {}) {
  const owned = await mkdtemp(path.join(os.tmpdir(), 'sf-agent-service-'));
  const calls = [], modules = new Map(), handlers = new Map(), timers = new Map();
  const coreSessions = [];
  const journal = options.journal ? realCore.openSqliteOperationLogStore({ databasePath: path.join(owned, 'audit.db'), workspaceId: 'owned', rootPath: owned, game: 'sekiro' }) : null;
  let activeSession = options.session ?? null, activeIndex = options.index ?? null, generation = 1;
  const target = new EventEmitter(); Object.assign(target, { id: 11, events: [], destroyed: false,
    isDestroyed() { return this.destroyed; }, send(channel, envelope) { assert.equal(channel, 'ai:agent:event');
      this.events.push(envelope); this.emit('agent', envelope); } });
  const stored = { id: 'owned-config', displayName: 'owned', protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid',
    model: 'owned-model', hasCredential: true, createdAt: '', updatedAt: '', temperature: 0, topP: 1, contextWindowTokens: 2000 };
  const adapter = { protocol: 'openai-compatible', listModels: async () => ({ ok: true, models: [] }),
    complete: async input => { calls.push(['complete', input]); return options.complete ? options.complete(input) : response('Owned task response.'); },
    stream: async function* (input) { const out = await adapter.complete(input); yield { type: 'done', message: out.message, finishReason: out.finishReason, usage: out.usage }; } };
  const registry = new realCore.ToolRegistry();
  registry.register({ name: 'inspect_owned', description: 'Read owned fixture state.', permission: 'read', proofPolicy: 'none', inputSchema: {},
    run: async (_input, context) => { calls.push(['readTool', context]); return options.read ? options.read(context) : { ok: true, content: '{"owned":true}' }; } });
  registry.register({ name: 'commit_owned', description: 'Commit owned fixture state.', permission: 'commit', proofPolicy: 'none', inputSchema: {},
    run: async (_input, context) => { calls.push(['commitTool', context]); return options.commit ? options.commit(context) : { ok: true, content: '{"committed":true,"opId":"owned-op"}' }; } });
  registry.register({ name: 'rollback_operation', description: 'Owned rollback dialogue fixture.', permission: 'rollback', proofPolicy: 'none', inputSchema: {},
    run: async () => { calls.push(['rollbackTool']); return { ok: true, data: {} }; } });
  const utility = { openAppDatabase: async value => { calls.push(['openAppDatabase', value]); if (options.usageError) throw options.usageError; },
    recordProviderUsage: async value => calls.push(['usage', value]),
    get: async opId => ({ opId, title: 'Owned prior operation', files: [{ targetUri: 'file:///owned/target' }] }),
    forWorkspace(id) { calls.push(['workspaceStore', id]); return this; },
    loadRagChunks: async () => { calls.push(['chunks']); return options.loadChunks ? options.loadChunks() : []; },
    loadReferences: async () => [], ragEmbeddingModel: async () => null, loadRagEmbeddingRecords: async () => [] };
  const memoryStore = new Map();
  const memoryManager = { getStore: (...args) => { calls.push(['memoryStore', args]); if (options.memoryError) throw options.memoryError;
    return { list: () => [...memoryStore.values()], save: value => { memoryStore.set(value.topic, value); return value; }, delete: key => memoryStore.delete(key) }; },
    getFullMemoryForSystemPrompt: () => 'Owned host memory.' };
  const embeddings = [];
  class Embedding {
    constructor(cache) { calls.push(['embeddingConstructor', cache]); embeddings.push(this); }
    schedule(...args) { calls.push(['embeddingSchedule', ...args]); }
    close() { calls.push(['embeddingClose']); return Promise.resolve(); }
    refreshLocalModelStatus() { calls.push(['embeddingStatusRefresh']); }
    getLocalModelStatus() { return { state: 'unavailable', modelId: 'owned-local-model', revision: 'owned-pin', dimension: 512 }; }
    getCachedVectors() { return null; }
    async ensure(corpus, database) { calls.push(['embeddingEnsure', corpus, database]); return options.embed ? options.embed(corpus, database) : { ok: false, code: 'RAG_LOCAL_MODEL_UNAVAILABLE', message: 'owned local model unavailable' }; }
    async embedQuery() { return null; }
  }
  const core = { ...realCore,
    createConfiguredModelServiceAdapter: input => { calls.push(['admitProvider', { sessionId: input.sessionId, configId: input.config.id }]); return { ok: true, adapter }; },
    ...(journal ? { openAgentCoreToolSession: async input => {
      const session = await realCore.openAgentCoreToolSession({ ...input, getOperationLog: async () => journal });
      coreSessions.push(session); const close = session.close.bind(session); let closed = false;
      session.close = () => { if (!closed) { closed = true; calls.push(['coreClose']); } close(); }; return session;
    } } : {})
  };
  const clock = { setTimeout(callback, delay) { const timer = { callback, delay, unref() {} }; timers.set(timer, timer); return timer; }, clearTimeout(timer) { timers.delete(timer); } };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const source = fs.readFileSync(filename, 'utf8'), built = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((built.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error), []);
    const exports = {}; modules.set(filename, exports);
    vm.runInNewContext(built.outputText, { exports, module: { exports }, process, Buffer, console, AbortController, Float32Array, ...clock,
      require(name) {
        if (name.startsWith('node:')) return require(name);
        if (name === '@soulforge/core') return core;
        if (name === '@soulforge/shared') return realShared;
        if (name === 'electron') { assert.equal(filename, adapterPath, 'application services must not import Electron');
          return { app: { getPath: () => owned }, dialog: { showMessageBox: async input => { calls.push(['dialog', input]); return { response: options.denyFull ? 1 : 0 }; } } }; }
        if (name.endsWith('/eventHistory.mjs')) return { BoundedEventHistory };
        if (name.endsWith('/agentUtilityClient.js')) return { runAgentUtilitySession: async params => {
          calls.push(['utilityRun', params]); return options.runner ? options.runner(params) : realCore.runAgentSession(params);
        } };
        if (name.endsWith('/ragEmbedding.js')) return { InternalRagEmbeddingService: Embedding, INTERNAL_RAG_EMBEDDING: { id: 'owned-local-model', dim: 512 } };
        if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name.replace(/\.js$/u, '.ts')));
        throw new Error(`Unexpected Agent service import ${name}`);
      }
    }, { filename });
    return exports;
  }
  const api = load(adapterPath);
  const deps = { handle: (channel, listener) => handlers.set(channel, (...args) => { if (options.untrusted) throw new Error('IPC_UNTRUSTED_SENDER'); return listener(...args); }), webContents: target, toolRegistry: registry, memoryManager,
    modelServiceVault: { listConfigs: async () => options.noConfig ? [] : [{ ...stored, hasCredential: !options.noCredential }],
      resolveApiKey: async () => options.noCredential ? null : 'synthetic-fixture-key' }, operationLogUtility: utility,
    getActiveIndex: () => activeIndex, getActiveSession: () => activeSession, getActiveWorkspaceSessionId: () => activeSession ? 'owned-session' : null,
    getActiveWorkspaceSessionGeneration: () => generation, waitForWorkspaceIndexing: async () => {},
    ensureActiveOperationLog: async session => { calls.push(['openWorkspace', session]); return options.openWorkspace ? options.openWorkspace(session, utility) : utility; },
    durableStoragePaths: () => ({ root: owned, backupBaseDir: path.join(owned, 'backups'), recoveryDir: path.join(owned, 'recovery'), stagingRoot: path.join(owned, 'stage') }),
    currentToolContext: () => ({ workspaceIndex: activeIndex, ...(activeSession ? { session: activeSession, workspaceSessionId: 'owned-session', workspaceSessionGeneration: generation, indexedFilesRevision: generation } : {}), mode: 'plan',
      ...(options.rag ? { rag: options.rag, ragSessionId: 'owned-session', ragGeneration: generation, ragIndexedFilesRevision: generation, ragEpoch: activeIndex?.getNativeVersionEpoch(), ragScope: 'full' } : {}) }),
    requestWriteConfirmation: async input => { calls.push(['writeConfirmation', input]); return null; }, readSystemPrompt: () => 'Owned system prompt.' };
  api.registerAgentIpcHandlers(deps);
  return { api, calls, owned, target, handlers, deps, utility, embeddings, journal,
    directLocal() {
      return load(localServicePath).createAgentLocalService({ getMemoryStore: () => memoryManager.getStore(), toolRegistry: registry,
        getActiveSession: deps.getActiveSession, getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId,
        getActiveWorkspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration,
        currentToolContext: deps.currentToolContext, ensureActiveOperationLog: deps.ensureActiveOperationLog });
    },
    directSession() {
      const evidence = load(evidenceServicePath).createAgentEvidenceService({ internalRagEmbedding: embeddings[0], operationLogUtility: utility,
        getActiveIndex: deps.getActiveIndex, getActiveSession: deps.getActiveSession, getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId,
        getActiveWorkspaceSessionGeneration: deps.getActiveWorkspaceSessionGeneration, currentToolContext: deps.currentToolContext, ensureActiveOperationLog: deps.ensureActiveOperationLog });
      const service = load(sessionServicePath).createAgentSessionService({ sessionsDir: path.join(owned, 'direct'), toolRegistry: registry, memoryManager,
        operationLogUtility: utility, getActiveIndex: deps.getActiveIndex, getActiveSession: deps.getActiveSession, getActiveWorkspaceSessionId: deps.getActiveWorkspaceSessionId,
        waitForWorkspaceIndexing: deps.waitForWorkspaceIndexing, ensureActiveOperationLog: deps.ensureActiveOperationLog,
        durableStoragePaths: deps.durableStoragePaths, currentToolContext: deps.currentToolContext, readSystemPrompt: deps.readSystemPrompt,
        ownerAvailable: () => true, publishEvent: (owner, envelope) => calls.push(['directEvent', owner, envelope]),
        sessionRunner: realCore.runAgentSession, evidence });
      return { service, authorization: { serviceId: stored.id, model: stored.model, sampling: {}, bindTarget() {}, requestWriteConfirmation: async () => null,
        execute: (assembly, invocation) => assembly.run({ ...invocation, adapter, config: { ...stored, hasCredential: false }, apiKey: '' }) } };
    },
    invoke: (channel, ...args) => handlers.get(channel)({ sender: target }, ...args),
    invokeAs: (ownerId, channel, ...args) => handlers.get(channel)({ sender: { id: ownerId } }, ...args),
    invokeFrom: (sender, channel, ...args) => handlers.get(channel)({ sender }, ...args),
    request: async (mode = 'plan', extra = {}) => {
      const grant = mode === 'plan' ? null : await handlers.get(channels[0])({ sender: target }, mode);
      return handlers.get('ai.agent.run')({ sender: target }, { configId: stored.id, prompt: 'Read owned fixture data.', mode,
        ...(grant?.ok ? { permissionGrantId: grant.grantId } : {}), streaming: false, ...extra });
    },
    waitEvent(type) { const existing = target.events.find(envelope => envelope.event.type === type); if (existing) return Promise.resolve(existing);
      return new Promise(done => { const listener = envelope => { if (envelope.event.type === type) { target.off('agent', listener); done(envelope); } }; target.on('agent', listener); }); },
    waitEventFor(sender, type) { const existing = sender.events.find(envelope => envelope.event.type === type); if (existing) return Promise.resolve(existing);
      return new Promise(done => { const listener = envelope => { if (envelope.event.type === type) { sender.off('agent', listener); done(envelope); } }; sender.on('agent', listener); }); },
    fire(delay) { for (const timer of [...timers.values()]) if (timer.delay === delay) { timers.delete(timer); timer.callback(); } },
    get timers() { return timers; },
    switchWorkspace(session, index) { activeSession = session; activeIndex = index; generation++; },
    async close() { target.destroyed = true; target.emit('destroyed'); api.clearAgentIpcState(); for (const session of coreSessions) session.close(); journal?.close(); await rm(owned, { recursive: true, force: true }); }
  };
}
const ownedCall = name => ({ message: { role: 'assistant', content: '', toolCalls: [{ id: 'owned-call', name, argumentsJson: '{}' }] }, finishReason: 'tool_use', diagnostics: [], usage: { inputTokens: 1, outputTokens: 1 } });

test('Agent application services own sessions and evidence without sender or credential authority', () => {
  assert.equal(fs.existsSync(sessionServicePath), true, 'Agent session application service must exist');
  assert.equal(fs.existsSync(evidenceServicePath), true, 'Agent evidence application service must exist');
  for (const filename of [sessionServicePath, evidenceServicePath]) assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /from ['"]electron|TrustedIpcHandle|IpcMainInvokeEvent|WebContents|modelServiceVault|resolveApiKey|apiKey/);
});
test('all twenty trusted channels retain their original order', async () => {
  const h = await harness(); try { assert.deepEqual([...h.handlers.keys()], channels); } finally { await h.close(); }
});
test('missing provider configuration and credentials reject without launch', async () => {
  for (const option of [{ noConfig: true }, { noCredential: true }]) { const h = await harness(option);
    try { assert.equal((await h.request()).ok, false); assert.equal(h.calls.filter(([name]) => name === 'utilityRun').length, 0); } finally { await h.close(); } }
});
test('renderer cannot manufacture a full-permission run or reuse another sender grant', async () => {
  const h = await harness(); try {
    assert.equal((await h.invoke('ai.agent.run', { configId: 'owned-config', prompt: 'owned', mode: 'fullPermission' })).error.code, 'AGENT_PERMISSION_REQUIRED');
    const grant = await h.invoke('ai.agent.permission.request', 'normal');
    assert.equal((await h.invokeAs(99, 'ai.agent.run', { configId: 'owned-config', prompt: 'owned', mode: 'normal', permissionGrantId: grant.grantId })).error.code, 'AGENT_PERMISSION_INVALID');
    assert.equal(h.calls.filter(([name]) => name === 'utilityRun').length, 0);
  } finally { await h.close(); }
});
test('full permission dialog refusal issues no grant', async () => {
  const h = await harness({ denyFull: true }); try { assert.equal((await h.invoke(channels[0], 'fullPermission')).error.code, 'AGENT_PERMISSION_DENIED');
    assert.equal(h.calls.filter(([name]) => name === 'dialog').length, 1); } finally { await h.close(); }
});
test('usage storage refusal remains before dispatch and creates no accepted session', async () => {
  const h = await harness({ usageError: new Error('owned usage unavailable') }); try {
    assert.equal((await h.request()).error.code, 'PROVIDER_USAGE_STORAGE_UNAVAILABLE'); assert.equal(h.target.events.length, 0);
    assert.equal(h.calls.filter(([name]) => name === 'utilityRun').length, 0);
  } finally { await h.close(); }
});
test('actual no-workspace finite run keeps acceptance, default budgets and visible nonstream response', async () => {
  const h = await harness(); try {
    const accepted = await h.request(); assert.equal(accepted.ok, true); await h.waitEvent('session-done');
    assert.equal(h.target.events[0].event.type, 'session-accepted'); assert.equal(h.api.isAgentSessionActive(accepted.sessionId), false);
    const params = h.calls.find(([name]) => name === 'utilityRun')[1]; assert.equal(params.timeoutMs, 180_000);
    assert.equal(params.permissionMode, 'plan'); assert.equal(params.streaming === true, false); assert.equal(params.compaction.autoCompactTokenLimit, 1600);
    assert.equal(h.target.events.some(({ event }) => event.type === 'agent-message-delta' && event.text === 'Owned task response.'), true);
    assert.equal(JSON.stringify(h.target.events).includes('synthetic-fixture-key'), false);
    assert.equal(h.calls.filter(([name]) => name === 'usage').length, 1);
  } finally { await h.close(); }
});
test('actual read tool execution remains available and plan denies a proposed write', async () => {
  for (const name of ['inspect_owned', 'commit_owned']) { let first = true; const h = await harness({ complete: async () => { if (first) { first = false; return ownedCall(name); } return response('Owned tool finished.'); } });
    try { await h.request(); await h.waitEvent('session-done'); assert.equal(h.calls.filter(([kind]) => kind === 'readTool').length, name === 'inspect_owned' ? 1 : 0);
      assert.equal(h.calls.filter(([kind]) => kind === 'commitTool').length, 0); } finally { await h.close(); } }
});
test('exact normal approval resumes one owned call while wrong call and foreign sender do not', async () => {
  let first = true; const h = await harness({ complete: async () => { if (first) { first = false; return ownedCall('commit_owned'); } return response('Owned commit finished.'); } });
  try { const accepted = await h.request('normal'); await h.waitEvent('approval-requested');
    assert.equal((await h.invokeAs(99, 'ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' })).error.code, 'AGENT_SESSION_FORBIDDEN');
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'other-call', decision: 'once' })).matched, false);
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'timed_out' })).error.code, 'INVALID_INPUT');
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' })).matched, true);
    await h.waitEvent('session-done'); assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 1);
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' })).matched, false);
  } finally { await h.close(); }
});
test('normal approval rejection and cancellation leave the writer undispatched', async () => {
  for (const cancel of [false, true]) { let first = true; const h = await harness({ complete: async () => { if (first) { first = false; return ownedCall('commit_owned'); } return response('Owned request refused.'); } });
    try { const accepted = await h.request('normal'); await h.waitEvent('approval-requested');
      if (cancel) await h.invoke('ai.agent.cancel', accepted.sessionId);
      else await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'reject' });
      await h.waitEvent('session-done'); assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 0);
    } finally { await h.close(); } }
});
test('event replay is sender-bound, ordered and rejects invalid sequence inputs', async () => {
  const h = await harness(); try { const accepted = await h.request(); await h.waitEvent('session-done');
    assert.equal((await h.invokeAs(99, 'ai.agent.events', accepted.sessionId)).error.code, 'AGENT_SESSION_FORBIDDEN');
    assert.equal((await h.invoke('ai.agent.events', accepted.sessionId, -1)).error.code, 'INVALID_INPUT');
    const result = await h.invoke('ai.agent.events', accepted.sessionId, 0); assert.equal(result.ok, true);
    assert.deepEqual(result.events.map(item => item.seq), h.target.events.map(item => item.seq));
    const second = await h.invoke('ai.agent.events', accepted.sessionId, 1); assert.ok(second.events.every(item => item.seq > 1));
    h.fire(300_000); assert.equal((await h.invoke('ai.agent.events', accepted.sessionId)).error.code, 'AGENT_SESSION_FORBIDDEN');
  } finally { await h.close(); }
});
test('session list and bounded load use owned rollouts and reject path traversal', async () => {
  const h = await harness(); try { await h.request(); await h.waitEvent('session-done');
    const listed = await h.invoke('ai.agent.sessions'); assert.equal(listed.ok, true); assert.equal(listed.sessions.length, 1);
    const loaded = await h.invoke('ai.agent.session.load', listed.sessions[0].sessionPath); assert.equal(loaded.ok, true); assert.ok(loaded.messagesPage.length <= 20);
    assert.equal((await h.invoke('ai.agent.session.load', '../outside.jsonl')).error.code, 'ROLLOUT_PATH_FORBIDDEN');
  } finally { await h.close(); }
});
test('manual embedding without a workspace and read-only local status never start a model', async () => {
  const h = await harness(); try { assert.equal((await h.invoke('rag.embed', {})).error.code, 'WORKSPACE_REQUIRED');
    assert.equal((await h.invoke('rag.localModelStatus')).state, 'unavailable'); assert.equal(h.calls.filter(([name]) => name === 'embeddingEnsure').length, 0);
  } finally { await h.close(); }
});
test('an admitted later window receives only its own live events and owns cancellation', async () => {
  const h = await harness(), second = new EventEmitter(); Object.assign(second, { id: 22, events: [], destroyed: false,
    isDestroyed() { return this.destroyed; }, send(_channel, envelope) { this.events.push(envelope); this.emit('agent', envelope); } });
  try {
    const accepted = await h.invokeFrom(second, 'ai.agent.run', { configId: 'owned-config', prompt: 'Owned second-window task.', mode: 'plan', streaming: false });
    await new Promise(done => setImmediate(done)); await new Promise(done => setImmediate(done));
    assert.equal((await h.invoke('ai.agent.events', accepted.sessionId)).error.code, 'AGENT_SESSION_FORBIDDEN');
    assert.equal(h.target.events.length, 0, 'first registered window must not receive another owner live events');
    assert.equal(second.events[0].event.type, 'session-accepted');
    assert.equal((await h.invokeFrom(second, 'ai.agent.events', accepted.sessionId)).ok, true);
  } finally { second.destroyed = true; second.emit('destroyed'); await h.close(); }
});
test('trusted transport refusal prevents provider admission, grants and run dispatch', async () => {
  const h = await harness({ untrusted: true }); try {
    await assert.rejects(async () => h.request('normal'), /IPC_UNTRUSTED_SENDER/);
    assert.equal(h.calls.filter(([name]) => ['admitProvider', 'openAppDatabase', 'utilityRun', 'dialog'].includes(name)).length, 0);
  } finally { await h.close(); }
});
test('closing the admitted later window settles its exact approval without affecting another owner', async () => {
  const delivery = deferred(), runnerFinished = deferred(), approvalSettled = deferred();
  const bounded = (promise, label) => {
    let timer;
    return Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Owned fixture did not observe ${label}`)), 5000);
    })]).finally(() => clearTimeout(timer));
  };
  const h = await harness({
    complete: async input => input.messages.some(message => message.toolCalls?.length)
      ? response('Owned approval settled.') : ownedCall('commit_owned'),
    runner: async params => {
      const closingOwner = params.prompt === 'Owned second-window task.';
      const result = await realCore.runAgentSession({ ...params, requestApproval: async request => {
        const decision = await params.requestApproval(request);
        if (closingOwner) approvalSettled.resolve({ request, decision });
        return decision;
      } });
      if (closingOwner) { runnerFinished.resolve(result); await delivery.promise; }
      return result;
    }
  });
  const second = new EventEmitter(); Object.assign(second, { id: 22, events: [], destroyed: false,
    isDestroyed() { return this.destroyed; }, send(_channel, envelope) { this.events.push(envelope); this.emit('agent', envelope); } });
  try {
    const first = await h.request('normal'); await bounded(h.waitEvent('approval-requested'), 'first owner approval');
    const grant = await h.invokeFrom(second, channels[0], 'normal');
    const accepted = await h.invokeFrom(second, 'ai.agent.run', { configId: 'owned-config', prompt: 'Owned second-window task.', mode: 'normal', permissionGrantId: grant.grantId, streaming: false });
    await bounded(h.waitEventFor(second, 'approval-requested'), 'later owner approval');
    const visible = second.events.length, firstVisible = h.target.events.length;
    const run = h.calls.find(([name, params]) => name === 'utilityRun' && params.sessionId === accepted.sessionId)[1];
    const otherRun = h.calls.find(([name, params]) => name === 'utilityRun' && params.sessionId === first.sessionId)[1];
    second.destroyed = true; second.emit('destroyed');
    assert.equal(run.signal.aborted, true); assert.equal(otherRun.signal.aborted, false);
    assert.equal(h.api.isAgentSessionActive(first.sessionId), true);
    assert.equal(h.target.events.length, firstVisible, 'closing another owner must not publish into the first window');
    assert.equal((await h.invokeFrom(second, 'ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' })).matched, false);
    const settled = await bounded(approvalSettled.promise, 'exact closed-owner approval rejection');
    assert.equal(settled.request.callId, 'owned-call'); assert.equal(settled.request.toolName, 'commit_owned');
    assert.equal(settled.decision.decision, 'reject');
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 600_000).length, 1, 'the other owner approval stays parked');
    const result = await bounded(runnerFinished.promise, 'cancelled real runner result');
    assert.equal(result.run.finishReason, 'cancelled');
    assert.equal(h.api.isAgentSessionActive(accepted.sessionId), true, 'active receipt remains until the actual runner result is delivered');
    assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 0);
    assert.equal(second.events.length, visible);
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: first.sessionId, callId: 'owned-call', decision: 'reject' })).matched, true);
    await bounded(h.waitEvent('session-done'), 'unaffected owner terminal result');
    delivery.resolve();
    let observingSettlement = true;
    try {
      await bounded((async () => {
        while (observingSettlement && h.api.isAgentSessionActive(accepted.sessionId)) await new Promise(done => setImmediate(done));
      })(), 'closed owner application settlement');
    } finally { observingSettlement = false; }
    assert.equal(h.api.isAgentSessionActive(accepted.sessionId), false);
    const replay = await h.invokeFrom(second, 'ai.agent.events', accepted.sessionId);
    assert.equal(replay.ok, true); assert.equal(replay.events.at(-1).event.type, 'session-done');
    assert.equal(replay.events.at(-1).event.finishReason, 'cancelled');
    assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 0);
    assert.equal(h.target.events.every(envelope => envelope.sessionId === first.sessionId), true);
    assert.equal(second.events.every(envelope => envelope.sessionId === accepted.sessionId), true);
    assert.equal(second.events.length, visible); assert.equal(h.api.isAgentSessionActive(first.sessionId), false);
  } finally { delivery.resolve(); await h.close(); }
});
test('approval timeout remains a host fact and removes its pending resolver', async () => {
  let first = true; const h = await harness({ complete: async () => { if (first) { first = false; return ownedCall('commit_owned'); } return response('Owned timeout.'); } });
  try { const accepted = await h.request('normal'); await h.waitEvent('approval-requested'); h.fire(600_000); await h.waitEvent('session-done');
    assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 0);
    assert.ok(h.target.events.some(({ event }) => event.type === 'approval-resolved' && event.decision === 'timed_out'));
    assert.equal((await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' })).matched, false);
  } finally { await h.close(); }
});
test('actual replay retains only the existing byte/entry window and reports an evicted prefix', async () => {
  const h = await harness({ runner: async params => {
    for (let i = 0; i < 5000; i++) params.onEvent({ type: 'agent-message-delta', text: 'x'.repeat(1000) });
    return { rolloutPath: path.join(params.sessionsDir, 'owned.jsonl'), run: { finishReason: 'stop', steps: 1, diagnostics: [] } };
  } });
  try { const accepted = await h.request(); await h.waitEvent('session-done');
    const replay = await h.invoke('ai.agent.events', accepted.sessionId, 0); assert.equal(replay.ok, true); assert.equal(replay.truncated, true);
    assert.ok(replay.events.length <= 4096); assert.ok(replay.totalBytes <= 2_097_152);
    assert.equal(replay.firstAvailableSeq, replay.events[0].seq); assert.ok(replay.firstAvailableSeq > 1);
    assert.equal(replay.events.at(-1).event.type, 'session-done');
  } finally { await h.close(); }
});
const ownedWorkspace = { meta: { workspaceId: 'owned', game: 'sekiro' }, layers: { overlayRoot: '/owned/mod' } };
const ownedRag = () => realCore.createRagCorpus({ workspaceId: 'owned', builtAt: 'owned', references: [], lookupIndex: 'deferred', chunks: [{
  chunkId: 'owned:row', workspaceId: 'owned', sourceUri: 'file:///owned/mod/owned.param', symbolUri: 'param://Owned/1',
  family: 'param_row', title: 'Owned row', body: 'Owned row evidence.', numericIds: [1], contentHash: 'owned-content', sourceHash: 'owned-source', sourceRevision: 1
}] });
test('manual embedding cannot adopt replacement workspace after awaited database opening', async () => {
  const start = deferred(), wait = deferred(), h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), rag: ownedRag(),
    openWorkspace: async (_session, store) => { start.resolve(); await wait.promise; return store; } });
  try { const pending = h.invoke('rag.embed', {}); await start.promise;
    h.switchWorkspace({ ...ownedWorkspace }, new realCore.WorkspaceIndex('owned')); wait.resolve(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.error.code, 'RAG_UNAVAILABLE');
    assert.equal(h.calls.filter(([name]) => name === 'workspaceStore' || name === 'embeddingEnsure').length, 0);
  } finally { await h.close(); }
});
test('late successful embedding is not reported as current after same-ID activation replacement', async () => {
  const start = deferred(), wait = deferred(), h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), rag: ownedRag(),
    embed: async () => { start.resolve(); await wait.promise; return { ok: true, embedded: 1, reused: 0, failed: 0, model: 'owned-local-model', dim: 512 }; } });
  try { const pending = h.invoke('rag.embed', {}); await start.promise;
    h.switchWorkspace(ownedWorkspace, new realCore.WorkspaceIndex('owned')); wait.resolve(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.error.code, 'RAG_UNAVAILABLE'); assert.equal(h.calls.filter(([name]) => name === 'embeddingEnsure').length, 1);
  } finally { await h.close(); }
});
test('lexical evidence discards replacement and ABA results after actual durable loading', async () => {
  const start = deferred(), wait = deferred(), h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'),
    loadChunks: async () => { start.resolve(); await wait.promise; return ownedRag().chunks; } });
  try { const pending = h.invoke('rag.searchEvidence', { query: 'Owned row' }); await start.promise;
    h.switchWorkspace({ ...ownedWorkspace }, new realCore.WorkspaceIndex('owned')); wait.resolve(); const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.code, 'RAG_UNAVAILABLE'); assert.match(result.message, /旧检索结果/);
    assert.equal(h.calls.filter(([name]) => name === 'chunks').length, 1);
  } finally { await h.close(); }
});
test('window destruction after dispatch joins the late committed journal outcome without replay', async () => {
  let first = true; const started = deferred(), release = deferred();
  const h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), journal: true,
    complete: async () => { if (first) { first = false; return ownedCall('commit_owned'); } return response('Owned task stopped.'); },
    commit: async context => {
      const log = context.coreSession.operationLog; noteOperationStarted('owned-op', log); started.resolve(); await release.promise;
      await log.record({ opId: 'owned-op', workspaceId: 'owned', title: 'owned fixture commit', author: 'ai', mode: 'normal', status: 'committed',
        createdAt: new Date().toISOString(), committedAt: new Date().toISOString(), backupRoot: path.join(h.owned, 'backup'), files: [], diagnostics: [] });
      await log.createTransaction({ transactionId: 'owned-txn', opId: 'owned-op', phase: 'committed', state: journalStateWithRequest({ ownedFixture: true }),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      return { ok: true, data: { opId: 'owned-op', committed: true } };
    } });
  try {
    const accepted = await h.request('normal'); await h.waitEvent('approval-requested');
    await h.invoke('ai.agent.approval.respond', { sessionId: accepted.sessionId, callId: 'owned-call', decision: 'once' }); await started.promise;
    const visible = h.target.events.length; h.target.destroyed = true; h.target.emit('destroyed');
    await new Promise(done => setTimeout(done, 20)); assert.equal(h.calls.filter(([name]) => name === 'coreClose').length, 0);
    release.resolve(); const deadline = Date.now() + 2000;
    while (!h.calls.some(([name]) => name === 'coreClose') && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    assert.equal(h.calls.filter(([name]) => name === 'coreClose').length, 1); assert.equal(h.calls.filter(([name]) => name === 'commitTool').length, 1);
    assert.equal((await h.journal.get('owned-op')).status, 'committed');
    const facts = await h.journal.findTransactionsForRequest(`agent:${accepted.sessionId}`, `${accepted.sessionId}:owned-call`);
    assert.equal(facts[0].phase, 'committed'); assert.equal(h.target.events.length, visible);
  } finally { release.resolve(); await h.close(); }
});
test('a caller cannot mutate a replay view into an oversized retained history entry', async () => {
  const h = await harness(); try {
    const accepted = await h.request(); await h.waitEvent('session-done');
    const first = await h.invoke('ai.agent.events', accepted.sessionId, 0);
    const narration = first.events.find(({ event }) => event.type === 'agent-message-delta');
    try { narration.event.text = 'x'.repeat(3_000_000); } catch { /* Immutable owned projections may reject caller mutation. */ }
    const second = await h.invoke('ai.agent.events', accepted.sessionId, 0);
    assert.equal(second.events.find(({ event }) => event.type === 'agent-message-delta').event.text === 'Owned task response.', true);
    assert.ok(second.totalBytes <= 2_097_152);
  } finally { await h.close(); }
});
test('a rollback confirmation capability stays bound to the admitted sender in trusted transport', async () => {
  let first = true; const h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), journal: true,
    complete: async () => { if (first) { first = false; const call = ownedCall('rollback_operation'); call.message.toolCalls[0].argumentsJson = '{"opId":"owned-prior"}'; return call; } return response('Owned rollback refused.'); } });
  const second = new EventEmitter(); Object.assign(second, { id: 22, events: [], destroyed: false,
    isDestroyed() { return this.destroyed; }, send(_channel, envelope) { this.events.push(envelope); this.emit('agent', envelope); } });
  try {
    const grant = await h.invokeFrom(second, channels[0], 'fullPermission');
    await h.invokeFrom(second, 'ai.agent.run', { configId: 'owned-config', prompt: 'Owned rollback task.', mode: 'fullPermission', permissionGrantId: grant.grantId, streaming: false });
    await h.waitEventFor(second, 'session-done');
    assert.equal(h.calls.filter(([name]) => name === 'writeConfirmation').length, 1);
    const input = h.calls.find(([name]) => name === 'writeConfirmation')[1]; assert.equal(input.event?.sender.id, 22);
    assert.equal(input.actionLabel, '回滚操作'); assert.equal(h.calls.filter(([name]) => name === 'rollbackTool').length, 0);
    assert.equal(h.target.events.length, 0);
  } finally { second.destroyed = true; second.emit('destroyed'); await h.close(); }
});
test('the public run contract declares the existing execution capability fields', () => {
  const filename = path.join(root, 'apps/desktop/src/ipc/publicTypes.ts'), source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const request = ast.statements.find(node => ts.isInterfaceDeclaration(node) && node.name.text === 'AiAgentRunRequest');
  assert.ok(request); const fields = new Set(request.members.map(member => member.name?.getText(ast)));
  for (const name of ['timeoutMs', 'maxSteps', 'streaming', 'autoCompactTokenLimit', 'retryMaxAttempts', 'useContextBroker']) assert.equal(fields.has(name), true, name);
});
test('main compatibility Agent types resolve to the single public contract declarations', () => {
  const contractPath = path.join(root, 'apps/desktop/src/ipc/publicTypes.ts');
  const program = ts.createProgram([adapterPath, contractPath], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true, skipLibCheck: true
  });
  const checker = program.getTypeChecker(), source = program.getSourceFile(adapterPath);
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(source));
  for (const name of ['AiAgentRunRequest', 'AiAgentApprovalResponseRequest', 'AiAgentRunIpcResult',
    'AiAgentPermissionRequestResult', 'AiAgentCancelIpcResult', 'AiAgentEventReplayIpcResult',
    'AiAgentSessionSummaryIpc', 'AiAgentSessionListIpcResult', 'AiAgentSessionLoadIpcResult',
    'AiAgentSessionLifecycleEvent', 'AiAgentEventEnvelope', 'AgentResourceReferenceCreateIpcResult',
    'AgentAttachmentCreateIpcResult']) {
    const symbol = exports.find(candidate => candidate.name === name);
    assert.ok(symbol, name);
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    assert.ok(target.declarations?.length, name);
    for (const declaration of target.declarations) assert.equal(sourceOwnerMatches(declaration.getSourceFile().fileName, contractPath), true, name);
  }
});
test('TypeScript Windows path representation retains exact declaration ownership', () => {
  for (const directory of ['C:\\owned source', '\\\\server\\share\\owned source']) {
    const filename = path.win32.join(directory, 'apps', 'desktop', 'src', 'ipc', 'publicTypes.ts');
    const normalized = filename.replaceAll('\\', '/');
    const host = {
      getSourceFile(name, language) { if (name.replaceAll('\\', '/') === normalized) return ts.createSourceFile(name, 'export interface OwnedContract { readonly ok: true }', language, true); },
      getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => directory.replaceAll('\\', '/'),
      getDirectories: () => [], fileExists: name => name.replaceAll('\\', '/') === normalized, readFile: () => '',
      getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n'
    };
    const program = ts.createProgram([filename], { noLib: true, noResolve: true }, host);
    const source = program.getSourceFile(filename), checker = program.getTypeChecker();
    const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)).find(candidate => candidate.name === 'OwnedContract');
    assert.ok(symbol); const declarationPath = symbol.declarations[0].getSourceFile().fileName;
    assert.notEqual(declarationPath, filename, 'actual TypeScript uses forward slashes for the Windows input');
    assert.equal(sourceOwnerMatches(declarationPath, filename, path.win32), true);
    assert.equal(sourceOwnerMatches(declarationPath, path.win32.join(directory, 'other', 'publicTypes.ts'), path.win32), false);
  }
});
test('actual desktop admission forwards exact controls through shared composition and keeps broker authority', async () => {
  const forgedBroker = { assemble: () => { throw new Error('renderer broker used'); } }, h = await harness();
  try {
    await h.request('plan', { timeoutMs: 2000, maxSteps: 999, maxTotalOutputTokens: 64, streaming: true,
      autoCompactTokenLimit: 900, retryMaxAttempts: 999, useContextBroker: true, contextMaxBytes: 12000, contextBroker: forgedBroker,
      approvalRequiredLevels: [] }); await h.waitEvent('session-done');
    const params = h.calls.find(([name]) => name === 'utilityRun')[1]; assert.equal(params.timeoutMs, 2000); assert.equal(params.maxSteps, 200);
    assert.equal(params.maxTotalOutputTokens, 64); assert.equal(params.streaming, true); assert.equal(params.compaction.autoCompactTokenLimit, 900);
    assert.equal(params.retryPolicy.maxAttempts, 8); assert.equal(params.contextBrokerOptions.maxBytes, 12000);
    assert.notEqual(params.contextBroker, forgedBroker); assert.equal((await params.contextBroker.assemble([])).ok, false);
    assert.equal(params.approvalRequiredLevels, undefined); assert.equal(params.sampling.temperature, 0);
  } finally { await h.close(); }
});
test('invalid numeric desktop controls use existing safe defaults and a real short deadline reaches the finite runner', async () => {
  const h = await harness(); try {
    await h.request('plan', { timeoutMs: 0, maxSteps: -1, maxTotalOutputTokens: 0, autoCompactTokenLimit: 0, retryMaxAttempts: -1 }); await h.waitEvent('session-done');
    const params = h.calls.find(([name]) => name === 'utilityRun')[1]; assert.equal(params.timeoutMs, 180_000);
    assert.equal(params.maxSteps, undefined); assert.equal(params.maxTotalOutputTokens, undefined); assert.equal(params.retryPolicy, undefined);
    assert.equal(params.compaction.autoCompactTokenLimit, 1600);
  } finally { await h.close(); }
  const delayed = await harness({ complete: async () => { await new Promise(done => setTimeout(done, 50)); return response('Late fixture response.'); } });
  try { await delayed.request('plan', { timeoutMs: 10 }); const done = await delayed.waitEvent('session-done'); assert.equal(done.event.finishReason, 'cancelled');
    assert.equal(delayed.target.events.some(({ event }) => event.type === 'agent-message-delta'), false);
  } finally { await delayed.close(); }
});
test('direct application runs need only admitted identities and execution ports without transport or vault', async () => {
  const h = await harness(), { service, authorization } = h.directSession();
  try {
    assert.equal(Object.isFrozen(service), true);
    const accepted = await service.run({ ownerId: 71, sessionId: 'owned-direct', mode: 'plan', request: { configId: 'owned-config', prompt: 'Owned direct task.' }, citationLines: [], authorization });
    assert.equal(accepted.sessionId, 'owned-direct'); const deadline = Date.now() + 2000;
    while (!h.calls.some(([name, , envelope]) => name === 'directEvent' && envelope.event.type === 'session-done') && Date.now() < deadline) await new Promise(done => setTimeout(done, 5));
    const replay = await service.events(71, 'owned-direct', 0); assert.equal(replay.ok, true);
    assert.equal(replay.events[0].event.type, 'session-accepted'); assert.equal(replay.events.at(-1).event.type, 'session-done');
    assert.equal((await service.events(72, 'owned-direct', 0)).error.code, 'AGENT_SESSION_FORBIDDEN');
    assert.equal(h.calls.filter(([name]) => name === 'admitProvider' || name === 'openAppDatabase' || name === 'dialog').length, 0);
    assert.equal(h.target.events.length, 0);
  } finally { service.clearState(); await h.close(); }
});
test('local Agent application entries need only memory and tool ports', async () => {
  assert.equal(fs.existsSync(localServicePath), true, 'Local Agent application service must exist');
  assert.doesNotMatch(fs.readFileSync(localServicePath, 'utf8'), /electron|TrustedIpcHandle|IpcMainInvokeEvent|WebContents|modelServiceVault|resolveApiKey|apiKey/);
  const h = await harness(); try {
    const service = h.directLocal(); assert.equal(Object.isFrozen(service), true);
    assert.equal(service.saveMemory({ topic: 'owned', summary: 'owned facts' }).ok, true);
    assert.equal(service.listMemories().entries.length, 1);
    assert.equal(service.deleteMemory('owned').deleted, true);
    assert.equal((await service.runTool('inspect_owned', {})).ok, true);
    assert.equal(h.calls.some(([name]) => name === 'admitProvider' || name === 'dialog' || name === 'utilityRun'), false);
  } finally { await h.close(); }
});
test('actual explicit memory entries retain normalization, bounds and global storage scope', async () => {
  const h = await harness(); try {
    const saved = await h.invoke('ai.memory.save', { topic: ' owned ', summary: ' facts ', details: ' detail ', id: ' id ', tags: [' tag ', ''] });
    assert.equal(saved.ok, true); assert.deepEqual(plain(saved.entry), { topic: 'owned', summary: 'facts', details: 'detail', id: 'id', tags: ['tag'] });
    for (const entry of [null, [], {}, { topic: 'x'.repeat(257), summary: 's' }, { topic: 't', summary: 'x'.repeat(10001) },
      { topic: 't', summary: 's', details: 1 }, { topic: 't', summary: 's', id: 1 }, { topic: 't', summary: 's', tags: [1] },
      { topic: 't', summary: 's', tags: Array(33).fill('tag') }, { topic: 't', summary: 's', tags: ['x'.repeat(129)] }]) {
      assert.equal((await h.invoke('ai.memory.save', entry)).error.code, 'MEMORY_ENTRY_INVALID');
    }
    assert.equal((await h.invoke('ai.memory.list')).entries.length, 1);
    for (const key of [null, '', ' ', 'x'.repeat(257)]) assert.equal((await h.invoke('ai.memory.delete', key)).error.code, 'MEMORY_KEY_INVALID');
    assert.equal((await h.invoke('ai.memory.delete', 'absent')).deleted, false);
    assert.equal((await h.invoke('ai.memory.delete', ' owned ')).deleted, true);
    assert.equal(h.calls.filter(([name]) => name === 'memoryStore').every(([, args]) => args.length === 0), true);
    assert.equal(h.calls.some(([name]) => name === 'openWorkspace' || name === 'admitProvider'), false);
  } finally { await h.close(); }
});
test('memory storage failure keeps the three original explicit operation errors', async () => {
  const h = await harness({ memoryError: new Error('owned private storage sentinel') }); try {
    for (const [channel, input, code] of [['ai.memory.list', undefined, 'MEMORY_LIST_FAILED'],
      ['ai.memory.save', { topic: 'owned', summary: 'facts' }, 'MEMORY_SAVE_FAILED'], ['ai.memory.delete', 'owned', 'MEMORY_DELETE_FAILED']]) {
      const result = await h.invoke(channel, input); assert.equal(result.ok, false); assert.equal(result.error.code, code);
      assert.doesNotMatch(JSON.stringify(result), /sentinel/);
    }
  } finally { await h.close(); }
});
test('sidebar draft stays a local plan and preserves supplied or registry tool descriptions', async () => {
  const h = await harness(); try {
    for (const availableTools of [[], [{ name: 'search_owned', description: 'Owned search.', permission: 'read' }]]) {
      const input = { settings: { provider: 'mock', thinking: 'low', mode: 'fullPermission' }, userPrompt: 'Read owned facts.', context: {}, availableTools };
      const result = await h.invoke('ai.sidebarDraft', input);
      assert.equal(result.mode, 'plan'); assert.equal(result.status, 'ready');
      assert.deepEqual(plain(result), realCore.buildAiSidebarDraft({ ...input, settings: { ...input.settings, mode: 'plan' },
        availableTools: availableTools.length ? availableTools : h.deps.toolRegistry.list() }));
    }
    assert.equal(h.calls.some(([name]) => name === 'admitProvider' || name === 'dialog' || name === 'utilityRun'), false);
  } finally { await h.close(); }
});
test('direct tools keep no-workspace discussion and the Core plan permission guard', async () => {
  const h = await harness(); try {
    assert.equal((await h.invoke('ai.runTool', 'inspect_owned', {})).ok, true);
    assert.equal((await h.invoke('ai.runTool', 'commit_owned', {})).error.code, 'TOOL_PERMISSION_DENIED');
    assert.equal((await h.invoke('ai.runTool', 'absent_tool', {})).error.code, 'TOOL_NOT_FOUND');
    assert.equal(h.calls.some(([name]) => name === 'openWorkspace' || name === 'commitTool'), false);
  } finally { await h.close(); }
});
test('direct tools do not dispatch against a same-ID replacement after utility opening', async () => {
  const opening = deferred(), replacement = { ...ownedWorkspace, layers: { ...ownedWorkspace.layers, overlayRoot: '/owned/replacement' } };
  const h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), openWorkspace: () => opening.promise });
  try {
    const pending = h.invoke('ai.runTool', 'inspect_owned', {});
    h.switchWorkspace(replacement, new realCore.WorkspaceIndex('owned')); opening.resolve(h.utility);
    const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'AGENT_WORKSPACE_REPLACED');
    assert.equal(h.calls.filter(([name]) => name === 'readTool').length, 0);
  } finally { await h.close(); }
});
test('direct tools reject reactivation of the same session object during utility opening', async () => {
  const opening = deferred(), index = new realCore.WorkspaceIndex('owned');
  const h = await harness({ session: ownedWorkspace, index, openWorkspace: () => opening.promise });
  try {
    const pending = h.invoke('ai.runTool', 'inspect_owned', {});
    h.switchWorkspace(null, null); h.switchWorkspace(ownedWorkspace, index); opening.resolve(h.utility);
    const result = await pending; assert.equal(result.ok, false); assert.equal(result.error.code, 'AGENT_WORKSPACE_REPLACED');
    assert.equal(h.calls.filter(([name]) => name === 'readTool').length, 0);
  } finally { await h.close(); }
});
test('utility opening in the same activation dispatches once and already-started results stay truthful', async () => {
  const opening = deferred(), settlement = deferred();
  const h = await harness({ session: ownedWorkspace, index: new realCore.WorkspaceIndex('owned'), openWorkspace: () => opening.promise, read: () => settlement.promise });
  try {
    const pending = h.invoke('ai.runTool', 'inspect_owned', {}); opening.resolve(h.utility);
    await new Promise(done => setImmediate(done)); assert.equal(h.calls.filter(([name]) => name === 'readTool').length, 1);
    assert.equal(h.calls.find(([name]) => name === 'readTool')[1].session, ownedWorkspace);
    h.switchWorkspace(null, null); const outcome = { ok: true, state: 'completed', data: { owned: 'settled' } }; settlement.resolve(outcome);
    assert.equal(await pending, outcome); assert.equal(h.calls.filter(([name]) => name === 'readTool').length, 1);
  } finally { await h.close(); }
});
