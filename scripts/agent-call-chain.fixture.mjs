import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import test from 'node:test';
import * as core from '../packages/core/dist/index.js';
import { encryptTestConfig } from './testing/test-agent-provider.mjs';
import { evaluateWriteAdmission, evaluateGoalCoverage } from './real-agent-harness-lib.mjs';
import { runHeadlessAgentCommand } from '../tools/soulforge-cli/headless-agent.mjs';

const secret = 'synthetic-call-chain-private-key';
const textResponse = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixture run stopped.' }] }], usage: { input_tokens: 8, output_tokens: 10 } };
const callResponse = (id, name, args) => ({ status: 'completed', output: [{ type: 'function_call', id: `fc-${id}`, call_id: id, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 12, output_tokens: 10 } });

async function fixture(mode, responses, check) {
 const root = await mkdtemp(join(tmpdir(), 'sf-original-call-chain-'));
 const previous = { xdg: process.env.XDG_DATA_HOME, local: process.env.LOCALAPPDATA, override: process.env.SF_E2E_WORKSPACE_STORAGE_ROOT, fetch: globalThis.fetch };
 const requests = [], results = [], frames = [], diagnostics = []; let calls = 0;
 try {
  const profile = join(root, 'profile');
  process.env.XDG_DATA_HOME = profile; process.env.LOCALAPPDATA = profile; delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT;
  globalThis.fetch = async () => { throw new Error('NETWORK_FORBIDDEN_IN_CALL_CHAIN_FIXTURE'); };
  const overlay = join(root, 'overlay'); await import('node:fs/promises').then(fs => fs.mkdir(overlay));
  const resource = join(overlay, 'fixture.txt'); const original = 'Owned fixture bytes remain unchanged.\n'; await writeFile(resource, original);
  const config = join(root, 'test'); await writeFile(config, encryptTestConfig({ url: 'https://original-config.fixture.invalid', api: secret, model: 'fixture-private-model', protocol: 'openai-responses' }));
  let session;
  const host = { ...core,
   createConfiguredModelServiceAdapter: options => core.createConfiguredModelServiceAdapter({ ...options, fetchImpl: async (url, init) => {
    calls++; assert.match(String(url), /\/v1\/responses$/); assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`);
    const body = JSON.parse(init.body); assert.equal(body.model, 'fixture-private-model'); requests.push(body);
    const next = responses[calls - 1]; assert.ok(next, 'unexpected provider resampling');
    return next instanceof Response ? next : Response.json(next);
   } }),
   openLocalCliSession: async options => {
    session = await core.openLocalCliSession(options);
    const workspacePath = relative(profile, core.cliWorkspaceRoot(session.coreSession.workspaceId));
    assert.ok(workspacePath && !isAbsolute(workspacePath) && !workspacePath.split(sep).includes('..'), 'actual CLI storage stays inside this owned fixture profile');
    const execute = session.bridge.executeTool;
    session.bridge.executeTool = async (...args) => { const result = await execute(...args); results.push({ tool: args[0].name, result }); return result; };
    const dispose = session.dispose;
    session.dispose = async () => { assert.deepEqual(await session.coreSession.operationLog.list(), []); await dispose(); };
    return session;
   }
  };
  const report = await runHeadlessAgentCommand({ workspace: overlay, mode, noAnalyze: true, useCache: false, agentArgs: ['exec', '--prompt', 'Inspect the owned fixture.', '--provider', 'test', '--test-config', config, '--max-cost', '1', '--input-price-per-million', '1', '--output-price-per-million', '1', '--max-steps', '6', '--sessions-dir', join(root, 'sessions')] }, host, process.cwd(), { emit: frame => frames.push(frame), emitDiagnostic: event => diagnostics.push(event) });
  assert.equal(await readFile(resource, 'utf8'), original); assert.deepEqual(await readdir(overlay), ['fixture.txt']);
  assert.equal(report.evaluation, 'unverified'); assert.equal(JSON.stringify({ report, frames, diagnostics }).includes(secret), false);
  const rollout = await readFile(report.rolloutPath, 'utf8'); assert.equal(rollout.includes(secret), false);
  await check({ report, requests, results, frames, diagnostics, calls, rollout, session });
 } finally {
  if (previous.xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous.xdg;
  if (previous.local === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.local;
  if (previous.override === undefined) delete process.env.SF_E2E_WORKSPACE_STORAGE_ROOT; else process.env.SF_E2E_WORKSPACE_STORAGE_ROOT = previous.override;
  globalThis.fetch = previous.fetch; await rm(root, { recursive: true, force: true });
 }
}

test('original encrypted test -> configured adapter -> shared host discovers despite unsupported effect metadata and blocks unproved writes', async () => {
 const goals = [{ goalId: 'unknown-effect', kind: 'unsupported', required: true, verificationStatus: 'unsupported', unsupportedReason: 'No independent effect verifier in this fixture.' }];
 assert.equal(evaluateWriteAdmission(goals).allowed, true);
 await fixture('fullPermission', [callResponse('discover', 'search_resources', { query: 'fixture', limit: 2 }), callResponse('unproved-write', 'mutate_param_fields', { edits: [{ table: 'FixtureParam', rowId: 1, fieldId: 'fixtureField', value: 2 }] }), textResponse], async ({ report, requests, results, diagnostics, rollout, calls }) => {
  assert.equal(calls, 3); assert.equal(results[0].tool, 'search_resources'); assert.equal(results[0].result.ok, true);
  assert.equal(results[1].result.ok, false); assert.match(results[1].result.content, /NATIVE_READ_REQUIRED/);
  assert.ok(requests[0].tools.some(tool => tool.name === 'search_resources'));
  assert.ok(requests[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'discover'));
  assert.ok(diagnostics.some(event => event.phase === 'tool' && event.details.tool === 'mutate_param_fields' && event.details.code === 'NATIVE_READ_REQUIRED'));
  assert.equal(report.budget.requests, 3); assert.equal(report.budget.outputUsed, 30); assert.equal(report.transactions.some(item => item.state === 'committed'), false);
  assert.match(rollout, /NATIVE_READ_REQUIRED/);
  const verdict = evaluateGoalCoverage(goals.map(goal => ({ ...goal, verified: true })), false);
  assert.equal(verdict.status, 'unsupported'); assert.equal(verdict.taskCompletionVerified, false);
 });
});

test('original encrypted provider in plan mode cannot commit through the shared host', async () => {
 await fixture('plan', [callResponse('unsafe-commit', 'commit_patch', {}), textResponse], async ({ report, results, rollout }) => {
  assert.equal(results.length, 0); assert.match(rollout, /AGENT_TOOL_DENIED_PLAN_MODE/);
  assert.equal(report.transactions.some(item => item.state === 'committed'), false);
 });
});

test('original configured adapter auth error is terminal, structured and redacted without real network calls', async () => {
 await fixture('plan', [new Response(JSON.stringify({ error: { message: `Credential ${secret} was rejected` } }), { status: 401, headers: { 'content-type': 'application/json' } })], async ({ report, results, calls }) => {
  assert.equal(calls, 1); assert.equal(results.length, 0); assert.equal(report.finishReason, 'error');
  assert.ok(report.diagnostics.some(item => item.code === 'MODEL_SERVICE_AUTH_ERROR'));
 });
});
