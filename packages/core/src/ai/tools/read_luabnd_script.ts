import type { RegisteredTool } from '../toolRegistry.js';
import { asOptionalString, asRecord, asString, canonicalScriptSourceUri, fail, nativePathFromFileToken, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { readLuabndScript } from '../../editing/luabndEdit.js';
import { projectScriptReadExport } from '../../references/scriptReadProjection.js';
import { sourceTextPage } from '.././sourceTextPage.js';
/** read_luabnd_script: one domain tool declaration, schema and handler. */
export function createReadLuabndScriptTool(): RegisteredTool {
    return {
        name: 'read_luabnd_script',
        description: 'Read a native Lua AI script inside a *.luabnd.dcx container (such as script/m11_01_00_00.luabnd.dcx or aicommon.luabnd.dcx). '
            + 'file: relative or absolute path (e.g. script/m11_01_00_00.luabnd.dcx); childPath: script name (e.g. 540000_battle.lua; omit to list scripts). '
            + 'Returns the actual source/decompiled text with sourceOffset/sourceLimit character windows and line locations. '
            + 'Use nextCursor with the same file/childPath to read the remaining source; sourceTextComplete states whether the delivered view is the whole script.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            file: 'string',
            childPath: 'string?',
            expectedContainerHash: 'string?',
            expectedChildHash: 'string?',
            sourceOffset: 'safe-integer?',
            sourceLimit: 'safe-integer?',
            cursor: 'string?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const file = asString(value.file);
            const childPath = asOptionalString(value.childPath);
            if ((value.cursor !== undefined || value.sourceOffset !== undefined || value.sourceLimit !== undefined) && !childPath) {
                return fail('SCRIPT_CHILD_REQUIRED', '展开源码需要指定 childPath。');
            }
            if (!file)
                return fail('INVALID_INPUT', 'read_luabnd_script ��Ҫ file��');
            const expectedContainerHash = asOptionalString(value.expectedContainerHash);
            const expectedChildHash = asOptionalString(value.expectedChildHash);
            const resolvedFile = resolveIndexedResourceFile(context, file, 'script');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const result = await readLuabndScript({
                edit: edit.session,
                file: nativePathFromFileToken(resolvedFile.path),
                ...(context.signal ? { signal: context.signal } : {}),
                ...(childPath ? { childPath } : {}),
                ...(expectedContainerHash ? { expectedContainerHash } : {}),
                ...(expectedChildHash ? { expectedChildHash } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.diagnostics);
            if (context.workspaceIndex && childPath) {
                const sourceUri = canonicalScriptSourceUri(context, result.containerPath);
                const script = result.script;
                const existing = context.workspaceIndex.toSymbolBundle().scripts?.find((item) => item.sourceUri === sourceUri);
                const sourceRevision = context.workspaceIndex.getFile(sourceUri)?.mtimeMs;
                context.workspaceIndex.upsertScriptExport(projectScriptReadExport({
                    sourceUri,
                    childPath,
                    script,
                    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
                    ...(existing ? { existing } : {})
                }));
                context.workspaceIndex.rebuildReferences();
                await context.onSemanticEvidenceUpdated?.([sourceUri]);
            }
            if (childPath && typeof result.script.sourceText === 'string') {
                try {
                    const sourceUri = canonicalScriptSourceUri(context, result.containerPath);
                    const { sourceText, ...page } = sourceTextPage({
                        text: result.script.sourceText,
                        sourceKey: `${context.workspaceIndex?.workspaceId ?? edit.session.session.meta.workspaceId}|${sourceUri}!/${childPath}`,
                        sourceHash: result.script.sourceHash,
                        domain: 'script',
                        ...(value.sourceOffset !== undefined ? { sourceOffset: value.sourceOffset as number } : {}),
                        ...(value.sourceLimit !== undefined ? { sourceLimit: value.sourceLimit as number } : {}),
                        ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {})
                    });
                    const { textPreview: _preview, derivedSource: _derived, embeddedSymbols: _symbols, ...snapshot } = result.script;
                    return ok({
                        ...result,
                        sourceUri,
                        childPath,
                        script: { ...snapshot, sourceText, sourceTextComplete: page.sourceTextComplete },
                        ...page,
                        nextActions: page.nextCursor ? [{
                                tool: 'read_luabnd_script',
                                args: { file: sourceUri, childPath, cursor: page.nextCursor },
                                reason: '继续读取后续源码'
                            }] : []
                    });
                }
                catch (error) {
                    return fail((error as {
                        code?: string;
                    }).code ?? 'SOURCE_WINDOW_FAILED', error instanceof Error ? error.message : '源码窗口读取失败。');
                }
            }
            return ok(result);
        }
    };
}
