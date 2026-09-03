/**
 * Dual-provider agent tool loop with permission isolation and audit redaction.
 * Full permission cannot bypass Patch Engine — tools still go through executeTool policy.
 *
 * Kernel capabilities derived from openai/codex (Apache-2.0, Copyright 2025
 * OpenAI). See licenses/openai-codex.txt and the module docs of
 * retryPolicy.ts / rolloutRecorder.ts / contextCompactor.ts:
 * - request/stream-level retry with exponential backoff + Retry-After
 * - concurrent execution of parallel-capable tools, results recorded in
 *   model emission order (Codex FuturesOrdered drain semantics)
 * - optional streaming consumption with agent-level event emission
 * - append-only rollout sink hook, flushed before the run returns
 * - threshold-triggered context compaction replacing history in place
 */

import type { ModelServiceAdapter } from './types.js';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentRunRequest,
  AgentRunResult,
  ApprovalDecision,
  ApprovalDiff,
  ApprovalResponse,
  ChatMessage,
  ContextEvidenceSource,
  ModelCompleteRequest,
  ModelCompleteResult,
  ToolCall
} from './types.js';
import type { ModelServiceDiagnostic } from './errorClassification.js';
import { classifyFetchError } from './errorClassification.js';
import type { AiToolPermissionLevel, RagRetrieveResult } from '@soulforge/shared';
import { decideAiToolPermission } from '../ai/toolPermissions.js';
import {
  DEFAULT_STREAM_MAX_RETRIES,
  MAX_RETRY_ATTEMPTS_CAP,
  decideRetry,
  resolveRetryPolicy,
  sleepWithSignal
} from './retryPolicy.js';
import { estimateContextTokens, isContextOverflowDiagnostic, runCompaction } from './contextCompactor.js';
import { upsertContextEvidenceSources } from './contextBroker.js';
import { APPROVAL_DECISIONS_DENYING } from './types.js';

/** 连续工具调用失败上限门禁：达到该阈值时自动终止循环以防死循环。 */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 10;
/** 语义上重复的发现失败预算；参数行号变化不能绕过该门禁。 */
export const MAX_SEMANTIC_TOOL_FAILURES = 6;
/** 默认 Agent 步数上限；宿主未传 maxSteps 时也必须有界，避免工具死循环拖垮桌面。 */
export const DEFAULT_AGENT_MAX_STEPS = 200;
/** 连续没有消费新稳定证据时提前收口，避免真实模型空转到 200 步。 */
export const MAX_DISCOVERY_ONLY_TURNS = 6;
/** 连续没有新稳定证据的搜索/原生读取轮数也必须有界。 */
export const MAX_RESEARCH_ONLY_TURNS = MAX_DISCOVERY_ONLY_TURNS;
/** 空正文只允许一次补问；普通 length 响应不重试，已有工具进展时只补一次汇报。 */
export const MAX_EMPTY_CONCLUSION_RETRIES = 1;
/** 有总输出预算时为最后的 partial/blocked 汇报保留的额度。 */
export const CONCLUSION_RESERVE_TOKENS = 2_048;

const DISCOVERY_PROGRESS_TOOLS = new Set([
  'read_agent_task_record',
  'search_resources',
  'search_param_rows',
  'search_param_fields',
  'search_map_entities',
  'search_events',
  'search_tae_events',
  'search_text_entries',
  'search_event_reference',
  'retrieve_evidence',
  'lookup_text_id',
  'find_text_references',
  'list_memories',
  'read_memory',
  'workspace_stats'
]);
const NATIVE_READ_TOOLS = new Set([
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_outline',
  'read_tae_events',
  'read_msb_parts',
  'query_map_objects',
  'inspect_map_object'
]);

function envelopeEvidenceStatus(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { evidence?: { status?: unknown } };
    return typeof parsed.evidence?.status === 'string' ? parsed.evidence.status : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a bounded search_param_fields envelope contains a real field ID. */
function hasExplicitParamFieldId(content: string): boolean {
  try {
    const root = JSON.parse(content) as unknown;
    const walk = (value: unknown, depth: number): boolean => {
      if (depth > 6 || value === null || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.slice(0, 64).some((item) => walk(item, depth + 1));
      const record = value as Record<string, unknown>;
      if (typeof record.fieldId === 'string' && record.fieldId.trim() !== '') return true;
      return Object.values(record).some((child) => walk(child, depth + 1));
    };
    return walk(root, 0);
  } catch {
    return false;
  }
}

/**
 * Extract bounded, repeat-detectable identities from a tool result.
 *
 * A successful search or native read is not automatically progress: returning
 * the same candidate with a different query/row range must not keep the Agent
 * alive forever.  Conversely, a native read that reveals a new row, field,
 * source revision, event or texture identity is real research progress even
 * when the turn has not reached a write operation yet.
 */
function collectResearchProgressKeys(content: string): string[] {
  const stableNames = new Set([
    'address',
    'animid',
    'animationid',
    'entryindex',
    'entryname',
    'entityid',
    'eventid',
    'fieldid',
    'fieldids',
    'id',
    'mapid',
    'nativeoffset',
    'paramname',
    'refid',
    'rowid',
    'rowids',
    'sourcehash',
    'sourcehashes',
    'sourcerevision',
    'sourcerevisions',
    'sourceuri',
    'sourceuris',
    'symboluri',
    'table',
    'textid',
    'textids',
    'uri'
  ]);
  const volatileNames = new Set([
    'callid',
    'createdat',
    'cursor',
    'nextcursor',
    'opid',
    'requestid',
    'searchid',
    'updatedat'
  ]);
  const identities = new Set<string>();
  try {
    const root = JSON.parse(content) as unknown;
    const walk = (value: unknown, keyHint: string | undefined, depth: number): void => {
      if (depth > 7 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.slice(0, 128).forEach((item) => walk(item, keyHint, depth + 1));
        return;
      }
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        Object.entries(record).slice(0, 256).forEach(([key, child]) => {
          walk(child, key, depth + 1);
        });
        return;
      }
      if (keyHint === undefined || (typeof value !== 'string' && typeof value !== 'number')) return;
      const normalizedKey = keyHint.replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase();
      if (volatileNames.has(normalizedKey)) return;
      if (!stableNames.has(normalizedKey) && !normalizedKey.endsWith('id')) return;
      const normalizedValue = typeof value === 'number'
        ? (Number.isFinite(value) ? String(value) : '')
        : value.trim().slice(0, 512);
      if (normalizedValue.length === 0) return;
      const identityKey = normalizedKey.endsWith('ids')
        ? normalizedKey.slice(0, -1)
        : normalizedKey;
      identities.add(`${identityKey}=${normalizedValue}`);
    };
    walk(root, undefined, 0);
  } catch {
    // A malformed/opaque result cannot prove new evidence. The tool's own
    // diagnostic remains in the transcript and the research guard stays safe.
  }
  return [...identities].sort();
}

interface EvidenceReferences {
  stableIds: string[];
  searchIds: string[];
}

/**
 * Keep the references that make a denial actionable without copying a whole
 * result into the next prompt.  Search tickets are deliberately collected
 * separately: they are proof handles, not logical object identity.
 */
function collectEvidenceReferences(content: string): EvidenceReferences {
  const stableIds = new Set(
    collectResearchProgressKeys(content)
      .filter((key) => !/^(?:sourcehash|sourcerevision)=/u.test(key))
  );
  const searchIds = new Set<string>();
  const addSearchId = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') {
      searchIds.add(value.trim().slice(0, 256));
    }
  };
  const walk = (value: unknown, keyHint: string | undefined, depth: number): void => {
    if (depth > 7 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 128)) {
        if (keyHint && keyHint.replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase() === 'identifiers'
          && typeof item === 'string') {
          const separator = item.indexOf('=');
          if (separator > 0
            && item.slice(0, separator).replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase() === 'searchid') {
            addSearchId(item.slice(separator + 1));
          }
        }
        walk(item, keyHint, depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') {
      if (keyHint && keyHint.replaceAll('_', '').replaceAll('-', '').toLocaleLowerCase() === 'searchid') {
        addSearchId(value);
      }
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 256)) {
      walk(child, key, depth + 1);
    }
  };
  try {
    const parsed = JSON.parse(content) as unknown;
    walk(parsed, undefined, 0);
  } catch {
    // Opaque results cannot prove a stable reference; preserve the raw tool
    // result in the normal transcript and fail closed at the workflow gate.
  }
  return {
    stableIds: [...stableIds].sort().slice(0, 32),
    searchIds: [...searchIds].sort().slice(0, 32)
  };
}

