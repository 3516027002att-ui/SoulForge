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
import {
  utf8CodepointPrefix,
  defaultReadSessionManager,
  createOpaqueCursor,
  parseOpaqueCursor,
  type NativeReadCompleteness,
  type NativeEditDomain
} from '@soulforge/shared';
import {
  toolInputShapeToJsonSchema,
  type HostResolvedEmevdEventTarget,
  type ToolContext,
  type ToolRegistry,
  type ToolResult
} from './toolRegistry.js';
import {
  projectEvidenceClaims,
  type EvidenceClaim
} from '../model-services/evidenceIdentity.js';
import { evidenceKey } from '../model-services/evidenceSelection.js';
import { encodeEvidenceClaims, type EvidenceClaimsTransport } from '../model-services/evidenceTransport.js';

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
export const MAX_BOUNDED_TOOL_RESULT_BYTES = 8_192;
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
  'read_msb_parts',
  'export_map_for_blender'
]);
const SUMMARY_ARRAY_LIMIT = 16;
const SUMMARY_STRING_LIMIT = 320;
const RESULT_ENVELOPE_DESCRIPTION =
  '返回固定结果 envelope：state、data、pagination、truncated、identifiers、evidence；state=committed 表示事务已落盘，verification_failed 表示已落盘但原生复读失败，不能按普通失败重试；大型结果只在 data.summary 中摘要，不能按原始 typed response 解读。evidence 只表示确定性来源状态，不是模型置信度分数。evidence.claimDefaults 是各条 claims 共用的完整字段（identity 按属性合并），单条字段覆盖默认值；省略的 key/resourceKey 可由完整 identity 无损重建。';

export type AgentEvidenceStatus = 'not_applicable' | 'candidate' | 'native-verified' | 'insufficient_evidence';
export type AgentEvidenceKind = 'discovery' | 'rag' | 'native-read' | 'proposal' | 'validation' | 'mutation' | 'memory' | 'other';
export type AgentToolSuccessState = 'completed' | 'staged' | 'committed' | 'verification_failed'
  | 'unsupported' | 'ambiguous' | 'stale' | 'cancelled' | 'insufficient_evidence';

/**
 * Agent-facing evidence is a finite workflow state, not a probability. A
 * candidate can guide the next lookup, while only a native read carrying a
 * source hash can support a native edit boundary.
 */
export interface AgentEvidenceMetadata extends EvidenceClaimsTransport {
  status: AgentEvidenceStatus;
  kind: AgentEvidenceKind;
  sourceUris: string[];
  sourceHashes: string[];
  sourceRevisions: Array<number | string>;
  nextActions: string[];
  repeatedQuery: boolean;
  /** Typed claim projections; raw result remains in the tool message/rollout. */
}

