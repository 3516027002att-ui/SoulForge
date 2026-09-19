/**
 * 关联页投影 + envelope 预算（T08，执行指令 §T08 步骤 6-8、最终投影 1-7）。
 *
 * 职责：
 * - 把 provider 的 ReferenceEdge（confidence 词表）投影成对外的
 *   ReferenceRelationItem（certainty 词表 confirmed/indirect/hypothesis），
 *   补齐真实语句、位置与完整身份；不能解析的位置保留诊断，不编造摘要句。
 * - 稳定排序：确定关系优先，来源类型与完整身份作为次级键（步骤 6）。
 * - envelope 预算：对外序列化走 content-first projection，不把 evidence、版本或
 *   hash 带进页面；缩页只整条移除 relation，长 source snippet 显式 truncated 并
 *   提供 readAction，identity/path 保持完整。单条装不下时保留诊断（投影 6）。
 */
import type {
  ReferenceCoverageDto,
  ReferenceDomainCoverageDto,
  ReferenceEvidenceDto,
  ReferenceContextDto,
  ReferenceObjectIdentity,
  ReferencePageRecord,
  ReferenceRelationItem,
  ReferenceSearchPage,
  ReferenceSearchRelationDto,
  ReferenceNextActionDto,
  ReferenceSourceVersionDto,
  ReferenceStatementDto,
  ReferenceStatementKind,
  ReferenceTargetReadDto,
  SymbolBundle
} from '@soulforge/shared';
import type { ReferenceEdge } from '@soulforge/shared';
import {
  computeDependencySummary,
  type DependencySummary
} from '../runtime/resourceVersion.js';

export const REFERENCE_ENVELOPE_MAX_BYTES = 8192;
export const REFERENCE_ENVELOPE_MAX_CHARS = 8192;
export const REFERENCE_CONTENT_STATEMENT_MAX_CHARS = 512;
/** Fixed-length reservation so replacing it with a host cursor cannot evict a relation. */
export const REFERENCE_CURSOR_TOKEN_PLACEHOLDER = `rf2_${'x'.repeat(32)}_${'x'.repeat(24)}`;

/** Serialize the public content page — the single Agent envelope budget callback. */
export function serializeReferenceEnvelope(record: ReferencePageRecord): string {
  return JSON.stringify(projectReferenceSearchPage(record));
}

function withinEnvelope(record: ReferencePageRecord): boolean {
  const text = serializeReferenceEnvelope(record);
  // The bridge adds pagination and a small status envelope after projection.
  return Buffer.byteLength(text, 'utf8') <= REFERENCE_ENVELOPE_MAX_BYTES - 1536
    && text.length <= REFERENCE_ENVELOPE_MAX_CHARS - 1536;
}

/**
 * Confidence (internal graph) → certainty (external contract). High edges are
 * confirmed direct relations; medium edges are indirect (path/binding or
 * cross-scope); low edges are hypotheses. Never re-derives semantics — pure
 * vocabulary mapping so a name-inference edge can never surface as confirmed.
 */
export function certaintyForEdge(edge: ReferenceEdge, indirect: boolean): 'confirmed' | 'indirect' | 'hypothesis' {
  if (edge.confidence === 'high') return indirect ? 'indirect' : 'confirmed';
  if (edge.confidence === 'medium') return 'indirect';
  return 'hypothesis';
}

/**
 * The edge reason already names the rule for hypotheses
 * (`hypothesis(<rule>):`); surface it as ruleName, required by the DTO.
 */
export function ruleNameFromReason(reason: string): string | undefined {
  const match = /^hypothesis\(([^)]+)\)/u.exec(reason) ?? /^rule\(([^)]+)\)/u.exec(reason);
  return match ? match[1] : undefined;
}

export function statementFromEdge(edge: ReferenceEdge): ReferenceStatementDto | undefined {
  const first = edge.evidence.find((item) => item.excerpt !== undefined);
  if (!first || first.excerpt === undefined) return undefined;
  let kind: ReferenceStatementKind;
  if (edge.reason.includes('rule(event-call') || edge.reason.includes('registry-confirmed')) kind = 'native-rendered';
  else if (edge.reason.includes('受信任 metadata') || edge.reason.includes('原生字段')) kind = 'field-assignment';
  else if (edge.reason.includes('hypothesis(script-name-match)') || edge.reason.includes('规则 lua-require') || edge.reason.includes('完整目录')) kind = 'source-text';
  else kind = 'field-assignment';
  const statement: ReferenceStatementDto = { kind, text: first.excerpt };
  const location = locationFromEdge(edge);
  if (location) statement.location = location;
  return statement;
}

