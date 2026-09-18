/**
 * RESOURCE reference provider.
 *
 * Covers resource kinds not owned by param/event/script/map providers so
 * registry.assertExhaustiveKinds() can pass, while still producing real
 * relations for FMG mappings, decoded TAE fields, and container members.
 *
 * Rules:
 * - FMG param→text links only via explicit mapping payload; same numeric id
 *   in a different category/language is NOT the same item.
 * - TAE: only decoded template fields; undecoded params → no confirmed edge.
 * - BND/ANIBND/LUABND/MSGBND: contains/member edges from real listContainerMembers.
 * - esd/gparam/flver/tpf/mtd/fxr/hkx-like → partial/unsupported + uncoveredReason.
 */
import { ALL_RESOURCE_KINDS } from '@soulforge/shared';
import type { ResourceKind } from '@soulforge/shared';
import type {
  ProviderRelationDraft,
  ReferenceProvider,
  ReferenceProviderCapability,
  ReferenceProviderCollectInput,
  ReferenceProviderCollectResult,
  ReferenceProviderSupport
} from './referenceProviderRegistry.js';

interface ResourceTargetLike {
  domain?: 'resource' | 'other' | 'fmg' | 'tae' | 'msg' | string;
  sourceUri: string;
  childChain?: string[];
  nativeObjectKey?: string;
  workspaceId?: string;
  category?: string;
  language?: string;
  textId?: number;
  entryIndex?: number;
  formatFamily?: string;
  resourceKind?: string;
  /** Explicit param→text mapping payload for FMG links. */
  textMapping?: Array<{
    paramName?: string;
    fieldId?: string;
    paramRowId?: number;
    textId?: number;
    category?: string;
    language?: string;
    fmgSourceUri?: string;
  }>;
  /** TAE decoded template fields. */
  taeFields?: Array<{ name: string; value: string | number | boolean }>;
  taeEntryIndex?: number;
  animId?: number;
  eventIndex?: number;
  /** Undecoded TAE parameter preview; never becomes a confirmed semantic edge. */
  parameterBytesHex?: string;
  /** Container members when already present on the target. */
  containerMembers?: Array<{
    name?: string;
    index?: number;
    childId?: string;
    size?: number;
    formatKind?: string;
    childUri?: string;
  }>;
}

/** Kinds already claimed as primary support by other providers. */
const OTHER_PROVIDER_PRIMARY_KINDS = new Set<ResourceKind>(['param', 'event', 'script', 'ai', 'map']);

/**
 * Format families that map into ResourceKind other/chr/obj/sfx/unknown.
 * These stay partial/unsupported with uncoveredReason — they do not block
 * core-domain relations.
 */
const LOW_SEMANTIC_FORMAT_REASONS: Array<{
  kinds: ResourceKind[];
  formatFamilies: string[];
  support: ReferenceProviderSupport;
  reason: string;
}> = [
  {
    kinds: ['menu'],
    formatFamilies: ['fmg', 'msgbnd', 'menu'],
    support: 'partial',
    reason: 'menu 文本沿用 FMG 映射规则；无显式映射时不确认 param→text 边'
  },
  {
    kinds: ['action'],
    formatFamilies: ['tae', 'anibnd'],
    support: 'partial',
    reason: '仅解码模板字段产生 confirmed 边；未解码参数体不产生语义边'
  },
  {
    kinds: ['sfx'],
    formatFamilies: ['fxr', 'bnd', 'sfxbnd'],
    support: 'partial',
    reason: '仅登记容器成员 contains 边；fxr 内部语义尚未建立唯一规则'
  },
  {
    kinds: ['chr'],
    formatFamilies: ['chrbnd', 'bnd', 'flver', 'hkx', 'tpf'],
    support: 'partial',
    reason: 'chr 容器仅产出成员 contains 边；hkx/flver/tpf 不伪造控制关系'
  },
  {
    kinds: ['obj'],
    formatFamilies: ['objbnd', 'bnd', 'flver', 'tpf', 'mtd'],
    support: 'partial',
    reason: 'obj 容器仅产出成员 contains 边；mtd/flver/tpf 无唯一语义规则'
  },
  {
    kinds: ['other'],
    formatFamilies: ['esd', 'gparam', 'tpf', 'mtd', 'fxr', 'hkx', 'bnd', 'luabnd', 'msgbnd'],
    support: 'partial',
    reason: 'esd/gparam/tpf/mtd/fxr/hkx 等格式暂无唯一引用规则，仅容器成员边'
  },
  {
    kinds: ['unknown'],
    formatFamilies: ['*'],
    support: 'unsupported',
    reason: '未识别格式不伪造关系'
  }
];

