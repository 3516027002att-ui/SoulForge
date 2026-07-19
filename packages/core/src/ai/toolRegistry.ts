import type {
  AiToolPermissionLevel,
  IndexedFile,
  PatchMode,
  PatchProposal,
  ReferenceEdge,
  ResourceKind
} from '@soulforge/shared';
import { createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import { getDefaultOperationLogStore } from '../patch/operationLog.js';
import { rollbackOperation } from '../patch/rollback.js';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../patch/graphPatch.js';
import type { MemoryResourceGraph } from '../resource-graph/memoryResourceGraph.js';
import { assessEditRisk, evaluateWriterGate, resolveWriterContract } from '../patch/writerContract.js';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { ALL_RESOURCE_KINDS } from '../workspace/resourceKinds.js';
import { buildTextAiContext, renderTextAiPrompt } from './aiContextBuilder.js';
import {
  ensurePatchToolState,
  runPatchCommit,
  runPatchProposeTextEdit,
  runPatchRollback,
  runPatchStage,
  runPatchValidate,
  type PatchToolCoreResult
} from './patchTools.js';
import { legacyPermissionToLevel, maxPermissionForMode } from './toolPermissions.js';
import { evaluatePolicyGate } from '../ai-tools/policyGate.js';
import type { ToolPermission as SharedToolPermission } from '@soulforge/shared';

export type ToolPermission = 'read' | 'plan' | 'write' | AiToolPermissionLevel;

export interface ToolContext {
  workspaceIndex: WorkspaceIndex;
  mode: 'plan' | 'normal' | 'fullPermission';
  confirmationReceiptIds?: string[];
  /**
   * Optional workspace root for PatchIR transaction tools.
   * Desktop production callers should pass the active overlay root.
   */
  workspaceRoot?: string;
  /**
   * Shared bag for chained tool calls (PatchIR propose → stage → validate → commit).
   */
  state?: Record<string, unknown>;
  /** Optional in-memory resource graph for resource.graph.query compatibility. */
  graph?: MemoryResourceGraph;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  permission: ToolPermission;
  permissionLevel?: AiToolPermissionLevel;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

type ToolHandler = (input: unknown, context: ToolContext) => Promise<ToolResult> | ToolResult;

export interface RegisteredTool extends ToolDescriptor {
  run: ToolHandler;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    const permissionLevel = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    this.tools.set(tool.name, { ...tool, permissionLevel, permission: permissionLevel });
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, permission, permissionLevel }) => ({
      name,
      description,
      permission,
      permissionLevel: permissionLevel ?? normalizePermissionLevel(permission)
    }));
  }

  getTool(name: string): ToolDescriptor | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      description: tool.description,
      permission: tool.permission,
      permissionLevel: tool.permissionLevel ?? normalizePermissionLevel(tool.permission)
    };
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Production policy-gated execution.
   * Alias for the scaffold registry naming so call sites can converge on one surface.
   */
  async executeToolThroughPolicy(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    return this.run(name, input, context);
  }

  async run(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `Unknown tool: ${name}`);

    const level = tool.permissionLevel ?? normalizePermissionLevel(tool.permission);
    const requiredPermission = level as SharedToolPermission;
    const decision = evaluatePolicyGate({
      mode: context.mode,
      toolName: name,
      requiredPermission,
      maxPermission: maxPermissionForMode(context.mode) as SharedToolPermission,
      ...(context.confirmationReceiptIds !== undefined
        ? { confirmationReceiptIds: context.confirmationReceiptIds }
        : {})
    });
    if (decision.kind === 'deny' || decision.kind === 'require_confirmation') {
      return fail(
        decision.code ?? 'TOOL_PERMISSION_DENIED',
        decision.reason || `Mode ${context.mode} cannot execute ${tool.name} (${level}).`
      );
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
    run: (_input, context) => ok(context.workspaceIndex.getStats())
  });

  // Dotted alias used by architecture scaffold smoke / typed tool plans.
  registry.register({
    name: 'workspace.stats',
    description: 'Alias of workspace_stats for dotted tool-plan naming.',
    permission: 'read',
    permissionLevel: 'read',
    run: async (_input, context) => {
      if (!context.workspaceRoot) {
        return fail('WORKSPACE_ROOT_REQUIRED', 'workspace.stats requires workspaceRoot on ToolContext.');
      }
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(context.workspaceRoot, { withFileTypes: true });
      const fileCount = entries.filter((entry) => entry.isFile()).length;
      return ok({ fileCount, root: context.workspaceRoot });
    }
  });

  registry.register({
    name: 'resource.graph.query',
    description: 'Query the in-memory resource graph attached to ToolContext.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      if (!context.graph) {
        return fail('GRAPH_REQUIRED', 'resource.graph.query requires graph on ToolContext.');
      }
      const value = asRecord(input);
      const limit = asNumber(value.limit, 50);
      const result = context.graph.query({ limit, includeDiagnostics: true, includeProvenance: true });
      return ok(result);
    }
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const query = asString(value.query, '');
      const limit = asNumber(value.limit, 50);
      const kinds = asResourceKinds(value.kinds);
      return ok(context.workspaceIndex.searchResources({ query, limit, ...(kinds ? { kinds } : {}) }));
    }
  });

  registry.register({
    name: 'search_events',
    description: 'Search parsed event symbols.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up parsed text entries by numeric textId and optional category.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'lookup_text_id requires numeric textId.');
      const category = asOptionalString(value.category);
      const matches = context.workspaceIndex.lookupTextEntries(textId, category);
      if (matches.length === 0) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      return ok({ textId, category: category ?? null, matches });
    }
  });

  registry.register({
    name: 'find_references',
    description: 'Find reference edges from/to a resource URI.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'find_references requires uri.');
      const direction = asReferenceDirection(value.direction);
      const edges = context.workspaceIndex.findReferences(uri, direction);
      return ok({ uri, direction, edges, summary: summarizeReferences(edges) });
    }
  });

  registry.register({
    name: 'get_file_summary',
    description: 'Return an indexed file record by URI or path.',
    permission: 'read',
    permissionLevel: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asOptionalString(value.uri);
      const path = asOptionalString(value.path);
      let file: IndexedFile | undefined;
      if (uri) file = context.workspaceIndex.getFile(uri);
      if (!file && path) {
        // WorkspaceIndex keys files by URI; fall back to relativePath scan when only path is given.
        const files = context.workspaceIndex.searchResources({ query: path, limit: 50 });
        file = files.find((item) => item.item.relativePath === path || item.item.sourceUri === path || item.item.sourceUri === path)?.item
          ?? files.find((item) => item.item.relativePath.endsWith(path) || item.item.sourceUri.endsWith(path))?.item;
      }
      if (!file) return fail('FILE_NOT_FOUND', 'No indexed file matched the request.', { uri, path });
      return ok(file);
    }
  });

  registry.register({
    name: 'build_text_ai_context',
    description: 'Build a structured AI context pack for a text/msg resource.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'build_text_ai_context requires uri.');

      const category = asOptionalString(value.category);
      let entry = asOptionalString(value.text) !== undefined
        ? {
            uri,
            sourceUri: uri,
            textId: typeof value.textId === 'number' ? value.textId : 0,
            text: asString(value.text),
            ...(category !== undefined ? { category } : {})
          }
        : undefined;

      if (!entry) {
        const textId = typeof value.textId === 'number' ? value.textId : Number.NaN;
        if (Number.isFinite(textId)) {
          entry = context.workspaceIndex.lookupTextEntry(textId, asOptionalString(value.category));
        }
      }
      if (!entry) {
        const matches = context.workspaceIndex.searchTextEntries(uri, 20);
        entry = matches.find((item) => item.item.sourceUri === uri || item.item.sourceUri === uri)?.item
          ?? matches[0]?.item;
      }
      if (!entry) {
        return fail('TEXT_ENTRY_NOT_FOUND', 'No indexed text entry matched the request.', { uri });
      }

      const pack = buildTextAiContext(
        entry,
        context.workspaceIndex.findReferences(entry.uri, 'both')
      );
      return ok({
        ...pack,
        prompt: renderTextAiPrompt(pack)
      });
    }
  });

  registry.register({
    name: 'propose_text_patch',
    description: 'Create a PatchProposal for a text edit without writing files.',
    permission: 'propose',
    permissionLevel: 'propose',
    run: (input, context) => {
      const value = asRecord(input);
      const workspaceId = asString(value.workspaceId, context.workspaceIndex.workspaceId);
      const title = asString(value.title, 'AI text edit');
      const targetUri = asString(value.targetUri);
      const targetPath = asString(value.targetPath);
      const newText = asString(value.newText);
      const mode = asPatchMode(value.mode, context.mode);

      if (!targetUri || !targetPath || newText === undefined) {
        return fail('INVALID_INPUT', 'propose_text_patch requires targetUri, targetPath, and newText.');
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
    name: 'validate_patch',
    description: 'Run Patch Engine validation in staging. It does not save files.',
    permission: 'validate',
    permissionLevel: 'validate',
    run: async (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'validate_patch requires a PatchProposal.');
      }
      return ok(await dryRunPatchProposal(proposal));
    }
  });

  registry.register({
    name: 'assess_edit_risk',
    description: 'Assess risk for a proposed write using the writer contract matrix.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri, asString(value.path, ''));
      const path = asString(value.path, uri);
      let file: IndexedFile | undefined = uri ? context.workspaceIndex.getFile(uri) : undefined;
      if (!file && path) {
        const matches = context.workspaceIndex.searchResources({ query: path, limit: 50 });
        file = matches.find((item) =>
          item.item.sourceUri === path
          || item.item.relativePath === path
          || item.item.relativePath.endsWith(path)
          || item.item.sourceUri.endsWith(path)
          || item.item.absolutePath === path
          || item.item.absolutePath.endsWith(path)
        )?.item;
      }
      if (!file) {
        // Honest fallback for callers that only pass kind/path without an index hit.
        // Marked unparsed/unknown so risk scoring stays conservative.
        file = {
          id: path || uri || 'unknown',
          workspaceId: context.workspaceIndex.workspaceId,
          absolutePath: path || uri || 'unknown',
          sourcePath: path || uri || 'unknown',
          sourceUri: path || uri || 'unknown://resource',
          relativePath: path || uri || 'unknown',
          resourceKind: 'unknown',
          formatKind: 'unknown',
          formatLabel: 'unknown',
          extension: '',
          compoundExtension: '',
          size: 0,
          mtimeMs: 0,
          game: 'unknown',
          parseStatus: 'unparsed',
          diagnostics: []
        };
      }
      const resolvedFile: IndexedFile = file;
      const riskOptions: {
        truncated?: boolean;
        structuredEditable?: boolean;
        parseStatus?: string;
      } = {
        truncated: value.truncated === true
      };
      if (value.structuredEditable === false) riskOptions.structuredEditable = false;
      const parseStatus = asOptionalString(value.parseStatus);
      if (parseStatus !== undefined) riskOptions.parseStatus = parseStatus;

      const risk = assessEditRisk(resolvedFile, riskOptions);
      const contract = resolveWriterContract(resolvedFile);
      const changeKind: 'text' | 'structured' | 'binary' =
        asString(value.changeKind, 'text') === 'structured'
          ? 'structured'
          : asString(value.changeKind, 'text') === 'binary'
            ? 'binary'
            : 'text';
      let confirmation = undefined as import('@soulforge/shared').ConfirmationReceipt | undefined;
      if (Array.isArray(value.confirmationReceiptIds) && value.confirmationReceiptIds.length > 0) {
        confirmation = {
          id: String(value.confirmationReceiptIds[0]),
          confirmedAt: new Date().toISOString(),
          subjects: ['edit-risk'],
          riskLevel: risk.level
        };
      }
      const gate = evaluateWriterGate({
        file: resolvedFile,
        changeKind,
        ...(Object.keys(riskOptions).length > 0 ? { riskOptions } : {}),
        ...(confirmation ? { confirmation } : {})
      });
      return ok({ risk, contract, gate });
    }
  });