function cloneStatement(statement: ReferenceStatementDto, maxChars = REFERENCE_CONTENT_STATEMENT_MAX_CHARS): ReferenceStatementDto {
  const characters = Array.from(statement.text);
  if (characters.length <= maxChars) return { ...statement, ...(statement.location ? { location: { ...statement.location } } : {}) };
  const suffix = '…';
  const take = Math.max(0, maxChars - suffix.length);
  return {
    ...statement,
    text: `${characters.slice(0, take).join('')}${suffix}`,
    truncated: true,
    ...(statement.location ? { location: { ...statement.location } } : {})
  };
}

function locationFromEdge(edge: ReferenceEdge): ReferenceStatementDto['location'] | undefined {
  const first = edge.evidence.find((item) => item.excerpt !== undefined || item.fieldName !== undefined || item.instructionUri !== undefined)
    ?? edge.evidence[0];
  if (!first) return undefined;
  const location: NonNullable<ReferenceStatementDto['location']> = {};
  if (first.fieldName) location.fieldId = first.fieldName;
  const instructionMatch = /#instruction\/(\d+)/u.exec(first.instructionUri ?? first.sourceUri ?? '');
  if (instructionMatch) location.instructionIndex = Number(instructionMatch[1]);
  const lineMatch = /@L(\d+):C(\d+)/u.exec(first.excerpt ?? '');
  if (lineMatch) {
    location.line = Number(lineMatch[1]);
    location.column = Number(lineMatch[2]);
  }
  return Object.keys(location).length > 0 ? location : undefined;
}

export function evidenceDtoFromEdge(edge: ReferenceEdge, versions: Map<string, ReferenceSourceVersionDto>): ReferenceEvidenceDto[] {
  return edge.evidence.map((item) => {
    const dto: ReferenceEvidenceDto = { sourceUri: item.sourceUri };
    if (item.excerpt !== undefined) dto.excerpt = item.excerpt;
    const version = versions.get(item.sourceUri);
    if (version) dto.sourceVersion = version;
    const statement = statementFromEdge(edge);
    if (statement) dto.statement = statement;
    return dto;
  });
}

/**
 * Build a stable identity for a uri using the bundle's symbol tables. Falls
 * back to a uri-derived identity; never invents row/event ids.
 */
