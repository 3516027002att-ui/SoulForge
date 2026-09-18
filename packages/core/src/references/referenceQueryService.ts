/**
 * Reference query orchestration: resolve → lock version → collect providers → page.
 * Does not recurse into resolveEntity → chrLinkage → referenceService.
 */
import type {
  ReferenceCandidate,
  ReferenceCoverage,
  ReferenceDiagnostic,
  ReferenceIdentity,
  ReferencePageRecord,
  ReferenceQueryInput,
  ReferenceRelationItem,
  ReferenceTargetRead,
  ReferenceTargetSelector
  ,ReferenceVersionSnapshot
} from '@soulforge/shared';
import type { ReferenceEdge } from '@soulforge/shared';
import { buildReferenceDependencyDigest, referenceIdentityKey } from '@soulforge/shared';
import type { NativeEditSession } from '../editing/nativeEditSession.js';
import type { NativeReadProofStore } from '../editing/nativeReadProofStore.js';
import type { NativeSnapshotCache } from '../runtime/nativeSnapshotCache.js';
import type { ResourceVersionClock } from '../runtime/resourceVersion.js';
import {
  baselineCapabilityMatrix,
  createReferenceProviderRegistry,
  type ReferenceProviderRegistry,
  type ReferenceProviderPorts
} from './referenceProviderRegistry.js';
import { createParamReferenceProvider } from './paramReferenceProvider.js';
import { createEventReferenceProvider } from './eventReferenceProvider.js';
import { createScriptReferenceProvider } from './scriptReferenceProvider.js';
import { createMapReferenceProvider } from './mapReferenceProvider.js';
import { createResourceReferenceProvider } from './resourceReferenceProvider.js';
import { projectReferencePage } from './referencePageProjection.js';

export interface ReferenceQueryServiceOptions {
  principal: string;
  workspaceId: string;
  workspaceSession: unknown;
  editSession: NativeEditSession;
  workspaceIndex?: unknown;
  snapshotCache: NativeSnapshotCache;
  versionClock: ResourceVersionClock;
  nativeReadProofs: NativeReadProofStore;
  providerRegistry?: ReferenceProviderRegistry;
  /** Injection for tests: resolve precise/query targets. */
  resolveTarget?: (input: ReferenceQueryInput) => Promise<ResolveTargetResult>;
  readTargetFields?: (input: {
    target: ReferenceIdentity;
    fieldIds: string[];
  }) => Promise<ReferenceTargetRead | null>;
  serializeEnvelope?: (record: ReferencePageRecord) => string;
  maxScanSources?: number;
  providerPorts?: ReferenceProviderPorts;
  /** Current indexed edges are an independent provider, not a fallback. */
  indexReferenceProvider?: () => ReferenceEdge[];
  /** Resolve a canonical symbol URI while continuing an opaque cursor. */
  resolveUriIdentity?: (uri: string) => ReferenceIdentity | undefined;
  /** Host-provided source coverage; absence is incomplete, never complete. */
  coverageProvider?: () => ReferenceCoverage;
}

export type ResolveTargetResult =
  | { resolution: 'resolved'; target: ReferenceIdentity; version: import('../runtime/resourceVersion.js').ResourceVersion }
  | { resolution: 'ambiguous'; candidates: ReferenceCandidate[]; diagnostics?: ReferenceDiagnostic[] }
  | { resolution: 'insufficient_evidence'; diagnostics: ReferenceDiagnostic[] }
  | { resolution: 'not_found'; diagnostics: ReferenceDiagnostic[]; coverage: ReferenceCoverage };

export class ReferenceQueryService {
  private readonly options: ReferenceQueryServiceOptions;
  private readonly registry: ReferenceProviderRegistry;
  private readonly shards = new Map<string, { relations: ReferenceRelationItem[]; versionTag: string }>();

  constructor(options: ReferenceQueryServiceOptions) {
    this.options = options;
    this.registry = options.providerRegistry ?? defaultRegistry();
  }

  get providerRegistry(): ReferenceProviderRegistry {
    return this.registry;
  }

  invalidateSource(sourceKey: string): void {
    for (const key of [...this.shards.keys()]) {
      if (key.includes(sourceKey)) this.shards.delete(key);
    }
  }