export interface AgentToolResultEnvelope {
  ok: true;
  state: AgentToolSuccessState;
  data: {
    items: unknown[];
    record: Record<string, unknown> | null;
    scalar: string | number | boolean | null;
    summary: string | null;
  };
  pagination: {
    originalChars: number;
    originalBytes?: number;
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
    continuationParams?: Record<string, unknown>;
  };
  completeness?: NativeReadCompleteness;
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
  'results', 'fields', 'instructions', 'topics', 'models'
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
  'query', 'note', 'status', 'confidence', 'sourceHash', 'outerFileHash', 'sourceRevision', 'numericIds',
  'item', 'chunk', 'row', 'event', 'format', 'darkScript', 'darkScriptComplete', 'machineInstructions',
  'instructionDto', 'index', 'bank', 'argsBase64', 'unknown', 'emedfName', 'typedArgs',
  'pagination', 'provenance', 'evidence', 'resourceKind', 'diagnostics',
  'severity', 'code', 'message',
  // Committed mutation lifecycle is deliberately small but must survive the
  // bounded projection: the loop uses it to keep a failed post-commit refresh
  // sticky, even when the raw write result contains a very large identity list.
  'operationId', 'opId', 'transactionId', 'lifecycle', 'transaction',
  'nativeVerification', 'knowledgeRefresh', 'outputBudget', 'identityBytes', 'maxBytes'
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
      ? `${utf8CodepointPrefix(value, DISCOVERY_STRING_LIMIT)}…`
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
  // Native DTOs carry the physical absolute path for the Patch Engine. That
  // identity is host-only; the model-facing event result must expose only a
  // safe relative locator (normally recovered from the already-sanitized
  // sourceUri). Do this on the event-specific path as well as in the complete
  // projection, because a large/partial read may use this summary instead.
  redactEmevdPhysicalLocators(output, record);
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

function buildEvidenceClaims(
  name: string,
  data: unknown,
  context?: ToolContext
): EvidenceClaim[] {
  const root = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : { items: Array.isArray(data) ? data : [data] };
  const workspaceId = context?.session?.meta.workspaceId
    ?? context?.workspaceIndex?.workspaceId
    ?? (typeof root.workspaceId === 'string' ? root.workspaceId : undefined);
  if (!workspaceId) return [];
  const native = NATIVE_READ_TOOLS.has(name);
  const nativeVerified = collectEvidenceFacts(data).sourceHashes.length > 0;
  const authorityClass: EvidenceClaim['authorityClass'] = native
    ? 'native'
    : DISCOVERY_TOOLS.has(name) ? 'candidate' : undefined;
  const authority = native ? 3 : DISCOVERY_TOOLS.has(name) ? 1 : 0;
  const claims = projectEvidenceClaims(root, {
    workspaceId,
    domain: /param/i.test(name)
      ? 'param'
      : /fmg|text/i.test(name)
        ? 'fmg'
        : /emevd|event/i.test(name)
          ? 'emevd'
          : /tae|animation/i.test(name)
            ? 'tae'
            : /map|msb/i.test(name)
              ? 'map'
              : /lua|script/i.test(name) ? 'script' : 'evidence',
    authorityClass,
    authority,
    versionState: nativeVerified ? 'current' : 'candidate',
    observationSequence: Date.now()
  });
  return claims.map((claim) => ({
    ...claim,
    key: evidenceKey(claim.identity),
    ...(authorityClass ? { authorityClass } : {}),
    authority,
    versionState: nativeVerified ? 'current' : 'candidate',
    // Requiredness is always computed by the host plan, never from a model
    // result or arbitrary tool payload.
    required: false
  }));
}

function buildEvidenceMetadata(
  name: string,
  data: unknown,
  repeatedQuery = false,
  context?: ToolContext
): AgentEvidenceMetadata {
  const facts = collectEvidenceFacts(data);
  const claims = buildEvidenceClaims(name, data, context);
  const withClaims = <T extends AgentEvidenceMetadata>(metadata: T): T => (
    claims.length > 0 ? { ...metadata, ...encodeEvidenceClaims(claims) } : metadata
  );
  if (DISCOVERY_TOOLS.has(name)) {
    const hasHits = hasMeaningfulResult(data);
    const isRag = name === 'retrieve_evidence';
    return withClaims({
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
    });
  }
  if (NATIVE_READ_TOOLS.has(name)) {
    const nativeVerified = facts.sourceHashes.length > 0;
    return withClaims({
      ...facts,
      status: nativeVerified ? 'native-verified' : 'insufficient_evidence',
      kind: 'native-read',
      nextActions: nativeVerified
        ? ['已取得带 sourceHash 的原生快照；写入前仍须使用该哈希和 sourceRevision 做前置条件校验。']
        : ['原生读取没有返回 sourceHash，不能把本次结果作为写入前置依据。'],
      repeatedQuery: false
    });
  }
  if (PROPOSAL_TOOLS.has(name)) {
    return withClaims({
      ...facts,
      status: 'candidate',
      kind: 'proposal',
      nextActions: ['这是候选方案，不是已写入结果；先完成原生读取、校验和用户确认，再进入写入。'],
      repeatedQuery: false
    });
  }
  if (VALIDATION_TOOLS.has(name)) {
    return withClaims({
      ...facts,
      status: 'not_applicable',
      kind: 'validation',
      nextActions: ['校验结果只说明当前补丁检查结果；原生格式仍须保留 sourceHash/sourceRevision 并在写入后回读。'],
      repeatedQuery: false
    });
  }
  if (MUTATION_TOOLS.has(name)) {
    return withClaims({
      ...facts,
      status: 'not_applicable',
      kind: 'mutation',
      nextActions: ['写入完成后必须原生回读目标资源，确认语义、哈希变化和可回滚记录。'],
      repeatedQuery: false
    });
  }
  if (name === 'list_memories' || name === 'read_memory') {
    return withClaims({
      ...facts,
      status: 'not_applicable',
      kind: 'memory',
      nextActions: [],
      repeatedQuery: false
    });
  }
  return withClaims({
    ...facts,
    status: 'not_applicable',
    kind: 'other',
    nextActions: [],
    repeatedQuery: false
  });
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
  window = resultWindowMetadata(data),
  state: AgentToolSuccessState = 'completed',
  completenessOverride?: NativeReadCompleteness
): AgentToolResultEnvelope {
  const counts = collectionCounts(data);
  let continuationParams: Record<string, unknown> | undefined;
  if (window.truncated && window.offset !== null && window.returned !== null) {
    continuationParams = {
      instructionOffset: window.offset + window.returned,
      instructionLimit: window.limit ?? window.returned,
      offset: window.offset + window.returned,
      limit: window.limit ?? window.returned
    };
  }
  const completeness: NativeReadCompleteness = completenessOverride
    ?? (window.truncated
      ? (window.offset !== null ? 'windowed' : 'partial')
      : (summary ? 'summary_only' : 'complete'));

  return {
    ok: true,
    state,
    data: normalizeEnvelopeData(data, summary),
    pagination: {
      originalChars,
      ...(typeof data === 'string' ? { originalBytes: Buffer.byteLength(data, 'utf8') } : {}),
      returnedCount: window.returned ?? counts.returnedCount,
      totalCount: window.total ?? counts.totalCount,
      total: window.total,
      offset: window.offset,
      limit: window.limit,
      truncated: window.truncated,
      cursors: identifiers.cursors,
      ...(continuationParams ? { continuationParams } : {})
    },
    completeness,
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

const COMMITTED_STATES = new Set<AgentToolSuccessState>(['committed', 'verification_failed']);
const COMMITTED_PROJECTION_KEYS = new Set([
  'operationId', 'opId', 'transactionId', 'sourceUri', 'sourcePath', 'file', 'containerPath',
  'resourceKind', 'rowId', 'eventId', 'textId', 'table', 'entryName',
  // `lifecycle` is the structured post-commit state emitted by mutation
  // handlers.  It must be projected as a parent key; otherwise the recursive
  // whitelist silently drops the transaction/native-verification state exactly
  // when the identity budget is exceeded.
  'lifecycle', 'transaction', 'nativeVerification', 'knowledgeRefresh', 'status', 'code', 'message', 'error',
  'sourceHash', 'outerHash', 'payloadHash', 'sourceRevision', 'revision', 'readback',
  'nativeReadback', 'verification', 'details', 'changedSources', 'sourceUris', 'semanticState',
  'invalidated', 'diagnostics'
]);
const COMMITTED_HASH_KEYS = new Set(['sourceHash', 'outerHash', 'payloadHash']);
const COMMITTED_STRING_MAX = 1_024;
const COMMITTED_LOCATOR_MAX_BYTES = 512;
const COMMITTED_STATUS_MAX_CHARS = 64;

function compactCommittedStatusValue(
  value: unknown,
  allowed: ReadonlySet<string>
): string | { status: string } | undefined {
  const status = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).status
      : undefined;
  if (typeof status !== 'string' || status.length === 0) return undefined;
  const normalized = status.length <= COMMITTED_STATUS_MAX_CHARS && allowed.has(status)
    ? status
    : 'unknown';
  return typeof value === 'string' ? normalized : { status: normalized };
}

const KNOWLEDGE_REFRESH_STATUSES = new Set([
  'completed', 'not_requested', 'converged', 'partial', 'invalidated', 'failed', 'preserved', 'degraded', 'unknown'
]);
const NATIVE_VERIFICATION_STATUSES = new Set([
  'verified', 'failed', 'stale', 'unverified', 'partial', 'unknown'
]);

function completeCommittedLocator(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Handles are opaque.  Keep the complete value only when it is small
  // enough; never slice a locator into a value that looks actionable.
  return Buffer.byteLength(value, 'utf8') <= COMMITTED_LOCATOR_MAX_BYTES ? value : undefined;
}

/**
 * Keep a committed/verification-failed result actionable after the identity
 * budget is exceeded. This is intentionally a whitelist, not a raw copy: the
 * model gets the transaction state, operation/reread locator, and structured
 * budget diagnostic, while large source/version collections stay omitted.
 */
function summarizeCommittedLifecycleValue(
  data: unknown,
  identityBytes: number
): Record<string, unknown> {
  const source = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const omittedKeys: string[] = [];
  const project = (value: unknown, key: string, depth: number): unknown => {
    if (depth > 4) {
      omittedKeys.push(key);
      return undefined;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      // Never prefix/truncate a hash: a partial digest must not look like a
      // complete native version. The same rule keeps long handles explicit.
      if (value.length > COMMITTED_STRING_MAX
        || (COMMITTED_HASH_KEYS.has(key) && value.length > 256)) {
        omittedKeys.push(key);
        return undefined;
      }
      return value;
    }
    if (Array.isArray(value)) {
      const projected = value.slice(0, 8)
        .map((item) => project(item, key, depth + 1))
        .filter((item): item is string | number | boolean | Record<string, unknown> | null => item !== undefined);
      if (value.length > projected.length) omittedKeys.push(`${key}[${projected.length}..]`);
      return projected;
    }
    if (!value || typeof value !== 'object') return undefined;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      if (!COMMITTED_PROJECTION_KEYS.has(childKey)) continue;
      const projected = project(child, childKey, depth + 1);
      if (projected !== undefined) output[childKey] = projected;
    }
    return Object.keys(output).length > 0 ? output : undefined;
  };

  const output: Record<string, unknown> = {};
  for (const key of COMMITTED_PROJECTION_KEYS) {
    if (!(key in source)) continue;
    const projected = project(source[key], key, 0);
    if (projected !== undefined) output[key] = projected;
  }
  output.outputBudget = {
    code: 'RESULT_IDENTITY_TOO_LARGE',
    identityBytes,
    maxBytes: MAX_BOUNDED_TOOL_RESULT_BYTES,
    projection: 'committed_lifecycle',
    ...(omittedKeys.length > 0 ? { omittedKeys: [...new Set(omittedKeys)].slice(0, 32) } : {})
  };
  return output;
}

function redactEmevdPhysicalLocators(
  output: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  const relativePath = safeEmevdRelativePath(
    source.relativePath,
    source.sourceUri
  ) ?? safeEmevdRelativePath(source.sourceUri)
    ?? safeEmevdRelativePath(source.sourcePath)
    ?? safeEmevdRelativePath(source.filePath);
  for (const key of ['sourcePath', 'filePath', 'file', 'relativePath']) {
    delete output[key];
  }
  if (relativePath) {
    output.sourcePath = relativePath;
    output.relativePath = relativePath;
  }
  // A production read already sanitizes sourceUri. If a custom/native adapter
  // supplies an absolute URI, do not echo it through the summary fallback.
  if (typeof source.sourceUri !== 'string' || !isSafeEmevdSourceUri(source.sourceUri)) {
    delete output.sourceUri;
  }
  redactEmevdLocatorTree(output);
}

function redactEmevdLocatorTree(value: unknown, depth = 0): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => redactEmevdLocatorTree(item, depth + 1));
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    const lower = key.toLocaleLowerCase();
    if (lower === 'sourceuri') {
      if (typeof child !== 'string' || !isSafeEmevdSourceUri(child)) delete record[key];
      continue;
    }
    if (lower === 'sourcepath' || lower === 'filepath' || lower === 'file' || lower === 'relativepath') {
      const relative = safeEmevdRelativePath(child);
      if (relative) record[key] = relative;
      else delete record[key];
      continue;
    }
    redactEmevdLocatorTree(child, depth + 1);
  }
}

