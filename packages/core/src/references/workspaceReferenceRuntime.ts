/**
 * Host-owned reference runtime shared by the desktop Agent and sfcli.
 *
 * The reference service deliberately does not guess physical identities.  This
 * adapter is the one place where a WorkspaceIndex is turned into precise
 * selectors, native versions and the indexed edge provider.  It is also the
 * seam used by tests, so CLI and desktop cannot silently grow different
 * resolver behaviour.
 */
import type {
  ReferenceCandidate,
  ReferenceCoverage,
  ReferenceDiagnostic,
  ReferenceIdentity,
  ReferenceQueryInput,
  ReferenceTargetRead,
  ReferenceTargetSelector,
  ReferenceVersionSnapshot,
  ReferenceEdge,
  ParamRowSymbol,
  TextEntrySymbol,
  EventSymbol,
  MapEntitySymbol,
  MapRegionSymbol,
  TaeEventSymbol
} from '@soulforge/shared';
import type { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import { readParamFields } from '../param/containerParamEdit.js';
import type { ReferenceProviderPorts } from './referenceProviderRegistry.js';
import {
  identityFromSelector,
  type ResolveTargetResult
} from './referenceQueryService.js';
import type { ResourceVersion } from '../runtime/resourceVersion.js';

export interface WorkspaceReferenceRuntime {
  resolveTarget: (input: ReferenceQueryInput) => Promise<ResolveTargetResult>;
  readTargetFields: (input: {
    target: ReferenceIdentity;
    fieldIds: string[];
  }) => Promise<ReferenceTargetRead | null>;
  providerPorts: ReferenceProviderPorts;
  indexReferenceProvider: () => ReferenceEdge[];
  resolveUriIdentity: (uri: string) => ReferenceIdentity | undefined;
  coverageProvider: () => ReferenceCoverage;
}

export interface CreateWorkspaceReferenceRuntimeOptions {
  workspaceIndex: WorkspaceIndex;
  workspaceId: string;
  editSession?: NativeEditSession;
  generation?: () => number;
}

type IndexedTarget = {
  identity: ReferenceIdentity;
  version: ResourceVersion;
  /** Extra native/index payload consumed by providers; never serialized by the service. */
  payload?: Record<string, unknown>;
};

export function createWorkspaceReferenceRuntime(
  options: CreateWorkspaceReferenceRuntimeOptions
): WorkspaceReferenceRuntime {
  const { workspaceIndex: index, workspaceId } = options;
  const generation = options.generation ?? (() => 0);

  const resolveUriIdentity = (uri: string): ReferenceIdentity | undefined => {
    const bundle = index.toSymbolBundle();
    const event = (bundle.events ?? []).flatMap((item) => item.events).find((item) => item.uri === uri);
    if (event) return eventIdentity(event, workspaceId);
    const map = (bundle.maps ?? []).flatMap((item) => [...item.entities, ...item.regions])
      .find((item) => item.uri === uri);
    if (map) return mapIdentity(map, workspaceId);
    const row = (bundle.params ?? []).flatMap((item) => item.rows).find((item) => item.uri === uri);
    if (row) return paramIdentity(row, workspaceId);
    const text = (bundle.msgs ?? []).flatMap((item) => item.entries).find((item) => item.uri === uri);
    if (text) return textIdentity(text, workspaceId);
    const taeOwner = (bundle.tae ?? []).find((item) => item.animations.some((animation) => animation.events.some((event) => event.uri === uri)));
    const tae = taeOwner?.animations.flatMap((animation) => animation.events.map((event) => ({ animation, event })))
      .find((item) => item.event.uri === uri);
    if (tae) return taeIdentity(tae.event, workspaceId, taeOwner?.sourceUri, tae.animation);
    const file = index.getFile(uri);
    return file ? resourceIdentity(file.sourceUri, workspaceId, []) : undefined;
  };

  const resolveTarget = async (input: ReferenceQueryInput): Promise<ResolveTargetResult> => {
    const candidates = input.target
      ? resolveSelector(index, input.target, workspaceId, generation())
      : input.uri
        ? resolveUriTarget(index, input.uri, workspaceId, generation(), resolveUriIdentity)
        : input.query
          ? resolveQuery(index, input.query, input.domain, workspaceId, generation())
          : [];

    if (candidates.length === 1) {
      const candidate = candidates[0]!;
      return { resolution: 'resolved', target: candidate.identity, version: candidate.version };
    }
    if (candidates.length > 1) {
      return {
        resolution: 'ambiguous',
        candidates: candidates.slice(0, 16).map((candidate) => ({
          identity: candidate.identity,
          version: toVersionSnapshot(candidate.version),
          discriminators: {
            sourceUri: candidate.identity.sourceUri,
            domain: candidate.identity.domain,
            objectKey: candidate.identity.objectKey
          }
        }))
      };
    }

    const domain = input.domain ?? (input.target && 'domain' in input.target ? input.target.domain : undefined);
    const coverage = coverageForIndex(index, domain);
    const diagnostic: ReferenceDiagnostic = {
      code: input.query || input.uri || input.target
        ? 'REFERENCE_TARGET_NOT_INDEXED'
        : 'REFERENCE_TARGET_REQUIRED',
      message: input.query || input.uri || input.target
        ? '目标在当前工作区索引中不存在，不能把空候选解释为无引用。'
        : '需要 uri、query 或结构化 target。',
      severity: 'warning'
    };
    if (domain) diagnostic.domain = domain as NonNullable<ReferenceDiagnostic['domain']>;
    return { resolution: 'insufficient_evidence', diagnostics: [diagnostic, ...coverageDiagnostics(coverage)] };
  };

  const readTargetFields = async (input: {
    target: ReferenceIdentity;
    fieldIds: string[];
  }): Promise<ReferenceTargetRead | null> => {
    if (input.target.domain !== 'param' || !options.editSession || input.target.rowId === undefined) return null;
    const file = index.getFile(input.target.sourceUri);
    if (!file) return null;
    const table = input.target.entryName ?? input.target.namespace;
    if (!table) return null;
    const result = await readParamFields({
      edit: options.editSession,
      containerPath: file.absolutePath,
      queries: [{ table, rowIds: [input.target.rowId], fieldIds: input.fieldIds }]
    });
    if (!result.ok || result.fields.length === 0) return null;
    const first = result.fields[0]!;
    const version = versionForFile(file, generation(), first.sourceHash, first.sourceRevision);
    return {
      identity: input.target,
      version: toVersionSnapshot(version),
      fields: result.fields.map((field) => ({
        fieldId: field.fieldId,
        value: field.value,
        ...(field.displayName ? { displayName: field.displayName } : {})
      })),
      completeness: result.missingRows.length === 0 ? 'complete' : 'partial'
    };
  };

  const providerPorts: ReferenceProviderPorts = {
    readParamFields: async (raw) => {
      const value = raw as { target?: ReferenceIdentity; fieldIds?: string[] };
      if (!value.target || !Array.isArray(value.fieldIds)) return null;
      return readTargetFields({ target: value.target, fieldIds: value.fieldIds });
    },
    resolveEntity: async (raw) => raw
  };

  return {
    resolveTarget,
    readTargetFields,
    providerPorts,
    indexReferenceProvider: () => index.listReferences(),
    resolveUriIdentity,
    coverageProvider: () => coverageForIndex(index)
  };
}

function resolveSelector(
  index: WorkspaceIndex,
  selector: ReferenceTargetSelector,
  workspaceId: string,
  generation: number
): IndexedTarget[] {
  if ('objectHandle' in selector) {
    const identity = identityFromSelector(selector, workspaceId);
    return [{ identity, version: unknownVersion(generation) }];
  }
  const bundle = index.toSymbolBundle();
  if (selector.domain === 'param') {
    return (bundle.params ?? []).flatMap((item) => item.rows)
      .filter((row) => row.sourceUri === selector.sourceUri
        && row.rowId === selector.rowId
        && (selector.entryName === undefined || row.entryName === selector.entryName)
        && (selector.entryIndex === undefined || row.entryIndex === undefined || row.entryIndex === selector.entryIndex))
      .map((row) => ({ identity: paramIdentity(row, workspaceId), version: versionForIndexed(row, index, generation), payload: { row } }));
  }
  if (selector.domain === 'emevd') {
    return index.lookupEvents(selector.eventId, selector.sourceUri)
      .map((event) => ({ identity: eventIdentity(event, workspaceId), version: versionForIndexed(event, index, generation), payload: { event } }));
  }
  if (selector.domain === 'fmg') {
    return index.lookupTextEntries(selector.textId, selector.category)
      .filter((entry) => entry.sourceUri === selector.sourceUri
        && (selector.language === undefined || String(entry.raw ?? '').toLowerCase().includes(selector.language.toLowerCase())))
      .map((entry) => ({ identity: textIdentity(entry, workspaceId, selector.childChain), version: versionForIndexed(entry, index, generation), payload: { entry } }));
  }
  if (selector.domain === 'map') {
    return (bundle.maps ?? []).flatMap((item) => [...item.entities, ...item.regions])
      .filter((entity) => entity.sourceUri === selector.sourceUri
        && (entity.uri === selector.nativeObjectKey || entity.name === selector.nativeObjectKey || ('model' in entity && entity.model === selector.nativeObjectKey)))
      .map((entity) => ({ identity: mapIdentity(entity, workspaceId), version: versionForIndexed(entity, index, generation), payload: { entity } }));
  }
  if (selector.domain === 'tae') {
    return (bundle.tae ?? []).flatMap((item) => item.animations.flatMap((animation) => animation.events.map((event) => ({ item, animation, event }))))
      .filter(({ item, animation, event }) => item.sourceUri === selector.sourceUri
        && animation.animId === selector.animId
        && (selector.taeEntryIndex === undefined || animation.taeEntryIndex === selector.taeEntryIndex)
        && (selector.eventIndex === undefined || event.index === selector.eventIndex))
      .map(({ item, animation, event }) => ({
        identity: taeIdentity(event, workspaceId, item.sourceUri, animation),
        version: versionForFile(index.getFile(item.sourceUri), generation, item.outerFileHash ?? item.sourceHash, item.sourceRevision),
        payload: { event }
      }));
  }
  const file = index.getFile(selector.sourceUri);
  if (!file) return [];
  return [{ identity: resourceIdentity(file.sourceUri, workspaceId, selector.childChain, 'nativeObjectKey' in selector ? selector.nativeObjectKey : undefined), version: versionForFile(file, generation) }];
}

function resolveUriTarget(
  index: WorkspaceIndex,
  uri: string,
  workspaceId: string,
  generation: number,
  resolveUriIdentity: (uri: string) => ReferenceIdentity | undefined
): IndexedTarget[] {
  const exact = resolveUriIdentity(uri);
  if (exact) {
    const file = index.getFile(exact.sourceUri);
    return [{ identity: exact, version: versionForFile(file, generation) }];
  }
  const file = index.getFile(uri);
  return file
    ? [{ identity: resourceIdentity(file.sourceUri, workspaceId, []), version: versionForFile(file, generation) }]
    : [];
}

function resolveQuery(
  index: WorkspaceIndex,
  query: string,
  domain: ReferenceQueryInput['domain'],
  workspaceId: string,
  generation: number
): IndexedTarget[] {
  const out: IndexedTarget[] = [];
  const domains = domain ? [domain] : ['param', 'emevd', 'fmg', 'map', 'tae', 'resource'] as const;
  for (const item of domains) {
    if (item === 'param') {
      for (const result of index.searchParamRows(query, 8)) out.push({ identity: paramIdentity(result.item, workspaceId), version: versionForIndexed(result.item, index, generation), payload: { row: result.item } });
    } else if (item === 'emevd') {
      for (const result of index.searchEvents(query, 8)) out.push({ identity: eventIdentity(result.item, workspaceId), version: versionForIndexed(result.item, index, generation), payload: { event: result.item } });
    } else if (item === 'fmg') {
      for (const result of index.searchTextEntries(query, 8)) out.push({ identity: textIdentity(result.item, workspaceId), version: versionForIndexed(result.item, index, generation), payload: { entry: result.item } });
    } else if (item === 'map') {
      for (const result of index.searchMapEntities(query, 8)) out.push({ identity: mapIdentity(result.item, workspaceId), version: versionForIndexed(result.item, index, generation), payload: { entity: result.item } });
    } else if (item === 'tae') {
      for (const result of index.searchTaeEvents(query, 8)) {
        const owner = (index.toSymbolBundle().tae ?? []).find((item) => item.animations.some((animation) => animation.events.some((event) => event.uri === result.item.uri)));
        out.push({
          identity: taeIdentity(result.item, workspaceId, owner?.sourceUri),
          version: versionForFile(owner ? index.getFile(owner.sourceUri) : undefined, generation, owner?.outerFileHash ?? owner?.sourceHash, owner?.sourceRevision),
          payload: { event: result.item }
        });
      }
    } else {
      for (const result of index.searchResources({ query, limit: 8 })) out.push({ identity: resourceIdentity(result.item.sourceUri, workspaceId, []), version: versionForFile(result.item, generation) });
    }
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = JSON.stringify([item.identity.domain, item.identity.sourceUri, item.identity.objectKey]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function paramIdentity(row: ParamRowSymbol, workspaceId: string): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'param',
    sourceUri: row.sourceUri,
    outerId: row.sourceUri,
    childChain: [row.entryName ?? row.paramName],
    namespace: row.entryName ?? row.paramName,
    objectKey: `${row.entryName ?? row.paramName}#${row.rowId}`,
    rowId: row.rowId,
    ...(row.entryIndex !== undefined ? { entryIndex: row.entryIndex } : {}),
    ...(row.entryName ? { entryName: row.entryName } : {})
  };
}

function eventIdentity(event: EventSymbol, workspaceId: string): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'emevd',
    sourceUri: event.sourceUri,
    outerId: event.sourceUri,
    childChain: ['event', String(event.eventId)],
    namespace: 'event',
    objectKey: `event#${event.eventId}`,
    eventId: event.eventId,
    ...(event.name ? { label: event.name } : {})
  };
}

