/**
 * Production bridge: workspace-aware ToolRegistry -> agent loop contract.
 *
 * The agent loop (model-services) speaks {name, description,
 * parametersJsonSchema, supportsParallel} tool definitions plus a flat
 * executeTool callback. The production registry (ai/toolRegistry.ts) speaks
 * permission-gated typed ToolResults bound to a WorkspaceIndex. This module
 * adapts one to the other without duplicating policy: permission gating stays
 * in ToolRegistry.run, loop-level mode gating stays in agentLoop.
 *
 * Parallelism policy (Codex supports_parallel_tool_calls analogue): pure
 * read/analyze tools may run concurrently within one model turn; anything
 * that proposes, validates or rolls back stays exclusive. Results are
 * recorded in model emission order by the loop itself.
 *
 * Schema policy: each tool's model-facing parametersJsonSchema is *projected*
 * from the same ToolInputShape that ToolRegistry.run enforces at runtime
 * (toolInputShapeToJsonSchema). Before this, every tool advertised a bare
 * `{ type: 'object' }`, which told the model nothing about field names —
 * the model had to guess `q` vs `query`, `id` vs `textId`, and a wrong guess
 * came back as INVALID_INPUT with no way for the model to know the real name.
 * That was the root cause of unreliable tool calling, and it is exactly the
 * failure a projection cannot reintroduce: rename a field in the shape and
 * the advertised schema follows.
 */

import type { ToolCall, ToolDefinition as AgentToolDefinition } from '../model-services/types.js';
import { toolInputShapeToJsonSchema, type ToolContext, type ToolRegistry } from './toolRegistry.js';

export interface AgentToolBridgeOptions {
  registry: ToolRegistry;
  context: ToolContext;
  /** Re-read mutable host state before every tool call in a long-lived run. */
  contextProvider?: () => ToolContext;
  /**
   * @deprecated Kept for compatibility with older hosts. Discovery is no
   * longer blocked on a previous text query; the bridge returns a deterministic
   * candidate/native-evidence status and native read/write contracts enforce
   * the actual evidence boundary.
   */
  requireTextLookupBeforeStructuredDiscovery?: boolean;
}

export interface AgentToolBridge {
  tools: AgentToolDefinition[];
  /**
   * 执行一次工具调用。`contextOverride` 由宿主（main）在需要注入生产上下文的
   * 调用（如回滚：session / 生产 store / 备份目录 / 用户确认凭据）时提供，
   * 与桥闭包里的基础 context 浅合并；纯读工具调用不传即行为不变。
   */
  executeTool: (
    call: ToolCall,
    contextOverride?: Partial<ToolContext>
  ) => Promise<{ ok: boolean; content: string; code?: string }>;
}

const PARALLEL_SAFE_LEVELS = new Set(['read', 'analyze']);
const DISCOVERY_TOOLS = new Set([
  'search_resources',
  'search_param_rows',
  'search_param_fields',
  'search_map_entities',
  'search_events',
  'search_tae_events',
  'search_text_entries',
  'search_event_reference',
  'retrieve_evidence',
  'list_luabnd_scripts',
  'lookup_text_id'
]);
const NATIVE_READ_TOOLS = new Set([
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_outline',
  'read_emevd_event',
  'read_tae_events',
  'read_msb_parts',
  'read_luabnd_script',
  'query_map_objects',
  'inspect_map_object'
]);
const DISCOVERY_QUERY_TOOLS = new Set([
  'search_resources',
  'search_param_rows',
  'search_param_fields',
  'search_map_entities',
  'search_events',
  'search_tae_events',
  'search_text_entries',
  'search_event_reference',
  'retrieve_evidence',
  'list_luabnd_scripts'
]);
const PROPOSAL_TOOLS = new Set(['propose_text_patch', 'propose_plaintext_script_edit', 'build_patch_graph']);
const VALIDATION_TOOLS = new Set(['validate_patch', 'assess_edit_risk']);
const MUTATION_TOOLS = new Set([
  'commit_patch',
  'mutate_param_fields',
  'mutate_fmg_entries',
  'apply_emevd_dsl',
  'mutate_tae_event_times',
  'mutate_msb_part_transform',
  'mutate_luabnd_script',
  'batch_transform_map_objects',
  'import_map_from_blender'
]);

/**
 * Discovery/outline results are context, not a dump of the entire index or
 * native document. Keep the model-facing payload small and leave it enough
 * stable identifiers/cursors to request the next page explicitly.
 */