function safeEmevdRelativePath(value: unknown, sourceUri?: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  let candidate = value.trim().replaceAll('\\', '/');
  if (candidate.startsWith('file://')) candidate = candidate.slice('file://'.length);
  else if (candidate.startsWith('file:')) candidate = candidate.slice('file:'.length).replace(/^\/+/, '');
  candidate = candidate.replace(/^\/+/, '');
  // A drive/UNC/rooted path is never a model-facing locator. The sourceUri
  // argument is accepted only as a hint for relativePath-shaped values; it
  // does not make an absolute physical path safe.
  if (/^[A-Za-z]:(?:\/|$)/u.test(candidate)
    || candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.split('/').some((part) => part === '..')) return undefined;
  if (candidate === '' || candidate === '.') return undefined;
  if (isLikelyAbsoluteEmevdPath(candidate)) return undefined;
  // A caller may provide a relativePath while sourceUri is absolute; keep the
  // relativePath, but never derive a path from an absolute sourceUri.
  if (sourceUri !== undefined && value === sourceUri && !isSafeEmevdSourceUri(value)) return undefined;
  return candidate;
}

function isSafeEmevdSourceUri(value: string): boolean {
  const normalized = value.trim().replaceAll('\\', '/');
  if (!normalized.startsWith('file://')) return !/^[A-Za-z]:(?:\/|$)|^(?:\/|\\\\)/u.test(normalized);
  const pathPart = normalized.slice('file://'.length).replace(/^\/+/, '');
  return pathPart !== ''
    && !/^[A-Za-z]:(?:\/|$)/u.test(pathPart)
    && !pathPart.split('/').some((part) => part === '..')
    && !isLikelyAbsoluteEmevdPath(pathPart);
}

function isLikelyAbsoluteEmevdPath(value: string): boolean {
  const first = value.split('/')[0]?.toLocaleLowerCase() ?? '';
  return new Set([
    'users', 'home', 'root', 'private', 'var', 'tmp', 'windows',
    'program files', 'program files (x86)', 'documents and settings', 'appdata'
  ]).has(first);
}

function projectEmevdDiagnostics(
  source: Record<string, unknown>,
  instructions: readonly unknown[]
): { diagnostics: unknown[]; unknownInstructionCount: number; unknownInstructionIndices: number[] } {
  const diagnostics: unknown[] = [];
  const unknownInstructionIndices: number[] = [];
  const append = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const diagnostic of value) {
      if (diagnostics.length >= 32) break;
      if (!diagnostic || typeof diagnostic !== 'object' || Array.isArray(diagnostic)) continue;
      const record = diagnostic as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const key of ['severity', 'code', 'message']) {
        const child = record[key];
        if (typeof child === 'string' && child.trim() !== '') projected[key] = child;
      }
      if (Object.keys(projected).length > 0) diagnostics.push(projected);
    }
  };
  append(source.diagnostics);
  instructions.forEach((instruction, index) => {
    if (!instruction || typeof instruction !== 'object' || Array.isArray(instruction)) return;
    const record = instruction as Record<string, unknown>;
    if (record.unknown === true) unknownInstructionIndices.push(
      typeof record.index === 'number' && Number.isSafeInteger(record.index) ? record.index : index
    );
    append(record.diagnostics);
  });
  return {
    diagnostics,
    unknownInstructionCount: unknownInstructionIndices.length,
    unknownInstructionIndices: unknownInstructionIndices.slice(0, 64)
  };
}

/**
 * The complete receipt projection keeps the source DarkScript verbatim and
 * the native identities needed by the write CAS, while explicitly omitting
 * the auxiliary machine DTO.  This is a different contract from
 * `summary_only`: `completeness=complete` is set only for this named view and
 * only after the whole event window has been delivered by the native read.
 */
function projectCompleteNativeEmevdDsl(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const instructions = Array.isArray(source.instructions) ? source.instructions : [];
  if (source.resourceKind !== 'event'
    || source.format !== 'darkscript'
    || typeof source.darkScript !== 'string'
    || source.darkScript.trim() === ''
    || source.darkScriptComplete !== true
    || !Number.isSafeInteger(source.eventId)
    || !Number.isSafeInteger(source.total)
    || (source.total as number) < 0
    || source.offset !== 0
    || source.returned !== source.total
    || source.instructionCount !== source.total
    || source.truncated !== false
    || !source.readRange
    || typeof source.readRange !== 'object'
    || Array.isArray(source.readRange)
    || (source.readRange as Record<string, unknown>).start !== 0
    || (source.readRange as Record<string, unknown>).end !== source.total
    || typeof source.sourceUri !== 'string'
    || source.sourceUri.trim() === ''
    || typeof source.sourceHash !== 'string'
    || source.sourceHash.trim() === ''
    || typeof source.outerFileHash !== 'string'
    || source.outerFileHash.trim() === ''
    || typeof source.sourceRevision !== 'number'
    || !Number.isFinite(source.sourceRevision)
    || typeof source.registryFingerprint !== 'string'
    || source.registryFingerprint.trim() === '') return null;

  const sourceUri = typeof source.sourceUri === 'string' && isSafeEmevdSourceUri(source.sourceUri)
    ? source.sourceUri
    : undefined;
  if (!sourceUri) return null;
  const relativePath = safeEmevdRelativePath(source.relativePath, sourceUri)
    ?? safeEmevdRelativePath(sourceUri)
    ?? safeEmevdRelativePath(source.sourcePath)
    ?? safeEmevdRelativePath(source.filePath);
  const diagnosticProjection = projectEmevdDiagnostics(source, instructions);

  const output: Record<string, unknown> = {
    projection: 'complete_native_dsl',
    machineProjection: { status: 'omitted', instructionCount: source.total },
    sourceUri,
    sourceHash: source.sourceHash,
    outerFileHash: source.outerFileHash,
    sourceRevision: source.sourceRevision,
    registryFingerprint: source.registryFingerprint,
    eventId: source.eventId,
    resourceKind: 'event',
    format: 'darkscript',
    instructionCount: source.instructionCount,
    total: source.total,
    offset: 0,
    returned: source.returned,
    truncated: false,
    darkScriptComplete: true,
    readRange: { start: 0, end: source.total },
    darkScript: source.darkScript,
    game: typeof source.game === 'string' && source.game.trim() !== '' ? source.game : 'unknown',
    diagnostics: diagnosticProjection.diagnostics,
    unknownInstructionCount: diagnosticProjection.unknownInstructionCount,
    ...(diagnosticProjection.unknownInstructionIndices.length > 0
      ? { unknownInstructionIndices: diagnosticProjection.unknownInstructionIndices }
      : {})
  };
  if (relativePath) {
    // Keep the field names stable for callers that previously consumed the
    // event DTO, but never expose the native absolute sourcePath/filePath.
    output.sourcePath = relativePath;
    output.relativePath = relativePath;
  }
  if (typeof source.limit === 'number' && Number.isSafeInteger(source.limit)) output.limit = source.limit;
  return output;
}

