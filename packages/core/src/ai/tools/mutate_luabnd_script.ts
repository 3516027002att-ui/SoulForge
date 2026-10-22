import type { RegisteredTool } from '../toolRegistry.js';
import { asOptionalString, asRecord, asString, fail, finalizeCommittedToolResult, requireEditSession } from '../toolRegistrySupport.js';
import { setLuabndScript } from '../../editing/luabndEdit.js';
/** mutate_luabnd_script: one domain tool declaration, schema and handler. */
export function createMutateLuabndScriptTool(): RegisteredTool {
    return {
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
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            const childPath = asString(value.childPath);
            if (!file || !childPath)
                return fail('INVALID_INPUT', 'mutate_luabnd_script ��Ҫ file �� childPath��');
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
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            return finalizeCommittedToolResult({ data: result, changedSources: [result.containerPath], context });
        }
    };
}