  async query(input: ReferenceQueryInput): Promise<ReferencePageRecord> {
    const resolve = this.options.resolveTarget ?? defaultResolveTarget;
    const cursor = input.cursor ? decodeServiceCursor(input.cursor) : null;
    if (input.cursor && !cursor) return cursorScopeFailure('游标格式无效或已损坏。');

    const continuationInput: ReferenceQueryInput = cursor
      ? {
          ...(cursor.targetSelector ? { target: cursor.targetSelector } : {}),
          direction: cursor.direction,
          detail: cursor.detail,
          depth: cursor.depth,
          limit: cursor.limit,
          includeHypotheses: cursor.includeHypotheses
        }
      : input;
    const resolved = await resolve(continuationInput);

    if (resolved.resolution === 'ambiguous') {
      return {
        resolution: 'ambiguous',
        candidates: resolved.candidates,
        relations: [],
        coverage: emptyCoverage('ambiguous-resolution-only', false),
        page: {
          returnedCount: 0,
          hasMore: false,
          dependencyDigest: '',
          sortVersion: 'ref-v1'
        },
        diagnostics: resolved.diagnostics ?? [],
        nextActions: resolved.candidates.slice(0, 8).map((candidate) => ({
          tool: 'find_references',
          args: { target: selectorFromIdentity(candidate.identity), direction: input.direction, detail: input.detail },
          reason: '选定候选精确身份后再次查询'
        }))
      };
    }

    if (resolved.resolution !== 'resolved') {
      const diagnostics = 'diagnostics' in resolved ? resolved.diagnostics : [];
      return {
        resolution: resolved.resolution,
        candidates: [],
        relations: [],
        coverage: 'coverage' in resolved && resolved.coverage
          ? resolved.coverage
          : emptyCoverage(resolved.resolution, resolved.resolution === 'not_found'),
        page: {
          returnedCount: 0,
          hasMore: false,
          dependencyDigest: '',
          sortVersion: 'ref-v1'
        },
        diagnostics,
        nextActions: []
      };
    }

    const target = resolved.target;
    if (cursor && cursor.targetKey !== referenceIdentityKey(target)) {
      return cursorScopeFailure('游标绑定的目标已变化，必须从新的精确目标重新查询。');
    }
    let targetRead: ReferenceTargetRead | undefined;
    if (input.fieldIds && input.fieldIds.length > 0) {
      if (this.options.readTargetFields) {
        const read = await this.options.readTargetFields({ target, fieldIds: input.fieldIds });
        if (read) targetRead = read;
      }
    }

    const collected = await this.collectRelations({
      target,
      direction: input.direction,
      detail: input.detail,
      depth: input.depth,
      includeHypotheses: input.includeHypotheses,
      ...(input.fieldIds ? { fieldIds: input.fieldIds } : {}),
      ...(targetRead ? { targetRead } : {})
    });
    const allRelations = collected.relations;

    const hostCoverage = this.options.coverageProvider?.();
    const coverage = mergeCoverage(
      hostCoverage ?? coverageFromProviderNotes(collected.coverageNotes, target.domain),
      collected.coverageNotes,
      collected.diagnostics,
      target
    );
    const offset = cursor?.offset ?? 0;
    const requestedLimit = Math.max(1, Math.min(32, input.limit || cursor?.limit || 8));
    const pageRelations = allRelations.slice(offset, offset + requestedLimit);
    const hasMoreBeforeProjection = offset + pageRelations.length < allRelations.length;

    const record: ReferencePageRecord = {
      resolution: 'resolved',
      target,
      targetVersion: resolved.version,
      ...(targetRead ? { targetRead } : {}),
      candidates: [],
      relations: pageRelations,
      coverage,
      page: {
        returnedCount: pageRelations.length,
        hasMore: hasMoreBeforeProjection,
        ...(hasMoreBeforeProjection
          ? {
              cursor: encodeServiceCursor({
                offset: offset + pageRelations.length,
                digest: buildReferenceDependencyDigest([
                  { sourceKey: referenceIdentityKey(target), version: toVersionSnapshot(resolved.version) }
                ]),
                targetKey: referenceIdentityKey(target),
                targetSelector: selectorFromIdentity(target),
                direction: input.direction,
                detail: input.detail,
                depth: input.depth,
                limit: requestedLimit,
                includeHypotheses: input.includeHypotheses
              })
            }
          : {}) ,
        dependencyDigest: buildReferenceDependencyDigest([
          { sourceKey: referenceIdentityKey(target), version: toVersionSnapshot(resolved.version) }
        ]),
        sortVersion: 'ref-v1'
      },
      diagnostics: collected.diagnostics,
      nextActions: pageRelations.length === 0 && !coverage.allowsNegativeClaim
        ? [{ tool: 'find_references', args: { target: selectorFromIdentity(target), includeHypotheses: true }, reason: '覆盖不足，不可宣称无引用' }]
        : []
    };

    const serialize = this.options.serializeEnvelope ?? defaultSerialize;
    const projected = projectReferencePage({
      record,
      serialize,
      cursorForOffset: (pageOffset, digest) => encodeServiceCursor({
        offset: offset + pageOffset,
        digest,
        targetKey: referenceIdentityKey(target),
        targetSelector: selectorFromIdentity(target),
        direction: input.direction,
        detail: input.detail,
        depth: input.depth,
        limit: requestedLimit,
        includeHypotheses: input.includeHypotheses
      })
    });
    if (!projected.ok) {
      return {
        ...record,
        relations: [],
        page: {
          returnedCount: 0,
          hasMore: false,
          dependencyDigest: record.page.dependencyDigest,
          sortVersion: 'ref-v1',
          truncationReason: projected.code
        },
        diagnostics: [{
          code: projected.code,
          message: projected.message,
          severity: 'error'
        }],
        nextActions: [
          ...(record.nextActions ?? []),
          { tool: 'read_param_fields', args: { table: '…', rowIds: [], fieldIds: [] }, reason: projected.message }
        ]
      };
    }
    return projected.record;
  }