function compactCommittedEvidence(evidence: AgentEvidenceMetadata): AgentEvidenceMetadata {
  const compact: AgentEvidenceMetadata = {
    ...evidence,
    // Source hashes are retained whole; source URIs are only a locator hint
    // here because the committed projection carries the primary reread URI.
    sourceUris: evidence.sourceUris.slice(0, 4),
    sourceHashes: evidence.sourceHashes.slice(0, 16),
    sourceRevisions: evidence.sourceRevisions.slice(0, 16),
    nextActions: [
      ...evidence.nextActions.slice(0, 3),
      '结果身份超出输出预算；仅保留已提交事务生命周期，完整证据请用 operationId/回读定位继续查询。'
    ]
  };
  if (evidence.claims !== undefined) {
    delete compact.claims;
    delete compact.claimDefaults;
  }
  return compact;
}

function committedOversizeEnvelope(
  name: string,
  data: unknown,
  rawLength: number,
  identityBytes: number,
  identifiers: { ids: string[]; cursors: Record<string, string> },
  evidence: AgentEvidenceMetadata,
  window: ResultWindowMetadata,
  state: AgentToolSuccessState
): string {
  const projected = summarizeCommittedLifecycleValue(data, identityBytes);
  const summary = `工具 ${name} 的结果身份超过字节预算，已保留 committed 生命周期与回读定位；完整身份不可在本回包中表示。`;
  const compactIdentity = compactIdentifiers(identifiers);
  const evidenceCandidates = [evidence, compactCommittedEvidence(evidence)];
  for (const candidateEvidence of evidenceCandidates) {
    const envelope = createResultEnvelope(
      projected,
      rawLength,
      true,
      summary,
      compactIdentity,
      candidateEvidence,
      window,
      state
    );
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
      && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
  }

  // The lifecycle projection itself is intentionally bounded. If an unusual
  // host supplied oversized diagnostics still fill the envelope, fall back to
  // the same state/locator/budget contract with no raw evidence claims.
  const minimalEvidence = compactCommittedEvidence({
    status: 'insufficient_evidence',
    kind: 'mutation',
    sourceUris: [],
    sourceHashes: [],
    sourceRevisions: [],
    nextActions: ['使用 operationId 或原生回读重新获取完整证据。'],
    repeatedQuery: false
  });
  const minimalProjection: Record<string, unknown> = {
    ...(typeof projected.operationId === 'string' ? { operationId: projected.operationId } : {}),
    ...(typeof projected.opId === 'string' ? { opId: projected.opId } : {}),
    ...(typeof projected.transactionId === 'string' ? { transactionId: projected.transactionId } : {}),
    ...(projected.lifecycle && typeof projected.lifecycle === 'object' ? { lifecycle: projected.lifecycle } : {}),
    // Some older mutation handlers expose the refresh state at the top level
    // rather than under lifecycle.  Keep that signal in the strict fallback
    // as well; dropping it would make a committed-but-stale write look safe
    // to retry.
    ...(compactCommittedStatusValue(projected.knowledgeRefresh, KNOWLEDGE_REFRESH_STATUSES)
      ? { knowledgeRefresh: compactCommittedStatusValue(projected.knowledgeRefresh, KNOWLEDGE_REFRESH_STATUSES) }
      : {}),
    outputBudget: projected.outputBudget
  };
  const minimalEncoded = JSON.stringify(createResultEnvelope(
    minimalProjection,
    rawLength,
    true,
    summary,
    compactIdentity,
    minimalEvidence,
    window,
    state
  ));
  if (Buffer.byteLength(minimalEncoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
    && minimalEncoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return minimalEncoded;

  // This final form is intentionally tiny and independently bounded.  It is
  // reachable only if a host supplied unusually large projected lifecycle
  // values, but a result contract must still hold for that case too.
  const lifecycle = projected.lifecycle && typeof projected.lifecycle === 'object'
    ? projected.lifecycle as Record<string, unknown>
    : {};
  let locatorOmitted = false;
  const strictLocator = (key: string): string | undefined => {
    if (!(key in projected)) return undefined;
    const value = completeCommittedLocator(projected[key]);
    if (value === undefined) locatorOmitted = true;
    return value;
  };
  const strictOperationId = strictLocator('operationId');
  const strictOpId = strictLocator('opId');
  const strictTransactionId = strictLocator('transactionId');
  const strictKnowledgeRefresh = compactCommittedStatusValue(
    projected.knowledgeRefresh,
    KNOWLEDGE_REFRESH_STATUSES
  );
  const strictTransaction = typeof projected.transaction === 'string'
    && projected.transaction.length <= COMMITTED_STATUS_MAX_CHARS
    ? projected.transaction
    : undefined;
  const strictNativeVerification = compactCommittedStatusValue(
    projected.nativeVerification,
    NATIVE_VERIFICATION_STATUSES
  );
  const lifecycleKnowledgeRefresh = compactCommittedStatusValue(
    lifecycle.knowledgeRefresh,
    KNOWLEDGE_REFRESH_STATUSES
  );
  const lifecycleNativeVerification = compactCommittedStatusValue(
    lifecycle.nativeVerification,
    NATIVE_VERIFICATION_STATUSES
  );
  const strictLifecycle: Record<string, unknown> = {
    ...(typeof lifecycle.transaction === 'string' && lifecycle.transaction.length <= COMMITTED_STATUS_MAX_CHARS
      ? { transaction: lifecycle.transaction }
      : {}),
    ...(lifecycleKnowledgeRefresh !== undefined ? { knowledgeRefresh: lifecycleKnowledgeRefresh } : {}),
    ...(lifecycleNativeVerification !== undefined ? { nativeVerification: lifecycleNativeVerification } : {})
  };
  const strictProjection: Record<string, unknown> = {
    ...(strictOperationId !== undefined ? { operationId: strictOperationId } : {}),
    ...(strictOpId !== undefined ? { opId: strictOpId } : {}),
    ...(strictTransactionId !== undefined ? { transactionId: strictTransactionId } : {}),
    ...(strictTransaction !== undefined ? { transaction: strictTransaction } : {}),
    ...(strictNativeVerification !== undefined ? { nativeVerification: strictNativeVerification } : {}),
    ...(Object.keys(strictLifecycle).length > 0 ? { lifecycle: strictLifecycle } : {}),
    ...(strictKnowledgeRefresh !== undefined ? { knowledgeRefresh: strictKnowledgeRefresh } : {}),
    outputBudget: {
      code: 'RESULT_IDENTITY_TOO_LARGE',
      identityBytes,
      maxBytes: MAX_BOUNDED_TOOL_RESULT_BYTES,
      projection: 'committed_lifecycle_minimal',
      ...(locatorOmitted ? { locatorOmitted: true } : {})
    }
  };
  const strictEncoded = JSON.stringify(createResultEnvelope(
    strictProjection,
    rawLength,
    true,
    '提交已完成；完整身份超出输出预算，请使用 operationId 或原生回读定位。',
    { ids: [], cursors: {} },
    minimalEvidence,
    { total: null, offset: null, limit: null, returned: null, truncated: false },
    state
  ));
  if (Buffer.byteLength(strictEncoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
    && strictEncoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return strictEncoded;

  // The fields above are all bounded constants, so this is defensive rather
  // than expected. Keep a literal emergency envelope to make the byte
  // contract mechanically true even if the envelope schema grows later.
  return JSON.stringify({
    ok: true,
    state,
    data: {
      items: [],
      record: {
        ...(strictOperationId !== undefined ? { operationId: strictOperationId } : {}),
        ...(strictKnowledgeRefresh !== undefined ? { knowledgeRefresh: strictKnowledgeRefresh } : {}),
        outputBudget: {
          code: 'RESULT_IDENTITY_TOO_LARGE',
          identityBytes,
          maxBytes: MAX_BOUNDED_TOOL_RESULT_BYTES,
          ...(locatorOmitted ? { locatorOmitted: true } : {})
        }
      },
      scalar: null,
      summary: '提交已完成；完整身份超出输出预算。'
    },
    pagination: {
      originalChars: rawLength,
      returnedCount: null,
      totalCount: null,
      total: null,
      offset: null,
      limit: null,
      truncated: true,
      cursors: {}
    },
    completeness: 'summary_only',
    truncated: true,
    identifiers: [],
    evidence: minimalEvidence
  });
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

/**
 * Errors are model-facing data too.  A native read can put a large diagnostic
 * list (or a complete parser exception) in `error.details`; serializing that
 * object directly bypasses the result budget and can also hide the stable
 * locator that the next tool call needs.  Keep the projection deliberately
 * conservative: stable identity is copied whole only when it fits, ordinary
 * text is UTF-8 bounded, and diagnostic arrays carry explicit counts.
 */
const ERROR_STABLE_KEYS = new Set([
  'sourceUri', 'sourcePath', 'file', 'filePath', 'containerPath', 'relativePath',
  'sourceHash', 'outerFileHash', 'outerHash', 'payloadHash', 'sourceRevision',
  'revision', 'handle', 'objectHandle', 'nativeHandle', 'operationId', 'opId',
  'transactionId', 'eventId', 'instructionOffset', 'instructionLimit', 'offset',
  'limit', 'rowId', 'textId', 'tableId', 'entryName', 'resourceKind', 'format',
  'sourceUris', 'sourceHashes', 'sourceRevisions', 'changedSources'
]);
const ERROR_HASH_KEYS = new Set(['sourceHash', 'outerFileHash', 'outerHash', 'payloadHash']);
const ERROR_LOCATOR_KEYS = new Set([
  'sourceUri', 'sourcePath', 'file', 'filePath', 'containerPath', 'relativePath',
  'handle', 'objectHandle', 'nativeHandle', 'operationId', 'opId', 'transactionId'
]);
const ERROR_DETAIL_KEYS = new Set([
  ...ERROR_STABLE_KEYS,
  'reason', 'hint', 'retryHint', 'retry', 'retryFormat', 'suggestedFormat',
  'suggestedInstructionLimit', 'requestedInstructionLimit', 'canReduceInstructionLimit',
  'message', 'code', 'severity', 'diagnostic', 'diagnostics', 'errors', 'warnings',
  'details', 'detail', 'status', 'state', 'lifecycle', 'transaction', 'nativeVerification',
  'knowledgeRefresh', 'changedSources', 'outputBudget', 'identityBytes', 'maxBytes',
  'omittedStableKeys', 'locatorOmitted', 'truncated', 'total', 'returned',
  'instructionCount', 'darkScriptComplete', 'readRange', 'crossesBlockBoundary',
  'source', 'tool', 'path', 'name', 'value', 'expected', 'actual'
]);
const ERROR_DIAGNOSTIC_KEYS = new Set(['diagnostic', 'diagnostics', 'errors', 'warnings']);
const ERROR_CODE_MAX_BYTES = 256;
const ERROR_MESSAGE_MAX_BYTES = 1_024;
const ERROR_DETAIL_STRING_MAX_BYTES = 384;
const ERROR_LOCATOR_MAX_BYTES = 1_024;
const ERROR_HANDLE_MAX_BYTES = 512;
const ERROR_HASH_MAX_BYTES = 256;
const ERROR_DIAGNOSTIC_ITEM_LIMIT = 8;
const ERROR_DETAIL_ARRAY_LIMIT = 8;

interface ErrorProjectionMeta {
  truncated: boolean;
  omittedStableKeys: Set<string>;
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 3) return utf8CodepointPrefix(value, maxBytes);
  return `${utf8CodepointPrefix(value, maxBytes - 3)}…`;
}

function errorKeyMatches(key: string, keys: ReadonlySet<string>): boolean {
  if (keys.has(key)) return true;
  const lower = key.toLocaleLowerCase();
  return [...keys].some((candidate) => candidate.toLocaleLowerCase() === lower);
}

function projectStableErrorValue(
  key: string,
  value: unknown,
  meta: ErrorProjectionMeta
): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, ERROR_DETAIL_ARRAY_LIMIT)
      .map((item) => projectStableErrorValue(key, item, meta))
      .filter((item) => item !== undefined);
    const truncated = value.length > items.length;
    if (truncated) meta.truncated = true;
    return { items, total: value.length, returned: items.length, truncated };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'string') return undefined;
  const lower = key.toLocaleLowerCase();
  const isHash = ERROR_HASH_KEYS.has(key) || lower.endsWith('hash') || lower.endsWith('hashes');
  const isHandle = lower.includes('handle');
  const maxBytes = isHash
    ? ERROR_HASH_MAX_BYTES
    : isHandle
      ? ERROR_HANDLE_MAX_BYTES
      : ERROR_LOCATOR_KEYS.has(key) || lower.endsWith('uri') || lower.endsWith('path')
        ? ERROR_LOCATOR_MAX_BYTES
        : ERROR_DETAIL_STRING_MAX_BYTES;
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    // Hashes and opaque handles are never prefix-truncated into something
    // that looks actionable.  The same rule is used for a long locator so a
    // retry cannot accidentally target an incomplete path.
    meta.omittedStableKeys.add(key);
    return undefined;
  }
  return value;
}

