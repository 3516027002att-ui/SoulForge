/**
 * Reference-query contract + behavior smoke (T01, 执行指令 §3/§4/§7).
 *
 * Contract-level assertions (decoder, identity, version) run against the
 * shared DTO and resourceVersion modules. Behavior-level assertions drive
 * the PRODUCTION dispatcher (createDefaultToolRegistry) and the production
 * graph builder over fixtures; they are expected to FAIL until T02-T08
 * land, and each failure message names the unimplemented behavior (never
 * an import/build problem — this file must compile on the baseline).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeReferenceQueryInput,
  REFERENCE_DEPTH_MAX,
  REFERENCE_LIMIT_MAX
} from '@soulforge/shared';
import type { ReferencePageRecord } from '@soulforge/shared';
import {
  FIXTURE_BYTECODE_ENTRY_NAME,
  FIXTURE_EMEVD_FILE_X,
  FIXTURE_EMEVD_FILE_Y,
  FIXTURE_EVENT_ID,
  FIXTURE_LUA_ENTRY_NAME,
  FIXTURE_LUA_TEXT,
  FIXTURE_LUABND_SOURCE,
  FIXTURE_MAP_SOURCE,
  FIXTURE_TARGET_ROW_ID,
  FIXTURE_THINK_PARAM,
  FIXTURE_WORKSPACE_A,
  FIXTURE_WORKSPACE_B,
  buildConditionalRefBundle,
  buildDuplicateIdentityBundle,
  buildEmevdCrossFileBundle,
  buildMapInstanceBundle,
  buildScenarioABundle,
  buildScriptBundle,
  fixtureHash,
  buildWorkspacePairBundles
} from './referenceOptimizationFixtures.js';
import {
  compareResourceVersion,
  computeResourceKey
} from '../runtime/resourceVersion.js';
import { buildReferenceGraph } from '../references/referenceBuilder.js';
import { buildScriptReferenceEdges } from '../references/scriptReferenceProvider.js';
import { parseLuaStaticSubset } from '../references/luaStaticSubset.js';
import { buildMapReferenceEdges } from '../references/mapReferenceProvider.js';
import { buildContainerMemberEdges } from '../references/containerMemberProvider.js';
import {
  REFERENCE_CAPABILITIES,
  validateReferenceCapabilities
} from '../references/referenceCapabilityRegistry.js';
import { ALL_RESOURCE_KINDS } from '@soulforge/shared';
import {
  buildEventCallChain,
  CALL_CHAIN_MAX_DEPTH
} from '../references/eventReferenceProvider.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { createDefaultToolRegistry, type ToolContext } from '../ai/toolRegistry.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';

const failures: string[] = [];
let checks = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (!condition) failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

/** Decode a raw find_references argument object and report its outcome. */
function decodeCode(raw: unknown): string {
  const result = decodeReferenceQueryInput(raw);
  return result.ok ? 'ok' : result.code;
}

/* ------------------------------------------------------------------ */
/* 1. Strict input decoding (§3.1, I08/I09)                            */
/* ------------------------------------------------------------------ */

check('decode/uri-only', decodeCode({ uri: 'event://m10/1000' }) === 'ok');
check(
  'decode/param-target',
  decodeCode({
    target: {
      domain: 'param',
      sourceUri: 'workspace://ws/mods/a/GameParam.parambnd.dcx',
      entryIndex: 0, rowId: FIXTURE_TARGET_ROW_ID
    },
    fieldIds: ['hp']
  }) === 'ok'
);
check('decode/query-domain', decodeCode({ query: 'NpcParam 50800000', domain: 'param' }) === 'ok');
check('decode/I08-conflict', decodeCode({ uri: 'event://m10/1', query: 'x' }) === 'REFERENCE_TARGET_CONFLICT');
check('decode/I08-target-plus-uri', decodeCode({
  uri: 'event://m10/1',
  target: { domain: 'emevd', sourceUri: 'workspace://ws/mods/x.emevd.dcx', eventId: 1 }
}) === 'REFERENCE_TARGET_CONFLICT');
check('decode/missing-target', decodeCode({ direction: 'both' }) === 'REFERENCE_TARGET_REQUIRED');
check('decode/I09-nan', decodeCode({
  target: { domain: 'emevd', sourceUri: 'workspace://ws/x.emevd.dcx', eventId: Number.NaN }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/I09-infinity', decodeCode({
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: Number.POSITIVE_INFINITY }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/I09-unsafe-int', decodeCode({
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: Number.MAX_SAFE_INTEGER + 10 }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/I09-string-number', decodeCode({
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: '123' }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/I09-empty-string-id', decodeCode({
  // Number('') === 0 is a coercion pitfall; the decoder must reject the raw
  // empty string, not silently accept it as rowId 0.
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: '' }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/depth-too-deep', decodeCode({ uri: 'e://1', depth: REFERENCE_DEPTH_MAX + 1 }) === 'REFERENCE_INVALID_INPUT');
check('decode/limit-over-max', decodeCode({ uri: 'e://1', limit: REFERENCE_LIMIT_MAX + 1 }) === 'REFERENCE_INVALID_INPUT');
check('decode/fieldIds-empty-array-rejected', decodeCode({
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: 1 },
  fieldIds: []
}) === 'REFERENCE_INVALID_INPUT');
check('decode/fieldIds-non-param-rejected', decodeCode({
  target: { domain: 'emevd', sourceUri: 'workspace://ws/x.emevd.dcx', eventId: 1 },
  fieldIds: ['hp']
}) === 'REFERENCE_INVALID_INPUT');
check('decode/unknown-top-level-key', decodeCode({ uri: 'e://1', verified: true }) === 'REFERENCE_INVALID_INPUT');
check('decode/spoofed-selector-field', decodeCode({
  target: { domain: 'param', sourceUri: 'workspace://ws/x', entryIndex: 0, rowId: 1, verified: true }
}) === 'REFERENCE_INVALID_INPUT');
check('decode/cursor-plus-target-conflict', decodeCode({
  cursor: 'host-cursor-1',
  target: { domain: 'emevd', sourceUri: 'workspace://ws/x.emevd.dcx', eventId: 1 }
}) === 'REFERENCE_CURSOR_SCOPE_MISMATCH');
check('decode/cursor-continuation-ok', decodeCode({ cursor: 'host-cursor-1' }) === 'ok');
check('decode/objectHandle-selector-only-key', decodeCode({
  target: { objectHandle: 'handle-1', extra: 'x' }
}) === 'REFERENCE_INVALID_INPUT');