export const MAX_BOUNDED_TOOL_RESULT_CHARS = 8_192;
const BOUNDED_DISCOVERY_TOOLS = new Set([
  'search_resources',
  'search_events',
  'search_map_entities',
  'search_tae_events',
  'search_param_rows',
  'search_param_fields',
  'search_text_entries',
  'search_event_reference',
  'query_map_objects',
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_outline',
  'read_emevd_event',
  'read_msb_parts'
]);
const SUMMARY_ARRAY_LIMIT = 16;
const SUMMARY_STRING_LIMIT = 320;
const RESULT_ENVELOPE_DESCRIPTION =
  '返回固定结果 envelope：data、pagination、truncated、identifiers、evidence；大型结果只在 data.summary 中摘要，不能按原始 typed response 解读。evidence 只表示确定性来源状态，不是模型置信度分数。';

export type AgentEvidenceStatus = 'not_applicable' | 'candidate' | 'native-verified' | 'insufficient_evidence';
export type AgentEvidenceKind = 'discovery' | 'rag' | 'native-read' | 'proposal' | 'validation' | 'mutation' | 'memory' | 'other';

/**
 * Agent-facing evidence is a finite workflow state, not a probability. A
 * candidate can guide the next lookup, while only a native read carrying a
 * source hash can support a native edit boundary.
 */
export interface AgentEvidenceMetadata {
  status: AgentEvidenceStatus;
  kind: AgentEvidenceKind;
  sourceUris: string[];
  sourceHashes: string[];
  sourceRevisions: Array<number | string>;
  nextActions: string[];
  repeatedQuery: boolean;
}

export interface AgentToolResultEnvelope {
  ok: true;
  state: 'completed';
  data: {
    items: unknown[];
    record: Record<string, unknown> | null;
    scalar: string | number | boolean | null;
    summary: string | null;
  };
  pagination: {
    originalChars: number;
    returnedCount: number | null;
    totalCount: number | null;
    /** Native/logical result total when the tool exposes a page window. */
    total: number | null;
    /** Native/logical zero-based page offset when the tool exposes one. */
    offset: number | null;
    /** Native/logical page limit when the tool exposes one. */
    limit: number | null;
    /** Whether the underlying tool result has more data beyond this window. */
    truncated: boolean;
    cursors: Record<string, string>;
  };
  truncated: boolean;
  identifiers: string[];
  evidence: AgentEvidenceMetadata;
}

function summarizeToolValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return typeof value === 'string' ? value.slice(0, SUMMARY_STRING_LIMIT) : '[depth-limited]';
  if (typeof value === 'string') {
    return value.length > SUMMARY_STRING_LIMIT
      ? `${value.slice(0, SUMMARY_STRING_LIMIT)}…`
      : value;
  }
  if (Array.isArray(value)) {
    return {
      items: value.slice(0, SUMMARY_ARRAY_LIMIT).map((item) => summarizeToolValue(item, depth + 1)),
      returnedCount: Math.min(value.length, SUMMARY_ARRAY_LIMIT),
      totalCount: value.length,
      ...(value.length > SUMMARY_ARRAY_LIMIT ? { truncated: true } : {})
    };
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const output: Record<string, unknown> = {};
  for (const key of keys.slice(0, 64)) {
    output[key] = summarizeToolValue(record[key], depth + 1);
  }
  if (keys.length > 64) output.truncatedKeys = keys.length - 64;
  return output;
}

/**
 * A discovery result must remain useful after bounding.  The old generic
 * summarizer copied up to sixteen complete records (including a whole native
 * row/chunk body) and then copied up to 128 identifiers.  For real MSG/RAG
 * searches that could still exceed the 8 KiB contract, so the final fallback
 * discarded `data` entirely and left the model with opaque chunk IDs.  Keep a
 * small, field-aware projection instead: stable identity plus the text/body
 * excerpt needed to choose the next native read, while preserving the result
 * count and page cursor.
 */