function projectErrorDiagnosticArray(
  value: unknown[],
  depth: number,
  meta: ErrorProjectionMeta
): Record<string, unknown> {
  const items = value.slice(0, ERROR_DIAGNOSTIC_ITEM_LIMIT)
    .map((item) => projectErrorDetailValue(item, depth + 1, meta, 'diagnostic'))
    .filter((item) => item !== undefined);
  const truncated = value.length > items.length;
  if (truncated) meta.truncated = true;
  return {
    items,
    total: value.length,
    returned: items.length,
    truncated
  };
}

function projectErrorDetailValue(
  value: unknown,
  depth: number,
  meta: ErrorProjectionMeta,
  key = 'details'
): unknown {
  if (depth > 4) {
    meta.truncated = true;
    return undefined;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (errorKeyMatches(key, ERROR_STABLE_KEYS)) return projectStableErrorValue(key, value, meta);
    if (Buffer.byteLength(value, 'utf8') > ERROR_DETAIL_STRING_MAX_BYTES) meta.truncated = true;
    return boundedUtf8Text(value, ERROR_DETAIL_STRING_MAX_BYTES);
  }
  if (Array.isArray(value)) {
    if (errorKeyMatches(key, ERROR_DIAGNOSTIC_KEYS)) {
      return projectErrorDiagnosticArray(value, depth, meta);
    }
    const items = value.slice(0, ERROR_DETAIL_ARRAY_LIMIT)
      .map((item) => projectErrorDetailValue(item, depth + 1, meta, key))
      .filter((item) => item !== undefined);
    const truncated = value.length > items.length;
    if (truncated) meta.truncated = true;
    return { items, total: value.length, returned: items.length, truncated };
  }
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (errorKeyMatches(childKey, ERROR_DIAGNOSTIC_KEYS) && Array.isArray(child)) {
      output[childKey] = projectErrorDiagnosticArray(child, depth + 1, meta);
      continue;
    }
    if (!errorKeyMatches(childKey, ERROR_DETAIL_KEYS)) continue;
    const projected = errorKeyMatches(childKey, ERROR_STABLE_KEYS)
      ? projectStableErrorValue(childKey, child, meta)
      : projectErrorDetailValue(child, depth + 1, meta, childKey);
    if (projected !== undefined) output[childKey] = projected;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeFailureState(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'failed';
  const state = value.trim();
  return Buffer.byteLength(state, 'utf8') <= 128 ? state : 'failed';
}

function normalizeFailureCode(value: unknown, fallbackCode: string): {
  code: string;
  omitted: boolean;
} {
  const candidate = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallbackCode;
  if (Buffer.byteLength(candidate, 'utf8') <= ERROR_CODE_MAX_BYTES) {
    return { code: candidate, omitted: false };
  }
  return { code: fallbackCode, omitted: true };
}

function projectToolError(
  error: unknown,
  fallbackCode: string
): Record<string, unknown> {
  const source = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const meta: ErrorProjectionMeta = { truncated: false, omittedStableKeys: new Set() };
  const normalizedCode = normalizeFailureCode(source.code, fallbackCode);
  const rawMessage = typeof source.message === 'string' && source.message.length > 0
    ? source.message
    : '工具执行失败。';
  const message = boundedUtf8Text(rawMessage, ERROR_MESSAGE_MAX_BYTES);
  if (message !== rawMessage) meta.truncated = true;
  const output: Record<string, unknown> = {
    code: normalizedCode.code,
    message,
    ...(normalizedCode.omitted ? { originalCodeOmitted: true } : {}),
    ...(message !== rawMessage ? { messageTruncated: true } : {})
  };
  if ('details' in source) {
    const details = projectErrorDetailValue(source.details, 0, meta, 'details');
    if (details !== undefined) output.details = details;
  }
  // Some registry failures expose the locator/diagnostics directly on the
  // error object rather than nesting them under `details`. Preserve the same
  // bounded projection in either shape; otherwise an oversized top-level
  // diagnostic would erase the only actionable source identity.
  for (const [key, value] of Object.entries(source)) {
    if (key === 'code' || key === 'message' || key === 'details') continue;
    if (errorKeyMatches(key, ERROR_STABLE_KEYS)) {
      const projected = projectStableErrorValue(key, value, meta);
      if (projected !== undefined) output[key] = projected;
      continue;
    }
    if (errorKeyMatches(key, ERROR_DIAGNOSTIC_KEYS) && Array.isArray(value)) {
      output[key] = projectErrorDiagnosticArray(value, 0, meta);
    }
  }
  if (meta.truncated) output.detailsTruncated = true;
  if (meta.omittedStableKeys.size > 0) {
    output.omittedStableKeys = [...meta.omittedStableKeys].slice(0, 32);
    output.locatorOmitted = true;
  }
  return output;
}

function isProjectedCountEnvelope(value: unknown): value is {
  items?: unknown[];
  total?: number;
  returned?: number;
  truncated?: boolean;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.items)
    && typeof record.total === 'number'
    && typeof record.returned === 'number'
    && typeof record.truncated === 'boolean';
}

