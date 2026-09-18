/**
 * PARAM reference provider.
 *
 * Confirmed edges only from trusted metadata Refs + sibling condition fields.
 * Numeric coincidence and name similarity never become confirmed.
 */
import { parseParamFieldRefs } from '@soulforge/shared';
import type {
  ProviderRelationDraft,
  ReferenceProvider,
  ReferenceProviderCapability,
  ReferenceProviderCollectInput,
  ReferenceProviderCollectResult
} from './referenceProviderRegistry.js';

interface ParamTargetLike {
  domain: 'param';
  sourceUri: string;
  entryIndex: number;
  entryName?: string;
  rowId: number;
  rowIndex?: number;
  workspaceId?: string;
  outerId?: string;
  fieldValues?: Record<string, unknown>;
  metadataByField?: Record<string, { refs?: string; provenance?: string }>;
  containerEntries?: string[];
}

export function createParamReferenceProvider(): ReferenceProvider {
  return {
    id: 'param',
    domains: ['param'],
    capabilities(): ReferenceProviderCapability[] {
      return [
        {
          resourceKind: 'param',
          formatFamilies: ['param', 'parambnd', 'gameparambnd'],
          support: 'supported',
          relationKinds: ['param_field_ref', 'param_text_link'],
          nativeReader: 'read_param_fields',
          writerSupported: true
        },
        {
          resourceKind: 'msg',
          formatFamilies: ['fmg'],
          support: 'partial',
          relationKinds: ['param_text_link'],
          nativeReader: 'read_fmg_entries',
          uncoveredReason: '仅使用已验证的 param→text 映射，不把同数值其它 FMG 当同一物品'
        }
      ];
    },
    async collect(input: ReferenceProviderCollectInput): Promise<ReferenceProviderCollectResult> {
      const target = input.target as ParamTargetLike | null;
      const diagnostics: ReferenceProviderCollectResult['diagnostics'] = [];
      const coverageNotes: ReferenceProviderCollectResult['coverageNotes'] = [];
      const relations: ProviderRelationDraft[] = [];

      if (!target || target.domain !== 'param') {
        diagnostics.push({
          code: 'PARAM_TARGET_REQUIRED',
          message: 'PARAM provider 需要已解析的 param 目标。',
          severity: 'error'
        });
        coverageNotes.push({ domain: 'param', status: 'failed', notes: ['target_missing'] });
        return { relations, coverageNotes, diagnostics };
      }

      const fieldValues = target.fieldValues ?? {};
      const metadataByField = target.metadataByField ?? {};
      const containerEntries = target.containerEntries ?? [];
      const rejectedFragments: string[] = [];
      let rulesApplied = 0;
      let conditionsUnresolved = 0;

      for (const [fieldId, meta] of Object.entries(metadataByField)) {
        const refsRaw = meta.refs;
        if (refsRaw === undefined || refsRaw === null || refsRaw === '') continue;
        const parsed = parseParamFieldRefs(refsRaw);
        if (parsed.rejected.length > 0) {
          rejectedFragments.push(...parsed.rejected.map((piece) => `${fieldId}:${piece}`));
        }
        if (parsed.targets.length === 0 && parsed.rejected.length > 0) {
          diagnostics.push({
            code: 'PARAM_REFS_UNKNOWN_SYNTAX',
            message: `字段 ${fieldId} 的 Refs 含无法识别片段，不得当作零引用。`,
            severity: 'warning'
          });
          continue;
        }

        for (const rule of parsed.targets) {
          const ruleTarget = rule as {
            param: string;
            condition?: { fieldId: string; value: number };
          };
          const value = fieldValues[fieldId];
          if (value === undefined || value === null) {
            conditionsUnresolved += 1;
            relations.push({
              relationKind: 'param_field_ref',
              certainty: 'hypothesis',
              from: target,
              to: {
                domain: 'param',
                sourceUri: target.sourceUri,
                entryName: ruleTarget.param,
                rowId: null,
                unresolved: true
              },
              evidence: {
                ruleName: `refs:${fieldId}->${ruleTarget.param}`,
                fieldFacts: { fieldId, value: null, metadataRule: String(refsRaw) },
                diagnostics: ['source_field_value_missing']
              },
              limitNote: '源字段当前值未读取，无法判定引用是否成立'
            });
            continue;
          }

          if (ruleTarget.condition) {
            const condField = ruleTarget.condition.fieldId;
            const condValue = ruleTarget.condition.value;
            if (!(condField in fieldValues)) {
              conditionsUnresolved += 1;
              relations.push({
                relationKind: 'param_field_ref',
                certainty: 'hypothesis',
                from: target,
                to: { domain: 'param', sourceUri: target.sourceUri, entryName: ruleTarget.param, rowId: null },
                evidence: {
                  ruleName: `refs:${fieldId}->${ruleTarget.param}(${condField}=${condValue})`,
                  fieldFacts: {
                    fieldId,
                    value,
                    conditionFieldId: condField,
                    conditionValue: undefined,
                    metadataRule: String(refsRaw)
                  },
                  diagnostics: ['condition_field_unread']
                },
                limitNote: '条件兄弟字段未读取'
              });
              continue;
            }
            const actualCond = fieldValues[condField];
            if (Number(actualCond) !== condValue) {
              // Rule not applicable — explicit, not an empty silent drop.
              rulesApplied += 1;
              continue;
            }
          }

          const numeric = Number(value);
          if (!Number.isFinite(numeric)) {
            diagnostics.push({
              code: 'PARAM_REF_VALUE_NOT_NUMERIC',
              message: `字段 ${fieldId} 的引用值不是可定位数字。`,
              severity: 'warning'
            });
            continue;
          }

          const resolvedEntry = resolveEntryName(ruleTarget.param, containerEntries);
          if (resolvedEntry.kind === 'ambiguous') {
            relations.push({
              relationKind: 'param_field_ref',
              certainty: 'hypothesis',
              from: target,
              to: {
                domain: 'param',
                sourceUri: target.sourceUri,
                entryName: ruleTarget.param,
                rowId: numeric
              },
              evidence: {
                ruleName: `refs:${fieldId}->${ruleTarget.param}`,
                fieldFacts: {
                  fieldId,
                  value: numeric,
                  ...(ruleTarget.condition
                    ? { conditionFieldId: ruleTarget.condition.fieldId, conditionValue: ruleTarget.condition.value }
                    : {}),
                  metadataRule: String(refsRaw),
                  targetStatus: 'ambiguous'
                },
                diagnostics: ['target_entry_ambiguous']
              },
              limitNote: '目标容器存在多个匹配 entry，需精确身份'
            });
            continue;
          }

          if (resolvedEntry.kind === 'missing') {
            relations.push({
              relationKind: 'param_field_ref',
              certainty: 'confirmed',
              from: target,
              to: {
                domain: 'param',
                sourceUri: target.sourceUri,
                entryName: ruleTarget.param,
                rowId: numeric
              },
              evidence: {
                ruleName: `refs:${fieldId}->${ruleTarget.param}`,
                fieldFacts: {
                  fieldId,
                  value: numeric,
                  ...(ruleTarget.condition
                    ? { conditionFieldId: ruleTarget.condition.fieldId, conditionValue: ruleTarget.condition.value }
                    : {}),
                  metadataRule: String(refsRaw),
                  targetStatus: 'missing'
                }
              },
              // Dangling reference is still a confirmed metadata edge; target presence is separate.
              limitNote: '目标表在当前容器目录中未找到；悬空引用保留，不得授权写入不存在目标'
            });
            rulesApplied += 1;
            continue;
          }

          relations.push({
            relationKind: 'param_field_ref',
            certainty: 'confirmed',
            from: target,
            to: {
              domain: 'param',
              sourceUri: target.sourceUri,
              entryName: resolvedEntry.entryName,
              entryIndex: resolvedEntry.entryIndex,
              rowId: numeric,
              ...(target.workspaceId ? { workspaceId: target.workspaceId } : {})
            },
            evidence: {
              ruleName: `refs:${fieldId}->${resolvedEntry.entryName}`,
              fieldFacts: {
                fieldId,
                value: numeric,
                ...(ruleTarget.condition
                  ? { conditionFieldId: ruleTarget.condition.fieldId, conditionValue: ruleTarget.condition.value }
                  : {}),
                metadataRule: String(refsRaw),
                targetStatus: 'unverified'
              },
              location: {
                sourceUri: target.sourceUri,
                domain: 'param',
                locator: `${resolvedEntry.entryName}#${target.rowId}.${fieldId}`,
                fieldId,
                ...(target.rowIndex !== undefined ? { rowIndex: target.rowIndex } : {})
              }
            }
          });
          rulesApplied += 1;
        }
      }

      if (rejectedFragments.length > 0) {
        coverageNotes.push({
          domain: 'param',
          status: 'partial',
          notes: [`rejected_refs:${rejectedFragments.join('|')}`]
        });
      }
      if (conditionsUnresolved > 0) {
        coverageNotes.push({
          domain: 'param',
          status: 'partial',
          notes: [`unresolved_conditions:${conditionsUnresolved}`]
        });
      }
      if (rulesApplied > 0 && rejectedFragments.length === 0 && conditionsUnresolved === 0) {
        coverageNotes.push({ domain: 'param', status: 'complete', notes: [`rules_applied:${rulesApplied}`] });
      } else if (rulesApplied === 0 && rejectedFragments.length === 0 && conditionsUnresolved === 0) {
        coverageNotes.push({ domain: 'param', status: 'complete', notes: ['no_refs_metadata_on_requested_fields'] });
      }

      return { relations, coverageNotes, diagnostics };
    }
  };
}

function resolveEntryName(
  requested: string,
  entries: string[]
): { kind: 'unique'; entryName: string; entryIndex: number } | { kind: 'missing' } | { kind: 'ambiguous'; matches: string[] } {
  if (entries.length === 0) {
    // Without a container inventory we keep the requested namespace and mark unverified later.
    return { kind: 'unique', entryName: requested, entryIndex: -1 };
  }
  const exact = entries
    .map((name, index) => ({ name, index }))
    .filter((item) => item.name === requested);
  if (exact.length === 1) return { kind: 'unique', entryName: exact[0]!.name, entryIndex: exact[0]!.index };
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact.map((item) => item.name) };

  const ci = entries
    .map((name, index) => ({ name, index }))
    .filter((item) => item.name.toLowerCase() === requested.toLowerCase());
  if (ci.length === 1) return { kind: 'unique', entryName: ci[0]!.name, entryIndex: ci[0]!.index };
  if (ci.length > 1) return { kind: 'ambiguous', matches: ci.map((item) => item.name) };
  return { kind: 'missing' };
}
