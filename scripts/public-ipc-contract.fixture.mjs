import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import ts from 'typescript';
import { encode, facadeSignatures, loadSource, observeFacade, registeredChannels, repoRoot } from './contract/publicIpcTestSupport.mjs';
import { checkPublicIpcOutputs, renderPublicIpc } from './generate-public-ipc.mjs';

const baseline = JSON.parse(readFileSync(resolve(repoRoot, 'scripts/contract/public-ipc-baseline.json'), 'utf8'));

test('the actual generated API preserves assignable method properties and contextual parameter types', () => {
  const config = ts.readConfigFile(resolve(repoRoot, 'tsconfig.base.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  const program = ts.createProgram({ rootNames: [resolve(repoRoot, 'scripts/contract/public-api-mutability.typecheck.ts')],
    options: { ...parsed.options, noEmit: true, types: ['node'], composite: false, incremental: false } });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => repoRoot, getCanonicalFileName: filename => filename, getNewLine: () => '\n'
  }));
});

test('the generated facade preserves every public method, channel, argument order and omitted argument', async () => {
  const { api, calls } = observeFacade();
  assert.deepEqual(Object.keys(api), baseline.methods);
  for (const entry of baseline.invokes) {
    const args = Array.from({ length: entry.parameterCount }, (_, index) => `arg-${index}`);
    await api[entry.name](...args);
    assert.deepEqual(encode(calls.pop()), entry.provided, entry.name);
    await api[entry.name]();
    assert.deepEqual(encode(calls.pop()), entry.omitted, `${entry.name} omitted`);
    await api[entry.name](...args, 'hostile-extra-argument');
    assert.deepEqual(encode(calls.pop()), entry.provided, `${entry.name} extra arguments`);
  }
});

test('compatibility defaults and request envelopes preserve their special wire behavior', async () => {
  const { api, calls } = observeFacade();
  await api.submitEmevdDslPlan('file://event', 'source', undefined);
  assert.deepEqual(calls.pop().args, ['file://event', 'source', 'patch']);
  await api.getAiAgentEvents('session', undefined);
  assert.deepEqual(calls.pop().args, ['session', 0]);
  await api.readMapStaticGeometry('file://map', 'part', undefined, null, undefined);
  assert.deepEqual(calls.pop().args, ['file://map', 'part', null, null, null]);
  for (const flag of [true, false, undefined, 'truthy']) {
    await api.readEmevdFullDocument('file://event', 'document', flag);
    assert.deepEqual(calls.pop().args, ['file://event', 'document', flag === true ? true : undefined]);
  }
  const selection = { resourceUri: 'file://relative', family: 'param' };
  await api.createAgentResourceReference(selection);
  assert.deepEqual(calls.pop().args, [{ selection }]);
  const hits = [{ kind: 'resource', sourceUri: 'file://relative' }];
  await api.createAgentCitation(hits);
  assert.deepEqual(calls.pop().args, [{ hits }]);
});

test('the four existing result projections strip nested authority and preserve binary identity', async () => {
  const { api, setResponse } = observeFacade();
  const bytes = new Uint8Array([3, 5]);
  const buffer = new ArrayBuffer(2);
  const forbiddenKeys = ['containerPath', 'rootPath', 'absolutePath', 'sourcePath', 'targetPath', 'backupPath'];
  const privateFields = Object.fromEntries(forbiddenKeys.map((key) => [key, 'private']));
  const payload = { ...privateFields, label: 'failed at C:\\game\\secret.bin', children: [{ ...privateFields, sourceUri: 'file://relative' }], bytes, buffer };
  setResponse(payload);
  for (const name of baseline.transforms) {
    const result = await api[name]('file://relative', 1, 20);
    for (const key of forbiddenKeys) {
      assert.equal(key in result, false, `${name} ${key}`);
      assert.equal(key in result.children[0], false, `${name} nested ${key}`);
    }
    assert.equal(result.children[0].sourceUri, 'file://relative');
    assert.equal(result.label, 'failed at [本机路径已隐藏]');
    assert.equal(result.bytes, bytes);
    assert.equal(result.buffer, buffer);
    assert.equal(payload.rootPath, 'private');
  }
  assert.equal(await api.readRawMetadata('file://relative'), payload);
});

test('transport failures retain the original rejection across every public invoke and projection', async () => {
  const { api, setResponse } = observeFacade();
  const failure = new Error('owned transport rejection');
  for (const { name } of baseline.invokes) {
    setResponse(Promise.reject(failure));
    await assert.rejects(api[name](), (error) => error === failure, name);
  }
});