export function identityForUri(uri: string, bundle: SymbolBundle, workspaceId: string): ReferenceObjectIdentity {
  const sourceUri = uri.split('#')[0] ?? uri;
  for (const paramExport of bundle.params ?? []) {
    for (const row of paramExport.rows) {
      if (row.uri === uri) {
        return {
          workspaceId, domain: 'param', sourceUri: row.sourceUri,
          ...(row.entryIndex !== undefined ? { entryIndex: row.entryIndex } : {}),
          ...(row.entryName !== undefined ? { entryName: row.entryName } : {}),
          rowId: row.rowId,
          ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {}),
          label: `${paramExport.paramName}#${row.rowId}`
        };
      }
    }
  }
  for (const eventExport of bundle.events ?? []) {
    for (const event of eventExport.events) {
      if (event.uri === uri) {
        return {
          workspaceId, domain: 'emevd', sourceUri: event.sourceUri,
          eventId: event.eventId, label: `event ${event.eventId}`
        };
      }
    }
  }
  for (const mapExport of bundle.maps ?? []) {
    for (const entity of mapExport.entities) {
      if (entity.uri === uri) {
        return {
          workspaceId, domain: 'map', sourceUri: entity.sourceUri,
          ...(entity.internalEntryId !== undefined ? { nativeObjectKey: String(entity.internalEntryId) } : {}),
          label: entity.name
        };
      }
    }
  }
  for (const msgExport of bundle.msgs ?? []) {
    for (const entry of msgExport.entries) {
      if (entry.uri === uri) {
        return {
          workspaceId, domain: 'fmg', sourceUri: entry.sourceUri,
          textId: entry.textId,
          ...(entry.category ? { childChain: [entry.category] } : {}),
          ...(entry.entryIndex !== undefined ? { entryIndex: entry.entryIndex } : {}),
          label: `${entry.category ?? 'text'}/${entry.textId}`
        };
      }
    }
  }
  for (const scriptExport of bundle.scripts ?? []) {
    for (const child of scriptExport.scripts) {
      if (child.uri === uri) {
        return {
          workspaceId, domain: 'script', sourceUri: child.sourceUri,
          childChain: child.childChain,
          ...(child.entryIndex !== undefined ? { entryIndex: child.entryIndex } : {}),
          label: child.entryName ?? child.childChain.join('/')
        };
      }
    }
  }
  for (const taeExport of bundle.tae ?? []) {
    for (const animation of taeExport.animations) {
      const animationUri = `${taeExport.sourceUri}#anim/${animation.animId}@${animation.taeEntryIndex ?? 'x'}`;
      if (animationUri === uri) {
        return {
          workspaceId,
          domain: 'tae',
          sourceUri: taeExport.sourceUri,
          ...(animation.taeEntryIndex === undefined ? {} : { taeEntryIndex: animation.taeEntryIndex }),
          animId: animation.animId,
          label: animation.code
        };
      }
      for (const event of animation.events) {
        if (event.uri !== uri) continue;
        return {
          workspaceId,
          domain: 'tae',
          sourceUri: taeExport.sourceUri,
          ...(event.taeEntryIndex === undefined ? {} : { taeEntryIndex: event.taeEntryIndex }),
          animId: animation.animId,
          eventIndex: event.index,
          label: `${animation.code}.e${event.index}`
        };
      }
    }
  }
  // Container source itself (contains edges point from a container uri).
  const domain = sourceUri.includes('.msb') ? 'map'
    : sourceUri.includes('.emevd') ? 'emevd'
    : sourceUri.includes('.param') ? 'param'
    : sourceUri.includes('.fmg') || sourceUri.includes('.msgbnd') ? 'fmg'
    : sourceUri.includes('.luabnd') || sourceUri.endsWith('.lua') ? 'script'
    : sourceUri.includes('.anibnd') || sourceUri.includes('.tae') ? 'tae'
    : 'resource';
  const workspaceMatch = /^workspace:\/\/([^/]+)/u.exec(uri);
  return {
    workspaceId: workspaceMatch?.[1] ?? workspaceId,
    domain,
    sourceUri,
    label: uri
  };
}

export function sourceVersionFromSymbol(symbol: {
  sourceUri: string;
  outerFileHash?: string;
  sourceHash?: string;
  sourceRevision?: number;
}): ReferenceSourceVersionDto {
  return {
    sourceUri: symbol.sourceUri,
    ...(symbol.outerFileHash ? { outerFileHash: symbol.outerFileHash } : {}),
    ...(symbol.sourceHash ? { payloadHash: symbol.sourceHash } : {}),
    ...(symbol.sourceRevision !== undefined ? { sourceRevision: symbol.sourceRevision } : {})
  };
}

/** Collect every source's version facts from the bundle for evidence stamping. */
export function collectSourceVersions(bundle: SymbolBundle): Map<string, ReferenceSourceVersionDto> {
  const versions = new Map<string, ReferenceSourceVersionDto>();
  const add = (symbol: {
    sourceUri?: string | undefined;
    outerFileHash?: string | undefined;
    sourceHash?: string | undefined;
    sourceRevision?: number | undefined;
  } | undefined): void => {
    if (!symbol?.sourceUri) return;
    if (!versions.has(symbol.sourceUri)) {
      versions.set(symbol.sourceUri, {
        sourceUri: symbol.sourceUri,
        ...(symbol.outerFileHash ? { outerFileHash: symbol.outerFileHash } : {}),
        ...(symbol.sourceHash ? { payloadHash: symbol.sourceHash } : {}),
        ...(symbol.sourceRevision !== undefined ? { sourceRevision: symbol.sourceRevision } : {})
      });
    }
  };
  for (const item of bundle.params ?? []) { add(item); for (const row of item.rows) add(row); }
  for (const item of bundle.events ?? []) {
    add({ sourceUri: item.events[0]?.sourceUri, outerFileHash: item.outerFileHash, sourceHash: item.sourceHash, sourceRevision: item.sourceRevision });
    for (const event of item.events) add(event);
  }
  for (const item of bundle.maps ?? []) {
    add({ sourceUri: item.entities[0]?.sourceUri, outerFileHash: item.outerFileHash, sourceHash: item.sourceHash, sourceRevision: item.sourceRevision });
    for (const entity of item.entities) add(entity);
    for (const region of item.regions) add(region);
  }
  for (const item of bundle.msgs ?? []) {
    add({ sourceUri: item.entries[0]?.sourceUri, outerFileHash: item.outerFileHash, sourceHash: item.sourceHash, sourceRevision: item.sourceRevision });
    for (const entry of item.entries) add(entry);
  }
  for (const item of bundle.scripts ?? []) { add(item); for (const child of item.scripts) add(child); }
  for (const item of bundle.tae ?? []) add(item);
  return versions;
}