export function createResourceReferenceProvider(): ReferenceProvider {
  return {
    id: 'resource',
    domains: ['resource', 'other', 'fmg', 'tae', 'msg'],
    capabilities(): ReferenceProviderCapability[] {
      const rows: ReferenceProviderCapability[] = [];

      // Exhaustiveness: every ALL_RESOURCE_KINDS value must appear in the
      // union of all providers' capabilities. Param/event/script/map cover
      // their primary kinds; this provider registers the remainder AND also
      // registers coverage rows for fmg/tae/msg formats.
      const covered = new Set<ResourceKind>(OTHER_PROVIDER_PRIMARY_KINDS);

      // Primary semantic rows this provider actually implements.
      rows.push({
        resourceKind: 'msg',
        formatFamilies: ['fmg', 'msgbnd'],
        support: 'partial',
        relationKinds: ['param_fmg_text', 'container_member'],
        nativeReader: 'read_fmg_entries',
        writerSupported: true,
        uncoveredReason: 'param→text 仅经显式 mapping payload；跨 category/language 同数值不是同一物品'
      });
      rows.push({
        resourceKind: 'menu',
        formatFamilies: ['fmg', 'msgbnd', 'menu'],
        support: 'partial',
        relationKinds: ['param_fmg_text', 'container_member'],
        nativeReader: 'read_fmg_entries',
        writerSupported: true,
        uncoveredReason: 'menu FMG 同样要求显式映射'
      });
      rows.push({
        resourceKind: 'action',
        formatFamilies: ['tae', 'anibnd'],
        support: 'partial',
        relationKinds: ['tae_motion_member', 'container_member'],
        nativeReader: 'read_tae_events',
        writerSupported: true,
        uncoveredReason: '仅 decoded template fields 产生 confirmed 边；undecoded 参数体不产生语义边'
      });
      rows.push({
        resourceKind: 'sfx',
        formatFamilies: ['fxr', 'bnd', 'sfxbnd'],
        support: 'partial',
        relationKinds: ['container_member'],
        nativeReader: 'container inventory',
        writerSupported: false,
        uncoveredReason: 'fxr 内部语义规则未建立；仅容器成员边'
      });
      rows.push({
        resourceKind: 'chr',
        formatFamilies: ['chrbnd', 'bnd', 'flver', 'hkx', 'tpf'],
        support: 'partial',
        relationKinds: ['container_member'],
        nativeReader: 'container inventory',
        writerSupported: false,
        uncoveredReason: 'chr 容器成员边；hkx/flver/tpf 不伪造控制关系'
      });
      rows.push({
        resourceKind: 'obj',
        formatFamilies: ['objbnd', 'bnd', 'flver', 'tpf', 'mtd'],
        support: 'partial',
        relationKinds: ['container_member'],
        nativeReader: 'container inventory',
        writerSupported: false,
        uncoveredReason: 'obj 容器成员边；mtd/flver/tpf 无唯一语义规则'
      });
      rows.push({
        resourceKind: 'other',
        formatFamilies: ['esd', 'gparam', 'bnd', 'luabnd', 'msgbnd', 'anibnd'],
        support: 'partial',
        relationKinds: ['container_member'],
        nativeReader: 'listContainerMembers',
        writerSupported: false,
        uncoveredReason: 'esd/gparam 等暂无唯一引用规则；BND 家族仅 contains/member 边'
      });
      rows.push({
        resourceKind: 'unknown',
        formatFamilies: ['*'],
        support: 'unsupported',
        relationKinds: [],
        uncoveredReason: '未识别格式不伪造关系'
      });

      // Defensive: if a future ResourceKind is added to ALL_RESOURCE_KINDS and
      // no provider claims it, register a placeholder so assertExhaustiveKinds
      // fails closed in tests rather than silently passing with a gap.
      for (const kind of ALL_RESOURCE_KINDS) {
        const already = rows.some((row) => row.resourceKind === kind) || covered.has(kind);
        if (already) continue;
        rows.push({
          resourceKind: kind,
          formatFamilies: [],
          support: 'unsupported',
          relationKinds: [],
          uncoveredReason: '该 ResourceKind 尚未登记语义规则'
        });
      }

      return rows;
    },
    async collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult> {
      const diagnostics: ReferenceProviderCollectResult['diagnostics'] = [];
      const coverageNotes: ReferenceProviderCollectResult['coverageNotes'] = [];
      const relations: ProviderRelationDraft[] = [];

      const target = input.target as ResourceTargetLike | null | undefined;
      if (!target || typeof target.sourceUri !== 'string' || target.sourceUri.trim() === '') {
        diagnostics.push({
          code: 'RESOURCE_TARGET_REQUIRED',
          message: 'RESOURCE provider 需要带 sourceUri 的 resource/other 目标。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'resource', status: 'failed', notes: ['target_missing'] });
        return { relations, coverageNotes, diagnostics };
      }

      const sourceUri = target.sourceUri;
      const workspaceId = target.workspaceId ?? 'unknown';
      const childChain = target.childChain ?? [];
      const domainHint = target.domain ?? 'resource';

      const fromIdentity = {
        workspaceId,
        domain: (domainHint === 'other' || domainHint === 'fmg' || domainHint === 'tae' || domainHint === 'msg'
          ? domainHint
          : 'resource') as 'resource' | 'other' | 'fmg' | 'tae' | 'msg',
        sourceUri,
        outerId: target.nativeObjectKey ?? sourceUri,
        childChain: childChain.length > 0 ? childChain : [domainHint],
        namespace: childChain[0] ?? domainHint,
        objectKey: target.nativeObjectKey
          ? `${sourceUri}#${target.nativeObjectKey}`
          : `${sourceUri}#${childChain.join('/') || domainHint}`,
        ...(target.nativeObjectKey ? { nativeObjectKey: target.nativeObjectKey } : {}),
        ...(target.entryIndex !== undefined ? { entryIndex: target.entryIndex } : {}),
        ...(target.textId !== undefined ? { textId: target.textId } : {}),
        ...(target.animId !== undefined ? { animId: target.animId } : {})
      };

      const formatFamily = (target.formatFamily ?? target.resourceKind ?? domainHint).toLowerCase();
      let fmgLinks = 0;
      let fmgRejectedNumericCoincidence = 0;
      let taeConfirmed = 0;
      let taeUndecoded = 0;
      let containerMembers = 0;

      // ── FMG: param→text only via explicit mapping payload ──
      if (Array.isArray(target.textMapping) && target.textMapping.length > 0) {
        for (const mapping of target.textMapping) {
          const textId = toSafeInteger(mapping.textId);
          const paramRowId = toSafeInteger(mapping.paramRowId);
          const category = mapping.category ?? target.category ?? '';
          const language = mapping.language ?? target.language ?? '';
          const paramName = mapping.paramName;
          const fieldId = mapping.fieldId;

          if (textId === null || paramRowId === null || !paramName) {
            diagnostics.push({
              code: 'FMG_MAPPING_INCOMPLETE',
              message: 'FMG 映射缺少 paramName / paramRowId / textId 安全整数，不产生 param_fmg_text 边。',
              severity: 'warning'
            });
            continue;
          }

          // Same numeric id in different category/language is NOT the same item.
          // The mapping payload must carry category when the host knows it; if the
          // target also has a category/language, they must match or we reject.
          if (target.category && mapping.category && target.category !== mapping.category) {
            fmgRejectedNumericCoincidence += 1;
            diagnostics.push({
              code: 'FMG_CATEGORY_MISMATCH',
              message: `映射 category=${mapping.category} 与目标 category=${target.category} 不一致；同数值 id 不视作同一物品。`,
              severity: 'warning'
            });
            continue;
          }
          if (target.language && mapping.language && target.language !== mapping.language) {
            fmgRejectedNumericCoincidence += 1;
            diagnostics.push({
              code: 'FMG_LANGUAGE_MISMATCH',
              message: `映射 language=${mapping.language} 与目标 language=${target.language} 不一致；同数值 id 不视作同一物品。`,
              severity: 'warning'
            });
            continue;
          }

          fmgLinks += 1;
          const fmgSource = mapping.fmgSourceUri ?? sourceUri;
          relations.push({
            relationKind: 'param_fmg_text',
            certainty: 'confirmed',
            from: makeParamRowIdentity(workspaceId, paramName, paramRowId, fieldId),
            to: {
              workspaceId,
              domain: 'fmg',
              sourceUri: fmgSource,
              outerId: fmgSource,
              childChain: ['fmg', category || 'unknown', language || 'default'],
              namespace: category || 'fmg',
              objectKey: `fmg#${category || 'unknown'}#${language || 'default'}#${textId}`,
              textId,
              ...(category ? { entryName: category } : {}),
              label: `fmg:${category || '?'}/${language || '?'}#${textId}`
            },
            evidence: {
              version: { readerSchema: 'fmg-explicit-mapping-v1' },
              location: {
                sourceUri,
                domain: 'resource',
                locator: `fmg-map:${paramName}#${paramRowId}->${category || '?'}/${language || '?'}#${textId}`,
                ...(fieldId ? { fieldId } : {})
              },
              fieldFacts: {
                fieldId: fieldId ?? 'textId',
                value: textId,
                metadataRule: `explicit_mapping:${paramName}#${paramRowId}`,
                targetStatus: 'unverified'
              },
              ruleName: 'param_fmg_text:explicit_mapping',
              diagnostics: ['explicit_mapping_only']
            },
            limitNote: '仅经显式 mapping；跨 category/language 的同数值 id 不等同'
          });
        }

        if (fmgRejectedNumericCoincidence > 0) {
          coverageNotes.push({
            domain: 'resource',
            status: 'partial',
            notes: [`fmg_category_language_mismatch:${fmgRejectedNumericCoincidence}`]
          });
        }
      } else if (formatFamily.includes('fmg') || domainHint === 'fmg' || domainHint === 'msg') {
        diagnostics.push({
          code: 'FMG_MAPPING_REQUIRED',
          message: 'FMG/MSG 目标未提供显式 textMapping payload；同数值 id 在不同 category/language 不得当作同一物品。',
          severity: 'info'
        });
      }

      // ── TAE: only decoded template fields ──
      const isTaeFamily = formatFamily.includes('tae') || formatFamily.includes('anibnd') || domainHint === 'tae';
      if (isTaeFamily) {
        const decoded = Array.isArray(target.taeFields) ? target.taeFields : [];
        const hasUndecoded = typeof target.parameterBytesHex === 'string' && target.parameterBytesHex.length > 0;

        if (hasUndecoded) {
          taeUndecoded += 1;
          diagnostics.push({
            code: 'TAE_PARAMS_UNDECODED',
            message: 'TAE 事件含未解码 parameterBytesHex；仅 decoded template 字段产生 confirmed 边，未解码部分不产生语义边。',
            severity: 'info'
          });
        }

        if (decoded.length === 0 && hasUndecoded) {
          // already recorded above
        }

        for (const field of decoded) {
          const numeric = toSafeInteger(field.value);
          if (numeric === null) {
            // Non-numeric decoded fields are not ref targets.
            continue;
          }
          // Decoded template fields that look like motion/anim references.
          const lower = field.name.toLowerCase();
          if (!lower.includes('anim') && !lower.includes('motion') && !lower.includes('state')) {
            continue;
          }
          taeConfirmed += 1;
          relations.push({
            relationKind: 'tae_motion_member',
            certainty: 'confirmed',
            from: fromIdentity,
            to: {
              workspaceId,
              domain: 'tae',
              sourceUri,
              outerId: sourceUri,
              childChain: [
                'tae',
                String(target.taeEntryIndex ?? 0),
                'anim',
                String(target.animId ?? field.value)
              ],
              namespace: 'tae_motion',
              objectKey: `tae_motion#${target.taeEntryIndex ?? 0}#${field.name}#${numeric}`,
              animId: target.animId ?? numeric,
              ...(target.taeEntryIndex !== undefined ? { entryIndex: target.taeEntryIndex } : {}),
              label: `${field.name}=${numeric}`
            },
            evidence: {
              version: { readerSchema: 'tae-template-fields-v1' },
              location: {
                sourceUri,
                domain: 'tae',
                locator: `tae#${target.taeEntryIndex ?? 0}/anim#${target.animId ?? '?'}/${field.name}`
              },
              statement: {
                kind: 'field-assignment',
                text: `${field.name}=${numeric}`,
                language: 'tae'
              },
              fieldFacts: {
                fieldId: field.name,
                value: numeric,
                metadataRule: 'tae_decoded_template_field',
                targetStatus: 'unverified'
              },
              ruleName: 'tae_motion_member:decoded_field'
            }
          });
        }

        if (hasUndecoded) {
          taeUndecoded += 1;
        }
      }

      // ── BND / container members ──
      let members = Array.isArray(target.containerMembers) ? target.containerMembers : [];
      if (members.length === 0 && input.ports.listContainerMembers) {
        try {
          const raw = await input.ports.listContainerMembers({
            domain: domainHint,
            sourceUri,
            childChain,
            workspaceId,
            ...(target.nativeObjectKey ? { nativeObjectKey: target.nativeObjectKey } : {})
          });
          const list = normalizeContainerMembers(raw);
          if (list.length > 0) {
            members = list;
          } else {
            diagnostics.push({
              code: 'CONTAINER_MEMBERS_EMPTY',
              message: 'listContainerMembers 未返回真实条目；不产生 contains/member 边。',
              severity: 'info'
            });
          }
        } catch (error) {
          diagnostics.push({
            code: 'CONTAINER_MEMBERS_READ_FAILED',
            message: `listContainerMembers 失败：${error instanceof Error ? error.message : String(error)}`,
            severity: 'warning'
          });
          coverageNotes.push({
            domain: 'resource',
            status: 'partial',
            notes: ['container_members_read_failed']
          });
        }
      }

      const isContainerFamily =
        formatFamily.includes('bnd') ||
        formatFamily.includes('anibnd') ||
        formatFamily.includes('luabnd') ||
        formatFamily.includes('msgbnd') ||
        formatFamily.includes('chrbnd') ||
        formatFamily.includes('objbnd');

      if (members.length > 0) {
        for (const member of members) {
          const memberName = member.name ?? member.childId ?? '';
          if (!memberName) continue;
          containerMembers += 1;
          relations.push({
            relationKind: 'container_member',
            certainty: 'confirmed',
            from: fromIdentity,
            to: {
              workspaceId,
              domain: 'resource',
              sourceUri,
              outerId: memberName,
              childChain: [...(childChain.length > 0 ? childChain : ['container']), memberName],
              namespace: 'container_member',
              objectKey: `${sourceUri}::${memberName}`,
              ...(member.index !== undefined ? { entryIndex: member.index } : {}),
              entryName: memberName,
              label: memberName
            },
            evidence: {
              version: { readerSchema: 'container-inventory-v1' },
              location: {
                sourceUri,
                domain: 'resource',
                locator: `${sourceUri}::${memberName}`,
                ...(member.index !== undefined ? { entryIndex: member.index } : {})
              },
              fieldFacts: {
                fieldId: memberName,
                value: member.index ?? member.size ?? null,
                metadataRule: 'container_inventory_entry',
                targetStatus: 'unverified'
              },
              ruleName: 'container_member:inventory'
            },
            limitNote: '真实容器成员表条目；不外推子项内部语义'
          });
        }
      } else if (isContainerFamily) {
        coverageNotes.push({
          domain: 'resource',
          status: 'partial',
          notes: ['container_family_without_member_inventory']
        });
      }

      // ── Low-semantic format coverage notes ──
      const lowSemantic = LOW_SEMANTIC_FORMAT_REASONS.find(
        (item) => item.formatFamilies.some((family) => formatFamily.includes(family.replace('*', ''))) ||
          item.kinds.some((kind) => String(target.resourceKind ?? '') === kind)
      );

      const notes: string[] = [
        `fmg_links:${fmgLinks}`,
        `tae_confirmed:${taeConfirmed}`,
        `tae_undecoded:${taeUndecoded}`,
        `container_members:${containerMembers}`,
        'resource_provider_real_relations_when_evidence_present'
      ];

      let status: 'complete' | 'partial' | 'unsupported' | 'skipped' = 'complete';
      if (taeUndecoded > 0 || fmgRejectedNumericCoincidence > 0 || (isContainerFamily && containerMembers === 0)) {
        status = 'partial';
        notes.push('partial_due_to_undecoded_or_missing_evidence');
      }
      if (lowSemantic && lowSemantic.support === 'unsupported') {
        status = 'unsupported';
        notes.push(lowSemantic.reason);
      } else if (lowSemantic) {
        notes.push(lowSemantic.reason);
        if (status === 'complete' && relations.length === 0) {
          status = 'partial';
        }
      }
      if (relations.length === 0 && status === 'complete') {
        notes.push('no_relation_evidence_on_target');
      }

      coverageNotes.push({ domain: 'resource', status, notes });
      // Secondary coverage rows for fmg/tae when those payloads were exercised.
      if (fmgLinks > 0 || domainHint === 'fmg' || domainHint === 'msg') {
        coverageNotes.push({
          domain: 'other',
          status: fmgLinks > 0 ? 'partial' : 'partial',
          notes: [`fmg_domain_links:${fmgLinks}`, 'numeric_id_cross_category_not_same_item']
        });
      }
      if (isTaeFamily) {
        coverageNotes.push({
          domain: 'other',
          status: taeUndecoded > 0 ? 'partial' : 'complete',
          notes: [`tae_decoded:${taeConfirmed}`, `tae_undecoded:${taeUndecoded}`]
        });
      }

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

function makeParamRowIdentity(workspaceId: string, paramName: string, rowId: number, fieldId?: string) {
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
    ...(fieldId ? { fieldId } : {}),
    label: `${paramName}#${rowId}`
  };
}

function normalizeContainerMembers(raw: unknown): Array<{
  name?: string;
  index?: number;
  childId?: string;
  size?: number;
  formatKind?: string;
  childUri?: string;
}> {
  if (!raw) return [];
  const record = raw as {
    members?: unknown;
    children?: unknown;
    entries?: unknown;
    data?: { members?: unknown; children?: unknown; entries?: unknown };
  };
  const source =
    record.members ??
    record.children ??
    record.entries ??
    record.data?.members ??
    record.data?.children ??
    record.data?.entries ??
    (Array.isArray(raw) ? raw : undefined);
  if (!Array.isArray(source)) return [];
  const out: Array<{
    name?: string;
    index?: number;
    childId?: string;
    size?: number;
    formatKind?: string;
    childUri?: string;
  }> = [];
  for (const item of source) {
    if (typeof item === 'string') {
      out.push({ name: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    const childId = typeof obj.childId === 'string' ? obj.childId : undefined;
    const index = toSafeInteger(obj.index);
    const size = toSafeInteger(obj.size);
    const formatKind = typeof obj.formatKind === 'string' ? obj.formatKind : undefined;
    const childUri = typeof obj.childUri === 'string' ? obj.childUri : undefined;
    if (!name && !childId) continue;
    out.push({
      ...(name !== undefined ? { name } : {}),
      ...(childId !== undefined ? { childId } : {}),
      ...(index !== null ? { index } : {}),
      ...(size !== null ? { size } : {}),
      ...(formatKind !== undefined ? { formatKind } : {}),
      ...(childUri !== undefined ? { childUri } : {})
    });
  }
  return out;
}
