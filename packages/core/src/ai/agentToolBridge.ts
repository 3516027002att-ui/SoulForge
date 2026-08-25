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
  /**
   * Entity/item discovery runs must attempt FMG/RAG text lookup before
   * probing PARAM/MSB/EMEVD.  This is a runtime contract, not prompt advice:
   * models that ignore the documented workflow receive a structured denial.
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
const TEXT_DISCOVERY_TOOLS = new Set(['search_text_entries', 'retrieve_evidence']);
const STRUCTURED_DISCOVERY_TOOLS = new Set([
  'search_resources',
  'search_param_rows',
  'read_param_fields',
  'query_map_objects',
  'search_map_entities',
  'read_msb_parts',
  'read_emevd_outline',
  'search_events'
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
  'search_text_entries',
  'query_map_objects',
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_outline',
  'read_msb_parts'
]);
const SUMMARY_ARRAY_LIMIT = 16;
const SUMMARY_STRING_LIMIT = 320;

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
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(value, 0);
  return { ids: [...new Set(ids)], cursors };
}

function boundedToolContent(name: string, data: unknown): string {
  const raw = JSON.stringify({ ok: true, state: 'completed', data: data ?? null });
  if (!BOUNDED_DISCOVERY_TOOLS.has(name) || raw.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return raw;
  const summary = summarizeToolValue(data);
  const identifiers = collectStableIdentifiers(data);
  const summarized = {
    summary: `工具 ${name} 输出过大，已返回摘要；请使用返回的 ID 或游标继续分页查询。`,
    truncated: true,
    originalChars: raw.length,
    data: summary,
    ...identifiers
  };
  const encoded = JSON.stringify({ ok: true, state: 'completed', data: summarized, ...identifiers });
  if (encoded.length <= MAX_BOUNDED_TOOL_RESULT_CHARS) return encoded;
  // Never inject invalid JSON. If even the structured summary is too large,
  // retain only the stable identifiers/cursor contract.
  return JSON.stringify({
    ok: true,
    state: 'completed',
    summary: `工具 ${name} 输出已截断；请使用 ID/游标继续查询。`,
    truncated: true,
    originalChars: raw.length,
    ...identifiers
  });
}

export function createAgentToolBridge(options: AgentToolBridgeOptions): AgentToolBridge {
  const { registry, context } = options;
  const textLookupEvidence: string[] = [];
  const tools: AgentToolDefinition[] = registry.list().map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
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
    const exactTarget = isExactStructuredTarget(call.name, input);
    if (
      options.requireTextLookupBeforeStructuredDiscovery === true
      && STRUCTURED_DISCOVERY_TOOLS.has(call.name)
      && !exactTarget
      && !hasMatchingTextEvidence(input, textLookupEvidence)
    ) {
      return {
        ok: false,
        code: 'TEXT_LOOKUP_REQUIRED',
        content: JSON.stringify({
          ok: false,
          error: {
            code: 'TEXT_LOOKUP_REQUIRED',
            message: '本任务必须先调用 search_text_entries（或 retrieve_evidence）按名称查 FMG 文本，再查询 PARAM/MSB/EMEVD；不要猜测行号。'
          }
        })
      };
    }
    const effectiveContext: ToolContext = { ...context, ...contextOverride };
    const result = await registry.run(call.name, input, effectiveContext);
    if (effectiveContext.mode && effectiveContext.mode !== context.mode) {
      context.mode = effectiveContext.mode;
    }
    if (result.ok) {
      if (TEXT_DISCOVERY_TOOLS.has(call.name)) {
        const evidence = extractTextEvidenceQuery(input, result.data);
        if (evidence) textLookupEvidence.push(evidence);
      }
      return { ok: true, content: boundedToolContent(call.name, result.data) };
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

function extractTextEvidenceQuery(input: unknown, data: unknown): string | undefined {
  const query = input && typeof input === 'object' && typeof (input as Record<string, unknown>).query === 'string'
    ? (input as Record<string, unknown>).query as string
    : '';
  if (!hasTextHits(data)) return undefined;
  return query.trim().toLocaleLowerCase();
}

function hasTextHits(data: unknown): boolean {
  if (Array.isArray(data)) return data.length > 0;
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return (Array.isArray(record.hits) && record.hits.length > 0)
    || (Array.isArray(record.entries) && record.entries.length > 0)
    || (Array.isArray(record.matches) && record.matches.length > 0);
}

function isExactStructuredTarget(name: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const value = input as Record<string, unknown>;
  if (name === 'read_param_fields') {
    return typeof value.table === 'string' && asNonEmptyNumberList(value.rowIds);
  }
  if (name === 'read_fmg_entries') {
    return typeof value.table === 'string' && asNonEmptyNumberList(value.ids);
  }
  if (name === 'read_msb_parts') {
    return Array.isArray(value.addresses) && value.addresses.length > 0
      && value.addresses.every((item) => typeof item === 'string' && /^(?:m\d{2}_\d{2}_\d{2}_\d{2}#|map:\/\/)/iu.test(item));
  }
  if (name === 'read_emevd_outline') {
    return typeof value.file === 'string' && /\.emevd(?:\.dcx)?$/iu.test(value.file);
  }
  if (name === 'search_param_rows' || name === 'search_map_entities') {
    return typeof value.query === 'string' && /^\d+$|^(?:m\d{2}_\d{2}_\d{2}_\d{2}#|map:\/\/)/iu.test(value.query.trim());
  }
  return false;
}

function asNonEmptyNumberList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'number' && Number.isInteger(item));
}

function hasMatchingTextEvidence(input: unknown, evidence: readonly string[]): boolean {
  if (evidence.length === 0 || !input || typeof input !== 'object') return false;
  const terms = Object.entries(input as Record<string, unknown>)
    .filter(([key, value]) => /query|name|identifier|target|region|model/i.test(key) && typeof value === 'string')
    .map(([, value]) => normalizeEvidenceTerm(value as string))
    .filter((value) => value.length >= 2);
  if (terms.length === 0) return true;
  return terms.some((term) => evidence.some((query) => query.includes(term) || term.includes(query)));
}

function normalizeEvidenceTerm(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_#:/\\.-]+/gu, '');
}
