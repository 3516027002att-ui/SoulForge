/**
 * MAP (MSB) reference provider.
 *
 * One identity + location per matching instance. Instances that share modelName
 * are never merged. Confirmed edges only when native fields (npcParam /
 * thinkParam / entityId) are present on the part. Same map name without a
 * target param field is NOT a control relation (diagnostic only).
 * entityId, nativeObjectKey, and name are preserved as separate fields.
 */
import type {
  ProviderRelationDraft,
  ReferenceProvider,
  ReferenceProviderCapability,
  ReferenceProviderCollectInput,
  ReferenceProviderCollectResult
} from './referenceProviderRegistry.js';

interface MsbPartLike {
  name?: string;
  nativeOffset?: number;
  typeId?: number;
  modelIndex?: number;
  modelName?: string;
  posX?: number;
  posY?: number;
  posZ?: number;
  internalEntryId?: number;
  entityId?: number;
  npcParamId?: number;
  thinkParamId?: number;
  entityParamId?: number;
  chrId?: number;
  nativeObjectKey?: string;
}

interface MsbDocumentLike {
  sourceUri?: string;
  mapId?: string;
  parts?: MsbPartLike[];
  models?: Array<{ name?: string; typeId?: number; nativeOffset?: number }>;
  sourceHash?: string;
  version?: number;
}

interface MapTargetLike {
  domain?: 'map' | string;
  sourceUri: string;
  nativeObjectKey?: string;
  mapId?: string;
  name?: string;
  workspaceId?: string;
  outerId?: string;
  entityId?: number;
  internalEntryId?: number;
  modelIndex?: number;
  modelName?: string;
  npcParamId?: number;
  thinkParamId?: number;
  entityParamId?: number;
  nativeOffset?: number;
  typeId?: number;
  parts?: MsbPartLike[];
  document?: MsbDocumentLike;
}