const DISCOVERY_ARRAY_KEYS = new Set([
  'items', 'hits', 'matches', 'rows', 'entries', 'events', 'parts', 'entities',
  'results', 'fields', 'instructions', 'topics'
]);
const DISCOVERY_DETAIL_KEYS = new Set([
  'id', 'uri', 'sourceUri', 'sourcePath', 'relativePath', 'symbolUri', 'chunkId',
  'searchId',
  'family', 'title', 'body', 'excerpt', 'text', 'name', 'rowId', 'rowName',
  'paramName', 'textId', 'category', 'eventId', 'mapId', 'entityId', 'nativeOffset',
  'entryName', 'entryIndex',
  'file', 'model', 'score', 'vectorScore', 'reasons', 'highlights', 'fieldId',
  'fieldIds', 'value', 'valueType', 'description', 'nextCursor', 'cursor',
  'total', 'offset', 'limit', 'returned', 'truncated', 'instructionCount',
  'instructionOffset', 'instructionLimit', 'totalHits', 'totalCount', 'returnedCount',
  'availability', 'source', 'tool',
  'query', 'note', 'status', 'confidence', 'sourceHash', 'sourceRevision', 'numericIds',
  'item', 'chunk', 'row', 'event', 'format', 'darkScript', 'darkScriptComplete', 'machineInstructions',
  'instructionDto', 'index', 'bank', 'argsBase64', 'unknown', 'emedfName', 'typedArgs',
  'pagination', 'provenance', 'evidence', 'resourceKind', 'diagnostics'
]);
const DISCOVERY_ITEM_LIMIT = 6;
const DISCOVERY_NESTED_ARRAY_LIMIT = 8;
const DISCOVERY_STRING_LIMIT = 420;

function summarizeDiscoveryValue(value: unknown, itemLimit = DISCOVERY_ITEM_LIMIT, depth = 0): unknown {
  if (depth > 4) return summarizeToolValue(value, depth);
  if (Array.isArray(value)) {
    return {
      items: value.slice(0, itemLimit).map((item) => summarizeDiscoveryItem(item, depth + 1)),
      returnedCount: Math.min(value.length, itemLimit),
      totalCount: value.length,
      ...(value.length > itemLimit ? { truncated: true } : {})
    };
  }
  if (!value || typeof value !== 'object') return compactDiscoveryScalar(value);
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (DISCOVERY_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      output[key] = child.slice(0, itemLimit).map((item) => summarizeDiscoveryItem(item, depth + 1));
      output[`${key}ReturnedCount`] = Math.min(child.length, itemLimit);
      output[`${key}TotalCount`] = child.length;
      if (child.length > itemLimit) output[`${key}Truncated`] = true;
      continue;
    }
    if (!DISCOVERY_DETAIL_KEYS.has(key)) continue;
    output[key] = summarizeDiscoveryChild(child, depth + 1);
  }
  return output;
}

function summarizeDiscoveryItem(value: unknown, depth = 0): unknown {
  if (depth > 5) return summarizeToolValue(value, depth);
  if (!value || typeof value !== 'object') return compactDiscoveryScalar(value);
  if (Array.isArray(value)) {
    return value.slice(0, DISCOVERY_NESTED_ARRAY_LIMIT).map((item) => summarizeDiscoveryItem(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!DISCOVERY_DETAIL_KEYS.has(key)) continue;
    output[key] = summarizeDiscoveryChild(child, depth + 1);
  }
  return Object.keys(output).length > 0 ? output : summarizeToolValue(value, depth);
}

function summarizeDiscoveryChild(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, DISCOVERY_NESTED_ARRAY_LIMIT).map((item) => summarizeDiscoveryItem(item, depth + 1));
  }
  if (value && typeof value === 'object') return summarizeDiscoveryItem(value, depth);
  return compactDiscoveryScalar(value);
}

function compactDiscoveryScalar(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > DISCOVERY_STRING_LIMIT
      ? `${value.slice(0, DISCOVERY_STRING_LIMIT)}…`
      : value;
  }
  return value;
}

/**
 * An event read is an explicit, bounded native read rather than a broad
 * discovery listing.  The generic discovery projection keeps only the first
 * few array items, which is unsafe here: the instruction that matters may be
 * near the end of a 20-instruction event (for example DisplayBossHealthBar at
 * index 18).  Compact the event-specific fields while retaining every
 * instruction in the requested logical window.
 */
function summarizeEmevdEventValue(value: unknown, includeRawArgs: boolean): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.instructions)) return null;

  const output = summarizeDiscoveryValue(value, record.instructions.length, 0) as Record<string, unknown>;
  output.instructions = record.instructions.map((instruction) => {
    if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)) {
      return summarizeDiscoveryItem(instruction);
    }
    const source = instruction as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    for (const key of ['index', 'bank', 'id', 'unknown', 'emedfName', 'diagnostics']) {
      if (key in source) compact[key] = summarizeDiscoveryChild(source[key], 1);
    }
    if (includeRawArgs && typeof source.argsBase64 === 'string') compact.argsBase64 = source.argsBase64;
    if (Array.isArray(source.typedArgs)) {
      compact.typedArgs = source.typedArgs.map((arg) => {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return summarizeDiscoveryItem(arg);
        const argSource = arg as Record<string, unknown>;
        const argOutput: Record<string, unknown> = {};
        // Byte offsets are native-layout detail already represented by the
        // instruction's bank/id and are not needed for the model's DarkScript
        // decision. Keep every semantic argument name/type/value, including
        // parameter symbols used to identify entity/flag references.
        for (const key of ['name', 'type', 'value', 'parameterSymbol']) {
          if (key in argSource) argOutput[key] = summarizeDiscoveryChild(argSource[key], 2);
        }
        return argOutput;
      });
    }
    return compact;
  });
  if (typeof record.darkScript === 'string') output.darkScript = record.darkScript;
  return output;
}