  private async collectRelations(input: {
    target: ReferenceIdentity;
    direction: ReferenceQueryInput['direction'];
    detail: ReferenceQueryInput['detail'];
    depth: number;
    includeHypotheses: boolean;
    fieldIds?: string[];
    targetRead?: ReferenceTargetRead;
  }): Promise<{
    relations: ReferenceRelationItem[];
    coverageNotes: Array<{ domain: string; status: 'complete' | 'partial' | 'unscanned' | 'failed' | 'unsupported' | 'skipped'; notes?: string[] }>;
    diagnostics: ReferenceDiagnostic[];
  }> {
    const providers = this.registry.forDomain(input.target.domain);
    const drafts: Array<{ relationKind: string; certainty: ReferenceRelationItem['certainty']; from: unknown; to: unknown; evidence: unknown; path?: unknown[]; limitNote?: string }> = [];
    const diagnostics: ReferenceDiagnostic[] = [];
    const coverageNotes: Array<{ domain: string; status: 'complete' | 'partial' | 'unscanned' | 'failed' | 'unsupported' | 'skipped'; notes?: string[] }> = [];
    const ports = this.options.providerPorts ?? {};

    for (const provider of providers.length > 0 ? providers : this.registry.list()) {
      const result = await provider.collect({
        targetDomain: input.target.domain,
        target: {
          ...input.target,
          ...(input.targetRead ? { fieldValues: Object.fromEntries(input.targetRead.fields.map((f) => [f.fieldId, f.value])) } : {}),
          containerEntries: (input.target as { containerEntries?: string[] }).containerEntries ?? [],
          metadataByField: (input.target as { metadataByField?: Record<string, { refs?: string }> }).metadataByField ?? {}
        },
        direction: input.direction,
        detail: input.detail,
        depth: input.depth,
        includeHypotheses: input.includeHypotheses,
        ...(input.fieldIds ? { fieldIds: input.fieldIds } : {}),
        ports
      });
      for (const draft of result.relations) {
        if (draft.certainty === 'hypothesis' && !input.includeHypotheses) continue;
        drafts.push(draft as typeof drafts[number]);
      }
      coverageNotes.push(...result.coverageNotes);
      diagnostics.push(...result.diagnostics);
    }

    // The index provider is deliberately independent from semantic providers:
    // it is valid evidence for already indexed edges, but its coverage is not
    // upgraded to a complete native read merely because it has rows.
    if (this.options.indexReferenceProvider) {
      for (const edge of this.options.indexReferenceProvider()) {
        const indexedFrom = this.options.resolveUriIdentity?.(edge.fromUri);
        const indexedTo = this.options.resolveUriIdentity?.(edge.toUri);
        const matchesFrom = edge.fromUri === input.target.objectKey || edge.fromUri === input.target.sourceUri
          || (indexedFrom ? identityKeyMatches(indexedFrom, input.target) : false);
        const matchesTo = edge.toUri === input.target.objectKey || edge.toUri === input.target.sourceUri
          || (indexedTo ? identityKeyMatches(indexedTo, input.target) : false);
        if ((input.direction === 'from' && !matchesFrom) || (input.direction === 'to' && !matchesTo)
          || (input.direction === 'both' && !matchesFrom && !matchesTo)) continue;
        const from = this.options.resolveUriIdentity?.(edge.fromUri) ?? indexedEdgeIdentity(edge.fromUri, input.target.workspaceId);
        const to = this.options.resolveUriIdentity?.(edge.toUri) ?? indexedEdgeIdentity(edge.toUri, input.target.workspaceId);
        drafts.push({
          relationKind: edge.kind,
          certainty: edge.confidence === 'high' ? 'confirmed' : edge.confidence === 'medium' ? 'indirect' : 'hypothesis',
          from,
          to,
          evidence: {
            version: versionFromEdge(edge),
            location: { sourceUri: edge.evidence[0]?.sourceUri ?? edge.fromUri, domain: from.domain, locator: edge.toUri },
            ...(input.detail === 'context' ? {
              statement: {
                kind: 'source-text',
                text: edge.reason,
                language: 'indexed-reference'
              }
            } : {}),
            diagnostics: edge.evidence.map((item) => item.excerpt).filter((item): item is string => Boolean(item))
          },
          path: [from, to]
        });
      }
      coverageNotes.push({ domain: input.target.domain, status: 'partial', notes: ['indexed_edge_provider'] });
    }

    // Stable sort: confirmed first, then relationKind, then object keys.
    const mapped = drafts
      .map((draft, index) => draftToItem(draft, index, input.target, input.detail))
      .filter((item) => relationMatchesDirection(item, input.target, input.direction));
    const dedupe = new Set<string>();
    const unique = mapped.filter((item) => {
      const key = `${referenceIdentityKey(item.from)}|${referenceIdentityKey(item.to)}|${item.relationKind}|${item.evidence.location.locator}`;
      if (dedupe.has(key)) return false;
      dedupe.add(key);
      return true;
    });
    unique.sort((a, b) => {
      const rank = (item: ReferenceRelationItem): number => item.certainty === 'confirmed' ? 0 : item.certainty === 'indirect' ? 1 : 2;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.relationKind !== b.relationKind) return a.relationKind < b.relationKind ? -1 : 1;
      return referenceIdentityKey(a.to) < referenceIdentityKey(b.to) ? -1 : 1;
    });
    return { relations: unique, coverageNotes, diagnostics };
  }
}

