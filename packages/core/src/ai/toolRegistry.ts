import type {
  AiToolPermissionLevel,
  ConfirmationReceipt,
  IndexedFile,
  MapExport,
  PatchMode,
  PatchProposal,
  ReferenceEdge,
  ResourceKind,
  TaeExport,
  MapEditOperation,
  MapDocument
} from '@soulforge/shared';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitPatchProposal, createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore, type OperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../patch/graphPatch.js';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../patch/writerContract.js';
import type { RagChunkFamily, RagCorpus, RagRetrieveOptions, RagRetrieveResult } from '@soulforge/shared';
import { RAG_CHUNK_FAMILIES } from '@soulforge/shared';
import type { SearchResult, WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { ALL_RESOURCE_KINDS, classifyResourceKind } from '../workspace/resourceKinds.js';
import { buildTextAiContext, renderTextAiPrompt } from './aiContextBuilder.js';
import { buildPlaintextScriptEdit } from '../script/plaintextScriptEdit.js';
import { nativeEditSessionFromContext, type NativeEditSession } from '../editing/nativeEditSession.js';
import { readParamFields, setParamFields, type ParamFieldEdit } from '../param/containerParamEdit.js';
import { readFmgEntries, setFmgEntries, type FmgEntryEdit } from '../editing/fmgEdit.js';
import { applyEmevdDsl, readEmevdOutline } from '../editing/emevdEdit.js';
import { readTaeEvents, setTaeEventTimes } from '../editing/taeEdit.js';
import { readMsbParts, type MsbPartTransformEdit } from '../editing/msbEdit.js';
import {
  executeMapTransaction,
  inspectMapEntity,
  queryMapEntities,
  loadMapDocument
} from '../editing/mapService.js';
import {
  exportMapSceneForBlender,
  importBlenderDeltaToTransaction,
  type BlenderDeltaImport
} from '@soulforge/shared';
import { isAiToolPermissionAllowed, legacyPermissionToLevel } from './toolPermissions.js';
import { buildRagCorpus, mergeCatalogAndPersisted } from '../rag/chunkBuilder.js';
import { retrieveEvidence } from '../rag/retrieve.js';
import { type MemoryStore } from '../memory/memoryStore.js';
import { coverageForScope, coverageForSearch } from '../semantic/coverage.js';
import { READ_FACTS_POSTCONDITION_KEY } from '../semantic/completion.js';
import { SemanticResolver } from '../semantic/resolver.js';
import { createTaskModel } from '../semantic/taskModel.js';
import type { CanonicalEntityKind, CompletionEvidence } from '../semantic/types.js';
import {
  executeSemanticPatchProposalTransaction,
  type SemanticPatchProposalInput
} from '../semantic/patchProposalTransaction.js';
import type { SemanticChangeSet, SemanticChangeOperation } from '../semantic/types.js';
/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

/**
 * Structured result of the post-commit knowledge refresh boundary.
 *
 * `ragRefreshed` only means that the current chunks/references were persisted.
 * `knowledgeFresh` is deliberately stricter: it is true only after a complete
 * embedding set for the same source revision was durably stored.  Keeping the
 * two facts separate prevents a lexical-only refresh from being advertised as
 * vector/RAG freshness.
 */
export type KnowledgeRefreshEmbeddingStatus = 'fresh' | 'invalidated' | 'blocked';

export type KnowledgeRefreshReason = 'read-enrichment' | 'committed-mutation';

export interface KnowledgeRefreshNotice {
  reason: KnowledgeRefreshReason;
}

export interface KnowledgeRefreshResult {
  indexRefreshed: boolean;
  referencesRefreshed: boolean;
  ragRefreshed: boolean;
  knowledgeFresh: boolean;
  embeddingStatus: KnowledgeRefreshEmbeddingStatus;
  sourceRevision?: string;
  embeddingModel?: string;
  diagnostics?: Array<{ code: string; message: string }>;
}

export interface ToolContext {
  workspaceIndex: WorkspaceIndex | null;
  mode: 'plan' | 'normal' | 'fullPermission';
  /** Task metadata supplied by the host; never inferred from a tool name. */
  taskKind?: 'inspect' | 'diagnose' | 'modify' | 'create';
  /** A create request must not fall through to an existing-row mutation. */
  explicitCreate?: boolean;
  /** Optional durable/in-memory RAG corpus. Absent falls back to building from the index. */
  rag?: RagCorpus;
  /** Optional host-owned hybrid RAG path; production hosts may attach provider-backed vectors. */
  retrieveEvidence?: (query: string, options?: RagRetrieveOptions) => Promise<RagRetrieveResult>;
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
  /**
   * Persist/rebuild knowledge after a live native read or write enriches the
   * WorkspaceIndex.  The structured result is optional for older/offline
   * hosts; when omitted the bridge can claim only that the callback ran, not
   * that embeddings are fresh.
   */
  onIndexUpdated?: (notice?: KnowledgeRefreshNotice) => Promise<KnowledgeRefreshResult | void>;
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
  data?: T;
  /** Host-verifiable completion evidence; model prose is never used here. */
  completionEvidence?: CompletionEvidence[];
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
    if (!isAiToolPermissionAllowed(level, context.mode)) {
      return fail('TOOL_PERMISSION_DENIED', `Tool '${name}' requires ${level} permission in ${context.mode} mode.`);
    }

    if (context.explicitCreate === true && CREATE_UNSUPPORTED_MUTATION_TOOLS.has(name)) {
      return fail(
        'CREATE_NATIVE_COVERAGE_REQUIRED',
        '当前任务明确要求创建，但本工具只修改既有 canonical entry；没有完整 native create/template coverage，已拒绝继续。'
      );
    }

    const inputCheck = validateToolInput(tool.inputSchema, input);
    if (!inputCheck.ok) {
      return fail('INVALID_INPUT', inputCheck.message);
    }

    try {
      const result = await tool.run(input, context);
      return attachCompletionEvidence(name, result);
    } catch (error) {
      return fail('TOOL_EXCEPTION', error instanceof Error ? error.message : String(error));
    }
  }
}

const COMPLETION_MUTATION_TOOLS = new Set([
  'mutate_param_fields',
  'mutate_fmg_entries',
  'apply_emevd_dsl',
  'mutate_tae_event_times',
  'mutate_msb_part_transform',
  'batch_transform_map_objects',
  'execute_map_transaction',
  'import_map_from_blender'
]);

/**
 * Create is deliberately fail-closed until a domain exposes a complete native
 * template/serializer contract. In particular, an explicit create request may
 * not be misrouted into a mutation of the first existing row/entity.
 */
const CREATE_UNSUPPORTED_MUTATION_TOOLS = new Set([
  'propose_text_patch',
  'propose_plaintext_script_edit',
  'validate_patch',
  'build_patch_graph',
  'commit_patch',
  'commit_semantic_change_set',
  'mutate_param_fields',
  'mutate_fmg_entries',
  'apply_emevd_dsl',
  'mutate_tae_event_times',
  'mutate_msb_part_transform',
  'batch_transform_map_objects',
  'import_map_from_blender'
]);

const COMPLETION_READ_TOOLS = new Set([
  'retrieve_evidence',
  'search_resources',
  'search_events',
  'search_map_entities',
  'search_tae_events',
  'search_param_rows',
  'search_text_entries',
  'lookup_text_id',
  'find_text_references',
  'explain_text_entry',
  'find_references',
  'explain_event',
  'read_param_fields',
  'read_fmg_entries',
  'read_emevd_outline',
  'read_tae_events',
  'read_msb_parts',
  'query_map_objects',
  'inspect_map_object',
  'export_map_for_blender'
]);

const GENERIC_MUTATION_KEY = 'requested-mutations';
const GENERIC_POSTCONDITION_KEY = 'requested-postconditions';

/**
 * Convert only typed handler postconditions into completion evidence.  This
 * deliberately does not inspect assistant text or a generic `ok` flag.
 */
