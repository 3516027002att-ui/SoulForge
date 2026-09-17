/**
 * 地图连接 provider（T07，执行指令 §T07 步骤 1-5、7）。
 *
 * 关系只来自原生 reader 已导出的字段：
 * - 实体 → PARAM 行：`raw.npcParamRowId` / `raw.thinkParamRowId` 这类真实外键
 *   字段存在且在当前索引中唯一命中目标行时才生成 confirmed 边；字段缺失就是
 *   没有该关系，不从部件名称反算（步骤 1）。
 * - 每个实例独立身份：遍历全部实体，不做 `.find()` 首实例截断（步骤 2）；
 *   同模型的两个实例绝不因 model 相同而合并。
 * - entityId / internalEntryId / nativeOffset / model / name 各自保留语义，
 *   不得互相代换（步骤 3）；entityId 在同图命中多个实例时返回歧义诊断。
 * - 位置只是实例所在说明，不进入关系主键（步骤 5）。
 * - 地图文件与同名事件文件只是搜索范围关系；"事件控制某角色"必须由事件侧
 *   typed entity/region 参数证明（eventReferenceProvider 负责），这里不生成
 *   任何 confirmed 的 map↔event 边（步骤 4）。
 * - 名称前缀等模式只进入 `includeHypotheses` 通道，low + 规则名（步骤 7）。
 */
import type {
  Diagnostic,
  MapExport,
  MapEntitySymbol,
  ParamExport,
  ReferenceEdge,
  ReferenceEvidence
} from '@soulforge/shared';

export interface MapReferenceBuildOptions {
  includeHypotheses?: boolean;
}

export interface MapReferenceBuildResult {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  stats: {
    confirmed: number;
    hypotheses: number;
    ambiguousEntityIds: number;
    danglingForeignKeys: number;
    instances: number;
  };
}

const MAX_MAP_REF_DIAGNOSTICS = 500;

/**
 * 受支持的原生外键字段：字段名（Bridge reader 导出的 raw 键）、目标参数表、
 * 关系语义。新增条目必须有 reader 出处，不得从名称反算。
 */
const ENTITY_PARAM_KEYS: ReadonlyArray<{
  rawField: string;
  table: string;
  property: string;
}> = Object.freeze([
  { rawField: 'npcParamRowId', table: 'NpcParam', property: 'npcParamId' },
  { rawField: 'thinkParamRowId', table: 'ThinkParam', property: 'thinkParamId' }
]);

interface ParamRowTarget {
  uri: string;
  sourceUri: string;
  paramName: string;
  rowId: number;
  rowIndex?: number;
}

function indexParamRows(params: readonly ParamExport[]): Map<string, ParamRowTarget[]> {
  const index = new Map<string, ParamRowTarget[]>();
  for (const paramExport of params) {
    const table = (paramExport.entryName ?? paramExport.paramName).replace(/\.param$/iu, '').toLowerCase();
    for (const row of paramExport.rows) {
      const key = `${table}#${row.rowId}`;
      const target: ParamRowTarget = {
        uri: row.uri,
        sourceUri: row.sourceUri,
        paramName: paramExport.paramName,
        rowId: row.rowId,
        ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {})
      };
      const list = index.get(key);
      if (list) list.push(target);
      else index.set(key, [target]);
    }
  }
  return index;
}