export interface AssembleRelationsInput {
  edges: readonly ReferenceEdge[];
  bundle: SymbolBundle;
  workspaceId: string;
  versions: Map<string, ReferenceSourceVersionDto>;
  /** uris reached through a bounded call-chain hop (T05) → indirect certainty. */
  indirectEdgeKeys?: Set<string>;
  /** Complete root-to-edge traversal paths keyed by the edge identity. */
  paths?: ReadonlyMap<string, import('@soulforge/shared').ReferencePathHop[]>;
}

export function edgeIdentityKey(
  fromUri: string,
  toUri: string,
  kind: ReferenceEdge['kind'],
  evidenceSourceUri = ''
): string {
  return `${fromUri}\u0000${toUri}\u0000${kind}\u0000${evidenceSourceUri}`;
}

export function edgeKey(edge: ReferenceEdge): string {
  return edgeIdentityKey(edge.fromUri, edge.toUri, edge.kind, edge.evidence[0]?.sourceUri ?? '');
}

/**
 * Certainty order first (confirmed < indirect < hypothesis), then relation
 * kind and full identity as stable secondary keys (步骤 6).
 */
const CERTAINTY_ORDER: Record<ReferenceRelationItem['certainty'], number> = {
  confirmed: 0, indirect: 1, hypothesis: 2
};

export function assembleRelations(input: AssembleRelationsInput): ReferenceRelationItem[] {
  const items: ReferenceRelationItem[] = [];
  let counter = 0;
  for (const edge of input.edges) {
    const indirect = input.indirectEdgeKeys?.has(edgeKey(edge)) === true;
    const certainty = certaintyForEdge(edge, indirect);
    const from = identityForUri(edge.fromUri, input.bundle, input.workspaceId);
    const to = identityForUri(edge.toUri, input.bundle, input.workspaceId);
    const ruleName = ruleNameFromReason(edge.reason);
    const path = input.paths?.get(edgeKey(edge))?.map((hop) => ({
      ...hop,
      from: { ...hop.from },
      ...(hop.to ? { to: { ...hop.to } } : {})
    })) ?? [{ from, to, relationKind: edge.kind, certainty }];
    counter += 1;
    items.push({
      relationId: `rel-${counter}`,
      from,
      to,
      relationKind: edge.kind,
      certainty,
      evidence: evidenceDtoFromEdge(edge, input.versions),
      path,
      reason: edge.reason,
      ...(ruleName ? { ruleName } : {})
    });
  }
  items.sort((a, b) =>
    CERTAINTY_ORDER[a.certainty] - CERTAINTY_ORDER[b.certainty]
    || a.relationKind.localeCompare(b.relationKind)
    || a.from.sourceUri.localeCompare(b.from.sourceUri)
    || a.to.sourceUri.localeCompare(b.to.sourceUri)
    || a.relationId.localeCompare(b.relationId));
  return items;
}

export interface CoverageInput {
  bundle: SymbolBundle;
  /** Source URIs actually visited by the providers in this query. */
  scannedDomains: readonly string[];
  truncated: boolean;
  /** Optional host-owned coverage certificate. Never infer completeness from the bundle alone. */
  coverageStates?: readonly {
    domain?: string;
    status?: string;
    coveredResources?: number;
    expectedResources?: number | null;
    coveredResourceIds?: readonly string[];
    expectedResourceIds?: readonly string[] | null;
    staleSources?: readonly string[];
    diagnostics?: readonly string[];
  }[] | undefined;
}

