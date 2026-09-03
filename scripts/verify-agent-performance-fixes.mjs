/**
 * Focused regression checks for the Agent/RAG/CPU fixes.  This is deliberately
 * offline: it exercises the production core loop and desktop task-record
 * gateway with deterministic adapters, without claiming native or provider
 * authority.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createContextBroker,
  runAgentToolLoop,
  upsertContextEvidenceSources
} from '../packages/core/dist/index.js';
import { createAgentTaskRecordGateway } from '../apps/desktop/src/main/agentTaskRecord.ts';

const config = {
  id: 'agent-performance-fix-smoke',
  displayName: 'offline smoke',
  protocol: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1',
  model: 'offline',
  hasCredential: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

function envelope(status, value, sourceRevision) {
  return JSON.stringify({
    ok: true,
    state: 'completed',
    data: { items: [{ table: 'NpcParam', rowId: 50800000, value }] },
    identifiers: ['table=NpcParam', 'rowId=50800000'],
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    evidence: { status }
  });
}

async function testEvidenceDedup() {
  const queue = [];
  const candidate = { kind: 'toolResult', uri: 'search_param_rows', text: envelope('candidate', 'candidate-value') };
  const nativeOld = { kind: 'toolResult', uri: 'read_param_fields', text: envelope('native-verified', 'native-old', 3) };
  const nativeNew = { kind: 'toolResult', uri: 'read_param_fields', text: envelope('native-verified', 'native-new', 4) };
  assert.equal(upsertContextEvidenceSources(queue, [candidate, nativeOld]), true);
  assert.equal(upsertContextEvidenceSources(queue, [candidate]), false, '重复 candidate 不应触发重装配');
  assert.equal(upsertContextEvidenceSources(queue, [nativeNew]), true, '更高 sourceRevision 的 native 应替换旧 native');
  const nativeWithoutRevision = { kind: 'toolResult', uri: 'read_param_fields', text: envelope('native-verified', 'unversioned-native') };
  assert.equal(
    upsertContextEvidenceSources(queue, [nativeWithoutRevision]),
    false,
    '无 sourceRevision 的 native 不能覆盖已有带 revision 的 native'
  );

  const broker = createContextBroker();
  const result = await broker.assemble(queue, { maxBytes: 8_000, maxEntries: 8, excerptLength: 8_000 });
  assert.equal(result.ok, true);
  assert.equal(queue.length, 1, '同一稳定 PARAM 身份只能保留一个 evidence');
  assert.match(result.context, /native-new/u);
  assert.doesNotMatch(result.context, /candidate-value|native-old|unversioned-native/u);

  const mutable = { kind: 'diagnostics', text: 'before-mutation' };
  const first = await broker.assemble([mutable], { maxBytes: 8_000, maxEntries: 8, excerptLength: 8_000, timeoutMs: 1_000 });
  assert.equal(first.ok, true);
  mutable.text = 'after-mutation';
  const second = await broker.assemble([mutable], { maxBytes: 8_000, maxEntries: 8, excerptLength: 8_000, timeoutMs: 1_000 });
  assert.equal(second.ok, true);
  assert.match(second.context, /after-mutation/u, 'source 内容变化后不得命中旧装配缓存');
  assert.doesNotMatch(second.context, /before-mutation/u);
}

async function testLoopSkipsDuplicateAssembly() {
  let modelCalls = 0;
  let assembleCalls = 0;
  const baseBroker = createContextBroker();
  const broker = {
    assemble: async (sources, options) => {
      assembleCalls += 1;
      return baseBroker.assemble(sources, options);
    }
  };
  const adapter = {
    protocol: 'openai-compatible',
    listModels: async () => ({ ok: true, models: [] }),
    complete: async () => {
      modelCalls += 1;
      if (modelCalls <= 3) {
        return {
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: `repeat-${modelCalls}`, name: 'repeat_read', argumentsJson: '{}' }]
          },
          finishReason: 'tool_use',
          diagnostics: []
        };
      }
      return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop', diagnostics: [] };
    }
  };
  const run = await runAgentToolLoop(adapter, {
    config,
    apiKey: 'offline-key',
    messages: [{ role: 'user', content: 'repeat evidence' }],
    tools: [{
      name: 'repeat_read',
      description: 'offline read',
      parametersJsonSchema: { type: 'object' },
      permissionLevel: 'read'
    }],
    permissionMode: 'normal',
    executeTool: async () => ({ ok: true, content: envelope('candidate', 'same') }),
    contextBroker: broker,
    contextBrokerOptions: { maxBytes: 8_000, maxEntries: 8, excerptLength: 8_000 },
    taskQuery: 'repeat evidence',
    ragSearch: {
      maxHits: 1,
      retrieve: async () => ({
        ok: true,
        query: 'repeat evidence',
        hits: [{
          score: 1,
          reasons: ['offline'],
          excerpt: 'cached rag evidence',
          chunk: {
            chunkId: 'chunk-1',
            workspaceId: 'workspace-1',
            sourceUri: 'fixture://evidence',
            symbolUri: 'fixture://evidence#1',
            family: 'file',
            title: 'fixture',
            body: 'cached rag evidence',
            numericIds: [],
            contentHash: 'hash-1'
          }
        }],
        retrievalMode: 'lexical',
        stats: { scanned: 1, matched: 1, expanded: 0, truncated: false }
      })
    },
    maxSteps: 4
  });
  assert.equal(run.finishReason, 'stop');
  assert.equal(modelCalls, 4);
  assert.equal(assembleCalls, 2, '同一 evidence 版本不应每轮重复 broker assemble');
  assert.equal(
    run.diagnostics.filter((diagnostic) => diagnostic.code === 'RAG_EVIDENCE_INJECTED').length,
    1,
    '同一上下文窗口不应重复注入 RAG'
  );
}

async function testCanonicalDenial() {
  let executed = false;
  let calls = 0;
  const adapter = {
    protocol: 'openai-compatible',
    listModels: async () => ({ ok: true, models: [] }),
    complete: async () => {
      calls += 1;
      return calls === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'unknown-call', name: 'not_registered', argumentsJson: '{}' }]
            },
            finishReason: 'tool_use',
            diagnostics: []
          }
        : { message: { role: 'assistant', content: 'blocked' }, finishReason: 'stop', diagnostics: [] };
    }
  };
  const run = await runAgentToolLoop(adapter, {
    config,
    apiKey: 'offline-key',
    messages: [{ role: 'user', content: 'denial' }],
    tools: [],
    permissionMode: 'normal',
    executeTool: async () => {
      executed = true;
      return { ok: true, content: 'must not execute' };
    },
    maxSteps: 2
  });
  const denial = run.messages.find((message) => message.role === 'tool');
  assert.equal(executed, false);
  assert.ok(denial);
  const parsed = JSON.parse(denial.content);
  assert.deepEqual(
    { ok: parsed.ok, state: parsed.state, code: parsed.error?.code },
    { ok: false, state: 'failed', code: 'AGENT_TOOL_NOT_REGISTERED' }
  );
}

async function testCanonicalExecutedFailure() {
  let calls = 0;
  const adapter = {
    protocol: 'openai-compatible',
    listModels: async () => ({ ok: true, models: [] }),
    complete: async () => {
      calls += 1;
      return calls === 1
        ? {
            message: {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'legacy-failure', name: 'failing_read', argumentsJson: '{}' }]
            },
            finishReason: 'tool_use',
            diagnostics: []
          }
        : { message: { role: 'assistant', content: 'partial report' }, finishReason: 'stop', diagnostics: [] };
    }
  };
  const run = await runAgentToolLoop(adapter, {
    config,
    apiKey: 'offline-key',
    messages: [{ role: 'user', content: 'legacy failure' }],
    tools: [{
      name: 'failing_read',
      description: 'offline read',
      parametersJsonSchema: { type: 'object' },
      permissionLevel: 'read'
    }],
    permissionMode: 'normal',
    executeTool: async () => ({
      ok: false,
      content: JSON.stringify({
        ok: false,
        state: 'completed',
        error: { code: 'LEGACY_FAILURE', message: 'legacy error' },
        payload: 'should-not-enter-the-failure-envelope'.repeat(1_000)
      })
    }),
    maxSteps: 2
  });
  const failure = run.messages.find((message) => message.role === 'tool');
  assert.ok(failure);
  const parsed = JSON.parse(failure.content);
  assert.deepEqual(
    { ok: parsed.ok, state: parsed.state, code: parsed.error?.code, payload: parsed.payload },
    { ok: false, state: 'failed', code: 'LEGACY_FAILURE', payload: undefined }
  );
  assert.equal(run.audit.toolCalls[0].code, 'LEGACY_FAILURE');
}

async function testNonFiniteStepBudgetIsBounded() {
  let modelCalls = 0;
  const adapter = {
    protocol: 'openai-compatible',
    listModels: async () => ({ ok: true, models: [] }),
    complete: async () => ({
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `step-${modelCalls + 1}`, name: 'bounded_read', argumentsJson: '{}' }]
      },
      finishReason: 'tool_use',
      diagnostics: []
    })
  };
  const run = await runAgentToolLoop(adapter, {
    config,
    apiKey: 'offline-key',
    messages: [{ role: 'user', content: 'bounded' }],
    tools: [{
      name: 'bounded_read',
      description: 'offline read',
      parametersJsonSchema: { type: 'object' },
      permissionLevel: 'read'
    }],
    permissionMode: 'normal',
    executeTool: async () => {
      modelCalls += 1;
      return { ok: true, content: 'bounded result' };
    },
    maxSteps: Number.NaN
  });
  assert.equal(run.steps, 200, '非有限 maxSteps 必须回退到 200 步并且不会无限运行');
  assert.equal(run.finishReason, 'partial');
}

async function testTaskRecordBatchBoundary() {
  const root = await mkdtemp(join(tmpdir(), 'soulforge-agent-performance-'));
  try {
    const gateway = createAgentTaskRecordGateway(root, 'batch-smoke');
    await gateway.read();
    await gateway.update({ objectName: '鬼刑部', propertyKey: 'target', value: '待定位', kind: 'target' });
    const ticket = await gateway.recordSearch({
      toolName: 'search_param_rows',
      query: '鬼刑部',
      result: { items: [{ table: 'NpcParam', rowId: 50800000 }] }
    });
    await Promise.all(Array.from({ length: 8 }, () => gateway.update({
      objectName: '鬼刑部',
      propertyKey: 'NpcParam',
      value: 'rowId=50800000',
      evidence: ['NpcParam#50800000 fieldId=teamType'],
      searchId: ticket.searchId,
      mutationBudget: 1
    })));
    assert.equal((await gateway.assertParamReadTarget({ table: 'NpcParam', rowIds: [50800000] })).ok, true);
    assert.equal((await gateway.assertParamReadTarget({ table: 'NpcParam', rowIds: [3504] })).ok, false);
    const snapshot = await gateway.read();
    assert.ok(snapshot.entries.some((entry) => entry.propertyKey === 'NpcParam'));
    const persisted = await readFile(join(root, 'batch-smoke.md'), 'utf8');
    assert.match(persisted, new RegExp(ticket.searchId, 'u'));
    assert.match(persisted, /rowId=50800000/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await testEvidenceDedup();
await testLoopSkipsDuplicateAssembly();
await testCanonicalDenial();
await testCanonicalExecutedFailure();
await testNonFiniteStepBudgetIsBounded();
await testTaskRecordBatchBoundary();
console.log('agent performance fixes smoke passed');