test('event projections hide Electron events and unsubscribe exactly their own listener', () => {
  const { api, listeners, removals } = observeFacade();
  for (const [method, channel, envelope, expected] of [
    ['onUpdateState', 'update:event', { seq: 8, state: { status: 'idle' } }, { status: 'idle' }],
    ['onAiAgentEvent', 'ai:agent:event', { seq: 4, sessionId: 's', event: { type: 'session-done' } }, { seq: 4, sessionId: 's', event: { type: 'session-done' } }]
  ]) {
    const first = [], second = [];
    const unsubscribe = api[method]((...args) => first.push(args));
    const unsubscribeSecond = api[method]((...args) => second.push(args));
    const [firstListener, secondListener] = listeners.get(channel);
    firstListener({ sender: 'private' }, envelope);
    secondListener({ sender: 'private' }, envelope);
    assert.deepEqual(first, [[expected]]);
    assert.deepEqual(second, [[expected]]);
    assert.equal(unsubscribe(), method === 'onUpdateState' ? 'transport-removal-result' : undefined);
    assert.deepEqual([...listeners.get(channel)], [secondListener]);
    assert.deepEqual(removals.at(-1), { channel, listener: firstListener });
    unsubscribeSecond();
    assert.equal(listeners.get(channel).size, 0);
  }
});

test('only the explicit public surface can cross the context bridge', () => {
  const { api } = observeFacade();
  for (const name of ['invoke', 'send', 'handle', 'runBridge', 'writeFile', 'saveRawReplace', 'resolveApiKey', 'createConfirmationReceipt']) {
    assert.equal(Object.hasOwn(api, name), false, name);
  }
  assert.equal(Object.values(api).every((value) => typeof value === 'function'), true);
});

test('every generated public invoke matches exactly one current main registration', async () => {
  const { channels, visitFile } = registeredChannels();
  visitFile('apps/desktop/src/main/ipc.ts');
  for (const filename of readdirSync(resolve(repoRoot, 'apps/desktop/src/main/ipc'))) {
    if (filename.endsWith('.ts') && !filename.endsWith('.test.ts')) visitFile(`apps/desktop/src/main/ipc/${filename}`);
  }
  visitFile('apps/desktop/src/main/update/updateIpc.ts');
  visitFile('apps/desktop/src/main/auxiliaryServices.ts');
  const { api, calls } = observeFacade();
  for (const entry of baseline.invokes) {
    await api[entry.name]();
    const { channel } = calls.pop();
    assert.equal(channels.get(channel)?.length, 1, `${entry.name} -> ${channel}: ${JSON.stringify(channels.get(channel))}`);
  }
});