export function buildCoverage(input: CoverageInput): ReferenceCoverageDto {
  const domains: ReferenceDomainCoverageDto[] = [];
  const unique = (values: readonly (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
  const bundle = input.bundle;
  const sourcesFor = (domain: string): string[] => {
    if (domain === 'param') return unique((bundle.params ?? []).map((item) => item.sourceUri));
    if (domain === 'emevd') return unique((bundle.events ?? []).flatMap((item) => item.events.map((event) => event.sourceUri)));
    if (domain === 'map') return unique((bundle.maps ?? []).flatMap((item) => [
      ...item.entities.map((entity) => entity.sourceUri),
      ...item.regions.map((region) => region.sourceUri)
    ]));
    if (domain === 'fmg') return unique((bundle.msgs ?? []).flatMap((item) => item.entries.map((entry) => entry.sourceUri)));
    if (domain === 'script') return unique((bundle.scripts ?? []).map((item) => item.sourceUri));
    if (domain === 'tae') return unique((bundle.tae ?? []).map((item) => item.sourceUri));
    return [];
  };
  const scanned = new Set(input.scannedDomains);
  const coverageDomain = (domain: string): string => domain === 'emevd'
    ? 'event'
    : domain === 'fmg'
      ? 'msg'
      : domain === 'tae'
        ? 'action'
        : domain;
  const push = (domain: string): void => {
    const discovered = sourcesFor(domain);
    const hostState = input.coverageStates?.find((state) => state.domain === coverageDomain(domain));
    if (hostState) {
      const expectedIds = hostState.expectedResourceIds ?? discovered;
      const coveredIds = hostState.coveredResourceIds ?? [];
      const failed = hostState.status === 'parse_failed' || hostState.status === 'source_unavailable'
        ? expectedIds.filter((sourceUri) => !coveredIds.includes(sourceUri))
        : [];
      const unscanned = hostState.status === 'complete'
        ? []
        : expectedIds.filter((sourceUri) => !coveredIds.includes(sourceUri) && !failed.includes(sourceUri));
      const status: ReferenceDomainCoverageDto['status'] = hostState.status === 'complete'
        ? (input.truncated ? 'partial' : 'complete')
        : hostState.status === 'stale'
          ? 'partial'
          : hostState.status === 'not_indexed' || hostState.status === 'source_unavailable'
            ? 'not_indexed'
            : hostState.status === 'parse_failed'
              ? 'partial'
              : hostState.status === 'partial'
                ? 'partial'
                : 'unknown';
      domains.push({
        domain,
        status,
        discoveredSources: hostState.expectedResources ?? expectedIds.length,
        readSuccessSources: hostState.coveredResources ?? coveredIds.length,
        parsedSuccessSources: hostState.coveredResources ?? coveredIds.length,
        unscannedSources: unscanned,
        failedSources: [...new Set([...failed, ...(hostState.staleSources ?? [])])]
      });
      return;
    }
    const scannedSources = discovered.filter((sourceUri) => scanned.has(sourceUri));
    const unscannedSources = discovered.filter((sourceUri) => !scanned.has(sourceUri));
    const status: ReferenceDomainCoverageDto['status'] = discovered.length === 0
      ? 'not_indexed'
      : scannedSources.length === 0
        ? 'unscanned'
        : scannedSources.length < discovered.length || input.truncated
          ? 'partial'
          : 'complete';
    domains.push({
      domain,
      status,
      discoveredSources: discovered.length,
      readSuccessSources: scannedSources.length,
      parsedSuccessSources: scannedSources.length,
      unscannedSources,
      failedSources: []
    });
  };
  push('param');
  push('emevd');
  push('map');
  push('fmg');
  push('script');
  push('tae');
  const overall = domains.every((item) => item.status === 'complete') && !input.truncated
    ? 'complete' : 'partial';
  return {
    scope: 'workspace-bundle',
    status: overall,
    domains,
    predicateComplete: overall === 'complete',
    negativeConclusionAllowed: overall === 'complete'
  };
}

export function buildDependencySummary(bundle: SymbolBundle, catalogGeneration = 1): DependencySummary {
  const entries: DependencySummary['entries'] = [];
  const add = (sourceKey: string, outerFileHash?: string, payloadHash?: string, sourceRevision?: number): void => {
    if (!outerFileHash && !payloadHash && sourceRevision === undefined) return;
    entries.push({
      sourceKey,
      ...(outerFileHash ? { outerFileHash } : {}),
      ...(payloadHash ? { payloadHash } : {}),
      ...(sourceRevision !== undefined ? { sourceRevision } : {})
    });
  };
  for (const item of bundle.params ?? []) add(item.sourceUri ?? item.paramName, item.outerFileHash, item.sourceHash, item.sourceRevision);
  for (const item of bundle.events ?? []) add(item.events[0]?.sourceUri ?? 'event', item.outerFileHash, item.sourceHash, item.sourceRevision);
  for (const item of bundle.maps ?? []) add(item.mapId, item.outerFileHash, item.sourceHash, item.sourceRevision);
  for (const item of bundle.msgs ?? []) add(item.sourceHash ?? 'msg', item.outerFileHash, item.sourceHash, item.sourceRevision);
  for (const item of bundle.scripts ?? []) add(item.sourceUri, item.outerFileHash, item.sourceHash, item.sourceRevision);
  for (const item of bundle.tae ?? []) add(item.sourceUri, item.outerFileHash, item.sourceHash, item.sourceRevision);
  return computeDependencySummary(entries, { catalogGeneration });
}

export interface BuildPageInput {
  record: Omit<ReferencePageRecord, 'page'>;
  limit: number;
  offset: number;
  /** Build context from the relations actually retained on this page. */
  contextForPage?: (relations: ReferenceRelationItem[]) => ReferenceContextDto | undefined;
  /** Reserve the final opaque cursor's byte length while budgeting this page. */
  nextCursorPlaceholder?: string;
  truncationReason?: string;
}

export interface BuiltPage {
  record: ReferencePageRecord;
  droppedRelationIds: string[];
  tooLargeRelationId?: string;
}

/**
 * Paginate + envelope-budget the page. Shrinks by removing WHOLE relation
 * items (never truncating a statement/hash). Removed items continue on the
 * next page via nextCursor. A single item that cannot fit even alone yields
 * REFERENCE_PAGE_ITEM_TOO_LARGE instead of a fake ok=true empty record.
 */
export function buildBoundedPage(input: BuildPageInput): BuiltPage {
  const { limit, offset } = input;
  const allRelations = input.record.relations;
  const pageRelations = allRelations.slice(offset, offset + limit);
  const droppedRelationIds: string[] = [];

  const assemble = (relations: typeof pageRelations, hasMore: boolean): ReferencePageRecord => ({
    ...input.record,
    ...(input.contextForPage
      ? (() => {
          const context = input.contextForPage(relations);
          return context ? { context } : {};
        })()
      : {}),
    relations,
    page: {
      returnedCount: relations.length,
      hasMore,
      ...(hasMore ? { nextCursor: input.nextCursorPlaceholder ?? encodeCursor(offset + relations.length) } : {}),
      ...(input.truncationReason ? { truncationReason: input.truncationReason } : {})
    }
  });

  let relations = pageRelations;
  let hasMore = offset + pageRelations.length < allRelations.length;
  let record = assemble(relations, hasMore);
  while (!withinEnvelope(record) && relations.length > 0) {
    const removed = relations[relations.length - 1]!;
    droppedRelationIds.unshift(removed.relationId);
    relations = relations.slice(0, -1);
    hasMore = true;
    record = assemble(relations, hasMore);
  }
  if (relations.length === 0 && pageRelations.length > 0) {
    // Even the first item alone exceeds the envelope.
    const oversized = pageRelations[0]!;
    return {
      record: {
        ...input.record,
        relations: [],
        diagnostics: [...input.record.diagnostics, {
          severity: 'error',
          code: 'REFERENCE_PAGE_ITEM_TOO_LARGE',
          message: `单条关系 ${oversized.relationId} 序列化后仍超过 ${REFERENCE_ENVELOPE_MAX_BYTES} 字节 envelope；用更小的 limit 或缩小读取窗口重试，未丢失该关系。`,
          ...(oversized.from.sourceUri ? { sourceUri: oversized.from.sourceUri } : {})
        }],
        nextActions: [
          ...input.record.nextActions,
          { tool: 'find_references', args: { limit: 1 }, reason: '缩小单页关系数后重试；被移出的关系不丢失' }
        ],
        page: { returnedCount: 0, hasMore: true, nextCursor: encodeCursor(offset) }
      },
      droppedRelationIds,
      tooLargeRelationId: oversized.relationId
    };
  }
  return { record, droppedRelationIds };
}

function eventIdentity(relation: ReferenceRelationItem): ReferenceObjectIdentity | undefined {
  if (relation.from.domain === 'emevd' && relation.from.eventId !== undefined) return relation.from;
  if (relation.to.domain === 'emevd' && relation.to.eventId !== undefined) return relation.to;
  return undefined;
}

function scriptIdentity(relation: ReferenceRelationItem): ReferenceObjectIdentity | undefined {
  if (relation.from.domain === 'script' && relation.from.childChain?.length) return relation.from;
  if (relation.to.domain === 'script' && relation.to.childChain?.length) return relation.to;
  return undefined;
}

function readActionForRelation(relation: ReferenceRelationItem): ReferenceNextActionDto | undefined {
  const statement = relation.evidence.find((item) => item.statement)?.statement;
  const location = statement?.location;
  const event = eventIdentity(relation);
  if (event) {
    return {
      tool: 'read_emevd_event',
      args: {
        file: event.sourceUri,
        eventId: event.eventId,
        ...(location?.instructionIndex === undefined ? {} : { instructionOffset: location.instructionIndex }),
        instructionLimit: 1,
        format: 'json'
      },
      reason: '读取产生该关联的原生事件指令窗口；完整事件仍需按 native read 结果续读。'
    };
  }
  const script = scriptIdentity(relation);
  if (script) {
    const sourceOffset = location?.byteRange?.[0];
    return {
      tool: 'read_luabnd_script',
      args: {
        file: script.sourceUri,
        childPath: script.childChain!.join('/'),
        ...(sourceOffset === undefined ? {} : { sourceOffset, sourceLimit: 256 })
      },
      reason: sourceOffset === undefined
        ? '读取该脚本的正文入口；返回 source cursor 后继续读取全文，当前页未猜测调用字符偏移。'
        : '读取脚本调用所在的有界源码窗口；窗口返回 nextCursor 时继续读取全文。'
    };
  }
  const param = relation.from.domain === 'param' ? relation.from : relation.to.domain === 'param' ? relation.to : undefined;
  if (param?.rowId !== undefined && param.label) {
    const table = param.label.split('#')[0]?.trim();
    const fieldId = location?.fieldId;
    if (table && fieldId && fieldId !== 'rowId' && relation.relationKind !== 'references_text' && relation.relationKind !== 'name_match') {
      return {
        tool: 'read_param_fields',
        args: { table, rowIds: [param.rowId], fieldIds: [fieldId], containerPath: param.sourceUri },
        reason: '按具体 PARAM 行与字段读取当前原生值。'
      };
    }
  }
  const text = relation.from.domain === 'fmg' ? relation.from : relation.to.domain === 'fmg' ? relation.to : undefined;
  if (text?.textId !== undefined && text.label) {
    const table = text.childChain?.at(-1)?.split(/[\\/]/u).at(-1)?.trim()
      || text.label.split('/').at(-2)?.trim();
    if (table) {
      return {
        tool: 'read_fmg_entries',
        args: { table, ids: [text.textId], containerPath: text.sourceUri, sourceOffset: 0, sourceLimit: 256 },
        reason: '读取该文本条目的有界正文窗口；窗口返回 nextCursor 时继续读取全文。'
      };
    }
  }
  return undefined;
}

function projectedCoverage(coverage: ReferenceCoverageDto): ReferenceSearchPage['coverage'] {
  return {
    scope: coverage.scope,
    status: coverage.status,
    predicateComplete: coverage.predicateComplete,
    negativeConclusionAllowed: coverage.negativeConclusionAllowed,
    domains: coverage.domains.map((domain) => ({
      domain: domain.domain,
      status: domain.status,
      discoveredSources: domain.discoveredSources,
      readSuccessSources: domain.readSuccessSources,
      unscannedCount: domain.unscannedSources.length,
      failedCount: domain.failedSources.length
    }))
  };
}

function projectedCandidates(record: ReferencePageRecord): ReferenceSearchPage['candidates'] {
  if (!record.candidates) return undefined;
  return record.candidates.map((candidate) => ({
    identity: publicIdentity(candidate.identity),
    discriminators: Object.fromEntries(Object.entries(candidate.discriminators).filter(([key]) =>
      !/(?:hash|version|revision|generation)/iu.test(key)))
  }));
}

function publicIdentity(identity: ReferenceObjectIdentity): ReferenceObjectIdentity {
  return {
    ...identity,
    workspaceId: 'workspace://active',
    ...(identity.entryName ? { entryName: identity.entryName.split(/[\\/]/u).at(-1)! } : {})
  };
}

function projectRelation(relation: ReferenceRelationItem): ReferenceSearchRelationDto {
  const statement = relation.evidence.find((item) => item.statement)?.statement
    ?? (() => {
      const excerpt = relation.evidence.find((item) => item.excerpt !== undefined)?.excerpt;
      return excerpt === undefined ? undefined : { kind: 'source-text' as const, text: excerpt };
    })();
  const content = statement ? cloneStatement(statement) : undefined;
  const readAction = readActionForRelation(relation);
  return {
    relationId: relation.relationId,
    from: publicIdentity(relation.from),
    to: publicIdentity(relation.to),
    relationKind: relation.relationKind,
    certainty: relation.certainty,
    ...(content ? { content } : {}),
    ...(content?.location ? { location: content.location } : {}),
    ...(relation.reason ?? relation.ruleName
      ? { reason: relation.reason ?? relation.ruleName } : {}),
    path: relation.path.map((hop) => ({ ...hop, from: publicIdentity(hop.from), ...(hop.to ? { to: publicIdentity(hop.to) } : {}) })),
    ...(readAction ? { readAction } : {})
  };
}

export interface ReferenceSearchPageProjectionOptions {
  maxBytes?: number;
  maxChars?: number;
}

/**
 * Project a host-side record to the content-first page consumed by Agent and
 * renderer envelopes.  Evidence, source versions and hashes never cross this
 * boundary.  Long statements are explicitly marked and carry a read action;
 * identity fields and paths are kept intact.
 */
export function projectReferenceSearchPage(
  record: ReferencePageRecord,
  options: ReferenceSearchPageProjectionOptions = {}
): ReferenceSearchPage {
  const relations = record.relations.map(projectRelation);
  const page: ReferenceSearchPage['page'] = {
    returnedCount: relations.length,
    hasMore: record.page.hasMore,
    ...(record.page.nextCursor ? { nextCursor: record.page.nextCursor } : {}),
    ...(record.page.truncationReason ? { truncationReason: record.page.truncationReason } : {})
  };
  const candidates = projectedCandidates(record);
  const base = (): ReferenceSearchPage => ({
    resolution: record.resolution,
    ...(record.target ? { target: publicIdentity(record.target) } : {}),
    ...(candidates ? { candidates } : {}),
    relations,
    coverage: projectedCoverage(record.coverage),
    page,
    ...(record.scan ? { scan: record.scan } : {}),
    ...(record.nextActions.length > 0 ? { nextActions: record.nextActions.slice(0, 4) } : {}),
    ...(record.diagnostics && record.diagnostics.length > 0
      ? { diagnostics: record.diagnostics.slice(0, 4) } : {})
  });
  // Never remove relations here: the service has already signed the next
  // offset. Page budgeting must operate on this exact, lossless projection.
  return base();
}

const CURSOR_PREFIX = 'rf1:';

export function encodeCursor(offset: number, sourceOffset = 0): string {
  return `${CURSOR_PREFIX}${JSON.stringify({ offset, sourceOffset })}`;
}

export interface DecodedCursor {
  offset: number;
  sourceOffset?: number;
}

export function decodeCursor(cursor: string): DecodedCursor | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const parsed = JSON.parse(cursor.slice(CURSOR_PREFIX.length)) as { offset?: unknown; sourceOffset?: unknown };
    if (typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) return undefined;
    if (parsed.sourceOffset !== undefined
      && (typeof parsed.sourceOffset !== 'number' || !Number.isSafeInteger(parsed.sourceOffset) || parsed.sourceOffset < 0)) return undefined;
    return { offset: parsed.offset, ...(parsed.sourceOffset === undefined ? {} : { sourceOffset: parsed.sourceOffset }) };
  } catch {
    return undefined;
  }
}

export function emptyTargetRead(): ReferenceTargetReadDto {
  return { fields: [], completeness: 'summary_only' };
}