/* ------------------------------------------------------------------ */
/* 2. Identity + version rules (§4.1/§4.2, I01-I05, V01/V04/P12)       */
/* ------------------------------------------------------------------ */

const pair = buildWorkspacePairBundles();
const rowA = pair.bundleA.params![0]!.rows[0]!;
const rowB = pair.bundleB.params![0]!.rows[0]!;
const keyOfRow = (uri: string, sourceUri: string, workspaceId: string) => computeResourceKey({
  workspaceId, domain: 'param', sourceUri,
  entryIndex: 0, rowId: FIXTURE_TARGET_ROW_ID, rowIndex: 0
});
check('I01/cross-workspace-distinct-keys',
  keyOfRow(rowA.uri, rowA.sourceUri, FIXTURE_WORKSPACE_A)
  !== keyOfRow(rowB.uri, rowB.sourceUri, FIXTURE_WORKSPACE_B));

const dup = buildDuplicateIdentityBundle();
const dupRows = dup.params![0]!.rows;
const dupKey0 = computeResourceKey({
  workspaceId: FIXTURE_WORKSPACE_A, domain: 'param', sourceUri: dupRows[0]!.sourceUri,
  entryIndex: dupRows[0]!.entryIndex ?? 0, rowId: dupRows[0]!.rowId, rowIndex: dupRows[0]!.rowIndex ?? 0
});
const dupKey1 = computeResourceKey({
  workspaceId: FIXTURE_WORKSPACE_A, domain: 'param', sourceUri: dupRows[1]!.sourceUri,
  entryIndex: dupRows[1]!.entryIndex ?? 0, rowId: dupRows[1]!.rowId, rowIndex: dupRows[1]!.rowIndex ?? 0
});
check('I03/duplicate-rowId-physical-rows-distinct', dupKey0 !== dupKey1);
const dupEntry = dup.params![1]!;
check('I02/same-entry-name-different-entryIndex-distinct',
  computeResourceKey({
    workspaceId: FIXTURE_WORKSPACE_A, domain: 'param', sourceUri: dupEntry.sourceUri!,
    entryIndex: dupEntry.entryIndex!, rowId: 10
  }) !== computeResourceKey({
    workspaceId: FIXTURE_WORKSPACE_A, domain: 'param', sourceUri: dupEntry.sourceUri!,
    entryIndex: 3, rowId: 10
  }));

const emevd = buildEmevdCrossFileBundle();
check('I04/same-eventId-different-file-distinct',
  computeResourceKey({
    workspaceId: FIXTURE_WORKSPACE_A, domain: 'emevd', sourceUri: FIXTURE_EMEVD_FILE_X, eventId: FIXTURE_EVENT_ID
  }) !== computeResourceKey({
    workspaceId: FIXTURE_WORKSPACE_A, domain: 'emevd', sourceUri: FIXTURE_EMEVD_FILE_Y, eventId: FIXTURE_EVENT_ID
  }));
void emevd;

check('V-missing-version-unknown', compareResourceVersion(undefined, { outerFileHash: 'a', generation: 1 }) === 'unknown');
check('V-empty-hash-unknown', compareResourceVersion({ outerFileHash: '', generation: 1 }, { outerFileHash: 'a', generation: 1 }) === 'unknown');
check('V01-same-mtime-different-bytes-stale', compareResourceVersion(
  { outerFileHash: 'hash-H1', generation: 2, mtimeMs: 1000 },
  { outerFileHash: 'hash-H0', generation: 2, mtimeMs: 1000 }
) === 'stale');
check('P12-generation-change-stale', compareResourceVersion(
  { outerFileHash: 'hash-H0', generation: 3 },
  { outerFileHash: 'hash-H0', generation: 1 }
) === 'stale');
check('V04-late-async-newer', compareResourceVersion(
  { outerFileHash: 'hash-H1', generation: 2 },
  { outerFileHash: 'hash-H1', generation: 5 }
) === 'newer');
check('V-equal-same-generation', compareResourceVersion(
  { outerFileHash: 'hash-H1', payloadHash: 'p1', generation: 2 },
  { outerFileHash: 'hash-H1', payloadHash: 'p1', generation: 2 }
) === 'equal');
check('V02-metadata-schema-stale', compareResourceVersion(
  { outerFileHash: 'h', generation: 1, metadataSchemaVersion: 'emedf-2' },
  { outerFileHash: 'h', generation: 1, metadataSchemaVersion: 'emedf-1' }
) === 'stale');

/* ------------------------------------------------------------------ */
/* 3. Production dispatcher must speak the new contract (§3.1)         */
/*    Expected to fail until T08 wires ReferenceQueryService.          */
/* ------------------------------------------------------------------ */

const registry = createDefaultToolRegistry();
const findTool = registry.list().find((tool) => tool.name === 'find_references');
const schemaKeys = new Set(Object.keys(findTool?.inputSchema ?? {}));
for (const key of ['target', 'query', 'detail', 'fieldIds', 'depth', 'limit', 'includeHypotheses', 'cursor']) {
  check(`schema/find_references.${key}`, schemaKeys.has(key),
    '行为未实现：find_references 仍只声明旧 uri/direction，新参数未进入生产 inputSchema（T08）');
}

