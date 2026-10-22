import type { RegisteredTool } from '../toolRegistry.js';
import { MSB_TRANSFORM_FIELDS, asMsbTransformEdits, asRecord, asString, fail, finalizeCommittedToolResult, ok, requireEditSession, resolveIndexedResourceFile } from '../toolRegistrySupport.js';
import { executeMapTransaction, loadMapDocument } from '../../editing/mapService.js';
import type { MsbPartTransformEdit } from '../../editing/msbEdit.js';
import { parseMapAddress } from '@soulforge/shared';
import type { MapEditTransaction, MapPartEntity } from '@soulforge/shared';
/** mutate_msb_part_transform: one domain tool declaration, schema and handler. */
export function createMutateMsbPartTransformTool(): RegisteredTool {
    return {
        name: 'mutate_msb_part_transform',
        description: 'Set MSB part position/rotation/scale through Patch Engine (write-msb '
            + 'msb_set_part_position / msb_set_part_transform). file accepts the concrete .msb/.msb.dcx '
            + 'path or a unique sourceUri from search_map_entities; a logical map id alone is resolved '
            + 'only when the workspace index has one match. edits: [{ address: m11_01_00_00#c1050_0000, '
            + 'nativeOffset, posX?, posY?, posZ?, rotX?, rotY?, rotZ?, scaleX?, scaleY?, scaleZ? }].',
        permission: 'commit',
        permissionLevel: 'commit',
        inputSchema: { file: 'string', edits: 'array' },
        run: async (input, context) => {
            const value = asRecord(input);
            if (value.domain && value.domain !== 'map') {
                return fail('DOMAIN_CROSSOVER_REJECTED', `MSB 变换工具不能接收 ${value.domain} 领域的请求。`);
            }
            if (value.fieldKind && value.fieldKind !== 'native_value') {
                return fail('FIELD_KIND_NON_NATIVE', `${value.fieldKind} 不是原生字段类型，不能写入 MSB。`);
            }
            const file = asString(value.file);
            const edits = asMsbTransformEdits(value.edits);
            if (!file)
                return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要 file。');
            if (!edits.ok)
                return fail(edits.code, edits.message);
            if (edits.edits.length === 0)
                return fail('INVALID_INPUT', 'mutate_msb_part_transform 需要非空 edits 数组。');
            for (const item of edits.edits) {
                if (/^[a-z0-9_]+#A\d/i.test(item.address)) {
                    return fail('DOMAIN_CROSSOVER_REJECTED', `MSB 变换工具不能接收 TAE 动作地址：${item.address}`);
                }
                const record = item as unknown as Record<string, unknown>;
                if (record.valueKind === 'display_label' || record.valueKind === 'external_metadata') {
                    return fail('FIELD_KIND_NON_NATIVE', 'display_label / external_metadata 不能作为 MSB 原生坐标写入。');
                }
            }
            const edit = requireEditSession(context, 'write');
            if (!('session' in edit))
                return edit;
            const resolvedFile = resolveIndexedResourceFile(context, file, 'map');
            if (!resolvedFile.ok)
                return fail(resolvedFile.code, resolvedFile.message, resolvedFile.details);
            const loaded = await loadMapDocument(edit.session, resolvedFile.path);
            if (!loaded.ok)
                return fail(loaded.error.code, loaded.error.message);
            const canonicalEdits: Array<{
                item: MsbPartTransformEdit;
                target: string;
                part: MapPartEntity;
            }> = [];
            for (const item of edits.edits) {
                if (item.nativeOffset === undefined) {
                    return fail('MSB_NATIVE_OFFSET_REQUIRED', `${item.address} 写入必须携带 nativeOffset；地址/名称仅作诊断，不能作为唯一目标。`);
                }
                const parsed = parseMapAddress(item.address);
                if (!parsed?.name)
                    return fail('MSB_ADDRESS_INVALID', `无法解析 MSB part 地址：${item.address}`);
                const resolved = loaded.sceneGraph.resolveNativeIdentity({
                    family: 'part',
                    nativeOffset: item.nativeOffset,
                    expectedName: parsed.name
                });
                if (!resolved.ok)
                    return fail(resolved.code, `MSB native identity 未唯一解析：${item.address}@${item.nativeOffset}`);
                if (resolved.entity.kind !== 'part')
                    return fail('MSB_ENTITY_KIND_INVALID', `MSB native identity 不是 Part：${item.address}@${item.nativeOffset}`);
                if (!MSB_TRANSFORM_FIELDS.some((field) => item[field] !== undefined)) {
                    return fail('MSB_EDIT_EMPTY', `${item.address} 没有任何要写入的变换字段。`);
                }
                canonicalEdits.push({ item, target: resolved.entity.stableKey, part: resolved.entity });
            }
            const transaction: MapEditTransaction = {
                id: `tx-agent-msb-${Date.now()}`,
                mapId: loaded.doc.mapId,
                baseRevision: loaded.doc.revision,
                description: `Agent MSB Part 变换 (${canonicalEdits.length} 项)`,
                author: 'agent',
                operations: canonicalEdits.map(({ item, target, part }) => ({
                    kind: 'set_transform' as const,
                    target,
                    ...(item.posX !== undefined || item.posY !== undefined || item.posZ !== undefined
                        ? { position: [
                                item.posX ?? part.transform.position[0],
                                item.posY ?? part.transform.position[1],
                                item.posZ ?? part.transform.position[2]
                            ] as [
                                number,
                                number,
                                number
                            ] }
                        : {}),
                    ...(item.rotX !== undefined || item.rotY !== undefined || item.rotZ !== undefined
                        ? { rotation: [
                                item.rotX ?? part.transform.rotation[0],
                                item.rotY ?? part.transform.rotation[1],
                                item.rotZ ?? part.transform.rotation[2]
                            ] as [
                                number,
                                number,
                                number
                            ] }
                        : {}),
                    ...(item.scaleX !== undefined || item.scaleY !== undefined || item.scaleZ !== undefined
                        ? { scale: [
                                item.scaleX ?? part.transform.scale[0],
                                item.scaleY ?? part.transform.scale[1],
                                item.scaleZ ?? part.transform.scale[2]
                            ] as [
                                number,
                                number,
                                number
                            ] }
                        : {})
                })),
                timestamp: Date.now()
            };
            const result = await executeMapTransaction(edit.session, resolvedFile.path, transaction);
            if (!result.ok)
                return fail(result.error?.code ?? 'MSB_TRANSACTION_FAILED', result.error?.message ?? 'MSB 地图事务失败。', result.error?.details);
            return finalizeCommittedToolResult({
                data: { ...result, status: result.verification ?? 'completed' },
                changedSources: [resolvedFile.path],
                context
            });
        }
    };
}