test('the typed public contract is the sole generator input and checked projections are deterministic', () => {
  const generator = resolve(repoRoot, 'scripts/generate-public-ipc.mjs');
  assert.equal(existsSync(generator), true, 'Missing deterministic public IPC generator');
  execFileSync(process.execPath, [generator, '--check'], { cwd: repoRoot, stdio: 'pipe' });
  const { publicIpcContract } = loadSource('apps/desktop/src/ipc/publicContract.ts');
  assert.deepEqual(Object.keys(publicIpcContract), baseline.methods);
  const output = readFileSync(resolve(repoRoot, 'apps/desktop/src/preload/index.ts'), 'utf8');
  assert.match(output, /Generated by scripts\/generate-public-ipc\.mjs/);
  assert.doesNotMatch(output, /from ['"]\.\.\/main\//);
});

test('all generated invoke parameter and result declarations preserve the pre-refactor type signatures', () => {
  const signatures = facadeSignatures(readFileSync(resolve(repoRoot, 'apps/desktop/src/preload/index.ts'), 'utf8'));
  for (const { name } of baseline.invokes) assert.deepEqual(signatures[name], baseline.signatures[name], name);
});

test('the generator catches stale projections and generates identical bytes from identical input', () => {
  const source = readFileSync(resolve(repoRoot, 'apps/desktop/src/ipc/publicContract.ts'), 'utf8');
  const expected = renderPublicIpc(source);
  assert.deepEqual(renderPublicIpc(source), expected);
  assert.deepEqual(checkPublicIpcOutputs(repoRoot, expected), []);
  const changed = renderPublicIpc(source.replace("'window.setThemeMode'", "'window.changedThemeMode'"));
  assert.deepEqual(checkPublicIpcOutputs(repoRoot, changed), ['apps/desktop/src/preload/index.ts']);
  const missing = new Map([['apps/desktop/src/ipc/missing.generated.ts', 'missing']]);
  assert.deepEqual(checkPublicIpcOutputs(repoRoot, missing), ['apps/desktop/src/ipc/missing.generated.ts']);
});

test('generated IPC projections accept LF/CRLF transport but retain content and lone-CR drift', () => {
  const source = readFileSync(resolve(repoRoot, 'apps/desktop/src/ipc/publicContract.ts'), 'utf8').replace(/\r\n/g, '\n');
  const outputs = renderPublicIpc(source);
  const crlfOutputs = renderPublicIpc(source.replace(/\n/g, '\r\n'));
  assert.deepEqual([...crlfOutputs.keys()], [...outputs.keys()]);
  for (const [path, output] of outputs) assert.equal(crlfOutputs.get(path) === output, true, `${path}: LF/CRLF generation differs`);
  const root = mkdtempSync(join(tmpdir(), 'sf-public-ipc-eol-'));
  try {
    for (const [path, output] of outputs) {
      const target = resolve(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, output.replace(/\n/g, '\r\n'));
    }
    assert.deepEqual(checkPublicIpcOutputs(root, outputs), []);
    const preload = 'apps/desktop/src/preload/index.ts';
    const changedChannel = outputs.get(preload).replace("'window.setThemeMode'", "'window.changedThemeMode'");
    assert.notEqual(changedChannel, outputs.get(preload));
    writeFileSync(resolve(root, preload), changedChannel);
    assert.deepEqual(checkPublicIpcOutputs(root, outputs), [preload]);
    writeFileSync(resolve(root, preload), outputs.get(preload));
    const types = 'apps/desktop/src/ipc/publicApi.generated.ts';
    const loneCr = outputs.get(types).replace('\n', '\r');
    assert.notEqual(loneCr, outputs.get(types));
    writeFileSync(resolve(root, types), loneCr);
    assert.deepEqual(checkPublicIpcOutputs(root, outputs), [types]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the generator refuses dynamic exposure, arbitrary transport methods and unknown transforms', () => {
  const prefix = 'export const publicIpcContract = ';
  for (const [body, failure] of [
    ["{ ...internalHandlers }", /NAMED_METHOD_REQUIRED/],
    ["{ invoke: invoke<unknown>()('anything', () => []) }", /METHOD_INVALID/],
    ["{ __proto__: invoke<unknown>()('anything', () => []) }", /METHOD_INVALID/],
    ["{ read: invoke<unknown>()(userChannel, () => []) }", /CHANNEL_INVALID/],
    ["{ read: invoke<unknown>()('read', (...args: unknown[]) => args) }", /FIXED_ARGUMENTS_REQUIRED/],
    ["{ read: invoke<unknown>()('read', () => [], 'unsafe') }", /TRANSFORM_INVALID/],
    ["{ read: invoke()('read', () => []) }", /RESULT_REQUIRED/],
    ["{ read: invoke<unknown>()('read', () => []), read: invoke<unknown>()('read', () => []) }", /METHOD_INVALID/]
  ]) assert.throws(() => renderPublicIpc(`${prefix}${body} as const;`), failure, body);
});

test('contract and type projections have no main or Electron import authority', () => {
  for (const path of ['ipc/contractDefinition.ts', 'ipc/publicContract.ts', 'ipc/publicTypes.ts', 'ipc/publicApi.generated.ts']) {
    const source = readFileSync(resolve(repoRoot, `apps/desktop/src/${path}`), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\()["'][^"']*(?:main\/|electron)/, path);
  }
});

test('the bundled generated preload exposes the same named transport surface without loading main or core runtime', async () => {
  const { api, calls, bundledInputs } = observeFacade({ bundle: true });
  assert.deepEqual(Object.keys(api), baseline.methods);
  assert.equal(bundledInputs.some((path) => path.includes('/main/') || path.startsWith('packages/core/')), false);
  assert.equal(bundledInputs.some((path) => path.endsWith('/publicContract.ts')), false);
  for (const entry of baseline.invokes) {
    await api[entry.name](...Array.from({ length: entry.parameterCount }, (_, index) => `arg-${index}`));
    assert.deepEqual(encode(calls.pop()), entry.provided, entry.name);
  }
});