function attachCompletionEvidence(name: string, result: ToolResult): ToolResult {
  if (!result.ok) return result;
  const data = asRecord(result.data);
  const evidence: CompletionEvidence[] = [];
  const evidenceId = `tool:${name}`;
  const add = (kind: CompletionEvidence['kind'], key?: string): void => {
    evidence.push({ kind, evidenceIds: [evidenceId], ...(key ? { key } : {}) });
  };

  const coverage = data.coverage ?? asRecord(data.stats).coverage;
  const coverageRecord = asRecord(coverage);
  const coverageStatus = coverageRecord.status;
  const coverageRatio = coverageRecord.completenessRatio;
  const hasSourceRevision = typeof coverageRecord.sourceRevision === 'string'
    && coverageRecord.sourceRevision.length > 0;
  if (COMPLETION_READ_TOOLS.has(name)
    && (coverageStatus === 'FOUND' || coverageStatus === 'NOT_FOUND_WITH_COMPLETE_COVERAGE')
    && typeof coverageRatio === 'number'
    && coverageRatio >= 1
    && hasSourceRevision) {
    add('postconditions_verified', READ_FACTS_POSTCONDITION_KEY);
  }

  if (name === 'resolve_canonical_entities'
    && data.status === 'RESOLVED'
    && data.value !== undefined) {
    add('target_resolved');
  }
  if (name === 'propose_text_patch'
    || name === 'propose_plaintext_script_edit'
    || name === 'import_map_from_blender') {
    add('mutations_planned', GENERIC_MUTATION_KEY);
  }
  if (name === 'validate_patch' && data.ok === true) {
    add('staged');
    add('validators_passed');
  }
  if (name === 'commit_patch' && Array.isArray(data.changedFiles) && data.changedFiles.length > 0) {
    add('staged');
    add('validators_passed');
    add('committed');
  }
  if (name === 'commit_semantic_change_set'
    && Array.isArray(data.changedFiles)
    && data.changedFiles.length > 0
    && Array.isArray(data.postconditionsVerified)) {
    add('staged');
    add('validators_passed');
    add('committed');
    add('reread_verified');
    add('postconditions_verified', GENERIC_POSTCONDITION_KEY);
  }
  if (COMPLETION_MUTATION_TOOLS.has(name)) {
    const mutationCount = typeof data.mutations === 'number' ? data.mutations : undefined;
    const afterCount = Array.isArray(data.after) ? data.after.length : 0;
    const appliedOperations = typeof data.appliedOperations === 'number' ? data.appliedOperations : undefined;
    const hasCommittedMutation = (mutationCount !== undefined && mutationCount > 0)
      || afterCount > 0
      || (appliedOperations !== undefined && appliedOperations > 0)
      || (name === 'apply_emevd_dsl' && typeof data.mutationCount === 'number' && data.mutationCount > 0);
    if (hasCommittedMutation) {
      add('mutations_planned', GENERIC_MUTATION_KEY);
      add('staged');
      add('validators_passed');
      add('committed');
      // These mutation facades return only after native reread/postcondition
      // verification succeeds; a failed reread is an outer tool failure.
      add('reread_verified');
      add('postconditions_verified', GENERIC_POSTCONDITION_KEY);
    }
  }
  if (evidence.length === 0) return result;
  return {
    ...result,
    completionEvidence: [...(result.completionEvidence ?? []), ...evidence]
  };
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
    run: async (input, context) => {
      const corpus = resolveRagCorpus(context);
      if (corpus === null && context.workspaceIndex === null) {
        return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      }
      const value = asRecord(input);
      const query = asString(value.query);
      if (!query.trim()) return fail('INVALID_INPUT', 'retrieve_evidence 需要非空 query。');
      const families = asRagFamilies(value.families);
      const retrievalOptions = {
        limit: asNumber(value.limit, 8),
        ...(value.expandReferences === undefined ? {} : { expandReferences: value.expandReferences === true }),
        ...(families ? { families } : {})
      };
      const result = context.retrieveEvidence
        ? await context.retrieveEvidence(query, retrievalOptions)
        : retrieveEvidence(corpus, query, retrievalOptions);
      if (!result.ok) {
        if (result.code === 'insufficient_evidence') return ok({
          query,
          hits: [],
          totalHits: 0,
          note: result.message,
          ...(result.coverage ? { coverage: result.coverage } : {})
        });
        return fail(result.code, result.message);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind. The result includes coverage; zero hits are not proof of absence unless coverage.status is NOT_FOUND_WITH_COMPLETE_COVERAGE.',
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
      const results = ws.searchResources({ query, limit, ...(kinds ? { kinds } : {}) });
      return ok(indexedSearch(ws, 'workspace', results));
    }
  });

  registry.register({
    name: 'resolve_canonical_entities',
    description:
      'Resolve a natural-language or exact address to canonical entities with provenance, epistemic state, '
        + 'candidate set, source revision, and coverage. Never guess an ID or choose the first ranked candidate.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: { query: 'string', kind: 'string?', address: 'string?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const query = asString(value.query, '').trim();
      if (!query) return fail('INVALID_INPUT', 'resolve_canonical_entities 需要非空 query。');
      const kind = asCanonicalEntityKind(value.kind);
      if (value.kind !== undefined && kind === undefined) {
        return fail('INVALID_INPUT', 'resolve_canonical_entities.kind 不是受支持的 canonical entity kind。');
      }
      const address = asString(value.address, '').trim();
      const target = {
        text: query,
        ...(kind ? { kind } : {}),
        ...(address ? { address } : {}),
        exact: address.length > 0
      };
      // An address or an explicitly constrained domain is a bounded exact/domain
      // read.  A bare natural-language query must traverse the TaskModel's
      // cross-domain resolver instead of silently defaulting to FMG text and
      // pretending that the first text hit is the canonical entity.
      const resolver = new SemanticResolver(ws);
      return ok(address || kind
        ? resolver.resolveTarget(target)
        : resolver.resolveTask(createTaskModel(query)));
    }
  });

  registry.register({
    name: 'search_events',
    description: 'Search parsed event symbols. The result includes coverage; zero hits are not proof of absence unless coverage.status is NOT_FOUND_WITH_COMPLETE_COVERAGE.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(indexedSearch(ws, 'event', ws.searchEvents(asString(value.query, ''), asNumber(value.limit, 50))));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities and regions. The result includes coverage; zero hits are not proof of absence unless coverage.status is NOT_FOUND_WITH_COMPLETE_COVERAGE.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(indexedSearch(ws, 'map', ws.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50))));
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
      return ok(indexedSearch(ws, 'action', ws.searchTaeEvents(asString(value.query, ''), asNumber(value.limit, 50))));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows. The result includes coverage; zero hits are not proof of absence unless coverage.status is NOT_FOUND_WITH_COMPLETE_COVERAGE.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(indexedSearch(ws, 'param', ws.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50))));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries. The result includes coverage; zero hits are not proof of absence unless coverage.status is NOT_FOUND_WITH_COMPLETE_COVERAGE.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      return ok(indexedSearch(ws, 'text', ws.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50))));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up parsed text entries by numeric textId and optional category; zero matches include coverage and are not proof of absence.',
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
      return ok({
        textId,
        category,
        matches,
        coverage: coverageForScope(ws, 'text', matches.length),
        ...(matches.length === 0 ? { note: `当前覆盖率下未命中 textId ${textId}，不能据此断言不存在。` } : {})
      });
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
      if (matches.length === 0) return ok({
        textId,
        category,
        matches: [],
        coverage: coverageForScope(ws, 'text', 0),
        note: `当前覆盖率下未找到 textId ${textId}，不能据此断言不存在。`
      });
      const items = matches.map((entry) => {
        const references = ws.findReferences(entry.uri, 'to');
        return { entry, references, referenceStats: summarizeReferences(references) };
      });
      return ok({
        textId,
        category,
        matches: items,
        totalReferences: items.reduce((sum, item) => sum + item.references.length, 0),
        coverage: coverageForScope(ws, 'text', items.length)
      });
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
      const result = await dryRunPatchProposal(proposal);
      if (!result.ok) {
        const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
        return fail(
          diagnostic?.code ?? 'PATCH_VALIDATION_FAILED',
          diagnostic?.message ?? 'Patch Engine staging/validation 失败。',
          result
        );
      }
      return ok(result);
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
        resourceKind: asResourceKind(rawFile.resourceKind),
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
      if (!context.session) return fail('WORKSPACE_REQUIRED', 'read_param_fields 需要已打开且已建立原生编辑会话的工作区。');
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
        context.workspaceIndex.mergeParamRows({
          paramName: table,
          rows: [...rowsById.entries()].map(([rowId, fields]) => ({
            uri: `${sourceUri}#${table}/${rowId}`,
            sourceUri,
            paramName: table,
            rowId,
            fields: fields.map((field) => ({ name: field.fieldId, value: field.value }))
          }))
        });
        await refreshWorkspaceFileRevision(context, edit.session, result.containerPath, 'param');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'read-enrichment' });
      }
      return ok({
        ...result,
        coverage: coverageForScope(context.workspaceIndex, 'param', result.fields.length)
      });
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
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(result.containerPath).href;
        mergeLiveParamSnapshots(context.workspaceIndex, sourceUri, result.after);
        await refreshWorkspaceFileRevision(context, edit.session, result.containerPath, 'param');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
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
      if (!context.session) return fail('WORKSPACE_REQUIRED', 'read_fmg_entries 需要已打开且已建立原生编辑会话的工作区。');
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
        context.workspaceIndex.mergeMsgEntries({
          category: result.table,
          entries: result.entries.map((entry) => ({
            uri: `${sourceUri}#${result.table}/${entry.id}`,
            sourceUri,
            category: result.table,
            textId: entry.id,
            text: entry.text,
            confidence: 'high'
          }))
        });
        await refreshWorkspaceFileRevision(context, edit.session, result.containerPath, 'msg');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'read-enrichment' });
      }
      return ok({
        ...result,
        coverage: coverageForScope(context.workspaceIndex, 'text', result.entries.length)
      });
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
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(result.containerPath).href;
        mergeLiveFmgSnapshots(context.workspaceIndex, sourceUri, result.after);
        await refreshWorkspaceFileRevision(context, edit.session, result.containerPath, 'msg');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
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
      if (!context.session) return fail('WORKSPACE_REQUIRED', 'read_emevd_outline 需要已打开且已建立原生编辑会话的工作区。');
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const file = asString(asRecord(input).file);
      if (!file) return fail('INVALID_INPUT', 'read_emevd_outline 需要 file。');
      const result = await readEmevdOutline({ edit: edit.session, file });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_READ_FAILED', result.error?.message ?? '读取失败。');
      if (context.workspaceIndex && result.events && result.filePath) {
        const indexedFile = context.workspaceIndex.getFiles().find((candidate) => candidate.absolutePath === result.filePath);
        const sourceUri = indexedFile?.sourceUri ?? result.filePath ?? file;
        const mapId = basename(sourceUri).replace(/\.emevd(?:\.dcx)?$/i, '');
        context.workspaceIndex.upsertEventExport({
          mapId,
          events: result.events.map((event) => ({
            uri: `${sourceUri}#event/${event.eventId}`,
            sourceUri,
            mapId,
            eventId: event.eventId,
            instructions: [],
            raw: {
              authority: 'native-verified-outline',
              instructionCount: event.instructionCount,
              restBehavior: event.restBehavior,
              semanticArgsDecoded: false
            }
          }))
        });
        await refreshWorkspaceFileRevision(context, edit.session, result.filePath, 'event');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'read-enrichment' });
      }
      return ok({
        ...result,
        coverage: coverageForScope(context.workspaceIndex, 'event', result.events?.length ?? 0)
      });
    }
  });

  registry.register({
    name: 'apply_emevd_dsl',
    description: 'Compile and commit EMEVD DSL through the canonical four-view compiler/writer path. '
      + 'The binary is never treated as text and the committed document is reread before success.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', dsl: 'string', mode: 'string?', emedfPath: 'string?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const dsl = asString(value.dsl);
      if (!file || !dsl.trim()) return fail('INVALID_INPUT', 'apply_emevd_dsl 需要 file 和非空 dsl。');
      const mode = value.mode === 'patch' || value.mode === 'dark-script' ? value.mode : undefined;
      const emedfPath = asOptionalString(value.emedfPath);
      const result = await applyEmevdDsl({
        edit: edit.session,
        file,
        dsl,
        ...(mode ? { mode } : {}),
        ...(emedfPath ? { emedfPath } : {})
      });
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_DSL_REJECTED', result.error?.message ?? 'EMEVD DSL 提交失败。', result.diagnostics);

      if (context.workspaceIndex && result.filePath) {
        const reread = await readEmevdOutline({ edit: edit.session, file: result.filePath });
        if (!reread.ok || !reread.filePath || !reread.events) {
          return fail('EMEVD_COMMITTED_REREAD_FAILED', 'EMEVD 已提交但提交后权威重读失败，拒绝报告成功。', reread);
        }
        const sourceUri = pathToFileURL(reread.filePath).href;
        const mapId = basename(reread.filePath).replace(/\.emevd(?:\.dcx)?$/i, '');
        context.workspaceIndex.upsertEventExport({
          mapId,
          events: reread.events.map((event) => ({
            uri: `${sourceUri}#event/${event.eventId}`,
            sourceUri,
            mapId,
            eventId: event.eventId,
            instructions: [],
            raw: {
              authority: 'native-verified-outline',
              instructionCount: event.instructionCount,
              restBehavior: event.restBehavior,
              semanticArgsDecoded: false
            }
          }))
        });
        await refreshWorkspaceFileRevision(context, edit.session, reread.filePath, 'event');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'read_tae_events',
    description: 'Read live TAE event times and bounded decoded fields by canonical action address. '
      + 'Partial address selection is merged into the index without claiming complete coverage.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?' },
    run: async (input, context) => {
      if (!context.session) return fail('WORKSPACE_REQUIRED', 'read_tae_events 需要已打开且已建立原生编辑会话的工作区。');
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const addresses = asStringList(value.addresses);
      if (!file) return fail('INVALID_INPUT', 'read_tae_events 需要 file。');
      const result = await readTaeEvents({ edit: edit.session, file, ...(addresses.length > 0 ? { addresses } : {}) });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(result.filePath).href;
        mergeLiveTaeEvents(context.workspaceIndex, result.chrId, sourceUri, result.events);
        await refreshWorkspaceFileRevision(context, edit.session, result.filePath, 'action');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'read-enrichment' });
      }
      return ok({ ...result, coverage: coverageForScope(context.workspaceIndex, 'action', result.events.length) });
    }
  });

  registry.register({
    name: 'mutate_tae_event_times',
    description: 'Set TAE event start/end frames by canonical action address through Patch Engine, '
      + 'then reread and refresh the action index before success.',
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
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(result.filePath).href;
        const chrId = result.after[0]?.chrId ?? inferChrIdFromPath(result.filePath);
        if (chrId) mergeLiveTaeEvents(context.workspaceIndex, chrId, sourceUri, result.after);
        await refreshWorkspaceFileRevision(context, edit.session, result.filePath, 'action');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'read_msb_parts',
    description: 'Read live MSB part transforms by canonical map address. Results are merged into the '
      + 'existing map projection and retain coverage diagnostics.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?' },
    run: async (input, context) => {
      if (!context.session) return fail('WORKSPACE_REQUIRED', 'read_msb_parts 需要已打开且已建立原生编辑会话的工作区。');
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const addresses = asStringList(value.addresses);
      if (!file) return fail('INVALID_INPUT', 'read_msb_parts 需要 file。');
      const result = await readMsbParts({ edit: edit.session, file, ...(addresses.length > 0 ? { addresses } : {}) });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (context.workspaceIndex) {
        mergeLiveMapSnapshots(context.workspaceIndex, result.mapId, pathToFileURL(result.filePath).href, result.parts);
        await refreshWorkspaceFileRevision(context, edit.session, result.filePath, 'map');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'read-enrichment' });
      }
      return ok({ ...result, coverage: coverageForScope(context.workspaceIndex, 'map', result.parts.length) });
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
      const operations: MapEditOperation[] = [];
      for (const editItem of edits.edits) {
        const part = loaded.sceneGraph.findPart(editItem.address);
        if (!part) return fail('MSB_PART_NOT_FOUND', `part 不存在：${editItem.address}`);
        if (!hasAnyMsbTransform(editItem)) {
          return fail('MSB_EDIT_EMPTY', `${editItem.address} 没有任何要写入的变换字段。`);
        }
        operations.push({
          kind: 'set_transform',
          target: part.stableKey,
          position: [
            editItem.posX ?? part.transform.position[0],
            editItem.posY ?? part.transform.position[1],
            editItem.posZ ?? part.transform.position[2]
          ],
          rotation: [
            editItem.rotX ?? part.transform.rotation[0],
            editItem.rotY ?? part.transform.rotation[1],
            editItem.rotZ ?? part.transform.rotation[2]
          ],
          scale: [
            editItem.scaleX ?? part.transform.scale[0],
            editItem.scaleY ?? part.transform.scale[1],
            editItem.scaleZ ?? part.transform.scale[2]
          ]
        });
      }
      const transaction = {
        id: `tx-agent-msb-${Date.now()}`,
        mapId: loaded.doc.mapId,
        baseRevision: loaded.doc.revision,
        description: 'Agent MSB part transform transaction',
        author: 'agent' as const,
        operations,
        timestamp: Date.now()
      };
      const result = await executeMapTransaction(edit.session, file, transaction);
      if (!result.ok) return fail(result.error?.code ?? 'MSB_TRANSACTION_FAILED', result.error?.message ?? 'MSB 事务提交失败。', result.error?.details);
      const reread = await readMsbParts({
        edit: edit.session,
        file,
        addresses: edits.edits.map((item) => item.address)
      });
      if (!reread.ok) return fail('MSB_COMMITTED_REREAD_FAILED', 'MSB 已提交但提交后权威重读失败，拒绝报告成功。', reread);
      if (context.workspaceIndex) {
        const sourceUri = pathToFileURL(reread.filePath).href;
        mergeLiveMapSnapshots(context.workspaceIndex, reread.mapId, sourceUri, reread.parts);
        await refreshWorkspaceFileRevision(context, edit.session, reread.filePath, 'map');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok({
        ...result,
        filePath: reread.filePath,
        mapId: reread.mapId,
        before: [],
        after: reread.parts,
        mutations: result.appliedOperations,
        diagnostics: reread.diagnostics
      });
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
      const kind = asMapQueryKind(value.kind);
      if (value.kind !== undefined && kind === undefined) {
        return fail('INVALID_INPUT', 'query_map_objects.kind 不是受支持的地图实体类型。');
      }
      const result = await queryMapEntities(edit.session, file, {
        ...(value.modelName ? { modelName: asString(value.modelName) } : {}),
        ...(typeof value.entityId === 'number' ? { entityId: Number(value.entityId) } : {}),
        ...(kind ? { kind } : {}),
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
      const loaded = await loadMapDocument(edit.session, file);
      if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
      const deltaX = typeof value.deltaX === 'number' ? Number(value.deltaX) : 0;
      const deltaY = typeof value.deltaY === 'number' ? Number(value.deltaY) : 0;
      const deltaZ = typeof value.deltaZ === 'number' ? Number(value.deltaZ) : 0;
      const rotDeltaX = typeof value.rotDeltaX === 'number' ? Number(value.rotDeltaX) : 0;
      const rotDeltaY = typeof value.rotDeltaY === 'number' ? Number(value.rotDeltaY) : 0;
      const rotDeltaZ = typeof value.rotDeltaZ === 'number' ? Number(value.rotDeltaZ) : 0;
      const scaleMultiplier = typeof value.scaleMultiplier === 'number' ? Number(value.scaleMultiplier) : 1;
      const operations: MapEditOperation[] = [];
      for (const target of targets) {
        const part = loaded.sceneGraph.findPart(target);
        if (!part) return fail('MSB_PART_NOT_FOUND', `批量目标 Part 不存在：${target}`);
        operations.push({
          kind: 'set_transform',
          target: part.stableKey,
          position: [
            part.transform.position[0] + deltaX,
            part.transform.position[1] + deltaY,
            part.transform.position[2] + deltaZ
          ],
          rotation: [
            part.transform.rotation[0] + rotDeltaX,
            part.transform.rotation[1] + rotDeltaY,
            part.transform.rotation[2] + rotDeltaZ
          ],
          scale: [
            part.transform.scale[0] * scaleMultiplier,
            part.transform.scale[1] * scaleMultiplier,
            part.transform.scale[2] * scaleMultiplier
          ]
        });
      }
      const transaction = {
        id: `tx-agent-msb-batch-${Date.now()}`,
        mapId: loaded.doc.mapId,
        baseRevision: loaded.doc.revision,
        description: 'Agent batch MSB transform transaction',
        author: 'agent' as const,
        operations,
        timestamp: Date.now()
      };
      const committed = await executeMapTransaction(edit.session, file, transaction);
      if (!committed.ok) return fail(committed.error?.code ?? 'BATCH_TRANSFORM_FAILED', committed.error?.message ?? '批量变换失败', committed.error?.details);
      const reread = await readMsbParts({
        edit: edit.session,
        file,
        addresses: targets
      });
      if (!reread.ok) return fail('MSB_COMMITTED_REREAD_FAILED', 'MSB 已提交但提交后权威重读失败，拒绝报告成功。', reread);
      if (context.workspaceIndex) {
        mergeLiveMapSnapshots(context.workspaceIndex, reread.mapId, pathToFileURL(reread.filePath).href, reread.parts);
        await refreshWorkspaceFileRevision(context, edit.session, reread.filePath, 'map');
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok({
        ...committed,
        modifiedCount: committed.appliedOperations,
        mutations: committed.appliedOperations,
        targets,
        before: [],
        after: reread.parts,
        filePath: reread.filePath,
        mapId: reread.mapId,
        diagnostics: reread.diagnostics
      });
    }
  });

  registry.register({
    name: 'execute_map_transaction',
    description: 'Execute typed MapEditTransaction operations through the single native MSB/Patch Engine path. '
      + 'Supports set_transform, batch_transform, set_property(entityId), change_model, template-backed duplicate/create Part, and delete; '
      + 'all operations are preflighted and the committed document is reread before success is returned.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', operations: 'array', description: 'string?', baseRevision: 'string?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'execute_map_transaction 需要 file。');
      const parsed = asMapEditOperations(value.operations);
      if (!parsed.ok) return fail('INVALID_INPUT', parsed.message);
      const loaded = await loadMapDocument(edit.session, file);
      if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
      const transaction = {
        id: `tx-agent-map-${Date.now()}`,
        mapId: loaded.doc.mapId,
        baseRevision: asOptionalString(value.baseRevision) ?? loaded.doc.revision,
        description: asOptionalString(value.description) ?? 'Agent MapEditTransaction',
        author: 'agent' as const,
        operations: parsed.operations,
        timestamp: Date.now()
      };
      const committed = await executeMapTransaction(edit.session, file, transaction);
      if (!committed.ok) {
        return fail(
          committed.error?.code ?? 'MAP_TRANSACTION_FAILED',
          committed.error?.message ?? 'Agent MapEditTransaction 提交失败。',
          committed.error?.details
        );
      }
      const reread = await loadMapDocument(edit.session, file);
      if (!reread.ok) return fail('MAP_REREAD_FAILED', '地图事务已提交但提交后权威重读失败。', reread.error);
      if (context.workspaceIndex) {
        mergeLiveMapDocument(context.workspaceIndex, reread.doc, pathToFileURL(reread.filePath).href);
        context.workspaceIndex.rebuildReferences();
        await refreshWorkspaceFileRevision(context, edit.session, reread.filePath, 'map');
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok({
        ...committed,
        status: 'committed',
        transactionId: transaction.id,
        filePath: reread.filePath,
        mapId: reread.doc.mapId,
        revision: reread.doc.revision,
        counts: {
          models: reread.doc.models.length,
          parts: reread.doc.parts.length,
          regions: reread.doc.regions.length,
          events: reread.doc.events.length,
          routes: reread.doc.routes.length
        },
        diagnostics: []
      });
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
      const committed = await executeMapTransaction(edit.session, file, translation.transaction);
      if (!committed.ok) {
        return fail(
          committed.error?.code ?? 'MAP_TRANSACTION_FAILED',
          committed.error?.message ?? 'Blender 地图事务提交失败。',
          committed.error?.details
        );
      }
      const reread = await loadMapDocument(edit.session, file);
      if (!reread.ok) return fail('MAP_REREAD_FAILED', 'Blender 地图事务提交后权威重读失败。', reread.error);
      if (context.workspaceIndex) {
        mergeLiveMapDocument(context.workspaceIndex, reread.doc, pathToFileURL(reread.filePath).href);
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok({
        transaction: translation.transaction,
        status: 'committed',
        ...committed,
        filePath: reread.filePath,
        mapId: reread.doc.mapId,
        diagnostics: []
      });
    }
  });

  registry.register({
    name: 'commit_semantic_change_set',
    description: 'Commit a complete multi-domain SemanticChangeSet through one durable WorkspaceTransaction. '
      + 'Each proposal must already come from an authoritative domain writer and every change must carry the '
      + 'current beforeHash. The supported postcondition is exactly committed_bytes_match_staged; native '
      + 'semantic postconditions remain fail-closed until their domain reread adapter is supplied.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      changeSet: 'object',
      proposals: 'array'
    },
    run: async (input, context) => {
      const value = asRecord(input);
      const parsedChangeSet = parseSemanticChangeSetInput(value.changeSet);
      if (!parsedChangeSet.ok) return fail('INVALID_INPUT', parsedChangeSet.message);
      const parsedProposals = parseSemanticPatchProposalInputs(value.proposals);
      if (!parsedProposals.ok) return fail('INVALID_INPUT', parsedProposals.message);
      if (!context.session || !context.operationLogStore || !context.backupBaseDir) {
        return fail(
          'COMMIT_CONTEXT_REQUIRED',
          '语义事务提交需要主进程注入的生产上下文（session / operationLogStore / backupBaseDir）。'
        );
      }
      if (!context.confirmation?.id || context.confirmation.subjects.length === 0) {
        return fail('EDIT_CONFIRMATION_REQUIRED', '语义事务提交需要用户审批回执。');
      }
      const overlayRoot = context.session.layers.overlayRoot;
      const resolvedProposals: SemanticPatchProposalInput[] = [];
      for (const item of parsedProposals.value) {
        const resolvedChanges = [];
        for (const change of item.proposal.changes) {
          const absolute = isAbsolute(change.targetPath)
            ? change.targetPath
            : join(overlayRoot, change.targetPath);
          const writable = context.session.resolveWritablePath(absolute, change.layer ?? 'overlay');
          if (!writable.ok || !writable.absolutePath) {
            const diagnostic = writable.diagnostics[0];
            return fail(
              diagnostic?.code ?? 'WRITE_OUTSIDE_OVERLAY',
              diagnostic?.message ?? '语义事务目标不在当前工作区 overlay 内。',
              { targetPath: change.targetPath }
            );
          }
          resolvedChanges.push({ ...change, targetPath: writable.absolutePath });
        }
        resolvedProposals.push({
          operationIds: item.operationIds,
          proposal: { ...item.proposal, changes: resolvedChanges }
        });
      }
      const edit = nativeEditSessionFromContext({
        session: context.session,
        operationLog: context.operationLogStore,
        backupBaseDir: context.backupBaseDir,
        recoveryDir: context.recoveryDir ?? join(overlayRoot, '.soulforge-staging', 'recovery'),
        ...(context.confirmation ? { confirmation: context.confirmation } : {})
      });
      const result = await executeSemanticPatchProposalTransaction({
        changeSet: parsedChangeSet.value,
        proposals: resolvedProposals,
        workspaceRoot: overlayRoot,
        session: context.session,
        operationLog: context.operationLogStore,
        backupBaseDir: context.backupBaseDir,
        ...(context.recoveryDir ? { recoveryDir: context.recoveryDir } : {}),
        actorId: 'agent:semantic-change-set',
        onCommitted: async (targetPaths) => {
          if (!context.workspaceIndex) return;
          for (const targetPath of targetPaths) {
            const kind = context.workspaceIndex.getFiles().find((file) => file.absolutePath === targetPath)?.resourceKind
              ?? classifyResourceKind(targetPath);
            await refreshWorkspaceFileRevision(context, edit, targetPath, kind);
          }
          context.workspaceIndex.rebuildReferences();
          await context.onIndexUpdated?.({ reason: 'committed-mutation' });
        }
      });
      const failed = result.diagnostics.some((item) => item.severity === 'error')
        || result.changedFiles.length === 0;
      if (failed) {
        const diagnostic = result.diagnostics.find((item) => item.severity === 'error');
        return fail(
          diagnostic?.code ?? 'SEMANTIC_COMMIT_FAILED',
          diagnostic?.message ?? 'SemanticChangeSet 提交失败，未报告成功。',
          { changeSetId: parsedChangeSet.value.changeSetId, result }
        );
      }
      return ok({
        ...result,
        changeSetId: parsedChangeSet.value.changeSetId,
        postconditionsVerified: parsedChangeSet.value.postconditions
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

      // The generic Patch Engine result is not itself the semantic
      // postcondition.  Re-read every committed file and compare it with the
      // durable afterHash recorded for that operation before exposing any
      // completion evidence.
      const rereadDiagnostics = [];
      if (!result.operation || result.operation.files.length !== result.changedFiles.length) {
        rereadDiagnostics.push({
          severity: 'error' as const,
          code: 'COMMITTED_REREAD_UNVERIFIABLE',
          message: '提交返回的操作日志缺少完整文件 afterHash，拒绝报告成功。'
        });
      } else {
        for (const file of result.operation.files) {
          try {
            const actualHash = createHash('sha256').update(await readFile(file.targetPath)).digest('hex');
            if (actualHash !== file.afterHash) {
              rereadDiagnostics.push({
                severity: 'error' as const,
                code: 'COMMITTED_REREAD_FAILED',
                message: `提交后重读哈希不匹配：${file.targetUri}。`,
                details: { expectedAfterHash: file.afterHash, actualHash }
              });
            }
          } catch (error) {
            rereadDiagnostics.push({
              severity: 'error' as const,
              code: 'COMMITTED_REREAD_FAILED',
              message: error instanceof Error ? error.message : '提交后重读失败。',
              details: { targetUri: file.targetUri, targetPath: file.targetPath }
            });
          }
        }
      }
      if (rereadDiagnostics.length > 0) {
        return fail(
          'COMMITTED_REREAD_FAILED',
          'Patch Engine 已返回提交结果，但提交后权威重读未通过；拒绝报告成功。',
          {
            opId: result.opId,
            changedFiles: result.changedFiles,
            recoveryRequired: true,
            diagnostics: rereadDiagnostics
          }
        );
      }
      if (context.workspaceIndex) {
        for (const changedFile of result.changedFiles) {
          const absolutePath = isAbsolute(changedFile) ? changedFile : join(overlayRoot, changedFile);
          const kind = context.workspaceIndex.getFiles().find((file) => file.absolutePath === absolutePath)?.resourceKind
            ?? classifyResourceKind(absolutePath);
          await refreshWorkspaceFileRevision(context, nativeEditSessionFromContext({
            session: context.session,
            operationLog: context.operationLogStore,
            backupBaseDir: context.backupBaseDir,
            recoveryDir: context.recoveryDir ?? join(overlayRoot, '.soulforge-staging', 'recovery'),
            ...(context.confirmation ? { confirmation: context.confirmation } : {})
          }), absolutePath, kind);
        }
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
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
      if (context.workspaceIndex && result.restoredFiles) {
        const edit = nativeEditSessionFromContext({
          session: context.session,
          operationLog: context.operationLogStore,
          backupBaseDir: context.backupBaseDir,
          recoveryDir: context.recoveryDir,
          ...(context.confirmation ? { confirmation: context.confirmation } : {})
        });
        for (const restoredFile of result.restoredFiles) {
          const absolutePath = isAbsolute(restoredFile) ? restoredFile : join(context.session.layers.overlayRoot, restoredFile);
          const kind = context.workspaceIndex.getFiles().find((file) => file.absolutePath === absolutePath)?.resourceKind
            ?? classifyResourceKind(absolutePath);
          await refreshWorkspaceFileRevision(context, edit, absolutePath, kind);
        }
        context.workspaceIndex.rebuildReferences();
        await context.onIndexUpdated?.({ reason: 'committed-mutation' });
      }
      return ok(result);
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
    // This is a durable side effect outside the Mod workspace.  It therefore
    // is not a Patch Engine operation, but it still requires the commit-level
    // approval boundary rather than being silently executable as a proposal.
    permission: 'commit',
    permissionLevel: 'commit',
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

async function refreshWorkspaceFileRevision(
  context: ToolContext,
  edit: NativeEditSession,
  absolutePath: string,
  kind: ResourceKind
): Promise<void> {
  const index = context.workspaceIndex;
  if (!index) return;
  const indexed = await edit.indexFile(absolutePath, kind);
  const previous = index.getFiles().find((file) => file.sourceUri === indexed.sourceUri || file.absolutePath === indexed.absolutePath);
  const next = previous?.parseStatus === 'parsed'
    ? { ...indexed, diagnostics: previous.diagnostics }
    : {
      ...indexed,
      parseStatus: 'partial' as const,
      diagnostics: [
        ...((previous?.diagnostics ?? indexed.diagnostics)),
        {
          severity: 'info' as const,
          code: 'LIVE_NATIVE_READ_PARTIAL_INDEX',
          message: '该文件已由原生门面实时读取并刷新 revision；局部读取不提升整文件 coverage。',
          sourceUri: indexed.sourceUri
        }
      ]
    };
  index.upsertFile(next);
}

function mergeLiveParamSnapshots(
  index: WorkspaceIndex,
  sourceUri: string,
  snapshots: ReadonlyArray<{
    table: string;
    rowId: number;
    fieldId: string;
    value: number | string | boolean | null;
  }>
): void {
  const grouped = new Map<string, typeof snapshots[number][]>();
  for (const snapshot of snapshots) {
    const items = grouped.get(snapshot.table) ?? [];
    items.push(snapshot);
    grouped.set(snapshot.table, items);
  }
  const current = index.toSymbolBundle().params ?? [];
  for (const [table, items] of grouped) {
    const existing = current.find((item) => item.paramName.toLowerCase() === table.toLowerCase());
    const rows = new Map((existing?.rows ?? []).map((row) => [row.rowId, row]));
    for (const item of items) {
      const previous = rows.get(item.rowId);
      const fields = new Map((previous?.fields ?? []).map((field) => [field.name, field]));
      fields.set(item.fieldId, { name: item.fieldId, value: item.value });
      rows.set(item.rowId, {
        uri: previous?.uri ?? `${sourceUri}#${table}/${item.rowId}`,
        sourceUri,
        paramName: table,
        rowId: item.rowId,
        ...(previous?.rowName ? { rowName: previous.rowName } : {}),
        fields: [...fields.values()]
      });
    }
    index.mergeParamRows({ paramName: table, rows: [...rows.values()] });
  }
}

function mergeLiveFmgSnapshots(
  index: WorkspaceIndex,
  sourceUri: string,
  snapshots: ReadonlyArray<{ table: string; id: number; text: string }>
): void {
  const grouped = new Map<string, typeof snapshots[number][]>();
  for (const snapshot of snapshots) {
    const items = grouped.get(snapshot.table) ?? [];
    items.push(snapshot);
    grouped.set(snapshot.table, items);
  }
  for (const [table, items] of grouped) {
    index.mergeMsgEntries({
      category: table,
      entries: items.map((item) => ({
        uri: `${sourceUri}#${table}/${item.id}`,
        sourceUri,
        category: table,
        textId: item.id,
        text: item.text,
        confidence: 'high'
      }))
    });
  }
}

function mergeLiveMapSnapshots(
  index: WorkspaceIndex,
  mapId: string,
  sourceUri: string,
  snapshots: ReadonlyArray<{
    name: string;
    mapId: string;
    posX: number;
    posY: number;
    posZ: number;
    rotX?: number;
    rotY?: number;
    rotZ?: number;
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
  }>
): void {
  const maps = index.toSymbolBundle().maps ?? [];
  const existing = maps.find((item) => item.mapId === mapId
    || item.entities.some((entity) => entity.sourceUri === sourceUri));
  if (!existing) return;
  const byName = new Map(snapshots.map((snapshot) => [snapshot.name, snapshot]));
  const entities = existing.entities.map((entity) => {
    const snapshot = byName.get(entity.name);
    if (!snapshot) return entity;
    return {
      ...entity,
      sourceUri,
      position: [snapshot.posX, snapshot.posY, snapshot.posZ] as [number, number, number],
      ...(snapshot.rotX !== undefined && snapshot.rotY !== undefined && snapshot.rotZ !== undefined
        ? { rotation: [snapshot.rotX, snapshot.rotY, snapshot.rotZ] as [number, number, number] }
        : {}),
      ...(snapshot.scaleX !== undefined && snapshot.scaleY !== undefined && snapshot.scaleZ !== undefined
        ? { scale: [snapshot.scaleX, snapshot.scaleY, snapshot.scaleZ] as [number, number, number] }
        : {})
    };
  });
  const next: MapExport = { ...existing, entities };
  index.upsertMapExport(next);
}

/** Replace the indexed map projection from a committed canonical reread. */
function mergeLiveMapDocument(index: WorkspaceIndex, document: MapDocument, sourceUri: string): void {
  const existing = index.toSymbolBundle().maps?.find((item) => item.mapId === document.mapId
    || item.entities.some((entity) => entity.sourceUri === sourceUri));
  const existingEntities = new Map((existing?.entities ?? []).map((entity) => [entity.name, entity]));
  const existingRegions = new Map((existing?.regions ?? []).map((region) => [region.name, region]));
  const entities: MapExport['entities'] = document.parts.map((part) => {
    const prior = existingEntities.get(part.name);
    return {
      ...(prior ?? {
        uri: `map://${document.mapId}/part/${part.name}`,
        kind: 'unknown' as const
      }),
      sourceUri,
      mapId: document.mapId,
      name: part.name,
      model: part.modelName,
      modelIndex: part.modelIndex,
      ...(part.entityId === undefined ? {} : { entityId: part.entityId }),
      position: part.transform.position,
      rotation: part.transform.rotation,
      scale: part.transform.scale
    };
  });
  const regions: MapExport['regions'] = document.regions.map((region) => {
    const prior = existingRegions.get(region.name);
    return {
      ...(prior ?? {
        uri: `map://${document.mapId}/region/${region.name}`
      }),
      sourceUri,
      mapId: document.mapId,
      name: region.name,
      ...(region.entityId === undefined ? {} : { entityId: region.entityId }),
      position: region.transform.position,
      rotation: region.transform.rotation
    };
  });
  index.upsertMapExport({ mapId: document.mapId, entities, regions });
}

function mergeLiveTaeEvents(
  index: WorkspaceIndex,
  chrId: string,
  sourceUri: string,
  snapshots: ReadonlyArray<{
    chrId: string;
    animId: number;
    code: string;
    eventIndex: number;
    uri: string;
    eventTypeId: number;
    typeName?: string;
    startTime: number;
    endTime: number;
    startFrame: number;
    endFrame: number;
    fields?: Array<{ name: string; value: string | number | boolean }>;
    parameterBytesHex?: string;
  }>
): void {
  const existing = index.toSymbolBundle().tae?.find((item) => item.chrId.toLowerCase() === chrId.toLowerCase());
  const animations = new Map<number, TaeExport['animations'][number]>();
  for (const animation of existing?.animations ?? []) {
    animations.set(animation.animId, {
      ...animation,
      events: [...animation.events]
    });
  }
  for (const snapshot of snapshots) {
    const animation = animations.get(snapshot.animId) ?? {
      animId: snapshot.animId,
      code: snapshot.code,
      events: []
    };
    const nextEvent = {
      uri: snapshot.uri,
      index: snapshot.eventIndex,
      eventTypeId: snapshot.eventTypeId,
      ...(snapshot.typeName ? { typeName: snapshot.typeName } : {}),
      startTime: snapshot.startTime,
      endTime: snapshot.endTime,
      startFrame: snapshot.startFrame,
      endFrame: snapshot.endFrame,
      ...(snapshot.fields ? { fields: snapshot.fields } : {}),
      ...(snapshot.parameterBytesHex ? { parameterBytesHex: snapshot.parameterBytesHex } : {})
    };
    const events = animation.events.filter((event) => event.index !== snapshot.eventIndex);
    events.push(nextEvent);
    events.sort((left, right) => left.index - right.index);
    animations.set(snapshot.animId, { ...animation, events });
  }
  const next: TaeExport = {
    chrId,
    sourceUri,
    animations: [...animations.values()].sort((left, right) => left.animId - right.animId)
  };
  index.upsertTaeExport(next);
}

function inferChrIdFromPath(filePath: string): string | undefined {
  const match = filePath.match(/(?:^|[\\/])c(\d{4})(?:\.|[\\/]|$)/i);
  return match ? `c${match[1]}`.toLowerCase() : undefined;
}

function indexedSearch<T>(
  index: WorkspaceIndex,
  scope: string,
  items: readonly SearchResult<T>[]
): { items: SearchResult<T>[]; coverage: ReturnType<typeof coverageForSearch> } {
  return { items: [...items], coverage: coverageForSearch(index, scope, items) };
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
  return { ok: true, data };
}

function fail(code: string, message: string, details?: unknown): ToolResult<never> {
  return {
    ok: false,
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
    return '这是 MSB 地图文档，请用 read_msb_parts / mutate_msb_part_transform / execute_map_transaction，不要把 msb 当文本补丁。';
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

function parseSemanticChangeSetInput(value: unknown):
  | { ok: true; value: SemanticChangeSet }
  | { ok: false; message: string } {
  if (!isObjectRecord(value)) return { ok: false, message: 'changeSet 必须是对象。' };
  const changeSetId = asString(value.changeSetId);
  const baseRevision = asString(value.baseRevision);
  const targetIdentities = asStringList(value.targetIdentities);
  const dependencyOrder = asStringList(value.dependencyOrder);
  const postconditions = asStringList(value.postconditions);
  const diagnostics = Array.isArray(value.diagnostics)
    ? value.diagnostics.filter((item): item is string => typeof item === 'string')
    : [];
  const conflictPolicy = value.conflictPolicy === 'manual_review' || value.conflictPolicy === 'fail_closed'
    ? value.conflictPolicy
    : undefined;
  if (!changeSetId || !baseRevision || targetIdentities.length === 0 || dependencyOrder.length === 0 || !conflictPolicy) {
    return { ok: false, message: 'changeSet 需要 changeSetId、baseRevision、targetIdentities、dependencyOrder、conflictPolicy。' };
  }
  if (!isObjectRecord(value.expectedBaseRevisions)) {
    return { ok: false, message: 'changeSet.expectedBaseRevisions 必须是对象。' };
  }
  const expectedBaseRevisions: Record<string, string> = {};
  for (const [target, revision] of Object.entries(value.expectedBaseRevisions)) {
    if (typeof revision !== 'string' || revision.length === 0) {
      return { ok: false, message: `changeSet.expectedBaseRevisions[${target}] 必须是非空字符串。` };
    }
    expectedBaseRevisions[target] = revision;
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    return { ok: false, message: 'changeSet.operations 必须是非空数组。' };
  }
  const operations: SemanticChangeOperation[] = [];
  for (const raw of value.operations) {
    if (!isObjectRecord(raw)) return { ok: false, message: 'changeSet.operations 包含无效条目。' };
    const domain = raw.domain;
    if (domain !== 'param' && domain !== 'fmg' && domain !== 'event'
      && domain !== 'map' && domain !== 'action' && domain !== 'resource') {
      return { ok: false, message: 'changeSet.operations.domain 无效。' };
    }
    if (!isObjectRecord(raw.payload)) return { ok: false, message: '每个 semantic operation 都需要 payload 对象。' };
    const operationId = asString(raw.operationId);
    const targetIdentity = asString(raw.targetIdentity);
    const kind = asString(raw.kind);
    const beforeRevision = asString(raw.beforeRevision);
    const dependencies = asStringList(raw.dependencies);
    if (!operationId || !targetIdentity || !kind || !beforeRevision) {
      return { ok: false, message: '每个 semantic operation 都需要 operationId、targetIdentity、kind、beforeRevision。' };
    }
    operations.push({
      operationId,
      domain,
      targetIdentity,
      kind,
      beforeRevision,
      dependencies,
      payload: raw.payload
    });
  }
  return {
    ok: true,
    value: {
      changeSetId,
      baseRevision,
      targetIdentities,
      expectedBaseRevisions,
      operations,
      dependencyOrder,
      postconditions,
      conflictPolicy,
      diagnostics
    }
  };
}

function parseSemanticPatchProposalInputs(value: unknown):
  | { ok: true; value: SemanticPatchProposalInput[] }
  | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'proposals 必须是非空数组。' };
  }
  const result: SemanticPatchProposalInput[] = [];
  for (const raw of value) {
    if (!isObjectRecord(raw)) return { ok: false, message: 'proposals 包含无效条目。' };
    const proposal = parsePatchProposalInput(raw.proposal);
    if (!proposal.ok) return proposal;
    const operationIds = asStringList(raw.operationIds);
    if (operationIds.length === 0) return { ok: false, message: '每个 proposal 都需要非空 operationIds。' };
    result.push({ proposal: proposal.value, operationIds });
  }
  return { ok: true, value: result };
}

function parsePatchProposalInput(value: unknown):
  | { ok: true; value: PatchProposal }
  | { ok: false; message: string } {
  if (!isObjectRecord(value)) return { ok: false, message: 'proposal 必须是对象。' };
  const opId = asString(value.opId);
  const workspaceId = asString(value.workspaceId);
  const title = asString(value.title);
  const createdAt = asString(value.createdAt);
  const author = value.author === 'user' || value.author === 'ai' ? value.author : undefined;
  const mode = value.mode === 'plan' || value.mode === 'normal' || value.mode === 'fullPermission'
    ? value.mode
    : undefined;
  if (!opId || !workspaceId || !title || !createdAt || !author || !mode || !Array.isArray(value.changes)) {
    return { ok: false, message: 'proposal 缺少 opId、workspaceId、title、author、mode、createdAt 或 changes。' };
  }
  const changes: PatchProposal['changes'] = [];
  for (const rawChange of value.changes) {
    if (!isObjectRecord(rawChange)) return { ok: false, message: 'proposal.changes 包含无效条目。' };
    const targetUri = asString(rawChange.targetUri);
    const targetPath = asString(rawChange.targetPath);
    const kind = rawChange.kind === 'text' || rawChange.kind === 'binary' || rawChange.kind === 'structured'
      ? rawChange.kind
      : undefined;
    if (!targetUri || !targetPath || !kind) {
      return { ok: false, message: '每个 PatchChange 都需要 targetUri、targetPath、kind。' };
    }
    const layer = rawChange.layer === 'overlay' || rawChange.layer === 'base' ? rawChange.layer : undefined;
    const resourceKind = typeof rawChange.resourceKind === 'string'
      && (ALL_RESOURCE_KINDS as readonly string[]).includes(rawChange.resourceKind)
      ? rawChange.resourceKind as PatchProposal['changes'][number]['resourceKind']
      : undefined;
    changes.push({
      targetUri,
      targetPath,
      kind,
      ...(typeof rawChange.beforeHash === 'string' ? { beforeHash: rawChange.beforeHash } : {}),
      ...(typeof rawChange.afterHash === 'string' ? { afterHash: rawChange.afterHash } : {}),
      ...(typeof rawChange.diff === 'string' ? { diff: rawChange.diff } : {}),
      ...(rawChange.structuredEdit !== undefined ? { structuredEdit: rawChange.structuredEdit } : {}),
      ...(layer ? { layer } : {}),
      ...(resourceKind ? { resourceKind } : {})
    });
  }
  return { ok: true, value: { opId, workspaceId, title, author, mode, changes, createdAt } };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function hasAnyMsbTransform(edit: MsbPartTransformEdit): boolean {
  return MSB_TRANSFORM_FIELDS.some((field) => edit[field] !== undefined);
}

type MapVectorKey = 'position' | 'rotation' | 'scale' | 'positionDelta' | 'rotationDelta' | 'scaleDelta';
type MapVectorResult = { ok: true; value?: [number, number, number] } | { ok: false; message: string };

function readMapVector(record: Record<string, unknown>, key: MapVectorKey): MapVectorResult {
  const raw = record[key];
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || raw.length !== 3 || raw.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return { ok: false, message: `${key} 必须是由 3 个有限数字组成的数组。` };
  }
  return { ok: true, value: [raw[0] as number, raw[1] as number, raw[2] as number] };
}

function readMapEntityId(record: Record<string, unknown>): { ok: true; value?: number } | { ok: false; message: string } {
  if (record.entityId === undefined) return { ok: true };
  if (typeof record.entityId !== 'number' || !Number.isInteger(record.entityId)) {
    return { ok: false, message: 'entityId 必须是整数。' };
  }
  return { ok: true, value: record.entityId };
}

function readMapOptionalName(record: Record<string, unknown>, key: string): { ok: true; value?: string } | { ok: false; message: string } {
  if (record[key] === undefined) return { ok: true };
  if (typeof record[key] !== 'string' || record[key].trim().length === 0) {
    return { ok: false, message: `${key} 必须是非空字符串。` };
  }
  return { ok: true, value: record[key] };
}

function asMapEditOperations(value: unknown): { ok: true; operations: MapEditOperation[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: 'operations 必须是非空数组。' };
  }
  const operations: MapEditOperation[] = [];
  for (const [index, item] of value.entries()) {
    const record = asRecord(item);
    const kind = asString(record.kind);
    const target = asString(record.target);
    if (!kind) return { ok: false, message: `operations[${index}].kind 缺失。` };
    const position = readMapVector(record, 'position');
    const rotation = readMapVector(record, 'rotation');
    const scale = readMapVector(record, 'scale');
    if (!position.ok) return position;
    if (!rotation.ok) return rotation;
    if (!scale.ok) return scale;
    switch (kind) {
      case 'set_transform':
        if (!target) return { ok: false, message: `operations[${index}].target 缺失。` };
        operations.push({
          kind,
          target,
          ...(position.value ? { position: position.value } : {}),
          ...(rotation.value ? { rotation: rotation.value } : {}),
          ...(scale.value ? { scale: scale.value } : {})
        });
        break;
      case 'batch_transform': {
        const targets = asStringList(record.targets);
        const positionDelta = readMapVector(record, 'positionDelta');
        const rotationDelta = readMapVector(record, 'rotationDelta');
        const scaleDelta = readMapVector(record, 'scaleDelta');
        if (targets.length === 0) return { ok: false, message: `operations[${index}].targets 必须是非空字符串数组。` };
        if (!positionDelta.ok) return positionDelta;
        if (!rotationDelta.ok) return rotationDelta;
        if (!scaleDelta.ok) return scaleDelta;
        operations.push({
          kind,
          targets,
          ...(positionDelta.value ? { positionDelta: positionDelta.value } : {}),
          ...(rotationDelta.value ? { rotationDelta: rotationDelta.value } : {}),
          ...(scaleDelta.value ? { scaleDelta: scaleDelta.value } : {})
        });
        break;
      }
      case 'set_property': {
        const property = asString(record.property);
        const valueType = typeof record.value;
        if (!target || !property || !['number', 'string', 'boolean'].includes(valueType)) {
          return { ok: false, message: `operations[${index}] set_property 需要 target、property 和 primitive value。` };
        }
        operations.push({ kind, target, property, value: record.value as number | string | boolean });
        break;
      }
      case 'change_model': {
        const newModelName = asString(record.newModelName);
        if (!target || !newModelName) return { ok: false, message: `operations[${index}] change_model 需要 target 和 newModelName。` };
        operations.push({ kind, target, newModelName });
        break;
      }
      case 'duplicate': {
        const newName = asString(record.newName);
        const modelName = readMapOptionalName(record, 'modelName');
        const entityId = readMapEntityId(record);
        if (!target || !newName) return { ok: false, message: `operations[${index}] duplicate 需要 target 和 newName。` };
        if (!modelName.ok) return modelName;
        if (!entityId.ok) return entityId;
        operations.push({
          kind,
          target,
          newName,
          ...(position.value ? { position: position.value } : {}),
          ...(rotation.value ? { rotation: rotation.value } : {}),
          ...(scale.value ? { scale: scale.value } : {}),
          ...(modelName.value ? { modelName: modelName.value } : {}),
          ...(entityId.value === undefined ? {} : { entityId: entityId.value })
        });
        break;
      }
      case 'create': {
        const template = asString(record.template);
        const newName = asString(record.newName);
        const modelName = readMapOptionalName(record, 'modelName');
        const entityId = readMapEntityId(record);
        if (!template || !newName || record.entityKind !== 'part') {
          return { ok: false, message: `operations[${index}] create 需要 template、newName 和 entityKind=part。` };
        }
        if (!modelName.ok) return modelName;
        if (!entityId.ok) return entityId;
        operations.push({
          kind,
          template,
          newName,
          entityKind: 'part',
          ...(position.value ? { position: position.value } : {}),
          ...(rotation.value ? { rotation: rotation.value } : {}),
          ...(scale.value ? { scale: scale.value } : {}),
          ...(modelName.value ? { modelName: modelName.value } : {}),
          ...(entityId.value === undefined ? {} : { entityId: entityId.value })
        });
        break;
      }
      case 'delete':
        if (!target) return { ok: false, message: `operations[${index}].target 缺失。` };
        operations.push({ kind, target });
        break;
      default:
        return { ok: false, message: `operations[${index}] 使用了不支持的 MapEditOperation kind: ${kind}。` };
    }
  }
  return { ok: true, operations };
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

function asResourceKind(value: unknown): ResourceKind {
  return typeof value === 'string' && ALL_RESOURCE_KINDS.includes(value as ResourceKind)
    ? value as ResourceKind
    : 'unknown';
}

function asMapQueryKind(value: unknown): 'model' | 'part' | 'region' | 'event' | 'route' | undefined {
  return value === 'model' || value === 'part' || value === 'region'
    || value === 'event' || value === 'route'
    ? value
    : undefined;
}

function asCanonicalEntityKind(value: unknown): CanonicalEntityKind | undefined {
  const allowed: readonly CanonicalEntityKind[] = [
    'character', 'item', 'map', 'map_entity', 'map_region', 'action', 'event',
    'param', 'param_row', 'text_entry', 'resource'
  ];
  return typeof value === 'string' && allowed.includes(value as CanonicalEntityKind)
    ? value as CanonicalEntityKind
    : undefined;
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
