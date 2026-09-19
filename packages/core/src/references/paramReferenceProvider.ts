/**
 * PARAM → PARAM 的条件引用 provider（T04）。
 *
 * 与 `paramTextReferences.ts`（PARAM→FMG 文本连接）互补：这里处理受信任
 * metadata 的 `Refs=` 规则把一个整数字段指向另一张参数表某一行的情况。
 *
 * 硬性约束（执行指令 §T04）：
 * - 只有 `refsProvenance === 'trusted-metadata'` 的字段才可能生成 confirmed 边；
 *   fieldId 包含 "Param"、描述包含 "特效"、或数值恰好相同，都不构成引用。
 * - 条件引用必须读取同一行的兄弟字段后三态判定：成立 → 候选目标；不成立 →
 *   规则不适用（计入 stats，不产生诊断噪声）；兄弟字段缺失/未解码 →
 *   unresolved-condition 诊断。三者不得都落入空数组。
 * - `refsRejected` 片段进入诊断，影响该规则的覆盖完整性，不得静默丢弃。
 * - 目标表名按容器 entry 名做大小写不敏感唯一匹配；多个物理 entry 命中同一
 *   名字时返回候选诊断，不选第一项。
 * - 悬空引用（目标行不存在）不能消失：进入 PARAM_REF_TARGET_MISSING 诊断，
 *   但绝不生成指向不存在目标的 confirmed 边。
 * - 重复 rowId 的物理行生成可区分候选身份（rowIndex/dataHash），不覆盖。
 */
import type {
  Diagnostic,
  ParamExport,
  ParamFieldRefCondition,
  ParamFieldSymbol,
  ParamRowSymbol,
  ReferenceEdge,
  ReferenceEvidence
} from '@soulforge/shared';

export interface ParamRefStats {
  confirmed: number;
  /** 条件不成立 → 规则对该行不适用（正常结果，不是缺口）。 */
  notApplicable: number;
  /** 条件字段缺失或无法解码为整数。 */
  unresolvedConditions: number;
  /** 未识别的 Refs 片段数量（语义缺口）。 */
  rejectedFragments: number;
  /** 目标表在索引中不存在。 */
  missingTables: number;
  /** 目标行不存在（悬空引用）。 */
  danglingTargets: number;
  /** 目标表或目标行有多个候选。 */
  ambiguousTargets: number;
}

export interface ParamReferenceBuildResult {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  stats: ParamRefStats;
}

const MAX_PARAM_REF_DIAGNOSTICS = 500;

interface TableEntry {
  /** 原生 entry 名（去掉 .param 扩展），保留原始大小写。 */
  nativeName: string;
  exports: ParamExport[];
}

interface RowIndex {
  byRowId: Map<number, ParamRowSymbol[]>;
}