function textIdentity(entry: TextEntrySymbol, workspaceId: string, childChain?: string[]): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'fmg',
    sourceUri: entry.sourceUri,
    outerId: entry.sourceUri,
    childChain: childChain ?? [entry.category ?? 'default', String(entry.textId)],
    namespace: entry.category ?? 'default',
    objectKey: `${entry.category ?? 'default'}#${entry.textId}`,
    textId: entry.textId,
    ...(entry.category ? { label: entry.category } : {})
  };
}

function mapIdentity(entity: MapEntitySymbol | MapRegionSymbol, workspaceId: string): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'map',
    sourceUri: entity.sourceUri,
    outerId: entity.sourceUri,
    childChain: [entity.mapId, entity.name],
    namespace: entity.mapId,
    objectKey: entity.uri,
    ...(entity.entityId !== undefined ? { nativeObjectKey: String(entity.entityId) } : { nativeObjectKey: entity.name })
  };
}

function taeIdentity(
  event: TaeEventSymbol,
  workspaceId: string,
  sourceUri?: string,
  animation?: { animId: number; taeEntryIndex?: number; taeEntryName?: string }
): ReferenceIdentity {
  const animId = animation?.animId ?? Number(event.uri.match(/#A(\d+)/i)?.[1] ?? 0);
  return {
    workspaceId,
    domain: 'tae',
    sourceUri: sourceUri ?? event.uri.split('#')[0] ?? event.uri,
    outerId: event.uri,
    childChain: [animation?.taeEntryName ?? event.taeEntryName ?? 'tae', String(animId), String(event.index)],
    namespace: animation?.taeEntryName ?? event.taeEntryName ?? 'tae',
    objectKey: event.uri,
    animId,
    rowIndex: event.index,
    ...(animation?.taeEntryIndex !== undefined ? { entryIndex: animation.taeEntryIndex } : {})
  };
}

function resourceIdentity(sourceUri: string, workspaceId: string, childChain: string[], nativeObjectKey?: string): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'resource',
    sourceUri,
    outerId: sourceUri,
    childChain,
    namespace: childChain[0] ?? 'resource',
    objectKey: nativeObjectKey ? `${sourceUri}#${nativeObjectKey}` : sourceUri,
    ...(nativeObjectKey ? { nativeObjectKey } : {})
  };
}

