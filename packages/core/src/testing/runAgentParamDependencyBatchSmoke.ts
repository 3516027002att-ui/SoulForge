/**
 * PARAM discovery/read dependency scheduling smoke.
 *
 * The fixture deliberately drives the production agent loop, bridge, and
 * ToolRegistry together.  It does not assert that a candidate is native
 * authority; the in-memory task record only models the existing search-ticket
 * and native-read gate so the ordering contract is observable.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import {
  ToolRegistry,
  type AgentTaskRecordGateway,
  type ToolContext
} from '../ai/toolRegistry.js';
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
  recordSearchCompleted: number;
  readGateChecks: number;
  readStarted: number;
  searchFieldStarted: number;
  activeReads: number;
  maxConcurrentReads: number;
  authorizedTables: Set<string>;
};

type FixtureOptions = {
  searchResult?: ParamRow[];
  searchWait?: Promise<void>;
  readWait?: Promise<void>;
  initialAuthorizedTables?: string[];
  onSearchRecorded?: () => void;
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

const row: ParamRow = {
  paramName: 'NpcParam',
  rowId: 50800000,
  rowName: 'fixture boss',
  fields: [{ fieldId: 'hp', value: 100 }],
  sourceUri: 'file://fixture/gameparam.parambnd.dcx',
  sourceHash: 'fixture-native-hash',
  sourceRevision: 1
};

function normalizeTable(value: string): string {
  const compact = value
    .replace(/\\/gu, '/')
    .split('/')
    .pop()!
    .replace(/\.param$/iu, '')
    .replace(/[^a-z0-9]/giu, '')
    .toLocaleLowerCase();
  return compact.endsWith('st') && compact.length > 2 ? compact.slice(0, -2) : compact;
}

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

function createTaskRecord(state: FixtureState, options: FixtureOptions): AgentTaskRecordGateway {
  let searchSequence = 0;
  const snapshot = () => ({ path: 'fixture://task-record', entries: [], updatedAt: null });
  return {
    read: async () => snapshot(),
    beforeSearch: async () => ({ ok: true as const }),
    recordSearch: async ({ toolName, query, result }) => {
      state.events.push('record-search');
      state.recordSearchCompleted += 1;
      const rows = Array.isArray(result) ? result : [];
      for (const value of rows) {
        const item = recordOf(value);
        // A native type (for example ATK_PARAM_ST) is not a physical entry.
        // Prefer the exact entryName when the Bridge returned it, and only use
        // paramName for legacy rows that have no finer-grained identity.
        const exactTable = typeof item.entryName === 'string' && item.entryName.trim() !== ''
          ? item.entryName
          : item.paramName;
        if (typeof exactTable === 'string') state.authorizedTables.add(normalizeTable(exactTable));
      }
      options.onSearchRecorded?.();
      searchSequence += 1;
      return { searchId: `fixture-search-${searchSequence}`, toolName, query };
    },
    update: async () => snapshot(),
    recordNativeParamRead: async () => snapshot(),
    assertMutationTarget: async () => ({ ok: true as const, reservationId: 'fixture-reservation' }),
    finalizeMutation: async () => undefined,
    releaseMutationReservation: async () => undefined,
    releaseMutationCount: async () => ({ ok: true as const, released: 0, snapshot: snapshot() }),
    assertParamReadTarget: async (input) => {
      state.events.push('read-gate');
      state.readGateChecks += 1;
      const table = recordOf(input).table;
      if (typeof table === 'string' && state.authorizedTables.has(normalizeTable(table))) {
        return { ok: true as const };
      }
      return {
        ok: false as const,
        code: 'TASK_RECORD_PARAM_TARGET_UNVERIFIED',
        message: 'fixture gate: PARAM table has no matching search row receipt.'
      };
    }
  };
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
    recordSearchCompleted: 0,
    readGateChecks: 0,
    readStarted: 0,
    searchFieldStarted: 0,
    activeReads: 0,
    maxConcurrentReads: 0,
    authorizedTables: new Set((options.initialAuthorizedTables ?? []).map(normalizeTable))
  };
  const registry = new ToolRegistry();
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
    inputSchema: { table: 'string', rowIds: 'array', fieldIds: 'array' },
    run: async (input) => {
      state.events.push('read-start');
      state.readStarted += 1;
      state.activeReads += 1;
      state.maxConcurrentReads = Math.max(state.maxConcurrentReads, state.activeReads);
      try {
        await (options.readWait ?? resolved());
        return {
          ok: true,
          data: {
            table: recordOf(input).table,
            rows: [row]
          }
        };
      } finally {
        state.activeReads -= 1;
        state.events.push('read-end');
      }
    }
  });
  const taskRecord = createTaskRecord(state, options);
  return {
    registry,
    context: {
      workspaceIndex: null,
      taskRecord,
      requireTaskRecord: true,
      mode: 'normal'
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
    assert.ok(fixture.state.events.indexOf('record-search') < fixture.state.events.indexOf('read-gate'));
    assert.equal(fixture.state.readStarted, 1);
  } finally {
    releaseSearch();
    await running.catch(() => undefined);
  }
}

async function testEmptyAndWrongSearchCannotAuthorize(): Promise<void> {
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
    assert.equal(result.finishReason, 'stop', `${label}: gate refusal should return to model`);
    assert.equal(fixture.state.searchCompleted, 1);
    assert.equal(fixture.state.recordSearchCompleted, 1);
    assert.equal(fixture.state.readStarted, 0, `${label}: failed read gate must not enter native handler`);
    assert.equal(fixture.state.readGateChecks, 1);
    assert.ok(fixture.state.events.indexOf('record-search') < fixture.state.events.indexOf('read-gate'));
    const readAudit = result.audit.toolCalls.find((item) => item.name === 'read_param_fields');
    assert.equal(readAudit?.ok, false, `${label}: read must be rejected by the task record`);
    assert.equal(readAudit?.code, 'TASK_RECORD_PARAM_TARGET_UNVERIFIED');
  }
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
    assert.ok(fixture.state.events.indexOf('record-search') < fixture.state.events.indexOf('read-gate'));
    assert.deepEqual(result.audit.toolCalls.map((item) => item.name), [
      'search_param_rows', 'search_param_fields', 'read_param_fields'
    ]);
  } finally {
    releaseSearch();
    await running.catch(() => undefined);
  }
}

async function testPreciseEntryTicketDoesNotWidenType(): Promise<void> {
  const attackRow: ParamRow = {
    ...row,
    paramName: 'ATK_PARAM_ST',
    entryName: 'AtkParam_Npc.param',
    rowId: 71000100
  };
  const fixture = createFixture({ searchResult: [attackRow] });
  const npcRead = await runFixture(fixture, [
    call('search-atk', 'search_param_rows', { query: 'attack', paramNames: ['ATK_PARAM_ST'] }),
    call('read-atk-npc', 'read_param_fields', {
      table: 'AtkParam_Npc', rowIds: [71000100], fieldIds: ['attackPower']
    })
  ]);
  assert.equal(npcRead.finishReason, 'stop');
  assert.equal(fixture.state.readStarted, 1, 'exact AtkParam_Npc entry should be readable');

  const pcRead = await runFixture(fixture, [
    call('read-atk-pc', 'read_param_fields', {
      table: 'AtkParam_Pc', rowIds: [71000100], fieldIds: ['attackPower']
    })
  ]);
  assert.equal(pcRead.finishReason, 'stop');
  assert.equal(fixture.state.readStarted, 1, 'shared ATK_PARAM_ST type must not authorize AtkParam_Pc');
  const pcAudit = pcRead.audit.toolCalls.find((item) => item.name === 'read_param_fields');
  assert.equal(pcAudit?.ok, false);
  assert.equal(pcAudit?.code, 'TASK_RECORD_PARAM_TARGET_UNVERIFIED');
}

async function testIndependentReadsOverlap(): Promise<void> {
  let releaseReads!: () => void;
  const readWait = new Promise<void>((resolve) => { releaseReads = resolve; });
  const fixture = createFixture({ readWait, initialAuthorizedTables: ['NpcParam'] });
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
  const fixture = createFixture({ onSearchRecorded: () => controller.abort('fixture-cancel') });
  const result = await runFixture(fixture, [
    call('search', 'search_param_rows', { query: 'boss', paramNames: ['NpcParam'] }),
    call('read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] })
  ], controller.signal);
  assert.equal(result.finishReason, 'cancelled');
  assert.equal(fixture.state.recordSearchCompleted, 1);
  assert.equal(fixture.state.readStarted, 0, 'cancellation must not launch the dependent read batch');
  assert.deepEqual(result.audit.toolCalls.map((item) => item.name), ['search_param_rows']);
}

export async function runAgentParamDependencyBatchSmoke(): Promise<void> {
  await testDeferredSearchBarrier();
  await testEmptyAndWrongSearchCannotAuthorize();
  await testSearchFieldsAlsoWaitsForRows();
  await testPreciseEntryTicketDoesNotWidenType();
  await testIndependentReadsOverlap();
  await testAbortStopsDependentBatch();
  console.log(JSON.stringify({
    ok: true,
    checks: 6,
    message: 'PARAM discovery/read dependency batch smoke passed'
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentParamDependencyBatchSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
