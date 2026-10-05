// Execute the production native Script IPC, commit port and confirmation flow.
// Bridge staging and Patch Engine replacement use owned synthetic ports; this
// check does not launch Electron, compile native code or write resource bytes.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = relative => fs.readFileSync(path.join(repo, relative), 'utf8');
const sourcePaths = {
  resource: 'apps/desktop/src/main/ipc/resource.ts',
  script: 'apps/desktop/src/main/services/scriptSourceService.ts',
  resourceWrite: 'apps/desktop/src/main/services/resourceMutationService.ts',
  writeContext: 'apps/desktop/src/main/services/resourceWriteContext.ts',
  ipc: 'apps/desktop/src/main/ipc.ts',
  ownership: 'apps/desktop/src/main/knowledgeRefreshOwnership.ts',
  sessionCommit: 'apps/desktop/src/main/services/sessionCommitService.ts',
  mutation: 'packages/core/src/editing/editorMutationService.ts',
  dto: 'apps/desktop/src/main/rendererDto.ts'
};

function execute(text, filename, scope = {}, imports = {}) {
  const result = ts.transpileModule(text, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  });
  assert.equal((result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const exports = {};
  vm.runInNewContext(result.outputText, {
    Buffer, Error, Uint8Array, ArrayBuffer, exports, module: { exports }, ...scope,
    require(name) {
      if (!Object.hasOwn(imports, name) && name.startsWith('.')) {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(filename), name.replace(/\.js$/, '.ts')));
        return execute(source(dependency), dependency, scope, imports);
      }
      assert.ok(Object.hasOwn(imports, name), `Unexpected runtime import: ${name}`);
      return imports[name];
    }
  }, { filename });
  return exports;
}

