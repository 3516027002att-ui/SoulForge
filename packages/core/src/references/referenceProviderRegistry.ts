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
import { buildScriptReferenceEdges, type ScriptLiteralTargetIndexes } from './scriptReferenceProvider.js';
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

/**
 * Literal lookup index for the bounded script observation channel.  It is
 * intentionally built from symbols that already have a stable URI; this
 * helper does not invent an API namespace or infer a foreign key from names.
 */
function scriptLiteralTargetIndexes(bundle: SymbolBundle): ScriptLiteralTargetIndexes {
  const numeric = new Map<number, Array<{ uri: string; label?: string }>>();
  const strings = new Map<string, Array<{ uri: string; label?: string }>>();
  const addNumeric = (value: number | undefined, target: { uri: string; label?: string }): void => {
    if (value === undefined || !Number.isSafeInteger(value)) return;
    const list = numeric.get(value) ?? [];
    list.push(target);
    numeric.set(value, list);
  };
  const addString = (value: string | undefined, target: { uri: string; label?: string }): void => {
    if (!value || value.trim().length === 0) return;
    const key = value.trim().toLocaleLowerCase();
    const list = strings.get(key) ?? [];
    list.push(target);
    strings.set(key, list);
  };
  for (const eventExport of bundle.events ?? []) {
    for (const event of eventExport.events) {
      const target = { uri: event.uri, label: `event ${event.eventId}` };
      addNumeric(event.eventId, target);
      addString(event.name, target);
    }
  }
  for (const mapExport of bundle.maps ?? []) {
    for (const entity of [...mapExport.entities, ...mapExport.regions]) {
      const target = { uri: entity.uri, label: entity.name };
      addNumeric(entity.entityId, target);
      addString(entity.name, target);
    }
  }
  for (const paramExport of bundle.params ?? []) {
    for (const row of paramExport.rows) {
      const target = { uri: row.uri, label: `${row.paramName}#${row.rowId}` };
      addNumeric(row.rowId, target);
      addString(row.rowName, target);
    }
  }
  for (const msgExport of bundle.msgs ?? []) {
    for (const entry of msgExport.entries) {
      const target = { uri: entry.uri, label: `${entry.category ?? 'text'}#${entry.textId}` };
      addNumeric(entry.textId, target);
      addString(entry.text, target);
    }
  }
  for (const scriptExport of bundle.scripts ?? []) {
    for (const child of scriptExport.scripts) {
      const target = { uri: child.uri, label: child.entryName ?? child.childChain.join('/') };
      addString(child.entryName, target);
      addString(child.childChain[child.childChain.length - 1], target);
    }
  }
  return { numeric, strings };
}

export function buildNameMatchEdges(bundle: SymbolBundle): ProviderShard {
  const texts = new Map<string, Array<{ uri: string; text: string }>>();
  const normalize = (value: string) => value.trim().normalize('NFC').toLocaleLowerCase();
  for (const item of bundle.msgs ?? []) {
    for (const entry of item.entries) {
      const name = normalize(entry.text);
      if (!name) continue;
      const values = texts.get(name) ?? [];
      values.push({ uri: entry.uri, text: entry.text });
      texts.set(name, values);
    }
  }
  const edges: ReferenceEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const table of bundle.params ?? []) {
    for (const row of table.rows) {
      const name = normalize(row.rowName ?? '');
      if (!name) continue;
      const matches = texts.get(name) ?? [];
      for (const entry of matches.slice(0, 16)) {
        edges.push({
          fromUri: row.uri, toUri: entry.uri, kind: 'name_match', confidence: 'low',
          reason: `同名：参数行名与文本内容“${row.rowName}”一致；仅名称匹配，不代表文本 ID 等于参数行 ID，也不表示存在外键。`,
          evidence: [{ sourceUri: entry.uri, excerpt: entry.text }]
        });
      }
      if (matches.length > 16) diagnostics.push({ severity: 'info', code: 'NAME_MATCH_LIMIT',
        message: `“${row.rowName}”命中 ${matches.length} 条同名文本，本次显示前 16 条；可用 search_text_entries 搜索该名称继续读取。`, sourceUri: row.sourceUri });
    }
  }
  return { edges, diagnostics };
}

export const REFERENCE_PROVIDERS: readonly ReferenceProviderDescriptor[] = Object.freeze([
  { id: 'content-name-match', domains: ['param', 'msg'], build: buildNameMatchEdges },
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
      ...(options.includeHypotheses !== undefined ? { includeHypotheses: options.includeHypotheses } : {}),
      literalTargets: scriptLiteralTargetIndexes(bundle)
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


