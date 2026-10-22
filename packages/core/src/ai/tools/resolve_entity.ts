import type { RegisteredTool } from '../toolRegistry.js';
import { asEntityRelations, asOptionalString, asRecord, fail, ok } from '../toolRegistrySupport.js';
import { resolveEntity } from '.././entityResolution.js';
import { resolveChrLinkage } from '../../references/chrLinkageResolver.js';
/** resolve_entity: one domain tool declaration, schema and handler. */
export function createResolveEntityTool(): RegisteredTool {
    return {
        name: 'resolve_entity',
        description: 'Resolve a fuzzy object name or an exact native handle into bounded candidates, identity chains, '
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
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const query = asOptionalString(value.query)?.trim();
            const handle = asOptionalString(value.handle)?.trim() ?? asOptionalString(value.nativeHandle)?.trim();
            if (!query && !handle)
                return fail('INVALID_INPUT', 'resolve_entity 需要 query 或 handle/nativeHandle。');
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
    };
}