function rawField(entity: MapEntitySymbol, field: string): number | undefined {
  const raw = entity.raw;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function entityPositionEvidence(entity: MapEntitySymbol): string {
  const parts = [`entity ${entity.name}`, `entityId=${entity.entityId ?? '?'}`, `internalEntryId=${entity.internalEntryId ?? '?'}`];
  if (entity.position) parts.push(`pos=[${entity.position.join(',')}]`);
  return parts.join(' ');
}

export function buildMapReferenceEdges(
  maps: readonly MapExport[],
  params: readonly ParamExport[],
  options: MapReferenceBuildOptions = {}
): MapReferenceBuildResult {
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const stats: MapReferenceBuildResult['stats'] = {
    confirmed: 0,
    hypotheses: 0,
    ambiguousEntityIds: 0,
    danglingForeignKeys: 0,
    instances: 0
  };
  const pushDiagnostic = (diagnostic: Diagnostic): void => {
    if (diagnostics.length >= MAX_MAP_REF_DIAGNOSTICS) return;
    diagnostics.push(diagnostic);
  };
  const rowsByScopedId = indexParamRows(params);

  for (const mapExport of maps) {
    // entityId 歧义：同一地图内同号实体收集全部实例（步骤 2/3）。
    const byEntityId = new Map<number, MapEntitySymbol[]>();
    for (const entity of mapExport.entities) {
      stats.instances += 1;
      if (typeof entity.entityId === 'number') {
        const list = byEntityId.get(entity.entityId);
        if (list) list.push(entity);
        else byEntityId.set(entity.entityId, [entity]);
      }
    }
    for (const [entityId, instances] of byEntityId) {
      if (instances.length > 1) {
        stats.ambiguousEntityIds += 1;
        pushDiagnostic({
          severity: 'warning',
          code: 'MAP_ENTITY_ID_AMBIGUOUS',
          message: `${mapExport.mapId} 内 entityId=${entityId} 命中 ${instances.length} 个实例（${instances.map((item) => item.name).join(', ')}）；引用不落到单一实例。`,
          ...(mapExport.entities[0] ? { sourceUri: mapExport.entities[0].sourceUri } : {}),
          details: { mapId: mapExport.mapId, entityId, candidates: instances.map((item) => item.uri) }
        });
      }
    }

    for (const entity of mapExport.entities) {
      // 原生外键 → PARAM 行（步骤 1）。
      for (const fk of ENTITY_PARAM_KEYS) {
        const rowId = rawField(entity, fk.rawField);
        if (rowId === undefined) continue;
        const key = `${fk.table.toLowerCase()}#${rowId}`;
        const targets = rowsByScopedId.get(key) ?? [];
        if (targets.length === 0) {
          stats.danglingForeignKeys += 1;
          pushDiagnostic({
            severity: 'warning',
            code: 'MAP_PARAM_FK_TARGET_MISSING',
            message: `${entity.name} 的原生字段 ${fk.rawField}=${rowId} 指向 ${fk.table}#${rowId}，该表/行不在当前索引；保留外键事实但不生成边。`,
            sourceUri: entity.sourceUri,
            details: { entityUri: entity.uri, field: fk.rawField, rowId, table: fk.table }
          });
          continue;
        }
        if (targets.length > 1) {
          stats.danglingForeignKeys += 1;
          pushDiagnostic({
            severity: 'warning',
            code: 'MAP_PARAM_FK_TARGET_AMBIGUOUS',
            message: `${fk.table}#${rowId} 命中 ${targets.length} 个物理行，外键不落到单一目标。`,
            sourceUri: entity.sourceUri,
            details: { entityUri: entity.uri, candidates: targets.map((item) => item.uri) }
          });
          continue;
        }
        const target = targets[0]!;
        const evidence: ReferenceEvidence = {
          sourceUri: entity.sourceUri,
          fieldName: fk.property,
          value: rowId,
          excerpt: `${entityPositionEvidence(entity)} — ${fk.rawField}=${rowId} → ${fk.table}#${rowId}`
        };
        stats.confirmed += 1;
        edges.push({
          fromUri: entity.uri,
          toUri: target.uri,
          kind: 'references_param_row',
          confidence: 'high',
          reason: `原生字段 ${entity.name}.${fk.rawField}=${rowId} 声明对 ${fk.table}#${rowId} 的外键。`,
          evidence: [evidence]
        });
      }

      // 名称前缀假设（步骤 7）：模型名 c1050.tai → chr://c1050，只作定位线索。
      if (options.includeHypotheses && entity.model) {
        const modelMatch = /^(c\d{4,5})\.[a-z]+$/iu.exec(entity.model);
        if (modelMatch) {
          stats.hypotheses += 1;
          edges.push({
            fromUri: entity.uri,
            toUri: `chr://${modelMatch[1]}`,
            kind: 'unknown',
            confidence: 'low',
            reason: `hypothesis(map.model-prefix): 模型文件名 ${entity.model} 的前缀与角色族号一致；这只说明命名相似，不能证明模型归属或可写性。`,
            evidence: [{
              sourceUri: entity.sourceUri,
              fieldName: 'model',
              excerpt: entityPositionEvidence(entity)
            }]
          });
        }
      }
    }
  }

  if (diagnostics.length >= MAX_MAP_REF_DIAGNOSTICS) {
    diagnostics.push({
      severity: 'warning',
      code: 'MAP_REF_DIAGNOSTICS_TRUNCATED',
      message: `地图引用诊断达到 ${MAX_MAP_REF_DIAGNOSTICS} 条上限，后续缺口未列出。`
    });
  }
  return { edges, diagnostics, stats };
}