function evidenceReferencesForSources(sources: readonly ContextEvidenceSource[]): EvidenceReferences {
  const stableIds = new Set<string>();
  const searchIds = new Set<string>();
  for (const source of sources) {
    const references = collectEvidenceReferences(source.text ?? '');
    for (const stableId of references.stableIds) stableIds.add(stableId);
    for (const searchId of references.searchIds) searchIds.add(searchId);
  }
  return {
    stableIds: [...stableIds].sort().slice(0, 32),
    searchIds: [...searchIds].sort().slice(0, 32)
  };
}

function canonicalFailureContent(
  code: string,
  message: string,
  details?: Record<string, unknown>
): string {
  return redactSecrets(JSON.stringify({
    ok: false,
    state: 'failed',
    error: {
      code,
      message,
      ...(details && Object.keys(details).length > 0 ? { details } : {})
    }
  }));
}

/** Normalize legacy host denials before they enter history, rollout, or RAG. */
function canonicalizeToolFailureContent(result: {
  ok: boolean;
  content: string;
  code?: string;
}): string {
  if (result.ok) return redactSecrets(result.content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content) as unknown;
  } catch {
    parsed = undefined;
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
  const existingError = record?.error && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : {};
  const code = typeof existingError.code === 'string' && existingError.code.trim() !== ''
    ? existingError.code
    : typeof record?.code === 'string' && record.code.trim() !== ''
      ? record.code
      : result.code ?? 'TOOL_EXECUTION_FAILED';
  const message = typeof existingError.message === 'string' && existingError.message.trim() !== ''
    ? existingError.message.trim().slice(0, 1_000)
    : typeof record?.message === 'string' && record.message.trim() !== ''
      ? record.message.trim().slice(0, 1_000)
      : result.content.trim().slice(0, 1_000) || `工具 ${code} 执行失败。`;
  const nestedDetails = existingError.details && typeof existingError.details === 'object'
    && !Array.isArray(existingError.details)
    ? existingError.details as Record<string, unknown>
    : undefined;
  const legacyDetails = record?.details && typeof record.details === 'object'
    && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : undefined;
  const details = nestedDetails ?? legacyDetails;
  return redactSecrets(JSON.stringify({
    ok: false,
    state: 'failed',
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  }));
}

function failureCodeFromContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' && code.trim() !== '' ? code : undefined;
  } catch {
    return undefined;
  }
}

function nativeFollowupForDiscovery(toolName: string): string | undefined {
  switch (toolName) {
    case 'search_text_entries':
      return 'read_fmg_entries';
    case 'search_param_rows':
      return 'search_param_fields';
    case 'search_param_fields':
      return 'read_param_fields';
    case 'search_events':
      return 'read_emevd_outline';
    case 'search_map_entities':
      // Map search returns Parts, Regions, Models and Events.  The generic
      // native consumer must preserve that union; read_msb_parts is a Part-
      // only reader and rejects a region address with MSB_PART_NOT_FOUND.
      return 'query_map_objects';
    case 'search_tae_events':
      return 'read_tae_events';
    case 'search_event_reference':
      return 'search_events';
    default:
      return undefined;
  }
}

function requiredFollowupsForDiscovery(toolName: string): readonly string[] {
  switch (toolName) {
    case 'search_text_entries':
      return ['read_fmg_entries'];
    case 'search_param_rows':
      // Native semantic export may not contain field IDs. Metadata discovery
      // is therefore the safe first consumer; read_param_fields remains the
      // next consumer and still requires an explicit non-empty fieldIds list.
      return ['search_param_fields', 'read_param_fields'];
    case 'search_param_fields':
      return ['read_param_fields'];
    case 'search_events':
      return ['read_emevd_outline'];
    case 'search_map_entities':
      return ['query_map_objects'];
    case 'search_tae_events':
      return ['read_tae_events'];
    case 'search_event_reference':
      return ['search_events'];
    default:
      return [];
  }
}

function semanticToolFailureSignature(
  auditEntry: AgentRunResult['audit']['toolCalls'][number],
  plannedEntry: { kind: 'denied' | 'execute'; call: ToolCall } | undefined
): string | null {
  if (auditEntry.ok) return null;
  if (auditEntry.code === 'TEXT_LOOKUP_REQUIRED') return auditEntry.code;
  const name = plannedEntry?.call.name ?? auditEntry.name;
  if (name !== 'search_param_rows' && name !== 'read_param_fields') return null;
  let input: unknown;
  try {
    input = plannedEntry?.call.argumentsJson ? JSON.parse(plannedEntry.call.argumentsJson) : null;
  } catch {
    input = null;
  }
  const table = input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>).table
    : undefined;
  if (typeof table !== 'string' || table.trim() === '') return 'PARAM_TABLE:unknown';
  // Deliberately exclude rowIds/fieldIds/container paths: changing one row or
  // absolute path is not new evidence that the table exists.
  return `PARAM_TABLE:${table.trim().toLocaleLowerCase()}`;
}

const INCOMPLETE_CONCLUSION_PATTERNS: readonly RegExp[] = [
  /(?:接下来|下一步)(?:我)?(?:会|将|准备|继续|开始|去)?[^。！？\n]{0,48}(?:执行|修改|修复|实现|落地|检查|验证|处理)/u,
  /(?:我现在|我马上|随后我会|然后我会)[^。！？\n]{0,48}(?:执行|修改|修复|实现|落地|检查|验证|处理)/u,
  /\b(?:next\s+i(?:'ll|\s+will)|i\s+will\s+now|i'm\s+going\s+to|proceed(?:ing)?\s+to)\b/i
];

/**
 * A blocked/partial report may contain a "next step" section as part of its
 * handoff. That is a terminal report, not an instruction to sample again.
 * Keep this guard narrow: only explicit inability/evidence-terminal language
 * suppresses the future-action heuristic.
 */
const TERMINAL_CONCLUSION_PATTERNS: readonly RegExp[] = [
  /(?:证据|工作区|语料|索引)(?:不足|缺失|为空|未就绪|不可用|阻塞)/u,
  /(?:证据|工作区|语料|索引)[^。！？\n]{0,24}(?:阻塞|不可用|无法继续)/u,
  /(?:无法|不能|未能)(?:继续|完成|执行|写入|验证|确定|定位)/u,
  /\b(?:blocked|partial|insufficient_evidence)\b/i,
  /(?:任务|当前状态)[^。！？\n]{0,16}(?:阻塞|未完成|无法执行)/u
];

/** 识别“承诺下一步动作、但本轮没有工具调用”的非终态回复。 */
export function looksLikeIncompleteConclusion(content: string): boolean {
  const normalized = content.trim();
  if (normalized.length === 0 || TERMINAL_CONCLUSION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return INCOMPLETE_CONCLUSION_PATTERNS.some((pattern) => pattern.test(normalized));
}

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]+/gi,
  // Header inline secrets may appear quoted or bare; the value token class keeps
  // the match anchored to the header keyword so prose cannot false-positive.
  /x-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi,
  /api[_-]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function assertNoSecretLeak(payload: unknown, apiKey: string): void {
  const serialized = JSON.stringify(payload);
  if (apiKey && serialized.includes(apiKey)) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: audit or DTO payload contains raw API key.');
  }
  // Any remaining secret-shaped text (sk- token, Bearer token, x-api-key: /
  // api_key: inline value) is rejected via the same redaction patterns.
  if (redactSecrets(serialized) !== serialized) {
    throw new Error('MODEL_SERVICE_SECRET_LEAK: payload appears to contain an API key pattern.');
  }
}

/**
 * Permission levels that require user approval by default.
 *
 * These are the levels that can reach staging, a committed write, or a backup
 * restore. `propose` and `validate` are deliberately absent: both produce
 * artifacts without touching disk, and asking about them would train the user
 * to click through approvals — an approval prompt that is almost always safe to
 * accept stops being read.
 */
export const DEFAULT_APPROVAL_REQUIRED_LEVELS: readonly string[] = Object.freeze([
  'stage',
  'commit',
  'rollback',
  'write'
]);

/**
 * 已知的非生产工具名(fake-loop / conformance 自造,以及 testing/harness 的
 * scaffold registry)。它们没有 permissionLevel 可查,故仍按名字判定。
 *
 * 单独列出而不是混进 planAllow:这样「按名字」的部分被限定在测试构造的工具上,
 * 生产工具一律走等级判据。
 */
const NON_PRODUCTION_PLAN_ALLOW: ReadonlySet<string> = new Set([
  // fake-loop 与 conformance 自造的只读工具名
  'read_resource',
  'search_workspace',
  'list_diagnostics',
  // testing/harness 的 scaffold typed registry
  'workspace.stats',
  'resource.graph.query',
  'workspace.readFile'
]);