function extract(relative, name, scope) {
  const text = source(relative);
  const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Actual production function ${name} must exist`);
  const alreadyExported = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  return execute(`${alreadyExported ? '' : 'export '}${declaration.getText(parsed)}`, relative, scope)[name];
}

const ownership = execute(source(sourcePaths.ownership), sourcePaths.ownership);
const shared = execute(source('packages/shared/src/path-sanitizer.ts'), 'packages/shared/src/path-sanitizer.ts');
const dto = execute(source(sourcePaths.dto), sourcePaths.dto, {}, {
  '@soulforge/shared': shared
});
const cancelledWrite = extract(sourcePaths.ipc, 'cancelledWrite');
const toSaveResultFromOutcome = extract(sourcePaths.ipc, 'toSaveResultFromOutcome', {
  cancelledWrite, toRendererSaveResult: dto.toRendererSaveResult
});

const sourceUri = 'resource://owned-synthetic/script.luabnd.dcx';
const file = { sourceUri, absolutePath: '/owned-synthetic/script.luabnd.dcx', relativePath: 'script.luabnd.dcx' };
const session = { meta: { workspaceId: 'owned-synthetic' }, layers: {} };
const storage = { root: '/owned-synthetic', backupBaseDir: '/owned-synthetic/backup', recoveryDir: '/owned-synthetic/recovery', stagingRoot: '/owned-synthetic/stage' };
const hksBytes = Buffer.from([0x1b, 0x4c, 0x75, 0x61, 0x51, 0]);
const unused = () => { throw new Error('Unexpected capability invocation'); };

function harness({ candidateOk = true, cancel = false, commitOk = true, rejectRefresh = false, rejectCache = false, readOk = true, compileOk = true, readRootsOk = true, stageRootsOk = true, commitGate, commitStarted, workspaceSessionId = 'owned-session' } = {}) {
  const events = [];
  const requests = { bridge: [], commit: [], confirmation: [], candidate: [], workbench: [], refresh: [] };
  const handlers = new Map();
  let activeSession = session, generation = 1;
  const rawResult = { ok: commitOk, opId: 'owned-commit', changedFiles: commitOk ? [file.absolutePath] : [], diagnostics: [] };
  const refresh = async (_sources, carrier) => {
    events.push('refresh');
    requests.refresh.push(_sources);
    if (rejectRefresh) throw new Error('owned refresh failed');
    carrier.knowledgeRefresh = { status: 'converged' };
  };
  const ownedSaveRawReplace = async input => {
      requests.commit.push(input);
      assert.ok(input.confirmation, 'Actual confirmation must reach commit');
      assert.equal(input.expectedHash, 'owned-container-hash');
      events.push('commit');
      commitStarted?.();
      if (commitGate) await commitGate;
      return rawResult;
  };
  const { createSessionCommitPort } = execute(source(sourcePaths.sessionCommit), sourcePaths.sessionCommit, {}, {
    '@soulforge/core': { saveRawReplace: ownedSaveRawReplace, createConfirmationReceipt: input => { requests.workbench.push(input); return { subjects: input.subjects }; } },
    '../knowledgeRefreshOwnership.js': ownership
  });
  const sessionCommitPort = extract(sourcePaths.ipc, 'sessionCommitPort', {
    createSessionCommitPort,
    getActiveWorkspaceSessionIdState: () => workspaceSessionId,
    getWorkspaceSession: () => activeSession,
    getActiveWorkspaceSessionGenerationState: () => generation,
    refreshActiveIndexAfterNativeWrite: refresh
  });
  const applyNativeMutation = extract(sourcePaths.mutation, 'applyNativeMutation', {
    // The actual confirmation/commit control flow runs with an owned staging candidate.
    buildNativeMutationCandidate: async request => {
      requests.candidate.push(request);
      if (!candidateOk) return { ok: false, diagnostics: [{ severity: 'error', code: 'OWNED_STAGE_FAILED', message: 'owned stage failed' }] };
      const staged = await request.stageWrite({ allowedRoots: ['/owned-synthetic'], writableRoots: ['/owned-synthetic/stage'], outputPath: '/owned-synthetic/stage/0.mut.dcx' });
      assert.equal(staged.ok, true);
      return { ok: true, newContentBase64: hksBytes.toString('base64'), payloadHash: 'owned-payload-hash' };
    }
  });
  const core = {
    applyNativeMutation,
    encodeScriptSourceForWriteback: unused,
    inspectContainerTree: unused,
    openResourcePreview: unused,
    readContainerChild: unused,
    replaceContainerChild: unused,
    saveRawReplace: unused,
    saveTextResource: unused,
    runBridge: async input => {
      requests.bridge.push(input);
      events.push(input.command);
      if (input.command === 'read-luabnd-script') return { parseStatus: readOk ? 'confirmed' : 'failed', diagnostics: [], data: {
        containerHash: 'owned-container-hash', contentHash: 'owned-child-hash', contentBase64: hksBytes.toString('base64'), sanitizedName: 'owned.lua'
      } };
      if (input.command === 'compile-hks-source') return { parseStatus: compileOk ? 'confirmed' : 'failed', diagnostics: [], data: { contentBase64: hksBytes.toString('base64') } };
      if (input.command === 'write-luabnd-script') return { parseStatus: 'confirmed', diagnostics: [], data: { outputHash: 'owned-output-hash' } };
      return unused();
    }
  };
  const resource = execute(source(sourcePaths.resource), sourcePaths.resource, {}, {
    'node:crypto': crypto,
    'node:fs/promises': { readFile: unused },
    'node:path': path,
    '@soulforge/core': core,
    '@soulforge/shared': shared,
    '../rendererDto.js': dto,
    '../knowledgeRefreshOwnership.js': ownership
  });
  resource.registerResourceIpcHandlers({
    handle: (name, handler) => handlers.set(name, handler),
    getIndexedFiles: () => [file],
    getActiveSession: () => activeSession,
    getActiveWorkspaceSessionGeneration: () => generation,
    ensureActiveOperationLog: async () => ({}),
    durableStoragePaths: () => storage,
    rejectNonSekiroNativeWrite: () => null,
    verifiedReadRoots: async () => ({ allowedRoots: ['/owned-synthetic'], diagnostics: readRootsOk ? [] : [{ severity: 'error', code: 'OWNED_READ_ROOT_FAILED' }] }),
    verifiedStageRoots: async () => ({ allowedRoots: ['/owned-synthetic'], writableRoots: ['/owned-synthetic/stage'], diagnostics: stageRootsOk ? [] : [{ severity: 'error', code: 'OWNED_STAGE_ROOT_FAILED' }] }),
    sessionCommitPort,
    toSaveResultFromOutcome,
    requestWriteConfirmation: async input => { requests.confirmation.push(input); events.push('confirm'); return cancel ? null : { subjects: ['owned-only'] }; },
    clearResourceRelatedCaches: () => { events.push('cache-clear'); if (rejectCache) throw new Error('owned cache failed'); },
    refreshActiveIndexAfterNativeWrite: refresh
  });
  return {
    events, requests, rawResult, sessionCommitPort,
    switchSession(value) { activeSession = value; generation++; },
    save: () => handlers.get('resource.saveScriptSource')({}, sourceUri, 'owned.lua', 'owned-child-hash', 'owned-container-hash', 'return 2', 'utf8', 0)
  };
}

const postCommit = events => events.filter(event => ['commit', 'cache-clear', 'refresh'].includes(event));
// The actual handler executes in a VM realm; compare plain argument values,
// while keeping separate identity assertions for the source file/session.
const plain = value => JSON.parse(JSON.stringify(value));

test('Script resource orchestration is callable below IPC with no sender or registrar capability', () => {
  const service = 'apps/desktop/src/main/services/scriptSourceService.ts';
  assert.equal(fs.existsSync(path.join(repo, service)), true, 'Script source application service must exist');
  assert.doesNotMatch(source(service), /IpcMainInvokeEvent|TrustedIpcHandle|deps\.handle/);
});

test('native commit orchestration is callable below the root adapter without transport capabilities', () => {
  assert.doesNotMatch(source(sourcePaths.sessionCommit), /IpcMainInvokeEvent|TrustedIpcHandle|electron|\.handle\(/);
  const text = source(sourcePaths.ipc), parsed = ts.createSourceFile(sourcePaths.ipc, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const adapter = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sessionCommitPort');
  assert.match(adapter.getText(parsed), /createSessionCommitPort\(/);
  assert.doesNotMatch(adapter.getText(parsed), /saveRawReplace\(|commitWithKnowledgeRefresh\(|createConfirmationReceipt\(/);
});

test('source identity is reported for the actual handler, commit port, mutation control flow and ownership helper', t => {
  for (const [name, relative] of Object.entries(sourcePaths)) {
    t.diagnostic(`${name}: ${crypto.createHash('sha256').update(source(relative)).digest('hex')}`);
  }
});

test('native script commit refreshes exactly once after resource caches are invalidated', async t => {
  const h = harness();
  const result = await h.save();
  t.diagnostic(`actual post-commit order: ${JSON.stringify(postCommit(h.events))}`);
  assert.equal(result.ok, true);
  assert.equal(result.knowledgeRefresh.status, 'converged');
  assert.deepEqual(postCommit(h.events), ['commit', 'cache-clear', 'refresh']);
});

test('failed stage, cancelled confirmation and failed commit perform zero post-commit refreshes', async () => {
  for (const options of [{ candidateOk: false }, { cancel: true }, { commitOk: false }]) {
    const h = harness(options);
    const result = await h.save();
    assert.equal(result.ok, false);
    assert.equal(h.events.filter(event => event === 'refresh').length, 0);
    assert.equal(h.events.filter(event => event === 'cache-clear').length, 0);
    assert.equal(h.events.filter(event => event === 'commit').length, options.commitOk === false ? 1 : 0);
  }
});

test('source, compile and allowed-root rejection never enter the replacement or refresh boundary', async () => {
  for (const options of [{ readOk: false }, { compileOk: false }, { readRootsOk: false }, { stageRootsOk: false }]) {
    const h = harness(options);
    const result = await h.save();
    assert.equal(result.ok, false);
    assert.deepEqual(postCommit(h.events), []);
    assert.equal(h.requests.commit.length, 0);
    assert.equal(h.requests.confirmation.length, 0);
    assert.equal(h.requests.candidate.length, 0);
  }
});

test('native script save retains expected hashes, staging scopes, confirmation and replacement arguments', async () => {
  const h = harness();
  const result = await h.save();
  assert.equal(result.ok, true);
  assert.deepEqual(h.events.slice(0, 5), ['read-luabnd-script', 'compile-hks-source', 'write-luabnd-script', 'confirm', 'commit']);
  assert.equal(h.requests.bridge.length, 3);
  for (const request of h.requests.bridge) {
    assert.equal(request.filePath, file.absolutePath);
    assert.equal(request.resourceUri, sourceUri);
    assert.deepEqual(request.allowedRoots, ['/owned-synthetic']);
    assert.equal(request.workspaceSessionId, session.meta.workspaceId);
    assert.equal(request.timeoutMs, 120_000);
    assert.equal(request.maxFrameBytes, 32 * 1024 * 1024);
  }
  assert.deepEqual(plain(h.requests.bridge[0].commandOptions), { entryIndex: 0, expectedContainerHash: 'owned-container-hash', expectedChildHash: 'owned-child-hash' });
  assert.deepEqual(plain(h.requests.bridge[1].commandOptions), {
    sourceText: 'return 2', expectedSourceHash: 'owned-child-hash', expectedDialect: 'sekiro-hks-1.6.x', sourceContentBase64: hksBytes.toString('base64')
  });
  assert.deepEqual(plain(h.requests.bridge[2].commandOptions), {
    outputPath: '/owned-synthetic/stage/0.mut.dcx', entryIndex: 0, expectedContainerHash: 'owned-container-hash', expectedChildHash: 'owned-child-hash', contentBase64: hksBytes.toString('base64')
  });
  assert.deepEqual(h.requests.bridge[2].writableRoots, ['/owned-synthetic/stage']);
  assert.equal(h.requests.candidate[0].stagingRoot, storage.stagingRoot);
  assert.equal(h.requests.candidate[0].stagingPrefix, 'luabnd');
  assert.equal(h.requests.candidate[0].stagingFileName, '0.mut.dcx');
  assert.equal(h.requests.confirmation.length, 1);
  assert.equal(h.requests.confirmation[0].payloadHash, 'owned-payload-hash');
  assert.equal(h.requests.confirmation[0].sourceUri, sourceUri);
  assert.equal(h.requests.commit.length, 1);
  const commit = h.requests.commit[0];
  assert.equal(commit.file, file);
  assert.equal(commit.expectedHash, 'owned-container-hash');
  assert.equal(commit.newContentBase64, hksBytes.toString('base64'));
  assert.equal(commit.title, '保存 HKS 脚本源码 owned.lua');
  assert.equal(commit.session, session);
  assert.equal(commit.backupBaseDir, storage.backupBaseDir);
  assert.equal(commit.recoveryDir, storage.recoveryDir);
  assert.deepEqual(commit.confirmation, { subjects: ['owned-only'] });
  assert.deepEqual(plain(result.changedFiles), [sourceUri]);
});

test('committed native script refresh rejection returns committed ok with warning and no replay', async t => {
  const h = harness({ rejectRefresh: true });
  const settled = await h.save().then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', message: error.message }));
  t.diagnostic(`actual settlement: ${JSON.stringify(settled)}; post-commit order: ${JSON.stringify(postCommit(h.events))}`);
  assert.equal(h.rawResult.ok, true, 'Durable commit occurred');
  assert.equal(h.events.filter(event => event === 'commit').length, 1, 'No write replay');
  assert.equal(settled.status, 'fulfilled', 'Refresh failure must not reject already committed IPC');
  assert.equal(settled.value.ok, true);
  assert.equal(settled.value.opId, 'owned-commit');
  assert.ok(settled.value.diagnostics.some(item => item.code === 'POSTCOMMIT_REFRESH_FAILED' && item.severity === 'warning'));
  assert.deepEqual(postCommit(h.events), ['commit', 'cache-clear', 'refresh']);
});

test('actual default commit port preserves result identity on refresh rejection without replay', async () => {
  const h = harness({ rejectRefresh: true });
  const result = await h.sessionCommitPort(session, {}, storage).commit({ file, expectedHash: 'owned-container-hash', newContentBase64: hksBytes.toString('base64'), title: 'owned-only', confirmation: { subjects: ['owned-only'] } });
  assert.equal(result, h.rawResult);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics[0].code, 'POSTCOMMIT_REFRESH_FAILED');
  assert.deepEqual(postCommit(h.events), ['commit', 'refresh']);
});

test('actual commit service retains workbench fallback confirmation subjects and durable Patch Engine arguments', async () => {
  for (const workspaceSessionId of ['owned-session', null]) {
    const h = harness({ workspaceSessionId }), log = {};
    const result = await h.sessionCommitPort(session, log, storage).commit({ file, expectedHash: 'owned-container-hash',
      newContentBase64: hksBytes.toString('base64'), title: 'owned-title' });
    assert.equal(result, h.rawResult); assert.equal(h.requests.workbench.length, 1);
    assert.deepEqual(plain(h.requests.workbench[0]), {
      subjects: ['MAIN_WORKBENCH_COMMIT', sourceUri, 'ALL_RISKS', ...(workspaceSessionId ? [`WORKSPACE_SESSION:${workspaceSessionId}`] : []), 'TITLE:owned-title'],
      riskLevel: 'high', sourceUri, note: '工作台提交视为已确认'
    });
    const committed = h.requests.commit[0];
    assert.equal(committed.session, session); assert.equal(committed.operationLog, log); assert.equal(committed.file, file);
    assert.equal(committed.backupBaseDir, storage.backupBaseDir); assert.equal(committed.recoveryDir, storage.recoveryDir);
    assert.deepEqual(postCommit(h.events), ['commit', 'refresh']);
  }
});

for (const aba of [false, true]) {
  test(`actual default commit port preserves A receipt without publishing into ${aba ? 'same-object ABA' : 'B'} owner`, async () => {
    let resolveCommit, notifyStarted;
    const commitGate = new Promise(resolve => { resolveCommit = resolve; });
    const started = new Promise(resolve => { notifyStarted = resolve; });
    const h = harness({ commitGate, commitStarted: notifyStarted });
    const port = h.sessionCommitPort(session, {}, storage);
    const pending = port.commit({ file, expectedHash: 'owned-container-hash', newContentBase64: hksBytes.toString('base64'),
      title: 'owned-only', confirmation: { subjects: ['owned-only'] } });
    await started;
    h.switchSession({ ...session, layers: { overlayRoot: '/owned-other' } });
    if (aba) h.switchSession(session);
    resolveCommit(); const result = await pending;
    assert.equal(result, h.rawResult); assert.equal(result.ok, true); assert.equal(result.opId, 'owned-commit');
    assert.equal(h.requests.commit[0].session, session);
    assert.deepEqual(postCommit(h.events), ['commit']);
    assert.equal(result.diagnostics.filter(item => item.code === 'POSTCOMMIT_WORKSPACE_SUPERSEDED').length, 1);
    assert.equal(h.requests.commit.length, 1);
  });
}

test('actual default commit port performs no projection on a failed old-owner write', async () => {
  const h = harness({ commitOk: false }); h.switchSession({ ...session });
  const result = await h.sessionCommitPort(session, {}, storage).commit({ file, expectedHash: 'owned-container-hash',
    newContentBase64: hksBytes.toString('base64'), title: 'owned-only', confirmation: { subjects: ['owned-only'] } });
  assert.equal(result, h.rawResult); assert.equal(result.ok, false);
  assert.deepEqual(postCommit(h.events), ['commit']); assert.deepEqual(result.diagnostics, []);
});

test('actual default commit port retains its submitted logical source when indexed fields are reused', async () => {
  let resolveCommit, notifyStarted;
  const commitGate = new Promise(resolve => { resolveCommit = resolve; });
  const started = new Promise(resolve => { notifyStarted = resolve; });
  const h = harness({ commitGate, commitStarted: notifyStarted }), mutableFile = { ...file };
  const pending = h.sessionCommitPort(session, {}, storage).commit({ file: mutableFile, expectedHash: 'owned-container-hash',
    newContentBase64: hksBytes.toString('base64'), title: 'owned-only', confirmation: { subjects: ['owned-only'] } });
  await started; mutableFile.sourceUri = 'resource://owned-other/reused'; resolveCommit();
  const result = await pending;
  assert.equal(result, h.rawResult); assert.deepEqual(plain(h.requests.refresh), [[sourceUri]]);
});

test('resource cache invalidation rejection keeps committed ok and still runs one refresh', async t => {
  const h = harness({ rejectCache: true });
  const settled = await h.save().then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', message: error.message }));
  t.diagnostic(`actual settlement: ${JSON.stringify(settled)}; post-commit order: ${JSON.stringify(postCommit(h.events))}`);
  assert.equal(h.events.filter(event => event === 'commit').length, 1);
  assert.equal(settled.status, 'fulfilled');
  assert.equal(settled.value.ok, true);
  assert.ok(settled.value.diagnostics.some(item => item.code === 'POSTCOMMIT_PREVIEW_FAILED' && item.severity === 'warning'));
  assert.equal(settled.value.knowledgeRefresh.status, 'converged');
  assert.deepEqual(postCommit(h.events), ['commit', 'cache-clear', 'refresh']);
});