function draftToItem(
  draft: { relationKind: string; certainty: ReferenceRelationItem['certainty']; from: unknown; to: unknown; evidence: unknown; path?: unknown[]; limitNote?: string },
  index: number,
  root: ReferenceIdentity,
  detail: ReferenceQueryInput['detail']
): ReferenceRelationItem {
  const from = (draft.from ?? root) as ReferenceIdentity;
  const to = draft.to as ReferenceIdentity;
  const evidence = draft.evidence as ReferenceRelationItem['evidence'];
  const normalizedEvidence = evidence ?? { version: {}, location: { sourceUri: from.sourceUri, domain: from.domain, locator: from.objectKey } };
  const edgeEvidence = detail === 'edges'
    ? (() => {
        const { statement: _statement, ...withoutStatement } = normalizedEvidence;
        return withoutStatement;
      })()
    : {
        ...normalizedEvidence,
        statement: normalizedEvidence.statement ?? {
          kind: 'source-text',
          text: `${draft.relationKind}: ${from.objectKey} -> ${to.objectKey}`,
          language: 'indexed-reference'
        }
      };
  return {
    relationId: `rel_${index}_${referenceIdentityKey(to).slice(0, 80)}`,
    from,
    to,
    relationKind: draft.relationKind,
    certainty: draft.certainty,
    evidence: edgeEvidence,
    path: (draft.path as ReferenceIdentity[] | undefined) ?? [from, to],
    ...(draft.limitNote ? { limitNote: draft.limitNote } : {})
  };
}

function defaultRegistry(): ReferenceProviderRegistry {
  return createReferenceProviderRegistry([
    createParamReferenceProvider(),
    createEventReferenceProvider(),
    createScriptReferenceProvider(),
    createMapReferenceProvider(),
    createResourceReferenceProvider()
  ]);
}

