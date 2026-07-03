import type { PatchMode, PatchProposal, ReferenceEdge, ResourceKind } from '@soulforge/shared';
import { createPatchProposal, dryRunPatchProposal } from '../patch/patchEngine.js';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';

export type ToolPermission = 'read' | 'plan' | 'write';

export interface ToolContext {
  workspaceIndex: WorkspaceIndex;
  mode: 'plan' | 'normal' | 'fullPermission';
}

export interface ToolDescriptor {
  name: string;
  description: string;
  permission: ToolPermission;
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
    this.tools.set(tool.name, tool);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, permission }) => ({ name, description, permission }));
  }

  async run(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return fail('TOOL_NOT_FOUND', `Unknown tool: ${name}`);

    if (!isToolAllowed(tool.permission, context.mode)) {
      return fail('TOOL_PERMISSION_DENIED', `Tool '${name}' requires ${tool.permission} permission in ${context.mode} mode.`);
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
    run: (_input, context) => ok(context.workspaceIndex.getStats())
  });

  registry.register({
    name: 'search_resources',
    description: 'Search indexed workspace files by path, extension, or resource kind.',
    permission: 'read',
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
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchEvents(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_map_entities',
    description: 'Search parsed map entities and regions.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchMapEntities(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_param_rows',
    description: 'Search parsed param rows.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchParamRows(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'search_text_entries',
    description: 'Search parsed text entries.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      return ok(context.workspaceIndex.searchTextEntries(asString(value.query, ''), asNumber(value.limit, 50)));
    }
  });

  registry.register({
    name: 'lookup_text_id',
    description: 'Look up one parsed text entry by numeric textId and optional category.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const textId = asNumber(value.textId, Number.NaN);
      if (!Number.isFinite(textId)) return fail('INVALID_INPUT', 'lookup_text_id requires numeric textId.');
      const category = asOptionalString(value.category);
      const found = context.workspaceIndex.lookupTextEntry(textId, category);
      if (!found) return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
      return ok(found);
    }
  });

  registry.register({
    name: 'find_references',
    description: 'Find evidence graph references connected to a URI.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'find_references requires uri.');
      const direction = asReferenceDirection(value.direction);
      return ok(context.workspaceIndex.findReferences(uri, direction));
    }
  });

  registry.register({
    name: 'explain_event',
    description: 'Build an evidence-first explanation input for one event URI.',
    permission: 'read',
    run: (input, context) => {
      const value = asRecord(input);
      const uri = asString(value.uri);
      if (!uri) return fail('INVALID_INPUT', 'explain_event requires uri.');
      const explanation = context.workspaceIndex.buildEventExplanationInput(uri);
      if (!explanation) return fail('EVENT_NOT_FOUND', `No event exists for URI: ${uri}`);
      return ok(explanation);
    }
  });

  registry.register({
    name: 'propose_text_patch',
    description: 'Create a text-only patch proposal. It does not save files.',
    permission: 'plan',
    run: (input, context) => {
      const value = asRecord(input);
      const workspaceId = context.workspaceIndex.workspaceId;
      const targetUri = asString(value.targetUri);
      const targetPath = asString(value.targetPath);
      const newText = asString(value.newText);
      const title = asString(value.title, 'AI text patch proposal');
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
    permission: 'plan',
    run: async (input) => {
      const proposal = input as PatchProposal;
      if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.changes)) {
        return fail('INVALID_INPUT', 'validate_patch requires a PatchProposal object.');
      }
      return ok(await dryRunPatchProposal(proposal));
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

function isToolAllowed(permission: ToolPermission, mode: ToolContext['mode']): boolean {
  if (permission === 'read') return true;
  if (permission === 'plan') return mode === 'plan' || mode === 'normal' || mode === 'fullPermission';
  return mode === 'fullPermission';
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
  const allowed = new Set<ResourceKind>(['event', 'map', 'param', 'msg', 'menu', 'script', 'action', 'ai', 'sfx', 'unknown']);
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