function compactProjectedErrorValue(value: unknown, key: string, depth = 0): unknown {
  if (depth > 4) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return { total: value.length, returned: 0, truncated: true };
  }
  if (!value || typeof value !== 'object') return undefined;
  if (isProjectedCountEnvelope(value)) {
    return {
      total: value.total,
      returned: 0,
      truncated: true
    };
  }
  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    // Preserve stable locators/hashes and retry instructions in the compact
    // candidate; diagnostic payload items are intentionally dropped while
    // their counts remain explicit.
    if (!errorKeyMatches(childKey, ERROR_DETAIL_KEYS)) continue;
    if (errorKeyMatches(childKey, ERROR_DIAGNOSTIC_KEYS)) {
      if (isProjectedCountEnvelope(child)) {
        output[childKey] = {
          total: child.total,
          returned: 0,
          truncated: true
        };
      } else if (Array.isArray(child)) {
        output[childKey] = { total: child.length, returned: 0, truncated: true };
      }
      continue;
    }
    const projected = compactProjectedErrorValue(child, childKey, depth + 1);
    if (projected !== undefined) output[childKey] = projected;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function collectProjectedDiagnosticTotals(
  value: unknown,
  output: Record<string, number> = {},
  depth = 0
): Record<string, number> {
  if (depth > 5 || value === null || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectProjectedDiagnosticTotals(item, output, depth + 1));
    return output;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (errorKeyMatches(key, ERROR_DIAGNOSTIC_KEYS)) {
      if (isProjectedCountEnvelope(child) && typeof child.total === 'number') {
        output[key] = child.total;
      } else if (Array.isArray(child)) {
        output[key] = child.length;
      }
    }
    collectProjectedDiagnosticTotals(child, output, depth + 1);
  }
  return output;
}

function boundedFailureContent(
  error: unknown,
  state: unknown = 'failed',
  fallbackCode = 'TOOL_FAILED'
): string {
  const normalizedState = normalizeFailureState(state);
  const originalError = error ?? { code: fallbackCode, message: '工具执行失败。' };
  // Preserve the exact error schema whenever it already fits. This keeps
  // tool-specific fields (including fields not known to this bridge) intact;
  // projection is only a response to the actual byte/character overflow.
  try {
    const originalEncoded = JSON.stringify({ ok: false, state: normalizedState, error: originalError });
    if (Buffer.byteLength(originalEncoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
      && originalEncoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return originalEncoded;
  } catch {
    // Fall through to the cycle-safe projected form below.
  }
  const projected = projectToolError(error, fallbackCode);
  const projectedDetails = projected.details === undefined
    ? undefined
    : compactProjectedErrorValue(projected.details, 'details');
  const diagnosticTotals = projected.details === undefined
    ? {}
    : collectProjectedDiagnosticTotals(projected.details);
  const compactProjected: Record<string, unknown> = {
    code: projected.code,
    message: projected.message,
    ...(projected.originalCodeOmitted ? { originalCodeOmitted: true } : {}),
    ...(projected.messageTruncated ? { messageTruncated: true } : {}),
    ...(projectedDetails !== undefined ? { details: projectedDetails } : {}),
    ...(projected.omittedStableKeys ? { omittedStableKeys: projected.omittedStableKeys, locatorOmitted: true } : {}),
    ...(projected.detailsTruncated ? { detailsTruncated: true } : {})
  };
  const minimalProjected: Record<string, unknown> = {
    code: projected.code,
    message: projected.message,
    ...(projected.originalCodeOmitted ? { originalCodeOmitted: true } : {}),
    ...(projected.messageTruncated ? { messageTruncated: true } : {}),
    detailsOmitted: projected.details !== undefined,
    // Once details are omitted, a locator may have been inside that details
    // object even when the allowlist did not see it. Make the loss explicit.
    ...(projected.details !== undefined || projected.locatorOmitted
      ? { locatorOmitted: true }
      : {}),
    ...(projected.omittedStableKeys ? { omittedStableKeys: projected.omittedStableKeys } : {}),
    ...(Object.keys(diagnosticTotals).length > 0 ? { diagnosticTotals } : {})
  };
  const candidates: Record<string, unknown>[] = [
    { ok: false, state: normalizedState, error: projected },
    { ok: false, state: normalizedState, error: compactProjected },
    { ok: false, state: normalizedState, error: minimalProjected }
  ];
  for (const candidate of candidates) {
    const encoded = JSON.stringify(candidate);
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
      && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
  }
  // The final candidate contains only bounded constants plus the normalized
  // machine code/state. It is intentionally independent of any error object.
  return JSON.stringify({
    ok: false,
    state: normalizedState,
    error: {
      code: projected.code,
      message: '工具执行失败；详细诊断已省略。',
      detailsOmitted: true,
      locatorOmitted: true,
      ...(projected.originalCodeOmitted ? { originalCodeOmitted: true } : {}),
      ...(Object.keys(diagnosticTotals).length > 0 ? { diagnosticTotals } : {})
    }
  });
}

function firstRecordString(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[]
): string | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      if (typeof record[key] === 'string' && record[key]!.trim() !== '') return record[key] as string;
    }
  }
  return undefined;
}