async function defaultResolveTarget(input: ReferenceQueryInput): Promise<ResolveTargetResult> {
  const diagnostics: ReferenceDiagnostic[] = [{
    code: 'REFERENCE_RESOLVER_REQUIRED',
    message: '未注入目标解析端口；query/target 需要宿主 resolveEntity 或精确选择器解码结果。',
    severity: 'error'
  }];
  if (input.target) {
    const identity = identityFromSelector(input.target, 'unknown');
    return {
      resolution: 'resolved',
      target: identity,
      version: {
        outerFileHash: '0'.repeat(64),
        generation: 0
      }
    };
  }
  return { resolution: 'insufficient_evidence', diagnostics };
}

export function identityFromSelector(selector: ReferenceTargetSelector, workspaceId: string): ReferenceIdentity {
  if ('objectHandle' in selector) {
    return {
      workspaceId,
      domain: 'other',
      sourceUri: '',
      outerId: selector.objectHandle,
      childChain: [],
      namespace: 'handle',
      objectKey: selector.objectHandle,
      objectHandle: selector.objectHandle
    };
  }
  switch (selector.domain) {
    case 'param':
      return {
        workspaceId,
        domain: 'param',
        sourceUri: selector.sourceUri,
        outerId: selector.sourceUri,
        childChain: selector.entryName ? [selector.entryName] : [String(selector.entryIndex)],
        namespace: selector.entryName ?? String(selector.entryIndex),
        objectKey: `${selector.entryName ?? selector.entryIndex}#${selector.rowId}`,
        rowId: selector.rowId,
        ...(selector.rowIndex !== undefined ? { rowIndex: selector.rowIndex } : {}),
        entryIndex: selector.entryIndex,
        ...(selector.entryName ? { entryName: selector.entryName } : {})
      };
    case 'emevd':
      return {
        workspaceId,
        domain: 'emevd',
        sourceUri: selector.sourceUri,
        outerId: selector.sourceUri,
        childChain: ['event', String(selector.eventId)],
        namespace: 'event',
        objectKey: `event#${selector.eventId}`,
        eventId: selector.eventId
      };
    default: {
      const childChain = 'childChain' in selector ? selector.childChain : [];
      return {
        workspaceId,
        domain: selector.domain,
        sourceUri: selector.sourceUri,
        outerId: selector.sourceUri,
        childChain: childChain ?? [],
        namespace: childChain?.[0] ?? selector.domain,
        objectKey: JSON.stringify(selector)
      };
    }
  }
}

export function selectorFromIdentity(identity: ReferenceIdentity): ReferenceTargetSelector {
  if (identity.objectHandle) return { objectHandle: identity.objectHandle };
  if (identity.domain === 'param' && identity.rowId !== undefined) {
    return {
      domain: 'param',
      sourceUri: identity.sourceUri,
      entryIndex: identity.entryIndex ?? 0,
      ...(identity.entryName ? { entryName: identity.entryName } : {}),
      rowId: identity.rowId,
      ...(identity.rowIndex !== undefined ? { rowIndex: identity.rowIndex } : {})
    };
  }
  if (identity.domain === 'emevd' && identity.eventId !== undefined) {
    return { domain: 'emevd', sourceUri: identity.sourceUri, eventId: identity.eventId };
  }
  if (identity.domain === 'fmg' && identity.textId !== undefined) {
    return {
      domain: 'fmg',
      sourceUri: identity.sourceUri,
      childChain: identity.childChain.length > 0 ? identity.childChain : ['default', String(identity.textId)],
      category: identity.namespace,
      textId: identity.textId,
      ...(identity.entryIndex !== undefined ? { entryIndex: identity.entryIndex } : {})
    };
  }
  if (identity.domain === 'map' && identity.nativeObjectKey) {
    return { domain: 'map', sourceUri: identity.sourceUri, nativeObjectKey: identity.nativeObjectKey };
  }
  if (identity.domain === 'tae' && identity.animId !== undefined) {
    return {
      domain: 'tae',
      sourceUri: identity.sourceUri,
      childChain: identity.childChain.length > 0 ? identity.childChain : ['tae', String(identity.animId)],
      taeEntryIndex: identity.entryIndex ?? 0,
      animId: identity.animId,
      ...(identity.rowIndex !== undefined ? { eventIndex: identity.rowIndex } : {})
    };
  }
  if (identity.domain === 'script') {
    return { domain: 'script', sourceUri: identity.sourceUri, childChain: identity.childChain };
  }
  return {
    domain: 'resource',
    sourceUri: identity.sourceUri,
    childChain: identity.childChain,
    ...(identity.nativeObjectKey ? { nativeObjectKey: identity.nativeObjectKey } : {})
  };
}