const emptyContext = { mode: 'normal', workspaceIndex: new WorkspaceIndex('ref-smoke') } as ToolContext;
const targetResult = await registry.run(
  'find_references',
  { target: { domain: 'emevd', sourceUri: FIXTURE_EMEVD_FILE_X, eventId: FIXTURE_EVENT_ID }, detail: 'edges' },
  emptyContext
);
check('dispatch/target-accepted', targetResult.ok === true,
  `行为未实现：精确 target 选择器被生产 dispatcher 拒绝（${JSON.stringify(targetResult.error?.code)}），T08 未接线 ReferenceQueryService`);

const conflictResult = await registry.run(
  'find_references',
  { uri: 'event://x/1', query: 'anything' },
  emptyContext
);
check('dispatch/I08-conflict-exact-code', conflictResult.error?.code === 'REFERENCE_TARGET_CONFLICT',
  `行为未实现：目标冲突应返回 REFERENCE_TARGET_CONFLICT，实际 ${JSON.stringify(conflictResult.error?.code)}`);

const noTargetResult = await registry.run('find_references', { direction: 'both' }, emptyContext);
check('dispatch/missing-target-exact-code', noTargetResult.error?.code === 'REFERENCE_TARGET_REQUIRED',
  `行为未实现：缺少目标应返回 REFERENCE_TARGET_REQUIRED，实际 ${JSON.stringify(noTargetResult.error?.code)}`);

/* ------------------------------------------------------------------ */
/* 4. Final page record shape (§3.2) — via ReferenceQueryService       */
/*    (T08). Probed dynamically so this file compiles on the baseline. */
/* ------------------------------------------------------------------ */

const servicePath = fileURLToPath(new URL('../references/referenceQueryService.js', import.meta.url));
check('service/referenceQueryService-exists', existsSync(servicePath),
  '行为未实现：packages/core/src/references/referenceQueryService.ts 尚不存在（T08）');

if (existsSync(servicePath)) {
  const serviceModule = await import(new URL('../references/referenceQueryService.js', import.meta.url).href) as {
    createReferenceQueryService?: (options: Record<string, unknown>) => {
      query: (input: unknown) => Promise<ReferencePageRecord>;
    };
  };
  check('service/factory-exported', typeof serviceModule.createReferenceQueryService === 'function');
  if (typeof serviceModule.createReferenceQueryService === 'function') {
    const service = serviceModule.createReferenceQueryService({ bundle: buildScenarioABundle() });
    const page = await service.query({
      target: {
        domain: 'param',
        sourceUri: rowA.sourceUri, entryIndex: 0, rowId: FIXTURE_TARGET_ROW_ID, rowIndex: 0
      },
      fieldIds: ['hp']
    });
    check('page/resolution-field', typeof page.resolution === 'string');
    check('page/coverage-field', typeof page.coverage?.status === 'string');
    check('page/page-field', typeof page.page?.returnedCount === 'number');
    check('page/target-read-echoes-field', (page.targetRead?.fields ?? []).some((field) => field.fieldId === 'hp'));
    check('page/indexed-target-read-not-native-proof', page.targetRead?.completeness === 'summary_only',
      '索引字段投影不能伪装成 native read proof');
    check('page/context-detail-is-explicit', page.detail === 'context' && page.context?.statements !== undefined,
      'context 查询必须返回明确、有界的上下文投影');
    check('page/coverage-does-not-falsely-complete', page.coverage.domains.some((domain) =>
      domain.status === 'partial' || domain.status === 'unscanned'),
      '未扫描域不得报告 complete');
    const edgesPage = await service.query({
      target: {
        domain: 'param',
        sourceUri: rowA.sourceUri, entryIndex: 0, rowId: FIXTURE_TARGET_ROW_ID, rowIndex: 0
      },
      detail: 'edges'
    });
    check('page/edges-vs-context-distinct', edgesPage.detail === 'edges'
      && JSON.stringify(edgesPage) !== JSON.stringify(page),
    'detail=edges 与 detail=context 不得返回同一 payload');
    const missingFieldPage = await service.query({
      target: {
        domain: 'param',
        sourceUri: rowA.sourceUri, entryIndex: 0, rowId: FIXTURE_TARGET_ROW_ID, rowIndex: 0
      },
      fieldIds: ['__missing_field__']
    });
    check('page/missing-field-partial', missingFieldPage.targetRead?.completeness === 'partial'
      && (missingFieldPage.targetRead?.fields.length ?? 0) === 0,
    '缺失字段不得以 value=null 冒充存在');
    check('page/relations-nonempty', page.relations.length > 0, '场景 A 应至少返回一条关联');
    check('page/certainty-vocabulary', page.relations.every((relation) =>
      ['confirmed', 'indirect', 'hypothesis'].includes(relation.certainty)),
    'certainty 必须使用 confirmed/indirect/hypothesis，不得沿用 high/medium/low');
    check('page/statement-kinds', page.relations.every((relation) => relation.evidence.every((evidence) =>
      evidence.statement === undefined || ['native-rendered', 'source-text', 'decompiled-view', 'field-assignment']
        .includes(evidence.statement.kind))));
    check('page/no-ledger-next-actions', page.nextActions.every((action) =>
      !action.tool.includes('task_record')), 'nextActions 不得要求登记台账');
  }
}

/* ------------------------------------------------------------------ */
/* 5. Param→param conditional reference edges through the production   */
/*    graph builder (R01-R04, §3.1 fixtures).                          */
/* ------------------------------------------------------------------ */

