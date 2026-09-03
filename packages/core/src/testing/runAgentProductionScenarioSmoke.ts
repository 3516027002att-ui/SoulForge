/**
 * 默认生产 ToolRegistry 的全链路隔离 smoke。
 *
 * 这不是给某个假工具注册表做的 happy path：使用默认注册表和真实
 * createAgentToolBridge / runAgentToolLoop，覆盖发现、语义分析、提案、
 * 校验、审批、Patch Engine 提交、回退和最终汇报。原生格式读取在本测试
 * 中只使用无 session 的结构化空结果，避免把合成样本冒充 native authority；
 * 文件写入则使用真实临时工作区的普通文本 Patch Engine 路径。
 *
 * Agent 运行明确禁止长期记忆写入。所有记忆断言都在进程内的
 * InMemoryMemoryStore 上完成，测试结束由 withSmokeWorkspace 清理临时目录。
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  EventExport,
  IndexedFile,
  MapExport,
  MsgExport,
  ParamExport,
  PatchProposal,
  ResourceKind,
  TaeExport
} from '@soulforge/shared';
import { createAgentToolBridge } from '../ai/agentToolBridge.js';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { InMemoryMemoryStore } from '../memory/memoryStore.js';
import { runAgentToolLoop } from '../model-services/agentLoop.js';
import type {
  AgentRunResult,
  ChatMessage,
  ModelCompleteRequest,
  ModelCompleteResult,
  ModelServiceAdapter,
  ModelServiceConfig,
  StreamEvent,
  ToolCall
} from '../model-services/types.js';
import { MemoryOperationLogStore } from '../patch/operationLog.js';
import { createConfirmationReceipt } from '../patch/writerContract.js';
import { openWorkspaceSession } from '../workspace/workspaceSession.js';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';

const TASK_QUERY = '把鬼刑部设置成精英怪，血条设置为2，出场时地上随机落雷5秒，不攻击到狼，击杀后掉落义父的铃铛';

const REQUIRED_TOOL_NAMES = [
  'workspace_stats',
  'retrieve_evidence',
  'search_resources',
  'search_events',
  'search_event_reference',
  'search_map_entities',
  'search_tae_events',
  'search_param_rows',
  'search_param_fields',
  'search_text_entries',
  'lookup_text_id',
  'find_text_references',
  'explain_text_entry',
  'find_references',
  'explain_event',
  'propose_text_patch',
  'propose_plaintext_script_edit',
  'validate_patch',
  'build_patch_graph',
  'assess_edit_risk',
  'read_param_fields',
  'mutate_param_fields',
  'read_fmg_entries',
  'mutate_fmg_entries',
  'read_emevd_outline',
  'apply_emevd_dsl',
  'read_tae_events',
  'mutate_tae_event_times',
  'read_msb_parts',
  'mutate_msb_part_transform',
  'query_map_objects',
  'inspect_map_object',
  'batch_transform_map_objects',
  'export_map_for_blender',
  'import_map_from_blender',
  'commit_patch',
  'list_operations',
  'rollback_operation',
  'read_memory',
  'write_memory',
  'list_memories',
  'switch_mode'
] as const;

interface ScenarioRound {
  text?: string;
  toolCalls?: ToolCall[];
}

class ScenarioAdapter implements ModelServiceAdapter {
  readonly protocol = 'openai-compatible' as const;
  readonly requests: ModelCompleteRequest[] = [];
  private roundIndex = 0;

  constructor(private readonly rounds: readonly ScenarioRound[]) {}

  async complete(_request: ModelCompleteRequest): Promise<ModelCompleteResult> {
    throw new Error('PRODUCTION_SCENARIO_EXPECTED_STREAM: smoke must exercise streaming adapter path.');
  }

  async *stream(request: ModelCompleteRequest): AsyncGenerator<StreamEvent, void, undefined> {
    this.requests.push({
      ...request,
      messages: request.messages.map((message) => ({ ...message }))
    });
    const round = this.rounds[this.roundIndex] ?? { text: '测试脚本未提供下一轮响应。' };
    this.roundIndex += 1;
    if (round.text) {
      // 分两段发出，验证 renderer/main 所依赖的增量消息路径，而不是只验证
      // 最终 completion 一次性返回。
      const pivot = Math.max(1, Math.floor(round.text.length / 2));
      yield { type: 'thinking-delta', text: `scenario-step-${this.roundIndex}` };
      yield { type: 'text-delta', text: round.text.slice(0, pivot) };
      yield { type: 'text-delta', text: round.text.slice(pivot) };
    }
    for (const toolCall of round.toolCalls ?? []) {
      yield { type: 'tool-call', toolCall };
    }
    yield {
      type: 'usage',
      inputTokens: 100 + this.roundIndex,
      outputTokens: Math.max(1, (round.text?.length ?? 0) + (round.toolCalls?.length ?? 0))
    };
    yield {
      type: 'message-stop',
      finishReason: (round.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'stop'
    };
  }

  async listModels(): Promise<{ ok: true; models: Array<{ id: string }> }> {
    return { ok: true, models: [{ id: 'scenario-model' }] };
  }
}

function call(id: string, name: string, input: unknown = {}): ToolCall {
  return { id, name, argumentsJson: JSON.stringify(input) };
}

function makeConfig(): ModelServiceConfig {
  const now = new Date().toISOString();
  return {
    id: 'production-scenario-service',
    displayName: 'production scenario fixture',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9',
    model: 'scenario-model',
    hasCredential: true,
    createdAt: now,
    updatedAt: now
  };
}

function makeFile(
  workspaceId: string,
  sourceUri: string,
  sourcePath: string,
  resourceKind: ResourceKind,
  formatKind: IndexedFile['formatKind'],
  compoundExtension: string
): IndexedFile {
  const extension = sourcePath.includes('.')
    ? `.${sourcePath.split('.').pop() ?? ''}`
    : '';
  return {
    id: sourceUri,
    workspaceId,
    sourceUri,
    sourcePath,
    absolutePath: sourcePath,
    relativePath: sourcePath,
    game: 'sekiro',
    resourceKind,
    extension,
    compoundExtension,
    formatKind,
    formatLabel: formatKind.toUpperCase(),
    size: 256,
    mtimeMs: 1,
    sha256: `${resourceKind}-scenario-v1`,
    parseStatus: 'partial',
    diagnostics: []
  };
}

function seedIndex(workspaceId: string): WorkspaceIndex {
  const index = new WorkspaceIndex(workspaceId);
  const eventSource = 'file://synthetic/event/m10_00_00_00.emevd.dcx';
  const mapSource = 'file://synthetic/map/m10_00_00_00.msb.dcx';
  const paramSource = 'file://synthetic/param/gameparam.parambnd.dcx';
  const msgSource = 'file://synthetic/msg/zhocn/item.msgbnd.dcx';
  const actionSource = 'file://synthetic/action/c0000.anibnd.dcx';
  index.setFiles([
    makeFile(workspaceId, eventSource, 'event/m10_00_00_00.emevd.dcx', 'event', 'emevd', '.emevd.dcx'),
    makeFile(workspaceId, mapSource, 'map/m10_00_00_00.msb.dcx', 'map', 'msb', '.msb.dcx'),
    makeFile(workspaceId, paramSource, 'param/gameparam.parambnd.dcx', 'param', 'param', '.parambnd.dcx'),
    makeFile(workspaceId, msgSource, 'msg/zhocn/item.msgbnd.dcx', 'msg', 'fmg', '.msgbnd.dcx'),
    makeFile(workspaceId, actionSource, 'action/c0000.anibnd.dcx', 'action', 'bnd', '.anibnd.dcx'),
    makeFile(workspaceId, 'file://synthetic/script/goal_list.lua', 'script/goal_list.lua', 'script', 'lua', '.lua')
  ]);

  const event: EventExport = {
    mapId: 'm10_00_00_00',
    sourceHash: 'event-scenario-v1',
    sourceRevision: 1,
    events: [{
      uri: `${eventSource}#event/1000`,
      sourceUri: eventSource,
      mapId: 'm10_00_00_00',
      eventId: 1000,
      name: '鬼刑部登场与击杀奖励',
      sourceHash: 'event-scenario-v1',
      sourceRevision: 1,
      instructions: [
        {
          uri: `${eventSource}#event/1000/instruction/0`,
          index: 0,
          name: 'SetEventFlag',
          args: [{ name: '鬼刑部实体', value: 50800000, role: 'entityId' }]
        },
        {
          uri: `${eventSource}#event/1000/instruction/1`,
          index: 1,
          name: 'CreateAssetFollowup',
          args: [{ name: '击杀掉落', value: 90032, role: 'paramId' }]
        }
      ]
    }]
  };
  const map: MapExport = {
    mapId: 'm10_00_00_00',
    sourceHash: 'map-scenario-v1',
    sourceRevision: 1,
    entities: [{
      uri: `${mapSource}#part/鬼刑部`,
      sourceUri: mapSource,
      mapId: 'm10_00_00_00',
      entityId: 50800000,
      name: '鬼刑部',
      kind: 'character',
      model: 'c0000',
      sourceHash: 'map-scenario-v1',
      sourceRevision: 1
    }],
    regions: []
  };
  const param: ParamExport = {
    paramName: 'NpcParam',
    sourceHash: 'param-scenario-v1',
    sourceRevision: 1,
    rows: [{
      uri: `${paramSource}#NpcParam/50800000`,
      sourceUri: paramSource,
      paramName: 'NpcParam',
      rowId: 50800000,
      rowName: '鬼庭刑部雅孝',
      sourceHash: 'param-scenario-v1',
      sourceRevision: 1,
      fields: [
        { fieldId: 'isBoss', name: 'isBoss', description: '精英/首领标记', value: false },
        { fieldId: 'hp', name: 'hp', description: '最大生命值', value: 1 }
      ]
    }]
  };
  const msg: MsgExport = {
    category: 'zhocn',
    sourceHash: 'msg-scenario-v1',
    sourceRevision: 1,
    entries: [{
      uri: `${msgSource}#zhocn/902012`,
      sourceUri: msgSource,
      category: 'zhocn',
      textId: 902012,
      text: '鬼庭刑部雅孝',
      confidence: 'high',
      sourceHash: 'msg-scenario-v1',
      sourceRevision: 1
    }, {
      uri: `${msgSource}#zhocn/90032`,
      sourceUri: msgSource,
      category: 'zhocn',
      textId: 90032,
      text: '义父的铃铛',
      confidence: 'high',
      sourceHash: 'msg-scenario-v1',
      sourceRevision: 1
    }]
  };
  const tae: TaeExport = {
    chrId: 'c0000',
    sourceUri: actionSource,
    sourceHash: 'action-scenario-v1',
    sourceRevision: 1,
    animations: [{
      animId: 200,
      code: 'A0200',
      events: [{
        uri: `${actionSource}#A0200/e0`,
        index: 0,
        eventTypeId: 128,
        typeName: 'PlaySound_General',
        startTime: 0,
        endTime: 1,
        startFrame: 0,
        endFrame: 30,
        sourceHash: 'action-scenario-v1',
        sourceRevision: 1,
        fields: [{ name: 'SoundID', value: 90032 }]
      }]
    }]
  };
  index.upsertEventExport(event);
  index.upsertMapExport(map);
  index.upsertParamExport(param);
  index.upsertMsgExport(msg);
  index.upsertTaeExport(tae);
  index.rebuildReferences();
  return index;
}

function parseJson(content: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(content);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), '工具结果必须是 JSON 对象。');
  return parsed as Record<string, unknown>;
}

function extractProposal(result: { ok: boolean; data?: unknown }): PatchProposal {
  assert.equal(result.ok, true, `提案生成失败：${JSON.stringify(result)}`);
  assert.ok(result.data && typeof result.data === 'object', '提案工具必须返回对象。');
  return result.data as PatchProposal;
}

async function runScenario(root: string): Promise<{
  toolCount: number;
  loopSteps: number;
  parallelPeak: number;
  approvalTools: string[];
  finalAnswer: string;
}> {
  const overlayRoot = join(root, 'overlay');
  const backupBaseDir = join(root, 'backups');
  const recoveryDir = join(root, 'recovery');
  await mkdir(overlayRoot, { recursive: true });
  await mkdir(backupBaseDir, { recursive: true });
  await mkdir(recoveryDir, { recursive: true });

  const targetPath = join(overlayRoot, 'scenario-result.txt');
  await writeFile(targetPath, 'before\n', 'utf8');
  const session = await openWorkspaceSession({
    overlayRoot,
    game: 'sekiro'
  });
  const index = seedIndex(session.meta.workspaceId);
  const memoryStore = new InMemoryMemoryStore({
    version: 1,
    entries: [{
      id: 'memory-scenario-1',
      topic: 'character-name-resolution',
      summary: '正式名称应通过 MSG 与 NpcParam 的原生备注交叉确认。',
      details: '鬼刑部对应鬼庭刑部雅孝；这条记忆只用于启动检索，不取代本轮 native reread。',
      tags: ['npc', 'msg'],
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    }]
  });
  const operationLogStore = new MemoryOperationLogStore();
  const baseContext: ToolContext = {
    workspaceIndex: index,
    mode: 'fullPermission',
    memoryStore,
    allowMemoryWrite: false,
    operationLogStore
  };
  const registry = createDefaultToolRegistry();
  const readBridge = createAgentToolBridge({ registry, context: baseContext });

  assert.equal(readBridge.tools.length, registry.list().length, 'Bridge 工具数必须与默认注册表一致。');
  assert.ok(readBridge.tools.length >= REQUIRED_TOOL_NAMES.length, '默认生产工具注册表不完整。');
  const advertisedNames = new Set(readBridge.tools.map((tool) => tool.name));
  for (const name of REQUIRED_TOOL_NAMES) assert.ok(advertisedNames.has(name), `生产 bridge 未暴露工具 ${name}。`);
  assert.ok(readBridge.tools.find((tool) => tool.name === 'search_text_entries')?.supportsParallel === true);
  assert.ok(readBridge.tools.find((tool) => tool.name === 'search_param_rows')?.supportsParallel === true);
  assert.ok(readBridge.tools.find((tool) => tool.name === 'search_param_fields')?.supportsParallel === true);
  assert.ok(readBridge.tools.find((tool) => tool.name === 'mutate_param_fields')?.supportsParallel === false);

  const proposalInput = {
    targetUri: pathToFileURL(targetPath).href,
    targetPath,
    newText: 'after\n',
    title: '生产式 agent 场景文本提交'
  };
  const proposal = extractProposal(await registry.run('propose_text_patch', proposalInput, baseContext));
  assert.equal(proposal.workspaceId, index.workspaceId);

  // 逐个走默认 bridge 的模型-facing surface。这里即使某个工具因缺 session
  // 返回结构化失败，也必须是可解析的结果，不能抛出、吞错或越过文件边界。
  const syntheticFile = {
    sourceUri: 'file://synthetic/notes.txt',
    sourcePath: 'notes.txt',
    extension: '.txt',
    compoundExtension: '.txt',
    game: 'sekiro',
    resourceKind: 'other'
  };
  const plaintextBytes = Buffer.from('old marker\n', 'utf8').toString('base64');
  const probes = new Map<string, unknown>([
    ['workspace_stats', {}],
    ['retrieve_evidence', { query: '鬼刑部' }],
    ['search_resources', { query: 'NpcParam' }],
    ['search_events', { query: '鬼刑部' }],
    ['search_event_reference', { query: '落雷 掉落 不攻击' }],
    ['search_map_entities', { query: '鬼刑部' }],
    ['search_tae_events', { query: 'c0000 A0200' }],
    ['search_param_rows', { query: '鬼刑部', paramNames: ['NpcParam'] }],
    ['search_param_fields', { table: 'NpcParam', rowIds: [50800000], query: 'health' }],
    ['search_text_entries', { query: '鬼刑部' }],
    ['lookup_text_id', { textId: 902012, category: 'zhocn' }],
    ['find_text_references', { textId: 902012, category: 'zhocn' }],
    ['explain_text_entry', { textId: 902012, category: 'zhocn' }],
    ['find_references', { uri: 'file://synthetic/event/m10_00_00_00.emevd.dcx#event/1000', direction: 'both' }],
    ['explain_event', { uri: 'file://synthetic/event/m10_00_00_00.emevd.dcx#event/1000' }],
    ['propose_text_patch', { ...proposalInput, newText: 'probe\n' }],
    ['propose_plaintext_script_edit', {
      containerUri: 'file://synthetic/script/goal_list.lua',
      childPath: 'goal_list.lua',
      entryIndex: 0,
      currentBytesBase64: plaintextBytes,
      expectedContainerHash: 'script-hash-v1',
      find: 'old marker',
      replace: 'new marker'
    }],
    ['validate_patch', proposal],
    ['build_patch_graph', proposal],
    ['assess_edit_risk', { file: syntheticFile, changeKind: 'text' }],
    ['read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] }],
    ['mutate_param_fields', { edits: [{ table: 'NpcParam', rowId: 50800000, fieldId: 'hp', value: 2 }] }],
    ['read_fmg_entries', { table: 'zhocn', ids: [902012] }],
    ['mutate_fmg_entries', { edits: [{ table: 'zhocn', id: 90032, text: '义父的铃铛' }] }],
    ['read_emevd_outline', { file: 'event/m10_00_00_00.emevd.dcx' }],
    ['apply_emevd_dsl', { file: 'event/m10_00_00_00.emevd.dcx', dsl: 'event 1000 {}' }],
    ['read_tae_events', { file: 'action/c0000.anibnd.dcx', addresses: ['c0000#A0200.e0'] }],
    ['mutate_tae_event_times', { file: 'action/c0000.anibnd.dcx', edits: [{ address: 'c0000#A0200.e0', startFrame: 0, endFrame: 30 }] }],
    ['read_msb_parts', { file: 'map/m10_00_00_00.msb.dcx', addresses: ['m10_00_00_00#鬼刑部'] }],
    ['mutate_msb_part_transform', { file: 'map/m10_00_00_00.msb.dcx', edits: [{ address: 'm10_00_00_00#鬼刑部', nativeOffset: 1, posX: 1 }] }],
    ['query_map_objects', { file: 'map/m10_00_00_00.msb.dcx', nameContains: '鬼刑部' }],
    ['inspect_map_object', { file: 'map/m10_00_00_00.msb.dcx', identifier: '鬼刑部' }],
    ['batch_transform_map_objects', { file: 'map/m10_00_00_00.msb.dcx', targets: ['鬼刑部'], deltaX: 1 }],
    ['export_map_for_blender', { file: 'map/m10_00_00_00.msb.dcx' }],
    ['import_map_from_blender', { file: 'map/m10_00_00_00.msb.dcx', delta: {} }],
    ['commit_patch', proposal],
    ['list_operations', {}],
    ['rollback_operation', { opId: proposal.opId }],
    ['read_memory', { query: '正式名称' }],
    ['write_memory', { topic: 'forbidden', summary: 'must not be saved' }],
    ['list_memories', {}],
    ['switch_mode', { mode: 'fullPermission', reason: 'production scenario' }]
  ]);
  const beforeMemory = memoryStore.serializeMarkdown();
  const directWriteMemory = await readBridge.executeTool(call('direct-write-memory', 'write_memory', probes.get('write_memory')));
  assert.equal(directWriteMemory.ok, false);
  assert.equal(directWriteMemory.code, 'AGENT_MEMORY_WRITE_FORBIDDEN');
  assert.equal(memoryStore.serializeMarkdown(), beforeMemory, '被禁止的 write_memory 不得改变记忆存储。');

  for (const tool of readBridge.tools) {
    const result = await readBridge.executeTool(call(`probe-${tool.name}`, tool.name, probes.get(tool.name) ?? {}));
    const parsed = parseJson(result.content);
    assert.equal(typeof parsed.ok, 'boolean', `工具 ${tool.name} 的失败也必须可结构化解析。`);
  }

  const writeBridge = createAgentToolBridge({
    registry,
    context: { ...baseContext }
  });
  let activeExecutions = 0;
  let parallelPeak = 0;
  const loopToolNames: string[] = [];
  const approvalTools: string[] = [];
  const executeForLoop = async (
    toolCall: ToolCall,
    override?: Record<string, unknown>
  ): Promise<{ ok: boolean; content: string; code?: string }> => {
    loopToolNames.push(toolCall.name);
    activeExecutions += 1;
    parallelPeak = Math.max(parallelPeak, activeExecutions);
    try {
      if (toolCall.name === 'commit_patch') {
        return await writeBridge.executeTool(toolCall, {
          ...(override ?? {}),
          session,
          operationLogStore,
          backupBaseDir,
          recoveryDir,
          confirmation: createConfirmationReceipt({
            subjects: ['AGENT_COMMIT_APPROVED', 'ALL_RISKS'],
            riskLevel: 'high',
            note: 'production scenario approval fixture'
          })
        } as Partial<ToolContext>);
      }
      if (toolCall.name === 'rollback_operation') {
        let opId = '';
        try {
          const parsed = JSON.parse(toolCall.argumentsJson) as { opId?: unknown };
          opId = typeof parsed.opId === 'string' ? parsed.opId : '';
        } catch {
          // Bridge will report the structured invalid-input result.
        }
        return await writeBridge.executeTool(toolCall, {
          ...(override ?? {}),
          session,
          operationLogStore,
          backupBaseDir,
          recoveryDir,
          confirmation: createConfirmationReceipt({
            subjects: [`ROLLBACK_OPERATION:${opId}`],
            riskLevel: 'high',
            note: 'production scenario rollback fixture'
          })
        } as Partial<ToolContext>);
      }
      return await readBridge.executeTool(toolCall, override as Partial<ToolContext> | undefined);
    } finally {
      activeExecutions -= 1;
    }
  };

  const rounds: ScenarioRound[] = [
    { toolCalls: [call('s1', 'list_memories')] },
    {
      toolCalls: [
        call('s2-text', 'search_text_entries', { query: '鬼刑部' }),
        call('s2-npc', 'search_param_rows', { query: '鬼刑部', paramNames: ['NpcParam'] }),
        call('s2-goods-lot', 'search_param_rows', { query: '义父的铃铛', paramNames: ['EquipParamGoods', 'ItemLotParam'] }),
        call('s2-event', 'search_event_reference', { query: '落雷 不攻击 掉落' })
      ]
    },
    {
      toolCalls: [
        call('s3-stats', 'workspace_stats'),
        call('s3-rag', 'retrieve_evidence', { query: '鬼刑部', expandReferences: true }),
        call('s3-resource', 'search_resources', { query: 'NpcParam' }),
        call('s3-event', 'search_events', { query: '鬼刑部' }),
        call('s3-map', 'search_map_entities', { query: '鬼刑部' }),
        call('s3-tae', 'search_tae_events', { query: 'c0000 A0200' }),
        call('s3-text-id', 'lookup_text_id', { textId: 902012, category: 'zhocn' }),
        call('s3-text-ref', 'find_text_references', { textId: 902012, category: 'zhocn' }),
        call('s3-text-explain', 'explain_text_entry', { textId: 902012, category: 'zhocn' }),
        call('s3-ref', 'find_references', { uri: 'file://synthetic/event/m10_00_00_00.emevd.dcx#event/1000' }),
        call('s3-event-explain', 'explain_event', { uri: 'file://synthetic/event/m10_00_00_00.emevd.dcx#event/1000' }),
        call('s3-ops', 'list_operations')
      ]
    },
    {
      toolCalls: [
        call('s4-text-proposal', 'propose_text_patch', { ...proposalInput, newText: 'proposal\n' }),
        call('s4-script-proposal', 'propose_plaintext_script_edit', {
          containerUri: 'file://synthetic/script/goal_list.lua',
          childPath: 'goal_list.lua',
          entryIndex: 0,
          currentBytesBase64: plaintextBytes,
          expectedContainerHash: 'script-hash-v1',
          find: 'old marker',
          replace: 'new marker'
        }),
        call('s4-graph', 'build_patch_graph', proposal),
        call('s4-validate', 'validate_patch', proposal),
        call('s4-risk', 'assess_edit_risk', { file: syntheticFile, changeKind: 'text' })
      ]
    },
    {
      toolCalls: [
        call('s5-param-read', 'read_param_fields', { table: 'NpcParam', rowIds: [50800000], fieldIds: ['hp'] }),
        call('s5-fmg-read', 'read_fmg_entries', { table: 'zhocn', ids: [902012] }),
        call('s5-emevd-read', 'read_emevd_outline', { file: 'event/m10_00_00_00.emevd.dcx' }),
        call('s5-tae-read', 'read_tae_events', { file: 'action/c0000.anibnd.dcx' }),
        call('s5-msb-read', 'read_msb_parts', { file: 'map/m10_00_00_00.msb.dcx' }),
        call('s5-map-query', 'query_map_objects', { file: 'map/m10_00_00_00.msb.dcx', nameContains: '鬼刑部' }),
        call('s5-map-inspect', 'inspect_map_object', { file: 'map/m10_00_00_00.msb.dcx', identifier: '鬼刑部' }),
        call('s5-map-export', 'export_map_for_blender', { file: 'map/m10_00_00_00.msb.dcx' })
      ]
    },
    {
      toolCalls: [
        call('s6-memory-write', 'write_memory', { topic: 'agent-scenario', summary: '不得写入长期记忆。' }),
        call('s6-commit', 'commit_patch', proposal)
      ]
    },
    { toolCalls: [call('s7-rollback', 'rollback_operation', { opId: proposal.opId })] },
    {
      text: '已完成全链路验证：已从记忆启动，并发核对 MSG、NpcParam、ItemLotParam/EquipParamGoods 与事件语义；实际写入经过审批、Patch Engine、备份和回退，最终方案会按 native reread 结果落地。'
    }
  ];
  const adapter = new ScenarioAdapter(rounds);
  const loop: AgentRunResult = await runAgentToolLoop(adapter, {
    config: makeConfig(),
    apiKey: 'local-scenario-key',
    taskQuery: TASK_QUERY,
    messages: [{ role: 'user', content: TASK_QUERY }],
    tools: readBridge.tools,
    permissionMode: 'full',
    streaming: true,
    maxSteps: rounds.length,
    approvalRequiredLevels: ['commit', 'rollback'],
    requestApproval: async (request) => {
      approvalTools.push(request.toolName);
      return { decision: 'once', note: '隔离生产场景自动批准，用于验证审批到执行的连接。' };
    },
    executeTool: executeForLoop
  });

  assert.equal(loop.finishReason, 'stop', `全链路 loop 未正常结束：${JSON.stringify(loop.diagnostics)}`);
  assert.equal(loop.audit.streaming, true, '全链路必须实际走 streaming 路径。');
  assert.ok(loop.steps >= 8, `必须覆盖 8 个模型轮次，实际 ${loop.steps}。`);
  assert.ok(parallelPeak >= 2, `MSG/PARAM 并发调用未被观察到，peak=${parallelPeak}。`);
  assert.deepEqual(approvalTools, ['commit_patch', 'rollback_operation']);
  assert.ok(loopToolNames.includes('write_memory'));
  assert.ok(loopToolNames.includes('commit_patch'));
  assert.ok(loopToolNames.includes('rollback_operation'));
  const finalAnswer = loop.messages
    .filter((message: ChatMessage) => message.role === 'assistant')
    .map((message) => message.content)
    .filter((content) => content.trim().length > 0)
    .at(-1) ?? '';
  assert.ok(finalAnswer.includes('MSG') && finalAnswer.includes('Patch Engine'), '最终输出必须包含检索和写入方案。');
  assert.equal(await readFile(targetPath, 'utf8'), 'before\n', '回退后临时文件必须恢复原文。');
  const history = await operationLogStore.history(session.meta.workspaceId);
  assert.equal(history.length, 2, '提交+回退应留下两条可审计历史。');
  assert.equal(memoryStore.serializeMarkdown(), beforeMemory, '全链路中 write_memory 也不得改变长期记忆。');

  return {
    toolCount: readBridge.tools.length,
    loopSteps: loop.steps,
    parallelPeak,
    approvalTools,
    finalAnswer
  };
}

async function main(): Promise<void> {
  const result = await withSmokeWorkspace('agent-production-scenario', (workspace) => runScenario(workspace.root));
  console.log(JSON.stringify({
    ok: true,
    message: '默认生产 ToolRegistry 全链路场景通过：发现/并发/提案/审批/提交/回退/流式输出；长期记忆写入被禁止。',
    ...result
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
