import type { RegisteredTool } from '../toolRegistry.js';
import { asPatchMode, asRecord, asString, fail, nativeFormatHint, ok } from '../toolRegistrySupport.js';
import { createPatchProposal } from '../../patch/patchEngine.js';
/** propose_text_patch: one domain tool declaration, schema and handler. */
export function createProposeTextPatchTool(): RegisteredTool {
    return {
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
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
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
    };
}