function toVersionSnapshot(version: import('../runtime/resourceVersion.js').ResourceVersion): import('@soulforge/shared').ReferenceVersionSnapshot {
  return {
    outerFileHash: version.outerFileHash,
    ...(version.childHash ? { childHash: version.childHash } : {}),
    ...(version.dataHash ? { dataHash: version.dataHash } : {}),
    ...(version.sourceRevision !== undefined ? { sourceRevision: version.sourceRevision } : {}),
    ...(version.readerSchema ? { readerSchema: version.readerSchema } : {}),
    ...(version.metadataSchema ? { metadataSchema: version.metadataSchema } : {}),
    generation: version.generation
  };
}

function emptyCoverage(scope: string, allowsNegative: boolean): ReferenceCoverage {
  return {
    scopeDescription: scope,
    predicateComplete: allowsNegative,
    domains: baselineCapabilityMatrix().map((cap) => ({
      domain: cap.resourceKind as never,
      status: cap.support === 'supported' ? 'complete' : cap.support === 'partial' ? 'partial' : 'unsupported',
      ...(cap.uncoveredReason ? { notes: [cap.uncoveredReason] } : {})
    })),
    unresolvedSources: [],
    failedSources: [],
    unscannedSources: [],
    allowsNegativeClaim: allowsNegative
  };
}

interface ServiceCursor {
  offset: number;
  digest: string;
  targetKey: string;
  targetSelector?: ReferenceTargetSelector;
  direction: ReferenceQueryInput['direction'];
  detail: ReferenceQueryInput['detail'];
  depth: number;
  limit: number;
  includeHypotheses: boolean;
}

function encodeServiceCursor(value: ServiceCursor): string {
  return `sf_ref_${Buffer.from(JSON.stringify({
    v: 2,
    o: value.offset,
    d: value.digest,
    t: value.targetKey,
    s: value.targetSelector,
    dir: value.direction,
    det: value.detail,
    depth: value.depth,
    limit: value.limit,
    h: value.includeHypotheses
  }), 'utf8').toString('base64url')}`;
}