const cond = buildConditionalRefBundle();
const graph = buildReferenceGraph(cond);
const condSource = cond.params![0]!.sourceUri;
const bulletUri = `${condSource}#Bullet/400`;
const rowUri = (rowId: number) => `${condSource}#BehaviorParam/${rowId}`;

check('R01/condition-holds-edge', graph.edges.some((edge) =>
  edge.fromUri === rowUri(1) && edge.toUri === bulletUri),
'行为未实现：Refs 条件成立的确定引用边缺失（T04 paramReferenceProvider）');
check('R02/condition-misses-no-edge', !graph.edges.some((edge) =>
  edge.fromUri === rowUri(2) && edge.toUri === bulletUri));
check('R03/unresolved-condition-surfaced', 'diagnostics' in graph,
  '行为未实现：条件字段缺失应产生 unresolved-condition 诊断（graph.diagnostics），而不是静默无边（T04/T08）');
check('R04/rejected-syntax-coverage-gap', (() => {
  const row4 = cond.params![0]!.rows[3]!;
  const field = (row4.fields ?? []).find((item) => item.fieldId === 'refId');
  return (field?.refsRejected?.length ?? 0) > 0;
})(), 'rejected 片段必须保留在符号投影中，不得 filter(Boolean) 丢失');

/* ------------------------------------------------------------------ */
/* 6. Ambiguity: query with two same-name candidates (§7 I07, 场景 B)  */
/* ------------------------------------------------------------------ */

if (existsSync(servicePath)) {
  const serviceModule = await import(new URL('../references/referenceQueryService.js', import.meta.url).href) as {
    createReferenceQueryService?: (options: Record<string, unknown>) => {
      query: (input: unknown) => Promise<ReferencePageRecord>;
    };
  };
  if (typeof serviceModule.createReferenceQueryService === 'function') {
    const service = serviceModule.createReferenceQueryService({ bundle: buildDuplicateIdentityBundle() });
    const ambiguous = await service.query({ query: 'Dup.param 10', domain: 'param' });
    check('B/ambiguous-resolution', ambiguous.resolution === 'ambiguous',
      `同名多来源应返回 ambiguous，实际 ${ambiguous.resolution}`);
    check('B/candidates-distinguished', (ambiguous.candidates?.length ?? 0) >= 2
      && new Set((ambiguous.candidates ?? []).map((candidate) => {
        const identity = candidate.identity;
        return computeResourceKey({
          workspaceId: identity.workspaceId, domain: identity.domain, sourceUri: identity.sourceUri,
          ...(identity.entryIndex !== undefined ? { entryIndex: identity.entryIndex } : {}),
          ...(identity.rowId !== undefined ? { rowId: identity.rowId } : {}),
          ...(identity.rowIndex !== undefined ? { rowIndex: identity.rowIndex } : {})
        });
      })).size === (ambiguous.candidates?.length ?? 0));
    check('B/no-deep-read-for-candidates', (ambiguous.candidates ?? []).every((candidate) =>
      candidate.discriminators !== undefined));
  }
}

/* ------------------------------------------------------------------ */
/* 7. EMEVD provider (T05): roles, namespaces, bindings, call chains.  */
/* ------------------------------------------------------------------ */

type SmokeArg = {
  name?: string;
  value: string | number;
  argIndex?: number;
  role?: 'flag' | 'eventId' | 'entityId' | 'regionId' | 'paramId' | 'textId' | 'unknown';
  roleSource?: 'registry' | 'inferred';
  paramName?: string;
};
type SmokeInstr = {
  index: number;
  name: string;
  bank?: number;
  id?: number;
  args: SmokeArg[];
};
type SmokeEvent = { eventId: number; instructions: SmokeInstr[]; parameters?: unknown[] };

function emevdExport(sourceUri: string, tag: string, events: SmokeEvent[]) {
  return {
    sourceHash: fixtureHash(sourceUri),
    outerFileHash: fixtureHash(`outer:${tag}`),
    events: events.map((event) => ({
      uri: `${sourceUri}#event/${event.eventId}`,
      sourceUri,
      eventId: event.eventId,
      outerFileHash: fixtureHash(`outer:${tag}`),
      instructions: event.instructions.map((instruction) => ({
        uri: `${sourceUri}#event/${event.eventId}#instruction/${instruction.index}`,
        index: instruction.index,
        name: instruction.name,
        ...(instruction.bank !== undefined ? { bank: instruction.bank } : {}),
        ...(instruction.id !== undefined ? { id: instruction.id } : {}),
        args: instruction.args
      })),
      ...(event.parameters ? { raw: { parameters: event.parameters } } : {})
    }))
  };
}

const E_FILE_A = `workspace://${FIXTURE_WORKSPACE_A}/mods/event/a/m11_05_00_00.emevd.dcx`;
const E_FILE_B = `workspace://${FIXTURE_WORKSPACE_A}/mods/event/b/m11_06_00_00.emevd.dcx`;
const E_COMMON = `workspace://${FIXTURE_WORKSPACE_A}/event/common.emevd.dcx`;

// Registry with the repo-supported InitializeEvent layout (slotNumber, eventId).
const smokeRegistry: EmedfRegistry = {
  schemaVersion: 1,
  game: 'sekiro',
  origin: 'fixture',
  instructions: [
    {
      bank: 2000,
      id: 6,
      name: 'InitializeEvent',
      args: [
        { name: 'slotNumber', type: 's32' },
        { name: 'eventId', type: 's32' },
        { name: 'arg', type: 's32' }
      ]
    },
    { bank: 2000, id: 99, name: 'SomeOpaqueThing', args: [{ name: 'value', type: 's32' }] }
  ]
};

