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
  TaeEventSymbol,
  NativeEditDomain,
  FieldValueKind
} from '@soulforge/shared';
import {
  assertEditDomain,
  assertWritableField,
  defaultReadSessionManager,
  createOpaqueCursor,
  parseOpaqueCursor,
  parseParamFieldRefs,
  decodeReferenceQueryInput
} from '@soulforge/shared';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { nativeEditSessionFromContext, type NativeEditSession } from '../editing/nativeEditSession.js';
import {
  readParamFields,
  searchParamFieldDefinitions,
  setParamFields,
  type ParamFieldEdit,
  type ParamFieldSnapshot
} from '../param/containerParamEdit.js';
import { readFmgEntries, setFmgEntries, type FmgEntryEdit } from '../editing/fmgEdit.js';
import * as emevdEdit from '../editing/emevdEdit.js';
import { readTaeEvents, setTaeEventFields, setTaeEventTimes } from '../editing/taeEdit.js';
import { listLuabndScripts, readLuabndScript, setLuabndScript } from '../editing/luabndEdit.js';
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
import { retrieveEvidence, type RagChunkExclusionMask } from '../rag/retrieve.js';
import { getRagStaleChunkMaskCached } from '../rag/freshness.js';
import { type MemoryStore } from '../memory/memoryStore.js';
import { EVENT_REFERENCE_SOURCE_URI, searchEventReference } from './eventReference.js';
import { resolveChrLinkage } from '../references/chrLinkageResolver.js';
import { createReferenceQueryService } from '../references/referenceQueryService.js';
import { ProofError, type NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { buildSessionWriteRequirements, LegacyFallbackError } from '../editing/writeRequirements.js';
import { resolveEntity, type EntityRelationRequest } from './entityResolution.js';
import { queryKnowledgeClaims, readKnowledgePage } from '../knowledge/knowledgeQuery.js';
/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

type EmevdEventReadFormat = 'darkscript' | 'json';
type EmevdEventReadCoreInput = {
  edit: ReturnType<typeof nativeEditSessionFromContext>;
  file: string;
  eventId: number;
  format?: EmevdEventReadFormat;
  instructionOffset?: number;
  instructionLimit?: number;
};
type EmevdEventReadCoreResult = {
  ok: boolean;
  [key: string]: unknown;
};
type EmevdEventReadCore = (
  input: EmevdEventReadCoreInput
) => Promise<EmevdEventReadCoreResult>;
function resolveReadEmevdEvent(): EmevdEventReadCore | undefined {
  const candidate = (emevdEdit as unknown as { readEmevdEvent?: unknown }).readEmevdEvent;
  return typeof candidate === 'function' ? candidate as EmevdEventReadCore : undefined;
}

/**
 * Host-resolved identity for one EMEVD event.  This is deliberately not a
 * model-facing field: the registry derives it from the current workspace
 * index and the physical path accepted by the native reader.
 */
export interface HostResolvedEmevdEventTarget {
  resourceKind: 'event';
  sourceUri: string;
  sourcePath: string;
  eventId: number;
  /** False when the resolver had to preserve an unindexed input token. */
  canonical: boolean;
}

export type KnowledgeSourceChange = readonly string[];
export type RagSnapshotScope = 'canonical-param' | 'full';

export interface ToolContext {
  workspaceIndex: WorkspaceIndex | null;
  /** Host-owned identity of the currently active workspace session. */
  workspaceSessionId?: string;
  workspaceSessionGeneration?: number;
  indexedFilesRevision?: number;
  /** Same long-lived host session used by desktop and CLI; no per-call ledger. */
  coreSession?: import('../runtime/coreToolSession.js').CoreToolSession;
  mode: 'plan' | 'normal' | 'fullPermission';
  /**
   * Immutable host grant for this run. `switch_mode` may lower/equal the
   * active mode but can never raise it above this ceiling. When omitted, the
   * initial context mode is the ceiling for backward-compatible hosts.
   */
  modeCeiling?: 'plan' | 'normal' | 'fullPermission';
  /** Agent sessions are read-only with respect to the persistent memory layer. */
  allowMemoryWrite?: boolean;
  /** Optional durable/in-memory RAG corpus. Absent falls back to building from the index. */
  rag?: RagCorpus;
  /** Host-owned native epoch that proves which WorkspaceIndex built the RAG snapshot. */
  ragEpoch?: number;
  /** Host-owned scope of the injected RAG snapshot. Missing provenance is stale. */
  ragScope?: RagSnapshotScope;
  /** Host-owned identity of the session/catalog that produced the RAG snapshot. */
  ragSessionId?: string;
  ragGeneration?: number;
  ragIndexedFilesRevision?: number;
  /** Optional long-term memory store (Codex MEMORY.md persistent layer). */
  memoryStore?: MemoryStore;
  /**
   * 主进程注入的「真实写/回滚」上下文。纯读工具不需要；写级工具（回滚等）
   * 缺省时干净失败（ROLLBACK_CONTEXT_REQUIRED），绝不用内存 store 冒充生产
   * 通道 —— 之前 rollback_operation 只带内存 store 且无 confirmation，恒以
   * EDIT_CONFIRMATION_REQUIRED 失败，属于半成品，本次接通。
   */
  session?: WorkspaceSession;
  /**
   * Long-lived edit session for this subject (T03 step 1). When present,
   * requireEditSession returns it instead of minting a fresh host-handle Map
   * per tool call; read handles then survive across calls of one session.
   */
  editSession?: NativeEditSession;
  operationLogStore?: OperationLogStore;
  backupBaseDir?: string;
  recoveryDir?: string;
  /** 用户对本次具体写操作的确认凭据（main 原生对话框签发，绑定操作 ID）。 */
  confirmation?: ConfirmationReceipt;
  /** Persist/rebuild RAG after a live native read enriches WorkspaceIndex. */
  onSemanticEvidenceUpdated?: (sourceUris?: KnowledgeSourceChange) => Promise<void>;
  /** Invalidate and converge knowledge after a committed native write/rollback. */
  onNativeWriteCommitted?: (changedSources: KnowledgeSourceChange) => Promise<KnowledgeRefreshResult | void>;
  /** Abort the current Agent tool call when the host cancels the run. */
  signal?: AbortSignal;
  /** Curator-only knowledge staging store; never a game resource writer. */
  knowledgeStore?: import('../knowledge/knowledgeStore.js').KnowledgeStore;
  /** Host diagnostic when the durable curator store could not be opened. */
  knowledgeStoreDiagnostic?: string;
  /** Private host target attached by ToolRegistry for the current event call. */
  hostResolvedEmevdEventTarget?: HostResolvedEmevdEventTarget;
  /**
   * Host-owned automatic native-read proof boundary (T09). When present,
   * mutating tools must satisfy requireCoverage() built from the actual write
   * payload before the writer runs. Model-authored verified/proof/searchId
   * fields never populate this store.
   */
  nativeReadProofs?: NativeReadProofStore;
  /** Principal identity for proof scoping (agent run / session subject). */
  proofPrincipal?: string;
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
  /** Non-enumerable host-only target; never included in model-facing data. */
  __hostResolvedEmevdEventTarget?: HostResolvedEmevdEventTarget;
}

type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;

/**
 * Declared input contract: field name -> expected type
 * ('string' | 'number' | 'safe-integer' | 'boolean' | 'array' | 'object'; trailing '?' marks
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
    if (expectedType === 'string[]' && Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          problems.push(`字段 ${key}[${index}] 必须是非空字符串，不能传入对象`);
        }
      });
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
    case 'safe-integer':
      return {
        type: 'integer',
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'array':
      return { type: 'array' };
    case 'string[]':
      return { type: 'array', items: { type: 'string', pattern: '\\S' } };
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
    case 'safe-integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'string[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
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

    const rawEventInput = asRecord(input);
    const hasEventIdentity = typeof rawEventInput.file === 'string'
      && rawEventInput.file.trim() !== ''
      && typeof rawEventInput.eventId === 'number'
      && Number.isSafeInteger(rawEventInput.eventId);
    const hostResolvedEmevdEventTarget = hasEventIdentity && (name === 'read_emevd_event'
      || (name === 'apply_emevd_dsl' && rawEventInput.scope === 'event'))
      ? resolveHostResolvedEmevdEventTarget(context, input)
      : undefined;
    if (hostResolvedEmevdEventTarget && !hostResolvedEmevdEventTarget.ok) {
      return fail(
        hostResolvedEmevdEventTarget.code,
        hostResolvedEmevdEventTarget.message,
        hostResolvedEmevdEventTarget.details
      );
    }
    const resolvedEmevdTarget = hostResolvedEmevdEventTarget?.ok
      ? hostResolvedEmevdEventTarget.target
      : undefined;

    const proofStore = context.nativeReadProofs ?? context.coreSession?.proofStore;
    if (MUTATING_AGENT_TOOLS.has(name) && proofStore) {
      // T09: requirements are derived from the actual writer payload and the
      // host-resolved native identity. A model-supplied ledger/searchId is
      // never consulted. FMG additions may use the explicitly returned
      // container proof as a narrow, host-defined fallback.
      let requirements;
      try {
        requirements = await buildSessionWriteRequirements(
          name,
          input,
          context.session,
          resolvedEmevdTarget
        );
      } catch (error) {
        const code = error instanceof ProofError || error instanceof LegacyFallbackError
          ? (error instanceof ProofError ? error.code : 'NATIVE_READ_REQUIREMENT_UNAVAILABLE')
          : 'NATIVE_READ_REQUIREMENT_UNAVAILABLE';
        return fail(code, error instanceof Error ? error.message : String(error));
      }
      const principal = context.proofPrincipal ?? context.coreSession?.principal ?? 'session';
      const workspaceId = context.workspaceIndex?.workspaceId ?? context.coreSession?.workspaceId ?? '';
      for (const requirement of requirements) {
        const check = (candidate: typeof requirement): void => {
          proofStore.requireCoverage({
            principal,
            workspaceId,
            objectKey: candidate.objectKey,
            outerSourceKey: candidate.outerSourceKey,
            version: {},
            ...(candidate.requiredFields ? { requiredFields: candidate.requiredFields } : {}),
            ...(candidate.requiredShape ? { requiredShape: candidate.requiredShape } : {})
          });
        };
        try {
          check(requirement);
        } catch (error) {
          if (requirement.fallback === undefined) {
            const code = error instanceof ProofError ? error.code : 'NATIVE_READ_REQUIRED';
            return fail(code, error instanceof Error ? error.message : String(error));
          }
          try {
            check(requirement.fallback);
          } catch (fallbackError) {
            const code = fallbackError instanceof ProofError ? fallbackError.code : 'NATIVE_READ_REQUIRED';
            return fail(code, fallbackError instanceof Error ? fallbackError.message : String(fallbackError));
          }
        }
      }
    }

    try {
      const executionContext = resolvedEmevdTarget
        ? { ...context, hostResolvedEmevdEventTarget: resolvedEmevdTarget }
        : context;
      const result = await tool.run(input, executionContext);
      if (resolvedEmevdTarget) {
        // Keep this host-only and non-enumerable: result.data is the only
        // object that can cross the bounded model-facing projection.
        Object.defineProperty(result, '__hostResolvedEmevdEventTarget', {
          value: resolvedEmevdTarget,
          enumerable: false,
          configurable: true
        });
      }
      if (name === 'read_emevd_event'
        && result.ok
        && resolvedEmevdTarget?.canonical !== true
        && result.data
        && typeof result.data === 'object'
        && !Array.isArray(result.data)) {
        const resultData = result.data as Record<string, unknown>;
        const diagnostics = Array.isArray(resultData.diagnostics)
          ? resultData.diagnostics
          : [];
        const warningCode = 'EMEVD_NONCANONICAL_SOURCE_INSPECT_ONLY';
        const nativeDiagnostics = diagnostics.filter((diagnostic) => (
          diagnostic
          && typeof diagnostic === 'object'
          && !Array.isArray(diagnostic)
          && (diagnostic as Record<string, unknown>).code !== warningCode
        ));
        // Keep this diagnostic in the native result data, rather than only
        // in host provenance: projectCompleteNativeEmevdDsl intentionally
        // preserves source diagnostics in the complete model-facing view.
        // Always replace a native same-code item and put the host wording
        // first, so a verbose native list cannot hide or spoof this boundary.
        result.data = {
          ...resultData,
          diagnostics: [
            {
              severity: 'warning',
              code: warningCode,
              message: '当前 file 未直接命中工作区索引的 canonical sourceUri/sourcePath/relativePath/absolutePath；本次 native read 仅供检查，不能生成写回凭据。请使用 search_events 返回的完整 sourceUri 重新读取。'
            },
            ...nativeDiagnostics
          ]
        };
      }
      return result;
    } catch (error) {
      return fail('TOOL_EXCEPTION', error instanceof Error ? error.message : String(error));
    }
  }
}

const MUTATING_AGENT_TOOLS = new Set([
  'commit_patch',
  'mutate_param_fields',
  'mutate_fmg_entries',
  'apply_emevd_dsl',
  'mutate_tae_event_times',
  'mutate_tae_event_fields',
  'mutate_msb_part_transform',
  'mutate_luabnd_script',
  'batch_transform_map_objects',
  'import_map_from_blender'
]);

export type NativePostWriteVerification =
  | { ok: true; details?: unknown }
  | { ok: false; code: string; message: string; details?: unknown };

/**
 * Preserve the irreversible transaction fact even when post-commit work
 * fails.  Knowledge refresh is deliberately best-effort after the Patch
 * Engine has committed; it must never turn the tool into a pre-commit
 * failure.
 */
export async function finalizeCommittedToolResult<T extends object>(input: {
  data: T;
  changedSources: KnowledgeSourceChange;
  context: ToolContext;
  verifyNative?: () => Promise<NativePostWriteVerification>;
  /**
   * Extra proof-store keys to invalidate (e.g. PARAM logical table names the
   * read proof was keyed on, which differ from the container path).
   */
  invalidateProofKeys?: readonly string[];
}): Promise<ToolResult<T & Record<string, unknown>>> {
  let nativeVerification: Record<string, unknown> = { status: 'not_performed' };
  if (input.verifyNative) {
    try {
      const verification = await input.verifyNative();
      nativeVerification = verification.ok
        ? { status: 'verified', ...(verification.details === undefined ? {} : { details: verification.details }) }
        : {
            status: 'failed',
            code: verification.code,
            message: verification.message,
            ...(verification.details === undefined ? {} : { details: verification.details })
          };
    } catch (error) {
      nativeVerification = {
        status: 'failed',
        code: 'POST_COMMIT_NATIVE_READ_EXCEPTION',
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  let knowledgeRefresh: KnowledgeRefreshResult | Record<string, unknown> | undefined;
  let knowledgeRefreshStatus = input.context.onNativeWriteCommitted ? 'completed' : 'not_requested';
  if (input.context.onNativeWriteCommitted) {
    try {
      const refreshed = await input.context.onNativeWriteCommitted(input.changedSources);
      if (refreshed) knowledgeRefresh = refreshed;
      if (knowledgeRefresh && 'status' in knowledgeRefresh && typeof knowledgeRefresh.status === 'string') {
        knowledgeRefreshStatus = knowledgeRefresh.status;
      }
    } catch (error) {
      knowledgeRefreshStatus = 'failed';
      knowledgeRefresh = {
        status: 'failed',
        code: 'KNOWLEDGE_REFRESH_FAILED',
        message: error instanceof Error ? error.message : String(error),
        changedSources: [...input.changedSources]
      };
    }
  }

  const state = nativeVerification.status === 'failed' ? 'verification_failed' : 'committed';
  // T10 steps 12/15: once the outer file has been committed (or rolled back),
  // invalidate the automatic read proofs for every changed source REGARDLESS
  // of whether post-commit verification / knowledge refresh / serialization
  // succeed. A stale-version proof must never authorize a later write; the
  // caller gets a native re-read entry point, not a ledger requirement.
  const proofStore = input.context.nativeReadProofs ?? input.context.coreSession?.proofStore;
  if (proofStore) {
    for (const source of input.changedSources) {
      const generation = Date.now();
      proofStore.invalidateSource(source, generation);
      // Native facades report physical paths while proof identities use the
      // canonical file URL. Invalidate both spellings when no Core session
      // helper is available; a CoreToolSession performs the same fan-out.
      if (isAbsolute(source)) {
        proofStore.invalidateSource(pathToFileURL(source).href, generation);
      }
    }
    if (input.invalidateProofKeys) {
      for (const key of input.invalidateProofKeys) {
        proofStore.invalidateSource(key, Date.now());
      }
    }
  }
  return {
    ok: true,
    state,
    data: {
      ...input.data,
      ...(knowledgeRefresh ? { knowledgeRefresh } : {}),
      lifecycle: {
        transaction: 'committed',
        nativeVerification,
        knowledgeRefresh: knowledgeRefreshStatus
      }
    }
  };
}

async function verifyCommittedParamFields(input: {
  edit: ReturnType<typeof nativeEditSessionFromContext>;
  edits: readonly ParamFieldEdit[];
  expected: readonly ParamFieldSnapshot[];
  containerPath: string;
}): Promise<NativePostWriteVerification> {
  const reread = await readParamFields({
    edit: input.edit,
    containerPath: input.containerPath,
    queries: input.edits.map((edit) => ({
      table: edit.table,
      rowIds: [edit.rowId],
      fieldIds: [edit.fieldId],
      ...(edit.rowIndex === undefined ? {} : { rowIndex: edit.rowIndex })
    }))
  });
  if (!reread.ok) {
    return {
      ok: false,
      code: 'PARAM_POST_COMMIT_READ_FAILED',
      message: reread.error.message,
      details: reread.error.details
    };
  }

  const normalizeTable = (value: string): string => value.toLocaleLowerCase().replace(/[^a-z0-9]/gu, '');
  const mismatches: Array<Record<string, unknown>> = [];
  const verifiedFields: Array<Record<string, unknown>> = [];
  for (const expected of input.expected) {
    const observed = reread.fields.find((field) => (
      normalizeTable(field.table) === normalizeTable(expected.table)
      && field.rowId === expected.rowId
      && field.fieldId === expected.fieldId
      && (expected.rowIndex === undefined || field.rowIndex === expected.rowIndex)
    ));
    if (!observed || !observed.sourceHash || !Object.is(observed.value, expected.value)) {
      mismatches.push({
        table: expected.table,
        rowId: expected.rowId,
        fieldId: expected.fieldId,
        expected: expected.value,
        observed: observed?.value ?? null,
        sourceHash: observed?.sourceHash ?? null
      });
      continue;
    }
    verifiedFields.push({
      table: observed.table,
      rowId: observed.rowId,
      fieldId: observed.fieldId,
      value: observed.value,
      sourceHash: observed.sourceHash,
      ...(observed.sourceRevision === undefined ? {} : { sourceRevision: observed.sourceRevision })
    });
  }
  if (mismatches.length > 0) {
    return {
      ok: false,
      code: 'PARAM_POST_COMMIT_VERIFICATION_MISMATCH',
      message: 'PARAM 已提交，但原生复读值或 sourceHash 与预期不一致；操作保留为 committed，必须回滚或恢复。',
      details: { mismatches }
    };
  }
  return { ok: true, details: { fields: verifiedFields } };
}

export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // T12 step 11: the manual ledger tools read_agent_task_record and
  // update_agent_task_record are removed from the production registry. The
  // automatic native-read proof boundary (T09) replaces the ledger gate; no
  // empty stub is kept to "succeed" for old prompts.

  registry.register({
    name: 'workspace_stats',
    description: 'Return indexed workspace counts for files, symbols, and references.',
    permission: 'read',
    permissionLevel: 'read',
    run: (_input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const stats = ws.getStats();
      const corpus = resolveRagCorpus(context);
      const hasStructuredSymbols = stats.events > 0 || stats.mapEntities > 0 || stats.mapRegions > 0
        || stats.paramRows > 0 || stats.textEntries > 0;
      const readiness = corpus?.availability === 'available'
        ? 'semantic-index-ready'
        : hasStructuredSymbols
          ? 'structured-index-ready'
          : stats.files > 0
            ? 'catalog-ready'
            : 'catalog-empty';
      // Statistics expose coverage counts, not every resource identity. The
      // full source list belongs to resource discovery/native evidence tools.
      const coverage = ws.getCoverageSnapshot().map((item) => ({
        scope: item.scope,
        ...(item.domain ? { domain: item.domain } : {}),
        status: item.status,
        coveredResources: item.coveredResources,
        expectedResources: item.expectedResources,
        staleSourceCount: item.staleSources.length,
        sourceVersionCount: item.sourceVersions.length,
        diagnosticCount: item.diagnostics.length,
        predicateCompleteness: {
          kind: item.predicateCompleteness.kind,
          status: item.predicateCompleteness.status,
          exhaustive: item.predicateCompleteness.exhaustive
        },
        detail: 'summary-only'
      }));
      if (!corpus) return ok({
        ...stats,
        coverage,
        semanticIndex: {
          readiness,
          inMemory: {
            events: stats.events,
            mapEntities: stats.mapEntities,
            mapRegions: stats.mapRegions,
            paramRows: stats.paramRows,
            textEntries: stats.textEntries,
            references: stats.references
          },
          rag: null
        }
      });
      // 轻量索引可能尚未把所有符号投影到内存，但宿主注入的 RAG 快照
      // 仍是带来源的语义语料；不能把内存计数为 0 误报成数据不存在。
      return ok({
        ...stats,
        coverage,
        events: Math.max(stats.events, corpus.stats.byFamily.event),
        mapEntities: Math.max(stats.mapEntities, corpus.stats.byFamily.map_entity),
        mapRegions: Math.max(stats.mapRegions, corpus.stats.byFamily.map_region),
        paramRows: Math.max(stats.paramRows, corpus.stats.byFamily.param_row),
        textEntries: Math.max(stats.textEntries, corpus.stats.byFamily.text_entry),
        references: Math.max(stats.references, corpus.references.length),
        semanticIndex: {
          readiness,
          source: stats.events + stats.mapEntities + stats.mapRegions + stats.paramRows + stats.textEntries > 0
            ? 'workspace-index'
            : 'rag',
          inMemory: {
            events: stats.events,
            mapEntities: stats.mapEntities,
            mapRegions: stats.mapRegions,
            paramRows: stats.paramRows,
            textEntries: stats.textEntries,
            references: stats.references
          },
          rag: {
            ...corpus.stats,
            availability: corpus.availability,
            diagnostics: corpus.diagnostics
          }
        }
      });
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
      const result = retrieveEvidence(corpus, query, {
        limit: asNumber(value.limit, 8),
        ...(value.expandReferences === undefined ? {} : { expandReferences: value.expandReferences === true }),
        ...(families ? { families } : {}),
        ...staleRagChunkOption(context, corpus)
      });
      if (!result.ok) {
        if (result.code === 'insufficient_evidence') return ok({ query, hits: [], totalHits: 0, note: result.message });
        // A stale injected snapshot may be the only semantic body available
        // while the current catalog has already invalidated its source.  The
        // freshness mask intentionally removes those chunks; report an
        // honest empty/partial result instead of turning a known stale source
        // into a retry loop around RAG_UNAVAILABLE.
        if (result.code === 'RAG_UNAVAILABLE'
          && context.rag?.chunks.some((chunk) => chunk.family !== 'file')) {
          return ok({
            query,
            hits: [],
            totalHits: 0,
            status: 'partial',
            diagnostics: corpus?.diagnostics ?? [],
            note: '当前语义快照已因 source revision/hash 失效，未将旧内容作为证据返回。'
          });
        }
        return fail(result.code, result.message);
      }
      return ok(result);
    }
  });

  registry.register({
    name: 'resolve_entity',
    description:
      'Resolve a fuzzy object name or an exact native handle into bounded candidates, identity chains, '
        + 'declared/verified relationship edges, coverage and a next-read plan. Exact handles are checked '
        + 'against current source versions. Fuzzy zero-hit is never proof that an entity does not exist; '
        + 'unregistered numeric joins remain hypotheses and never enter mutation targets.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      query: 'string?',
      handle: 'string?',
      nativeHandle: 'string?',
      domain: 'string?',
      relations: 'array?',
      maxCandidates: 'safe-integer?',
      maxEdges: 'safe-integer?',
      maxSteps: 'safe-integer?'
    },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const query = asOptionalString(value.query)?.trim();
      const handle = asOptionalString(value.handle)?.trim() ?? asOptionalString(value.nativeHandle)?.trim();
      if (!query && !handle) return fail('INVALID_INPUT', 'resolve_entity 需要 query 或 handle/nativeHandle。');
      const relations = asEntityRelations(value.relations);
      const linkageRoot = context.session?.layers.overlayRoot;
      const domain = asOptionalString(value.domain);
      const result = await resolveEntity({
        index: ws,
        ...(query ? { query } : {}),
        ...(handle ? { nativeHandle: handle } : {}),
        ...(domain ? { domain } : {}),
        ...(relations.length > 0 ? { requiredRelations: relations } : {}),
        ...(typeof value.maxCandidates === 'number' ? { maxCandidates: value.maxCandidates } : {}),
        ...(typeof value.maxEdges === 'number' ? { maxEdges: value.maxEdges } : {}),
        ...(typeof value.maxSteps === 'number' ? { maxSteps: value.maxSteps } : {}),
        ...(linkageRoot ? {
          linkageResolver: async (rowId: number) => resolveChrLinkage(rowId, {
            workspaceRoot: linkageRoot,
            ...(context.session?.layers.baseRoot ? { oodleRuntimeRoot: context.session.layers.baseRoot } : {})
          })
        } : {})
      });
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
    description: 'Search parsed native event symbols and instruction names. For exact lookup pass file + eventId; '
      + 'fuzzy queries return candidates and are not a substitute for native reads. For Chinese behavior terms '
      + 'such as 血条、落雷、掉落 or 不攻击, use search_event_reference in parallel, then verify the '
      + 'candidate instruction against this workspace event and EMEDF.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', file: 'string?', eventId: 'number?', limit: 'number?' },
    run: async (input, context) => {
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
        const resolvedFile = resolveIndexedResourceFile(context, file, 'event');
        if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
        const matches = ws.lookupEvents(eventId, resolvedFile.sourceUri).slice(0, limit);
        if (matches.length === 0) {
          return fail('EVENT_NOT_FOUND', `未找到 ${file} 中的 eventId ${eventId}。`);
        }
        return ok(matches);
      }
      const query = asOptionalString(value.query)?.trim();
      if (!query) return fail('INVALID_INPUT', 'search_events 需要 query，或 file + eventId。');
      const nativeResults = ws.searchEvents(query, limit);
      if (nativeResults.length > 0) return ok(nativeResults);

      // The index is a bounded semantic projection and may legitimately lack
      // instruction rows after a fresh mount. For a precise instruction name
      // or numeric ID, cross-file native reading is the authority fallback;
      // Chinese behavior phrases continue through reference/RAG discovery.
      if (emevdEdit.isPreciseEmevdInstructionQuery(query) && context.session) {
        const edit = requireEditSession(context, 'read');
        if ('session' in edit) {
          const nativeSearch = await emevdEdit.searchEmevdInstructionMatches({
            edit: edit.session,
            files: ws.getFiles(),
            query,
            limit,
            ...(context.signal ? { signal: context.signal } : {})
          });
          if (!nativeSearch.ok) {
            return fail(nativeSearch.error.code, nativeSearch.error.message, nativeSearch.diagnostics);
          }
          if (nativeSearch.matches.length > 0 || !nativeSearch.complete) {
            return ok({
              authority: 'native-read-event-search',
              query,
              complete: nativeSearch.complete,
              truncated: nativeSearch.truncated,
              scannedFiles: nativeSearch.scannedFiles,
              scannedEvents: nativeSearch.scannedEvents,
              matches: nativeSearch.matches,
              diagnostics: nativeSearch.diagnostics
            });
          }
        }
      }
      return ragSearchFallback(context, query, ['event'], limit, 'search_events');
    }
  });

  registry.register({
    name: 'search_event_reference',
    description: 'Search the community-maintained Sekiro event-experience glossary by Chinese behavior, English instruction '
      + 'name, or alias. This is a non-authoritative reference map: it guides semantic planning but never proves an instruction exists '
      + 'in the current EMEVD. Always follow with search_events and read_emevd_event using the returned names, '
      + 'file, eventId, and native source evidence.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input) => {
      const value = asRecord(input);
      const query = asString(value.query, '').trim();
      if (!query) return fail('INVALID_INPUT', 'search_event_reference 需要非空 query。');
      const matches = searchEventReference(query, asNumber(value.limit, 20));
      return ok({
        query,
        sourceUri: EVENT_REFERENCE_SOURCE_URI,
        authority: 'community-reference',
        totalHits: matches.length,
        matches,
        note: '社区经验用于语义定位和方案组织；当前事件号、指令签名、参数和写入身份必须由 native EMEVD/EMEDF 复核。'
      });
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
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const nativeResults = ws.searchMapEntities(query, limit);
      return nativeResults.length > 0
        ? ok(nativeResults)
        : ragSearchFallback(context, query, ['map_entity', 'map_region'], limit, 'search_map_entities');
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
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const nativeResults = ws.searchTaeEvents(query, limit);
      return nativeResults.length > 0
        ? ok(nativeResults)
        : ragSearchFallback(context, query, ['tae_event'], limit, 'search_tae_events');
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed PARAM rows by native row name, row id, field id, display name, '
      + 'field description, or value. Use paramNames to search specific tables such as '
      + 'NpcParam, EquipParamGoods, or ItemLotParam. Results are candidates; use '
      + 'read_param_fields for live native values. Example: { query: "鬼庭形部", '
      + 'paramNames: ["NpcParam"] }.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?', paramNames: 'array?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const paramState = typeof ws.getParamSemanticState === 'function' ? ws.getParamSemanticState() : 'ready';
      if (paramState === 'warming_up') {
        return ok({
          status: 'warming_up',
          directive: 'DEFER_PARAM_QUERY',
          state: 'warming_up',
          totalHits: 0,
          hits: [],
          message: '【状态机调度】PARAM 语义索引当前正在后台解包预热中（尚未就绪）。请当前循环暂时跳过参数查询流程，优先执行其他可独立推进的任务（如 MSB 地图分析、EMEVD 事件逻辑校验、任务规划等）；请在下一次循环或后续步骤中再重新查询参数。'
        });
      }
      const value = asRecord(input);
      const paramNames = asStringList(value.paramNames);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const nativeResults = ws.searchParamRows(
        query,
        limit,
        paramNames.length > 0 ? paramNames : undefined
      );
      return nativeResults.length > 0
        ? ok(nativeResults)
        : ragSearchFallback(context, query, ['param_row'], limit, 'search_param_rows', paramNames);
    }
  });

  registry.register({
    name: 'search_param_fields',
    description: 'Search the trusted native PARAM definition for field IDs on an already located table/row. '
      + 'Pass table, non-empty rowIds, and a semantic query such as health/hp, elite/boss, hostile/team/target, '
      + 'lightning/effect, or drop/reward/item. This returns metadata candidates only; use the returned real fieldId '
      + 'in read_param_fields, which requires a non-empty explicit fieldIds array. Do not parse Smithbox XML yourself.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      rowIds: 'array',
      query: 'string',
      limit: 'number?',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const table = asString(value.table);
      const rowIds = asIdList(value.rowIds);
      const query = asString(value.query);
      if (!table || rowIds.length === 0 || !query.trim()) {
        return fail('PARAM_FIELD_QUERY_REQUIRED', 'search_param_fields 需要 table、非空 rowIds 和 query。');
      }
      const containerPath = asOptionalString(value.containerPath);
      const result = await searchParamFieldDefinitions({
        edit: edit.session,
        table,
        rowIds,
        query,
        ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return ok(result);
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed MSG/FMG text entries by visible text or text id. '
      + 'Use this in parallel with search_param_rows when resolving a character or item; '
      + 'textId is not automatically a PARAM rowId.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string', limit: 'number?' },
    run: (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const nativeResults = ws.searchTextEntries(query, limit);
      return nativeResults.length > 0
        ? ok(nativeResults)
        : ragSearchFallback(context, query, ['text_entry'], limit, 'search_text_entries');
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
    description: 'Find evidence-graph references connected to a target. Provide exactly one of '
      + 'uri (logical symbol uri), target (precise native selector, e.g. '
      + '{domain:"param",sourceUri,entryIndex,rowId} / {domain:"emevd",sourceUri,eventId}) or '
      + 'query (delegated to resolveEntity). Optional: direction (from|to|both), detail '
      + '(edges|context), fieldIds (param root only), depth (1-4), limit (1-32), '
      + 'includeHypotheses, cursor (host-issued continuation only).',
    permission: 'analyze',
    permissionLevel: 'analyze',
    inputSchema: {
      uri: 'string?',
      target: 'object?',
      query: 'string?',
      domain: 'string?',
      direction: 'enum:from|to|both?',
      detail: 'enum:edges|context?',
      fieldIds: 'array?',
      depth: 'number?',
      limit: 'number?',
      includeHypotheses: 'boolean?',
      cursor: 'string?'
    },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const decoded = decodeReferenceQueryInput(input);
      if (!decoded.ok) return fail(decoded.code, decoded.message);
      const service = createReferenceQueryService({
        bundle: ws.toSymbolBundle(),
        workspaceId: ws.workspaceId,
        coverageStates: ws.getCoverageSnapshot(),
        providerRegistryDigest: 'soulforge-reference-providers-v1',
        resolveQuery: async (query, domain) => {
          const resolved = await resolveEntity({
            index: ws,
            query,
            ...(domain ? { domain: domain as never } : {}),
            maxCandidates: 8
          });
          if (resolved.status === 'ambiguous' || resolved.candidates.length > 1) {
            return {
              resolution: 'ambiguous' as const,
              candidates: resolved.candidates.slice(0, 8).map((candidate) => ({
                uri: candidate.sourceUri ?? candidate.nativeHandle,
                label: candidate.label ?? candidate.nativeHandle,
                discriminators: { nativeHandle: candidate.nativeHandle, route: candidate.route }
              }))
            };
          }
          if (resolved.status === 'resolved' && resolved.candidates.length === 1) {
            const candidate = resolved.candidates[0]!;
            return { resolution: 'resolved' as const, uri: candidate.sourceUri ?? candidate.nativeHandle };
          }
          return {
            resolution: resolved.status === 'not_found' || resolved.status === 'not_found_complete_coverage'
              ? 'not_found' as const : 'insufficient_evidence' as const
          };
        }
      });
      try {
        const page = await service.query(input as Parameters<typeof service.query>[0]);
        return ok(page);
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code : 'REFERENCE_QUERY_FAILED';
        return fail(code, (error as Error).message ?? '关联查询失败。');
      }
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
      const outline = await emevdEdit.readEmevdOutline({ edit: edit.session, file: indexedFile.absolutePath });
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
          authority: 'native-read-outline',
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
        markdown: `# Event ${eventId}\n\n- authority: native-read-outline\n- instructionCount: ${row.instructionCount}\n- restBehavior: ${row.restBehavior}\n- diagnostics: EMEDF 参数尚未解码，引用结论不可用。`,
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
    description: 'Project a full PatchProposal into the graph patch IR for review.',
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
      + 'Pass table, row ids, and a non-empty explicit fieldIds array on every call; '
      + 'omitting fieldIds or passing an empty array is rejected to prevent unbounded row payloads. '
      + 'Copy each returned fieldId, rowIndex, and dataHash into the matching write edit; '
      + 'the physical rowIndex is required when the read returned it. '
      + 'Do not parse Smithbox XML or unpack BND yourself. Use the same explicit field ids for writes.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      table: 'string',
      rowIds: 'array',
      fieldIds: 'array',
      containerPath: 'string?',
      cursor: 'string?'
    },
    run: async (input, context) => {
      const value = asRecord(input);
      const table = asString(value.table);
      const rowIds = asIdList(value.rowIds);
      const fieldIds = asStringList(value.fieldIds);
      if (!table || rowIds.length === 0 || fieldIds.length === 0) {
        return fail('PARAM_FIELD_IDS_REQUIRED', 'read_param_fields 必须提供 table、非空 rowIds 和非空 fieldIds；请先从候选或元数据中确认真实字段 ID。');
      }
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const containerPath = asOptionalString(value.containerPath);
      const result = await readParamFields({
        edit: edit.session,
        queries: [{ table, rowIds, fieldIds }],
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      // T09 step 3: the automatic proof is confirmed by the bridge AFTER the
      // bounded projection is delivered (createAgentToolBridge), not promoted
      // here from the raw tool result.
      if (context.workspaceIndex && result.fields.length > 0) {
        const sourceUri = pathToFileURL(result.containerPath).href;
        // Physical identity: entry + rowIndex + rowId. A PARAM table can hold
        // duplicate logical row ids; bucketing by rowId alone merged distinct
        // physical rows into one projection.
        type FieldSnapshot = typeof result.fields[number];
        const rowsByPhysicalKey = new Map<string, { rowId: number; rowIndex?: number; dataHash?: string; entryName?: string; entryIndex?: number; rowName?: string; fields: FieldSnapshot[] }>();
        for (const field of result.fields) {
          const key = `${field.entryIndex ?? '?'}\u0000${field.entryName ?? field.table}\u0000${field.rowId}\u0000${field.rowIndex ?? '?'}`;
          const bucket = rowsByPhysicalKey.get(key);
          if (bucket) {
            bucket.fields.push(field);
          } else {
            rowsByPhysicalKey.set(key, {
              rowId: field.rowId,
              ...(field.rowIndex !== undefined ? { rowIndex: field.rowIndex } : {}),
              ...(field.dataHash ? { dataHash: field.dataHash } : {}),
              ...(field.entryName ? { entryName: field.entryName } : {}),
              ...(field.entryIndex !== undefined ? { entryIndex: field.entryIndex } : {}),
              ...(field.rowName ? { rowName: field.rowName } : {}),
              fields: [field]
            });
          }
        }
        const provenanceFor = (fields: FieldSnapshot[]): { sourceHash?: string; sourceRevision?: number } => {
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
          rows: [...rowsByPhysicalKey.values()].map((bucket) => ({
            // Duplicate physical rows must stay addressable: append the
            // physical rowIndex to the URI when the native read provided one.
            uri: `${sourceUri}#${table}/${bucket.rowId}${bucket.rowIndex === undefined ? '' : `@${bucket.rowIndex}`}`,
            sourceUri,
            paramName: table,
            ...(bucket.entryName ? { entryName: bucket.entryName } : {}),
            ...(bucket.entryIndex !== undefined ? { entryIndex: bucket.entryIndex } : {}),
            rowId: bucket.rowId,
            ...(bucket.rowIndex === undefined ? {} : { rowIndex: bucket.rowIndex }),
            ...(bucket.dataHash ? { dataHash: bucket.dataHash } : {}),
            ...(bucket.rowName ? { rowName: bucket.rowName } : {}),
            ...provenanceFor(bucket.fields),
            fields: bucket.fields.map((field) => {
              const parsedRefs = field.refs ? parseParamFieldRefs(field.refs) : undefined;
              return {
                ...(field.fieldId ? { fieldId: field.fieldId } : {}),
                name: field.displayName ?? field.fieldId,
                ...(field.description ? { description: field.description } : {}),
                value: field.value,
                // Trusted-metadata provenance only: the refs string came from
                // the same native document read as the row bytes.
                ...(parsedRefs && parsedRefs.targets.length > 0 ? { refs: parsedRefs.targets, refsProvenance: 'trusted-metadata' as const } : {}),
                ...(parsedRefs && parsedRefs.rejected.length > 0 ? { refsRejected: parsedRefs.rejected, refsProvenance: 'trusted-metadata' as const } : {})
              };
            })
          }))
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      // T12 step 8: reading NpcParam no longer auto-attaches a crossReferences
      // web. Related context is obtained explicitly via find_references
      // (detail=context) or resolve_entity, so a plain field read stays light.
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_param_fields',
    description: 'Set absolute PARAM field values through Patch Engine (write-param + write-bnd4). '
      + 'edits: [{ table, rowId, rowIndex, fieldId, expectedDataHash, value }]; copy rowIndex and dataHash '
      + 'from the latest read when present, and pass the returned containerPath when available. Never multiply current values. '
      + 'Do not parse Smithbox XML, scan BND, or write file_replace by hand.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      edits: 'array',
      containerPath: 'string?'
    },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.domain && value.domain !== 'param') {
        return fail('DOMAIN_CROSSOVER_REJECTED', `PARAM 写入工具不能接收 ${value.domain} 领域的请求。`);
      }
      if (value.fieldKind && value.fieldKind !== 'native_value') {
        return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 PARAM。`);
      }
      const edits = asParamEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      for (const e of edits.edits) {
        if (/^m\d\d_/i.test(e.table) || /^c\d\d/i.test(e.table) || /#A\d\d/i.test(e.table)) {
          return fail('DOMAIN_CROSSOVER_REJECTED', `PARAM 写入工具不能接收地图或 TAE 目标：${e.table}`);
        }
        const record = e as unknown as Record<string, unknown>;
        if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
          return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 PARAM 原生字段写入。');
        }
      }
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const containerPath = asOptionalString(value.containerPath);
      const result = await setParamFields({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      if (result.changedTables.length === 0) return ok(result);
      return finalizeCommittedToolResult({
        data: result,
        changedSources: [result.containerPath],
        // Read proofs are keyed on the logical table name (the same value the
        // write requirement carries); the container path alone would leave the
        // stale per-table proofs usable after a commit.
        invalidateProofKeys: result.changedTables,
        context,
        verifyNative: () => verifyCommittedParamFields({
          edit: edit.session,
          edits: edits.edits,
          expected: result.after,
          containerPath: result.containerPath
        })
      });
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
      lang: 'string?',
      cursor: 'string?'
    },
    run: async (input, context) => {
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
            text: entry.text ?? '',
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
      const value = asRecord(input);
      if (value.domain && value.domain !== 'fmg') {
        return fail('DOMAIN_CROSSOVER_REJECTED', `FMG 写入工具不能接收 ${value.domain} 领域的请求。`);
      }
      if (value.fieldKind && value.fieldKind !== 'native_value') {
        return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 FMG。`);
      }
      const edits = asFmgEdits(value.edits);
      if (!edits.ok) return fail(edits.code, edits.message);
      for (const e of edits.edits) {
        if (/^m\d\d_/i.test(e.table) || /^c\d\d/i.test(e.table) || /#c\d\d/i.test(e.table) || /#A\d\d/i.test(e.table)) {
          return fail('DOMAIN_CROSSOVER_REJECTED', `FMG 写入工具不能接收地图或 TAE 目标：${e.table}`);
        }
        const record = e as unknown as Record<string, unknown>;
        if (record.valueKind === 'display_label' || record.fieldId === 'displayLabel') {
          return fail('FIELD_KIND_NON_NATIVE', 'display_label 是界面显示标签，不能作为 FMG 原生文本写入。');
        }
        if (record.valueKind === 'external_metadata' || record.fieldId === 'externalMetadata') {
          return fail('FIELD_KIND_NON_NATIVE', 'external_metadata 是外部元数据，不能作为 FMG 原生文本写入。');
        }
      }
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const containerPath = asOptionalString(value.containerPath);
      const lang = asOptionalString(value.lang);
      const result = await setFmgEntries({
        edit: edit.session,
        edits: edits.edits,
        ...(containerPath ? { containerPath } : {}),
        ...(lang ? { lang } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.error.details);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.containerPath], context });
    }
  });

  registry.register({
    name: 'read_emevd_event',
    description: 'Read exactly one EMEVD event through the native core readEmevdEvent authority. '
      + 'A complete format=darkscript read from instructionOffset=0 through the native total returns data.record.projection=complete_native_dsl: '
      + 'the full DarkScript, native evidence/provenance and native identity are retained while auxiliary machine DTO is omitted; this is the only event read view that can mint a write receipt. '
      + 'Use format=json or instructionOffset/instructionLimit paging when machine instructions are needed, but JSON, tail, partial, or incomplete windows remain inspect-only and cannot authorize event writes. '
      + 'If file does not directly match an indexed sourceUri/sourcePath/relativePath/absolutePath, the native read may still succeed as inspect-only and cannot mint a write receipt; use search_events to obtain the complete sourceUri and reread. '
      + 'It never uses RAG or an index projection as a native-read substitute. format defaults to darkscript.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      file: 'string',
      eventId: 'safe-integer',
      format: 'enum:darkscript|json?',
      instructionOffset: 'safe-integer?',
      instructionLimit: 'safe-integer?',
      cursor: 'string?'
    },
    run: async (input, context) => {
      const value = asRecord(input);
      const file = asString(value.file).trim();
      const eventId = typeof value.eventId === 'number' && Number.isSafeInteger(value.eventId)
        ? value.eventId
        : undefined;
      if (!file || eventId === undefined) {
        return fail('INVALID_INPUT', 'read_emevd_event 需要 file 与安全整数 eventId。');
      }
      if (!context.session) return fail('WORKSPACE_REQUIRED', '这次原生 EMEVD 事件读取需要先打开 Mod 工作区。');
      const resolvedFile = context.hostResolvedEmevdEventTarget
        ? {
            ok: true as const,
            path: context.hostResolvedEmevdEventTarget.sourcePath,
            sourceUri: context.hostResolvedEmevdEventTarget.sourceUri,
            canonical: context.hostResolvedEmevdEventTarget.canonical
          }
        : resolveIndexedResourceFile(context, file, 'event');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const nativeFile = context.hostResolvedEmevdEventTarget?.sourcePath
        ?? nativePathFromFileToken(resolvedFile.path);
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const reader = resolveReadEmevdEvent();
      if (!reader) {
        return fail(
          'EMEVD_EVENT_READ_UNAVAILABLE',
          '当前核心尚未提供 readEmevdEvent 原生事件读取门面，已拒绝用索引或 RAG 结果冒充 native read。',
          { authority: 'core.readEmevdEvent', file, eventId }
        );
      }
      const format = value.format === undefined ? undefined : value.format as EmevdEventReadFormat;
      const instructionOffset = value.instructionOffset === undefined
        ? undefined
        : typeof value.instructionOffset === 'number' && Number.isSafeInteger(value.instructionOffset)
          ? value.instructionOffset
          : undefined;
      const instructionLimit = value.instructionLimit === undefined
        ? undefined
        : typeof value.instructionLimit === 'number' && Number.isSafeInteger(value.instructionLimit)
          ? value.instructionLimit
          : undefined;
      if (value.instructionOffset !== undefined && instructionOffset === undefined) {
        return fail('INVALID_INPUT', 'instructionOffset 必须是安全整数。');
      }
      if (value.instructionLimit !== undefined && instructionLimit === undefined) {
        return fail('INVALID_INPUT', 'instructionLimit 必须是安全整数。');
      }
      const result = await reader({
        edit: edit.session,
        file: nativeFile,
        eventId,
        ...(format ? { format } : {}),
        ...(instructionOffset !== undefined ? { instructionOffset } : {}),
        ...(instructionLimit !== undefined ? { instructionLimit } : {}),
        ...(context.signal ? { signal: context.signal } : {})
      });
      if (!result.ok) {
        const error = asRecord(result.error);
        return fail(
          asString(error.code, 'EMEVD_EVENT_READ_FAILED'),
          asString(error.message, 'EMEVD 事件读取失败。'),
          result.diagnostics
        );
      }
      const resultRecord = result as Record<string, unknown>;
      // Bind the model-facing/native receipt to the workspace-indexed URI.
      // The facade's URI is derived from its physical path and may otherwise
      // contain a sanitized-but-user-specific path rather than the canonical
      // resource identity used by search_events.
      const canonicalSourceUri = context.hostResolvedEmevdEventTarget?.sourceUri
        ?? resolvedFile.sourceUri;
      const provenance = {
        ...(asRecord(resultRecord.provenance)),
        authority: 'native-emevd-event',
        sourceUri: canonicalSourceUri,
        ...(typeof resultRecord.sourceHash === 'string' ? { sourceHash: resultRecord.sourceHash } : {}),
        ...(typeof resultRecord.sourceRevision === 'number' || typeof resultRecord.sourceRevision === 'string'
          ? { sourceRevision: resultRecord.sourceRevision }
          : {}),
        ...(typeof resultRecord.registryFingerprint === 'string'
          ? { registryFingerprint: resultRecord.registryFingerprint }
          : {})
      };
      return ok({ ...resultRecord, sourceUri: canonicalSourceUri, provenance });
    }
  });

  registry.register({
    name: 'read_emevd_outline',
    description: 'Read event IDs and instruction counts from an overlay EMEVD file. '
      + 'Pass offset (default 0) and limit (default 8, maximum 16) to page through all events using nextOffset. '
      + 'The outline is read-only metadata, not a complete DarkScript write receipt. '
      + 'Does not parse a second native format; uses Bridge read-emevd-document.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', offset: 'safe-integer?', limit: 'safe-integer?' },
    run: async (input, context) => {
      const value = asRecord(input);
      const offset = value.offset ?? 0;
      const limit = value.limit ?? 8;
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0
        || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 16) {
        return fail('INVALID_INPUT', 'read_emevd_outline 的 offset 必须是非负安全整数，limit 必须是 1 到 16 的安全整数。');
      }
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'read_emevd_outline 需要 file。');
      const resolvedFile = resolveIndexedResourceFile(context, file, 'event');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await emevdEdit.readEmevdOutline({
        edit: edit.session,
        file: nativePathFromFileToken(resolvedFile.path)
      });
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
              authority: 'native-read-outline',
              instructionCount: event.instructionCount,
              restBehavior: event.restBehavior,
              semanticArgsDecoded: false
            }
          }))
        });
        context.workspaceIndex.rebuildReferences();
        await context.onSemanticEvidenceUpdated?.([sourceUri]);
      }
      // The index above always consumes the complete native outline. Only the
      // model-facing result is paged; no event disappears from future windows.
      const allEvents = result.events ?? [];
      const events = allEvents.slice(offset, offset + limit);
      const truncated = offset + events.length < allEvents.length;
      return ok({
        ...result,
        events,
        total: allEvents.length,
        totalCount: allEvents.length,
        offset,
        limit,
        returned: events.length,
        returnedCount: events.length,
        truncated,
        darkScriptComplete: false,
        ...(truncated ? {
          nextOffset: offset + events.length,
          continuationParams: { file, offset: offset + events.length, limit }
        } : {})
      });
    }
  });

  registry.register({
    name: 'apply_emevd_dsl',
    description: 'Compile and commit EMEVD DSL through the native Bridge four-view path. '
      + '完整文件模式 scope=file 可提交文件内 DSL；event-only 模式 scope=event 必须同时给出安全整数 eventId，核心只允许该事件作用域，禁止误删其他事件。'
      + ' event-scope 还必须回传最近一次完整 read_emevd_event 的 sourceHash、outerFileHash、sourceRevision 与 darkScriptComplete=true；读取必须是 offset=0 到 native total 的完整 darkscript 事件视图，底层会做 source identity CAS。JSON、tail、分页或缺少任一 identity 字段都不能写回。'
      + ' The DSL is not a binary text patch; unknown/ambiguous parameter bindings and invalid scope inputs fail closed.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      dsl: 'string',
      mode: 'enum:patch|dark-script?',
      eventId: 'safe-integer?',
      scope: 'enum:file|event?',
      sourceHash: 'string?',
      outerFileHash: 'string?',
      sourceRevision: 'number?',
      darkScriptComplete: 'boolean?'
    },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.emedfPath !== undefined || value.emedfLocator !== undefined) {
        return fail(
          'EMEVD_EXTERNAL_SCHEMA_FORBIDDEN',
          '生产 EMEVD 链不接受外部 EMEDF schema；请使用 SoulForge 内置 schema。'
        );
      }
      const file = asString(value.file).trim();
      const dsl = asString(value.dsl);
      if (!file || !dsl.trim()) return fail('INVALID_INPUT', 'apply_emevd_dsl 需要 file 与非空 dsl。');
      const scope = value.scope === undefined ? 'file' : value.scope as 'file' | 'event';
      const eventId = value.eventId;
      const safeEventId = typeof eventId === 'number' && Number.isSafeInteger(eventId) ? eventId : undefined;
      if (eventId !== undefined && safeEventId === undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的 eventId 必须是安全整数。');
      }
      if (scope === 'event' && safeEventId === undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的 scope=event 必须同时提供 eventId。');
      }
      if (scope === 'file' && safeEventId !== undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的完整文件模式不能带 eventId；请使用 scope=event。');
      }
      const sourceHash = asOptionalString(value.sourceHash);
      const outerFileHash = asOptionalString(value.outerFileHash);
      const sourceRevision = value.sourceRevision === undefined
        ? undefined
        : asNumber(value.sourceRevision, Number.NaN);
      const darkScriptComplete = value.darkScriptComplete === undefined
        ? undefined
        : typeof value.darkScriptComplete === 'boolean'
          ? value.darkScriptComplete
          : undefined;
      if (value.sourceHash !== undefined && sourceHash === undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的 sourceHash 必须是非空字符串。');
      }
      if (value.outerFileHash !== undefined && outerFileHash === undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的 outerFileHash 必须是非空字符串。');
      }
      if (value.darkScriptComplete !== undefined && darkScriptComplete === undefined) {
        return fail('INVALID_INPUT', 'apply_emevd_dsl 的 darkScriptComplete 必须是布尔值。');
      }
      if (scope === 'event' && (
        sourceHash === undefined
        || outerFileHash === undefined
        || sourceRevision === undefined
        || !Number.isFinite(sourceRevision)
        || darkScriptComplete !== true
      )) {
        return fail(
          'EMEVD_DSL_READ_RECEIPT_REQUIRED',
          `event-scope 写回必须携带最近一次完整 read_emevd_event 的 sourceHash、outerFileHash、sourceRevision 与 darkScriptComplete=true；当前缺少或不满足：${[
            sourceHash === undefined ? 'sourceHash' : null,
            outerFileHash === undefined ? 'outerFileHash' : null,
            sourceRevision === undefined || !Number.isFinite(sourceRevision) ? 'sourceRevision' : null,
            darkScriptComplete !== true ? 'darkScriptComplete=true' : null
          ].filter((item): item is string => item !== null).join('、') || '完整 native DarkScript 视图'}。`
        );
      }
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const resolvedFile = context.hostResolvedEmevdEventTarget
        ? {
            ok: true as const,
            path: context.hostResolvedEmevdEventTarget.sourcePath,
            sourceUri: context.hostResolvedEmevdEventTarget.sourceUri,
            canonical: context.hostResolvedEmevdEventTarget.canonical
          }
        : resolveIndexedResourceFile(context, file, 'event');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const mode = value.mode === 'dark-script' ? 'dark-script' : 'patch';
      const applyInput: Parameters<typeof emevdEdit.applyEmevdDsl>[0] = {
        edit: edit.session,
        file: context.hostResolvedEmevdEventTarget?.sourcePath
          ?? nativePathFromFileToken(resolvedFile.path),
        dsl,
        mode,
        ...(safeEventId === undefined ? {} : { eventId: safeEventId }),
        ...(scope === 'event' && safeEventId !== undefined
          ? { scope: { eventId: safeEventId } }
          : {}),
        ...(sourceHash ? { sourceHash } : {}),
        ...(outerFileHash ? { outerFileHash } : {}),
        ...(sourceRevision !== undefined ? { sourceRevision } : {}),
        ...(darkScriptComplete !== undefined ? { darkScriptComplete } : {})
      };
      const result = await emevdEdit.applyEmevdDsl(applyInput);
      if (!result.ok) return fail(result.error?.code ?? 'EMEVD_DSL_FAILED', result.error?.message ?? 'EMEVD DSL 提交失败。', result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath ?? file], context });
    }
  });

  registry.register({
    name: 'read_tae_events',
    description: 'Read native TAE event times and decoded fields by exact action address. '
      + 'Use cXXXX#AXXXX.eN addresses; omitted addresses return the bounded native event projection.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?', cursor: 'string?', pageSize: 'number?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'read_tae_events 需要 file。');
      const addresses = value.addresses === undefined ? [] : asStringList(value.addresses);
      const cursor = value.cursor === undefined ? undefined : asString(value.cursor).trim();
      if (value.cursor !== undefined && !cursor) return fail('INVALID_INPUT', 'read_tae_events 的 cursor 必须是非空 opaque token。');
      const pageSize = value.pageSize === undefined ? undefined : asNumber(value.pageSize, 32);
      // search_resources returns the indexed source URI for ACTION containers
      // (for example file://chr/c7100.anibnd.dcx), while the TAE facade needs
      // the current workspace's physical overlay path.  Resolve only this
      // read path through the existing catalog boundary; mutation remains on
      // its legacy resolver and base/read permissions stay unchanged.
      const resolvedFile = resolveIndexedResourceFile(context, file, 'chr');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await readTaeEvents({
        edit: edit.session,
        file: nativePathFromFileToken(resolvedFile.path),
        ...(addresses.length > 0 ? { addresses } : {}),
        ...(cursor ? { cursor } : {}),
        ...(pageSize === undefined ? {} : { pageSize })
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      if (context.workspaceIndex) {
        // Keep the catalog identity returned by search_resources when the
        // resolver selected a canonical indexed file.  For legacy relative /
        // absolute / bare tokens that remain unindexed, preserve the previous
        // physical-path identity derived from the successful native read.
        const sourceUri = resolvedFile.canonical === true
          ? resolvedFile.sourceUri
          : pathToFileURL(result.filePath).href;
        const sourceFile = context.workspaceIndex.getFile(sourceUri);
        const sourceHash = result.sourceHash;
        const sourceRevision = sourceFile?.mtimeMs;
        // 同一 TAE source 内不同 section 可以复用 animId；不能按裸数字合并，
        // 否则 AI 看到的事件会跨 a00/a50 串线。
        const animations = new Map<string, TaeAnimSymbol>();
        for (const event of result.events) {
          const animationKey = `${event.taeEntryIndex ?? event.taeEntryId ?? event.taeEntryName ?? 'tae'}:${event.animId}`;
          const animation = animations.get(animationKey) ?? {
            animId: event.animId,
            code: event.code,
            ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex }),
            ...(event.taeEntryId === undefined ? {} : { taeEntryId: event.taeEntryId }),
            ...(event.taeEntryName === undefined ? {} : { taeEntryName: event.taeEntryName }),
            ...(event.taeGroup === undefined ? {} : { taeGroup: event.taeGroup }),
            events: [] as TaeEventSymbol[]
          };
          animation.events.push({
            uri: event.uri,
            index: event.eventIndex,
            eventTypeId: event.eventTypeId,
            ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex }),
            ...(event.taeEntryId === undefined ? {} : { taeEntryId: event.taeEntryId }),
            ...(event.taeEntryName === undefined ? {} : { taeEntryName: event.taeEntryName }),
            ...(event.taeGroup === undefined ? {} : { taeGroup: event.taeGroup }),
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
          animations.set(animationKey, animation);
        }
        context.workspaceIndex.upsertTaeExport({
          chrId: result.chrId,
          sourceUri,
          ...(sourceHash ? { sourceHash } : {}),
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          ...(result.taeEntryCount !== undefined ? { taeEntryCount: result.taeEntryCount } : {}),
          ...(result.taeEntries ? { taeEntries: result.taeEntries } : {}),
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
      const value = asRecord(input);
      if (value.domain && value.domain !== 'tae') {
        return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具不能接收 ${value.domain} 领域的请求。`);
      }
      if (value.fieldKind && value.fieldKind !== 'native_value') {
        return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 TAE。`);
      }
      const file = asString(value.file);
      const edits = asTaeTimeEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_tae_event_times 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      for (const e of edits.edits) {
        if (/^m\d\d_/i.test(e.address) || !/^[a-z0-9_]+#A/i.test(e.address)) {
          return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具只能接收 TAE 动作事件地址（如 cXXXX#AXXXX.eN），不能接收地图或其它领域地址：${e.address}`);
        }
        const record = e as unknown as Record<string, unknown>;
        if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
          return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 TAE 原生时间写入。');
        }
      }
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const result = await setTaeEventTimes({ edit: edit.session, file, edits: edits.edits });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context });
    }
  });

  registry.register({
    name: 'mutate_tae_event_fields',
    description: 'Set first-party decoded TAE event fields by exact action address through Patch Engine. '
      + 'Use fieldIndex for stable schema fields or fieldName for named fields; padding/assert fields are rejected.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.domain && value.domain !== 'tae') {
        return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 写入工具不能接收 ${value.domain} 领域的请求。`);
      }
      const file = asString(value.file);
      const edits = asTaeFieldEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_tae_event_fields 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      for (const edit of edits.edits) {
        if (/^m\d\d_/i.test(edit.address) || !/^[a-z0-9_]+#A/i.test(edit.address)) {
          return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 字段写入工具只能接收 TAE 动作事件地址：${edit.address}`);
        }
      }
      const session = requireEditSession(context, 'write');
      if (!('session' in session)) return session;
      const result = await setTaeEventFields({ edit: session.session, file, edits: edits.edits });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context });
    }
  });

  registry.register({
    name: 'list_luabnd_scripts',
    description: 'List all Lua AI scripts inside a *.luabnd.dcx container (such as script/m11_01_00_00.luabnd.dcx or script/aicommon.luabnd.dcx). '
      + 'Returns script filenames (e.g. 540000_battle.lua for Genichiro, 508000_battle.lua for Gyoubu) to identify the target AI script before calling read_luabnd_script.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      file: 'string'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'list_luabnd_scripts ��Ҫ file��');
      const result = await listLuabndScripts({ edit: edit.session, file });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return ok(result);
    }
  });

  registry.register({
    name: 'read_luabnd_script',
    description: 'Read a native Lua AI script inside a *.luabnd.dcx container (such as script/m11_01_00_00.luabnd.dcx or aicommon.luabnd.dcx). '
      + 'file: relative or absolute path (e.g. script/m11_01_00_00.luabnd.dcx); childPath: script name (e.g. 540000_battle.lua; omit to list scripts). '
      + 'Returns script bytecode/text status, embedded symbols/action list (Act01, Interupt_Use_Item, etc.), and script preview.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      file: 'string',
      childPath: 'string?',
      expectedContainerHash: 'string?',
      expectedChildHash: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const childPath = asOptionalString(value.childPath);
      if (!file) return fail('INVALID_INPUT', 'read_luabnd_script ��Ҫ file��');
      const expectedContainerHash = asOptionalString(value.expectedContainerHash);
      const expectedChildHash = asOptionalString(value.expectedChildHash);
      const result = await readLuabndScript({
        edit: edit.session,
        file,
        ...(childPath ? { childPath } : {}),
        ...(expectedContainerHash ? { expectedContainerHash } : {}),
        ...(expectedChildHash ? { expectedChildHash } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_luabnd_script',
    description: 'Modify or replace a Lua AI script inside a *.luabnd.dcx container through Patch Engine. '
      + 'file: path to luabnd container; childPath: target script (e.g. 540000_battle.lua); '
      + 'text: new script text (for plain text or decompiled edits); contentBase64: raw bytes or compiled bytecode. '
      + 'Preserves BND4 container structure, signatures, and layout via Bridge writer.',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: {
      file: 'string',
      childPath: 'string',
      text: 'string?',
      contentBase64: 'string?',
      expectedContainerHash: 'string?',
      expectedChildHash: 'string?'
    },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      const childPath = asString(value.childPath);
      if (!file || !childPath) return fail('INVALID_INPUT', 'mutate_luabnd_script ��Ҫ file �� childPath��');
      const text = asOptionalString(value.text);
      const contentBase64 = asOptionalString(value.contentBase64);
      if (text === undefined && contentBase64 === undefined) {
        return fail('INVALID_INPUT', 'mutate_luabnd_script ��Ҫ text �� contentBase64��');
      }
      const expectedContainerHash = asOptionalString(value.expectedContainerHash);
      const expectedChildHash = asOptionalString(value.expectedChildHash);
      const result = await setLuabndScript({
        edit: edit.session,
        file,
        childPath,
        ...(text !== undefined ? { text } : {}),
        ...(contentBase64 !== undefined ? { contentBase64 } : {}),
        ...(expectedContainerHash ? { expectedContainerHash } : {}),
        ...(expectedChildHash ? { expectedChildHash } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.containerPath], context });
    }
  });

  registry.register({
    name: 'read_msb_parts',
    description: 'Read native MSB Parts by exact map address (for example '
      + 'm10_00_00_00#c1150_0006). file accepts a concrete .msb/.msb.dcx path, a sourceUri '
      + 'returned by search_map_entities, or a unique logical map id. The result includes '
      + 'nativeOffset, model/transform data, sourceUri, and sourceHash; use nativeOffset plus '
      + 'the expected name for later writes.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?', cursor: 'string?' },
    run: async (input, context) => {
      const edit = requireEditSession(context, 'read');
      if (!('session' in edit)) return edit;
      const value = asRecord(input);
      const file = asString(value.file);
      if (!file) return fail('INVALID_INPUT', 'read_msb_parts 需要 file。');
      const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const addresses = value.addresses === undefined ? [] : asStringList(value.addresses);
      if (value.addresses !== undefined && addresses.length === 0) {
        return fail('INVALID_INPUT', 'read_msb_parts 的 addresses 必须是非空字符串数组。');
      }
      const result = await readMsbParts({
        edit: edit.session,
        file: resolvedFile.path,
        ...(addresses.length > 0 ? { addresses } : {})
      });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return ok(result);
    }
  });

  registry.register({
    name: 'mutate_msb_part_transform',
    description: 'Set MSB part position/rotation/scale through Patch Engine (write-msb '
      + 'msb_set_part_position / msb_set_part_transform). file accepts the concrete .msb/.msb.dcx '
      + 'path or a unique sourceUri from search_map_entities; a logical map id alone is resolved '
      + 'only when the workspace index has one match. edits: [{ address: m11_01_00_00#c1050_0000, '
      + 'nativeOffset, posX?, posY?, posZ?, rotX?, rotY?, rotZ?, scaleX?, scaleY?, scaleZ? }].',
    permission: 'commit',
    permissionLevel: 'commit',
    inputSchema: { file: 'string', edits: 'array' },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.domain && value.domain !== 'map') {
        return fail('DOMAIN_CROSSOVER_REJECTED', `MSB 变换工具不能接收 ${value.domain} 领域的请求。`);
      }
      if (value.fieldKind && value.fieldKind !== 'native_value') {
        return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 MSB。`);
      }
      const file = asString(value.file);
      const edits = asMsbTransformEdits(value.edits);
      if (!file) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要 file。');
      if (!edits.ok) return fail(edits.code, edits.message);
      if (edits.edits.length === 0) return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要非空 edits 数组。');
      for (const item of edits.edits) {
        if (/^[a-z0-9_]+#A\d/i.test(item.address)) {
          return fail('DOMAIN_CROSSOVER_REJECTED', `MSB 变换工具不能接收 TAE 动作地址：${item.address}`);
        }
        const record = item as unknown as Record<string, unknown>;
        if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
          return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 MSB 原生坐标写入。');
        }
      }
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const loaded = await loadMapDocument(edit.session, resolvedFile.path);
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
      const result = await executeMapTransaction(edit.session, resolvedFile.path, transaction);
      if (!result.ok) return fail(result.error?.code ?? 'MSB_TRANSACTION_FAILED', result.error?.message ?? 'MSB 地图事务失败。', result.error?.details);
      return finalizeCommittedToolResult({
        data: { ...result, status: result.verification ?? 'completed' },
        changedSources: [resolvedFile.path],
        context
      });
    }
  });

  registry.register({
    name: 'query_map_objects',
    description: 'Read and query native semantic map objects (Parts, Regions, Models, Events) by '
      + 'modelName, entityId, kind, or name. file accepts a concrete .msb/.msb.dcx path, a '
      + 'sourceUri returned by search_map_entities, or a unique logical map id. Results include '
      + 'sourceUri/sourceHash and are bounded; use returned stable IDs for follow-up inspection.',
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
      const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await queryMapEntities(edit.session, resolvedFile.path, {
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
    description: 'Inspect a specific native map object (Part, Region, Event) by name, ID, or '
      + 'stableKey, showing transform, model, and reverse references. Pass the concrete map file '
      + 'or sourceUri returned by search_map_entities; logical map ids are accepted only when unique.',
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
      const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await inspectMapEntity(edit.session, resolvedFile.path, identifier);
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
      const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
      if (!resolvedFile.ok) return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
      const result = await batchTransformMapParts(edit.session, resolvedFile.path, {
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
      return finalizeCommittedToolResult({ data: result, changedSources: [resolvedFile.path], context });
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
      return finalizeCommittedToolResult({
        data: {
          transaction: translation.transaction,
          status: result.verification ?? 'completed',
          result
        },
        changedSources: [file],
        context
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
      return finalizeCommittedToolResult({ data: result, changedSources: result.changedFiles, context });
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
      return finalizeCommittedToolResult({ data: result, changedSources: result.restoredFiles, context });
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
      if (context.allowMemoryWrite === false) {
        return fail('AGENT_MEMORY_WRITE_FORBIDDEN', 'Agent 运行禁止写入长期记忆。');
      }
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
    name: 'query_knowledge',
    description: '只读查询受版本、游戏 profile 和 workspace scope 约束的知识 claims；知识候选不能替代当前 native 读取或写入授权。',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: {
      query: 'string',
      // The active host session is authoritative.  Keep this optional for
      // model callers so they do not have to guess an opaque workspace id;
      // direct/test callers may still provide one when no host session exists.
      workspaceId: 'string?',
      gameProfile: 'string?',
      namespace: 'string?',
      includeHistorical: 'boolean?',
      limit: 'number?'
    },
    run: (input, context) => {
      if (!context.knowledgeStore) return fail('KNOWLEDGE_STORE_UNAVAILABLE', `宿主知识 store 不可用，不能伪装成空知识结果。${context.knowledgeStoreDiagnostic ? ` ${context.knowledgeStoreDiagnostic}` : ''}`);
      const value = asRecord(input);
      const query = asString(value.query).trim();
      if (!query) return fail('INVALID_INPUT', 'query_knowledge 需要非空 query。');
      const scope = resolveKnowledgeWorkspaceId(value.workspaceId, context);
      if (!scope.ok) return scope.result;
      const { workspaceId } = scope;
      const results = queryKnowledgeClaims(context.knowledgeStore, query, {
        workspaceId,
        ...(asOptionalString(value.gameProfile) ? { gameProfile: asString(value.gameProfile) } : {}),
        ...(asOptionalString(value.namespace) ? { namespace: asString(value.namespace) } : {}),
        includeHistorical: value.includeHistorical === true,
        limit: asNumber(value.limit, 8)
      });
      return ok({
        query,
        scope: { workspaceId, ...(asOptionalString(value.gameProfile) ? { gameProfile: asString(value.gameProfile) } : {}) },
        count: results.length,
        claims: results,
        note: '知识内容仅是候选证据；执行修改前仍需当前 native handle、source version 和独立验证。'
      });
    }
  });

  registry.register({
    name: 'read_knowledge_claims',
    description: '只读读取已登记 claim/page 的完整来源和发布状态；stale/contradicted/quarantined 默认不作为正面依据。',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { workspaceId: 'string?', claimIds: 'array?', pageId: 'string?', includeHistorical: 'boolean?', limit: 'number?' },
    run: (input, context) => {
      if (!context.knowledgeStore) return fail('KNOWLEDGE_STORE_UNAVAILABLE', `宿主知识 store 不可用，不能伪装成空知识结果。${context.knowledgeStoreDiagnostic ? ` ${context.knowledgeStoreDiagnostic}` : ''}`);
      const value = asRecord(input);
      const scope = resolveKnowledgeWorkspaceId(value.workspaceId, context);
      if (!scope.ok) return scope.result;
      const { workspaceId } = scope;
      const pageId = asOptionalString(value.pageId)?.trim();
      const claimIds = Array.isArray(value.claimIds)
        ? value.claimIds.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
      if (!workspaceId || (!pageId && claimIds.length === 0)) return fail('INVALID_INPUT', 'read_knowledge_claims 需要 workspaceId 与 claimIds/pageId 之一。');
      const generation = context.knowledgeStore.getCurrent();
      const includeHistorical = value.includeHistorical === true;
      const claims = claimIds
        .map((claimId) => generation.claims[claimId])
        .filter((claim): claim is NonNullable<typeof claim> => Boolean(claim))
        .filter((claim) => includeHistorical || ['draft', 'accepted'].includes(claim.publicationState))
        .filter((claim) => claim.scope.visibility === 'global' || claim.scope.workspaceId === workspaceId)
        .slice(0, Math.max(1, Math.min(64, asNumber(value.limit, 16))));
      const page = pageId ? readKnowledgePage(context.knowledgeStore, pageId, { workspaceId, includeHistorical }) : undefined;
      return ok({
        workspaceId,
        claims,
        ...(page ? { page } : {}),
        ...(pageId && !page ? { pageMissingOrOutOfScope: true } : {}),
        count: claims.length
      });
    }
  });

  registry.register({
    name: 'switch_mode',
    description: 'Lower the active agent operation mode within the immutable host grant. Raising permission requires the user to choose Edit or Bypass in the host and start/resume a run.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { mode: 'string', reason: 'string?' },
    run: (input, context) => {
      const value = asRecord(input);
      const rawMode = asString(value.mode).trim();
      const targetMode = rawMode === 'edit' ? 'normal' : rawMode;
      if (targetMode === 'plan' || targetMode === 'normal' || targetMode === 'fullPermission') {
        const rank = { plan: 0, normal: 1, fullPermission: 2 } as const;
        const ceiling = context.modeCeiling ?? context.mode;
        if (rank[targetMode] > rank[ceiling]) {
          return fail(
            'MODE_ESCALATION_REQUIRES_HOST_GRANT',
            `不能由模型把模式从 ${context.mode} 提升到 ${targetMode}；请由用户在宿主中选择 Edit 或 Bypass 后开始或承接新一轮。`,
            { currentMode: context.mode, modeCeiling: ceiling, requestedMode: targetMode }
          );
        }
        context.mode = targetMode;
        return ok({
          switched: true,
          currentMode: targetMode,
          note: `操作模式已在宿主授权上限内切换为「${targetMode}」。`
        });
      }
      return fail('INVALID_MODE', `不支持的目标模式: "${rawMode}"，可选值为: "plan" | "edit" | "normal" | "fullPermission"。`);
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

const KNOWLEDGE_SCOPE_PLACEHOLDERS = new Set(['default', 'current', 'active', 'workspace']);

function resolveKnowledgeWorkspaceId(
  requestedValue: unknown,
  context: ToolContext
): { ok: true; workspaceId: string } | { ok: false; result: ToolResult<never> } {
  const requested = asOptionalString(requestedValue)?.trim();
  const hostWorkspaceId = context.session?.meta.workspaceId
    ?? context.coreSession?.workspaceId
    ?? context.workspaceIndex?.workspaceId;
  // A host-created store is already bound to one workspace.  Never let a
  // model choose another scope; common placeholders are treated as omission
  // so a model can use the tool without guessing a host-generated id.
  if (hostWorkspaceId) {
    if (requested && !KNOWLEDGE_SCOPE_PLACEHOLDERS.has(requested) && requested !== hostWorkspaceId) {
      return {
        ok: false,
        result: fail(
          'KNOWLEDGE_SCOPE_MISMATCH',
          '知识查询的 workspace scope 必须由当前宿主会话决定，不能读取其他工作区。',
          { requestedScope: 'redacted', activeScope: 'host-bound' }
        )
      };
    }
    return { ok: true, workspaceId: hostWorkspaceId };
  }
  if (requested) return { ok: true, workspaceId: requested };
  return {
    ok: false,
    result: fail('INVALID_INPUT', '知识工具需要当前工作区 scope；请先打开工作区。')
  };
}

function requireEditSession(
  context: ToolContext,
  purpose: 'read' | 'write'
): { ok: true; session: ReturnType<typeof nativeEditSessionFromContext> } | ToolResult<never> {
  if (!context.session) {
    return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
  }
  if (context.editSession && context.editSession.session === context.session) {
    return { ok: true, session: context.editSession };
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

type IndexedFileResolution =
  | { ok: true; path: string; sourceUri: string; canonical?: boolean }
  | { ok: false; code: string; message: string; details?: unknown };

type HostResolvedEmevdEventTargetResult =
  | { ok: true; target: HostResolvedEmevdEventTarget }
  | { ok: false; code: string; message: string; details?: unknown };

function resolveHostResolvedEmevdEventTarget(
  context: ToolContext,
  input: unknown
): HostResolvedEmevdEventTargetResult {
  const value = asRecord(input);
  const file = typeof value.file === 'string' ? value.file.trim() : '';
  const eventId = typeof value.eventId === 'number' && Number.isSafeInteger(value.eventId)
    ? value.eventId
    : undefined;
  if (!file || eventId === undefined) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'EMEVD event identity 需要 file 与安全整数 eventId。'
    };
  }
  const resolved = resolveIndexedResourceFile(context, file, 'event');
  if (!resolved.ok) return resolved;
  const sourcePath = nativePathFromFileToken(resolved.path);
  return {
    ok: true,
    target: {
      resourceKind: 'event',
      sourceUri: resolved.sourceUri,
      sourcePath,
      eventId,
      canonical: resolved.canonical === true
    }
  };
}

function nativePathFromFileToken(token: string): string {
  if (!/^file:/iu.test(token)) return token;
  try {
    return fileURLToPath(token);
  } catch {
    // Keep the original token so the native facade returns its structured
    // path diagnostic instead of silently guessing a different file.
    return token;
  }
}

/**
 * Resolve the model-facing file token against the current workspace catalog.
 * Search results expose a sourceUri, while models commonly pass only a logical
 * map id such as m10_00_00_00. Native readers need the actual indexed file;
 * silently guessing between base/overlay variants would be unsafe, so an
 * ambiguous logical id fails with the available source URIs.
 */
function resolveIndexedResourceFile(
  context: ToolContext,
  input: string,
  resourceKind: ResourceKind
): IndexedFileResolution {
  const token = input.trim();
  if (resourceKind === 'map' && !isLogicalMapToken(token) && !isMapPathToken(token)) {
    return {
      ok: false,
      code: 'MAP_RESOURCE_TYPE_MISMATCH',
      message: `地图工具只接受 .msb/.msb.dcx 或逻辑地图 ID；收到的资源不是 MSB：${token}`,
      details: { expected: ['map', 'msb', 'msb.dcx'] }
    };
  }
  const index = context.workspaceIndex;
  if (!index) {
    if (isLogicalMapToken(token)) {
      return {
        ok: false,
        code: 'MAP_SOURCE_REQUIRED',
        message: '逻辑地图 ID 不能直接作为文件；请先打开工作区并用 search_map_entities 获取 sourceUri。'
      };
    }
    return { ok: true, path: token, sourceUri: token, canonical: false };
  }

  const files = index.getFiles().filter((file) => file.resourceKind === resourceKind);
  const normalized = normalizeFileToken(token);
  const direct = files.filter((file) => [file.sourceUri, file.sourcePath, file.relativePath, file.absolutePath]
    .some((candidate) => normalizeFileToken(candidate) === normalized));
  if (direct.length === 1) {
    return { ok: true, path: direct[0]!.absolutePath, sourceUri: direct[0]!.sourceUri, canonical: true };
  }
  if (direct.length > 1) {
    return ambiguousIndexedFiles(resourceKind, token, direct);
  }

  if (resourceKind === 'map') {
    const mapId = mapIdFromFileToken(token);
    if (mapId) {
      const byMapId = files.filter((file) => mapIdFromFileToken(file.relativePath) === mapId
        || mapIdFromFileToken(file.sourcePath) === mapId
        || mapIdFromFileToken(file.sourceUri) === mapId);
      if (byMapId.length === 1) {
        return { ok: true, path: byMapId[0]!.absolutePath, sourceUri: byMapId[0]!.sourceUri, canonical: true };
      }
      if (byMapId.length > 1) return ambiguousIndexedFiles(resourceKind, token, byMapId);
      if (isLogicalMapToken(token)) {
        return {
          ok: false,
          code: 'MAP_SOURCE_NOT_INDEXED',
          message: `工作区索引中没有地图 ${mapId} 的 MSB 文件；请先检查资源索引。`
        };
      }
    }
  }

  // Preserve the existing path resolver for callers that already supplied a
  // concrete relative/absolute file but whose catalog is partial.
  return { ok: true, path: token, sourceUri: token, canonical: false };
}

function ambiguousIndexedFiles(
  resourceKind: ResourceKind,
  token: string,
  files: readonly IndexedFile[]
): IndexedFileResolution {
  return {
    ok: false,
    code: resourceKind === 'map' ? 'MAP_SOURCE_AMBIGUOUS' : 'RESOURCE_SOURCE_AMBIGUOUS',
    message: `输入 ${token} 匹配多个 ${resourceKind} 文件；请使用搜索结果中的 sourceUri，而不是继续猜测。`,
    details: {
      candidates: files.map((file) => ({ sourceUri: file.sourceUri, relativePath: file.relativePath }))
    }
  };
}

function normalizeFileToken(value: string): string {
  return value.trim().replace(/\\/g, '/').toLocaleLowerCase();
}

function isLogicalMapToken(value: string): boolean {
  return /^m\d{2}_\d{2}_\d{2}_\d{2}(?:#.*)?$/iu.test(value.trim())
    || /^map:\/\/m\d{2}_\d{2}_\d{2}_\d{2}(?:\/|$)/iu.test(value.trim());
}

function isMapPathToken(value: string): boolean {
  return /\.msb(?:\.dcx)?$/iu.test(value.trim().split('#', 1)[0] ?? '');
}

function mapIdFromFileToken(value: string): string | null {
  const withoutFragment = value.trim().split('#', 1)[0] ?? '';
  const mapUri = withoutFragment.match(/^map:\/\/([^/]+)/iu);
  if (mapUri?.[1]) return mapUri[1].toLocaleLowerCase();
  const leaf = withoutFragment.replace(/\\/g, '/').split('/').pop() ?? '';
  const mapId = leaf.replace(/\.msb(?:\.dcx)?$/iu, '');
  return /^m\d{2}_\d{2}_\d{2}_\d{2}$/iu.test(mapId) ? mapId.toLocaleLowerCase() : null;
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

function asEntityRelations(value: unknown): EntityRelationRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): EntityRelationRequest[] => {
    if (typeof item === 'string' && item.trim().length > 0) return [item.trim()];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.relation !== 'string' || record.relation.trim().length === 0) return [];
    return [{
      relation: record.relation.trim(),
      ...(typeof record.targetNamespace === 'string' && record.targetNamespace.trim().length > 0
        ? { targetNamespace: record.targetNamespace.trim() }
        : {}),
      ...(typeof record.ruleId === 'string' && record.ruleId.trim().length > 0
        ? { ruleId: record.ruleId.trim() }
        : {})
    }];
  });
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
    // T10 step 6: physical identity fields are carried through, never dropped.
    // A present-but-invalid rowIndex/expectedDataHash fails closed instead of
    // silently falling back to logical-row addressing.
    const edit: ParamFieldEdit = { table, rowId, fieldId, value: raw };
    if (record.rowIndex !== undefined) {
      if (typeof record.rowIndex !== 'number' || !Number.isSafeInteger(record.rowIndex) || record.rowIndex < 0) {
        return { ok: false, code: 'INVALID_INPUT', message: `${table}#${rowId}.${fieldId} 的 rowIndex 必须是非负安全整数。` };
      }
      edit.rowIndex = record.rowIndex;
    }
    if (record.expectedDataHash !== undefined) {
      if (typeof record.expectedDataHash !== 'string' || !/^[0-9a-fA-F]{16,128}$/.test(record.expectedDataHash.trim())) {
        return { ok: false, code: 'INVALID_INPUT', message: `${table}#${rowId}.${fieldId} 的 expectedDataHash 必须是完整的十六进制哈希值。` };
      }
      edit.expectedDataHash = record.expectedDataHash.trim();
    }
    edits.push(edit);
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

function asTaeFieldEdits(value: unknown): { ok: true; edits: Array<{
  address: string;
  fieldIndex?: number;
  fieldName?: string;
  value: string | number | boolean;
}> } | { ok: false; code: string; message: string } {
  const items = Array.isArray(value) ? value : (value && typeof value === 'object' && 'address' in value ? [value] : null);
  if (!items || items.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'mutate_tae_event_fields 的 edits 必须是数组或单条 edit 对象。' };
  }
  const edits: Array<{ address: string; fieldIndex?: number; fieldName?: string; value: string | number | boolean }> = [];
  for (const item of items) {
    const record = asRecord(item);
    const address = asString(record.address);
    if (!address) return { ok: false, code: 'INVALID_INPUT', message: '每条 TAE 字段 edit 需要 address。' };
    const fieldName = record.fieldName === undefined ? undefined : asString(record.fieldName);
    const fieldIndex = record.fieldIndex === undefined ? undefined : asNumber(record.fieldIndex, Number.NaN);
    if (fieldName === undefined && fieldIndex === undefined) {
      return { ok: false, code: 'INVALID_INPUT', message: `${address} 需要 fieldIndex 或 fieldName。` };
    }
    if (fieldIndex !== undefined && (!Number.isSafeInteger(fieldIndex) || fieldIndex < 0)) {
      return { ok: false, code: 'INVALID_INPUT', message: `${address} 的 fieldIndex 必须是非负安全整数。` };
    }
    const raw = record.value;
    if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'boolean') {
      return { ok: false, code: 'INVALID_INPUT', message: `${address} 的 value 必须是数字、字符串或布尔。` };
    }
    edits.push({
      address,
      ...(fieldIndex === undefined ? {} : { fieldIndex }),
      ...(fieldName === undefined ? {} : { fieldName }),
      value: raw
    });
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

export function resolveRagCorpus(context: ToolContext): RagCorpus | null {
  if (context.workspaceIndex) {
    const currentEpoch = context.workspaceIndex.getNativeVersionEpoch();
    const hasMatchingHostIdentity = typeof context.workspaceSessionId === 'string'
      && typeof context.ragSessionId === 'string'
      && context.ragSessionId === context.workspaceSessionId
      && typeof context.workspaceSessionGeneration === 'number'
      && typeof context.ragGeneration === 'number'
      && context.ragGeneration === context.workspaceSessionGeneration
      && typeof context.indexedFilesRevision === 'number'
      && typeof context.ragIndexedFilesRevision === 'number'
      && context.ragIndexedFilesRevision === context.indexedFilesRevision;
    // 主进程在一次分析/原生回读后注入带来源快照。优先复用同一 workspace
    // 的快照；如果每次 retrieve_evidence 都从 WorkspaceIndex 重建 18 万个
    // chunk，会把检索变成全局 CPU 放大器，尤其在并发 Agent 下会互相叠加。
    if (context.rag
      && context.rag.workspaceId === context.workspaceIndex.workspaceId
      && hasMatchingHostIdentity
      && context.ragEpoch === currentEpoch
      && context.ragScope === 'full') {
      const stats = context.workspaceIndex.getStats();
      const ragStats = context.rag.stats.byFamily;
      const taeEventCount = context.workspaceIndex.toSymbolBundle().tae?.reduce(
        (total, exportItem) => total + exportItem.animations.reduce(
          (animationTotal, animation) => animationTotal + animation.events.length,
          0
        ),
        0
      ) ?? 0;
      const ragMissingSymbols = (stats.files > 0 && ragStats.file === 0)
        || (stats.events > 0 && ragStats.event === 0)
        || (stats.mapEntities > 0 && ragStats.map_entity === 0)
        || (stats.mapRegions > 0 && ragStats.map_region === 0)
        || (stats.paramRows > 0 && ragStats.param_row === 0)
        || (stats.textEntries > 0 && ragStats.text_entry === 0)
        || (taeEventCount > 0 && ragStats.tae_event === 0);
      const incompleteSemanticCoverage = context.workspaceIndex.getCoverageSnapshot().some((item) => (
        item.domain !== undefined
        && item.expectedResources !== null
        && item.expectedResources > 0
        && item.status !== 'complete'
      ));
      if (!ragMissingSymbols && !incompleteSemanticCoverage) {
        return context.rag;
      }
    }
    // A canonical PARAM snapshot is intentionally retained, while the live
    // index supplies native families that may finish after the first PARAM
    // stage.  This is also the safe fallback for snapshots without provenance:
    // stale persisted chunks are admitted only when mergeCatalogAndPersisted
    // can prove their source revision/hash against the current file catalog.
    const live = buildRagCorpus(
      context.workspaceIndex,
      undefined,
      [],
      undefined,
      undefined,
      {
        lookupIndex: 'deferred',
        families: ['file', 'event', 'map_entity', 'map_region', 'text_entry', 'tae_event']
      }
    );
    if (context.rag && context.rag.chunks.length > 0) {
      return mergeCatalogAndPersisted(live, context.rag, { lookupIndex: 'deferred' });
    }
    return live;
  }
  if (context.rag && context.rag.chunks.length > 0) return context.rag;
  return null;
}

function ragSearchFallback(
  context: ToolContext,
  query: string,
  families: readonly RagChunkFamily[],
  limit: number,
  toolName: string,
  paramNames?: readonly string[]
): ToolResult<unknown> {
  const isParamWarmingUp = families.includes('param_row')
    && context.workspaceIndex?.getParamSemanticState?.() === 'warming_up';

  const corpus = resolveRagCorpus(context);
  const catalogHits = buildCatalogFallbackHits(context.workspaceIndex, query, families, limit);
  if (!corpus) {
    if (isParamWarmingUp) {
      return ok({
        status: 'warming_up',
        directive: 'DEFER_PARAM_QUERY',
        state: 'warming_up',
        source: 'rag-fallback',
        tool: toolName,
        query,
        availability: 'unavailable',
        totalHits: 0,
        hits: [],
        diagnostics: [],
        message: '【状态机调度】PARAM 语义索引当前正在后台解包预热中（尚未就绪）。请当前循环暂时跳过参数查询流程，优先执行其他可独立推进的任务（如 MSB 地图分析、EMEVD 事件逻辑校验、任务规划等）；请在下一次循环或后续步骤中再重新查询参数。'
      });
    }
    return ok({
      status: 'catalog-only',
      source: 'structured-catalog-fallback',
      tool: toolName,
      query,
      availability: 'unavailable',
      totalHits: catalogHits.length,
      hits: catalogHits,
      diagnostics: [{
        severity: 'warning',
        code: 'RAG_LOCAL_MODEL_UNAVAILABLE',
        message: '当前没有可用的本地模型或语义语料；已回退到结构化文件目录候选，结果只能用于定位，不能作为原生语义证明。'
      }],
      note: catalogHits.length > 0
        ? '当前只有目录级结构化候选；请继续使用领域搜索和 native read。'
        : '目录级结构化候选也未命中；零命中不是资源不存在的证明。'
    });
  }

  const result = retrieveEvidence(corpus, query, {
    limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    families,
    expandReferences: false,
    ...staleRagChunkOption(context, corpus)
  });
  if (!result.ok) {
    if (result.code === 'RAG_UNAVAILABLE') {
      if (isParamWarmingUp) {
        return ok({
          status: 'warming_up',
          directive: 'DEFER_PARAM_QUERY',
          state: 'warming_up',
          source: 'rag-fallback',
          tool: toolName,
          query,
          availability: corpus.availability,
          totalHits: 0,
          hits: [],
          diagnostics: corpus.diagnostics,
          message: '【状态机调度】PARAM 语义索引当前正在后台解包预热中（尚未就绪）。请当前循环暂时跳过参数查询流程，优先执行其他可独立推进的任务（如 MSB 地图分析、EMEVD 事件逻辑校验、任务规划等）；请在下一次循环或后续步骤中再重新查询参数。'
        });
      }
      // A semantic corpus can be present but unavailable when its last build
      // failed or is still partial. Keep the structured file catalog usable in
      // that state as well; returning only RAG_UNAVAILABLE made a clean local
      // workspace look completely unsearchable and encouraged agents to loop.
      if (catalogHits.length > 0) {
        return ok({
          status: 'catalog-only',
          source: 'structured-catalog-fallback',
          tool: toolName,
          query,
          availability: corpus.availability,
          totalHits: catalogHits.length,
          hits: catalogHits,
          diagnostics: [
            ...corpus.diagnostics,
            {
              severity: 'warning',
              code: result.code,
              message: result.message
            }
          ],
          note: '语义语料当前不可用；已返回结构化文件候选，必须继续使用领域搜索和 native read，不能把零命中解释为资源不存在。'
        });
      }
      return fail(result.code, result.message, {
        ragAvailability: corpus.availability,
        ragStats: corpus.stats,
        diagnostics: corpus.diagnostics
      });
    }
    return ok({
      source: 'rag-fallback',
      tool: toolName,
      query,
      availability: corpus.availability,
      totalHits: 0,
      hits: [],
      diagnostics: corpus.diagnostics,
      note: result.message
    });
  }

  const allowedParams = paramNames && paramNames.length > 0
    ? new Set(paramNames.map(normalizeParamNameForFallback))
    : null;
  const hits = result.hits.filter((hit) => {
    if (allowedParams === null || hit.chunk.family !== 'param_row') return true;
    // RAG chunk 同时保留原生表名和物理文件身份；参数表过滤沿用
    // 原生候选搜索的大小写、标点和 _ST 归一化，避免误把有效候选过滤掉。
    const haystack = normalizeParamSearchText(`${hit.chunk.title}\n${hit.chunk.body}`);
    return [...allowedParams].some((paramName) => haystack.includes(paramName));
  });

  return ok({
    source: 'rag-fallback',
    tool: toolName,
    query,
    availability: corpus.availability,
    totalHits: hits.length,
    hits,
    diagnostics: corpus.diagnostics,
    note: '原生专用搜索未命中；以上是已校验来源的 RAG 候选，只能用于定位，必须继续原生读取确认。'
  });
}

function buildCatalogFallbackHits(
  index: WorkspaceIndex | null,
  query: string,
  families: readonly RagChunkFamily[],
  limit: number
): Array<Record<string, unknown>> {
  if (!index) return [];
  const allowedKinds = new Set<ResourceKind>();
  for (const family of families) {
    if (family === 'param_row') allowedKinds.add('param');
    if (family === 'text_entry') allowedKinds.add('msg');
    if (family === 'event') allowedKinds.add('event');
    if (family === 'map_entity' || family === 'map_region') allowedKinds.add('map');
    if (family === 'tae_event') {
      allowedKinds.add('action');
      allowedKinds.add('chr');
    }
  }
  const results = index.searchResources({
    query,
    limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    ...(allowedKinds.size > 0 ? { kinds: [...allowedKinds] } : {})
  });
  return results.map(({ item, score }) => ({
    chunk: {
      chunkId: `catalog:${item.id}`,
      workspaceId: item.workspaceId,
      sourceUri: item.sourceUri,
      symbolUri: item.sourceUri,
      family: 'file',
      title: item.relativePath,
      body: `${item.resourceKind} ${item.formatLabel}`,
      numericIds: [],
      contentHash: item.sha256 ?? '',
      sourceRevision: item.mtimeMs,
      relativePath: item.relativePath,
      resourceKind: item.resourceKind,
      confidence: 'low'
    },
    score,
    reasons: ['structured-file-catalog'],
    excerpt: `${item.relativePath} · ${item.formatLabel}`,
    evidence: {
      status: 'summary_only',
      authority: 'structured-index',
      writeAllowed: false
    }
  }));
}

function staleRagChunkOption(
  context: ToolContext,
  corpus: RagCorpus | null
): { excludeChunkMask?: RagChunkExclusionMask } {
  if (!corpus) return {};
  const index = context.workspaceIndex;
  if (!index || index.workspaceId !== corpus.workspaceId) return {};
  const staleChunkMask = getRagStaleChunkMaskCached(index, corpus);
  return staleChunkMask ? { excludeChunkMask: staleChunkMask } : {};
}

function normalizeParamNameForFallback(value: string): string {
  const normalized = value
    .replace(/\\/gu, '/')
    .split('/')
    .pop()!
    .replace(/\.param$/iu, '')
    .replace(/[^a-z0-9]+/giu, '')
    .toLocaleLowerCase();
  return normalized.endsWith('st') && normalized.length > 2
    ? normalized.slice(0, -2)
    : normalized;
}

function normalizeParamSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '');
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
  'find_references.detail': (value) => (value === 'edges' || value === 'context' ? value : '__unaccepted__'),
  'read_emevd_event.format': (value) => (value === 'darkscript' || value === 'json' ? value : '__unaccepted__'),
  // asPatchMode falls back to the session mode. Probing with a sentinel
  // fallback keeps every declared value testable — using a real mode as the
  // fallback would make that one value indistinguishable between "accepted"
  // and "rejected then defaulted".
  'propose_text_patch.mode': (value) => asPatchMode(value, '__unaccepted__' as PatchMode),
  'apply_emevd_dsl.mode': (value) => (value === 'patch' || value === 'dark-script' ? value : '__unaccepted__'),
  'apply_emevd_dsl.scope': (value) => (value === 'file' || value === 'event' ? value : '__unaccepted__'),
  // The handler passes any string through (`typeof === 'string'`), so all
  // declared values are accepted. The declaration is deliberately narrower
  // than the handler here: narrowing only under-promises to the model, which
  // is the safe direction. assessEditRisk itself only branches on
  // 'unsupported' / 'failed' (writerContract.ts:273).
  'assess_edit_risk.parseStatus': (value) => value,
  'assess_edit_risk.changeKind': (value) => (value === 'structured' || value === 'binary' ? value : 'text')
};