function firstRecordNumber(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[]
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function firstRecordFiniteNumber(
  records: Array<Record<string, unknown> | undefined>,
  keys: readonly string[]
): number | undefined {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    }
  }
  return undefined;
}

function buildEmevdWindowTooLargeDetails(
  data: unknown,
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  const result = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const records = [input, result];
  const offset = firstRecordNumber(records, ['instructionOffset', 'offset']) ?? 0;
  const requestedLimit = firstRecordNumber(records, ['instructionLimit', 'limit', 'instructionCount']) ?? 1;
  const format = firstRecordString(records, ['format']) ?? 'darkscript';
  const canReduce = requestedLimit > 1;
  const suggestedLimit = canReduce ? Math.max(1, Math.floor(requestedLimit / 2)) : 1;
  const details: Record<string, unknown> = {
    sourceUri: firstRecordString([result, input], ['sourceUri']),
    sourcePath: firstRecordString([result, input], ['sourcePath', 'filePath']),
    file: firstRecordString([input, result], ['file']),
    eventId: firstRecordNumber([input, result], ['eventId']),
    instructionOffset: offset,
    instructionLimit: requestedLimit,
    requestedInstructionLimit: requestedLimit,
    suggestedInstructionLimit: suggestedLimit,
    canReduceInstructionLimit: canReduce,
    format,
    retryFormat: canReduce ? format : 'json',
    retry: canReduce
      ? { format, instructionOffset: offset, instructionLimit: suggestedLimit }
      : { format: 'json', instructionOffset: offset, instructionLimit: 1 },
    retryHint: canReduce
      ? `请以 instructionOffset=${offset}、instructionLimit=${suggestedLimit} 继续读取；不要重试同一窗口。`
      : 'instructionLimit=1 仍超出输出预算，已无更小窗口；可改用 format=json 读取同一事件，不能无限重试。'
  };
  details.retry = {
    ...(details.retry as Record<string, unknown>),
    ...(typeof details.file === 'string' ? { file: details.file } : {}),
    ...(typeof details.eventId === 'number' ? { eventId: details.eventId } : {})
  };
  for (const [key, keys] of [
    ['sourceHash', ['sourceHash']],
    ['outerFileHash', ['outerFileHash', 'outerHash']],
    ['sourceRevision', ['sourceRevision', 'revision']]
  ] as const) {
    const value = firstRecordString(records, keys);
    if (value !== undefined) details[key] = value;
    else {
      // Native source revisions are often file timestamps and may be
      // fractional; they are still exact version identity and must survive
      // the retry envelope.
      const numberValue = key === 'sourceRevision'
        ? firstRecordFiniteNumber(records, keys)
        : firstRecordNumber(records, keys);
      if (numberValue !== undefined) details[key] = numberValue;
    }
  }
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

function boundedToolContent(
  name: string,
  data: unknown,
  repeatedQuery = false,
  context?: ToolContext,
  state: AgentToolSuccessState = 'completed',
  input?: Record<string, unknown>
): string {
  const evidence = buildEvidenceMetadata(name, data, repeatedQuery, context);
  const raw = JSON.stringify({ ok: true, state, data: data ?? null, evidence });
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const identifiers = collectStableIdentifiers(data);
  const compactIdentity = compactIdentifiers(identifiers);
  const window = resultWindowMetadata(data);

  // If identity itself exceeds the byte budget, fail fast without truncating hash or handle
  const identityJson = JSON.stringify({
    ok: true,
    state,
    identifiers: identifiers.ids,
    evidence
  });
  const identityBytes = Buffer.byteLength(identityJson, 'utf8');
  if (identityBytes > MAX_BOUNDED_TOOL_RESULT_BYTES) {
    if (COMMITTED_STATES.has(state)) {
      // A committed write is irreversible even when the model-facing identity
      // projection cannot fit. Preserve its state and lifecycle instead of
      // returning an ordinary failed tool call that invites a duplicate write.
      return committedOversizeEnvelope(
        name,
        data,
        raw.length,
        identityBytes,
        identifiers,
        evidence,
        window,
        state
      );
    }
    return boundedFailureContent({
      code: 'RESULT_IDENTITY_TOO_LARGE',
      message: `结果身份与版本自身大小（${identityBytes} 字节）超过字节预算（${MAX_BOUNDED_TOOL_RESULT_BYTES} 字节），不能截断稳定哈希或对象句柄。`
    }, state === 'completed' ? 'failed' : state);
  }

  // A complete DarkScript event read has a stronger model-facing contract
  // than the generic envelope, even when the raw payload happens to fit in
  // one response.  Keep this before the raw fastpath: otherwise small/empty
  // events would be returned without `projection=complete_native_dsl` and
  // could never produce the host-side native proof that the write gate needs.
  if (name === 'read_emevd_event' && !window.truncated) {
    const completeDsl = projectCompleteNativeEmevdDsl(data);
    if (completeDsl !== null) {
      const completeEnvelope = createResultEnvelope(
        completeDsl,
        raw.length,
        false,
        '完整 native DarkScript 视图；辅助 machine instruction DTO 已省略。',
        compactIdentity,
        evidence,
        window,
        state,
        'complete'
      );
      const encoded = JSON.stringify(completeEnvelope);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
        && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
    }
  }

  const byteBoundedByRaw = (BOUNDED_DISCOVERY_TOOLS.has(name) || rawBytes > MAX_BOUNDED_TOOL_RESULT_BYTES * 4)
    && rawBytes > MAX_BOUNDED_TOOL_RESULT_BYTES;
  // Event reads always use the event-specific projection below when the
  // complete-native contract is unavailable; returning the raw DTO here
  // would echo its physical absolute sourcePath/filePath and bypass the
  // locator/unknown-diagnostic redaction.
  if (!byteBoundedByRaw && name !== 'read_emevd_event') {
    const sourceSummary = truncationSummary(name, window, false);
    const encoded = JSON.stringify(createResultEnvelope(
      data,
      raw.length,
      window.truncated,
      sourceSummary,
      identifiers,
      evidence,
      window,
      state
    ));
    // The envelope adds pagination, identifiers and evidence metadata. A raw
    // payload below the threshold can therefore still overflow the actual
    // model-facing response (as happens for a verbose native EMEVD page).
    // Only take the fast path when the final serialized envelope fits both
    // limits; otherwise continue through the bounded projection below.
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
      && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
  }
  const summaryText = truncationSummary(name, window, true) ?? '工具输出已截断；请继续分页查询。';
  if (name === 'read_param_fields' && data && typeof data === 'object' && !Array.isArray(data)) {
    const fields = (data as Record<string, unknown>).fields;
    if (Array.isArray(fields)) {
      const summary = summarizeDiscoveryValue(data, fields.length) as Record<string, unknown>;
      summary.fields = fields.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const field = value as Record<string, unknown>;
        const compact = summarizeDiscoveryItem(field) as Record<string, unknown>;
        // Values and native identity are exact. Only auxiliary metadata can be
        // summarized; the generic six-candidate cap must not drop requested fields.
        for (const key of ['fieldId', 'rowId', 'table', 'entryName', 'value', 'sourceHash', 'sourceRevision']) {
          if (key in field) compact[key] = field[key];
        }
        return compact;
      });
      const encoded = JSON.stringify(createResultEnvelope(
        summary, raw.length, true,
        '已压缩辅助元数据；保留本次请求的全部字段、完整字段值及原生身份。',
        compactIdentity, evidence, window, state
      ));
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
        && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
      return boundedFailureContent({
        code: 'RESULT_FIELD_WINDOW_TOO_LARGE',
        message: '本次字段窗口在保留全部原生身份和字段值后仍超出输出预算；请减少 fieldIds 或 rowIds 分批读取。'
      }, state === 'completed' ? 'failed' : state);
    }
  }
  if (name === 'read_emevd_event') {
    const completeDsl = window.truncated ? null : projectCompleteNativeEmevdDsl(data);
    if (completeDsl !== null) {
      const completeEnvelope = createResultEnvelope(
        completeDsl,
        raw.length,
        false,
        '完整 native DarkScript 视图；辅助 machine instruction DTO 已省略。',
        compactIdentity,
        evidence,
        window,
        state,
        'complete'
      );
      const encoded = JSON.stringify(completeEnvelope);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES
        && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
    }
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
        window,
        state
      );
      const encoded = JSON.stringify(summarizedEnvelope);
      if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
    }
    // A complete native event read must remain actionable. Returning the
    // generic compact envelope with `ok=true` and `record=null` would erase
    // the instruction window while falsely presenting a successful read.
    return boundedFailureContent({
      code: 'RESULT_EVENT_WINDOW_TOO_LARGE',
      message: '完整 EMEVD 指令窗口超过 Agent 输出预算；请使用 instructionOffset/instructionLimit 分页读取。',
      details: buildEmevdWindowTooLargeDetails(data, input)
    }, state === 'completed' ? 'failed' : state);
  }
  // Try progressively smaller candidate sets. A single native row/chunk can
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
      window,
      state
    );
    const encoded = JSON.stringify(summarizedEnvelope);
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES && encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
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
    window,
    state
  );
  const compactEncoded = JSON.stringify(compactEnvelope);
  if (Buffer.byteLength(compactEncoded, 'utf8') <= MAX_BOUNDED_TOOL_RESULT_BYTES && compactEncoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return compactEncoded;

  return JSON.stringify(createResultEnvelope(
    null,
    raw.length,
    true,
    `工具 ${name} 输出已截断；请继续分页查询。`,
    { ids: [], cursors: {} },
    evidence,
    window,
    state
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

    const inputRec = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

    // Guard against model free-form crafted nativeOffset on pagination tools
    if (
      typeof inputRec.nativeOffset === 'number' &&
      typeof inputRec.cursor !== 'string'
    ) {
      return {
        ok: false,
        code: 'NATIVE_OFFSET_CRAFTING_FORBIDDEN',
        content: JSON.stringify({
          ok: false,
          state: 'failed',
          error: {
            code: 'NATIVE_OFFSET_CRAFTING_FORBIDDEN',
            message: '不能由模型自由构造 nativeOffset；请使用宿主返回的 opaque cursor 进行安全分页。'
          }
        })
      };
    }

    // Validate cursor token if passed
    if (typeof inputRec.cursor === 'string') {
      try {
        parseOpaqueCursor(inputRec.cursor);
      } catch (err: any) {
        return {
          ok: false,
          code: err?.code ?? 'INVALID_READ_CURSOR',
          content: JSON.stringify({
            ok: false,
            state: 'failed',
            error: {
              code: err?.code ?? 'INVALID_READ_CURSOR',
              message: err?.message ?? '无效的 cursor token。'
            }
          })
        };
      }
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
    if (result.ok && result.state !== 'failed') {
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
      const content = boundedToolContent(
        call.name,
        result.data,
        repeatedQuery,
        effectiveContext,
        result.state ?? 'completed',
        inputRec
      );
      // Projection can reject a successful registry result when its stable
      // identity exceeds the output budget. The loop audit and model envelope
      // must observe the same failure, including its actionable error code.
      const envelope = JSON.parse(content) as {
        ok: boolean;
        error?: { code?: string };
        data?: unknown;
        completeness?: NativeReadCompleteness;
        truncated?: boolean;
      };
      if (!envelope.ok) {
        return { ok: false, code: envelope.error?.code ?? 'TOOL_FAILED', content };
      }
      const envelopeData = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
        ? envelope.data as { record?: unknown }
        : undefined;
      const envelopeRecord = envelopeData?.record && typeof envelopeData.record === 'object'
        && !Array.isArray(envelopeData.record)
        ? envelopeData.record as Record<string, unknown>
        : undefined;
      // Only the named complete native DSL view can mint an EMEVD proof. A
      // JSON read, a tail/partial window, or a generic summary is still a
      // useful successful read, but it must leave the mutation gate closed.
      const completeNativeDslEnvelope = call.name === 'read_emevd_event'
        && result.__hostResolvedEmevdEventTarget?.canonical === true
        && envelopeRecord?.projection === 'complete_native_dsl'
        && envelope.completeness === 'complete'
        && envelope.truncated === false;
      if (completeNativeDslEnvelope
        && effectiveContext.taskRecord?.recordNativeEmevdRead
        && result.__hostResolvedEmevdEventTarget) {
        try {
          await effectiveContext.taskRecord.recordNativeEmevdRead({
            input: inputRec,
            rawResult: result.data,
            envelope,
            target: result.__hostResolvedEmevdEventTarget
          });
        } catch (error) {
          const structured = error && typeof error === 'object'
            ? error as { code?: unknown; message?: unknown; details?: unknown }
            : undefined;
          if (structured?.code !== 'TASK_RECORD_NATIVE_PROOF_TARGET_MISSING') {
            const message = typeof structured?.message === 'string'
              ? structured.message
              : error instanceof Error ? error.message : String(error);
            return {
              ok: false,
              code: 'TASK_RECORD_NATIVE_PROOF_FAILED',
              content: boundedFailureContent({
                code: 'TASK_RECORD_NATIVE_PROOF_FAILED',
                message: `原生 EMEVD 已读取但 Evidence proof 未能由宿主记录：${message}`,
                ...(structured?.details === undefined ? {} : { details: structured.details })
              })
            };
          }
        }
      }
      return { ok: true, content };
    }
    const content = boundedFailureContent(
      result.error ?? { code: 'TOOL_FAILED', message: '工具执行失败。' },
      result.state ?? 'failed'
    );
    const envelope = JSON.parse(content) as { error?: { code?: string } };
    return {
      ok: false,
      code: envelope.error?.code ?? 'TOOL_FAILED',
      content
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