const eExports = [
  emevdExport(E_FILE_A, 'e-a', [
    {
      eventId: 100,
      instructions: [
        // Trusted metadata role → confirmed.
        { index: 0, name: 'SetFlag', bank: 2000, id: 90, args: [{ name: 'flagId', value: 5000, argIndex: 0, role: 'flag', roleSource: 'registry' }] },
        // Rule-table only: no role metadata, but registry def matches the explicit rule.
        { index: 1, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 200, argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] },
        // Indirect call through a parameter binding with a native parameters table.
        { index: 2, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 'X4_4', argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] },
        // Name-inference only (no role, no registry match) → hypothesis channel.
        { index: 3, name: 'ShowDialogText', bank: 2000, id: 99, args: [{ name: 'value', value: 777, argIndex: 0 }] }
      ],
      parameters: [{ instructionIndex: 2, targetStartByte: 4, sourceStartByte: 4, byteCount: 4, unkId: 0 }]
    },
    {
      eventId: 200,
      instructions: [
        // Calls back into 100 → cycle.
        { index: 0, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 100, argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] }
      ]
    }
  ]),
  emevdExport(E_FILE_B, 'e-b', [
    // Same eventId 200 as file A — cross-file same id must not merge.
    { eventId: 200, instructions: [] }
  ])
];

const eGraph = buildReferenceGraph({ events: eExports as never }, { registry: smokeRegistry });
const eEdges = eGraph.edges;

// Trusted metadata flag role → confirmed high.
check('E01/trusted-role-confirmed', eEdges.some((edge) =>
  edge.fromUri === `${E_FILE_A}#event/100` && edge.toUri === 'flag://5000'
  && edge.confidence === 'high' && edge.reason.startsWith('registry-confirmed')),
  '行为未实现：roleSource=registry 的显式角色未生成 confirmed 边（T05）');

// Rule-table match without any arg.role metadata → confirmed with ruleId.
check('E02/rule-table-event-call', eEdges.some((edge) =>
  edge.fromUri === `${E_FILE_A}#event/100` && edge.toUri === `${E_FILE_A}#event/200`
  && edge.kind === 'calls_event' && edge.confidence === 'high' && edge.reason.includes('rule(event-call:InitializeEvent)')),
  '行为未实现：显式规则表未把 InitializeEvent(eventId@1) 解析为 confirmed 调用（T05 步骤 2/5）');

// Confirmed edges carry the real typed call statement.
check('E03/evidence-typed-statement', eEdges.some((edge) =>
  edge.evidence.some((item) => (item.excerpt ?? '').includes('InitializeEvent#1')
    && (item.excerpt ?? '').includes('eventId=200'))),
  '行为未实现：confirmed 边缺少真实 typed 参数渲染的调用语句（T05 步骤 3）');

// Name inference never confirms; suppressed by default.
check('E04/hypothesis-not-confirmed', !eEdges.some((edge) =>
  edge.confidence === 'high' && edge.reason.includes('ShowDialogText')));
check('E04b/hypothesis-suppressed', !eEdges.some((edge) =>
  edge.reason.includes('hypothesis(name-inference)')),
  '默认图不得包含名称推断 hypothesis 边（T05 步骤 12）');
const eGraphWithHypo = buildReferenceGraph({
  events: eExports as never,
  // Text target so the name-inference hypothesis on ShowDialogText(777)
  // has a real resolution to attach to; the hypothesis stays low + rule-named.
  msgs: [{
    entries: [{
      uri: `${E_FILE_A}#text/777`, sourceUri: E_FILE_A, textId: 777, text: 'smoke'
    }]
  }]
} as never, { registry: smokeRegistry, includeHypotheses: true });
check('E04c/hypothesis-opt-in-low', eGraphWithHypo.edges.some((edge) =>
  edge.reason.includes('hypothesis(name-inference)') && edge.confidence === 'low'));

// Unknown instruction (registry supplied, bank:id absent) → diagnostic, no silent pass.
const unknownGraph = buildReferenceGraph({
  events: [emevdExport(E_FILE_B, 'e-b', [{
    eventId: 300,
    instructions: [{ index: 0, name: 'Mystery', bank: 9999, id: 42, args: [{ name: 'eventId', value: 200, argIndex: 0, role: 'eventId', roleSource: 'registry' }] }]
  }])] as never
}, { registry: smokeRegistry });
check('E05/unknown-instruction-diagnostic', unknownGraph.diagnostics.some((d) =>
  d.code === 'EMEVD_UNKNOWN_INSTRUCTION'),
  '行为未实现：registry 下未知 bank:id 未保留未解析诊断（T05 步骤 4）');

// Cross-file same event id: A/100→200 resolves inside A; nothing merges B/200.
check('E06/cross-file-not-merged', !eEdges.some((edge) =>
  edge.toUri === `${E_FILE_B}#event/200` && edge.confidence === 'high'),
  '跨文件同号事件被当作确定目标（T05 步骤 5 / I04）');