function collectStableIdentifiers(value: unknown): { ids: string[]; cursors: Record<string, string> } {
  const ids: string[] = [];
  const cursors: Record<string, string> = {};
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.slice(0, 128).forEach((item) => walk(item, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === 'string') {
        if (/cursor|nextPage|pageToken/i.test(key)) cursors[key] = child;
        if (/^(?:id|.*Id|uri|sourceUri|opId|eventId|rowId|textId|tableId)$/i.test(key) && ids.length < 128) {
          ids.push(`${key}=${child}`);
        }
      } else if (typeof child === 'number' && Number.isFinite(child)) {
        // Native addresses commonly expose eventId/rowId/textId as numbers.
        // Stable summary IDs must preserve them just like their string form;
        // otherwise the final truncation branch loses the only follow-up key.
        if (/^(?:id|.*Id|uri|sourceUri|opId|eventId|rowId|textId|tableId)$/i.test(key) && ids.length < 128) {
          ids.push(`${key}=${child}`);
        }
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(value, 0);
  return { ids: [...new Set(ids)], cursors };
}

function normalizeEnvelopeData(
  value: unknown,
  summary: string | null
): AgentToolResultEnvelope['data'] {
  if (Array.isArray(value)) {
    return { items: value, record: null, scalar: null, summary };
  }
  if (value !== null && typeof value === 'object') {
    return { items: [], record: value as Record<string, unknown>, scalar: null, summary };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { items: [], record: null, scalar: value, summary };
  }
  return { items: [], record: null, scalar: null, summary };
}

function collectionCounts(value: unknown): { returnedCount: number | null; totalCount: number | null } {
  if (Array.isArray(value)) return { returnedCount: value.length, totalCount: value.length };
  if (!value || typeof value !== 'object') return { returnedCount: null, totalCount: null };
  const record = value as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items : undefined;
  const returnedCount = typeof record.returnedCount === 'number'
    ? record.returnedCount
    : items ? items.length : null;
  const totalCount = typeof record.totalCount === 'number' ? record.totalCount : returnedCount;
  return { returnedCount, totalCount };
}

interface ResultWindowMetadata {
  total: number | null;
  offset: number | null;
  limit: number | null;
  returned: number | null;
  truncated: boolean;
}

function safeMetadataNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstMetadataNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = safeMetadataNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Preserve a tool's own logical page window separately from the bridge's byte
 * budget.  This is especially important for read_emevd_event: a native page
 * can be complete for the requested window while still being only a prefix of
 * the event, and the model must see both facts after the bounded projection.
 */
function resultWindowMetadata(value: unknown): ResultWindowMetadata {
  if (Array.isArray(value)) {
    return {
      total: value.length,
      offset: 0,
      limit: value.length,
      returned: value.length,
      truncated: false
    };
  }
  if (!value || typeof value !== 'object') {
    return { total: null, offset: null, limit: null, returned: null, truncated: false };
  }
  const record = value as Record<string, unknown>;
  const total = firstMetadataNumber(record, ['total', 'instructionCount', 'totalCount', 'totalHits']);
  const offset = firstMetadataNumber(record, ['offset', 'instructionOffset']);
  const limit = firstMetadataNumber(record, ['limit', 'instructionLimit']);
  const returned = firstMetadataNumber(record, ['returned', 'returnedCount'])
    ?? (Array.isArray(record.instructions)
      ? record.instructions.length
      : Array.isArray(record.items) ? record.items.length : null);
  const inferredTruncated = total !== null && offset !== null && returned !== null
    ? offset + returned < total
    : false;
  return {
    total,
    offset,
    limit,
    returned,
    truncated: typeof record.truncated === 'boolean' ? record.truncated : inferredTruncated
  };
}

function collectEvidenceFacts(value: unknown): Pick<AgentEvidenceMetadata, 'sourceUris' | 'sourceHashes' | 'sourceRevisions'> {
  const sourceUris = new Set<string>();
  const sourceHashes = new Set<string>();
  const sourceRevisions = new Set<number | string>();
  const seen = new Set<object>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.slice(0, 128).forEach((item) => walk(item, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const normalizedKey = key.toLocaleLowerCase();
      if (normalizedKey === 'sourceuri' && typeof child === 'string' && child.trim() !== '') {
        sourceUris.add(child.trim().slice(0, 512));
      } else if (normalizedKey === 'sourcehash' && typeof child === 'string' && child.trim() !== '') {
        sourceHashes.add(child.trim().slice(0, 256));
      } else if (normalizedKey === 'sourcerevision'
        && ((typeof child === 'number' && Number.isFinite(child))
          || (typeof child === 'string' && child.trim() !== ''))) {
        sourceRevisions.add(typeof child === 'string' ? child.trim().slice(0, 256) : child);
      }
      walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return {
    sourceUris: [...sourceUris].slice(0, 16),
    sourceHashes: [...sourceHashes].slice(0, 16),
    sourceRevisions: [...sourceRevisions].slice(0, 16)
  };
}

function hasMeaningfulResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  for (const key of [
    'items',
    'hits',
    'entries',
    'matches',
    'rows',
    'events',
    'parts',
    'entities',
    'matchedEntities',
    'results',
    'topics',
    'fields'
  ]) {
    if (Array.isArray(record[key]) && record[key]!.length > 0) return true;
  }
  return ['totalHits', 'totalCount', 'matchedCount', 'returnedCount'].some((key) => (
    typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] > 0
  ));
}

function buildEvidenceMetadata(name: string, data: unknown, repeatedQuery = false): AgentEvidenceMetadata {
  const facts = collectEvidenceFacts(data);
  if (DISCOVERY_TOOLS.has(name)) {
    const hasHits = hasMeaningfulResult(data);
    const isRag = name === 'retrieve_evidence';
    return {
      ...facts,
      status: hasHits ? 'candidate' : 'insufficient_evidence',
      kind: isRag ? 'rag' : 'discovery',
      nextActions: hasHits
        ? discoveryNextActions(name, repeatedQuery)
        : name === 'search_param_fields'
          ? [
              '当前字段语义查询没有命中；不能调用 read_param_fields，因为没有真实 fieldId。改用 health/hp、elite/boss、hostile/team/target、lightning/effect 或 drop/reward/item 等字段语义词重新检索。'
            ]
          : [
              repeatedQuery
                ? '已执行相同或语义相近的查询；不要原样重试，改用另一条对象解析路径或原生读取。'
                : '当前查询没有命中；这只结束本次查询，不代表对象不存在。继续使用正式名称、参数备注、数字 ID、资源来源或引用关系定位。'
            ],
      repeatedQuery
    };
  }
  if (NATIVE_READ_TOOLS.has(name)) {
    const nativeVerified = facts.sourceHashes.length > 0;
    return {
      ...facts,
      status: nativeVerified ? 'native-verified' : 'insufficient_evidence',
      kind: 'native-read',
      nextActions: nativeVerified
        ? ['已取得带 sourceHash 的原生快照；写入前仍须使用该哈希和 sourceRevision 做前置条件校验。']
        : ['原生读取没有返回 sourceHash，不能把本次结果作为写入前置依据。'],
      repeatedQuery: false
    };
  }
  if (PROPOSAL_TOOLS.has(name)) {
    return {
      ...facts,
      status: 'candidate',
      kind: 'proposal',
      nextActions: ['这是候选方案，不是已写入结果；先完成原生读取、校验和用户确认，再进入写入。'],
      repeatedQuery: false
    };
  }
  if (VALIDATION_TOOLS.has(name)) {
    return {
      ...facts,
      status: 'not_applicable',
      kind: 'validation',
      nextActions: ['校验结果只说明当前补丁检查结果；原生格式仍须保留 sourceHash/sourceRevision 并在写入后回读。'],
      repeatedQuery: false
    };
  }
  if (MUTATION_TOOLS.has(name)) {
    return {
      ...facts,
      status: 'not_applicable',
      kind: 'mutation',
      nextActions: ['写入完成后必须原生回读目标资源，确认语义、哈希变化和可回滚记录。'],
      repeatedQuery: false
    };
  }
  if (name === 'list_memories' || name === 'read_memory') {
    return {
      ...facts,
      status: 'not_applicable',
      kind: 'memory',
      nextActions: [],
      repeatedQuery: false
    };
  }
  return {
    ...facts,
    status: 'not_applicable',
    kind: 'other',
    nextActions: [],
    repeatedQuery: false
  };
}

function discoveryNextActions(name: string, repeatedQuery: boolean): string[] {
  if (repeatedQuery) {
    return [
      '已命中相同或语义相近的定位词；停止重复同义词搜索，停止继续扩大同一路径，改用另一类资源或已有结果的稳定 ID/sourceUri。'
    ];
  }
  if (name === 'search_text_entries') {
    return [
      '这是 MSG/FMG 候选；读取返回的 textId/category/sourceUri，并与 PARAM 行名交叉比对。',
      'textId 不等于 NpcParam、EquipParamGoods 或 ItemLotParam 的 rowId。'
    ];
  }
  if (name === 'search_param_rows') {
    return [
      '这是 PARAM 候选；优先使用返回的 paramName、rowName、fieldId、字段显示名/备注和 sourceUri。',
      '如果结果没有 fieldId，下一步先用同一 table/rowIds 调用 search_param_fields，并使用 health/hp、elite/boss、hostile/team/target、lightning/effect 或 drop/reward/item 等字段语义词；拿到真实 fieldId 后再调用 read_param_fields。'
    ];
  }
  if (name === 'search_param_fields') {
    return [
      '这是授信 PARAM 字段元数据候选；使用返回的真实 fieldId 继续 read_param_fields。',
      '如果 fields 为空，不能调用 read_param_fields；改用 health/hp、elite/boss、hostile/team/target、lightning/effect 或 drop/reward/item 等字段语义词重新检索。',
      '本工具不读取或写入字段值，不能替代原生字段读取。'
    ];
  }
  if (name === 'search_map_entities') {
    return [
      '这是地图候选；使用返回的实体稳定地址和 sourceUri 继续读取 MSB。',
      '不要把逻辑地图 ID 直接当作 MSB file 参数。'
    ];
  }
  if (name === 'search_event_reference') {
    return [
      '这是社区事件经验提供的语义参考，可用于组织方案；使用返回的 instruction 名称继续 search_events。',
      '再用 search_events 的 file/eventId 和 read_emevd_outline/native EMEDF 确认当前事件身份、指令签名、参数及真实事件关系。'
    ];
  }
  return [
    '候选结果不是写入依据；使用返回的稳定 ID/sourceUri 转入结构化查询或原生读取。'
  ];
}

function createResultEnvelope(
  data: unknown,
  originalChars: number,
  truncated: boolean,
  summary: string | null,
  identifiers = collectStableIdentifiers(data),
  evidence = buildEvidenceMetadata('unknown', data),
  window = resultWindowMetadata(data)
): AgentToolResultEnvelope {
  const counts = collectionCounts(data);
  return {
    ok: true,
    state: 'completed',
    data: normalizeEnvelopeData(data, summary),
    pagination: {
      originalChars,
      returnedCount: window.returned ?? counts.returnedCount,
      totalCount: window.total ?? counts.totalCount,
      total: window.total,
      offset: window.offset,
      limit: window.limit,
      truncated: window.truncated,
      cursors: identifiers.cursors
    },
    truncated,
    identifiers: identifiers.ids,
    evidence
  };
}

function compactIdentifiers(
  identifiers: { ids: string[]; cursors: Record<string, string> }
): { ids: string[]; cursors: Record<string, string> } {
  return {
    ids: identifiers.ids.slice(0, 12).map((id) => id.slice(0, 160)),
    cursors: Object.fromEntries(Object.entries(identifiers.cursors).slice(0, 8)
      .map(([key, value]) => [key, value.slice(0, 160)]))
  };
}

function truncationSummary(name: string, window: ResultWindowMetadata, byteBounded: boolean): string | null {
  const messages: string[] = [];
  if (byteBounded) {
    messages.push(`工具 ${name} 输出过大，已返回摘要；请使用返回的 ID 或游标继续分页查询。`);
  }
  if (window.truncated) {
    const details = [
      window.total === null ? null : `total=${window.total}`,
      window.offset === null ? null : `offset=${window.offset}`,
      window.limit === null ? null : `limit=${window.limit}`,
      window.returned === null ? null : `returned=${window.returned}`
    ].filter((value): value is string => value !== null).join(', ');
    messages.push(details.length > 0
      ? `底层工具结果已分页（${details}），剩余数据需要继续请求后续窗口。`
      : '底层工具结果已分页，剩余数据需要继续请求后续窗口。');
  }
  return messages.length > 0 ? messages.join('；') : null;
}

function boundedToolContent(name: string, data: unknown, repeatedQuery = false): string {
  const evidence = buildEvidenceMetadata(name, data, repeatedQuery);
  const raw = JSON.stringify({ ok: true, state: 'completed', data: data ?? null, evidence });
  const identifiers = collectStableIdentifiers(data);
  const window = resultWindowMetadata(data);
  const byteBounded = BOUNDED_DISCOVERY_TOOLS.has(name) && raw.length > MAX_BOUNDED_TOOL_RESULT_CHARS;
  if (!byteBounded) {
    const sourceSummary = truncationSummary(name, window, false);
    return JSON.stringify(createResultEnvelope(
      data,
      raw.length,
      window.truncated,
      sourceSummary,
      identifiers,
      evidence,
      window
    ));
  }
  const summaryText = truncationSummary(name, window, true) ?? '工具输出已截断；请继续分页查询。';
  const compactIdentity = compactIdentifiers(identifiers);
  if (name === 'read_emevd_event') {
    // Preserve the complete requested instruction window even when verbose
    // typed arguments make the ordinary 8 KiB discovery projection overflow.
    // The second variant drops only redundant raw bytes; names and typed
    // values remain available for cross-file reasoning and safe DSL edits.
    for (const includeRawArgs of [true, false]) {
      const summary = summarizeEmevdEventValue(data, includeRawArgs);
      if (summary === null) break;
      const summarizedEnvelope = createResultEnvelope(
        summary,
        raw.length,
        window.truncated,
        window.truncated
          ? summaryText
          : '工具输出超过字节预算，已压缩冗余字段但保留当前事件窗口的全部指令。',
        compactIdentity,
        evidence,
        window
      );
      const encoded = JSON.stringify(summarizedEnvelope);
      if (encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
    }
  }
  // Try progressively smaller candidate sets.  A single native row/chunk can
  // be wide, but the first few stable candidates are more useful than an
  // opaque "truncated" result with no data at all.
  for (const itemLimit of [DISCOVERY_ITEM_LIMIT, 4, 2]) {
    const summary = summarizeDiscoveryValue(data, itemLimit);
    const summarizedEnvelope = createResultEnvelope(
      summary,
      raw.length,
      true,
      summaryText,
      compactIdentity,
      evidence,
      window
    );
    const encoded = JSON.stringify(summarizedEnvelope);
    if (encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
  }
  // Keep the same envelope even when the identifier-rich summary itself is
  // too large. The compact form retains the first stable follow-up keys.
  const compact = compactIdentifiers(identifiers);
  const compactEnvelope = createResultEnvelope(
    null,
    raw.length,
    true,
    `工具 ${name} 输出已截断；请使用 identifiers 或 pagination.cursors 继续查询。`,
    compact,
    evidence,
    window
  );
  const compactEncoded = JSON.stringify(compactEnvelope);
  if (compactEncoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return compactEncoded;

  return JSON.stringify(createResultEnvelope(
    null,
    raw.length,
    true,
    `工具 ${name} 输出已截断；请继续分页查询。`,
    { ids: [], cursors: {} },
    evidence,
    window
  ));
}

export function createAgentToolBridge(options: AgentToolBridgeOptions): AgentToolBridge {
  const { registry, context } = options;
  const attemptedDiscoveryQueries: DiscoveryQueryRecord[] = [];
  const tools: AgentToolDefinition[] = registry.list().map((descriptor) => ({
    name: descriptor.name,
    // Every successful result is normalized by boundedToolContent, not only
    // discovery results.  The model must therefore receive the envelope
    // contract for switch_mode, proposals, and mutations as well.
    description: `${descriptor.description} ${RESULT_ENVELOPE_DESCRIPTION}`,
    parametersJsonSchema: toolInputShapeToJsonSchema(descriptor.inputSchema),
    // Carried through so the loop's approval gate can group by severity from
    // the registry's own declaration instead of guessing from the name.
    permissionLevel: descriptor.permissionLevel ?? 'read',
    supportsParallel: PARALLEL_SAFE_LEVELS.has(descriptor.permissionLevel ?? 'read')
  }));

  const executeTool = async (
    call: ToolCall,
    contextOverride?: Partial<ToolContext>
  ): Promise<{ ok: boolean; content: string; code?: string }> => {
    let input: unknown = {};
    try {
      input = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson);
    } catch {
      return {
        ok: false,
        code: 'TOOL_INPUT_INVALID',
        content: JSON.stringify({
          ok: false,
          error: { code: 'TOOL_INPUT_INVALID', message: '工具参数不是有效 JSON。' }
        })
      };
    }
    const dynamicContext = options.contextProvider?.();
    const effectiveContext: ToolContext = {
      ...context,
      ...(dynamicContext ?? {}),
      ...contextOverride
    };
    // Optional fields need an explicit delete when the live host no longer
    // has them.  Otherwise a stale initial session/RAG snapshot survives the
    // shallow merge for the rest of the Agent run.
    if (dynamicContext) {
      if (dynamicContext.rag === undefined) delete effectiveContext.rag;
      if (dynamicContext.session === undefined) delete effectiveContext.session;
      if (dynamicContext.operationLogStore === undefined) delete effectiveContext.operationLogStore;
      if (dynamicContext.backupBaseDir === undefined) delete effectiveContext.backupBaseDir;
      if (dynamicContext.recoveryDir === undefined) delete effectiveContext.recoveryDir;
    }
    const result = await registry.run(call.name, input, effectiveContext);
    if (effectiveContext.mode && effectiveContext.mode !== context.mode) {
      context.mode = effectiveContext.mode;
    }
    if (result.ok) {
      let repeatedQuery = false;
      if (DISCOVERY_QUERY_TOOLS.has(call.name)) {
        const current = makeDiscoveryQueryRecord(call.name, input, result.data);
        if (current) {
          repeatedQuery = attemptedDiscoveryQueries.some((previous) => (
            previous.scope === current.scope
            && previous.terms.some((previousTerm) => current.terms.some((term) => areSimilarEvidenceTerms(previousTerm, term)))
          ));
          attemptedDiscoveryQueries.push(current);
          if (attemptedDiscoveryQueries.length > 64) attemptedDiscoveryQueries.shift();
        }
      }
      return { ok: true, content: boundedToolContent(call.name, result.data, repeatedQuery) };
    }
    return {
      ok: false,
      code: result.error?.code ?? 'TOOL_FAILED',
      content: JSON.stringify({
        ok: false,
        state: 'failed',
        error: result.error ?? { code: 'TOOL_FAILED', message: '工具执行失败。' }
      })
    };
  };

  return { tools, executeTool };
}

interface DiscoveryQueryRecord {
  scope: string;
  terms: string[];
}

function makeDiscoveryQueryRecord(name: string, input: unknown, data: unknown): DiscoveryQueryRecord | null {
  const terms = collectDiscoveryTerms(input, data);
  if (terms.length === 0) return null;
  return { scope: discoveryQueryScope(name, input), terms };
}

function discoveryQueryScope(name: string, input: unknown): string {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  if (name === 'search_text_entries') return `text:${String(record.category ?? '')}`.toLocaleLowerCase();
  if (name === 'search_param_rows') {
    const tables = Array.isArray(record.paramNames)
      ? record.paramNames.filter((item): item is string => typeof item === 'string').map((item) => normalizeEvidenceTerm(item)).sort()
      : [];
    return `param:${tables.join(',')}`;
  }
  if (name === 'search_resources') {
    const kinds = Array.isArray(record.kinds)
      ? record.kinds.filter((item): item is string => typeof item === 'string').map((item) => normalizeEvidenceTerm(item)).sort()
      : [];
    return `resource:${kinds.join(',')}`;
  }
  return name;
}

function collectDiscoveryTerms(input: unknown, data: unknown): string[] {
  const terms = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const normalized = normalizeEvidenceTerm(value);
    if (normalized.length >= 2) terms.add(normalized);
  };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const query = (input as Record<string, unknown>).query;
    if (typeof query === 'string') collect(query);
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.slice(0, 32).forEach((item) => walk(item, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (/^(?:query|text|rowName|name|paramName|mapId|model|category|title)$/i.test(key)) collect(child);
      else if (typeof child === 'object') walk(child, depth + 1);
    }
  };
  walk(data, 0);
  return [...terms].slice(0, 32);
}

function areSimilarEvidenceTerms(left: string, right: string): boolean {
  const normalizedLeft = normalizeEvidenceTerm(left);
  const normalizedRight = normalizeEvidenceTerm(right);
  if (normalizedLeft.length < 2 || normalizedRight.length < 2) return false;
  if (normalizedLeft === normalizedRight
    || normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft)) return true;

  // Chinese display names frequently differ by a shortened or alternate
  // character. This is a non-blocking hint only: it stops the model from
  // wasting calls on the same semantic lookup without rejecting a useful
  // cross-reference lookup.
  const leftHan = [...normalizedLeft].filter((char) => /\p{Script=Han}/u.test(char));
  const rightHan = [...normalizedRight].filter((char) => /\p{Script=Han}/u.test(char));
  if (leftHan.length < 3 || rightHan.length < 3) return false;
  const rightSet = new Set(rightHan);
  const overlap = new Set(leftHan.filter((char) => rightSet.has(char))).size;
  return overlap >= Math.max(2, Math.ceil(Math.min(leftHan.length, rightHan.length) / 2));
}

function normalizeEvidenceTerm(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_#:/\\.-]+/gu, '');
}
