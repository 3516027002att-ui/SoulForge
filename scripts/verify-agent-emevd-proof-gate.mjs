/**
 * Production host-composition fixture for the EMEVD native proof boundary.
 *
 * Uses production ToolRegistry (createDefaultToolRegistry) + AgentToolBridge +
 * NativeReadProofStore. createAgentTaskRecordGateway is NOT a production gate.
 * Native read/write I/O is controlled fixture data only — the production
 * projection, proof minting and write-gate contracts are exercised for real.
 *
 * Suite: test:agent-emevd-proof-gate
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAgentToolBridge } from '../packages/core/dist/index.js';
import { createDefaultToolRegistry } from '../packages/core/dist/ai/toolRegistry.js';
import { NativeReadProofStore } from '../packages/core/dist/editing/nativeReadProofStore.js';

const fixtureRoot = await mkdtemp(join(tmpdir(), 'soulforge-emevd-proof-gate-'));
let callSequence = 0;

function sha(label) {
  return createHash('sha256').update(label).digest('hex');
}

function completeEmevdDto({ sourceUri, sourcePath, eventId, outerFileHash, darkScript, total }) {
  const instructions = Array.from({ length: total }, (_, index) => ({
    index,
    bank: 3,
    id: index,
    argsBase64: 'AA==',
    unknown: false,
    emedfName: `FixtureInstruction${index}`,
    typedArgs: [{ name: 'value', type: 's32', value: index }],
    diagnostics: []
  }));
  return {
    ok: true,
    resourceKind: 'event',
    sourceUri,
    sourcePath,
    relativePath: sourceUri.slice('file://'.length),
    filePath: sourcePath,
    eventId,
    restBehavior: 1,
    instructionCount: total,
    total,
    offset: 0,
    limit: total,
    returned: total,
    truncated: false,
    darkScriptComplete: true,
    readRange: { start: 0, end: total },
    sourceHash: outerFileHash,
    outerFileHash,
    sourceRevision: 1,
    game: 'sekiro',
    registryOrigin: 'imported',
    registryFingerprint: 'fixture-registry-v1',
    registry: { origin: 'imported', fingerprint: 'fixture-registry-v1' },
    format: 'darkscript',
    darkScript,
    instructions,
    diagnostics: []
  };
}

function createHarness(sessionId) {
  const workspaceId = `workspace://emevd-proof/${sessionId}`;
  const sourceUri = 'file://event/fixture.emevd.dcx';
  const sourcePath = join(fixtureRoot, 'native-fixture', 'event', 'fixture.emevd.dcx');
  const eventId = 1000;
  const outerFileHash = sha(`outer-${sessionId}-${eventId}`);
  const darkScript = `$Event(${eventId}, Restart, function() {\n  FixtureInstruction0(0);\n});`;
  const writeCalls = [];
  const proofs = new NativeReadProofStore({ generation: 1 });

  const indexedFile = {
    id: `fixture-${sourceUri}`,
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: 'event/fixture.emevd.dcx',
    resourceKind: 'event',
    game: 'sekiro'
  };
  const workspaceIndex = {
    workspaceId,
    findReferences: () => [],
    getFiles: () => [indexedFile]
  };
  const session = {
    meta: { workspaceId, game: 'sekiro' },
    layers: { overlayRoot: fixtureRoot, baseRoot: fixtureRoot }
  };

  const registry = createDefaultToolRegistry();
  const context = {
    workspaceIndex,
    session,
    mode: 'fullPermission',
    modeCeiling: 'fullPermission',
    nativeReadProofs: proofs,
    proofPrincipal: `agent-run:${sessionId}`,
    agentRunId: `agent-run:${sessionId}`,
    requireProofBoundary: true,
    requireTaskRecord: false
  };

  const originalRun = registry.run.bind(registry);
  registry.run = async (name, input, ctx) => {
    if (name === 'read_emevd_event') {
      const view = input?.view === 'full-source' ? 'full-source' : 'default';
      const eventIdNum = Number(input?.eventId ?? eventId);
      const effectiveCtx = { ...ctx, ...context };
      if (view === 'full-source') {
        const data = completeEmevdDto({
          sourceUri,
          sourcePath,
          eventId: eventIdNum,
          outerFileHash,
          darkScript,
          total: 1
        });
        const result = {
          ok: true,
          state: 'completed',
          data
        };
        Object.defineProperty(result, '__hostResolvedEmevdEventTarget', {
          value: {
            resourceKind: 'event',
            sourceUri,
            sourcePath,
            eventId: eventIdNum,
            canonical: true
          },
          enumerable: false,
          configurable: true
        });
        return result;
      }
      // Windowed/outline-shaped read: not a complete native DSL delivery.
      const data = completeEmevdDto({
        sourceUri,
        sourcePath,
        eventId: eventIdNum,
        outerFileHash,
        darkScript: `$Event(${eventIdNum}, Restart, function() {\n  FixtureInstruction0(0);\n});`,
        total: 1
      });
      data.truncated = true;
      data.darkScriptComplete = false;
      data.offset = 0;
      data.returned = 0;
      data.instructionCount = 1;
      data.total = 8;
      data.readRange = { start: 0, end: 0 };
      data.instructions = [];
      data.darkScript = undefined;
      data.format = 'json';
      const result = { ok: true, state: 'completed', data };
      Object.defineProperty(result, '__hostResolvedEmevdEventTarget', {
        value: {
          resourceKind: 'event',
          sourceUri,
          sourcePath,
          eventId: eventIdNum,
          canonical: true
        },
        enumerable: false,
        configurable: true
      });
      return result;
    }
    if (name === 'apply_emevd_dsl' || name === 'mutate_luabnd_script') {
      const result = await originalRun(name, input, { ...ctx, ...context });
      const code = result?.error?.code;
      // Count only when the call passed the proof boundary (writer layer reached).
      if (!(result?.ok === false && typeof code === 'string' && code.startsWith('NATIVE_READ'))) {
        writeCalls.push({ name, input, code });
      }
      return result;
    }
    return originalRun(name, input, { ...ctx, ...context });
  };

  const bridge = createAgentToolBridge({ registry, context });
  return {
    sessionId,
    workspaceId,
    sourceUri,
    sourcePath,
    eventId,
    outerFileHash,
    darkScript,
    proofs,
    writeCalls,
    bridge,
    context,
    registry
  };
}

async function call(harness, name, input) {
  const response = await harness.bridge.executeTool({
    id: `fixture-${++callSequence}`,
    name,
    argumentsJson: JSON.stringify(input)
  });
  const parsed = JSON.parse(response.content);
  return { ok: response.ok, code: response.code, envelope: parsed, content: response.content };
}

const harness = createHarness('gate-run');

const applyPayload = {
  file: harness.sourceUri,
  eventId: harness.eventId,
  scope: 'event',
  mode: 'dark-script',
  dsl: harness.darkScript,
  sourceHash: harness.outerFileHash,
  outerFileHash: harness.outerFileHash,
  sourceRevision: 1,
  darkScriptComplete: true
};

// 1) Without any host-delivered proof, whole-event write fails NATIVE_READ_*.
const denied = await call(harness, 'apply_emevd_dsl', applyPayload);
assert.equal(denied.ok, false, '缺少完整原生读取证明时整事件写入必须失败');
assert.match(String(denied.code ?? denied.envelope?.error?.code ?? ''), /NATIVE_READ_/u);
assert.equal(harness.writeCalls.length, 0, '证明拒绝时不得调用 writer');

// 2) Fragment/outline/windowed read cannot mint whole-object proof.
const windowed = await call(harness, 'read_emevd_event', {
  file: harness.sourceUri,
  eventId: harness.eventId,
  view: 'default'
});
assert.equal(windowed.ok, true, 'windowed read itself may succeed');
assert.notEqual(
  windowed.envelope?.data?.record?.projection,
  'complete_native_dsl',
  'windowed read must not project complete_native_dsl'
);
const deniedAfterWindow = await call(harness, 'apply_emevd_dsl', applyPayload);
assert.equal(deniedAfterWindow.ok, false, '指令窗口/大纲不能授权整对象替换');
assert.match(String(deniedAfterWindow.code ?? deniedAfterWindow.envelope?.error?.code ?? ''), /NATIVE_READ_/u);
assert.equal(harness.writeCalls.length, 0);

// 3) Host-delivered complete native DSL (view=full-source) mints a proof.
const full = await call(harness, 'read_emevd_event', {
  file: harness.sourceUri,
  eventId: harness.eventId,
  view: 'full-source'
});
if (full.ok !== true) {
  console.error('full-source read failed', full.code, full.content?.slice(0, 800));
}
assert.equal(full.ok, true);
const projection = full.envelope?.data?.record?.projection
  ?? full.envelope?.data?.projection
  ?? full.envelope?.data?.items?.[0]?.projection;
assert.equal(projection, 'complete_native_dsl', `full-source must project complete_native_dsl, got ${String(projection)}`);
assert.equal(full.envelope?.completeness, 'complete');
assert.equal(full.envelope?.truncated, false);
assert.ok(
  harness.proofs.debugCount(harness.context.proofPrincipal) >= 1,
  '完整 DSL 读取后应产生宿主 NativeReadProofStore 证明'
);

// 4) With proof, write gate passes to writer layer (writer may fail on missing native file).
const allowed = await call(harness, 'apply_emevd_dsl', applyPayload);
const allowedCode = allowed.code ?? allowed.envelope?.error?.code;
if (allowed.ok === false && String(allowedCode ?? '').startsWith('NATIVE_READ')) {
  assert.fail(`完整读取后写入门禁仍拒绝：${allowedCode}\n${allowed.content?.slice(0, 500)}`);
}
assert.ok(
  harness.writeCalls.length >= 1,
  `证明通过后应到达 writer 层，writeCalls=${JSON.stringify(harness.writeCalls)} code=${String(allowedCode)}`
);

// 5) Production registry must not expose the manual task-record ledger tools.
const toolNames = harness.registry.list().map((tool) => tool.name);
assert.ok(!toolNames.includes('read_agent_task_record'), '生产注册表不得包含 read_agent_task_record');
assert.ok(!toolNames.includes('update_agent_task_record'), '生产注册表不得包含 update_agent_task_record');
assert.ok(toolNames.includes('apply_emevd_dsl') && toolNames.includes('read_emevd_event'));

await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);

console.log(JSON.stringify({
  ok: true,
  suite: 'test:agent-emevd-proof-gate',
  contract: 'production-tool-registry-native-read-proof-store',
  note: 'NativeReadProofStore is the production gate; createAgentTaskRecordGateway is not required',
  checks: [
    'without-proof-apply-emevd-dsl-fails-NATIVE_READ',
    'windowed-outline-read-does-not-pass-write-gate',
    'complete-native-dsl-full-source-mints-host-proof',
    'proof-passes-write-gate-to-writer-layer',
    'no-manual-task-record-gate-in-production-registry'
  ]
}, null, 2));
