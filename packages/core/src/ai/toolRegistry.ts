import type {
  AiToolPermissionLevel,
  ConfirmationReceipt,
  IndexedFile,
  MapPartEntity,
  PatchMode,
  PatchProposal,
  ReferenceEdge,
  ResourceKind,
  TaeAnimSymbol,
  TaeEventSymbol
} from '@soulforge/shared';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitPatchProposal, createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../patch/graphPatch.js';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../patch/writerContract.js';
import type { RagChunkFamily, RagCorpus } from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { KnowledgeRefreshResult } from '../indexing/knowledgeRefresh.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';
import { buildTextAiContext, renderTextAiPrompt } from './aiContextBuilder.js';
import { buildPlaintextScriptEdit } from '../script/plaintextScriptEdit.js';
import { nativeEditSessionFromContext } from '../editing/nativeEditSession.js';
import { readParamFields, setParamFields, type ParamFieldEdit } from '../param/containerParamEdit.js';
import { readFmgEntries, setFmgEntries, type FmgEntryEdit } from '../editing/fmgEdit.js';
import { applyEmevdDsl, readEmevdOutline } from '../editing/emevdEdit.js';
import { readTaeEvents, setTaeEventTimes } from '../editing/taeEdit.js';
import { readMsbParts, type MsbPartTransformEdit } from '../editing/msbEdit.js';
import {
  batchTransformMapParts,
  executeMapTransaction,
  inspectMapEntity,
  queryMapEntities,
  loadMapDocument
} from '../editing/mapService.js';
import {
  exportMapSceneForBlender,
  importBlenderDeltaToTransaction,
  type BlenderDeltaImport,
  type MapEditTransaction
} from '@soulforge/shared';
import { parseMapAddress } from '@soulforge/shared';
import { decideAiToolPermission, legacyPermissionToLevel } from './toolPermissions.js';
import { buildRagCorpus, mergeCatalogAndPersisted } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { type MemoryStore } from '../memory/memoryStore.js';
/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

export type KnowledgeSourceChange = readonly string[];

export interface ToolContext {
  workspaceIndex: WorkspaceIndex | null;
  mode: 'plan' | 'normal' | 'fullPermission';
  /** Optional durable/in-memory RAG corpus. Absent falls back to building from the index. */
  rag?: RagCorpus;
  /** Optional long-term memory store (Codex MEMORY.md persistent layer). */
  memoryStore?: MemoryStore;
  /**
   * 主进程注入的「真实写/回滚」上下文。纯读工具不需要；写级工具（回滚等）
   * 缺省时干净失败（ROLLBACK_CONTEXT_REQUIRED），绝不用内存 store 冒充生产
   * 通道 —— 之前 rollback_operation 只带内存 store 且无 confirmation，恒以
   * EDIT_CONFIRMATION_REQUIRED 失败，属于半成品，本次接通。
   */
  session?: WorkspaceSession;
  operationLogStore?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  /** 用户对本次具体写操作的确认凭据（main 原生对话框签发，绑定操作 ID）。 */
  confirmation?: ConfirmationReceipt;
  /** Persist/rebuild RAG after a live native read enriches WorkspaceIndex. */
  onSemanticEvidenceUpdated?: (sourceUris?: KnowledgeSourceChange) => Promise<void>;
  /** Invalidate and converge knowledge after a committed native write/rollback. */
  onNativeWriteCommitted?: (changedSources: KnowledgeSourceChange) => Promise<KnowledgeRefreshResult | void>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  permission: ToolPermission;
  permissionLevel?: AiToolPermissionLevel;
  /**
   * Declared input contract, surfaced so callers (notably the agent loop
   * bridge) can project it into a model-facing JSON Schema. Absent means the
   * tool takes no arguments.
   */
  inputSchema?: ToolInputShape;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  /** Stable machine-facing lifecycle state; callers must not infer it from data shape. */
  state?: 'completed' | 'failed' | 'staged' | 'committed' | 'verification_failed'
    | 'unsupported' | 'ambiguous' | 'stale' | 'cancelled' | 'insufficient_evidence';
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * Declared input contract: field name -> expected type
 * ('string' | 'number' | 'boolean' | 'array' | 'object'; trailing '?' marks
 * the field optional; unrecognized type names pass through). Undeclared extra
 * fields are ignored — callers may attach context markers.
 *
 * Enumerations use `enum:a|b|c` (optional as `enum:a|b|c?`). Before this, a
 * field like `direction` was declared as bare `'string'` and the model was
 * told nothing about the three accepted values; a wrong value did not fail but
 * silently fell back to a default (`'sideways'` → `'both'`, `mode: 'destroy'`
 * → the session mode), so the model acted on a result it did not ask for.
 */
export type ToolInputShape = Record<string, string>;

const ENUM_PREFIX = 'enum:';

/** Split a declared type string into its bare type and optionality. */
function parseDeclaredType(declared: string): { bare: string; optional: boolean } {
  const optional = declared.endsWith('?');
  return { bare: optional ? declared.slice(0, -1) : declared, optional };
}

/** Accepted values for an `enum:a|b|c` declaration, or null if not an enum. */
function enumValues(bare: string): string[] | null {
  if (!bare.startsWith(ENUM_PREFIX)) return null;
  const values = bare.slice(ENUM_PREFIX.length).split('|').filter((value) => value.length > 0);
  return values.length > 0 ? values : null;
}

export interface RegisteredTool extends ToolDescriptor {
  inputSchema?: ToolInputShape;
  run: ToolHandler;
}

export function validateToolInput(
  shape: ToolInputShape | undefined,
  input: unknown
): { ok: true } | { ok: false; message: string } {
  if (!shape || Object.keys(shape).length === 0) return { ok: true };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: '工具输入必须是 JSON 对象。' };
  }
  const record = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, declared] of Object.entries(shape)) {
    const { bare: expectedType, optional } = parseDeclaredType(declared);
    const value = record[key];
    if (value === undefined) {
      if (!optional) problems.push(`缺少必填字段 ${key}`);
      continue;
    }
    const allowed = enumValues(expectedType);
    if (allowed !== null) {
      // Enum values are enforced here rather than silently defaulted in the
      // handler, so a wrong value comes back naming the accepted set.
      if (typeof value !== 'string' || !allowed.includes(value)) {
        problems.push(`字段 ${key} 取值应为 ${allowed.join(' | ')} 之一`);
      }
      continue;
    }
    if (!matchesDeclaredType(value, expectedType)) {
      problems.push(`字段 ${key} 类型应为 ${expectedType}`);
    }
  }
  if (problems.length > 0) {
    return { ok: false, message: `INVALID_INPUT: ${problems.join('；')}。` };
  }
  return { ok: true };
}

/**
 * Project a declared ToolInputShape into the JSON Schema the model sees.
 *
 * This is deliberately a *projection* of the same declaration that
 * validateToolInput enforces at runtime, not a second hand-written schema.
 * Two independent copies would drift silently: the model would be told about
 * fields the validator rejects, or vice versa, and nothing would fail.
 *
 * `additionalProperties` stays true on purpose — validateToolInput ignores
 * undeclared extras (callers attach context markers), so advertising a closed
 * object would misdescribe the runtime contract.
 */
export function toolInputShapeToJsonSchema(shape: ToolInputShape | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, declared] of Object.entries(shape ?? {})) {
    const { bare: declaredType, optional } = parseDeclaredType(declared);
    properties[key] = jsonSchemaForDeclaredType(declaredType);
    if (!optional) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: true
  };
}

/**
 * Mirror of matchesDeclaredType's accepted type names. Unrecognized names pass
 * validation unchecked there, so they must project to an unconstrained schema
 * here — claiming a type the validator does not enforce would be a lie to the
 * model in the permissive direction.
 */
function jsonSchemaForDeclaredType(declaredType: string): Record<string, unknown> {
  const allowed = enumValues(declaredType);
  if (allowed !== null) return { type: 'string', enum: allowed };
  switch (declaredType) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array' };
    case 'object':
      return { type: 'object' };
    default:
      return {};
  }
}