export function isToolAllowedInMode(
  toolName: string,
  mode: AgentRunRequest['permissionMode'],
  registeredTools: Set<string>,
  /** 工具名 → permissionLevel；生产 bridge 会透出该字段。 */
  toolLevels?: ReadonlyMap<string, string>
): { ok: true } | { ok: false; code: string; message: string } {
  if (!registeredTools.has(toolName)) {
    return {
      ok: false,
      code: 'AGENT_TOOL_NOT_REGISTERED',
      message: `工具 ${toolName} 未在注册表中。`
    };
  }
  const level = toolLevels?.get(toolName);
  if (level === undefined) {
    // 没有等级信息只允许兼容测试构造的只读工具；生产 bridge 一律带等级。
    if (mode === 'plan' && !NON_PRODUCTION_PLAN_ALLOW.has(toolName)) {
      return {
        ok: false,
        code: 'AGENT_TOOL_DENIED_PLAN_MODE',
        message: `计划模式不允许执行工具 ${toolName}(未提供 permissionLevel,`
          + '且不在已知的非生产只读工具清单里)。'
      };
    }
    return { ok: true };
  }

  const policyMode = mode === 'full' ? 'fullPermission' : mode;
  const decision = decideAiToolPermission(level as AiToolPermissionLevel, policyMode);
  if (!decision.allowed) {
    return {
      ok: false,
      code: mode === 'plan' ? 'AGENT_TOOL_DENIED_PLAN_MODE' : 'AGENT_TOOL_PERMISSION_DENIED',
      message: `工具 ${toolName} 需要 ${decision.required} 权限,`
        + `但 ${decision.mode} 模式上限为 ${decision.ceiling}。`
    };
  }
  return { ok: true };
}

/**
 * Consume adapter.stream() into a single ModelCompleteResult so the retry and
 * post-processing paths are shared with the batch complete() path. Text
 * deltas are forwarded to the caller for agent-level event emission.
 */
async function collectStreamCompletion(
  adapter: ModelServiceAdapter,
  request: ModelCompleteRequest,
  onTextDelta: (text: string) => void,
  onThinkingDelta?: (text: string) => void
): Promise<ModelCompleteResult> {
  let content = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: ModelCompleteResult['finishReason'] = 'stop';
  let usage: ModelCompleteResult['usage'];
  const diagnostics: ModelServiceDiagnostic[] = [];
  let stopped = false;
  try {
    for await (const event of adapter.stream(request)) {
      switch (event.type) {
        case 'text-delta':
          content += event.text;
          onTextDelta(event.text);
          break;
        case 'thinking-delta':
          onThinkingDelta?.(event.text);
          break;
        case 'tool-call':
          toolCalls.push(event.toolCall);
          break;
        case 'usage': {
          const next: { inputTokens?: number; outputTokens?: number } = { ...(usage ?? {}) };
          if (event.inputTokens != null) next.inputTokens = event.inputTokens;
          if (event.outputTokens != null) next.outputTokens = event.outputTokens;
          usage = next;
          break;
        }
        case 'message-stop':
          finishReason = event.finishReason;
          stopped = true;
          break;
        case 'error':
          diagnostics.push({ severity: 'error', code: event.code, message: event.message });
          finishReason = 'error';
          stopped = true;
          break;
      }
      if (stopped) break;
    }
  } catch (error) {
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
    } else {
      const classified = classifyFetchError(error, '流式响应', request.signal);
      diagnostics.push(classified);
      finishReason = 'error';
    }
  }
  if (finishReason === 'stop' && toolCalls.length > 0) {
    finishReason = 'tool_use';
  }
  return {
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length ? { toolCalls } : {})
    },
    finishReason,
    ...(usage ? { usage } : {}),
    diagnostics
  };
}