// Common namespace: call to an id that only exists in common.emevd is confirmed.
const commonGraph = buildReferenceGraph({
  events: [
    emevdExport(E_FILE_A, 'e-a', [{
      eventId: 400,
      instructions: [{ index: 0, name: 'InitializeCommonEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 900, argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] }]
    }]),
    emevdExport(E_COMMON, 'e-common', [{ eventId: 900, instructions: [] }])
  ] as never
}, { registry: smokeRegistry });
check('E07/common-namespace-resolves', commonGraph.edges.some((edge) =>
  edge.fromUri === `${E_FILE_A}#event/400` && edge.toUri === `${E_COMMON}#event/900`
  && edge.confidence === 'high'),
  '行为未实现：common.emevd 命名空间内的事件 id 未按现有规则解析（T05 步骤 5）');

// Call chain: direct hop, indirect binding hop with width kept, cycle detection.
const chain = buildEventCallChain(eExports as never, `${E_FILE_A}#event/100`, { registry: smokeRegistry });
const directHop = chain.paths.flat().find((hop) => hop.toEventUri === `${E_FILE_A}#event/200` && !hop.indirect);
check('E08/chain-direct-hop', directHop !== undefined, '调用链缺少直接 InitializeEvent 跳（T05 步骤 8）');
const indirectHop = chain.paths.flat().find((hop) => hop.indirect);
check('E09/chain-indirect-binding', indirectHop?.parameterSymbol === 'X4_4'
  && indirectHop.byteCount === 4 && indirectHop.sourceStartByte === 4
  && indirectHop.parameterInstructionIndex === 2,
  '行为未实现：X<off>_<width> 绑定未保留宽度/偏移或未按原生 parameters 匹配（T05 步骤 6）');
check('E10/chain-cycle-detected', chain.cycles.some((c) =>
  c.includes(`${E_FILE_A}#event/100`) && c.includes(`${E_FILE_A}#event/200`)),
  '行为未实现：A→B→A 环未被检测（T05 步骤 10）');

// Depth truncation on a linear chain longer than the default cap.
const deepEvents: SmokeEvent[] = [];
for (let i = 0; i < CALL_CHAIN_MAX_DEPTH + 2; i += 1) {
  deepEvents.push({
    eventId: 1000 + i,
    instructions: [{
      index: 0, name: 'InitializeEvent', bank: 2000, id: 6,
      args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 1001 + i, argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }]
    }]
  });
}
const deepChain = buildEventCallChain([emevdExport(E_FILE_A, 'deep', deepEvents)] as never, `${E_FILE_A}#event/1000`, { registry: smokeRegistry });
check('E11/chain-depth-truncated', deepChain.truncated === true
  && (deepChain.truncationReason ?? '').includes('深度'),
  '行为未实现：超过深度上限未返回截断声明（T05 步骤 10）');

// Two call sites with different bound parameters → distinguishable hops.
const twoSiteEvents: SmokeEvent[] = [
  {
    eventId: 500,
    instructions: [
      { index: 0, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 'X0_4', argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] },
      { index: 1, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 'X8_4', argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] }
    ],
    parameters: [
      { instructionIndex: 0, targetStartByte: 4, sourceStartByte: 0, byteCount: 4, unkId: 0 },
      { instructionIndex: 1, targetStartByte: 4, sourceStartByte: 8, byteCount: 4, unkId: 1 }
    ]
  }
];
const twoSiteChain = buildEventCallChain([emevdExport(E_FILE_A, 'two-site', twoSiteEvents)] as never, `${E_FILE_A}#event/500`, { registry: smokeRegistry });
const twoSiteHops = twoSiteChain.paths.flat().filter((hop) => hop.indirect);
check('E12/two-call-sites-distinguishable', twoSiteHops.length === 2
  && new Set(twoSiteHops.map((hop) => `${hop.parameterSymbol}:${hop.parameterInstructionIndex}:${hop.parameterTargetStartByte}`)).size === 2,
  '行为未实现：同一事件两个不同绑定调用点生成了不可区分的路径（T05 步骤 8）');

// Unmatched binding (no native parameters table) stays unresolved-flagged:
// hop keeps the symbol but carries no parameter identity.
const unmatchedChain = buildEventCallChain([emevdExport(E_FILE_A, 'unmatched', [{
  eventId: 600,
  instructions: [{ index: 0, name: 'InitializeEvent', bank: 2000, id: 6, args: [{ name: 'slotNumber', value: 0, argIndex: 0 }, { name: 'eventId', value: 'X16_8', argIndex: 1 }, { name: 'arg', value: 0, argIndex: 2 }] }]
}])] as never, `${E_FILE_A}#event/600`, { registry: smokeRegistry });
const unmatchedHop = unmatchedChain.paths.flat().find((hop) => hop.indirect);
check('E13/unmatched-binding-unresolved', unmatchedHop !== undefined
  && unmatchedHop.parameterInstructionIndex === undefined
  && unmatchedHop.byteCount === 8,
  '行为未实现：越界/无匹配的参数绑定未保留为 unresolved（T05 步骤 7）');

/* ------------------------------------------------------------------ */
/* 8. Script provider (T06): static Lua subset, container identity.    */
/* ------------------------------------------------------------------ */

const SCRIPT_URI = `${FIXTURE_LUABND_SOURCE}!/${FIXTURE_LUA_ENTRY_NAME}`;

// 8a. Lexer/parser: real calls only; comments/strings/definitions excluded.
const luaParse = parseLuaStaticSubset(FIXTURE_LUA_TEXT);
const callees = luaParse.calls.map((call) => `${call.callee}@${call.span.startLine}`);
check('L01/real-calls-only',
  luaParse.calls.length === 4
  && callees.includes('SetTalkFlag@3')
  && callees.includes('RequestAsset@4')
  && !callees.some((label) => label.includes('777') || label.includes('778')),
  `注释/字符串里的伪调用被当作真实调用或真实调用数不符：${JSON.stringify(callees)}`);
check('L02/function-def-not-call', !luaParse.calls.some((call) => call.span.startLine === 2),
  'local function 定义行被误判为调用（T06 步骤 6）');

// SetTalkFlag is shadowed by a local function → never a confirmed API ref.
const scriptGraph = buildScriptReferenceEdges(buildScriptBundle().scripts ?? []);
const scriptEdges = scriptGraph.edges;
check('L03/shadowed-local-not-api', luaParse.calls
  .filter((call) => call.callee === 'SetTalkFlag')
  .every((call) => call.isLocal),
  '被 local function 遮蔽的全局名未标记为局部（T06 步骤 6）');
check('L04/no-confirmed-edge-without-rule',
  !scriptEdges.some((edge) => edge.kind === 'invokes_script' && edge.confidence === 'high'),
  '没有受信任 API 规则时产生了 confirmed 脚本边（T06 步骤 7）');

