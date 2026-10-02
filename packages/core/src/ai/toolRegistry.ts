import { createSearchTaeEventsTool } from './tools/search_tae_events.js';
import { createReadTaeEventsTool } from './tools/read_tae_events.js';
import { createAnalyzeTaeStructureTool } from './tools/analyze_tae_structure.js';
import { createInsertTaeEventsTool } from './tools/insert_tae_events.js';
import { createMutateTaeEventTimesTool } from './tools/mutate_tae_event_times.js';
import { createMutateTaeEventFieldsTool } from './tools/mutate_tae_event_fields.js';
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
import { normalizePermissionLevel, fail, asRecord, resolveHostResolvedEmevdEventTarget } from './toolRegistrySupport.js';
import type { AiToolPermissionLevel, ConfirmationReceipt } from '@soulforge/shared';


import { type OperationLogStore } from '../patch/operationLog.js';
import type { WorkspaceSession } from '../workspace/workspaceSession.js';
import type { RagCorpus } from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { KnowledgeRefreshResult } from '../indexing/knowledgeRefresh.js';
import { type NativeEditSession } from '../editing/nativeEditSession.js';


import { decideAiToolPermission } from './toolPermissions.js';
import { type MemoryStore } from '../memory/memoryStore.js';
import { type ReferenceCursorStore } from '../references/referenceCursorStore.js';
import { ProofError, type NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import { buildSessionWriteRequirements, LegacyFallbackError } from '../editing/writeRequirements.js';



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
 * Enumerations use `enum:a|b|c` (optional as `enum:a|b|c?`); arrays of those
 * values use `enum[]:a|b|c` (optional as `enum[]:a|b|c?`). Before this, a
 * field like `direction` was declared as bare `'string'` and the model was
 * told nothing about the three accepted values; a wrong value did not fail but
 * silently fell back to a default (`'sideways'` → `'both'`, `mode: 'destroy'`
 * → the session mode), so the model acted on a result it did not ask for.
 */
export type ToolInputShape = Record<string, string>;
const ENUM_PREFIX = 'enum:';
const ENUM_ARRAY_PREFIX = 'enum[]:';
/** Split a declared type string into its bare type and optionality. */
function parseDeclaredType(declared: string): {
    bare: string;
    optional: boolean;
} {
    const optional = declared.endsWith('?');
    return { bare: optional ? declared.slice(0, -1) : declared, optional };
}
/** Accepted values for the requested enum declaration, or null if absent. */
function enumValues(bare: string, prefix = ENUM_PREFIX): string[] | null {
    if (!bare.startsWith(prefix))
        return null;
    const values = bare.slice(prefix.length).split('|').filter((value) => value.length > 0);
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
        const allowedItems = enumValues(expectedType, ENUM_ARRAY_PREFIX);
        if (allowedItems !== null) {
            if (!Array.isArray(value)) {
                problems.push(`字段 ${key} 类型应为 array`);
            }
            else {
                value.forEach((item, index) => {
                    if (typeof item !== 'string' || !allowedItems.includes(item)) {
                        problems.push(`字段 ${key}[${index}] 取值应为 ${allowedItems.join(' | ')} 之一`);
                    }
                });
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
    const allowedItems = enumValues(declaredType, ENUM_ARRAY_PREFIX);
    if (allowedItems !== null)
        return { type: 'array', items: { type: 'string', enum: allowedItems } };
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
  registry.register(createSearchTaeEventsTool());

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
  registry.register(createReadTaeEventsTool());

    registry.register(createAnalyzeTaeStructureTool());
  registry.register(createInsertTaeEventsTool());

    registry.register(createMutateTaeEventTimesTool());
    registry.register(createMutateTaeEventFieldsTool());
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
