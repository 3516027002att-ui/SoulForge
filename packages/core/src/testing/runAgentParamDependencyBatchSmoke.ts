/**
 * PARAM discovery/read scheduling + proof-boundary write smoke (T12 migration).
 *
 * The fixture drives the production agent loop, bridge, and ToolRegistry
 * together. The manual ledger gate is gone: reads never require a search
 * ticket, while writes must satisfy the automatic native-read proof boundary
 * (T09) built from the ACTUAL delivered read result. The loop's PARAM
 * dependency barrier (a row-search must settle before dependent PARAM
 * consumers start) is a scheduler contract and stays observable here.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import {
  ToolRegistry,
  type ToolContext
} from '../ai/toolRegistry.js';
import { CoreToolSession } from '../runtime/coreToolSession.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type {
  ModelServiceAdapter,
  ToolCall
} from '../model-services/types.js';

type ParamRow = {
  paramName: string;
  entryName?: string;
  rowId: number;
  rowName: string;
  fields: Array<{ fieldId: string; value: number }>;
  sourceUri: string;
  sourceHash: string;
  sourceRevision: number;
};

type FixtureState = {
  events: string[];
  searchStarted: number;
  searchCompleted: number;
  readStarted: number;
  searchFieldStarted: number;
  activeReads: number;
  maxConcurrentReads: number;
  writerCalls: number;
};

type FixtureOptions = {
  searchResult?: ParamRow[];
  searchWait?: Promise<void>;
  readWait?: Promise<void>;
  onSearchCompleted?: () => void;
};

const config = {
  id: 'param-dependency-batch-fixture',
  displayName: 'PARAM dependency batch fixture',
  protocol: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:9',
  model: 'fixture',
  hasCredential: false,
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z'
};
const fixtureContainerPath = join(process.cwd(), 'package.json');

const row: ParamRow = {
  paramName: 'NpcParam',
  rowId: 50800000,
  rowName: 'fixture boss',
  fields: [{ fieldId: 'hp', value: 100 }],
  sourceUri: 'file://fixture/gameparam.parambnd.dcx',
  sourceHash: 'fixture-native-hash',
  sourceRevision: 1
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, name, argumentsJson: JSON.stringify(input) };
}

function resolved(): Promise<void> {
  return Promise.resolve();
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('PARAM dependency fixture timed out waiting for state transition'));
        return;
      }
      setTimeout(check, 1);
    };
    check();
  });
}

function createFixture(options: FixtureOptions = {}): {
  registry: ToolRegistry;
  context: ToolContext;
  state: FixtureState;
} {
  const state: FixtureState = {
    events: [],
    searchStarted: 0,
    searchCompleted: 0,
    readStarted: 0,
    searchFieldStarted: 0,
    activeReads: 0,
    maxConcurrentReads: 0,
    writerCalls: 0
  };
  const registry = new ToolRegistry();
  // Keep the fixture host-shaped: the automatic proof promotion needs a
  // stable workspace identity in addition to the proof store.  Production
  // hosts obtain both from CoreToolSession; a null workspace index alone is
  // intentionally insufficient for minting a write receipt.
  const coreSession = new CoreToolSession({
    principal: 'fixture-run',
    workspaceId: 'workspace://param-dependency-batch'
  });
  const session = {
    meta: { workspaceId: coreSession.workspaceId, game: 'sekiro' },
    layers: { overlayRoot: process.cwd() }
  } as unknown as NonNullable<ToolContext['session']>;
  registry.register({
    name: 'search_param_rows',
    description: 'fixture PARAM row search',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?', paramNames: 'array?' },
    run: async () => {
      state.events.push('search-start');
      state.searchStarted += 1;
      await (options.searchWait ?? resolved());
      state.events.push('search-end');
      state.searchCompleted += 1;
      options.onSearchCompleted?.();
      return { ok: true, data: options.searchResult ?? [row] };
    }
  });
  registry.register({
    name: 'search_param_fields',
    description: 'fixture PARAM field search',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { table: 'string', rowIds: 'array', query: 'string', limit: 'number?' },
    run: async (input) => {
      state.events.push('search-fields-start');
      state.searchFieldStarted += 1;
      return {
        ok: true,
        data: {
          table: recordOf(input).table,
          rowId: 50800000,
          fields: [{ fieldId: 'hp', name: 'HP' }]
        }
      };
    }
  });
  registry.register({
    name: 'read_param_fields',
    description: 'fixture native PARAM read',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { table: 'string', rowIds: 'array', fieldIds: 'array', containerPath: 'string?' },
    run: async (input) => {
      state.events.push('read-start');
      state.readStarted += 1;
      state.activeReads += 1;
      state.maxConcurrentReads = Math.max(state.maxConcurrentReads, state.activeReads);
      try {
        await (options.readWait ?? resolved());
        const value = recordOf(input);
        const table = typeof value.table === 'string' ? value.table : '';
        const rowIds = Array.isArray(value.rowIds) ? value.rowIds.filter((id): id is number => typeof id === 'number') : [];
        const fieldIds = Array.isArray(value.fieldIds) ? value.fieldIds.filter((id): id is string => typeof id === 'string') : [];
        // Production-shaped field payload: the bridge mints delivered-read
        // proofs from exactly this `fields` array shape.
        const fields = rowIds.flatMap((rowId) => fieldIds.map((fieldId) => ({
          table,
          rowId,
          fieldId,
          value: 100,
          outerFileHash: 'fixture-outer-hash'
        })));
        return { ok: true, data: { table, containerPath: fixtureContainerPath, fields } };
      } finally {
        state.activeReads -= 1;
        state.events.push('read-end');
      }
    }
  });
  registry.register({
    name: 'mutate_param_fields',
    description: 'fixture PARAM write (counts writer invocations)',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { edits: 'array', containerPath: 'string?' },
    run: async () => {
      state.writerCalls += 1;
      return { ok: true, state: 'committed' as const, data: { opId: 'fixture-op' } };
    }
  });
  return {
    registry,
    context: {
      workspaceIndex: null,
      coreSession,
      mode: 'normal',
      session,
      proofPrincipal: 'fixture-run'
    },
    state
  };
}

function adapterFor(toolCalls: ToolCall[]): ModelServiceAdapter {
  let round = 0;
  return {
    protocol: 'openai-compatible',
    async complete() {
      round += 1;
      if (round === 1) {
        return {
          message: { role: 'assistant', content: '', toolCalls },
          finishReason: 'tool_use',
          diagnostics: []
        };
      }
      return {
        message: { role: 'assistant', content: 'fixture complete' },
        finishReason: 'stop',
        diagnostics: []
      };
    },
    async *stream() {
      throw new Error('streaming is not used by this fixture');
    },
    async listModels() {
      return { ok: true, models: [] };
    }
  };
}

async function runFixture(
  fixture: ReturnType<typeof createFixture>,
  toolCalls: ToolCall[],
  signal?: AbortSignal
) {
  const bridge = createAgentToolBridge({ registry: fixture.registry, context: fixture.context });
  return runAgentToolLoop(adapterFor(toolCalls), {
    config,
    apiKey: 'fixture-key',
    taskQuery: '验证 PARAM 发现与原生读取顺序',
    messages: [{ role: 'user', content: '验证 PARAM 发现与原生读取顺序' }],
    tools: bridge.tools,
    permissionMode: 'normal',
    executeTool: bridge.executeTool,
    maxSteps: 4,
    ...(signal ? { signal } : {})
  });
}

async function testDeferredSearchBarrier(): Promise<void> {
  let releaseSearch!: () => void;
  const searchWait = new Promise<void>((resolve) => { releaseSearch = resolve; });
  const fixture = createFixture({ searchWait });
  const running = runFixture(fixture, [
    call('search', 'search_param_rows', { query: 'boss', paramNames: ['NpcParam'] }),
    call('read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] })
  ]);
  try {
    await waitFor(() => fixture.state.searchStarted === 1);
    assert.equal(fixture.state.readStarted, 0, 'dependent read must not start while search is pending');
    assert.deepEqual(fixture.state.events, ['search-start']);
    releaseSearch();
    const result = await running;
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.audit.toolCalls.map((item) => item.name), ['search_param_rows', 'read_param_fields']);
    assert.ok(fixture.state.events.indexOf('search-end') < fixture.state.events.indexOf('read-start'));
    assert.equal(fixture.state.readStarted, 1);
  } finally {
    releaseSearch();
    await running.catch(() => undefined);
  }
}

async function testLedgerlessReadNeedsNoTicket(): Promise<void> {
  // T12: a plain native read no longer requires any search ticket or ledger
  // entry, even when the preceding search returned nothing usable.
  const cases: Array<[string, ParamRow[]]> = [
    ['empty search', [] as ParamRow[]],
    ['wrong table search', [{ ...row, paramName: 'OtherParam' }]]
  ];
  for (const [label, searchResult] of cases) {
    const fixture = createFixture({ searchResult });
    const result = await runFixture(fixture, [
      call(`search-${label}`, 'search_param_rows', { query: 'boss', paramNames: ['NpcParam'] }),
      call(`read-${label}`, 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] })
    ]);
    assert.equal(result.finishReason, 'stop', `${label}: read must not be gated by the removed ledger`);
    assert.equal(fixture.state.readStarted, 1, `${label}: read must reach the native handler without a ticket`);
    const readAudit = result.audit.toolCalls.find((item) => item.name === 'read_param_fields');
    assert.equal(readAudit?.ok, true, `${label}: ledgerless read must succeed`);
    assert.ok(!result.audit.toolCalls.some((item) => item.name === 'update_agent_task_record'
      || item.name === 'read_agent_task_record'), '轨迹中不得出现台账工具');
  }
}

async function testWriteRequiresDeliveredReadProof(): Promise<void> {
  // Without a prior native read there is no proof: the writer must not run.
  const cold = createFixture();
  const coldResult = await runFixture(cold, [
    call('write-cold', 'mutate_param_fields', {
      edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 120 }],
      containerPath: fixtureContainerPath
    })
  ]);
  assert.equal(cold.state.writerCalls, 0, '未读取就写入不得进入 writer');
  const coldAudit = coldResult.audit.toolCalls.find((item) => item.name === 'mutate_param_fields');
  assert.equal(coldAudit?.ok, false);
  assert.equal(coldAudit?.code, 'NATIVE_READ_REQUIRED');

  // A delivered read of the same field mints the proof; the write then passes.
  const warm = createFixture();
  const warmResult = await runFixture(warm, [
    call('read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] }),
    call('write', 'mutate_param_fields', {
      edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 120 }],
      containerPath: fixtureContainerPath
    })
  ]);
  assert.equal(warmResult.finishReason, 'stop');
  assert.equal(warm.state.writerCalls, 1, '已读取字段的写入应通过证明边界');
  const writeAudit = warmResult.audit.toolCalls.find((item) => item.name === 'mutate_param_fields');
  assert.equal(writeAudit?.ok, true);
}

async function testSearchFieldsAlsoWaitsForRows(): Promise<void> {
  let releaseSearch!: () => void;
  const searchWait = new Promise<void>((resolve) => { releaseSearch = resolve; });
  const fixture = createFixture({ searchWait });
  const running = runFixture(fixture, [
    call('search', 'search_param_rows', { query: 'boss', paramNames: ['NpcParam'] }),
    call('fields', 'search_param_fields', { table: 'NpcParam', rowIds: [50800000], query: 'health' }),
    call('read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] })
  ]);
  try {
    await waitFor(() => fixture.state.searchStarted === 1);
    assert.equal(fixture.state.searchFieldStarted, 0);
    assert.equal(fixture.state.readStarted, 0);
    releaseSearch();
    const result = await running;
    assert.equal(result.finishReason, 'stop');
    assert.equal(fixture.state.searchFieldStarted, 1);
    assert.equal(fixture.state.readStarted, 1);
    assert.ok(fixture.state.events.indexOf('search-end') < fixture.state.events.indexOf('search-fields-start'));
    assert.deepEqual(result.audit.toolCalls.map((item) => item.name), [
      'search_param_rows', 'search_param_fields', 'read_param_fields'
    ]);
  } finally {
    releaseSearch();
    await running.catch(() => undefined);
  }
}

async function testProofDoesNotWidenPhysicalEntry(): Promise<void> {
  // A read of the physical entry AtkParam_Npc must not authorize a write to
  // the sibling AtkParam_Pc that shares the logical native type.
  const fixture = createFixture();
  const result = await runFixture(fixture, [
    call('read-npc', 'read_param_fields', {
      table: 'AtkParam_Npc', rowIds: [71000100], fieldIds: ['attackPower']
    }),
    call('write-pc', 'mutate_param_fields', {
      edits: [{ table: 'AtkParam_Pc', rowId: 71000100, fieldId: 'attackPower', value: 5 }],
      containerPath: fixtureContainerPath
    })
  ]);
  assert.equal(result.finishReason, 'stop');
  assert.equal(fixture.state.writerCalls, 0, 'shared ATK_PARAM_ST type must not authorize AtkParam_Pc');
  const pcAudit = result.audit.toolCalls.find((item) => item.name === 'mutate_param_fields');
  assert.equal(pcAudit?.ok, false);
  assert.equal(pcAudit?.code, 'NATIVE_READ_REQUIRED');
}

async function testIndependentReadsOverlap(): Promise<void> {
  let releaseReads!: () => void;
  const readWait = new Promise<void>((resolve) => { releaseReads = resolve; });
  const fixture = createFixture({ readWait });
  const running = runFixture(fixture, [
    call('read-a', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] }),
    call('read-b', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hpBarType'] })
  ]);
  try {
    await waitFor(() => fixture.state.readStarted === 2);
    assert.equal(fixture.state.maxConcurrentReads, 2, 'independent native reads should overlap');
    releaseReads();
    const result = await running;
    assert.equal(result.finishReason, 'stop');
    assert.deepEqual(result.audit.toolCalls.map((item) => item.name), ['read_param_fields', 'read_param_fields']);
  } finally {
    releaseReads();
    await running.catch(() => undefined);
  }
}

async function testAbortStopsDependentBatch(): Promise<void> {
  const controller = new AbortController();
  const fixture = createFixture({ onSearchCompleted: () => controller.abort('fixture-cancel') });
  const result = await runFixture(fixture, [
    call('search', 'search_param_rows', { query: 'boss', paramNames: ['NpcParam'] }),
    call('read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] })
  ], controller.signal);
  assert.equal(result.finishReason, 'cancelled');
  assert.equal(fixture.state.searchCompleted, 1);
  assert.equal(fixture.state.readStarted, 0, 'cancellation must not launch the dependent read batch');
  assert.deepEqual(result.audit.toolCalls.map((item) => item.name), ['search_param_rows']);
}

export async function runAgentParamDependencyBatchSmoke(): Promise<void> {
  await testDeferredSearchBarrier();
  await testLedgerlessReadNeedsNoTicket();
  await testWriteRequiresDeliveredReadProof();
  await testSearchFieldsAlsoWaitsForRows();
  await testProofDoesNotWidenPhysicalEntry();
  await testIndependentReadsOverlap();
  await testAbortStopsDependentBatch();
  console.log(JSON.stringify({
    ok: true,
    checks: 7,
    message: 'PARAM discovery/read scheduling + proof-boundary write smoke passed'
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentParamDependencyBatchSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