// Bytecode child carries no source-derived calls and stays a distinct state.
const bytecodeUri = `${FIXTURE_LUABND_SOURCE}!/${FIXTURE_BYTECODE_ENTRY_NAME}`;
check('L05/bytecode-child-no-calls', !scriptGraph.callsByScriptUri.has(bytecodeUri)
  && scriptGraph.diagnostics.some((d) => d.code === 'SCRIPT_BYTECODE_NO_SOURCE'),
  '字节码子项被当作可解析源码或没有保留编码诊断（T06 步骤 1/3）');

// contains edges only from a complete catalog.
check('L06/contains-from-complete-catalog', scriptEdges.some((edge) =>
  edge.kind === 'contains' && edge.fromUri === FIXTURE_LUABND_SOURCE && edge.toUri === SCRIPT_URI),
  '完整目录未生成 contains 边（T06 步骤 2）');

// 8b. require resolution + dynamic/missing gaps.
const REQ_BND = `workspace://${FIXTURE_WORKSPACE_A}/mods/script/req.luabnd.dcx`;
const reqChild = (name: string, index: number, source?: string) => ({
  uri: `${REQ_BND}!/${name}`, sourceUri: REQ_BND, childChain: [name],
  entryIndex: index, entryName: name,
  ...(source !== undefined
    ? { contentKind: 'source', sourceText: source, sourceHash: fixtureHash(source) }
    : { contentKind: 'catalog-only' })
});
const reqSource = [
  'require "goal_list"',
  'local x = compute()',
  'require(x)',
  'require "missing_module"'
].join('\n');
const reqGraph = buildScriptReferenceEdges([{
  sourceUri: REQ_BND, containerKind: 'luabnd', catalogComplete: true,
  outerFileHash: fixtureHash('req'),
  scripts: [
    reqChild('main.lua', 0, reqSource),
    reqChild('goal_list.lua', 1)
  ]
} as never]);
check('R01/require-confirmed-edge', reqGraph.edges.some((edge) =>
  edge.kind === 'invokes_script' && edge.confidence === 'high'
  && edge.fromUri === `${REQ_BND}!/main.lua` && edge.toUri === `${REQ_BND}!/goal_list.lua`),
  '行为未实现：require 未在同容器完整目录中解析为 confirmed 边（T06 步骤 7/8）');
check('R02/require-dynamic-gap', reqGraph.diagnostics.some((d) =>
  d.code === 'SCRIPT_MODULE_ARG_DYNAMIC'),
  '行为未实现：变量参数的 require 未留下动态缺口（T06 步骤 7）');
check('R03/require-missing-target', reqGraph.diagnostics.some((d) =>
  d.code === 'SCRIPT_REQUIRE_TARGET_MISSING'),
  '行为未实现：目录中不存在的 require 目标未报告 missing（T06 步骤 1）');
check('R04/require-no-edge-for-missing', !reqGraph.edges.some((edge) =>
  edge.toUri === `${REQ_BND}!/missing_module.lua`),
  '为不存在的模块生成了边（T06 步骤 1：present 不能凭空拼接）');

// 8c. Partial catalog: no contains edges, coverage gap, existence unverified.
const partialGraph = buildScriptReferenceEdges([{
  sourceUri: REQ_BND, containerKind: 'luabnd', catalogComplete: false,
  outerFileHash: fixtureHash('req'),
  scripts: [reqChild('main.lua', 0, reqSource)]
} as never]);
check('C01/partial-catalog-no-contains', !partialGraph.edges.some((edge) => edge.kind === 'contains'),
  '目录未读全仍发布了 contains 边（T06 步骤 2）');
check('C02/partial-catalog-diagnostic', partialGraph.diagnostics.some((d) =>
  d.code === 'SCRIPT_CATALOG_INCOMPLETE'),
  '行为未实现：部分目录未报告覆盖缺口（T06 步骤 2）');
check('C03/partial-require-unverified', partialGraph.diagnostics.some((d) =>
  d.code === 'SCRIPT_REQUIRE_TARGET_UNVERIFIED'),
  '行为未实现：目录不全时 require 目标存在性未降为 unverified（T06 步骤 2）');

// 8d. Source span equals the real statement slice (T06 step 9).
const spanCall = luaParse.calls.find((call) => call.callee === 'RequestAsset');
const sliced = spanCall ? FIXTURE_LUA_TEXT.slice(spanCall.span.startOffset, spanCall.span.endOffset) : '';
check('S01/span-slice-equals-statement', sliced === 'RequestAsset("c1050_ai", 1)',
  `原文 span 切片与真实调用语句不等：${JSON.stringify(sliced)}`);

// 8e. Hypothesis channel never invents a child: c1050_ai.lua is NOT in the
// fixture catalog, so even opt-in must not claim presence (T06 step 1).
const hypoGraph = buildScriptReferenceEdges(buildScriptBundle().scripts ?? [], { includeHypotheses: true });
check('H01/hypothesis-no-invented-child', !hypoGraph.edges.some((edge) =>
  edge.kind === 'invokes_script' && edge.toUri.includes('c1050_ai')),
  'includeHypotheses 下按名称拼接出不存在的子项边（T06 步骤 1）');

/* ------------------------------------------------------------------ */
/* 9. Map provider + capability registry (T07).                         */
/* ------------------------------------------------------------------ */

const mapBundle = buildMapInstanceBundle();
const pairBundles = buildWorkspacePairBundles();
const mapRefs = buildMapReferenceEdges(mapBundle.maps ?? [], pairBundles.bundleA.params ?? []);
const mapEdges = mapRefs.edges;