function versionForIndexed(value: { sourceUri: string; outerFileHash?: string; sourceHash?: string; sourceRevision?: number }, index: WorkspaceIndex, generation: number): ResourceVersion {
  return versionForFile(index.getFile(value.sourceUri), generation, value.outerFileHash ?? value.sourceHash, value.sourceRevision);
}

function versionForFile(file: { sha256?: string; mtimeMs?: number; size?: number } | undefined, generation: number, outerFileHash?: string, sourceRevision?: number): ResourceVersion {
  return {
    outerFileHash: outerFileHash ?? file?.sha256 ?? '0'.repeat(64),
    generation,
    ...(sourceRevision !== undefined || file?.mtimeMs !== undefined
      ? { sourceRevision: sourceRevision ?? file!.mtimeMs }
      : {}),
    ...(file?.mtimeMs !== undefined ? { mtimeMs: file.mtimeMs } : {}),
    ...(file?.size !== undefined ? { size: file.size } : {})
  };
}

function unknownVersion(generation: number): ResourceVersion {
  return { outerFileHash: '0'.repeat(64), generation };
}

function toVersionSnapshot(version: ResourceVersion): ReferenceVersionSnapshot {
  return {
    outerFileHash: version.outerFileHash,
    ...(version.sourceRevision !== undefined ? { sourceRevision: version.sourceRevision } : {}),
    generation: version.generation
  };
}

