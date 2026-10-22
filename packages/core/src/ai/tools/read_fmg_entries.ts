import type { RegisteredTool } from '../toolRegistry.js';
import { asIdList, asOptionalString, asRecord, asString, fail, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { readFmgEntries } from '../../editing/fmgEdit.js';
import { pathToFileURL } from 'node:url';
import { sourceTextPage } from '.././sourceTextPage.js';
/** read_fmg_entries: one domain tool declaration, schema and handler. */
export function createReadFmgEntriesTool(): RegisteredTool {
    return {
        name: 'read_fmg_entries',
        description: 'Read live FMG text entries from a confirmed msgbnd table. '
            + 'Pass table name (logical, e.g. Title) and entry ids. For a long entry read one id with sourceOffset/sourceLimit or nextCursor to continue its actual text. Do not treat FMG as UTF-8.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            table: 'string',
            ids: 'array',
            containerPath: 'string?',
            lang: 'string?',
            cursor: 'string?',
            sourceOffset: 'safe-integer?',
            sourceLimit: 'safe-integer?'
        },
        run: async (input, context) => {
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const value = asRecord(input);
            const table = asString(value.table);
            const ids = asIdList(value.ids);
            if (!table || ids.length === 0) {
                return fail('INVALID_INPUT', 'read_fmg_entries 需要 table、ids。');
            }
            if ((value.cursor !== undefined || value.sourceOffset !== undefined || value.sourceLimit !== undefined) && ids.length !== 1) {
                return fail('FMG_SOURCE_WINDOW_SINGLE_ENTRY', '展开正文时 ids 必须只有一个文本条目。');
            }
            const containerPath = asOptionalString(value.containerPath);
            const lang = asOptionalString(value.lang);
            const result = await readFmgEntries({
                edit: edit.session,
                table,
                ids,
                ...(containerPath ? { containerPath } : {}),
                ...(lang ? { lang } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.error.details);
            if (context.workspaceIndex && result.entries.length > 0) {
                const resolved = resolveIndexedResourceFile(context, result.containerPath, 'msg');
                const sourceUri = resolved.ok ? resolved.sourceUri : pathToFileURL(result.containerPath).href;
                const hashes = new Set(result.entries.map((entry) => entry.sourceHash).filter((hash): hash is string => Boolean(hash)));
                const revisions = new Set(result.entries.map((entry) => entry.sourceRevision).filter((revision): revision is number => revision !== undefined));
                const sourceHash = hashes.size === 1 ? [...hashes][0] : undefined;
                const sourceRevision = revisions.size === 1 ? [...revisions][0] : undefined;
                const indexedTable = context.workspaceIndex.toSymbolBundle().msgs?.find((item) => (item.entries.some((entry) => entry.sourceUri === sourceUri)
                    && (item.category === result.table || item.category?.endsWith(`/${result.table}`))));
                const category = indexedTable?.category ?? result.table;
                context.workspaceIndex.mergeMsgEntries({
                    category,
                    ...(sourceHash ? { sourceHash } : {}),
                    ...(sourceHash ? { outerFileHash: sourceHash } : {}),
                    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
                    entries: result.entries.map((entry) => ({
                        ...indexedTable?.entries.find((old) => old.textId === entry.id && old.sourceUri === sourceUri),
                        uri: indexedTable?.entries.find((old) => old.textId === entry.id && old.sourceUri === sourceUri)?.uri ?? `${sourceUri}#${result.table}/${entry.id}`,
                        sourceUri,
                        category,
                        textId: entry.id,
                        text: entry.text ?? '',
                        confidence: 'high',
                        ...(entry.sourceHash ? { sourceHash: entry.sourceHash } : {}),
                        ...(entry.sourceHash ? { outerFileHash: entry.sourceHash } : {}),
                        ...(entry.sourceRevision !== undefined ? { sourceRevision: entry.sourceRevision } : {})
                    }))
                });
                context.workspaceIndex.rebuildReferences();
                await context.onSemanticEvidenceUpdated?.([sourceUri]);
            }
            if (result.entries.length === 1 && typeof result.entries[0]!.text === 'string') {
                const entry = result.entries[0]!;
                try {
                    const resolved = resolveIndexedResourceFile(context, result.containerPath, 'msg');
                    const sourceUri = resolved.ok ? resolved.sourceUri : result.containerPath;
                    const { sourceText, ...page } = sourceTextPage({
                        text: entry.text!,
                        sourceKey: `${context.workspaceIndex?.workspaceId ?? edit.session.session.meta.workspaceId}|${sourceUri}|${result.table}|${entry.id}`,
                        sourceHash: entry.sourceHash ?? '', domain: 'fmg',
                        ...(value.sourceOffset !== undefined ? { sourceOffset: value.sourceOffset as number } : {}),
                        ...(value.sourceLimit !== undefined ? { sourceLimit: value.sourceLimit as number } : {}),
                        ...(value.cursor !== undefined ? { cursor: value.cursor as string } : {})
                    });
                    return ok({ ...result, sourceUri, entries: [{ ...entry, text: sourceText }], ...page,
                        nextActions: page.nextCursor ? [{ tool: 'read_fmg_entries',
                                args: { table: result.table, ids: [entry.id], containerPath: result.containerPath, cursor: page.nextCursor },
                                reason: '继续读取该条目的后续文本' }] : [] });
                }
                catch (error) {
                    return fail((error as {
                        code?: string;
                    }).code ?? 'SOURCE_WINDOW_FAILED', error instanceof Error ? error.message : '文本窗口读取失败。');
                }
            }
            return ok(result);
        }
    };
}
