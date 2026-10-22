import type { RegisteredTool } from '../toolRegistry.js';
import { fail, ok } from '../toolRegistrySupport.js';
import type { PatchProposal } from '@soulforge/shared';
import { dryRunPatchProposal } from '../../patch/patchEngine.js';
/** validate_patch: one domain tool declaration, schema and handler. */
export function createValidatePatchTool(): RegisteredTool {
    return {
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
    };
}
