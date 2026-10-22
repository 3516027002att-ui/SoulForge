import type { RegisteredTool } from '../toolRegistry.js';
import { asNumber, asOptionalString, asRecord, fail, ok } from '../toolRegistrySupport.js';
import { buildTextAiContext, renderTextAiPrompt } from '.././aiContextBuilder.js';
/** explain_text_entry: one domain tool declaration, schema and handler. */
export function createExplainTextEntryTool(): RegisteredTool {
    return {
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
            if (ws === null)
                return fail('WORKSPACE_REQUIRED', '这次工具需要先打开 Mod 工作区。');
            const value = asRecord(input);
            const textId = asNumber(value.textId, Number.NaN);
            if (!Number.isFinite(textId))
                return fail('INVALID_INPUT', 'explain_text_entry requires numeric textId.');
            const category = asOptionalString(value.category);
            const maxReferences = asNumber(value.maxReferences, 80);
            const maxMarkdownChars = asNumber(value.maxMarkdownChars, 24000);
            const matches = ws.lookupTextEntries(textId, category);
            if (matches.length === 0)
                return fail('TEXT_ENTRY_NOT_FOUND', `No text entry exists for textId ${textId}.`, { category });
            const contexts = matches.map((entry) => {
                const references = ws.findReferences(entry.uri, 'to');
                const aiContext = buildTextAiContext(entry, references, { maxReferences, maxMarkdownChars });
                return { context: aiContext, prompt: renderTextAiPrompt(aiContext) };
            });
            return ok({ textId, category, contexts });
        }
    };
}