function decodeServiceCursor(value: string): ServiceCursor | null {
  if (!value.startsWith('sf_ref_')) return null;
  try {
    const raw = JSON.parse(Buffer.from(value.slice('sf_ref_'.length), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (raw.v !== 2 || !Number.isSafeInteger(raw.o) || (raw.o as number) < 0
      || typeof raw.d !== 'string' || typeof raw.t !== 'string'
      || !['from', 'to', 'both'].includes(String(raw.dir))
      || !['edges', 'context'].includes(String(raw.det))
      || !Number.isSafeInteger(raw.depth) || !Number.isSafeInteger(raw.limit)) return null;
    return {
      offset: raw.o as number,
      digest: raw.d,
      targetKey: raw.t,
      ...(raw.s && typeof raw.s === 'object' ? { targetSelector: raw.s as ReferenceTargetSelector } : {}),
      direction: raw.dir as ServiceCursor['direction'],
      detail: raw.det as ServiceCursor['detail'],
      depth: raw.depth as number,
      limit: raw.limit as number,
      includeHypotheses: raw.h === true
    };
  } catch {
    return null;
  }
}

function cursorScopeFailure(message: string): ReferencePageRecord {
  return {
    resolution: 'insufficient_evidence',
    candidates: [],
    relations: [],
    coverage: emptyCoverage('cursor-scope-invalid', false),
    page: { returnedCount: 0, hasMore: false, dependencyDigest: '', sortVersion: 'ref-v1' },
    diagnostics: [{ code: 'REFERENCE_CURSOR_SCOPE_MISMATCH', message, severity: 'error' }],
    nextActions: []
  };
}

function indexedEdgeIdentity(uri: string, workspaceId: string): ReferenceIdentity {
  return {
    workspaceId,
    domain: 'other',
    sourceUri: uri,
    outerId: uri,
    childChain: [],
    namespace: 'indexed-edge',
    objectKey: uri
  };
}

function versionFromEdge(edge: ReferenceEdge): ReferenceVersionSnapshot {
  void edge;
  return { generation: 0 };
}

function relationMatchesDirection(
  relation: ReferenceRelationItem,
  target: ReferenceIdentity,
  direction: ReferenceQueryInput['direction']
): boolean {
  const targetKey = referenceIdentityKey(target);
  const from = referenceIdentityKey(relation.from);
  const to = referenceIdentityKey(relation.to);
  // Providers may return a physical source URI instead of the exact symbol
  // identity. Accept it only when it is the same source and domain, never by
  // relation direction alone.
  const same = (identity: ReferenceIdentity): boolean => identityKeyMatches(identity, target) || (
    identity.sourceUri === target.sourceUri && identity.domain === target.domain
  );
  void targetKey;
  void from;
  void to;
  if (direction === 'from') return same(relation.from);
  if (direction === 'to') return same(relation.to);
  return same(relation.from) || same(relation.to);
}

function identityKeyMatches(a: ReferenceIdentity, b: ReferenceIdentity): boolean {
  return referenceIdentityKey(a) === referenceIdentityKey(b)
    || a.objectKey === b.objectKey && a.sourceUri === b.sourceUri && a.domain === b.domain;
}

function coverageFromProviderNotes(
  notes: Array<{ domain: string; status: 'complete' | 'partial' | 'unscanned' | 'failed' | 'unsupported' | 'skipped'; notes?: string[] }>,
  targetDomain: string
): ReferenceCoverage {
  const domains = notes.length > 0 ? notes.map((note) => ({
    domain: note.domain as ReferenceCoverage['domains'][number]['domain'],
    status: note.status,
    ...(note.notes ? { notes: note.notes } : {})
  })) : [{ domain: targetDomain as ReferenceCoverage['domains'][number]['domain'], status: 'unscanned' as const, notes: ['provider_coverage_missing'] }];
  const complete = domains.every((domain) => domain.status === 'complete');
  return {
    scopeDescription: `target-domain=${targetDomain}`,
    predicateComplete: complete,
    domains,
    unresolvedSources: [],
    failedSources: domains.filter((domain) => domain.status === 'failed').map((domain) => domain.domain),
    unscannedSources: domains.filter((domain) => domain.status === 'unscanned' || domain.status === 'skipped').map((domain) => domain.domain),
    allowsNegativeClaim: complete
  };
}

function mergeCoverage(
  base: ReferenceCoverage,
  notes: Array<{ domain: string; status: 'complete' | 'partial' | 'unscanned' | 'failed' | 'unsupported' | 'skipped'; notes?: string[] }>,
  diagnostics: ReferenceDiagnostic[],
  target: ReferenceIdentity
): ReferenceCoverage {
  const byDomain = new Map(base.domains.map((domain) => [domain.domain, domain]));
  for (const note of notes) {
    const domain = note.domain as ReferenceCoverage['domains'][number]['domain'];
    const previous = byDomain.get(domain);
    const rank = (status: string): number => ({ complete: 0, partial: 1, skipped: 2, unscanned: 3, not_indexed: 3, failed: 4, unsupported: 5 }[status] ?? 5);
    const selected = !previous || rank(note.status) > rank(previous.status) ? note.status : previous.status;
    byDomain.set(domain, {
      ...(previous ?? { domain }),
      status: selected,
      ...(note.notes || previous?.notes ? { notes: [...new Set([...(previous?.notes ?? []), ...(note.notes ?? [])])] } : {})
    });
  }
  const domains = [...byDomain.values()];
  const complete = base.predicateComplete && domains.every((domain) => domain.status === 'complete') && !diagnostics.some((item) => item.severity === 'error');
  return {
    ...base,
    scopeDescription: `target=${target.objectKey}`,
    domains,
    predicateComplete: complete,
    allowsNegativeClaim: complete,
    failedSources: [...new Set([...base.failedSources, ...domains.filter((domain) => domain.status === 'failed').map((domain) => domain.domain)])],
    unscannedSources: [...new Set([...base.unscannedSources, ...domains.filter((domain) => ['unscanned', 'not_indexed', 'skipped'].includes(domain.status)).map((domain) => domain.domain)])]
  };
}

function defaultSerialize(record: ReferencePageRecord): string {
  return JSON.stringify(record);
}

export function createReferenceQueryService(options: ReferenceQueryServiceOptions): ReferenceQueryService {
  return new ReferenceQueryService(options);
}
