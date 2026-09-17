/**
 * Provider registry（T08，执行指令 §T08 步骤 5）。
 *
 * 把各 provider 注册为可按 source 组合的分片生产者：服务查询 current 的
 * source-scoped 关联分片，缺失分片通过这里补齐；同一 source/version 的构建
 * 任务合并（缓存键含 outerFileHash，版本变化自然失效）。
 *
 * 分片是否持久化沿用现有索引存储能力；本 registry 不做独立图数据库，也不把
 * 未校验的持久化投影直接当 current。
 */
import type { Diagnostic, ReferenceEdge, SymbolBundle } from '@soulforge/shared';
import { buildParamReferenceEdges } from './paramReferenceProvider.js';
import { buildParamTextReferenceEdges } from './paramTextReferences.js';
import { buildEventReferenceEdges } from './eventReferenceProvider.js';
import { buildScriptReferenceEdges } from './scriptReferenceProvider.js';
import { buildMapReferenceEdges } from './mapReferenceProvider.js';
import { buildContainerMemberEdges } from './containerMemberProvider.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { REFERENCE_CAPABILITIES } from './referenceCapabilityRegistry.js';
import type { ResourceKind } from '@soulforge/shared';

export interface ProviderBuildOptions {
  includeHypotheses?: boolean;
  registry?: EmedfRegistry;
  enableNumericFallback?: boolean;
  maxAmbiguousNumericMatches?: number;
}

export interface ProviderShard {
  edges: ReferenceEdge[];
  diagnostics: Diagnostic[];
  /** EMEVD numeric-fallback suppression count (surfaced in graph stats). */
  suppressedAmbiguousNumbers?: number;
}

export interface ReferenceProviderDescriptor {
  id: string;
  /** ResourceKind domains this provider contributes edges for. */
  domains: readonly ResourceKind[];
  build: (bundle: SymbolBundle, options: ProviderBuildOptions) => ProviderShard;
}

/**
 * Target-index view the event provider needs; assembled from the same bundle
 * so shard caching keys on the bundle's sources, not a separate index.
 */
function eventTargetIndexes(bundle: SymbolBundle) {
  const mapEntitiesByEntityId = new Map<number, Array<{ uri: string; mapId?: string }>>();
  const paramRowsById = new Map<number, { uri: string }[]>();
  const paramRowsByScopedId = new Map<string, { uri: string }[]>();
  const textsById = new Map<number, { uri: string }[]>();
  for (const mapExport of bundle.maps ?? []) {
    for (const entity of mapExport.entities) {
      if (typeof entity.entityId === 'number') {
        const list = mapEntitiesByEntityId.get(entity.entityId) ?? [];
        list.push({ uri: entity.uri, ...(entity.mapId ? { mapId: entity.mapId } : {}) });
        mapEntitiesByEntityId.set(entity.entityId, list);
      }
    }
    for (const region of mapExport.regions) {
      if (typeof region.entityId === 'number') {
        const list = mapEntitiesByEntityId.get(region.entityId) ?? [];
        list.push({ uri: region.uri, ...(region.mapId ? { mapId: region.mapId } : {}) });
        mapEntitiesByEntityId.set(region.entityId, list);
      }
    }
  }
  for (const paramExport of bundle.params ?? []) {
    for (const row of paramExport.rows) {
      const list = paramRowsById.get(row.rowId) ?? [];
      list.push({ uri: row.uri });
      paramRowsById.set(row.rowId, list);
      // Keyed by the row's own paramName (the typeName the event arg references),
      // matching the scoped lookup in eventReferenceProvider.
      const key = `${row.paramName.toLowerCase()}#${row.rowId}`;
      const scoped = paramRowsByScopedId.get(key) ?? [];
      scoped.push({ uri: row.uri });
      paramRowsByScopedId.set(key, scoped);
    }
  }
  for (const msgExport of bundle.msgs ?? []) {
    for (const entry of msgExport.entries) {
      const list = textsById.get(entry.textId) ?? [];
      list.push({ uri: entry.uri });
      textsById.set(entry.textId, list);
    }
  }
  return { mapEntitiesByEntityId, paramRowsById, paramRowsByScopedId, textsById };
}

export const REFERENCE_PROVIDERS: readonly ReferenceProviderDescriptor[] = Object.freeze([
  {
    id: 'param-refs',
    domains: ['param'],
    build: (bundle) => buildParamReferenceEdges(bundle.params ?? [])
  },
  {
    id: 'param-text',
    domains: ['param', 'msg'],
    build: (bundle) => ({
      edges: buildParamTextReferenceEdges(bundle.params ?? [], bundle.msgs ?? []),
      diagnostics: []
    })
  },
  {
    id: 'emevd-refs',
    domains: ['event'],
    build: (bundle, options) => {
      const result = buildEventReferenceEdges(
        bundle.events ?? [],
        eventTargetIndexes(bundle),
        {
          ...(options.enableNumericFallback !== undefined ? { enableNumericFallback: options.enableNumericFallback } : {}),
          ...(options.maxAmbiguousNumericMatches !== undefined ? { maxAmbiguousNumericMatches: options.maxAmbiguousNumericMatches } : {}),
          ...(options.includeHypotheses !== undefined ? { includeHypotheses: options.includeHypotheses } : {}),
          ...(options.registry ? { registry: options.registry } : {})
        }
      );
      return {
        edges: result.edges,
        diagnostics: result.diagnostics,
        suppressedAmbiguousNumbers: result.stats.suppressedAmbiguousNumbers
      };
    }
  },
  {
    id: 'script-refs',
    domains: ['script', 'ai'],
    build: (bundle, options) => buildScriptReferenceEdges(bundle.scripts ?? [], {
      ...(options.includeHypotheses !== undefined ? { includeHypotheses: options.includeHypotheses } : {})
    })
  },
  {
    id: 'map-refs',
    domains: ['map', 'param'],
    build: (bundle, options) => buildMapReferenceEdges(bundle.maps ?? [], bundle.params ?? [], {
      ...(options.includeHypotheses !== undefined ? { includeHypotheses: options.includeHypotheses } : {})
    })
  },
  {
    id: 'container-members',
    domains: ['action', 'msg'],
    build: (bundle) => buildContainerMemberEdges(bundle.tae ?? [], bundle.msgs ?? [])
  }
]);

/** Providers whose domains include the given ResourceKind. */
export function providersForDomain(domain: ResourceKind): ReferenceProviderDescriptor[] {
  return REFERENCE_PROVIDERS.filter((provider) => provider.domains.includes(domain));
}

/** Capability entry for a domain; throws on unregistered kinds (exhaustive). */
export function capabilityForDomain(domain: ResourceKind) {
  return REFERENCE_CAPABILITIES[domain];
}