registry.register({
    name: 'build_patch_graph',
    description: 'Build a graph-level impact summary from a PatchProposal without writing files.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: (input, context) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'build_patch_graph requires a PatchProposal.');
      }
      const resourceKindByUri = new Map<string, ResourceKind>();
      for (const change of proposal.changes) {
        const indexed = context.workspaceIndex.getFile(change.targetUri);
        if (indexed) resourceKindByUri.set(change.targetUri, indexed.resourceKind);
      }
      const graph = buildGraphPatchFromProposal(proposal, {
        resourceKindByUri
      });
      return ok({
        graph,
        summary: summarizeGraphPatch(graph)
      });
    }
  });

  registry.register({
    name: 'list_operations',
    description: 'List Patch Engine operation log / patch history entries for the active workspace.',
    permission: 'analyze',
    permissionLevel: 'analyze',
    run: async (_input, context) => {
      const store = getDefaultOperationLogStore();
      return ok({
        operations: await store.list(context.workspaceIndex.workspaceId),
        history: await store.history(context.workspaceIndex.workspaceId)
      });
    }
  });

  registry.register({
    name: 'rollback_operation',
    description: 'Rollback a committed operation from its backup. Requires full-permission mode.',
    permission: 'rollback',
    permissionLevel: 'rollback',
    run: async (input) => {
      const value = asRecord(input);
      const opId = asString(value.opId);
      if (!opId) return fail('INVALID_INPUT', 'rollback_operation requires opId.');
      return ok(await rollbackOperation({
        opId,
        store: getDefaultOperationLogStore()
      }));
    }
  });

  // Shared PatchIR tools — single implementation for production + scaffold registry.
  registry.register({
    name: 'patch.proposeTextEdit',
    description: 'Propose a text edit PatchIR without writing files.',
    permission: 'propose',
    permissionLevel: 'propose',
    run: (input, context) => toToolResult(runPatchProposeTextEdit(input, {
      workspaceId: context.workspaceIndex.workspaceId,
      state: ensurePatchToolState(context)
    }))
  });

  registry.register({
    name: 'patch.stage',
    description: 'Stage the last proposed PatchIR via WorkspaceTransaction.',
    permission: 'stage',
    permissionLevel: 'stage',
    run: async (input, context) => toToolResult(await runPatchStage(input, {
      workspaceId: context.workspaceIndex.workspaceId,
      ...(context.workspaceRoot !== undefined ? { workspaceRoot: context.workspaceRoot } : {}),
      state: ensurePatchToolState(context),
      actorId: 'patch.stage'
    }))
  });

  registry.register({
    name: 'patch.validate',
    description: 'Validate staged PatchIR output through WorkspaceTransaction.',
    permission: 'validate',
    permissionLevel: 'validate',
    run: async (input, context) => toToolResult(await runPatchValidate(input, {
      workspaceId: context.workspaceIndex.workspaceId,
      state: ensurePatchToolState(context)
    }))
  });

  registry.register({
    name: 'patch.commit',
    description: 'Commit a validated PatchIR transaction through WorkspaceTransaction.',
    permission: 'commit',
    permissionLevel: 'commit',
    run: async (input, context) => toToolResult(await runPatchCommit(input, {
      workspaceId: context.workspaceIndex.workspaceId,
      state: ensurePatchToolState(context)
    }))
  });

  registry.register({
    name: 'patch.rollback',
    description: 'Rollback the last WorkspaceTransaction.',
    permission: 'rollback',
    permissionLevel: 'rollback',
    run: async (input, context) => toToolResult(await runPatchRollback(input, {
      workspaceId: context.workspaceIndex.workspaceId,
      state: ensurePatchToolState(context)
    }))
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

function toToolResult<T>(result: PatchToolCoreResult<T>): ToolResult<T> {
  if (result.ok) {
    return ok(result.data);
  }
  return fail(result.code, result.message, result.details ?? (result.diagnostics ? { diagnostics: result.diagnostics } : undefined));
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

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
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

function asReferenceDirection(value: unknown): 'from' | 'to' | 'both' {
  return value === 'from' || value === 'to' || value === 'both' ? value : 'both';
}

function asPatchMode(value: unknown, fallback: ToolContext['mode']): PatchMode {
  if (value === 'plan' || value === 'normal' || value === 'fullPermission') return value;
  return fallback;
}