export function createMapReferenceProvider(): ReferenceProvider {
  return {
    id: 'map',
    domains: ['map'],
    capabilities(): ReferenceProviderCapability[] {
      return [
        {
          resourceKind: 'map',
          formatFamilies: ['msb'],
          support: 'supported',
          relationKinds: ['msb_param_link', 'msb_entity_instance'],
          nativeReader: 'read_msb_parts',
          writerSupported: true
        }
      ];
    },
    async collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult> {
      const diagnostics: ReferenceProviderCollectResult['diagnostics'] = [];
      const coverageNotes: ReferenceProviderCollectResult['coverageNotes'] = [];
      const relations: ProviderRelationDraft[] = [];

      const target = input.target as MapTargetLike | null | undefined;
      if (!target || typeof target.sourceUri !== 'string' || target.sourceUri.trim() === '') {
        diagnostics.push({
          code: 'MAP_TARGET_REQUIRED',
          message: 'MAP provider 需要带 sourceUri 的 map 目标。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'map', status: 'failed', notes: ['target_missing'] });
        return { relations, coverageNotes, diagnostics };
      }

      const sourceUri = target.sourceUri;
      const workspaceId = target.workspaceId ?? 'unknown';
      const mapId = target.mapId ?? '';

      let parts: MsbPartLike[] = [];
      let documentSourceHash: string | undefined;

      if (Array.isArray(target.parts) && target.parts.length > 0) {
        parts = target.parts;
      }
      if (Array.isArray(target.document?.parts) && (target.document?.parts?.length ?? 0) > 0) {
        parts = target.document!.parts!;
        documentSourceHash = target.document?.sourceHash;
      }

      if (parts.length === 0 && input.ports.readMsbDocument) {
        try {
          const docRaw = await input.ports.readMsbDocument({
            domain: 'map',
            sourceUri,
            mapId,
            workspaceId,
            ...(target.nativeObjectKey ? { nativeObjectKey: target.nativeObjectKey } : {})
          });
          const doc = (docRaw ?? null) as MsbDocumentLike | { data?: MsbDocumentLike; parts?: MsbPartLike[] } | null;
          if (doc) {
            const nested = 'data' in doc && doc.data ? doc.data : (doc as MsbDocumentLike);
            const docParts = (doc as { parts?: MsbPartLike[] }).parts ?? nested.parts ?? [];
            if (Array.isArray(docParts) && docParts.length > 0) {
              parts = docParts;
              documentSourceHash = nested.sourceHash;
            }
          }
        } catch (error) {
          diagnostics.push({
            code: 'MAP_DOCUMENT_READ_FAILED',
            message: `readMsbDocument 失败：${error instanceof Error ? error.message : String(error)}`,
            severity: 'warning'
          });
          coverageNotes.push({ domain: 'map', status: 'partial', notes: ['msb_document_read_failed'] });
        }
      }

      // Seed the target instance fields when the selector itself carries them.
      const targetInstance: MsbPartLike = {
        ...(target.name !== undefined ? { name: target.name } : {}),
        ...(target.nativeObjectKey !== undefined ? { nativeObjectKey: target.nativeObjectKey } : {}),
        ...(target.entityId !== undefined ? { entityId: target.entityId } : {}),
        ...(target.internalEntryId !== undefined ? { internalEntryId: target.internalEntryId } : {}),
        ...(target.modelIndex !== undefined ? { modelIndex: target.modelIndex } : {}),
        ...(target.modelName !== undefined ? { modelName: target.modelName } : {}),
        ...(target.npcParamId !== undefined ? { npcParamId: target.npcParamId } : {}),
        ...(target.thinkParamId !== undefined ? { thinkParamId: target.thinkParamId } : {}),
        ...(target.entityParamId !== undefined ? { entityParamId: target.entityParamId } : {}),
        ...(target.nativeOffset !== undefined ? { nativeOffset: target.nativeOffset } : {}),
        ...(target.typeId !== undefined ? { typeId: target.typeId } : {})
      };

      const targetKey = target.nativeObjectKey ?? '';
      const targetName = target.name ?? '';
      const targetEntityId = toSafeInteger(target.entityId);

      // Collect matching instances — never merge parts that share modelName.
      const matching: MsbPartLike[] = [];

      const selfHasAnyNative =
        targetInstance.entityId !== undefined ||
        targetInstance.npcParamId !== undefined ||
        targetInstance.thinkParamId !== undefined ||
        targetInstance.entityParamId !== undefined ||
        targetKey !== '' ||
        targetName !== '' ||
        targetEntityId !== null;

      if (selfHasAnyNative) {
        matching.push(targetInstance);
      }

      // Map-scope query (no instance discriminator): inventory every provided part
      // as its own instance. Shared modelName must not collapse identities.
      const mapScopeQuery = !selfHasAnyNative;
      if (mapScopeQuery) {
        for (const part of parts) {
          matching.push(part);
        }
      } else {
        for (const part of parts) {
          const partKey = part.nativeObjectKey ?? '';
          const partName = part.name ?? '';
          const partEntityId = toSafeInteger(part.entityId);

          const keyMatch = targetKey !== '' && partKey !== '' && partKey === targetKey;
          const entityMatch =
            targetEntityId !== null && partEntityId !== null && partEntityId === targetEntityId && partEntityId !== 0;
          // Name match alone is weaker: used to surface instances, never to invent control edges.
          const nameMatch = targetName !== '' && partName !== '' && partName === targetName;

          if (keyMatch || entityMatch) {
            matching.push(part);
            continue;
          }
          if (nameMatch) {
            matching.push(part);
          }
        }
      }

      // Deduplicate by identity key while keeping separate instances that share modelName.
      const seenKeys = new Set<string>();
      const uniqueInstances: MsbPartLike[] = [];
      for (const part of matching) {
        const key = instanceKey(sourceUri, part);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        uniqueInstances.push(part);
      }

      let confirmedInstance = 0;
      let confirmedParamLink = 0;
      let nameOnlyWithoutParamField = 0;
      let modelNameCollisions = 0;

      // Detect modelName collisions for coverage notes (never merge).
      const modelNameCounts = new Map<string, number>();
      for (const part of uniqueInstances) {
        const model = part.modelName ?? (part.modelIndex !== undefined ? `idx:${part.modelIndex}` : '');
        if (!model) continue;
        modelNameCounts.set(model, (modelNameCounts.get(model) ?? 0) + 1);
      }
  for (const count of modelNameCounts.values()) {
        if (count > 1) modelNameCollisions += count;
      }

      for (const part of uniqueInstances) {
        const identity = makeMapInstanceIdentity(workspaceId, sourceUri, mapId, part);
        const location = {
          sourceUri,
          domain: 'map' as const,
          locator: identity.objectKey,
          ...(part.nativeOffset !== undefined ? { nativeOffset: part.nativeOffset } : {}),
          ...(part.posX !== undefined || part.posY !== undefined || part.posZ !== undefined
            ? {
                // transform lives in evidence.fieldFacts, not ReferenceLocation
              }
            : {})
        };

        const hasEntityId = part.entityId !== undefined && toSafeInteger(part.entityId) !== null;
        const npcParam = toSafeInteger(part.npcParamId);
        const thinkParam = toSafeInteger(part.thinkParamId);
        const entityParam = toSafeInteger(part.entityParamId);
        const hasAnyParamField = npcParam !== null || thinkParam !== null || entityParam !== null;

        // name-only / map-name-only without param fields → diagnostic, not control relation.
        if (!hasEntityId && !hasAnyParamField) {
          const nameLike = part.name ?? targetName;
          if (nameLike) {
            nameOnlyWithoutParamField += 1;
            diagnostics.push({
              code: 'MAP_NAME_NOT_CONTROL_RELATION',
              message: `实例 ${nameLike} 仅有名称/同图信息，缺少 npcParam/thinkParam/entityId 等原生字段，不产生控制关系。`,
              severity: 'info'
            });
          }
          continue;
        }

        if (hasEntityId && part.entityId !== undefined) {
          const entityId = toSafeInteger(part.entityId)!;
          confirmedInstance += 1;
          relations.push({
            relationKind: 'msb_entity_instance',
            certainty: 'confirmed',
            from: identity,
            to: identity,
            evidence: {
              version: {
                ...(documentSourceHash ? { outerFileHash: documentSourceHash } : {}),
                readerSchema: 'msb-bridge-v1'
              },
              location,
              statement: {
                kind: 'field-assignment',
                text: `entityId=${entityId}; nativeObjectKey=${part.nativeObjectKey ?? part.name ?? ''}; name=${part.name ?? ''}`,
                language: 'msb'
              },
              fieldFacts: {
                fieldId: 'entityId',
                value: entityId,
                metadataRule: 'msb_native_field:entityId',
                targetStatus: 'unverified'
              },
              ruleName: 'msb_entity_instance:entityId'
            }
          });
        }

        // Confirmed param links only when native param fields are present.
        const paramLinks: Array<{ fieldId: string; value: number; paramName: string }> = [];
        if (npcParam !== null) {
          paramLinks.push({ fieldId: 'npcParamId', value: npcParam, paramName: 'NpcParam' });
        }
        if (thinkParam !== null) {
          paramLinks.push({ fieldId: 'thinkParamId', value: thinkParam, paramName: 'ThinkParam' });
        }
        if (entityParam !== null) {
          paramLinks.push({ fieldId: 'entityParamId', value: entityParam, paramName: 'EntityParam' });
        }

        for (const link of paramLinks) {
          // Same map name without target param field is NOT a control relation.
          // Presence of the native field on THIS part is what confirms the edge.
          confirmedParamLink += 1;
          relations.push({
            relationKind: 'msb_param_link',
            certainty: 'confirmed',
            from: identity,
            to: makeParamTargetIdentity(workspaceId, link.paramName, link.value),
            evidence: {
              version: {
                ...(documentSourceHash ? { outerFileHash: documentSourceHash } : {}),
                readerSchema: 'msb-bridge-v1'
              },
              location,
              statement: {
                kind: 'field-assignment',
                text: `${link.fieldId}=${link.value}`,
                language: 'msb'
              },
              fieldFacts: {
                fieldId: link.fieldId,
                value: link.value,
                metadataRule: `msb_native_field:${link.fieldId}`,
                targetStatus: 'unverified'
              },
              ruleName: `msb_param_link:${link.fieldId}`
            },
            limitNote: '由 MSB part 原生参数字段确认；目标 param 行是否存在另核'
          });
        }

        // If the only "match" was same map name and part has no native param field,
        // do not emit any additional control edge — already handled above via continue
        // when both entityId and param fields are absent.
        if (!hasAnyParamField && hasEntityId && targetName && (part.name ?? '') === targetName) {
          diagnostics.push({
            code: 'MAP_SAME_NAME_NOT_CONTROL',
            message: `与目标同名的地图实例 ${part.name ?? ''} 仅有 entityId，无 npcParam/thinkParam 字段，不据此生成额外控制关系。`,
            severity: 'info'
          });
        }
      }

      if (modelNameCollisions > 1) {
        coverageNotes.push({
          domain: 'map',
          status: 'partial',
          notes: [`shared_model_name_instances_kept_separate:${modelNameCollisions}`]
        });
      }

      const notes: string[] = [
        `instances:${uniqueInstances.length}`,
        `msb_entity_instance_confirmed:${confirmedInstance}`,
        `msb_param_link_confirmed:${confirmedParamLink}`,
        `name_only_without_param_field:${nameOnlyWithoutParamField}`,
        'entityId_nativeObjectKey_name_preserved_separately'
      ];
      let status: 'complete' | 'partial' | 'unsupported' | 'failed' = 'complete';
      if (parts.length === 0 && uniqueInstances.length <= 1) {
        notes.push('no_msb_parts_payload');
        status = 'partial';
      }
      if (nameOnlyWithoutParamField > 0) {
        status = 'partial';
        notes.push('name_only_matches_are_diagnostics_not_control_edges');
      }
      coverageNotes.push({ domain: 'map', status, notes });

      return { relations, coverageNotes, diagnostics };
    }
  };
}

function toSafeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function instanceKey(sourceUri: string, part: MsbPartLike): string {
  const nativeObjectKey = part.nativeObjectKey ?? '';
  const name = part.name ?? '';
  const entityId = part.entityId !== undefined ? String(part.entityId) : '';
  const offset = part.nativeOffset !== undefined ? String(part.nativeOffset) : '';
  const entry = part.internalEntryId !== undefined ? String(part.internalEntryId) : '';
  return JSON.stringify([sourceUri, nativeObjectKey, name, entityId, offset, entry]);
}

function makeMapInstanceIdentity(workspaceId: string, sourceUri: string, mapId: string, part: MsbPartLike) {
  const name = part.name ?? '';
  const nativeObjectKey = part.nativeObjectKey ?? (name ? `name:${name}` : `offset:${part.nativeOffset ?? 0}`);
  const entityId = toSafeInteger(part.entityId);
  return {
    workspaceId,
    domain: 'map' as const,
    sourceUri,
    outerId: nativeObjectKey,
    childChain: ['map', mapId || 'unknown', 'part', name || nativeObjectKey],
    namespace: 'map_part',
    objectKey: nativeObjectKey,
    // Preserve entityId vs nativeObjectKey vs name as separate fields.
    ...(entityId !== null ? { rowId: entityId } : {}),
    ...(part.internalEntryId !== undefined ? { entryIndex: part.internalEntryId } : {}),
    nativeObjectKey,
    ...(name ? { label: name } : {}),
    ...(name ? { entryName: name } : {}),
    // Discriminators kept on the draft identity for projection/tests.
    discriminators: {
      entityId: entityId ?? null,
      nativeObjectKey,
      name: name || null,
      mapId: mapId || null,
      modelIndex: part.modelIndex ?? null,
      modelName: part.modelName ?? null,
      nativeOffset: part.nativeOffset ?? null,
      internalEntryId: part.internalEntryId ?? null,
      npcParamId: toSafeInteger(part.npcParamId),
      thinkParamId: toSafeInteger(part.thinkParamId),
      entityParamId: toSafeInteger(part.entityParamId)
    }
  };
}

function makeParamTargetIdentity(workspaceId: string, paramName: string, rowId: number) {
  return {
    workspaceId,
    domain: 'param' as const,
    sourceUri: `param/${paramName}`,
    outerId: paramName,
    childChain: [paramName],
    namespace: paramName,
    objectKey: `${paramName}#${rowId}`,
    rowId,
    entryName: paramName,
    label: `${paramName}#${rowId}`
  };
}
