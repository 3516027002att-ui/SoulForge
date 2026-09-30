import { createReadHksScriptTool } from './tools/read_hks_script.js';
import { createSearchHksScriptTool } from './tools/search_hks_script.js';
import { createWorkspaceStatsTool } from './tools/workspace_stats.js';
import { createRetrieveEvidenceTool } from './tools/retrieve_evidence.js';
import { createResolveEntityTool } from './tools/resolve_entity.js';
import { createSearchResourcesTool } from './tools/search_resources.js';
import { createSearchEventsTool } from './tools/search_events.js';
import { createSearchEventReferenceTool } from './tools/search_event_reference.js';
import { createSearchMapEntitiesTool } from './tools/search_map_entities.js';
import { createSearchParamRowsTool } from './tools/search_param_rows.js';
import { createSearchParamFieldsTool } from './tools/search_param_fields.js';
import { createSearchTextEntriesTool } from './tools/search_text_entries.js';
import { createLookupTextIdTool } from './tools/lookup_text_id.js';
import { createFindTextReferencesTool } from './tools/find_text_references.js';
import { createExplainTextEntryTool } from './tools/explain_text_entry.js';
import { createEvaluateEmevdParametersTool } from './tools/evaluate_emevd_parameters.js';
import { createFindReferencesTool } from './tools/find_references.js';
import { createExplainEventTool } from './tools/explain_event.js';
import { createProposeTextPatchTool } from './tools/propose_text_patch.js';
import { createProposePlaintextScriptEditTool } from './tools/propose_plaintext_script_edit.js';
import { createValidatePatchTool } from './tools/validate_patch.js';
import { createBuildPatchGraphTool } from './tools/build_patch_graph.js';
import { createAssessEditRiskTool } from './tools/assess_edit_risk.js';
import { createReadParamFieldsTool } from './tools/read_param_fields.js';
import { createMutateParamFieldsTool } from './tools/mutate_param_fields.js';
import { createReadFmgEntriesTool } from './tools/read_fmg_entries.js';
import { createMutateFmgEntriesTool } from './tools/mutate_fmg_entries.js';
import { createReadEmevdEventTool } from './tools/read_emevd_event.js';
import { createReadEmevdOutlineTool } from './tools/read_emevd_outline.js';
import { createApplyEmevdDslTool } from './tools/apply_emevd_dsl.js';
import { createListLuabndScriptsTool } from './tools/list_luabnd_scripts.js';
import { createReadLuabndScriptTool } from './tools/read_luabnd_script.js';
import { createAnalyzeLuabndScriptTool } from './tools/analyze_luabnd_script.js';
import { createMutateLuabndScriptTool } from './tools/mutate_luabnd_script.js';
import { createReadMsbPartsTool } from './tools/read_msb_parts.js';
import { createMutateMsbPartTransformTool } from './tools/mutate_msb_part_transform.js';
import { createQueryMapObjectsTool } from './tools/query_map_objects.js';
import { createInspectMapObjectTool } from './tools/inspect_map_object.js';
import { createBatchTransformMapObjectsTool } from './tools/batch_transform_map_objects.js';
import { createExportMapForBlenderTool } from './tools/export_map_for_blender.js';
import { createImportMapFromBlenderTool } from './tools/import_map_from_blender.js';
import { createCommitPatchTool } from './tools/commit_patch.js';
import { createListOperationsTool } from './tools/list_operations.js';
import { createRollbackOperationTool } from './tools/rollback_operation.js';
import { createReadMemoryTool } from './tools/read_memory.js';
import { createWriteMemoryTool } from './tools/write_memory.js';
import { createListMemoriesTool } from './tools/list_memories.js';
import { createQueryKnowledgeTool } from './tools/query_knowledge.js';
import { createReadKnowledgeClaimsTool } from './tools/read_knowledge_claims.js';
import { createSwitchModeTool } from './tools/switch_mode.js';
import { finalizeCommittedToolResult, normalizePermissionLevel, ok, fail, asRecord, asString, requireEditSession, resolveHostResolvedEmevdEventTarget, nativePathFromFileToken, resolveIndexedResourceFile, asStringList, asTaeTimeEdits, asTaeFieldEdits, asNumber, isWorkspaceContextCurrent, ragSearchFallback } from './toolRegistrySupport.js';
import type { AiToolPermissionLevel, ConfirmationReceipt, TaeAnimSymbol, TaeEventSymbol } from '@soulforge/shared';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { RagCorpus } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { KnowledgeRefreshResult } from '../indexing/knowledgeRefresh.js';
import { type NativeEditSession } from '../editing/nativeEditSession.js';
import { insertTaeEvents, readTaeEvents, setTaeEventFields, setTaeEventTimes, type TaeEventInsertion } from '../editing/taeEdit.js';
import { contentSearchPage } from './contentSearchPage.js';
import { decideAiToolPermission } from './toolPermissions.js';
import { type MemoryStore } from '../memory/memoryStore.js';
import { type ReferenceCursorStore } from '../references/referenceCursorStore.js';
import { ProofError, type NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { buildSessionWriteRequirements, LegacyFallbackError } from '../editing/writeRequirements.js';
import { sourceTextPage } from './sourceTextPage.js';
import { literalSourceSearchPage } from './literalSourceSearchPage.js';
import { readHksSource } from '../editing/hksRead.js';
import type { DiagnosticEvent } from '../diagnostics/diagnosticEvent.js';
/** @deprecated Prefer AiToolPermissionLevel. Kept for older UI labels. */
export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;
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
    /** Host-owned live check used to discard RAG results after a workspace switch. */
    isWorkspaceContextCurrent?: () => boolean;
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
    /** Host-owned read-only query continuations; CLI may persist these across commands. */
    referenceCursorStore?: ReferenceCursorStore;
    /** Invalidate and converge knowledge after a committed native write/rollback. */
    onNativeWriteCommitted?: (changedSources: KnowledgeSourceChange) => Promise<KnowledgeRefreshResult | void>;
    /** Abort the current Agent tool call when the host cancels the run. */
    signal?: AbortSignal;
    /** Optional host-only timing/progress sink; never enters tool result data. */
    onDiagnostic?: (event: DiagnosticEvent) => void;
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
    /** Effect and concurrency come from the same permission declaration. */
    effect?: 'read' | 'stage' | 'write' | 'rollback';
    supportsParallel?: boolean;
    /** Curator-only writes explicitly opt out; native writes default fail-closed. */
    proofPolicy?: 'native-read' | 'none';
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
    state?: 'completed' | 'failed' | 'staged' | 'committed' | 'verification_failed' | 'unsupported' | 'ambiguous' | 'stale' | 'cancelled' | 'insufficient_evidence';
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
function parseDeclaredType(declared: string): {
    bare: string;
    optional: boolean;
} {
    const optional = declared.endsWith('?');
    return { bare: optional ? declared.slice(0, -1) : declared, optional };
}
/** Accepted values for an `enum:a|b|c` declaration, or null if not an enum. */
function enumValues(bare: string): string[] | null {
    if (!bare.startsWith(ENUM_PREFIX))
        return null;
    const values = bare.slice(ENUM_PREFIX.length).split('|').filter((value) => value.length > 0);
    return values.length > 0 ? values : null;
}
export interface RegisteredTool extends ToolDescriptor {
    inputSchema?: ToolInputShape;
    run: ToolHandler;
}
export function validateToolInput(shape: ToolInputShape | undefined, input: unknown): {
    ok: true;
} | {
    ok: false;
    message: string;
} {
    if (!shape || Object.keys(shape).length === 0)
        return { ok: true };
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, message: '工具输入必须是 JSON 对象。' };
    }
    const record = input as Record<string, unknown>;
    const problems: string[] = [];
    for (const [key, declared] of Object.entries(shape)) {
        const { bare: expectedType, optional } = parseDeclaredType(declared);
        const value = record[key];
        if (value === undefined) {
            if (!optional)
                problems.push(`缺少必填字段 ${key}`);
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
        if (!optional)
            required.push(key);
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
    if (allowed !== null)
        return { type: 'string', enum: allowed };
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
        if (this.tools.has(tool.name))
            throw new Error(`Tool already registered: ${tool.name}`);
        const permissionLevel = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
        const effect = permissionLevel === 'rollback' ? 'rollback' : permissionLevel === 'commit' ? 'write' : permissionLevel === 'stage' ? 'stage' : 'read';
        this.tools.set(tool.name, { ...tool, permissionLevel, permission: permissionLevel, effect,
            supportsParallel: (permissionLevel === 'read' || permissionLevel === 'analyze') && tool.supportsParallel !== false,
            proofPolicy: tool.proofPolicy ?? (effect === 'write' ? 'native-read' : 'none') });
    }
    list(): ToolDescriptor[] {
        return [...this.tools.values()].map(({ name, description, permission, permissionLevel, inputSchema, effect, supportsParallel, proofPolicy }) => ({
            name,
            description,
            permission,
            permissionLevel: permissionLevel ?? normalizePermissionLevel(permission),
            ...(effect ? { effect } : {}),
            ...(proofPolicy ? { proofPolicy } : {}),
            ...(supportsParallel !== undefined ? { supportsParallel } : {}),
            // Surfaced verbatim (not cloned-and-renamed) so the model-facing schema
            // and the runtime validateToolInput check can never disagree: both read
            // this same declaration.
            ...(inputSchema && Object.keys(inputSchema).length > 0 ? { inputSchema } : {})
        }));
    }
    async run(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
        const tool = this.tools.get(name);
        if (!tool)
            return fail('TOOL_NOT_FOUND', `Unknown tool: ${name}`);
        const level = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
        const permissionDecision = decideAiToolPermission(level, context.mode);
        if (!permissionDecision.allowed) {
            return fail('TOOL_PERMISSION_DENIED', `Tool '${name}' requires ${permissionDecision.required} permission in ${context.mode} mode; `
                + `maximum is ${permissionDecision.ceiling}.`);
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
            return fail(hostResolvedEmevdEventTarget.code, hostResolvedEmevdEventTarget.message, hostResolvedEmevdEventTarget.details);
        }
        const resolvedEmevdTarget = hostResolvedEmevdEventTarget?.ok
            ? hostResolvedEmevdEventTarget.target
            : undefined;
        const proofStore = context.nativeReadProofs ?? context.coreSession?.proofStore;
        if (tool.proofPolicy === 'native-read' && proofStore) {
            // T09: requirements are derived from the actual writer payload and the
            // host-resolved native identity. A model-supplied ledger/searchId is
            // never consulted. FMG additions may use the explicitly returned
            // container proof as a narrow, host-defined fallback.
            let requirements;
            try {
                requirements = await buildSessionWriteRequirements(name, input, context.session, resolvedEmevdTarget);
            }
            catch (error) {
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
                }
                catch (error) {
                    if (requirement.fallback === undefined) {
                        const code = error instanceof ProofError ? error.code : 'NATIVE_READ_REQUIRED';
                        return fail(code, error instanceof Error ? error.message : String(error));
                    }
                    try {
                        check(requirement.fallback);
                    }
                    catch (fallbackError) {
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
                const nativeDiagnostics = diagnostics.filter((diagnostic) => (diagnostic
                    && typeof diagnostic === 'object'
                    && !Array.isArray(diagnostic)
                    && (diagnostic as Record<string, unknown>).code !== warningCode));
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
        }
        catch (error) {
            return fail('TOOL_EXCEPTION', error instanceof Error ? error.message : String(error));
        }
    }
}
export function createDefaultToolRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    // T12 step 11: the manual ledger tools read_agent_task_record and
    // update_agent_task_record are removed from the production registry. The
    // automatic native-read proof boundary (T09) replaces the ledger gate; no
    // empty stub is kept to "succeed" for old prompts.
    registry.register(createWorkspaceStatsTool());
    registry.register(createRetrieveEvidenceTool());
    registry.register(createResolveEntityTool());
    registry.register(createSearchResourcesTool());
    registry.register(createSearchEventsTool());
    registry.register(createSearchEventReferenceTool());
    registry.register(createSearchMapEntitiesTool());
  registry.register({
    name: 'search_tae_events',
    description: 'Search native TAE actions by any event field, type or address. A hit returns the action’s sibling events in native order. '
      + 'limit counts actions. Follow nextCursor for more actions and each action pagination.nextRead for remaining events.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { query: 'string?', limit: 'safe-integer?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'safe-integer?' },
    run: async (input, context) => {
      const ws = context.workspaceIndex;
      if (ws === null) return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
      const value = asRecord(input);
      try {
        const page = contentSearchPage({ tool: 'search_tae_events', workspaceId: ws.workspaceId, input: value,
          search: (query) => ws.searchTaeActionGroups(query, Number.MAX_SAFE_INTEGER),
          fingerprint: (match) => [match.item.sourceUri, match.item.address, match.item.sourceHash, match.item.sourceRevision, match.item.events] });
        const pageSize = typeof value.pageSize === 'number' && Number.isSafeInteger(value.pageSize) && value.pageSize > 0
          ? Math.min(128, value.pageSize) : 16;
        if (page.total > 0 || value.cursor !== undefined) return ok({ ...page,
          matches: page.matches.map((match) => {
            const item = match.item;
            const maximumBytes = Math.max(1, ...item.events.map((event) => Buffer.byteLength(JSON.stringify(event), 'utf8')));
            const size = Math.max(1, Math.min(pageSize, Math.floor(20000 / maximumBytes)));
            const events = item.events.slice(0, size);
            const totalCount = item.eventCount ?? null;
            const complete = item.eventsComplete === true;
            const hasMore = !complete || events.length < (totalCount ?? item.events.length);
            const prefix = events.every((event, index) => event.index === index);
            return { ...match, item: { ...item, events,
              pagination: { totalCount, returnedCount: events.length, offset: 0,
                pageNumber: 1, totalPages: totalCount === null ? null : Math.ceil(totalCount / size), hasMore,
                ...(hasMore ? { nextRead: { tool: 'read_tae_events', args: {
                  file: item.sourceUri, addresses: [item.address], offset: prefix ? events.length : 0, pageSize: size,
                  ...(item.sourceHash ? { expectedSourceHash: item.sourceHash } : {}),
                  ...(item.readerSchemaRevision === undefined ? {} : { expectedReaderSchemaRevision: item.readerSchemaRevision }) } } } : {}) } } };
          }) });
        return ragSearchFallback(context, page.query, ['tae_event'], page.limit, 'search_tae_events');
      } catch (error) {
        return fail((error as { code?: string }).code ?? 'TAE_SEARCH_FAILED', error instanceof Error ? error.message : '动作搜索失败。');
      }
    }
  });

    registry.register(createSearchParamRowsTool());
    registry.register(createSearchParamFieldsTool());
    registry.register(createSearchTextEntriesTool());
    registry.register(createLookupTextIdTool());
    registry.register(createFindTextReferencesTool());
    registry.register(createExplainTextEntryTool());
    registry.register(createEvaluateEmevdParametersTool());
    registry.register(createFindReferencesTool());
    registry.register(createExplainEventTool());
    registry.register(createProposeTextPatchTool());
    registry.register(createProposePlaintextScriptEditTool());
    registry.register(createValidatePatchTool());
    registry.register(createBuildPatchGraphTool());
    registry.register(createAssessEditRiskTool());
    registry.register(createReadParamFieldsTool());
    registry.register(createMutateParamFieldsTool());
    registry.register(createReadFmgEntriesTool());
    registry.register(createMutateFmgEntriesTool());
    registry.register(createReadEmevdEventTool());
    registry.register(createReadEmevdOutlineTool());
    registry.register(createApplyEmevdDslTool());
  registry.register({
    name: 'read_tae_events',
    description: 'Read native TAE event times and decoded fields by exact action address. '
      + 'Use an action-level cXXXX#AXXXX or section-qualified action URI to read every event. Event addresses select exact events. Follow cursor with the same addresses for remaining native events.',
    permission: 'read',
    permissionLevel: 'read',
    inputSchema: { file: 'string', addresses: 'array?', cursor: 'string?', offset: 'safe-integer?', pageSize: 'number?', expectedSourceHash: 'string?', expectedReaderSchemaRevision: 'safe-integer?' },
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
        ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(typeof value.expectedSourceHash === 'string' ? { expectedSourceHash: value.expectedSourceHash } : {}),
        ...(typeof value.expectedReaderSchemaRevision === 'number' ? { expectedReaderSchemaRevision: value.expectedReaderSchemaRevision } : {})
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
        // 原生读取的内容哈希与扫描期的文件字节哈希是两种体系，直接用前者
        // 挂版本会被 freshness 门禁恒拒（read-hash ≠ scan-hash），导致
        // search_tae_events 永远 RAG-fallback。导出版本只挂扫描一致的文件
        // 身份（无扫描哈希时退为纯 mtime 版本）；事件明细仍保留读取哈希。
        const exportSourceHash = sourceFile?.sha256;
        const readSourceHash = result.sourceHash;
        const sourceRevision = sourceFile?.mtimeMs;
        // 同一 TAE source 内不同 section 可以复用 animId；不能按裸数字合并，
        // 否则 AI 看到的事件会跨 a00/a50 串线。
        const animations = new Map<string, TaeAnimSymbol>();
        for (const action of result.actions) {
          const key = `${action.taeEntryIndex ?? action.taeEntryId ?? action.taeEntryName ?? 'tae'}:${action.animId}`;
          animations.set(key, { ...action, eventCount: action.eventCount, eventsComplete: action.eventCount === 0, events: [] });
        }
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
            ...(readSourceHash ? { sourceHash: readSourceHash } : {}),
            ...(sourceRevision !== undefined ? { sourceRevision } : {}),
            ...(event.fields ? { fields: event.fields } : {}),
            ...(event.parameterBytesHex ? { parameterBytesHex: event.parameterBytesHex } : {}),
            ...(event.decodeStatus ? { decodeStatus: event.decodeStatus } : {}),
            ...(event.raw ? { raw: event.raw } : {})
          });
          animations.set(animationKey, animation);
        }
        context.workspaceIndex.mergeTaeEvents({
          chrId: result.chrId,
          readerSchemaRevision: result.readerSchemaRevision,
          ...((result.containerSourceHash ?? result.sourceHash) ? { outerFileHash: result.containerSourceHash ?? result.sourceHash } : {}),
          sourceUri,
          ...(exportSourceHash ? { sourceHash: exportSourceHash } : {}),
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
        name: 'analyze_tae_structure',
        description: 'Read native TAE structure with section/animation/event identity, raw unknown-event preservation and layered '
            + 'evidence. It does not infer an action-to-AtkParam/Bullet chain or runtime behavior from timing/name similarity.',
        permission: 'analyze',
        permissionLevel: 'analyze',
        inputSchema: { file: 'string', cursor: 'string?', pageSize: 'number?' },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            if (!file)
                return fail('INVALID_INPUT', 'analyze_tae_structure 需要 file。');
            const resolvedFile = resolveIndexedResourceFile(context, file, 'chr');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await readTaeEvents({
                edit: edit.session,
                file: nativePathFromFileToken(resolvedFile.path),
                ...(typeof value.cursor === 'string' ? { cursor: value.cursor.trim() } : {}),
                ...(typeof value.pageSize === 'number' ? { pageSize: Math.trunc(value.pageSize) } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            const unknownEvents = result.events.filter((event) => event.decodeStatus !== 'decoded');
            return ok({
                ...result,
                evidenceLayers: {
                    resource: 'native-read',
                    relation: 'section-animation-event-index',
                    logic: unknownEvents.length > 0 ? 'partial-unknown-events' : 'decoded-fields-only',
                    runtime: 'not-run'
                },
                actionChain: {
                    status: 'insufficient_evidence',
                    reason: '当前没有足够证据把招式分支闭合到 Behavior/AtkParam/Bullet；禁止用最大行号、最后时间轴事件或名称相似度代替身份。'
                },
                unknownEvents: unknownEvents.map((event) => ({
                    address: event.address,
                    eventTypeId: event.eventTypeId,
                    raw: event.raw ?? { eventTypeId: event.eventTypeId, startTime: event.startTime, endTime: event.endTime, ...(event.parameterBytesHex ? { parameterBytesHex: event.parameterBytesHex } : {}) }
                }))
            });
        }
    });
  registry.register({
    name: 'insert_tae_events',
    description: 'Append native TAE events through Patch Engine in one audited commit. Each event needs an action-level address, eventTypeId, startFrame/endFrame, and a template {file?, address} with an exact event address. Templates may come from another action, section or workspace file. Optional fields are typed first-party schema overrides applied atomically; unknown layouts fail closed. Returns exact new addresses, backup, operation and rollback information.',
    permission: 'commit', permissionLevel: 'commit',
    inputSchema: { file: 'string', events: 'array' },
    run: async (input, context) => {
      const value = asRecord(input);
      if (value.domain && value.domain !== 'tae') return fail('DOMAIN_CROSSOVER_REJECTED', 'TAE 新增工具仅接受动作词条。');
      const file = asString(value.file);
      if (!file || !Array.isArray(value.events)) return fail('INVALID_INPUT', 'insert_tae_events 需要 file 和 events 数组。');
      const edit = requireEditSession(context, 'write');
      if (!('session' in edit)) return edit;
      const resolved = resolveIndexedResourceFile(context, file, 'chr');
      if (!resolved.ok) return fail(resolved.code, resolved.message, resolved.details);
      for (const raw of value.events) {
        const template = asRecord(asRecord(raw).template);
        if (typeof template.file === 'string') {
          const resolvedTemplate = resolveIndexedResourceFile(context, template.file, 'chr');
          if (!resolvedTemplate.ok) return fail(resolvedTemplate.code, resolvedTemplate.message, resolvedTemplate.details);
        }
      }
      const events = value.events.map(raw => {
        const event = asRecord(raw); const template = asRecord(event.template);
        const templateFile = typeof template.file === 'string' ? resolveIndexedResourceFile(context, template.file, 'chr') : undefined;
        return { ...event, template: { ...template, ...(templateFile?.ok ? { file: nativePathFromFileToken(templateFile.path) } : {}) } };
      }) as unknown as TaeEventInsertion[];
      const result = await insertTaeEvents({ edit: edit.session, file: nativePathFromFileToken(resolved.path), events });
      if (!result.ok) return fail(result.error.code, result.error.message, result.diagnostics);
      return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context,
        verifyNative: async () => result.nativeVerified ? { ok: true, details: { addresses: result.after.map(e => e.address) } }
          : { ok: false, code: 'TAE_INSERT_READBACK_FAILED', message: '提交后未完整回读新增词条。', details: result.diagnostics } });
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
            if (!file)
                return fail('INVALID_INPUT', 'mutate_tae_event_times 需要 file。');
            if (!edits.ok)
                return fail(edits.code, edits.message);
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
            if (!('session' in edit))
                return edit;
            const result = await setTaeEventTimes({ edit: edit.session, file, edits: edits.edits });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
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
            if (!file)
                return fail('INVALID_INPUT', 'mutate_tae_event_fields 需要 file。');
            if (!edits.ok)
                return fail(edits.code, edits.message);
            for (const edit of edits.edits) {
                if (/^m\d\d_/i.test(edit.address) || !/^[a-z0-9_]+#A/i.test(edit.address)) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `TAE 字段写入工具只能接收 TAE 动作事件地址：${edit.address}`);
                }
            }
            const session = requireEditSession(context, 'write');
            if (!('session' in session))
                return session;
            const result = await setTaeEventFields({ edit: session.session, file, edits: edits.edits });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.filePath], context });
        }
    });
    registry.register(createReadHksScriptTool());
    registry.register(createSearchHksScriptTool());
    registry.register(createListLuabndScriptsTool());
    registry.register(createReadLuabndScriptTool());
    registry.register(createAnalyzeLuabndScriptTool());
    registry.register(createMutateLuabndScriptTool());
    registry.register(createReadMsbPartsTool());
    registry.register(createMutateMsbPartTransformTool());
    registry.register(createQueryMapObjectsTool());
    registry.register(createInspectMapObjectTool());
    registry.register(createBatchTransformMapObjectsTool());
    registry.register(createExportMapForBlenderTool());
    registry.register(createImportMapFromBlenderTool());
    registry.register(createCommitPatchTool());
    registry.register(createListOperationsTool());
    registry.register(createRollbackOperationTool());
    registry.register(createReadMemoryTool());
    registry.register(createWriteMemoryTool());
    registry.register(createListMemoriesTool());
    registry.register(createQueryKnowledgeTool());
    registry.register(createReadKnowledgeClaimsTool());
    registry.register(createSwitchModeTool());
    return registry;
}
export { finalizeCommittedToolResult, finalizeEmevdDslApplyResult, summarizeReferences, resolveRagCorpus, ENUM_FIELD_NORMALIZERS } from './toolRegistrySupport.js';
export type { NativePostWriteVerification } from './toolRegistrySupport.js';