function matchesDeclaredType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    const permissionLevel = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    this.tools.set(tool.name, { ...tool, permissionLevel, permission: permissionLevel });
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, permission, permissionLevel, inputSchema }) => ({
      name,
      description,
      permission,
      permissionLevel: permissionLevel ?? normalizePermissionLevel(permission),
      // Surfaced verbatim (not cloned-and-renamed) so the model-facing schema
      // and the runtime validateToolInput check can never disagree: both read
      // this same declaration.
      ...(inputSchema && Object.keys(inputSchema).length > 0 ? { inputSchema } : {})
    }));
  }

  async run(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `Unknown tool: ${name}`);

    const level = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    const permissionDecision = decideAiToolPermission(level, context.mode);
    if (!permissionDecision.allowed) {
      return fail(
        'TOOL_PERMISSION_DENIED',
        `Tool '${name}' requires ${permissionDecision.required} permission in ${context.mode} mode; `
          + `maximum is ${permissionDecision.ceiling}.`
      );
    }

    const inputCheck = validateToolInput(tool.inputSchema, input);
    if (!inputCheck.ok) {
      return fail('INVALID_INPUT', inputCheck.message);
    }

    try {
      return await tool.run(input, context);
    } catch (error) {
      return fail('TOOL_EXCEPTION', error instanceof Error ? error.message : String(error));
    }
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'workspace_stats',
    description: 'Return indexed workspace counts for files, symbols, and references.',
    permission: 'read',
    permissionLevel: 'read',
    run: (_input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      return ok(ws.getStats());
    }
  });

  registry.register({
    name: 'retrieve_evidence',
    description:
      'Hybrid retrieve over the workspace evidence index: exact IDs, lexical text, and one-hop reference expansion. '
        + 'Addresses are param-like: cXXXX / cXXXX#AXXXX(.eN) for actions, MXX / mAA_BB_CC_DD '
        + '(or mAA_BB_CC_DD#partName) for maps. Use this before specialized search_* tools when the '
        + 'question names a flag, entity, event, textId, unknown resource, anim code, or map block.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      query: 'string',
      limit: 'number?',
      families: 'array?',
      expandReferences: 'boolean?'
    },
    run: (input, context) => {
      const corpus = resolveRagCorpus(context);
      if (corpus === null && context.workspaceIndex === null) {
        return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      }
      const value = asRecord(input);
      const query = asString(value.query);
      if (!query.trim()) return fail('INVALID_INPUT', 'retrieve_evidence 需要非空 query。');
      const families = asRagFamilies(value.families);
      const result = retrieveEvidence(corpus, query, {
        limit: asNumber(value.limit, 8),
        ...(value.expandReferences === undefined ? {} : { expandReferences: value.expandReferences === true }),
        ...(families ? { families } : {})
      });
      if (!result.ok) {
        if (result.code === 'insufficient_evidence') return ok({ query, hits: [], totalHits: 0, note: result.message });
        return fail(result.code, result.message);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?', kinds: 'array?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const kinds = asResourceKinds(value.kinds);
      return ok(ws.searchResources({ query, limit, ...(kinds ? { kinds } : {}) }));
    }
  });

  registry.register({
    name: 'search_events',
    description: 'Search parsed event symbols. For exact lookup pass file + eventId; fuzzy query remains text-first gated.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', file: 'string?', eventId: 'number?', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const file = asOptionalString(value.file);
      const eventId = value.eventId === undefined ? undefined : asNumber(value.eventId, Number.NaN);
      const limit = Math.max(1, Math.min(200, Math.trunc(asNumber(value.limit, 50))));
      if (file !== undefined || eventId !== undefined) {
        if (!file || eventId === undefined || !Number.isSafeInteger(eventId)) {
          return fail('INVALID_INPUT', 'search_events exact lookup 需要 file 与安全整数 eventId。');
        }
        const indexedFile = ws.getFiles().find((candidate) => [
          candidate.sourceUri,
          candidate.sourcePath,
          candidate.absolutePath,
          candidate.relativePath
        ].includes(file));
        if (!indexedFile) {
          return fail('EVENT_SOURCE_NOT_INDEXED', `事件源文件未建立索引: ${file}`);
        }
        const matches = ws.lookupEvents(eventId, indexedFile.sourceUri).slice(0, limit);
        if (matches.length === 0) {
          return fail('EVENT_NOT_FOUND', `未找到 ${file} 中的 eventId ${eventId}。`);
        }
        return ok(matches);
      }
      const query = asOptionalString(value.query)?.trim();
      if (!query) return fail('INVALID_INPUT', 'search_events 需要 query，或 file + eventId。');
      return ok(ws.searchEvents(query, limit));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities and regions.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_tae_events',
    description: 'Search parsed TAE animation events by address (c1050#A0200.e0), anim code, '
      + 'frame, SoundID, or type name. TAE events live inside anibnd; do not unpack BND or '
      + 'treat anibnd as text.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchTaeEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(ws.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up parsed text entries by numeric textId and optional category.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { textId: 'number', category: 'string?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'lookup_text_id requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      return ok({ textId, category, matches });
    }
  });

  registry.register({
    name: 'find_text_references',
    description: 'Find events or other symbols that reference a parsed textId.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { textId: 'number', category: 'string?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'find_text_references requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const items = matches.map((entry) => {
        const references = ws.findReferences(entry.uri, 'to');
        return { entry, references, referenceStats: summarizeReferences(references) };
      });
      return ok({ textId, category, matches: items, totalReferences: items.reduce((sum, item) => sum + item.references.length, 0) });
    }
  });

  registry.register({
    name: 'explain_text_entry',
    description: 'Build evidence-first AI explanation contexts for a parsed textId.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {
      textId: 'number',
      category: 'string?',
      maxReferences: 'number?',
      maxMarkdownChars: 'number?'
    },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'explain_text_entry requires numeric textId.');
      const category = asOptionalString(value.category);
      const maxReferences = asNumber(value.maxReferences, 80);
      const maxMarkdownChars = asNumber(value.maxMarkdownChars, 24_000);
      const matches = ws.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      const contexts = matches.map((entry) => {
        const references = ws.findReferences(entry.uri, 'to');
        const aiContext = buildTextAiContext(entry, references, { maxReferences, maxMarkdownChars });
        return { context: aiContext, prompt: renderTextAiPrompt(aiContext) };
      });
      return ok({ textId, category, contexts });
    }
  });

  registry.register({
    name: 'find_references',
    description: 'Find evidence graph references connected to a URI.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { uri: 'string', direction: 'enum:from|to|both?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'find_references requires uri.');
      const direction = asReferenceDirection(value.direction);
      return ok(ws.findReferences(uri, direction));
    }
  });

  registry.register({
    name: 'explain_event',
    description: 'Build an evidence-first explanation input for one event URI.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { uri: 'string' },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'explain_event requires uri.');
      const explanation = ws.buildEventExplanationInput(uri);
      if (explanation) return ok(explanation);

      // The persistent index can legitimately lag a live Bridge read (fresh
      // workspace, cache invalidation, or an event opened before background
      // indexing finished).  Fall back to the native outline, but label the
      // result partial: an outline contains counts/IDs, not decoded EMEDF args.
      if (!context.session) return fail('EVENT_NOT_FOUND', `No event exists for URI: ${uri}`);
      const eventMatch = /#event\/(-?\d+)/.exec(uri);
      if (!eventMatch) return fail('EVENT_NOT_FOUND', `No event exists for URI: ${uri}`);
      const sourceUri = uri.slice(0, uri.indexOf('#'));
      const indexedFile = ws.getFile(sourceUri);
      if (!indexedFile) return fail('EVENT_SOURCE_NOT_INDEXED', `事件来源尚未索引：${sourceUri}`);
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const outline = await readEmevdOutline({ edit: edit.session, file: indexedFile.absolutePath });
      if (!outline.ok || !outline.events) {
        return fail(outline.error?.code ?? 'EMEVD_READ_FAILED', outline.error?.message ?? '无法从 Bridge 读取事件。');
      }
      const eventId = Number(eventMatch[1]);
      const row = outline.events.find((event) => event.eventId === eventId);
      if (!row) return fail('EVENT_NOT_FOUND', `Bridge 中没有事件 ${eventId}。`);
      const partialEvent = {
        uri,
        sourceUri,
        eventId,
        instructions: [],
        raw: {
          authority: 'native-verified-outline',
          instructionCount: row.instructionCount,
          restBehavior: row.restBehavior,
          semanticArgsDecoded: false
        }
      };
      return ok({
        event: partialEvent,
        report: {
          eventUri: uri,
          eventId,
          confirmed: [],
          possible: [],
          unknownArguments: [],
          diagnostics: [
            '仅取得 C# Bridge 原生事件 outline；EMEDF 指令参数尚未解码，不能推断实体、参数或文本引用。'
          ]
        },
        markdown: `# Event ${eventId}\n\n- authority: native-verified-outline\n- instructionCount: ${row.instructionCount}\n- restBehavior: ${row.restBehavior}\n- diagnostics: EMEDF 参数尚未解码，引用结论不可用。`,
        references: [],
        authority: 'partial-outline',
        diagnostics: outline.diagnostics
      });
    }
  });

  registry.register({
    name: 'propose_text_patch',
    description: 'Create a text-only patch proposal. It does not save files.',
    permission: 'propose',
    permissionLevel: 'propose',
    inputSchema: {
      targetUri: 'string',
      targetPath: 'string',
      newText: 'string',
      title: 'string?',
      mode: 'enum:plan|normal|fullPermission?'
    },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const workspaceId = ws.workspaceId;
      const targetUri = asString(value.targetUri);
      const targetPath = asString(value.targetPath);
      const newText = asString(value.newText);
      const title = asString(value.title, 'AI text patch proposal');
      const mode = asPatchMode(value.mode, context.mode);

      if (!targetUri || !targetPath || newText === undefined) {
        return fail('INVALID_INPUT', 'propose_text_patch requires targetUri, targetPath, and newText.');
      }
      const nativeHint = nativeFormatHint(targetUri, targetPath);
      if (nativeHint) {
        return fail('USE_NATIVE_EDIT_FACADE', nativeHint);
      }

      const proposal = createPatchProposal({
        workspaceId,
        title,
        author: 'ai',
        mode,
        changes: [
          {
            targetUri,
            targetPath,
            kind: 'text',
            structuredEdit: { newText }
          }
        ]
      });

      return ok(proposal);
    }
  });

  registry.register({
    name: 'propose_plaintext_script_edit',
    description: 'Propose a source-level edit to a plain-text script entry (goal_list.lua, '
      + '*_battle.lua, *nameid.txt). Verifies the target is really plain text from its bytes, '
      + 'preserves the original encoding and trailing padding, and returns a patch proposal. '
      + 'It does not save files. Bytecode entries are rejected.',
    permission: 'propose',
    permissionLevel: 'propose',
    inputSchema: {
      containerUri: 'string',
      childPath: 'string',
      entryIndex: 'number',
      /** 目标条目当前字节的 base64。调用方须经 read 类工具取得,不是猜的。 */
      currentBytesBase64: 'string',
      expectedContainerHash: 'string',
      find: 'string',
      replace: 'string',
      containerFormat: 'string?'
    },
    run: (input) => {
      const value = asRecord(input);
      const containerUri = asString(value.containerUri);
      const childPath = asString(value.childPath);
      const currentBytesBase64 = asString(value.currentBytesBase64);
      const expectedContainerHash = asString(value.expectedContainerHash);
      const find = asString(value.find);
      const replace = asString(value.replace);
      const entryIndex = asNumber(value.entryIndex, Number.NaN);
      if (!containerUri || !childPath || !currentBytesBase64 || !expectedContainerHash || !find) {
        return fail(
          'INVALID_INPUT',
          'propose_plaintext_script_edit 需要 containerUri、childPath、currentBytesBase64、'
            + 'expectedContainerHash 与 find。'
        );
      }
      if (!Number.isInteger(entryIndex) || entryIndex < 0) {
        return fail('INVALID_INPUT', 'entryIndex 必须是非负整数。');
      }
      let currentBytes: Uint8Array;
      try {
        currentBytes = new Uint8Array(Buffer.from(currentBytesBase64, 'base64'));
      } catch {
        return fail('INVALID_INPUT', 'currentBytesBase64 不是合法 base64。');
      }
      if (currentBytes.length === 0) {
        return fail('INVALID_INPUT', 'currentBytesBase64 解出零字节。');
      }
      // 全部判定与编排复用已端到端验证过的那一层:明文按真实字节判定、
      // 编码保持、尾部对齐填充保留、锚点唯一性强制、写后哈希。
      // 工具层不重写任何一条 —— 重写就会出现两套会漂移的规则。
      const result = buildPlaintextScriptEdit({
        containerUri,
        childPath,
        entryIndex,
        currentBytes,
        expectedContainerHash,
        ...(asOptionalString(value.containerFormat)
          ? { containerFormat: asOptionalString(value.containerFormat)! }
          : {}),
        actions: [{ kind: 'replace-once', find, replace }]
      });
      if (!result.ok) {
        return fail(result.code, result.message, { diagnostics: result.diagnostics });
      }
      return ok({
        operation: result.operation,
        encoding: result.encoding,
        beforeBytes: result.beforeBytes,
        afterBytes: result.afterBytes,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        diagnostics: result.diagnostics,
        note: '已生成 PatchIR 操作,尚未写入任何文件。提交需经 Patch Engine,'
          + '且写后应用 checkPlaintextWriteback 复验重读字节。'
      });
    }
  });

  registry.register({
    name: 'validate_patch',
    description: 'Run Patch Engine validation in staging on a full PatchProposal. It does not save files.',
    permission: 'validate',
    permissionLevel: 'validate',
    // The whole input *is* the PatchProposal, so every required proposal field
    // must be declared. Declaring only `changes` told the model the rest was
    // unnecessary: dryRunPatchProposal then returned ok:true at the tool layer
    // with an inner PATCH_IR_MISSING_WORKSPACE failure, which the agent loop
    // reads as a successful call.
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: async (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'validate_patch requires a PatchProposal object.');
      }
      return ok(await dryRunPatchProposal(proposal));
    }
  });

  registry.register({
    name: 'build_patch_graph',
    description: 'Project a full PatchProposal into the v0.5 graph patch IR for review.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    // Same whole-input-is-the-proposal contract as validate_patch. With only
    // `changes` declared, a proposal missing opId produced ok:true carrying
    // node id "op:undefined" and summary "op=undefined files=1" — polluted
    // output with no error anywhere in the chain.
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'build_patch_graph requires a PatchProposal object.');
      }
      const graph = buildGraphPatchFromProposal(proposal);
      return ok({ graph, summaryText: summarizeGraphPatch(graph) });
    }
  });

  registry.register({
    name: 'assess_edit_risk',
    description: 'Assess Files-mode edit risk and resolve writer contract for an indexed file snapshot.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {
      // `file` can only be declared as a bare object: ToolInputShape is
      // Record<string, string> and cannot express nested required fields.
      // The run body checks them explicitly and names what is missing.
      file: 'object',
      truncated: 'boolean?',
      structuredEditable: 'boolean?',
      parseStatus: 'enum:unparsed|parsed|partial|unsupported|failed?',
      changeKind: 'enum:text|structured|binary?'
    },
    run: (input) => {
      const value = asRecord(input);
      const rawFile = (value.file && typeof value.file === 'object' ? value.file : value) as Record<string, unknown>;
      if (!rawFile || (typeof rawFile.sourceUri !== 'string' && typeof rawFile.sourcePath !== 'string')) {
        return fail('INVALID_INPUT', 'assess_edit_risk 需要在 { file } 中传入包含 sourceUri 的文件对象。');
      }
      const sourceUri = typeof rawFile.sourceUri === 'string' ? rawFile.sourceUri : `workspace://files/${String(rawFile.sourcePath).replace(/\\/g, '/')}`;
      const pathStr = typeof rawFile.sourcePath === 'string' ? rawFile.sourcePath : sourceUri;
      const parts = pathStr.split(/[/\\]/);
      const name = parts[parts.length - 1] || '';
      const dots = name.split('.');
      const derivedExt = dots.length > 1 ? dots[dots.length - 1] || '' : '';
      const derivedCompoundExt = dots.length > 2 ? dots.slice(1).join('.') : derivedExt;

      const file = {
        sourceUri,
        sourcePath: typeof rawFile.sourcePath === 'string' ? rawFile.sourcePath : name,
        extension: typeof rawFile.extension === 'string' ? rawFile.extension : derivedExt,
        compoundExtension: typeof rawFile.compoundExtension === 'string' ? rawFile.compoundExtension : derivedCompoundExt,
        game: typeof rawFile.game === 'string' ? rawFile.game : 'sekiro',
        resourceKind: typeof rawFile.resourceKind === 'string' ? (rawFile.resourceKind as any) : 'unknown',
        ...(rawFile.containerFormat ? { containerFormat: rawFile.containerFormat as any } : {})
      } as unknown as IndexedFile;

      const riskOptions = {
        ...(value.truncated === true ? { truncated: true as const } : {}),
        ...(typeof value.structuredEditable === 'boolean' ? { structuredEditable: value.structuredEditable } : {}),
        ...(typeof value.parseStatus === 'string' ? { parseStatus: value.parseStatus } : {})
      };
      const risk = assessEditRisk(file, riskOptions);
      const contract = resolveWriterContract(file);
      const gate = evaluateWriterGate({
        file,
        changeKind: value.changeKind === 'structured' || value.changeKind === 'binary' ? value.changeKind : 'text',
        riskOptions
      });
      return ok({ risk, contract, gate });
    }
  });

  registry.register({
    name: 'read_param_fields',
    description: 'Read live PARAM field values from the opened gameparam container. '
      + 'Pass table name, row ids and field ids. Do not parse Smithbox XML or unpack BND yourself.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      rowIds: 'array',
      fieldIds: 'array',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      if (!context.session) return ok({ table: asString(asRecord(input).table), rows: [], note: 'no workspace session, guard relaxed, empty' });
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const table = asString(value.table);
      const rowIds = asIdList(value.rowIds);
      const fieldIds = asStringList(value.fieldIds);
      if (!table || rowIds.length === 0 || fieldIds.length === 0) {
        return fail('INVALID_INPUT', 'read_param_fields 需要 table、rowIds、fieldIds。');
      }
      const containerPath = asOptionalString(value.containerPath);
      const result = await readParamFields({
        edit: edit.session,
        queries: [{ table, rowIds, fieldIds }],
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (context.workspaceIndex && result.fields.length > 0) {
        const sourceUri = pathToFileURL(result.containerPath).href;
        const rowsById = new Map<number, typeof result.fields>();
        for (const field of result.fields) {
          const fields = rowsById.get(field.rowId) ?? [];
          fields.push(field);
          rowsById.set(field.rowId, fields);
        }
        const provenanceFor = (fields: typeof result.fields): { sourceHash?: string; sourceRevision?: number } => {
          const hashes = new Set(fields.map((field) => field.sourceHash).filter((hash): hash is string => Boolean(hash)));
          const revisions = new Set(fields.map((field) => field.sourceRevision).filter((revision): revision is number => revision !== undefined));
          return {
            ...(hashes.size === 1 ? { sourceHash: [...hashes][0] } : {}),
            ...(revisions.size === 1 ? { sourceRevision: [...revisions][0] } : {})
          };
        };
        const exportProvenance = provenanceFor(result.fields);
        context.workspaceIndex.mergeParamRows({
          paramName: table,
          ...exportProvenance,
          rows: [...rowsById.entries()].map(([rowId, fields]) => ({
            uri: `${sourceUri}#${table}/${rowId}`,
            sourceUri,
            paramName: table,
            rowId,
            ...provenanceFor(fields),
            fields: fields.map((field) => ({ name: field.fieldId, value: field.value }))
          }))
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_param_fields',
    description: 'Set absolute PARAM field values through Patch Engine (write-param + write-bnd4). '
      + 'edits: [{ table, rowId, fieldId, value }]. Never multiply current values. '
      + 'Do not parse Smithbox XML, scan BND, or write file_replace by hand.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      edits: 'array',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const edits = asParamEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      const containerPath = asOptionalString(value.containerPath);
      const result = await setParamFields({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([result.containerPath]);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'read_fmg_entries',
    description: 'Read live FMG text entries from a confirmed msgbnd table. '
      + 'Pass table name (logical, e.g. Title) and entry ids. Do not treat FMG as UTF-8.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      ids: 'array',
      containerPath: 'string?',
      lang: 'string?'
    },
    run: async (input, context) => {
      if (!context.session) return ok({ table: asString(asRecord(input).table), entries: [], note: 'no workspace session, guard relaxed, empty' });
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const table = asString(value.table);
      const ids = asIdList(value.ids);
      if (!table || ids.length === 0) {
        return fail('INVALID_INPUT', 'read_fmg_entries 需要 table、ids。');
      }
      const containerPath = asOptionalString(value.containerPath);
      const lang = asOptionalString(value.lang);
      const result = await readFmgEntries({
        edit: edit.session,
        table,
        ids,
        ...(containerPath ? { containerPath } : {}),
        ...(lang ? { lang } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (context.workspaceIndex && result.entries.length > 0) {
        const sourceUri = pathToFileURL(result.containerPath).href;
        const hashes = new Set(result.entries.map((entry) => entry.sourceHash).filter((hash): hash is string => Boolean(hash)));
        const revisions = new Set(result.entries.map((entry) => entry.sourceRevision).filter((revision): revision is number => revision !== undefined));
        const sourceHash = hashes.size === 1 ? [...hashes][0] : undefined;
        const sourceRevision = revisions.size === 1 ? [...revisions][0] : undefined;
        context.workspaceIndex.mergeMsgEntries({
          category: result.table,
          ...(sourceHash ? { sourceHash } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          entries: result.entries.map((entry) => ({
            uri: `${sourceUri}#${result.table}/${entry.id}`,
            sourceUri,
            category: result.table,
            textId: entry.id,
            text: entry.text,
            confidence: 'high',
            ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
            ...(entry.sourceRevision !== undefined ? { sourceRevision: entry.sourceRevision } : {})
          }))
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_fmg_entries',
    description: 'Set FMG entry text through Patch Engine (write-fmg mutations[]). '
      + 'edits: [{ table, id, text }]. One table per call. Do not propose_text_patch on .fmg/.msgbnd.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      edits: 'array',
      containerPath: 'string?',
      lang: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const edits = asFmgEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      const containerPath = asOptionalString(value.containerPath);
      const lang = asOptionalString(value.lang);
      const result = await setFmgEntries({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {}),
        ...(lang ? { lang } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([result.containerPath]);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'read_emevd_outline',
    description: 'Read event IDs and instruction counts from an overlay EMEVD file. '
      + 'Does not parse a second native format; uses Bridge read-emevd-document.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string' },
    run: async (input, context) => {
      if (!context.session) return ok({ file: asString(asRecord(input).file), events: [], note: 'no workspace session, guard relaxed, empty' });
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const file = asString(asRecord(input).file);
      if (!file) return fail('INVALID_INPUT', 'read_emevd_outline 需要 file。');
      const result = await readEmevdOutline({ edit: edit.session, file });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_READ_FAILED', result.error?.message ?? '读取失败。');
      if (context.workspaceIndex && result.events) {
        const indexedFile = context.workspaceIndex.getFiles().find((candidate) => candidate.absolutePath === result.filePath);
        const sourceUri = indexedFile?.sourceUri ?? result.filePath ?? file;
        const sourceHash = result.sourceHash;
        const sourceRevision = indexedFile?.mtimeMs;
        const mapId = basename(sourceUri).replace(/\.emevd(?:\.dcx)?$/i, '');
        context.workspaceIndex.upsertEventExport({
          mapId,
          ...(sourceHash ? { sourceHash } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          events: result.events.map((event) => ({
            uri: `${sourceUri}#event/${event.eventId}`,
            sourceUri,
            mapId,
            eventId: event.eventId,
            ...(sourceHash ? { sourceHash } : {}),
            ...(sourceRevision !== undefined ? { sourceRevision } : {}),
            instructions: [],
            raw: {
              authority: 'native-verified-outline',
              instructionCount: event.instructionCount,
              restBehavior: event.restBehavior,
              semanticArgsDecoded: false
            }
          }))
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'apply_emevd_dsl',
    description: 'Compile and commit EMEVD DSL through the native Bridge four-view path. '
      + 'The DSL is not a binary text patch; unknown/ambiguous parameter bindings fail closed.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      dsl: 'string',
      mode: 'enum:patch|dark-script?',
      emedfPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const dsl = asString(value.dsl);
      if (!file || !dsl.trim()) return fail('INVALID_INPUT', 'apply_emevd_dsl 需要 file 与非空 dsl。');
      const mode = value.mode === 'dark-script' ? 'dark-script' : 'patch';
      const emedfPath = asOptionalString(value.emedfPath);
      const result = await applyEmevdDsl({
        edit: edit.session,
        file,
        dsl,
        mode,
        ...(emedfPath ? { emedfPath } : {})
      });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_DSL_FAILED', result.error?.message ?? 'EMEVD DSL 提交失败。', result.diagnostics);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([result.filePath ?? file]);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'read_tae_events',
    description: 'Read native TAE event times and decoded fields by exact action address. '
      + 'Use cXXXX#AXXXX.eN addresses; omitted addresses return the bounded native event projection.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?' },
    run: async (input, context) => {
      if (!context.session) return ok({ file: asString(asRecord(input).file), events: [], note: 'no workspace session, guard relaxed, empty' });
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'read_tae_events 需要 file。');
      const addresses = value.addresses === undefined ? [] : asStringList(value.addresses);
      const result = await readTaeEvents({
        edit: edit.session,
        file,
        ...(addresses.length > 0 ? { addresses } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(result.filePath).href;
        const sourceFile = context.workspaceIndex.getFile(sourceUri);
        const sourceHash = result.sourceHash;
        const sourceRevision = sourceFile?.mtimeMs;
        const animations = new Map<number, TaeAnimSymbol>();
        for (const event of result.events) {
          const animation = animations.get(event.animId) ?? { animId: event.animId, code: event.code, events: [] as TaeEventSymbol[] };
          animation.events.push({
            uri: event.uri,
            index: event.eventIndex,
            eventTypeId: event.eventTypeId,
            ...(event.typeName ? { typeName: event.typeName } : {}),
            startTime: event.startTime,
            endTime: event.endTime,
            startFrame: event.startFrame,
            endFrame: event.endFrame,
            ...(sourceHash ? { sourceHash } : {}),
            ...(sourceRevision !== undefined ? { sourceRevision } : {}),
            ...(event.fields ? { fields: event.fields } : {}),
            ...(event.parameterBytesHex ? { parameterBytesHex: event.parameterBytesHex } : {})
          });
          animations.set(event.animId, animation);
        }
        context.workspaceIndex.upsertTaeExport({
          chrId: result.chrId,
          sourceUri,
          ...(sourceHash ? { sourceHash } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          animations: [...animations.values()]
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_tae_event_times',
    description: 'Set TAE event start/end frames by exact action address through Patch Engine. '
      + 'Ambiguous or missing native events fail closed; no filename or array-index guessing.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const edits = asTaeTimeEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_tae_event_times 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      const result = await setTaeEventTimes({ edit: edit.session, file, edits: edits.edits });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([result.filePath]);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'mutate_msb_part_transform',
    description: 'Set MSB part position/rotation/scale through Patch Engine (write-msb '
      + 'msb_set_part_position / msb_set_part_transform). edits: [{ address: m11_01_00_00#c1050_0000, posX?, posY?, posZ?, rotX?, rotY?, rotZ?, scaleX?, scaleY?, scaleZ? }].',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const edits = asMsbTransformEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      if (edits.edits.length === 0) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要非空 edits 数组。');
      const loaded = await loadMapDocument(edit.session, file);
      if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
      const canonicalEdits: Array<{ item: MsbPartTransformEdit; target: string; part: MapPartEntity }> = [];
      for (const item of edits.edits) {
        if (item.nativeOffset === undefined) {
          return fail('MSB_NATIVE_OFFSET_REQUIRED', `${item.address} 写入必须携带 nativeOffset；地址/名称仅作诊断，不能作为唯一目标。`);
        }
        const parsed = parseMapAddress(item.address);
        if (!parsed?.name) return fail('MSB_ADDRESS_INVALID', `无法解析 MSB part 地址：${item.address}`);
        const resolved = loaded.sceneGraph.resolveNativeIdentity({
          family: 'part',
          nativeOffset: item.nativeOffset,
          expectedName: parsed.name
        });
        if (!resolved.ok) return fail(resolved.code, `MSB native identity 未唯一解析：${item.address}@${item.nativeOffset}`);
        if (resolved.entity.kind !== 'part') return fail('MSB_ENTITY_KIND_INVALID', `MSB native identity 不是 Part：${item.address}@${item.nativeOffset}`);
        if (!MSB_TRANSFORM_FIELDS.some((field) => item[field] !== undefined)) {
          return fail('MSB_EDIT_EMPTY', `${item.address} 没有任何要写入的变换字段。`);
        }
        canonicalEdits.push({ item, target: resolved.entity.stableKey, part: resolved.entity });
      }
      const transaction: MapEditTransaction = {
        id: `tx-agent-msb-${Date.now()}`,
        mapId: loaded.doc.mapId,
        baseRevision: loaded.doc.revision,
        description: `Agent MSB Part 变换 (${canonicalEdits.length} 项)`,
        author: 'agent',
        operations: canonicalEdits.map(({ item, target, part }) => ({
          kind: 'set_transform' as const,
          target,
          ...(item.posX !== undefined || item.posY !== undefined || item.posZ !== undefined
            ? { position: [
                item.posX ?? part.transform.position[0],
                item.posY ?? part.transform.position[1],
                item.posZ ?? part.transform.position[2]
              ] as [number, number, number] }
            : {}),
          ...(item.rotX !== undefined || item.rotY !== undefined || item.rotZ !== undefined
            ? { rotation: [
                item.rotX ?? part.transform.rotation[0],
                item.rotY ?? part.transform.rotation[1],
                item.rotZ ?? part.transform.rotation[2]
              ] as [number, number, number] }
            : {}),
          ...(item.scaleX !== undefined || item.scaleY !== undefined || item.scaleZ !== undefined
            ? { scale: [
                item.scaleX ?? part.transform.scale[0],
                item.scaleY ?? part.transform.scale[1],
                item.scaleZ ?? part.transform.scale[2]
              ] as [number, number, number] }
            : {})
        })),
        timestamp: Date.now()
      };
      const result = await executeMapTransaction(edit.session, file, transaction);
      if (!result.ok) return fail(result.error?.code ?? 'MSB_TRANSACTION_FAILED', result.error?.message ?? 'MSB 地图事务失败。', result.error?.details);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([file]);
      return ok({ ...result, status: result.verification ?? 'completed', ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'query_map_objects',
    description: 'Query semantic map objects (Parts, Regions, Models, Events) by modelName, entityId, kind, or name. Results are bounded; use returned IDs/cursors for follow-up pages.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      file: 'string',
      modelName: 'string?',
      entityId: 'number?',
      kind: 'string?',
      nameContains: 'string?',
      regionName: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'query_map_objects 需要 file。');
      const result = await queryMapEntities(edit.session, file, {
        ...(value.modelName ? { modelName: asString(value.modelName) } : {}),
        ...(typeof value.entityId === 'number' ? { entityId: Number(value.entityId) } : {}),
        ...(value.kind ? { kind: asString(value.kind) as any } : {}),
        ...(value.nameContains ? { nameContains: asString(value.nameContains) } : {}),
        ...(value.regionName ? { regionName: asString(value.regionName) } : {})
      });
      if (!result.ok) return fail(result.error?.code ?? 'QUERY_FAILED', result.error?.message ?? '查询地图实体失败');
      return ok(result);
    }
  });

  registry.register({
    name: 'inspect_map_object',
    description: 'Inspect a specific map object (Part, Region, Event) by name, ID, or stableKey, showing transform, model, and reverse references.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', identifier: 'string' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const identifier = asString(value.identifier);
      if (!file || !identifier) return fail('INVALID_INPUT', 'inspect_map_object 需要 file 和 identifier。');
      const result = await inspectMapEntity(edit.session, file, identifier);
      if (!result.ok) return fail(result.error?.code ?? 'INSPECT_FAILED', result.error?.message ?? '查看地图对象失败');
      return ok(result);
    }
  });

  registry.register({
    name: 'batch_transform_map_objects',
    description: 'Batch transform multiple map parts (translate, rotate, scale) in a single atomic transaction through Patch Engine.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      targets: 'array',
      deltaX: 'number?',
      deltaY: 'number?',
      deltaZ: 'number?',
      rotDeltaX: 'number?',
      rotDeltaY: 'number?',
      rotDeltaZ: 'number?',
      scaleMultiplier: 'number?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const targets = asStringList(value.targets);
      if (!file || targets.length === 0) return fail('INVALID_INPUT', 'batch_transform_map_objects 需要 file 和非空 targets 数组。');
      const result = await batchTransformMapParts(edit.session, file, {
        targets,
        ...(typeof value.deltaX === 'number' ? { deltaX: Number(value.deltaX) } : {}),
        ...(typeof value.deltaY === 'number' ? { deltaY: Number(value.deltaY) } : {}),
        ...(typeof value.deltaZ === 'number' ? { deltaZ: Number(value.deltaZ) } : {}),
        ...(typeof value.rotDeltaX === 'number' ? { rotDeltaX: Number(value.rotDeltaX) } : {}),
        ...(typeof value.rotDeltaY === 'number' ? { rotDeltaY: Number(value.rotDeltaY) } : {}),
        ...(typeof value.rotDeltaZ === 'number' ? { rotDeltaZ: Number(value.rotDeltaZ) } : {}),
        ...(typeof value.scaleMultiplier === 'number' ? { scaleMultiplier: Number(value.scaleMultiplier) } : {})
      });
      if (!result.ok) return fail(result.error?.code ?? 'BATCH_TRANSFORM_FAILED', result.error?.message ?? '批量变换失败');
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([file]);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'export_map_for_blender',
    description: 'Export canonical MapDocument to Blender-compatible JSON scene descriptor with stable identifiers and revisions.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'export_map_for_blender 需要 file。');
      const loaded = await loadMapDocument(edit.session, file);
      if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
      const blenderScene = exportMapSceneForBlender(loaded.doc);
      return ok(blenderScene);
    }
  });

  registry.register({
    name: 'import_map_from_blender',
    description: 'Import Blender delta modifications, validate against current map revision, and commit as a MapEditTransaction.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', delta: 'object' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const delta = value.delta as BlenderDeltaImport;
      if (!file || !delta || typeof delta !== 'object') return fail('INVALID_INPUT', 'import_map_from_blender 需要 file 和 delta 对象。');
      const loaded = await loadMapDocument(edit.session, file);
      if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
      const translation = importBlenderDeltaToTransaction(loaded.doc, delta);
      if (!translation.ok) return fail(translation.conflict ? 'REVISION_CONFLICT' : 'IMPORT_FAILED', translation.error);
      const result = await executeMapTransaction(edit.session, file, translation.transaction);
      if (!result.ok) return fail(result.error?.code ?? 'IMPORT_COMMIT_FAILED', result.error?.message ?? 'Blender 地图事务提交失败。', result.error?.details);
      const knowledgeRefresh = await context.onNativeWriteCommitted?.([file]);
      return ok({
        transaction: translation.transaction,
        status: result.verification ?? 'completed',
        result,
        ...(knowledgeRefresh ? { knowledgeRefresh } : {})
      });
    }
  });

  registry.register({
    name: 'commit_patch',
    description: 'Commit a PatchProposal through Patch Engine (staging, backup, hash check, rollback metadata). '
      + 'Pass the object returned by propose_text_patch. Does not write until the user approves in the Agent panel.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      opId: 'string',
      workspaceId: 'string',
      changes: 'array',
      title: 'string?',
      author: 'string?',
      mode: 'string?',
      createdAt: 'string?'
    },
    run: async (input, context) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'commit_patch requires a PatchProposal object.');
      }
      if (!context.session || !context.operationLogStore || !context.backupBaseDir) {
        return fail(
          'COMMIT_CONTEXT_REQUIRED',
          '提交需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir）。'
        );
      }
      if (!context.confirmation?.id || context.confirmation.subjects.length === 0) {
        return fail(
          'EDIT_CONFIRMATION_REQUIRED',
          '提交需要用户在 Agent 审批卡确认后签发的写入回执。'
        );
      }
      const overlayRoot = context.session.layers.overlayRoot;
      const resolvedChanges = [];
      for (const change of proposal.changes) {
        if (typeof change.targetPath !== 'string' || change.targetPath.trim() === '') {
          return fail('INVALID_INPUT', 'commit_patch 的每条 change 都需要 targetPath。');
        }
        const absolute = isAbsolute(change.targetPath)
          ? change.targetPath
          : join(overlayRoot, change.targetPath);
        const writable = context.session.resolveWritablePath(absolute, change.layer ?? 'overlay');
        if (!writable.ok || !writable.absolutePath) {
          const diagnostic = writable.diagnostics[0];
          return fail(
            diagnostic?.code ?? 'WRITE_OUTSIDE_OVERLAY',
            diagnostic?.message ?? '目标不在当前打开的工作区里，无法写入。',
            { targetPath: change.targetPath }
          );
        }
        resolvedChanges.push({ ...change, targetPath: writable.absolutePath });
      }
      const result = await commitPatchProposal(
        { ...proposal, changes: resolvedChanges, author: proposal.author === 'user' ? 'user' : 'ai' },
        {
          session: context.session,
          operationLog: context.operationLogStore,
          workspaceRoot: overlayRoot,
          backupRoot: context.backupBaseDir,
          ...(context.recoveryDir ? { recoveryDir: context.recoveryDir } : {})
        }
      );
      const failed = result.diagnostics.some((item) => item.severity === 'error')
        || result.changedFiles.length === 0;
      if (failed) {
        const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
        return fail(
          diagnostic?.code ?? 'COMMIT_FAILED',
          diagnostic?.message ?? 'Patch Engine 提交失败，工作区未被修改。',
          { opId: result.opId, diagnostics: result.diagnostics }
        );
      }
      const knowledgeRefresh = await context.onNativeWriteCommitted?.(result.changedFiles);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'list_operations',
    description: 'List Patch Engine operation log / patch history entries for the active workspace.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: async (_input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      // 优先用主进程注入的生产 SQLite store；没有注入时退回内存 store（测试/离线
      // 形态），不再把「内存空日志」冒充生产日志 —— 主进程 ai.runAgent 已注入。
      const store = context.operationLogStore ?? getDefaultOperationLogStore();
      return ok({
        operations: await store.list(ws.workspaceId),
        history: await store.history(ws.workspaceId)
      });
    }
  });

  registry.register({
    name: 'rollback_operation',
    description: 'Rollback a committed operation from its backup. Requires full-permission mode.',
    permission: 'rollback',
    permissionLevel: 'rollback',
    inputSchema: { opId: 'string' },
    run: async (input, context) => {
      const value = asRecord(input);
      const opId = asString(value.opId);
      if (!opId) return fail('INVALID_INPUT', 'rollback_operation requires opId.');
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      // 回滚必须走生产上下文：session（可写路径权威校验）、持久 store（幂等与
      // 审计）、备份/恢复目录（逆向事务的还原点）。缺任一即干净失败，绝不回退
      // 到内存 store —— 那会把「没有备份」伪装成「已回滚」。
      if (!context.session || !context.operationLogStore || !context.backupBaseDir || !context.recoveryDir) {
        return fail(
          'ROLLBACK_CONTEXT_REQUIRED',
          '回滚需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir / recoveryDir）。'
        );
      }
      const result = await rollbackOperation({
        opId,
        store: context.operationLogStore,
        session: context.session,
        backupBaseDir: context.backupBaseDir,
        recoveryDir: context.recoveryDir,
        author: 'ai',
        ...(context.confirmation ? { confirmation: context.confirmation } : {})
      });
      // rollbackOperation 返回自带 ok 字段的结果对象，不能再用 ok() 整体包装
      // —— 那会把失败状态（EDIT_CONFIRMATION_REQUIRED 等）吞成 ToolResult.ok=true。
      if (!result.ok) {
        const diagnostic = result.diagnostics[0];
        return fail(
          diagnostic?.code ?? 'ROLLBACK_FAILED',
          diagnostic?.message ?? '回滚失败。',
          { opId: result.opId }
        );
      }
      const knowledgeRefresh = await context.onNativeWriteCommitted?.(result.restoredFiles);
      return ok({ ...result, ...(knowledgeRefresh ? { knowledgeRefresh } : {}) });
    }
  });

  registry.register({
    name: 'read_memory',
    description: 'Read or search long-term memory entries by topic/query, or retrieve all project memories if query is omitted.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'number?' },
    run: (input, context) => {
      const store = context.memoryStore;
      if (!store) return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝伪装为已读取。');
      const value = asRecord(input);
      const query = asOptionalString(value.query);
      const limit = asNumber(value.limit, 10);
      if (query) {
        const results = store.search(query, limit);
        return ok({ query, count: results.length, entries: results });
      }
      const all = store.list().slice(0, limit);
      return ok({ count: all.length, entries: all });
    }
  });

  registry.register({
    name: 'write_memory',
    description: 'Store or update a persistent long-term memory entry (topic, summary, details, tags) across sessions.',
    permission: 'propose',
    permissionLevel: 'propose',
    inputSchema: { topic: 'string', summary: 'string', details: 'string?', tags: 'array?' },
    run: (input, context) => {
      const store = context.memoryStore;
      if (!store) return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝伪装为已保存。');
      const value = asRecord(input);
      const topic = asString(value.topic).trim();
      const summary = asString(value.summary).trim();
      if (!topic || !summary) {
        return fail('INVALID_INPUT', 'write_memory requires non-empty topic and summary.');
      }
      const details = asOptionalString(value.details);
      const tags = Array.isArray(value.tags) ? value.tags.map(String).filter(Boolean) : [];
      const saved = store.save({ topic, summary, ...(details ? { details } : {}), tags });
      return ok({ saved: true, entry: saved });
    }
  });

  registry.register({
    name: 'list_memories',
    description: 'List all topics and summaries stored in the long-term memory system.',
    permission: 'read',
    permissionLevel: 'read',
    run: (_input, context) => {
      const store = context.memoryStore;
      if (!store) return fail('MEMORY_STORE_REQUIRED', '宿主未提供持久记忆存储，拒绝返回临时空列表。');
      const list = store.list();
      return ok({ count: list.length, topics: list.map((e) => ({ id: e.id, topic: e.topic, summary: e.summary, updatedAt: e.updatedAt })) });
    }
  });

  registry.register({
    name: 'switch_mode',
    description: 'Switch the agent operation mode dynamically (e.g. from "plan" to "normal" or "fullPermission" to perform edits/mutations, or back to "plan").',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { mode: 'string', reason: 'string?' },
    run: (input, context) => {
      const value = asRecord(input);
      const targetMode = asString(value.mode).trim();
      if (targetMode === 'plan' || targetMode === 'normal' || targetMode === 'fullPermission') {
        context.mode = targetMode;
        return ok({
          switched: true,
          currentMode: targetMode,
          note: `操作模式已成功切换为「${targetMode}」。现在可以执行该模式允许的操作。`
        });
      }
      return fail('INVALID_MODE', `不支持的目标模式: "${targetMode}"，可选值为: "plan" | "normal" | "fullPermission"。`);
    }
  });

  return registry;
}

export function summarizeReferences(edges: ReferenceEdge[]): { high: number; medium: number; low: number; total: number } {
  return {
    high: edges.filter((edge) => edge.confidence === 'high').length,
    medium: edges.filter((edge) => edge.confidence === 'medium').length,
    low: edges.filter((edge) => edge.confidence === 'low').length,
    total: edges.length
  };
}

function normalizePermissionLevel(permission: ToolPermission): AiToolPermissionLevel {
  if (
    permission === 'read'
    || permission === 'analyze'
    || permission === 'propose'
    || permission === 'stage'
    || permission === 'validate'
    || permission === 'commit'
    || permission === 'rollback'
  ) {
    return permission;
  }
  if (permission === 'plan' || permission === 'write') {
    return legacyPermissionToLevel(permission);
  }
  return 'read';
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, state: 'completed', data };
}

function fail(code: string, message: string, details?: unknown): ToolResult<never> {
  return {
    ok: false,
    state: 'failed',
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback?: string): string {
  return typeof value === 'string' ? value : fallback ?? '';
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireEditSession(
  context: ToolContext,
  purpose: 'read' | 'write'
): { ok: true; session: ReturnType<typeof nativeEditSessionFromContext> } | ToolResult<never> {
  if (!context.session) {
    return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
  }
  const backupBaseDir = context.backupBaseDir ?? join(context.session.layers.overlayRoot, '.soulforge-staging', 'backups');
  const recoveryDir = context.recoveryDir ?? join(context.session.layers.overlayRoot, '.soulforge-staging', 'recovery');
  return {
    ok: true,
    session: nativeEditSessionFromContext({
      session: context.session,
      operationLog: context.operationLogStore ?? getDefaultOperationLogStore(),
      backupBaseDir,
      recoveryDir,
      ...(context.confirmation ? { confirmation: context.confirmation } : {})
    })
  };
}

function nativeFormatHint(targetUri: string, targetPath: string): string | null {
  const haystack = `${targetUri} ${targetPath}`.toLowerCase();
  if (/\.(parambnd|param)(\.dcx)?(\b|$)/.test(haystack) || haystack.includes('gameparam')) {
    return '这是 PARAM 容器，请用 read_param_fields / mutate_param_fields，不要走文本补丁。';
  }
  if (/\.(fmg|msgbnd)(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 FMG 文本表，请用 FMG 门面（mutate_fmg_entries），不要把词条当 UTF-8 文件覆盖。';
  }
  if (/\.emevd(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 EMEVD 事件，请用 apply_emevd_dsl，不要把二进制当文本补丁。';
  }
  if (/\.(anibnd|tae)(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 TAE 动作文档，请用 read_tae_events / mutate_tae_event_times，不要把 anibnd/tae 当文本补丁。';
  }
  if (/\.msb(\.dcx)?(\b|$)/.test(haystack)) {
    return '这是 MSB 地图文档，请用 read_msb_parts / mutate_msb_part_transform，不要把 msb 当文本补丁。';
  }
  if (/\.(dcx|bnd)\b/.test(haystack)) {
    return '这是打包原生格式，禁止 propose_text_patch。请用对应的 PARAM / FMG / EMEVD / 明文脚本门面。';
  }
  return null;
}

function asIdList(value: unknown): number[] {
  if (typeof value === 'number') return Number.isInteger(value) ? [value] : [];
  if (typeof value === 'string' && value.trim()) {
    const num = Number(value.trim());
    if (Number.isInteger(num)) return [num];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isInteger(item));
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function asParamEdits(value: unknown): { ok: true; edits: ParamFieldEdit[] } | { ok: false; code: string; message: string } {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' && 'table' in value ? [value] : null);
  if (!items || items.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_param_fields 需要非空 edits 数组或单条 edit 对象。' };
  }
  const edits: ParamFieldEdit[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const table = asString(record.table);
    const fieldId = asString(record.fieldId);
    const rowId = asNumber(record.rowId, Number.NaN);
    if (!table || !fieldId || !Number.isInteger(rowId)) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 table、rowId、fieldId、value。' };
    }
    const raw = record.value;
    if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'boolean') {
      return { ok: false, code: 'INVALID_INPUT', message: `${table}#${rowId}.${fieldId} 的 value 必须是数字、字符串或布尔。` };
    }
    edits.push({ table, rowId, fieldId, value: raw });
  }
  return { ok: true, edits };
}

function asFmgEdits(value: unknown): { ok: true; edits: FmgEntryEdit[] } | { ok: false; code: string; message: string } {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' && 'table' in value ? [value] : null);
  if (!items || items.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_fmg_entries 需要非空 edits 数组或单条 edit 对象。' };
  }
  const edits: FmgEntryEdit[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const table = asString(record.table);
    const text = typeof record.text === 'string' ? record.text : '';
    const id = asNumber(record.id, Number.NaN);
    if (!table || !Number.isInteger(id)) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 table、id、text。' };
    }
    if (typeof record.text !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: `${table}#${id} 的 text 必须是字符串。` };
    }
    edits.push({ table, id, text });
  }
  return { ok: true, edits };
}

function asTaeTimeEdits(value: unknown): { ok: true; edits: Array<{ address: string; startFrame?: number; endFrame?: number }> } | { ok: false; code: string; message: string } {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' && 'address' in value ? [value] : null);
  if (!items || items.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_tae_event_times 的 edits 必须是数组或单条 edit 对象。' };
  }
  const edits: Array<{ address: string; startFrame?: number; endFrame?: number }> = [];
  for (const item of items) {
    const record = asRecord(item);
    const address = asString(record.address);
    if (!address) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 address（格式 c1050#A0200.e0）。' };
    }
    const edit: { address: string; startFrame?: number; endFrame?: number } = { address };
    if (record.startFrame !== undefined) {
      const frame = asNumber(record.startFrame, Number.NaN);
      if (!Number.isFinite(frame)) return { ok: false, code: 'INVALID_INPUT', message: `${address}.startFrame 必须是有限数字。` };
      edit.startFrame = frame;
    }
    if (record.endFrame !== undefined) {
      const frame = asNumber(record.endFrame, Number.NaN);
      if (!Number.isFinite(frame)) return { ok: false, code: 'INVALID_INPUT', message: `${address}.endFrame 必须是有限数字。` };
      edit.endFrame = frame;
    }
    edits.push(edit);
  }
  return { ok: true, edits };
}

const MSB_TRANSFORM_FIELDS = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ', 'scaleX', 'scaleY', 'scaleZ'] as const;

function asMsbTransformEdits(value: unknown): { ok: true; edits: MsbPartTransformEdit[] } | { ok: false; code: string; message: string } {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' && 'address' in value ? [value] : null);
  if (!items || items.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_msb_part_transform 的 edits 必须是数组或单条 edit 对象。' };
  }
  const edits: MsbPartTransformEdit[] = [];
  for (const item of items) {
    const record = asRecord(item);
    const address = asString(record.address);
    if (!address) {
      return { ok: false, code: 'INVALID_INPUT', message: '每条 edit 需要 address（格式 m11_01_00_00#c1050_0000）。' };
    }
    const edit: MsbPartTransformEdit = { address };
    if (record.nativeOffset !== undefined) {
      const nativeOffset = asNumber(record.nativeOffset, Number.NaN);
      if (!Number.isSafeInteger(nativeOffset) || nativeOffset < 0) {
        return { ok: false, code: 'INVALID_INPUT', message: `${address}.nativeOffset 必须是非负安全整数。` };
      }
      edit.nativeOffset = nativeOffset;
    }
    for (const field of MSB_TRANSFORM_FIELDS) {
      if (record[field] === undefined) continue;
      const raw = record[field];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, code: 'INVALID_INPUT', message: `${address}.${field} 必须是有限数字。` };
      }
      Object.assign(edit, { [field]: raw });
    }
    edits.push(edit);
  }
  return { ok: true, edits };
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asResourceKinds(value: unknown): ResourceKind[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<ResourceKind>(ALL_RESOURCE_KINDS);
  const kinds = value.filter((item): item is ResourceKind => typeof item === 'string' && allowed.has(item as ResourceKind));
  return kinds.length > 0 ? kinds : undefined;
}

function asRagFamilies(value: unknown): RagChunkFamily[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = new Set<RagChunkFamily>(RAG_CHUNK_FAMILIES);
  const families = value.filter((item): item is RagChunkFamily => typeof item === 'string' && allowed.has(item as RagChunkFamily));
  return families.length > 0 ? families : undefined;
}

function resolveRagCorpus(context: ToolContext): RagCorpus | null {
  if (context.workspaceIndex) {
    const live = buildRagCorpus(context.workspaceIndex);
    if (context.rag && context.rag.chunks.length > 0) {
      return mergeCatalogAndPersisted(live, context.rag);
    }
    return live;
  }
  if (context.rag && context.rag.chunks.length > 0) return context.rag;
  return null;
}

function asReferenceDirection(value: unknown): 'from' | 'to' | 'both' {
  return value === 'from' || value === 'to' || value === 'both' ? value : 'both';
}

function asPatchMode(value: unknown, fallback: ToolContext['mode']): PatchMode {
  if (value === 'plan' || value === 'normal' || value === 'fullPermission') return value;
  return fallback;
}

/**
 * Handler-side normalizers for every `enum:`-declared field, keyed
 * `toolName.fieldName`. Exported so the schema gate can prove each declared
 * value is actually accepted rather than silently defaulted.
 *
 * A declaration is free to list a value the handler does not accept — that
 * costs nothing at compile time and nothing at runtime, but it makes the model
 * pass a value it believes is legal and receive a different one. Reading the
 * real normalizers (instead of restating the accepted sets in the gate) keeps
 * that check from becoming a second copy that drifts.
 */
export const ENUM_FIELD_NORMALIZERS: Record<string, (value: string) => string> = {
  'find_references.direction': (value) => asReferenceDirection(value),
  // asPatchMode falls back to the session mode. Probing with a sentinel
  // fallback keeps every declared value testable — using a real mode as the
  // fallback would make that one value indistinguishable between "accepted"
  // and "rejected then defaulted".
  'propose_text_patch.mode': (value) => asPatchMode(value, '__unaccepted__' as PatchMode),
  'apply_emevd_dsl.mode': (value) => (value === 'patch' || value === 'dark-script' ? value : '__unaccepted__'),
  // The handler passes any string through (`typeof === 'string'`), so all
  // declared values are accepted. The declaration is deliberately narrower
  // than the handler here: narrowing only under-promises to the model, which
  // is the safe direction. assessEditRisk itself only branches on
  // 'unsupported' / 'failed' (writerContract.ts:273).
  'assess_edit_risk.parseStatus': (value) => value,
  'assess_edit_risk.changeKind': (value) => (value === 'structured' || value === 'binary' ? value : 'text')
};