export function buildParamReferenceEdges(
  params: readonly ParamExport[]
): ParamReferenceBuildResult {
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const stats: ParamRefStats = {
    confirmed: 0,
    notApplicable: 0,
    unresolvedConditions: 0,
    rejectedFragments: 0,
    missingTables: 0,
    danglingTargets: 0,
    ambiguousTargets: 0
  };
  const seen = new Set<string>();

  const tableIndex = buildTableIndex(params);
  const rowIndexCache = new Map<ParamExport, RowIndex>();

  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length >= MAX_PARAM_REF_DIAGNOSTICS) return;
    diagnostics.push(diagnostic);
  };

  for (const paramExport of params) {
    for (const row of paramExport.rows) {
      for (const field of row.fields ?? []) {
        // 只接受受信任 metadata 发布的目标；未知来源（包括显示名构造）不生成边。
        if (field.refsProvenance !== 'trusted-metadata') continue;
        const targets = field.refs;
        if (!targets || targets.length === 0) continue;

        for (const fragment of field.refsRejected ?? []) {
          stats.rejectedFragments += 1;
          pushDiagnostic({
            severity: 'warning',
            code: 'PARAM_REF_SYNTAX_REJECTED',
            message: `${paramExport.paramName}#${row.rowId}.${field.fieldId ?? field.name} 的 Refs 含未识别片段「${fragment}」，该规则的覆盖不完整。`,
            sourceUri: row.sourceUri,
            details: { fieldId: field.fieldId ?? field.name, rejected: fragment }
          });
        }

        for (const target of targets) {
          const outcome = evaluateCondition(row, target.condition);
          if (outcome === 'unresolved') {
            stats.unresolvedConditions += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_CONDITION_UNRESOLVED',
              message: `${paramExport.paramName}#${row.rowId} 缺少条件字段 ${target.condition!.fieldId}（或无法解码为整数），引用规则 ${ruleText(target.param, target.condition)} 不适用也无法排除。`,
              sourceUri: row.sourceUri,
              details: { rowId: row.rowId, fieldId: field.fieldId ?? field.name, condition: target.condition }
            });
            continue;
          }
          if (outcome === 'misses') {
            stats.notApplicable += 1;
            continue;
          }

          const targetRowId = parseRefRowId(field.value);
          if (targetRowId === null) {
            stats.unresolvedConditions += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_VALUE_UNRESOLVED',
              message: `${paramExport.paramName}#${row.rowId}.${field.fieldId ?? field.name} 的值无法解释为目标行 id（${String(field.value)}），规则 ${ruleText(target.param, target.condition)} 未解析。`,
              sourceUri: row.sourceUri,
              details: { fieldId: field.fieldId ?? field.name, value: field.value }
            });
            continue;
          }

          const table = tableIndex.get(target.param.toLowerCase());
          if (!table) {
            stats.missingTables += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_TARGET_TABLE_MISSING',
              message: `规则 ${ruleText(target.param, target.condition)} 指向的表 ${target.param} 不在当前索引中；引用保留为语义事实，但不生成边。`,
              sourceUri: row.sourceUri,
              details: { targetParam: target.param, targetRowId }
            });
            continue;
          }
          if (table.exports.length > 1) {
            stats.ambiguousTargets += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_TARGET_AMBIGUOUS',
              message: `目标表名 ${target.param} 命中 ${table.exports.length} 个物理 entry（${table.exports.map((item) => `${item.entryIndex ?? '?'}:${item.entryName ?? item.paramName}`).join(', ')}），返回候选而非任选其一。`,
              sourceUri: row.sourceUri,
              details: {
                targetParam: target.param,
                targetRowId,
                candidates: table.exports.map((item) => ({
                  sourceUri: item.sourceUri,
                  entryIndex: item.entryIndex,
                  entryName: item.entryName
                }))
              }
            });
            continue;
          }

          const ownerExport = table.exports[0]!;
          const rows = indexRows(ownerExport, rowIndexCache).byRowId.get(targetRowId) ?? [];
          if (rows.length === 0) {
            stats.danglingTargets += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_TARGET_MISSING',
              message: `悬空引用：${paramExport.paramName}#${row.rowId}.${field.fieldId ?? field.name} 指向 ${table.nativeName}#${targetRowId}，该目标行不存在，不能授权修改不存在的目标。`,
              sourceUri: row.sourceUri,
              details: {
                targetParam: table.nativeName,
                targetRowId,
                rule: ruleText(target.param, target.condition)
              }
            });
            continue;
          }
          if (rows.length > 1) {
            stats.ambiguousTargets += 1;
            pushDiagnostic({
              severity: 'warning',
              code: 'PARAM_REF_TARGET_AMBIGUOUS',
              message: `目标 ${table.nativeName}#${targetRowId} 有 ${rows.length} 个物理行（rowIndex ${rows.map((item) => item.rowIndex ?? '?').join('/')}），引用不落到单一目标。`,
              sourceUri: row.sourceUri,
              details: {
                targetParam: table.nativeName,
                targetRowId,
                candidates: rows.map((item) => ({
                  rowIndex: item.rowIndex,
                  dataHash: item.dataHash,
                  uri: item.uri
                }))
              }
            });
            continue;
          }

          const targetRow = rows[0]!;
          if (targetRow.uri === row.uri) continue;
          const key = `${row.uri}\u0000${targetRow.uri}\u0000${field.fieldId ?? field.name}`;
          if (seen.has(key)) continue;
          seen.add(key);

          stats.confirmed += 1;
          edges.push({
            fromUri: row.uri,
            toUri: targetRow.uri,
            kind: 'references_param_row',
            confidence: 'high',
            reason: `受信任 metadata 规则 ${ruleText(target.param, target.condition)} 将 ${paramExport.paramName}#${row.rowId}.${field.fieldId ?? field.name}=${targetRowId} 解析为 ${table.nativeName}#${targetRowId}。`,
            evidence: [paramRefEvidence(paramExport, row, field, targetRowId, target.param, target.condition)]
          });
        }
      }
    }
  }

  if (diagnostics.length >= MAX_PARAM_REF_DIAGNOSTICS) {
    diagnostics.push({
      severity: 'warning',
      code: 'PARAM_REF_DIAGNOSTICS_TRUNCATED',
      message: `PARAM 引用诊断达到 ${MAX_PARAM_REF_DIAGNOSTICS} 条上限，后续缺口未列出。`
    });
  }

  return { edges, diagnostics, stats };
}