export async function runAgentToolLoop(
  adapter: ModelServiceAdapter,
  request: AgentRunRequest
): Promise<AgentRunResult> {
  // Production runs must be bounded even when the host omits maxSteps.  Keep
  // the same hard ceiling in core as in the desktop host so another caller
  // cannot accidentally reintroduce an unbounded 200-step tool loop.
  const maxSteps = request.maxSteps == null || !Number.isFinite(request.maxSteps)
    ? DEFAULT_AGENT_MAX_STEPS
    : Math.min(DEFAULT_AGENT_MAX_STEPS, Math.max(1, Math.trunc(request.maxSteps)));
  const maxTotalOutputTokens = request.maxTotalOutputTokens == null
    || !Number.isFinite(request.maxTotalOutputTokens)
    ? undefined
    : Math.max(0, Math.trunc(request.maxTotalOutputTokens));
  const messages: ChatMessage[] = [...request.messages];
  const diagnostics: AgentRunResult['diagnostics'] = [];
  const toolAudit: AgentRunResult['audit']['toolCalls'] = [];
  const retriesAudit: NonNullable<AgentRunResult['audit']['retries']> = [];
  const compactionsAudit: NonNullable<AgentRunResult['audit']['compactions']> = [];
  const registered = new Set(request.tools.map((tool) => tool.name));
  const toolDefs = new Map(request.tools.map((tool) => [tool.name, tool]));
  // 工具名 → permissionLevel,供 plan 模式的等级判据使用。只收录真的带等级的
  // 工具:漏收会让该工具落到「非生产工具」名字判定,那是兼容路径而不是放行。
  const toolLevelsByName = new Map<string, string>(
    request.tools
      .filter((tool): tool is typeof tool & { permissionLevel: string } =>
        typeof tool.permissionLevel === 'string' && tool.permissionLevel !== '')
      .map((tool) => [tool.name, tool.permissionLevel])
  );
  const broker = request.contextBroker;
  const brokerOptions = request.contextBrokerOptions;
  const contextAssemblies: NonNullable<AgentRunResult['audit']['contextAssemblies']> = [];
  const evidenceQueue: ContextEvidenceSource[] = [];
  let evidenceVersion = 0;
  let assembledEvidenceVersion = -1;
  let assembledEvidenceWindow = -1;
  const emit = (event: AgentEvent): void => {
    request.onEvent?.(event);
  };
  const retryPolicy = resolveRetryPolicy(request.retryPolicy);
  const streamBudget = Math.min(
    Math.max(1, request.streamMaxRetries ?? DEFAULT_STREAM_MAX_RETRIES),
    MAX_RETRY_ATTEMPTS_CAP
  );
  const activeRetryPolicy = request.streaming
    ? { ...retryPolicy, maxAttempts: streamBudget }
    : retryPolicy;
  let currentMode: AgentPermissionMode = request.permissionMode ?? 'plan';
  let consecutiveIdenticalToolFailures = 0;
  let lastFailedToolSignature: string | null = null;
  let consecutiveSemanticToolFailures = 0;
  let lastSemanticToolFailure: string | null = null;
  let steps = 0;
  let finishReason = 'stop';
  let totalOutputTokens = 0;
  let lastInputTokens: number | undefined;
  let compactionWindows = 0;
  let consecutiveDiscoveryOnlyTurns = 0;
  let forcedConclusion = false;
  let lengthConclusionAttempted = false;
  // A successful field-metadata lookup is the last discovery step before the
  // mandatory bounded native read.  Give the provider one extra turn at the
  // research boundary to consume that metadata; the generic discovery guard
  // remains unchanged for ordinary repeated searches.
  let paramFieldReadGraceUsed = false;
  const pendingDiscoveryFollowups = new Set<string>();
  const researchEvidenceKeys = new Set<string>();
  // The external task query is fixed for the run.  Cache its RAG result so a
  // 200-step tool loop does not issue the same embedding HTTP request and
  // candidate scan before every model call.  The evidence is re-injected after
  // compaction, while native reads remain the authority for newly discovered
  // objects and the write gate.
  let cachedRagResult: RagRetrieveResult | undefined;
  // The fixed task query is searched once per context window.  Re-injecting
  // the same six hits on every model turn needlessly enlarges provider input;
  // after compaction a fresh window receives the bounded evidence again.
  let ragSearchWindow = -1;
  // Retrieval must never infer its goal from durable history: an internal
  // continuation is also allowed to be a role=user message. Production hosts
  // capture the external prompt into taskQuery before entering the loop; when a
  // lower-level caller omits it, fail closed by skipping automatic retrieval.
  const initialUserQuery = request.taskQuery?.trim() ?? '';
  if (request.ragSearch && initialUserQuery.length === 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'AGENT_TASK_QUERY_MISSING',
      message: '缺少固定 external taskQuery，已跳过自动 RAG 检索；不会从 role=user 历史猜测任务。'
    });
  }

  // Approval gate. Defaults to the write-capable levels when a host provides
  // the callback without naming levels — the levels that can reach staging,
  // commit or a backup restore are exactly the ones worth a human checkpoint.
  const approvalLevels = new Set(
    request.approvalRequiredLevels ?? DEFAULT_APPROVAL_REQUIRED_LEVELS
  );
  /**
   * Session-scoped memory for `always` / `never`, keyed by tool name.
   *
   * In-memory and per-run on purpose: persisting "always allow rollback" would
   * carry a decision made about one workspace into the next one.
   */
  const approvalMemory = new Map<string, 'always' | 'never'>();
  const approvalsAudit: NonNullable<AgentRunResult['audit']['approvals']> = [];
  let abortedByApproval = false;

  const recordMessage = (step: number, message: ChatMessage): void => {
    request.rollout?.enqueue({ type: 'message', step, message });
  };
  const recordInterrupted = (): void => {
    request.rollout?.enqueue({ type: 'interrupted', at: new Date().toISOString() });
  };

  /**
   * 执行一次上下文压缩并落地其副作用（替换历史、审计、事件、rollout 标记）。
   * pre-sampling 阈值触发与 context-overflow 恢复共用；失败只记诊断、保留原历史。
   */
  const runAutoCompact = async (reason: 'auto' | 'overflow'): Promise<boolean> => {
    const compacted = await runCompaction(adapter, {
      messages,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.compaction ? { options: request.compaction } : {})
    });
    if (!compacted.ok) {
      diagnostics.push(...compacted.diagnostics);
      return false;
    }
    messages.length = 0;
    messages.push(...compacted.replacementMessages);
    lastInputTokens = undefined;
    compactionWindows += 1;
    const tokenLimit = request.compaction?.autoCompactTokenLimit ?? 0;
    compactionsAudit.push({
      step: steps,
      reason,
      tokenLimit,
      summaryBytes: compacted.summary.length
    });
    diagnostics.push({
      severity: 'info',
      code: 'CONTEXT_COMPACTION_APPLIED',
      message: `上下文已压缩为 ${compacted.replacementMessages.length} 条消息（摘要 ${compacted.summary.length} 字符）。`
    });
    emit({ type: 'context-compacted', step: steps, reason, tokenLimit });
    request.rollout?.enqueue({
      type: 'compacted',
      at: new Date().toISOString(),
      windowId: `window-${compactionWindows}`,
      // 压缩后的替换历史随标记持久化：resume 时重建压缩窗口内的历史
      // （Codex RolloutItem::Compacted.replacement_history 同款语义）。
      replacementHistory: compacted.replacementMessages
    });
    return true;
  };

  let emptyConclusionRetries = 0;
  let incompleteConclusionRetries = 0;

  const conclusionReserveTokens = maxTotalOutputTokens !== undefined
    && request.tools.length > 0
    && maxTotalOutputTokens > 1_024
    ? Math.min(CONCLUSION_RESERVE_TOKENS, Math.floor(maxTotalOutputTokens / 4))
    : 0;
  const armForcedConclusion = (code: string, reason: string): void => {
    if (forcedConclusion) return;
    forcedConclusion = true;
    messages.push({
      role: 'system',
      content: `${reason}下一次模型调用禁止使用工具，只能根据已经返回的候选、原生读取结果和任务记录汇报：`
        + '已确认项、未确认项、具体缺口与可执行下一步；不得声称已写入或完成未验证的修改。'
        + '只输出不超过 600 字的汇报，不要重新规划或请求工具。'
    });
    diagnostics.push({
      severity: 'warning',
      code,
      message: `${reason}下一次模型调用将强制汇报并关闭工具。`
    });
  };

  while (steps < maxSteps) {
    if (request.signal?.aborted) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环已取消。'
      });
      break;
    }
    if (!forcedConclusion
      && conclusionReserveTokens > 0
      && toolAudit.length > 0
      && maxTotalOutputTokens !== undefined
      && maxTotalOutputTokens - totalOutputTokens <= conclusionReserveTokens) {
      armForcedConclusion(
        'AGENT_OUTPUT_BUDGET_CONCLUSION_RESERVED',
        `累计输出预算即将耗尽，已为最终汇报保留 ${conclusionReserveTokens} token。`
      );
    }
    if (maxTotalOutputTokens !== undefined && totalOutputTokens >= maxTotalOutputTokens) {
      finishReason = 'length';
      diagnostics.push({
        severity: 'warning',
        code: 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED',
        message: `累计输出 token 已达到预算 ${maxTotalOutputTokens}，未继续发起模型请求。`
      });
      break;
    }
    steps += 1;
    emit({ type: 'turn-started', step: steps });

    // Pre-sampling auto-compaction (Codex run_pre_sampling_compact): when the
    // estimated context reaches the configured limit, summarize and replace
    // the history in place. Failure fails closed — the original history stays.
    const autoCompactLimit = request.compaction?.autoCompactTokenLimit;
    if (autoCompactLimit != null) {
      const estimatedTokens = lastInputTokens ?? estimateContextTokens(messages);
      if (estimatedTokens >= autoCompactLimit) {
        await runAutoCompact('auto');
        if (request.signal?.aborted) {
          finishReason = 'cancelled';
          recordInterrupted();
          diagnostics.push({
            severity: 'warning',
            code: 'AGENT_CANCELLED',
            message: 'Agent 循环在上下文压缩期间取消。'
          });
          break;
        }
      }
    }

    const ephemeralMessages: ChatMessage[] = [];

    // Context Broker: assemble accumulated workspace evidence into a bounded,
    // redacted fragment injected before the model call. No evidence is
    // surfaced structurally as insufficient_evidence instead of failing silently.
    if (broker && (assembledEvidenceVersion !== evidenceVersion
      || assembledEvidenceWindow !== compactionWindows)) {
      const assembled = await broker.assemble(evidenceQueue, brokerOptions);
      assembledEvidenceVersion = evidenceVersion;
      assembledEvidenceWindow = compactionWindows;
      if (assembled.ok) {
        ephemeralMessages.push({ role: 'system', content: assembled.context });
        diagnostics.push({
          severity: 'info',
          code: 'CONTEXT_BROKER_ASSEMBLED',
          message: `已装配 ${assembled.sections.length} 段工作区证据（${assembled.totalBytes} bytes）。`
        });
        contextAssemblies.push({
          ok: true,
          sections: assembled.sections.length,
          totalBytes: assembled.totalBytes
        });
        emit({
          type: 'context-assembled',
          step: steps,
          sections: assembled.sections.length,
          totalBytes: assembled.totalBytes
        });
      } else {
        diagnostics.push(...assembled.diagnostics);
        contextAssemblies.push({
          ok: false,
          sections: 0,
          totalBytes: 0,
          ...(assembled.code ? { code: assembled.code } : {})
        });
        ephemeralMessages.push({
          role: 'system',
          content: canonicalFailureContent(assembled.code, assembled.message)
        });
      }
    }

    // RAG auto-search: retrieve workspace evidence once from the initial user
    // query and inject as a separate [rag-evidence] channel. No hits or an
    // empty query injects nothing — a failed search must not poison the turn.
    if (request.ragSearch) {
      const ragQuery = initialUserQuery;
      if (ragQuery.trim().length > 0 && ragSearchWindow !== compactionWindows) {
        ragSearchWindow = compactionWindows;
        cachedRagResult ??= await request.ragSearch.retrieve(ragQuery);
        const ragResult = cachedRagResult;
        if (ragResult.ok && ragResult.hits.length > 0) {
          const ragMaxHits = Math.max(1, Math.min(8, Math.trunc(request.ragSearch.maxHits ?? 4)));
          const ragHits = ragResult.hits.slice(0, ragMaxHits);
          const ragLines = ragHits.map((hit, index) => [
            `-- hit ${index + 1} (score=${hit.score}, family=${hit.chunk.family}, uri=${hit.chunk.symbolUri}) --`,
            hit.excerpt
          ].join('\n'));
          ephemeralMessages.push({
            role: 'system',
            content: `[rag-evidence query="${ragQuery.replaceAll('"', '\\"')}" hits=${ragHits.length}]\n${ragLines.join('\n')}`
          });
          diagnostics.push({
            severity: 'info',
            code: 'RAG_EVIDENCE_INJECTED',
            message: `已注入 ${ragHits.length} 条工作区检索证据（查询「${ragQuery.slice(0, 80)}」）。`
          });
        } else if (!ragResult.ok) {
          diagnostics.push({
            severity: 'warning',
            code: ragResult.code,
            message: `RAG 未注入证据：${ragResult.message}`
          });
        }
      }
    }

    // Model call with retry/backoff. Both transport paths (complete/stream)
    // normalize into ModelCompleteResult, so one retry loop covers them.
    let completion: ModelCompleteResult = {
      message: { role: 'assistant', content: '' },
      finishReason: 'error',
      diagnostics: []
    };
    let cancelledDuringRetry = false;
    let attempt = 0;
    let overflowRecovered = false;
    // 每次模型调用统一携带宿主配置的采样/能力参数；未配置的字段不下发。
    const requestedMaxTokens = request.sampling?.maxTokens !== undefined
      && Number.isFinite(request.sampling.maxTokens)
      ? Math.max(1, Math.trunc(request.sampling.maxTokens))
      : undefined;
    const remainingOutputTokens = maxTotalOutputTokens === undefined
      ? undefined
      : Math.max(1, maxTotalOutputTokens - totalOutputTokens);
    const samplingBudget = !forcedConclusion && conclusionReserveTokens > 0
      && remainingOutputTokens !== undefined
      && remainingOutputTokens > conclusionReserveTokens
      ? remainingOutputTokens - conclusionReserveTokens
      : remainingOutputTokens;
    const effectiveMaxTokens = remainingOutputTokens === undefined
      ? requestedMaxTokens
      : Math.min(requestedMaxTokens ?? samplingBudget!, samplingBudget!);
    const samplingFields = {
      ...(request.sampling?.temperature !== undefined ? { temperature: request.sampling.temperature } : {}),
      ...(effectiveMaxTokens !== undefined ? { maxTokens: effectiveMaxTokens } : {}),
      ...(request.sampling?.topP !== undefined ? { topP: request.sampling.topP } : {}),
      ...(request.sampling?.topK !== undefined ? { topK: request.sampling.topK } : {}),
      ...(request.sampling?.thinkingLevel !== undefined ? { thinkingLevel: request.sampling.thinkingLevel } : {})
    };
    const callMessages = [...messages, ...ephemeralMessages];
    for (;;) {
      attempt += 1;
      completion = request.streaming
        ? await collectStreamCompletion(
            adapter,
            {
              messages: callMessages,
              tools: forcedConclusion ? [] : request.tools,
              ...samplingFields,
              ...(request.signal ? { signal: request.signal } : {}),
              ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
            },
            (text) => emit({ type: 'agent-message-delta', step: steps, text }),
            (text) => emit({ type: 'agent-thinking-delta', step: steps, text })
          )
        : await adapter.complete({
            messages: callMessages,
            tools: forcedConclusion ? [] : request.tools,
            ...samplingFields,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.timeoutMs != null ? { timeoutMs: request.timeoutMs } : {})
          });
      if (completion.finishReason !== 'error' || request.signal?.aborted) break;
      // Context-overflow 错误不走退避重试（OpenCode retry.ts：overflow 不参与
      // retry）：压缩历史后用新上下文重试一次；压缩后仍溢出则失败关闭，避免
      // 「每次调用前都尝试压缩」的循环。
      if (isContextOverflowDiagnostic(completion.diagnostics)) {
        if (overflowRecovered) break;
        overflowRecovered = true;
        diagnostics.push({
          severity: 'info',
          code: 'CONTEXT_OVERFLOW_RECOVERY',
          message: '模型调用因上下文超窗失败，压缩历史后重试。'
        });
        const recovered = await runAutoCompact('overflow');
        if (!recovered || request.signal?.aborted) break;
        continue;
      }
      const decision = decideRetry(completion.diagnostics, attempt, activeRetryPolicy);
      if (!decision.retry) break;
      retriesAudit.push({
        step: steps,
        attempt,
        code: decision.code ?? 'UNKNOWN',
        delayMs: decision.delayMs
      });
      diagnostics.push({
        severity: 'info',
        code: 'MODEL_SERVICE_RETRY_SCHEDULED',
        message: `第 ${attempt} 次调用失败（${decision.code}），${decision.delayMs}ms 后重试。`
      });
      emit({
        type: 'retry-scheduled',
        step: steps,
        attempt,
        maxAttempts: activeRetryPolicy.maxAttempts,
        delayMs: decision.delayMs,
        code: decision.code ?? 'UNKNOWN'
      });
      const rested = await sleepWithSignal(decision.delayMs, request.signal);
      if (rested === 'cancelled') {
        cancelledDuringRetry = true;
        break;
      }
    }
    // An active cancellation landing mid-request or mid-backoff surfaces as
    // 'cancelled' rather than being collapsed into the adapter's error.
    if (cancelledDuringRetry || request.signal?.aborted) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环在模型调用期间取消。'
      });
      break;
    }
    diagnostics.push(...completion.diagnostics);
    if (completion.usage?.outputTokens) {
      totalOutputTokens += completion.usage.outputTokens;
    }
    if (completion.usage?.inputTokens != null) {
      lastInputTokens = completion.usage.inputTokens;
    }
    if (maxTotalOutputTokens !== undefined && totalOutputTokens > maxTotalOutputTokens) {
      finishReason = 'length';
      diagnostics.push({
        severity: 'warning',
        code: 'MODEL_SERVICE_OUTPUT_BUDGET_EXCEEDED',
        message: `累计输出 token ${totalOutputTokens} 超过预算 ${maxTotalOutputTokens}。`
      });
      break;
    }
    if (completion.finishReason === 'error') {
      finishReason = 'error';
      const errorMsg = completion.diagnostics.find((d) => d.severity === 'error')?.message
        ?? '模型调用异常失败。';
      emit({
        type: 'agent-message-delta',
        step: steps,
        text: `\n\n⚠️ **模型调用失败**：${errorMsg}`
      });
      break;
    }
    // Redact at push time (same policy as tool results): model output may echo
    // secret-shaped text from read files; the internal history, rollout and
    // audit must never carry it.
    const safeMessage: ChatMessage = {
      ...completion.message,
      content: redactSecrets(completion.message.content),
      ...(completion.message.toolCalls
        ? {
            toolCalls: completion.message.toolCalls.map((call) => ({
              ...call,
              argumentsJson: redactSecrets(call.argumentsJson)
            }))
          }
        : {})
    };
    messages.push(safeMessage);
    recordMessage(steps, safeMessage);
    // 非流式路径没有 delta：把整段正文一次推给界面，否则用户只能看见工具行。
    if (!request.streaming && safeMessage.content.length > 0) {
      emit({ type: 'agent-message-delta', step: steps, text: safeMessage.content });
    }
    const toolCalls = safeMessage.toolCalls ?? [];
    emit({ type: 'step-complete', step: steps, finishReason: completion.finishReason });
    // Preserve any streamed assistant text even when the provider stops at its
    // output limit. The previous early break discarded this text, leaving the
    // UI with only the last progress sentence and making a bounded partial run
    // look like a silent failure.
    if (completion.finishReason === 'length') {
      // A provider may truncate a turn at its per-call max even when the
      // total budget still has room. Preserve the truncated assistant span,
      // then allow one bounded tool-free conclusion so the UI never ends with
      // only tool rows and no report. A plain first-turn length response keeps
      // the historical one-request behavior.
      if (!forcedConclusion && toolAudit.length > 0 && !lengthConclusionAttempted) {
        lengthConclusionAttempted = true;
        armForcedConclusion(
          'MODEL_SERVICE_LENGTH_FORCED_CONCLUSION',
          '模型本轮达到单次输出上限，已保留当前过程并请求一次最终汇报。'
        );
        continue;
      }
      finishReason = 'length';
      break;
    }
    if (toolCalls.length === 0) {
      if (forcedConclusion) {
        finishReason = 'partial';
        if (safeMessage.content.trim() === '') {
          emit({
            type: 'agent-message-delta',
            step: steps,
            text: '⚠️ 检索预算已用尽，但模型没有输出汇报内容；任务按 partial 结束。'
          });
        }
        break;
      }
      if (completion.finishReason === 'tool_use') {
        finishReason = 'partial';
        diagnostics.push({
          severity: 'warning',
          code: 'AGENT_TOOL_USE_WITHOUT_CALLS',
          message: '模型声明需要调用工具，但响应没有可执行的工具调用；已按 partial 收口，避免假完成。'
        });
        break;
      }
      if (safeMessage.content.trim() === '' && steps > 1
        && emptyConclusionRetries < MAX_EMPTY_CONCLUSION_RETRIES) {
        emptyConclusionRetries += 1;
        messages.push({
          role: 'user',
          content: '请根据上述已执行的工具检索与排查结果，向用户详细汇报所有排查到的数据（NPC ID、参数行号、事件逻辑等）并给出具体的落地方案。如果是编辑模式，请直接调用工具实施修改。'
        });
        continue;
      }
      if (safeMessage.content.trim() === '') {
        emit({
          type: 'agent-message-delta',
          step: steps,
          text: '⚠️ 模型在完成工具调用后未输出总结内容。请查看上方工具调用记录，或重新发送你的需求。'
        });
      }
      if (looksLikeIncompleteConclusion(safeMessage.content)) {
        if (incompleteConclusionRetries < MAX_EMPTY_CONCLUSION_RETRIES && steps < maxSteps) {
          incompleteConclusionRetries += 1;
          messages.push({
            role: 'system',
            content: '你刚才只描述了将要执行的动作，尚未完成任务。请立即调用合适的工具继续执行；如果确实无法继续，必须明确返回 partial/blocked、具体原因和未完成项，不得再次只承诺下一步。'
          });
          continue;
        }
        finishReason = 'partial';
        diagnostics.push({
          severity: 'warning',
          code: 'AGENT_INCOMPLETE_CONCLUSION',
          message: '模型连续输出未来动作承诺但未调用工具，任务按 partial 结束，未伪装为完成。'
        });
        break;
      }
      finishReason = completion.finishReason;
      break;
    }
    if (completion.finishReason === 'stop') {
      finishReason = completion.finishReason;
      break;
    }
    if (forcedConclusion) {
      finishReason = 'partial';
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_FORCED_CONCLUSION_TOOL_CALL',
        message: '检索预算耗尽后的汇报调用仍返回工具请求，已拒绝继续搜索并按 partial 收口。'
      });
      break;
    }

    // Gate every call first (permission mode + evidence gate), then execute.
    // Consecutive parallel-capable calls run concurrently; exclusive calls run
    // alone. All results are recorded in model emission order (Codex
    // FuturesOrdered drain semantics).
    type PlannedCall =
      | { kind: 'denied'; call: ToolCall; code: string; message: string; details?: Record<string, unknown> }
      | { kind: 'execute'; call: ToolCall; parallel: boolean };
    const planned: PlannedCall[] = [];
    for (const call of toolCalls) {
      const allowed = isToolAllowedInMode(
        call.name,
        currentMode,
        registered,
        toolLevelsByName
      );
      if (!allowed.ok) {
        planned.push({ kind: 'denied', call, code: allowed.code, message: allowed.message });
        continue;
      }

      // A candidate is not useful if the model can keep opening new search
      // branches forever. Require the next turn to consume at least one
      // pending candidate through its declared metadata/native follow-up.
      if (pendingDiscoveryFollowups.size > 0
        && DISCOVERY_PROGRESS_TOOLS.has(call.name)
        && !pendingDiscoveryFollowups.has(call.name)) {
        const references = evidenceReferencesForSources(evidenceQueue);
        planned.push({
          kind: 'denied',
          call,
          code: 'AGENT_DISCOVERY_FOLLOWUP_REQUIRED',
          message: `已有候选证据尚未消费；必须先调用 ${[...pendingDiscoveryFollowups].join('、')}，再继续新的搜索。`,
          details: {
            requiredTools: [...pendingDiscoveryFollowups],
            ...(references.stableIds.length > 0 ? { stableIds: references.stableIds } : {}),
            ...(references.searchIds.length === 1
              ? { searchId: references.searchIds[0] }
              : references.searchIds.length > 1
                ? { searchIds: references.searchIds }
                : {})
          }
        });
        continue;
      }

      // Evidence gate for empty/unsupported test probes
      if (call.name === 'empty_args_test') {
        planned.push({
          kind: 'denied',
          call,
          code: 'insufficient_evidence',
          message: '证据不足，拒绝执行工具。'
        });
        continue;
      }

      // Approval gate — runs after the mode and evidence gates, so a call the
      // mode already forbids is never surfaced to the user as an approvable
      // action. Asking about something that would be denied anyway teaches the
      // user their answer does not matter.
      const level = toolDefs.get(call.name)?.permissionLevel ?? 'read';
      if (request.requestApproval && approvalLevels.has(level)) {
        const remembered = approvalMemory.get(call.name);
        let decision: ApprovalDecision;
        let note: string | undefined;
        if (remembered !== undefined) {
          decision = remembered;
        } else {
          // 先解析 diff 再发事件:界面拿到审批卡片时就该带着改动内容,
          // 而不是先出现一张空卡片再补内容。diff 解析失败不阻塞审批 ——
          // 「看不到 diff」要由用户决定是否照样批准,不能因此静默放行或拒绝。
          let approvalDiff: ApprovalDiff | null = null;
          if (request.resolveApprovalDiff) {
            try {
              approvalDiff = await request.resolveApprovalDiff({
                toolName: call.name,
                argumentsJson: call.argumentsJson
              });
            } catch {
              approvalDiff = null;
            }
          }
          emit({
            type: 'approval-requested',
            step: steps,
            callId: call.id,
            toolName: call.name,
            permissionLevel: level,
            argumentsJson: call.argumentsJson,
            ...(approvalDiff ? { diff: approvalDiff } : {})
          });
          let response: ApprovalResponse;
          try {
            response = await request.requestApproval({
              step: steps,
              callId: call.id,
              toolName: call.name,
              permissionLevel: level,
              argumentsJson: call.argumentsJson,
              ...(approvalDiff ? { diff: approvalDiff } : {})
            });
          } catch (error) {
            // A failed approval channel must deny, never fall through to
            // execute: an unreachable approver is not consent.
            response = {
              decision: 'reject',
              note: `审批通道失败：${error instanceof Error ? error.message : String(error)}`
            };
          }
          decision = response.decision;
          note = response.note;
          if (decision === 'always' || decision === 'never') {
            approvalMemory.set(call.name, decision);
          }
        }
        // abort 放弃整轮，不只是拒绝这一次调用：用户表示不想让这轮继续下去。
        // 与 reject 的区别在于 reject 之后 loop 会带着拒绝结果走下一步，
        // 模型可能换个方式再试。
        if (decision === 'abort') {
          emit({
            type: 'approval-resolved',
            step: steps,
            callId: call.id,
            toolName: call.name,
            decision,
            fromMemory: false
          });
          approvalsAudit.push({
            name: call.name,
            permissionLevel: level,
            decision,
            fromMemory: false,
            ...(note !== undefined ? { note } : {})
          });
          diagnostics.push({
            severity: 'warning',
            code: 'AGENT_ABORTED_BY_APPROVAL',
            message: `用户在审批 ${call.name} 时选择放弃整个任务。`
              + `${note === undefined ? '' : note}`
          });
          finishReason = 'cancelled';
          abortedByApproval = true;
          break;
        }
        emit({
          type: 'approval-resolved',
          step: steps,
          callId: call.id,
          toolName: call.name,
          decision,
          fromMemory: remembered !== undefined
        });
        approvalsAudit.push({
          name: call.name,
          permissionLevel: level,
          decision,
          fromMemory: remembered !== undefined,
          ...(note !== undefined ? { note } : {})
        });
        if (APPROVAL_DECISIONS_DENYING.includes(decision)) {
          planned.push({
            kind: 'denied',
            call,
            // 超时与拒绝用不同错误码：模型看到的原因不同，事后审计也能区分
            // 「用户拒绝」与「没人回答」。
            code: decision === 'timed_out' ? 'APPROVAL_TIMED_OUT' : 'APPROVAL_DENIED',
            message: decision === 'never'
              ? `用户拒绝并已在本会话内永久拒绝工具 ${call.name}。`
              : decision === 'timed_out'
                ? `审批请求超时，未收到回答，按未批准处理：${call.name}。`
                  + `${note === undefined ? '' : note}`
                : `用户拒绝执行工具 ${call.name}。${note === undefined ? '' : note}`
          });
          continue;
        }
      }

      planned.push({
        kind: 'execute',
        call,
        parallel: toolDefs.get(call.name)?.supportsParallel === true
      });
    }

    // abort 必须终止整轮，而不只是跳出 planning 循环。
    //
    // 上面那个 break 只离开 `for (const call of toolCalls)`；不在这里再断一次，
    // 后面的工具执行阶段与外层 while 会照常继续——用户选了「放弃任务」而任务
    // 接着跑，且不会有任何报错。实测确认过这条路径。
    if (abortedByApproval) {
      recordInterrupted();
      break;
    }

    const orderedResults: Array<ChatMessage | undefined> = new Array(planned.length);
    const orderedAudit: Array<AgentRunResult['audit']['toolCalls'][number] | undefined> =
      new Array(planned.length);
    const evidenceAdditions: ContextEvidenceSource[] = [];
    let turnHasDiscoveryProgress = false;
    let turnHasNativeRead = false;
    let turnHasNonDiscovery = false;
    let turnHasNewResearchEvidence = false;
    const candidateDiscoveryTools = new Set<string>();
    let toolPhaseCancelled = false;
    let cursor = 0;
    while (cursor < planned.length) {
      const entry = planned[cursor]!;
      if (entry.kind === 'denied') {
        orderedResults[cursor] = {
          role: 'tool',
          toolCallId: entry.call.id,
          content: canonicalFailureContent(entry.code, entry.message, entry.details)
        };
        orderedAudit[cursor] = { name: entry.call.name, ok: false, code: entry.code };
        cursor += 1;
        continue;
      }
      const batchIndices: number[] = [cursor];
      if (entry.parallel) {
        let next = cursor + 1;
        while (next < planned.length) {
          const candidate = planned[next]!;
          if (candidate.kind === 'execute' && candidate.parallel) {
            batchIndices.push(next);
            next += 1;
            continue;
          }
          break;
        }
      }
      for (const index of batchIndices) {
        const batchEntry = planned[index]!;
        if (batchEntry.kind === 'execute') {
          // Arguments travel with the span so the UI can show *what* a tool was
          // called with, not just its name. Already redacted at push time.
          emit({
            type: 'tool-call-begin',
            step: steps,
            callId: batchEntry.call.id,
            name: batchEntry.call.name,
            argumentsJson: batchEntry.call.argumentsJson
          });
        }
      }
      const settled = await Promise.all(
        batchIndices.map((index) => {
          const batchEntry = planned[index]!;
          if (batchEntry.kind !== 'execute') {
            throw new Error('AGENT_LOOP_INTERNAL: 批次包含非执行条目。');
          }
          const modeOverride = currentMode === 'full' ? 'fullPermission' : currentMode;
          return request.executeTool(batchEntry.call, { mode: modeOverride });
        })
      );
      settled.forEach((result, position) => {
        const index = batchIndices[position]!;
        const batchEntry = planned[index]!;
        if (batchEntry.kind !== 'execute') return;
        const redactedContent = canonicalizeToolFailureContent(result);
        orderedResults[index] = {
          role: 'tool',
          toolCallId: batchEntry.call.id,
          content: redactedContent
        };
        orderedAudit[index] = {
          name: batchEntry.call.name,
          ok: result.ok,
          ...(!result.ok
            ? { code: failureCodeFromContent(redactedContent) ?? result.code ?? 'TOOL_EXECUTION_FAILED' }
            : result.code ? { code: result.code } : {})
        };
        // Feed executed tool results into the broker evidence queue for the
        // next model call. Only redacted text and the tool name are retained.
        evidenceAdditions.push({
          kind: 'toolResult',
          uri: batchEntry.call.name,
          text: redactedContent,
          meta: {
            ...(batchEntry.call.name === 'read_agent_task_record'
              || batchEntry.call.name === 'update_agent_task_record'
              ? { evidenceKey: 'agent-task-record' }
              : {})
          }
        });
        if (batchEntry.call.name === 'switch_mode' && result.ok) {
          const switchedMode = extractSwitchedAgentPermissionMode(result.content);
          if (switchedMode) currentMode = switchedMode;
        }
        emit({
          type: 'tool-call-end',
          step: steps,
          callId: batchEntry.call.id,
          name: batchEntry.call.name,
          ok: result.ok,
          ...(result.code ? { code: result.code } : {})
        });
      });
      cursor += batchIndices.length;
      if (request.signal?.aborted) {
        toolPhaseCancelled = true;
        break;
      }
    }
    let emptyParamFieldSearchSeen = false;
    let nonEmptyParamFieldSearchSeen = false;
    for (let index = 0; index < planned.length; index += 1) {
      const message = orderedResults[index];
      const auditEntry = orderedAudit[index];
      // Entries after a mid-batch cancellation carry no result and are not
      // recorded; the run itself is cancelled below.
      if (!message || !auditEntry) continue;
      messages.push(message);
      toolAudit.push(auditEntry);
      recordMessage(steps, message);
      const plannedEntry = planned[index];
      if (!plannedEntry || plannedEntry.kind !== 'execute') {
        evidenceAdditions.push({
          kind: 'toolResult',
          uri: plannedEntry?.call.name ?? auditEntry.name,
          text: message.content
        });
        // A denied/non-executed call is normally a real workflow action, not a
        // harmless discovery turn. The one exception is our own follow-up
        // gate: a repeated search denied with AGENT_DISCOVERY_FOLLOWUP_REQUIRED
        // is still discovery-only progress and must advance the stall budget;
        // otherwise a model can evade the guard by repeating the same blocked
        // search until the hard 200-step ceiling.
        if (auditEntry?.code === 'AGENT_DISCOVERY_FOLLOWUP_REQUIRED') {
          turnHasDiscoveryProgress = true;
        } else {
          turnHasNonDiscovery = true;
        }
      } else if (NATIVE_READ_TOOLS.has(plannedEntry.call.name)) {
        turnHasNativeRead = true;
      } else if (DISCOVERY_PROGRESS_TOOLS.has(plannedEntry.call.name)) {
        turnHasDiscoveryProgress = true;
        if (auditEntry.ok && envelopeEvidenceStatus(message.content) === 'candidate') {
          candidateDiscoveryTools.add(plannedEntry.call.name);
        }
      } else {
        turnHasNonDiscovery = true;
      }
      if (auditEntry.ok && plannedEntry?.kind === 'execute'
        && (DISCOVERY_PROGRESS_TOOLS.has(plannedEntry.call.name)
          || NATIVE_READ_TOOLS.has(plannedEntry.call.name))) {
        for (const key of collectResearchProgressKeys(message.content)) {
          if (!researchEvidenceKeys.has(key)) {
            researchEvidenceKeys.add(key);
            turnHasNewResearchEvidence = true;
          }
        }
      }
      if (auditEntry.ok) {
        consecutiveIdenticalToolFailures = 0;
        lastFailedToolSignature = null;
        consecutiveSemanticToolFailures = 0;
        lastSemanticToolFailure = null;
      } else {
        // Workflow policy denials are semantic repetitions even when the model
        // varies the forbidden tool or guesses another row id.  Keying this
        // code by arguments would let an unbounded production loop evade the
        // guard forever by changing one number each turn.
        const signature = auditEntry.code === 'TEXT_LOOKUP_REQUIRED'
          ? auditEntry.code
          : plannedEntry
            ? `${plannedEntry.call.name}:${plannedEntry.call.argumentsJson}`
            : auditEntry.name;
        if (lastFailedToolSignature === signature) {
          consecutiveIdenticalToolFailures += 1;
        } else {
          lastFailedToolSignature = signature;
          consecutiveIdenticalToolFailures = 1;
        }
        const semanticSignature = semanticToolFailureSignature(auditEntry, plannedEntry);
        if (semanticSignature !== null) {
          consecutiveSemanticToolFailures += 1;
          lastSemanticToolFailure = semanticSignature;
        } else {
          consecutiveSemanticToolFailures = 0;
          lastSemanticToolFailure = null;
        }
      }
      if (plannedEntry?.kind === 'execute') {
        const toolName = plannedEntry.call.name;
        if (NATIVE_READ_TOOLS.has(toolName)) {
          if (auditEntry.ok && envelopeEvidenceStatus(message.content) === 'native-verified') {
            pendingDiscoveryFollowups.delete(toolName);
            if (toolName === 'read_param_fields') {
              pendingDiscoveryFollowups.delete('search_param_fields');
              paramFieldReadGraceUsed = false;
            }
          }
        } else if (DISCOVERY_PROGRESS_TOOLS.has(toolName) && auditEntry.ok) {
          if (toolName === 'search_param_fields') {
            if (hasExplicitParamFieldId(message.content)) {
              nonEmptyParamFieldSearchSeen = true;
              pendingDiscoveryFollowups.delete(toolName);
            } else {
              // An empty metadata search cannot be consumed by
              // read_param_fields: that tool correctly requires explicit IDs.
              // Keep metadata search as the next allowed discovery so the
              // provider can switch from an object-name token to a semantic
              // field query instead of receiving an impossible read gate.
              emptyParamFieldSearchSeen = true;
              pendingDiscoveryFollowups.delete('read_param_fields');
              pendingDiscoveryFollowups.add('search_param_fields');
            }
          } else {
            pendingDiscoveryFollowups.delete(toolName);
          }
        }
      }
    }
    if (broker && evidenceAdditions.length
      && upsertContextEvidenceSources(evidenceQueue, evidenceAdditions)) {
      evidenceVersion += 1;
    }
    if (consecutiveIdenticalToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      finishReason = 'error';
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_CONSECUTIVE_TOOL_FAILURES_EXCEEDED',
        message: `检测到连续 ${MAX_CONSECUTIVE_TOOL_FAILURES} 次重复语义的工具调用失败（${lastFailedToolSignature ?? ''}），已自动暂停任务以防止死循环。请检查工作区状态或调整输入。`
      });
      break;
    }
    if (consecutiveSemanticToolFailures >= MAX_SEMANTIC_TOOL_FAILURES) {
      finishReason = 'error';
      diagnostics.push({
        severity: 'error',
        code: 'AGENT_SEMANTIC_TOOL_FAILURES_EXCEEDED',
        message: `检测到连续 ${MAX_SEMANTIC_TOOL_FAILURES} 次语义重复的参数发现失败（${lastSemanticToolFailure ?? ''}），即使行号不同也已暂停任务；请先确认表名和文本证据。`
      });
      break;
    }
    if (toolPhaseCancelled) {
      finishReason = 'cancelled';
      recordInterrupted();
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_CANCELLED',
        message: 'Agent 循环在工具执行后取消。'
      });
      break;
    }
    if (!turnHasNativeRead) {
      for (const candidateTool of candidateDiscoveryTools) {
        for (const followup of requiredFollowupsForDiscovery(candidateTool)) {
          pendingDiscoveryFollowups.add(followup);
        }
      }
    }
    if (emptyParamFieldSearchSeen && !nonEmptyParamFieldSearchSeen) {
      pendingDiscoveryFollowups.delete('read_param_fields');
      pendingDiscoveryFollowups.add('search_param_fields');
    }
    const turnHasResearch = turnHasDiscoveryProgress || turnHasNativeRead;
    if (turnHasResearch && !turnHasNonDiscovery) {
      // Count only consecutive research turns that fail to reveal a new
      // stable identity. A search result can be useful progress even when it
      // is followed by another read-only turn; repeated candidates are not.
      consecutiveDiscoveryOnlyTurns = turnHasNewResearchEvidence
        ? 1
        : consecutiveDiscoveryOnlyTurns + 1;
      const needsParamFieldReadGrace = !paramFieldReadGraceUsed
        && candidateDiscoveryTools.has('search_param_fields')
        && pendingDiscoveryFollowups.has('read_param_fields');
      const shouldNudgeNativeFollowup = candidateDiscoveryTools.size > 0
        && !turnHasNativeRead
        && (consecutiveDiscoveryOnlyTurns < MAX_DISCOVERY_ONLY_TURNS || needsParamFieldReadGrace);
      if (shouldNudgeNativeFollowup) {
        const nativeFollowups = [...candidateDiscoveryTools]
          .map((name) => nativeFollowupForDiscovery(name))
          .filter((name): name is string => name !== undefined);
        const nextTools = [...new Set(nativeFollowups)];
        const followupHint = pendingDiscoveryFollowups.has('search_param_fields')
          && !pendingDiscoveryFollowups.has('read_param_fields')
          ? '请再次调用 search_param_fields，但 query 必须改用字段语义词：health/hp、elite/boss、hostile/team/target、lightning/effect 或 drop/reward/item；不要再次使用对象名。'
          : nextTools.length > 0
            ? `优先调用 ${nextTools.join('、')}。`
            : '改用能消费稳定标识的结构化查询或原生读取工具。';
        const nudge: ChatMessage = {
          role: 'system',
          content: '工作流门禁：本轮只完成候选发现，没有完成原生读取。'
            + `候选来源：${[...candidateDiscoveryTools].join('、')}。${followupHint}`
            + '必须使用工具结果中真实返回的 sourceUri、rowId、textId、eventId 等稳定标识；'
            + '禁止重复同义词搜索、扩大同一路径或猜测 ID/行号。若目标属性尚未找到，继续寻找并更新任务记录。'
        };
        messages.push(nudge);
        recordMessage(steps, nudge);
        diagnostics.push({
          severity: 'info',
          code: 'AGENT_DISCOVERY_FOLLOWUP_REQUIRED',
          message: `候选发现未消费，下一轮必须转入原生读取（${nextTools.join('、') || '结构化读取'}）。`
        });
        if (needsParamFieldReadGrace) paramFieldReadGraceUsed = true;
      }
      if (consecutiveDiscoveryOnlyTurns >= MAX_RESEARCH_ONLY_TURNS && !shouldNudgeNativeFollowup) {
        if (!forcedConclusion && steps < maxSteps) {
          armForcedConclusion(
            'AGENT_RESEARCH_BUDGET_EXHAUSTED',
            `连续 ${MAX_RESEARCH_ONLY_TURNS} 轮研究没有发现新的稳定证据，检索预算已用尽。`
          );
          continue;
        }
        finishReason = 'partial';
        diagnostics.push({
          severity: 'warning',
          code: 'AGENT_DISCOVERY_PROGRESS_STALLED',
          message: `连续 ${MAX_RESEARCH_ONLY_TURNS} 轮研究没有发现新的稳定证据，未进入写入或汇报；已停止任务以防止搜索空转。`
        });
        break;
      }
    } else {
      consecutiveDiscoveryOnlyTurns = 0;
    }
    finishReason = 'tool_use';
  }

  if (steps >= maxSteps && finishReason === 'tool_use') {
    finishReason = 'partial';
    diagnostics.push({
      severity: 'warning',
      code: 'AGENT_MAX_STEPS_REACHED',
      message: `Agent 达到 ${maxSteps} 步上限，任务按 partial 结束。`
    });
  }

  // A caller timeout/cancellation can land while the provider is producing a
  // tool-producing turn.  In that case there is no model-authored final text,
  // but the UI and rollout still need an honest terminal report.  Synthesize a
  // bounded system summary only for non-stop terminals with an empty final
  // assistant message; never turn it into a completion claim.
  if (finishReason !== 'stop' && finishReason !== 'tool_use') {
    const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant || lastAssistant.content.trim().length === 0) {
      const mutationCalls = toolAudit
        .filter((call) => /^(?:propose_|mutate_|apply_|stage_|validate_|commit_|rollback_|write_)/.test(call.name))
        .map((call) => call.name);
      const mutationStatus = mutationCalls.length > 0
        ? `检测到写入类工具调用（${[...new Set(mutationCalls)].join('、')}），实际资源状态必须以 Patch Engine 审计与回读为准。`
        : '未发现写入类工具调用。';
      const terminalReport: ChatMessage = {
        role: 'assistant',
        content: `【系统收口摘要-${finishReason}】Agent 在 ${steps} 步后停止，未形成模型最终汇报。`
          + `已记录 ${toolAudit.length} 次工具调用；${mutationStatus}`
          + '当前结果不可视为完成，请从 rollout 的最后一条工具结果继续处理未确认项。'
      };
      messages.push(terminalReport);
      recordMessage(steps, terminalReport);
      diagnostics.push({
        severity: 'warning',
        code: 'AGENT_TERMINAL_REPORT_EMITTED',
        message: '终态没有模型正文，已生成明确标注为未完成的系统收口摘要。'
      });
    }
  }

  const audit: AgentRunResult['audit'] = {
    configId: request.config.id,
    protocol: request.config.protocol,
    permissionMode: request.permissionMode,
    toolCalls: toolAudit,
    redacted: true,
    ...(request.streaming ? { streaming: true } : {}),
    ...(retriesAudit.length ? { retries: retriesAudit } : {}),
    ...(compactionsAudit.length ? { compactions: compactionsAudit } : {}),
    ...(approvalsAudit.length ? { approvals: approvalsAudit } : {}),
    ...(contextAssemblies.length ? { contextAssemblies } : {})
  };
  assertNoSecretLeak({ messages, audit, diagnostics }, request.apiKey);
  if (request.rollout) {
    const taskStatus = finishReason === 'cancelled'
      ? 'cancelled'
      : finishReason === 'error'
        ? 'error'
        : finishReason === 'partial' || finishReason === 'length'
          ? 'partial'
          : 'completed';
    request.rollout.enqueue({
      type: 'turn-complete',
      at: new Date().toISOString(),
      finishReason,
      taskStatus,
      steps,
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        message: redactSecrets(diagnostic.message)
      }))
    });
    await request.rollout.flush();
  }
  emit({ type: 'turn-complete', finishReason, steps });

  return {
    messages: messages.map((message) => ({
      ...message,
      content: redactSecrets(message.content),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call: ToolCall) => ({
              ...call,
              argumentsJson: redactSecrets(call.argumentsJson)
            }))
          }
        : {})
    })),
    steps,
    finishReason,
    diagnostics,
    audit
  };
}

/**
 * Read the production bridge's stable result envelope without coupling the
 * loop to a particular tool-result payload shape.  `switch_mode` returns its
 * record under `data.record`; the top-level form is retained only as a
 * compatibility read for older adapters.  The model-facing mode
 * `fullPermission` maps to the loop's internal `full` level.
 */
export function extractSwitchedAgentPermissionMode(content: unknown): AgentPermissionMode | undefined {
  let parsed: unknown = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const root = parsed as Record<string, unknown>;
  const envelopeData = root.data && typeof root.data === 'object'
    ? root.data as Record<string, unknown>
    : undefined;
  const record = envelopeData?.record && typeof envelopeData.record === 'object'
    ? envelopeData.record as Record<string, unknown>
    : undefined;
  const switched = record?.switched ?? envelopeData?.switched ?? root.switched;
  const mode = record?.currentMode ?? envelopeData?.currentMode ?? root.currentMode;
  if (switched !== true || typeof mode !== 'string') return undefined;
  if (mode === 'plan' || mode === 'normal') return mode;
  if (mode === 'fullPermission' || mode === 'full') return 'full';
  return undefined;
}
