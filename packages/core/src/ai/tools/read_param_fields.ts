import type { RegisteredTool } from '../toolRegistry.js';
import { asIdList, asNumber, asOptionalString, asRecord, asString, asStringList, fail, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { readParamFields } from '../../param/containerParamEdit.js';
import { pathToFileURL } from 'node:url';
import { parseParamFieldRefs } from '@soulforge/shared';
/** read_param_fields: one domain tool declaration, schema and handler. */
export function createReadParamFieldsTool(): RegisteredTool {
    return {
        name: 'read_param_fields',
        description: 'Read live PARAM field values from the opened gameparam container. '
            + 'Pass table, row ids, and a non-empty explicit fieldIds array on every call; '
            + 'omitting fieldIds or passing an empty array is rejected to prevent unbounded row payloads. '
            + 'Use pageSize and the returned opaque cursor to read a large field window without loading the whole result envelope. '
            + 'Copy each returned fieldId, rowIndex, and dataHash into the matching write edit; '
            + 'the physical rowIndex is required when the read returned it. '
            + 'Do not parse Smithbox XML or unpack BND yourself. Use the same explicit field ids for writes.',
        permission: 'read',
        permissionLevel: 'read',
        inputSchema: {
            table: 'string',
            rowIds: 'array',
            fieldIds: 'array',
            containerPath: 'string?',
            cursor: 'string?',
            offset: 'safe-integer?',
            pageSize: 'number?'
        },
        run: async (input, context) => {
            const value = asRecord(input);
            const table = asString(value.table);
            const rowIds = asIdList(value.rowIds);
            const fieldIds = asStringList(value.fieldIds);
            const cursor = asOptionalString(value.cursor)?.trim();
            const pageSize = value.pageSize === undefined ? undefined : Math.max(1, Math.min(128, Math.trunc(asNumber(value.pageSize, 32))));
            if (!table || rowIds.length === 0 || fieldIds.length === 0) {
                return fail('PARAM_FIELD_IDS_REQUIRED', 'read_param_fields 必须提供 table、非空 rowIds 和非空 fieldIds；请先从候选或元数据中确认真实字段 ID。');
            }
            const edit = requireEditSession(context, 'read');
            if (!('session' in edit))
                return edit;
            const containerPath = asOptionalString(value.containerPath);
            const result = await readParamFields({
                edit: edit.session,
                queries: [{ table, rowIds, fieldIds }],
                ...(containerPath ? { containerPath } : {}),
                ...(cursor ? { cursor } : {}),
                ...(typeof value.offset === 'number' ? { offset: value.offset } : {}),
                ...(pageSize !== undefined ? { pageSize } : {})
            });
            if (!result.ok)
                return fail(result.error.code, result.error.message, result.error.details);
            const resolvedContainer = context.workspaceIndex
                ? resolveIndexedResourceFile(context, result.containerPath, 'param')
                : undefined;
            const sourceUri = resolvedContainer?.ok
                ? resolvedContainer.sourceUri
                : pathToFileURL(result.containerPath).href;
            // T09 step 3: the automatic proof is confirmed by the bridge AFTER the
            // bounded projection is delivered (createAgentToolBridge), not promoted
            // here from the raw tool result.
            if (context.workspaceIndex && result.fields.length > 0) {
                // Physical identity: entry + rowIndex + rowId. A PARAM table can hold
                // duplicate logical row ids; bucketing by rowId alone merged distinct
                // physical rows into one projection.
                type FieldSnapshot = typeof result.fields[number];
                const rowsByPhysicalKey = new Map<string, {
                    rowId: number;
                    rowIndex?: number;
                    dataHash?: string;
                    entryName?: string;
                    entryIndex?: number;
                    rowName?: string;
                    fields: FieldSnapshot[];
                }>();
                for (const field of result.fields) {
                    const key = `${field.entryIndex ?? '?'}\u0000${field.entryName ?? field.table}\u0000${field.rowId}\u0000${field.rowIndex ?? '?'}`;
                    const bucket = rowsByPhysicalKey.get(key);
                    if (bucket) {
                        bucket.fields.push(field);
                    }
                    else {
                        rowsByPhysicalKey.set(key, {
                            rowId: field.rowId,
                            ...(field.rowIndex !== undefined ? { rowIndex: field.rowIndex } : {}),
                            ...(field.dataHash ? { dataHash: field.dataHash } : {}),
                            ...(field.entryName ? { entryName: field.entryName } : {}),
                            ...(field.entryIndex !== undefined ? { entryIndex: field.entryIndex } : {}),
                            ...(field.rowName ? { rowName: field.rowName } : {}),
                            fields: [field]
                        });
                    }
                }
                const provenanceFor = (fields: FieldSnapshot[]): {
                    sourceHash?: string;
                    sourceRevision?: number;
                } => {
                    const hashes = new Set(fields.map((field) => field.sourceHash).filter((hash): hash is string => Boolean(hash)));
                    const revisions = new Set(fields.map((field) => field.sourceRevision).filter((revision): revision is number => revision !== undefined));
                    return {
                        ...(hashes.size === 1 ? { sourceHash: [...hashes][0] } : {}),
                        ...(revisions.size === 1 ? { sourceRevision: [...revisions][0] } : {})
                    };
                };
                const exportProvenance = provenanceFor(result.fields);
                const changed = context.workspaceIndex.mergeParamRows({
                    paramName: table,
                    ...exportProvenance,
                    rows: [...rowsByPhysicalKey.values()].map((bucket) => ({
                        // Duplicate physical rows must stay addressable: append the
                        // physical rowIndex to the URI when the native read provided one.
                        uri: `${sourceUri}#${table}/${bucket.rowId}${bucket.rowIndex === undefined ? '' : `@${bucket.rowIndex}`}`,
                        sourceUri,
                        paramName: table,
                        ...(bucket.entryName ? { entryName: bucket.entryName } : {}),
                        ...(bucket.entryIndex !== undefined ? { entryIndex: bucket.entryIndex } : {}),
                        rowId: bucket.rowId,
                        ...(bucket.rowIndex === undefined ? {} : { rowIndex: bucket.rowIndex }),
                        ...(bucket.dataHash ? { dataHash: bucket.dataHash } : {}),
                        ...(bucket.rowName ? { rowName: bucket.rowName } : {}),
                        ...provenanceFor(bucket.fields),
                        fields: bucket.fields.map((field) => {
                            const parsedRefs = field.refs ? parseParamFieldRefs(field.refs) : undefined;
                            return {
                                ...(field.fieldId ? { fieldId: field.fieldId } : {}),
                                name: field.displayName ?? field.fieldId,
                                ...(field.description ? { description: field.description } : {}),
                                value: field.value,
                                // Trusted-metadata provenance only: the refs string came from
                                // the same native document read as the row bytes.
                                ...(parsedRefs && parsedRefs.targets.length > 0 ? { refs: parsedRefs.targets, refsProvenance: 'trusted-metadata' as const } : {}),
                                ...(parsedRefs && parsedRefs.rejected.length > 0 ? { refsRejected: parsedRefs.rejected, refsProvenance: 'trusted-metadata' as const } : {})
                            };
                        })
                    }))
                });
                if (changed) {
                    context.workspaceIndex.rebuildReferences();
                    await context.onSemanticEvidenceUpdated?.([sourceUri]);
                }
            }
            // T12 step 8: reading NpcParam no longer auto-attaches a crossReferences
            // web. Related context is obtained explicitly via find_references
            // (detail=context) or resolve_entity, so a plain field read stays light.
            const indexedFile = resolvedContainer?.ok
                ? context.workspaceIndex?.getFile(resolvedContainer.sourceUri)
                : undefined;
            return ok({
                ...result,
                sourceUri,
                ...(indexedFile?.relativePath ? { sourcePath: indexedFile.relativePath } : {})
            });
        }
    };
}