/* ------------------------------------------------------------------ */
/* 条件三态判定                                                        */
/* ------------------------------------------------------------------ */

type ConditionOutcome = 'holds' | 'misses' | 'unresolved';

function evaluateCondition(
  row: ParamRowSymbol,
  condition: ParamFieldRefCondition | undefined
): ConditionOutcome {
  if (!condition) return 'holds';
  const sibling = findSiblingField(row, condition.fieldId);
  if (!sibling) return 'unresolved';
  const actual = numericValue(sibling.value);
  if (actual === null) return 'unresolved';
  return actual === condition.value ? 'holds' : 'misses';
}

function findSiblingField(row: ParamRowSymbol, fieldId: string): ParamFieldSymbol | undefined {
  const fields = row.fields ?? [];
  const exact = fields.find((field) => field.fieldId === fieldId);
  if (exact) return exact;
  const lowered = fieldId.toLowerCase();
  return fields.find((field) => (field.fieldId ?? field.name).toLowerCase() === lowered);
}

/* ------------------------------------------------------------------ */
/* 值与目标解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 目标 rowId 只接受可精确表示的整数。空槽/sentinel 的解释依赖字段自身的
 * metadata 规则（min/max/enum），符号投影里没有携带这些规则时不得统一
 * 假定 0/-1 无引用 —— 交给 targetStatus 判定（missing → 诊断）。
 */
function parseRefRowId(value: ParamFieldSymbol['value']): number | null {
  return numericValue(value);
}

function numericValue(value: ParamFieldSymbol['value']): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\s*-?\d+\s*$/u.test(value)) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function ruleText(param: string, condition: ParamFieldRefCondition | undefined): string {
  return condition ? `${param}(${condition.fieldId}=${condition.value})` : param;
}

function paramRefEvidence(
  paramExport: ParamExport,
  row: ParamRowSymbol,
  field: ParamFieldSymbol,
  targetRowId: number,
  targetParam: string,
  condition: ParamFieldRefCondition | undefined
): ReferenceEvidence {
  const rowLabel = `${paramExport.paramName}#${row.rowId}${row.rowIndex === undefined ? '' : `@${row.rowIndex}`}`;
  return {
    sourceUri: row.sourceUri,
    fieldName: field.fieldId ?? field.name,
    value: targetRowId,
    excerpt: `${rowLabel}.${field.fieldId ?? field.name}=${targetRowId} -> ${targetParam}#${targetRowId}`
      + (condition ? ` [${condition.fieldId}=${condition.value}]` : '')
      + ` (rule: ${ruleText(targetParam, condition)})`
  };
}

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

function buildTableIndex(params: readonly ParamExport[]): Map<string, TableEntry> {
  const index = new Map<string, TableEntry>();
  for (const paramExport of params) {
    const nativeName = entryTableName(paramExport);
    const key = nativeName.toLowerCase();
    const existing = index.get(key);
    if (existing) {
      existing.exports.push(paramExport);
    } else {
      index.set(key, { nativeName, exports: [paramExport] });
    }
  }
  return index;
}

/** 容器 entry 名是权威表名；paramName（typeName）在不同导出路径下会漂移。 */
function entryTableName(paramExport: ParamExport): string {
  const raw = paramExport.entryName ?? paramExport.paramName;
  return raw.split(/[\\/]/u).at(-1)!.replace(/\.param$/iu, '');
}

function indexRows(paramExport: ParamExport, cache: Map<ParamExport, RowIndex>): RowIndex {
  const cached = cache.get(paramExport);
  if (cached) return cached;
  const byRowId = new Map<number, ParamRowSymbol[]>();
  for (const row of paramExport.rows) {
    const list = byRowId.get(row.rowId);
    if (list) list.push(row);
    else byRowId.set(row.rowId, [row]);
  }
  const built: RowIndex = { byRowId };
  cache.set(paramExport, built);
  return built;
}


