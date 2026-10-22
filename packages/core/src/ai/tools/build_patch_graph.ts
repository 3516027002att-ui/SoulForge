import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok } from '../toolRegistrySupport.js';
import type { PatchProposal } from '@soulforge/shared';
import { buildGraphPatchFromProposal, summarizeGraphPatch } from '../../patch/graphPatch.js';
/** build_patch_graph: one domain tool declaration, schema and handler. */
export function createBuildPatchGraphTool(): RegisteredTool {
    return {
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
    };
}