// Only the entity with the native npcParamRowId foreign key connects; the
// sibling sharing the same model does not (steps 1-2).
check('M01/native-fk-only', mapEdges.filter((edge) => edge.kind === 'references_param_row').length === 1
  && mapEdges.some((edge) => edge.fromUri === `${FIXTURE_MAP_SOURCE}#entity/4194304`
    && edge.confidence === 'high'),
  '行为未实现：地图实例未按原生外键连接，或无外键的同模型实例被错误连接（T07 步骤 1/2）');
check('M02/instances-not-merged', mapRefs.stats.instances === 2,
  '同模型两个实例被合并计数（T07 步骤 2）');

// Duplicate entityId in one map → ambiguity, never a single-instance pick.
const dupEntityMap = buildMapInstanceBundle();
for (const exportItem of dupEntityMap.maps ?? []) {
  for (const entity of exportItem.entities) entity.entityId = 777;
}
const dupMapRefs = buildMapReferenceEdges(dupEntityMap.maps ?? [], []);
check('M03/duplicate-entityId-ambiguous', dupMapRefs.diagnostics.some((d) =>
  d.code === 'MAP_ENTITY_ID_AMBIGUOUS'),
  '行为未实现：重复 entityId 未返回歧义诊断（T07 通过条件）');

// Model-name prefix is hypothesis-only: default graph has no chr:// edge.
check('M04/prefix-hypothesis-default-off', !mapEdges.some((edge) => edge.toUri.startsWith('chr://')));
const hypoMapRefs = buildMapReferenceEdges(mapBundle.maps ?? [], [], { includeHypotheses: true });
check('M05/prefix-hypothesis-opt-in-low', hypoMapRefs.edges.some((edge) =>
  edge.toUri === 'chr://c1050' && edge.confidence === 'low' && edge.reason.startsWith('hypothesis(')),
  '行为未实现：模型名前缀未进入 includeHypotheses 的 low 假设通道（T07 步骤 7）');

// Capability registry: exhaustive over ALL_RESOURCE_KINDS, core domains real.
const capValidation = validateReferenceCapabilities();
check('CAP01/registry-exhaustive', capValidation.ok === true,
  `能力 registry 未穷举 ALL_RESOURCE_KINDS：${JSON.stringify(capValidation)}`);
check('CAP02/core-domains-supported',
  (['param', 'event', 'msg', 'script', 'map'] as const).every((kind) =>
    REFERENCE_CAPABILITIES[kind].status === 'supported'
    && REFERENCE_CAPABILITIES[kind].relationKinds.length > 0
    && REFERENCE_CAPABILITIES[kind].provider.includes('references/')),
  '核心域能力登记缺失或没有 provider（T07 步骤 11/12）');
check('CAP03/unsupported-has-reason', ALL_RESOURCE_KINDS.every((kind) =>
  REFERENCE_CAPABILITIES[kind].status !== 'unsupported'
  || REFERENCE_CAPABILITIES[kind].uncoveredReasons.length > 0),
  'unsupported 域没有写明未覆盖原因（T07 步骤 11）');

// TAE member_of + contains from the native child directory only.
const TAE_SRC = `workspace://${FIXTURE_WORKSPACE_A}/mods/action/c1050.anibnd.dcx`;
const taeGraph = buildContainerMemberEdges([{
  chrId: 'c1050', sourceUri: TAE_SRC, outerFileHash: fixtureHash('anibnd'),
  taeEntryCount: 2,
  taeEntries: [
    { entryIndex: 0, entryId: 100, entryName: 'a000_020000.tae', taeGroup: 'Attack', animationCount: 1, sourceSize: 512, sourceHash: fixtureHash('tae-0') },
    { entryIndex: 1, entryId: 101, entryName: 'a000_030000.tae', taeGroup: 'Move', animationCount: 1, sourceSize: 256, sourceHash: fixtureHash('tae-1') }
  ],
  animations: [
    { animId: 200, motionAnimId: 200, taeEntryIndex: 0, code: 'A0200', events: [] },
    { animId: 300, taeEntryIndex: 1, code: 'A0300', events: [] },
    { animId: 200, code: 'A0200-ghost', events: [] }
  ]
} as never], []);
check('T01/tae-contains-children', taeGraph.edges.filter((edge) =>
  edge.kind === 'contains' && edge.fromUri === TAE_SRC).length === 2,
  '行为未实现：TAE 原生子项目录未发布 contains 边（T07 步骤 10）');
check('T02/tae-member-by-entry-index', taeGraph.edges.some((edge) =>
  edge.kind === 'member_of' && edge.fromUri === `${TAE_SRC}#anim/200@0`
  && edge.toUri === `${TAE_SRC}#taeEntry/0`),
  '行为未实现：动画未按 taeEntryIndex 落到完整子项身份（T07 步骤 10）');
check('T03/tae-missing-child-unresolved', taeGraph.diagnostics.some((d) =>
  d.code === 'TAE_ANIM_CHILD_UNRESOLVED')
  && !taeGraph.edges.some((edge) => edge.fromUri === `${TAE_SRC}#anim/200@undefined`),
  '行为未实现：缺少子项身份的动作未产生 unresolved 诊断或生成了假边');

// MSGBND text entries get contains edges from the exported source grouping.
const msgGraph = buildContainerMemberEdges([], [{
  category: 'ItemName', outerFileHash: fixtureHash('msgbnd'),
  entries: [{
    uri: `${FIXTURE_MAP_SOURCE.replace(/msb.*/, '')}msg.fmg#ItemName/200`,
    sourceUri: 'workspace://ws/msg.fmg', category: 'ItemName', textId: 200, text: '修复虫'
  }]
} as never]);
check('T04/msgbnd-contains', msgGraph.edges.some((edge) =>
  edge.kind === 'contains' && edge.fromUri === 'workspace://ws/msg.fmg'),
  '行为未实现：msgbnd 目录未发布 contains 边（T07 步骤 10）');

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, checks, failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, checks, message: 'reference-query contract + behavior smoke passed' }, null, 2));
}