function coverageForIndex(index: WorkspaceIndex, domain?: string): ReferenceCoverage {
  const states = index.getCoverageSnapshot().filter((state) => !domain || state.domain === domain);
  const domains = states.map((state) => ({
    domain: normalizeCoverageDomain(state.domain),
    status: state.status === 'parse_failed' ? 'failed' as const
      : state.status === 'source_unavailable' ? 'unscanned' as const
        : state.status === 'stale' ? 'partial' as const
          : state.status,
    ...(state.expectedResources !== null ? { discovered: state.expectedResources } : {}),
    readOk: state.coveredResources,
    ...(state.diagnostics.length > 0 ? { notes: state.diagnostics } : {})
  }));
  const complete = states.length > 0 && states.every((state) => state.status === 'complete' && state.predicateCompleteness.status === 'complete');
  return {
    scopeDescription: domain ? `workspace domain=${domain}` : 'workspace index',
    predicateComplete: complete,
    domains,
    unresolvedSources: [],
    failedSources: states.filter((state) => state.status === 'parse_failed').flatMap((state) => state.coveredResourceIds),
    unscannedSources: states.filter((state) => state.status !== 'complete').flatMap((state) => state.expectedResourceIds ?? []),
    allowsNegativeClaim: complete
  };
}

function normalizeCoverageDomain(domain?: string): ReferenceCoverage['domains'][number]['domain'] {
  switch (domain) {
    case 'event': return 'emevd';
    case 'msg': return 'fmg';
    case 'action': return 'tae';
    case 'workspace':
    case undefined: return 'workspace';
    default: return domain as ReferenceCoverage['domains'][number]['domain'];
  }
}

function coverageDiagnostics(coverage: ReferenceCoverage): ReferenceDiagnostic[] {
  return coverage.domains.filter((domain) => domain.status !== 'complete').slice(0, 8).map((domain) => ({
    code: 'REFERENCE_COVERAGE_INCOMPLETE',
    message: `${domain.domain} 当前覆盖为 ${domain.status}，未找到目标不能解释为无引用。`,
    severity: 'warning' as const,
    domain: domain.domain === 'workspace' ? 'other' : domain.domain
  }));
}
