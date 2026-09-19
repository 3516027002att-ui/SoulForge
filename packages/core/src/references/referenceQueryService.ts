/**
 * ReferenceQueryService（T08，执行指令 §T08）。
 *
 * 固定执行顺序：
 * 1. 解码输入（共享 strict decoder）；游标续页先做宿主登记校验。
 * 2. 精确 target 走 bundle 内的精确身份解析；uri 逻辑寻址不能唯一解析时返回
 *    候选；query 委托现有 resolveEntity（宿主注入），不另起第二套名称搜索。
 * 3. 歧义在本步结束：只返回候选 + 覆盖 + 选定后的调用入口，不深读候选。
 * 4. 根目标锁定当前版本；fieldIds 读取原生值形成 targetRead 快照。
 * 5. 通过 provider registry 取 source-scoped 分片（同 source/version 合并）。
 * 6. 按 direction/depth/node/edge/source 上限做真正多跳遍历；contains/member_of
 *    仅作为根的终止关系，避免容器边把无关子图全部展开；保留完整 path。
 * 7. 语句/位置来自 provider 证据；解析失败保留诊断。
 * 8. coverage + 依赖摘要 + envelope 预算分页；targetRead 建立字段观察登记。
 */
import { createHash } from 'node:crypto';
import type {
  NormalizedReferenceQuery,
  ReferenceObjectIdentity,
  ReferencePageRecord,
  ReferenceContextDto,
  ReferenceDetail,
  ReferenceQueryInput,
  ReferenceRelationItem,
  ReferencePathHop,
  ReferenceTargetReadDto,
  SymbolBundle
} from '@soulforge/shared';
import {
  decodeReferenceQueryInput,
  REFERENCE_DEPTH_DEFAULT,
  REFERENCE_LIMIT_DEFAULT
} from '@soulforge/shared';
import {
  buildBoundedPage,
  buildCoverage,
  buildDependencySummary,
  collectSourceVersions,
  assembleRelations,
  certaintyForEdge,
  edgeIdentityKey,
  identityForUri,
  REFERENCE_CURSOR_TOKEN_PLACEHOLDER,
  type BuiltPage
} from './referencePageProjection.js';
import type { ReferenceEdge } from '@soulforge/shared';
import { REFERENCE_PROVIDERS, type ProviderBuildOptions } from './referenceProviderRegistry.js';
import { buildEventCallChain } from './eventReferenceProvider.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { dependencySummariesMatch } from '../runtime/resourceVersion.js';
import {
  defaultReferenceCursorStore,
  type ReferenceCursorScope,
  type ReferenceCursorStore,
  type StoredReferenceCursor
} from './referenceCursorStore.js';

export interface ReferenceQueryServiceOptions {
  /** Snapshot bundle of current symbols (workspace index or fixture). */
  bundle: SymbolBundle;
  workspaceId?: string;
  registry?: EmedfRegistry;
  /**
   * Host-provided entity resolver (production: resolveEntity over the real
   * index). The service never runs its own name search (步骤 2). When absent,
   * query resolution falls back to the same exact-identity collector used for
   * `target`, applied over the bundle's indexed symbols — never a deep read.
   */
  resolveQuery?: (query: string, domain?: string) => Promise<{
    resolution: 'resolved' | 'ambiguous' | 'not_found' | 'insufficient_evidence';
    uri?: string;
    candidates?: Array<{
      uri: string;
      label: string;
      discriminators: Record<string, unknown>;
      identity?: ReferenceObjectIdentity;
    }>;
  }>;
  /** Scan caps for cold-shard completion (步骤：并发 ≤2、来源 ≤64). */
  maxSources?: number;
  /** Hard graph traversal caps; they bound multi-hop work independently of page size. */
  maxTraversalNodes?: number;
  maxTraversalEdges?: number;
  /** Host-owned cursor state. Default is a bounded store shared by service instances. */
  cursorStore?: ReferenceCursorStore;
  /** Optional enrichment scan state to include while budgeting the public page. */
  scan?: ReferencePageRecord['scan'];
  /** Enrichment diagnostics are folded into the page before cursor budgeting. */
  sourceDiagnostics?: ReferencePageRecord['diagnostics'];
  buildOptions?: ProviderBuildOptions;
  /** Host-owned coverage certificate; bundle symbols alone never prove completeness. */
  coverageStates?: readonly {
    domain?: string;
    status?: string;
    coveredResources?: number;
    expectedResources?: number | null;
    coveredResourceIds?: readonly string[];
    expectedResourceIds?: readonly string[] | null;
    staleSources?: readonly string[];
    diagnostics?: readonly string[];
  }[];
  /** Active provider/schema contract digest used for shard invalidation. */
  providerRegistryDigest?: string;
}

export interface ReferenceQueryService {
  query(input: ReferenceQueryInput): Promise<ReferencePageRecord>;
  /** Field observations actually delivered to the caller (T09 proof input). */
  deliveredFieldProofs(): Array<{ sourceUri: string; rowId: number; rowIndex?: number; fieldId: string; dataHash?: string }>;
}

export function createReferenceQueryService(options: ReferenceQueryServiceOptions): ReferenceQueryService {
  const workspaceId = options.workspaceId ?? 'workspace';
  const maxSources = options.maxSources ?? 64;
  const maxTraversalNodes = options.maxTraversalNodes ?? 256;
  const maxTraversalEdges = options.maxTraversalEdges ?? 512;
  const cursorStore = options.cursorStore ?? defaultReferenceCursorStore;
  const fieldProofs: Array<{ sourceUri: string; rowId: number; rowIndex?: number; fieldId: string; dataHash?: string }> = [];
  let shardCache: { key: string; edges: import('@soulforge/shared').ReferenceEdge[]; diagnostics: import('@soulforge/shared').Diagnostic[] } | undefined;

  function collectShards(includeHypotheses = false): { edges: import('@soulforge/shared').ReferenceEdge[]; diagnostics: import('@soulforge/shared').Diagnostic[] } {
    const bundle = options.bundle;
    const versions = `${bundleVersionKey(bundle)}|providers:${options.providerRegistryDigest ?? 'default'}|hypotheses:${includeHypotheses ? 'on' : 'off'}`;
    if (shardCache && shardCache.key === versions) return shardCache;
    const edges: import('@soulforge/shared').ReferenceEdge[] = [];
    const diagnostics: import('@soulforge/shared').Diagnostic[] = [];
    const buildOptions: ProviderBuildOptions = {
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.buildOptions ?? {}),
      includeHypotheses
    };
    for (const provider of REFERENCE_PROVIDERS) {
      const shard = provider.build(bundle, buildOptions);
      for (const edge of shard.edges) edges.push(edge);
      for (const diagnostic of shard.diagnostics) diagnostics.push(diagnostic);
    }
    shardCache = { key: versions, edges, diagnostics };
    return shardCache;
  }

  function bundleVersionKey(bundle: SymbolBundle): string {
    // Do not build one giant JSON/string key.  Real EMEVD and PARAM exports
    // contain millions of characters and the old `parts.join()` path could
    // throw V8 `Invalid string length` before the bounded page projection ran.
    // Hash a deterministic structural stream instead.  This keeps row/field
    // and instruction content in the invalidation identity without retaining
    // the whole bundle in another string.
    const hash = createHash('sha256');
    const write = (value: unknown, seen: Set<object> = new Set()): void => {
      if (value === null) {
        hash.update('null;');
        return;
      }
      switch (typeof value) {
        case 'undefined':
          hash.update('undefined;');
          return;
        case 'string':
          hash.update(`string:${value.length}:`);
          hash.update(value);
          hash.update(';');
          return;
        case 'number':
          hash.update(`number:${Number.isNaN(value) ? 'NaN' : String(value)};`);
          return;
        case 'boolean':
          hash.update(value ? 'true;' : 'false;');
          return;
        case 'bigint':
          hash.update(`bigint:${value.toString()};`);
          return;
        case 'function':
          hash.update('function;');
          return;
      }
      if (seen.has(value)) {
        hash.update('cycle;');
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        hash.update(`array:${value.length}[`);
        for (const item of value) write(item, seen);
        hash.update('];');
      } else {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        hash.update(`object:${keys.length}{`);
        for (const key of keys) {
          hash.update(`key:${key.length}:`);
          hash.update(key);
          hash.update('=');
          write(record[key], seen);
        }
        hash.update('};');
      }
      seen.delete(value);
    };
    write(bundle);
    return `sha256:${hash.digest('hex')}`;
  }

  function cursorScopeFor(input: NormalizedReferenceQuery): ReferenceCursorScope {
    return {
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      direction: input.direction,
      detail: input.detail,
      ...(input.fieldIds !== undefined ? { fieldIds: [...input.fieldIds] } : {}),
      depth: input.depth,
      limit: input.limit,
      includeHypotheses: input.includeHypotheses
    };
  }

  function explicitCursorScopeMatches(raw: ReferenceQueryInput, decoded: NormalizedReferenceQuery, stored: ReferenceCursorScope): boolean {
    const rawRecord = raw as unknown as Record<string, unknown>;
    const fields: Array<keyof ReferenceCursorScope> = [
      'uri', 'target', 'query', 'domain', 'direction', 'detail', 'fieldIds', 'depth', 'limit', 'includeHypotheses'
    ];
    for (const field of fields) {
      if (!(field in rawRecord)) continue;
      const current = (cursorScopeFor(decoded) as Record<string, unknown>)[field];
      const expected = (stored as Record<string, unknown>)[field];
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    }
    return true;
  }

  interface ResolvedCandidate {
    uri: string;
    label: string;
    discriminators: Record<string, unknown>;
    identity: ReferenceObjectIdentity;
  }

  function identityOf(candidate: { sourceUri: string }, domain: string, extra: Omit<ReferenceObjectIdentity, 'workspaceId' | 'domain' | 'sourceUri'>): ReferenceObjectIdentity {
    return { workspaceId, domain, sourceUri: candidate.sourceUri, ...extra };
  }

  function resolveExactTarget(target: Exclude<ReferenceQueryInput['target'], undefined>): { uri?: string; candidates: ResolvedCandidate[] } {
    const bundle = options.bundle;
    const candidates: ResolvedCandidate[] = [];
    if (!('domain' in target)) return { candidates };
    if (target.domain === 'param') {
      for (const paramExport of bundle.params ?? []) {
        if (paramExport.sourceUri !== target.sourceUri) continue;
        if (paramExport.entryIndex !== target.entryIndex) continue;
        if (target.entryName !== undefined && paramExport.entryName !== target.entryName) continue;
        for (const row of paramExport.rows) {
          if (row.rowId !== target.rowId) continue;
          if (target.rowIndex !== undefined && row.rowIndex !== target.rowIndex) continue;
          candidates.push({
            uri: row.uri,
            label: `${paramExport.paramName}#${row.rowId}`,
            discriminators: {
              entryIndex: paramExport.entryIndex,
              ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {}),
              ...(row.dataHash ? { dataHash: row.dataHash } : {})
            },
            identity: identityOf(row, 'param', {
              ...(paramExport.entryIndex !== undefined ? { entryIndex: paramExport.entryIndex } : {}),
              rowId: row.rowId,
              ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {})
            })
          });
        }
      }
    } else if (target.domain === 'emevd') {
      for (const eventExport of bundle.events ?? []) {
        for (const event of eventExport.events) {
          if (event.sourceUri !== target.sourceUri || event.eventId !== target.eventId) continue;
          candidates.push({
            uri: event.uri, label: `event ${event.eventId}`,
            discriminators: { eventId: event.eventId },
            identity: identityOf(event, 'emevd', { eventId: event.eventId })
          });
        }
      }
    } else if (target.domain === 'script') {
      const wanted = target.childChain.join('/');
      for (const scriptExport of bundle.scripts ?? []) {
        if (scriptExport.sourceUri !== target.sourceUri) continue;
        for (const child of scriptExport.scripts) {
          if (child.childChain.join('/') !== wanted) continue;
          if (target.scriptEntryIndex !== undefined && child.entryIndex !== target.scriptEntryIndex) continue;
          candidates.push({
            uri: child.uri, label: child.entryName ?? wanted,
            discriminators: { childChain: child.childChain },
            identity: identityForUri(child.uri, bundle, workspaceId)
          });
        }
      }
    } else if (target.domain === 'fmg') {
      for (const msgExport of bundle.msgs ?? []) {
        for (const entry of msgExport.entries) {
          if (entry.sourceUri !== target.sourceUri || entry.textId !== target.textId) continue;
          if (entry.category !== target.category) continue;
          if (target.childChain.length > 0 && entry.category !== target.childChain.at(-1)) continue;
          if (target.language !== undefined && (entry as typeof entry & { language?: string }).language !== target.language) continue;
          if (target.entryIndex !== undefined && (entry as typeof entry & { entryIndex?: number }).entryIndex !== target.entryIndex) continue;
          candidates.push({
            uri: entry.uri, label: `${entry.category ?? ''}/${entry.textId}`,
            discriminators: { textId: entry.textId },
            identity: identityForUri(entry.uri, bundle, workspaceId)
          });
        }
      }
    } else if (target.domain === 'map') {
      for (const mapExport of bundle.maps ?? []) {
        for (const entity of mapExport.entities) {
          if (entity.sourceUri !== target.sourceUri) continue;
          if (entity.internalEntryId === undefined || String(entity.internalEntryId) !== target.nativeObjectKey) continue;
          candidates.push({
            uri: entity.uri, label: entity.name,
            discriminators: { nativeObjectKey: target.nativeObjectKey },
            identity: identityForUri(entity.uri, bundle, workspaceId)
          });
        }
      }
    } else if (target.domain === 'tae') {
      for (const tae of bundle.tae ?? []) {
        if (tae.sourceUri !== target.sourceUri) continue;
        for (const animation of tae.animations) {
          if (animation.animId !== target.animId) continue;
          if (animation.taeEntryIndex !== target.taeEntryIndex) continue;
          if (target.childChain.length > 0) {
            const child = animation.taeEntryName ?? animation.taeGroup;
            if (child === undefined || child !== target.childChain.at(-1)) continue;
          }
          if (target.eventIndex !== undefined) {
            const hasEvent = animation.events?.some((event) => event.index === target.eventIndex);
            if (!hasEvent) continue;
          }
          candidates.push({
            uri: target.eventIndex === undefined
              ? `${tae.sourceUri}#anim/${animation.animId}@${animation.taeEntryIndex}`
              : animation.events?.find((event) => event.index === target.eventIndex)?.uri
                ?? `${tae.sourceUri}#anim/${animation.animId}@${animation.taeEntryIndex}/e${target.eventIndex}`,
            label: animation.code,
            discriminators: { taeEntryIndex: animation.taeEntryIndex },
            identity: {
              workspaceId, domain: 'tae', sourceUri: tae.sourceUri,
              animId: animation.animId,
              ...(animation.taeEntryIndex === undefined ? {} : { taeEntryIndex: animation.taeEntryIndex }),
              ...(target.eventIndex === undefined ? {} : { eventIndex: target.eventIndex })
            }
          });
        }
      }
    }
    // objectHandle: host-issued lookup only; cannot resolve without a handle map.
    return candidates.length === 1 ? { uri: candidates[0]!.uri, candidates } : { candidates };
  }

  function resolveUri(uri: string): { uri?: string; candidates: ResolvedCandidate[] } {
    const bundle = options.bundle;
    const candidates: ResolvedCandidate[] = [];
    const identity = () => identityForUri(uri, bundle, workspaceId);
    for (const paramExport of bundle.params ?? []) {
      for (const row of paramExport.rows) if (row.uri === uri) candidates.push({ uri: row.uri, label: `${paramExport.paramName}#${row.rowId}`, discriminators: { rowId: row.rowId }, identity: identity() });
    }
    for (const eventExport of bundle.events ?? []) {
      for (const event of eventExport.events) if (event.uri === uri) candidates.push({ uri: event.uri, label: `event ${event.eventId}`, discriminators: { eventId: event.eventId }, identity: identity() });
    }
    for (const mapExport of bundle.maps ?? []) {
      for (const entity of mapExport.entities) if (entity.uri === uri) candidates.push({ uri: entity.uri, label: entity.name, discriminators: {}, identity: identity() });
      for (const region of mapExport.regions) if (region.uri === uri) candidates.push({ uri: region.uri, label: region.name, discriminators: {}, identity: identity() });
    }
    for (const msgExport of bundle.msgs ?? []) {
      for (const entry of msgExport.entries) if (entry.uri === uri) candidates.push({ uri: entry.uri, label: `${entry.category ?? ''}/${entry.textId}`, discriminators: { textId: entry.textId }, identity: identity() });
    }
    for (const scriptExport of bundle.scripts ?? []) {
      for (const child of scriptExport.scripts) if (child.uri === uri) candidates.push({ uri: child.uri, label: child.entryName ?? '', discriminators: {}, identity: identity() });
    }
    // A host may resolve a table/file/container before asking for content
    // references. Preserve a source-only root instead of treating the file as
    // absent merely because it has no child symbol in this snapshot.
    if (candidates.length === 0) {
      const sourceUris = new Set<string>();
      for (const item of bundle.params ?? []) if (item.sourceUri) sourceUris.add(item.sourceUri);
      for (const item of bundle.events ?? []) for (const event of item.events) sourceUris.add(event.sourceUri);
      for (const item of bundle.maps ?? []) {
        for (const entity of item.entities) sourceUris.add(entity.sourceUri);
        for (const region of item.regions) sourceUris.add(region.sourceUri);
      }
      for (const item of bundle.msgs ?? []) for (const entry of item.entries) sourceUris.add(entry.sourceUri);
      for (const item of bundle.scripts ?? []) sourceUris.add(item.sourceUri);
      for (const item of bundle.tae ?? []) sourceUris.add(item.sourceUri);
      if (sourceUris.has(uri)) {
        candidates.push({ uri, label: uri, discriminators: { sourceUri: uri }, identity: identity() });
      }
    }
    return candidates.length === 1 ? { uri: candidates[0]!.uri, candidates } : { candidates };
  }

  /**
   * Bundle-scoped query fallback (no host resolver): parses the table name and
   * row id out of the query text and applies the SAME exact-identity
   * collection as `target`. Multiple physical matches → ambiguous with full
   * discriminators; never a deep read of candidates (步骤 3).
   */
  function resolveQueryInBundle(query: string, domain?: string): {
    resolution: 'resolved' | 'ambiguous' | 'not_found' | 'insufficient_evidence';
    uri?: string;
    candidates?: ResolvedCandidate[];
  } {
    const bundle = options.bundle;
    const match = /^([A-Za-z0-9_.]+)\s+(\d+)$/u.exec(query.trim());
    if (domain === 'param' && match) {
      const table = match[1]!.replace(/\.param$/iu, '').toLowerCase();
      const rowId = Number(match[2]);
      const candidates: ResolvedCandidate[] = [];
      for (const paramExport of bundle.params ?? []) {
        const entryTable = (paramExport.entryName ?? paramExport.paramName).replace(/\.param$/iu, '').toLowerCase();
        if (entryTable !== table && paramExport.paramName.toLowerCase() !== table) continue;
        for (const row of paramExport.rows) {
          if (row.rowId !== rowId) continue;
          candidates.push({
            uri: row.uri,
            label: `${paramExport.paramName}#${row.rowId}`,
            discriminators: {
              entryIndex: paramExport.entryIndex,
              ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {}),
              ...(row.dataHash ? { dataHash: row.dataHash } : {})
            },
            identity: identityOf(row, 'param', {
              ...(paramExport.entryIndex !== undefined ? { entryIndex: paramExport.entryIndex } : {}),
              rowId: row.rowId,
              ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {})
            })
          });
        }
      }
      if (candidates.length === 1) return { resolution: 'resolved', uri: candidates[0]!.uri, candidates };
      if (candidates.length > 1) return { resolution: 'ambiguous', candidates };
      return { resolution: 'not_found' };
    }
    return { resolution: 'insufficient_evidence' };
  }

  function targetReadFor(uri: string | undefined, fieldIds: string[] | undefined): ReferenceTargetReadDto {
    if (!uri || !fieldIds) return { fields: [], completeness: 'summary_only' };
    const bundle = options.bundle;
    const fields: ReferenceTargetReadDto['fields'] = [];
    for (const paramExport of bundle.params ?? []) {
      for (const row of paramExport.rows) {
        if (row.uri !== uri) continue;
        for (const fieldId of fieldIds) {
          const field = (row.fields ?? []).find((item) => (item.fieldId ?? item.name) === fieldId);
          if (field) {
            fields.push({
              fieldId,
              value: field.value,
              rowId: row.rowId,
              ...(row.rowIndex !== undefined ? { rowIndex: row.rowIndex } : {}),
              ...(row.dataHash ? { dataHash: row.dataHash } : {})
            });
          }
        }
        const found = new Set(fields.map((field) => field.fieldId));
        return {
          fields,
          // This is an indexed candidate, never a native proof. Even when all
          // requested fields are present, a writer must perform read_param_fields.
          completeness: found.size === fieldIds.length ? 'summary_only' : 'partial',
          ...(fieldIds.filter((fieldId) => !found.has(fieldId)).length > 0
            ? { missingFieldIds: fieldIds.filter((fieldId) => !found.has(fieldId)) }
            : {})
        };
      }
    }
    return { fields: [], completeness: 'summary_only' };
  }

  function indirectEdgeKeys(rootUri: string, depth: number): Set<string> {
    const keys = new Set<string>();
    if (!options.registry && !rootUri.includes('#event/')) return keys;
    const chain = buildEventCallChain(options.bundle.events ?? [], rootUri, {
      maxDepth: Math.min(depth, 4),
      ...(options.registry ? { registry: options.registry } : {})
    });
    for (const path of chain.paths) {
      for (const hop of path) {
        if (hop.indirect) {
          keys.add(edgeIdentityKey(hop.fromEventUri, hop.toEventUri, 'calls_event', hop.instructionUri));
        }
      }
    }
    return keys;
  }

  function contextFor(
    rootUri: string,
    relations: import('@soulforge/shared').ReferenceRelationItem[],
    targetRead: ReferenceTargetReadDto
  ): ReferenceContextDto {
    const statements: ReferenceContextDto['statements'] = [];
    const evidence: ReferenceContextDto['evidence'] = [];
    const seenStatements = new Set<string>();
    const seenEvidence = new Set<string>();
    for (const relation of relations) {
      for (const item of relation.evidence) {
        const evidenceKey = JSON.stringify(item);
        if (!seenEvidence.has(evidenceKey) && evidence.length < 32) {
          seenEvidence.add(evidenceKey);
          evidence.push(item);
        }
        const statement = item.statement;
        if (statement) {
          const statementKey = `${statement.kind}\u0000${statement.text}`;
          if (!seenStatements.has(statementKey) && statements.length < 32) {
            seenStatements.add(statementKey);
            statements.push(statement);
          }
        }
      }
    }
    for (const field of targetRead.fields) {
      const statement = {
        kind: 'field-assignment' as const,
        text: `${field.fieldId} = ${JSON.stringify(field.value)}`,
        location: { fieldId: field.fieldId }
      };
      if (statements.length < 32) statements.push(statement);
    }
    return {
      target: identityForUri(rootUri, options.bundle, workspaceId),
      statements,
      evidence
    };
  }

  interface TraversalResult {
    edges: ReferenceEdge[];
    paths: Map<string, ReferencePathHop[]>;
    indirectEdgeKeys: Set<string>;
    scannedSources: Set<string>;
    truncated: boolean;
    truncationReason?: string;
  }

  const CONTAINER_BOUNDARY_KINDS = new Set<ReferenceEdge['kind']>(['contains', 'member_of']);

  function sourceOf(uri: string): string {
    return uri.split('#')[0] ?? uri;
  }

  function edgeStableSort(a: ReferenceEdge, b: ReferenceEdge): number {
    return a.fromUri.localeCompare(b.fromUri)
      || a.toUri.localeCompare(b.toUri)
      || a.kind.localeCompare(b.kind)
      || a.reason.localeCompare(b.reason)
      || (a.evidence[0]?.sourceUri ?? '').localeCompare(b.evidence[0]?.sourceUri ?? '');
  }

  /**
   * Traverse only the requested direction and depth. Container membership is
   * a terminal fact: a root may show its own contains/member_of relation, but
   * the traversal never walks through the container to enumerate unrelated
   * siblings. Node, edge and source caps remain independent of page size.
   */
  function traverseBounded(
    rootUri: string,
    edges: readonly ReferenceEdge[],
    direction: NormalizedReferenceQuery['direction'],
    depth: number
  ): TraversalResult {
    const outgoing = new Map<string, ReferenceEdge[]>();
    const incoming = new Map<string, ReferenceEdge[]>();
    for (const edge of edges) {
      const from = outgoing.get(edge.fromUri) ?? [];
      from.push(edge);
      outgoing.set(edge.fromUri, from);
      const to = incoming.get(edge.toUri) ?? [];
      to.push(edge);
      incoming.set(edge.toUri, to);
    }
    for (const list of outgoing.values()) list.sort(edgeStableSort);
    for (const list of incoming.values()) list.sort(edgeStableSort);

    const queue: Array<{ uri: string; depth: number; path: ReferencePathHop[] }> = [{ uri: rootUri, depth: 0, path: [] }];
    const visited = new Set<string>([rootUri]);
    const selected = new Map<string, ReferenceEdge>();
    const paths = new Map<string, ReferencePathHop[]>();
    const indirectEdgeKeys = new Set<string>();
    const scannedSources = new Set<string>([sourceOf(rootUri)]);
    let truncated = false;
    let truncationReason: string | undefined;
    let expansionEdges = 0;

    const candidatesFor = (uri: string): ReferenceEdge[] => {
      if (direction === 'from') return outgoing.get(uri) ?? [];
      if (direction === 'to') return incoming.get(uri) ?? [];
      const combined = new Map<string, ReferenceEdge>();
      for (const edge of [...(outgoing.get(uri) ?? []), ...(incoming.get(uri) ?? [])]) {
        const key = `${edge.fromUri}\u0000${edge.toUri}\u0000${edge.kind}\u0000${edge.evidence[0]?.sourceUri ?? ''}`;
        if (!combined.has(key)) combined.set(key, edge);
      }
      return [...combined.values()].sort(edgeStableSort);
    };
    const nextFor = (uri: string, edge: ReferenceEdge): string | undefined => {
      if (direction === 'from') return edge.fromUri === uri ? edge.toUri : undefined;
      if (direction === 'to') return edge.toUri === uri ? edge.fromUri : undefined;
      if (edge.fromUri === uri) return edge.toUri;
      if (edge.toUri === uri) return edge.fromUri;
      return undefined;
    };

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= depth) {
        const hasUnvisitedBeyondDepth = candidatesFor(current.uri).some((edge) => {
          if (CONTAINER_BOUNDARY_KINDS.has(edge.kind)) return false;
          const nextUri = nextFor(current.uri, edge);
          return nextUri !== undefined && !visited.has(nextUri);
        });
        if (hasUnvisitedBeyondDepth) {
          truncated = true;
          truncationReason = `达到查询深度上限 ${depth}；已停止继续遍历。`;
        }
        continue;
      }
      for (const edge of candidatesFor(current.uri)) {
        if (expansionEdges >= maxTraversalEdges) {
          truncated = true;
          truncationReason = `达到关联边上限 ${maxTraversalEdges}；已停止继续遍历。`;
          break;
        }
        expansionEdges += 1;
        const nextUri = nextFor(current.uri, edge);
        if (!nextUri) continue;
        const nextSource = sourceOf(nextUri);
        if (!scannedSources.has(nextSource) && scannedSources.size >= maxSources) {
          truncated = true;
          truncationReason = `达到来源上限 ${maxSources}；已停止继续遍历。`;
          continue;
        }
        if (!visited.has(nextUri) && visited.size >= maxTraversalNodes) {
          truncated = true;
          truncationReason = `达到关联节点上限 ${maxTraversalNodes}；已停止继续遍历。`;
          continue;
        }
        const key = `${edge.fromUri}\u0000${edge.toUri}\u0000${edge.kind}\u0000${edge.evidence[0]?.sourceUri ?? ''}`;
        const hopCertainty = certaintyForEdge(edge, current.path.length > 0);
        const hop: ReferencePathHop = {
          from: identityForUri(current.uri, options.bundle, workspaceId),
          to: identityForUri(nextUri, options.bundle, workspaceId),
          relationKind: edge.kind,
          certainty: hopCertainty
        };
        const path = [...current.path, hop];
        if (!selected.has(key)) {
          selected.set(key, edge);
          paths.set(key, path);
          if (path.length > 1 || hopCertainty === 'indirect') indirectEdgeKeys.add(key);
        }
        scannedSources.add(sourceOf(edge.fromUri));
        scannedSources.add(sourceOf(edge.toUri));

        // Membership edges are intentionally terminal. A container relation
        // can be displayed when directly attached to the root but never fans
        // out into all children/siblings.
        if (CONTAINER_BOUNDARY_KINDS.has(edge.kind)) continue;
        if (current.depth + 1 > depth || visited.has(nextUri)) continue;
        visited.add(nextUri);
        scannedSources.add(nextSource);
        queue.push({ uri: nextUri, depth: current.depth + 1, path });
      }
      if (truncated && expansionEdges >= maxTraversalEdges) break;
    }

    return {
      edges: [...selected.values()],
      paths,
      indirectEdgeKeys,
      scannedSources,
      truncated,
      ...(truncationReason ? { truncationReason } : {})
    };
  }

  function insufficientRecord(message: string): ReferencePageRecord {
    return {
      resolution: 'insufficient_evidence',
      relations: [],
      coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [], truncated: false, coverageStates: options.coverageStates }),
      page: { returnedCount: 0, hasMore: false },
      ...(options.scan ? { scan: options.scan } : {}),
      diagnostics: [...(options.sourceDiagnostics ?? []), { severity: 'warning', code: 'REFERENCE_INSUFFICIENT_EVIDENCE', message }],
      nextActions: []
    };
  }

  async function query(input: ReferenceQueryInput): Promise<ReferencePageRecord> {
    const decoded = decodeReferenceQueryInput(input);
    if (!decoded.ok) {
      throw Object.assign(new Error(decoded.message), { code: decoded.code, field: decoded.field });
    }
    let normalized = decoded.input;
    let offset = 0;
    let cursorRegistration: StoredReferenceCursor | undefined;
    const currentSourceVersionKey = bundleVersionKey(options.bundle);
    const currentDependencySummary = buildDependencySummary(options.bundle);
    if (normalized.cursor) {
      const registration = cursorStore.get(normalized.cursor);
      if (!registration) {
        throw Object.assign(new Error('游标未由当前宿主签发或已过期；请重新发起查询。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      if (registration.sourceScanState !== undefined) {
        throw Object.assign(new Error('该游标属于来源 enrichment 扫描，不能作为关联结果分页游标使用；请通过 sourceCursor 续扫。'), { code: 'REFERENCE_CURSOR_KIND_MISMATCH' });
      }
      if (registration.workspaceId !== workspaceId) {
        throw Object.assign(new Error('游标属于其他 workspace。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      if (!explicitCursorScopeMatches(input, normalized, registration.scope)) {
        throw Object.assign(new Error('游标查询条件与首次查询不一致；请沿用原 scope 续页。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      if (registration.sourceVersionKey !== currentSourceVersionKey
        || registration.providerRegistryDigest !== options.providerRegistryDigest
        || !dependencySummariesMatch(registration.dependencySummary, currentDependencySummary)) {
        throw Object.assign(new Error('来源版本在分页期间变化；旧游标失效，请重新查询。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      cursorRegistration = registration;
      offset = registration.relationOffset;
      // Omitted continuation fields inherit the exact original scope,
      // including direction/detail/depth/limit/includeHypotheses.
      normalized = {
        ...registration.scope,
        cursor: normalized.cursor,
        cursorScopeCheckRequired: true
      };
    }
    const limit = normalized.limit ?? REFERENCE_LIMIT_DEFAULT;
    const depth = normalized.depth ?? REFERENCE_DEPTH_DEFAULT;

    // --- Steps 2-3: resolve the root. ---
    let rootUri: string | undefined;
    const resolution: ReferencePageRecord['resolution'] = 'resolved';
    if (cursorRegistration) {
      rootUri = cursorRegistration.rootUri;
      if (!rootUri) {
        return insufficientRecord('游标登记的根目标在当前快照中不再唯一或已消失。');
      }
    } else if (normalized.target) {
      const exact = resolveExactTarget(normalized.target);
      if (exact.uri === undefined) {
        if (exact.candidates.length > 1) {
          return {
            resolution: 'ambiguous',
            candidates: exact.candidates.map((item) => ({
              identity: item.identity,
              discriminators: item.discriminators
            })),
            relations: [],
            coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [], truncated: false, coverageStates: options.coverageStates }),
            page: { returnedCount: 0, hasMore: false },
            diagnostics: [{ severity: 'info', code: 'REFERENCE_TARGET_AMBIGUOUS', message: '同名/同 id 多候选；选定精确 target 后重新查询。第一步不对候选深读。' }],
            nextActions: exact.candidates.slice(0, 8).map((item) => ({
              tool: 'find_references',
              args: { uri: item.uri, detail: 'edges' },
              reason: `对候选 ${item.label} 重新发起精确查询`
            }))
          };
        }
        return insufficientRecord('精确 target 在当前索引快照中没有唯一命中；不触发盲猜扫描。');
      }
      rootUri = exact.uri;
    } else if (normalized.uri) {
      const byUri = resolveUri(normalized.uri);
      if (byUri.uri === undefined) {
        if (byUri.candidates.length > 1) {
          return {
            resolution: 'ambiguous',
            candidates: byUri.candidates.map((item) => ({
              identity: item.identity,
              discriminators: item.discriminators
            })),
            relations: [],
            coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [], truncated: false, coverageStates: options.coverageStates }),
            page: { returnedCount: 0, hasMore: false },
            diagnostics: [{ severity: 'info', code: 'REFERENCE_TARGET_AMBIGUOUS', message: '逻辑 URI 不能唯一解析，返回候选。' }],
            nextActions: []
          };
        }
        return insufficientRecord(`URI ${normalized.uri} 不在当前索引快照中；缺少 index/原生来源时返回缺失条件。`);
      }
      rootUri = byUri.uri;
    } else if (normalized.query) {
      const resolved = options.resolveQuery
        ? await options.resolveQuery(normalized.query, normalized.domain)
        : resolveQueryInBundle(normalized.query, normalized.domain);
      if (resolved.resolution === 'ambiguous') {
        return {
          resolution: 'ambiguous',
          candidates: (resolved.candidates ?? []).map((item) => ({
            identity: item.identity ?? identityForUri(item.uri, options.bundle, workspaceId),
            discriminators: item.discriminators
          })),
          relations: [],
          coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [], truncated: false, coverageStates: options.coverageStates }),
          page: { returnedCount: 0, hasMore: false },
          diagnostics: [{ severity: 'info', code: 'REFERENCE_QUERY_AMBIGUOUS', message: 'query 命中多个候选；第一步不深读，选定后重新查询。' }],
          nextActions: (resolved.candidates ?? []).slice(0, 8).map((item) => ({
            tool: 'find_references', args: { uri: item.uri, detail: 'edges' }, reason: `对候选 ${item.label} 精确查询`
          }))
        };
      }
      if (resolved.resolution !== 'resolved' || !resolved.uri) {
        return insufficientRecord(`query「${normalized.query}」没有可验证的当前原生来源（${resolved.resolution}）。`);
      }
      rootUri = resolved.uri;
    } else {
      return insufficientRecord('缺少可解析的根目标。');
    }

    // --- Step 4: lock root version; read requested fields. ---
    const targetRead = targetReadFor(rootUri, normalized.fieldIds);

    // --- Step 5-6: source shards + bounded multi-hop traversal. ---
    const includeHypotheses = normalized.includeHypotheses === true;
    const shards = collectShards(includeHypotheses);
    const direction = normalized.direction ?? 'both';
    const traversableEdges = shards.edges.filter((edge) =>
      includeHypotheses || !(edge.confidence === 'low' && edge.reason.includes('hypothesis(')));
    const traversal = traverseBounded(rootUri, traversableEdges, direction, depth);
    const connected = traversal.edges;
    const scanned = traversal.scannedSources;
    const indirectKeys = new Set(traversal.indirectEdgeKeys);
    if (rootUri.includes('#event/')) {
      for (const key of indirectEdgeKeys(rootUri, depth)) indirectKeys.add(key);
    }
    const versions = collectSourceVersions(options.bundle);
    const relations = assembleRelations({
      edges: connected,
      bundle: options.bundle,
      workspaceId,
      versions,
      indirectEdgeKeys: indirectKeys,
      paths: traversal.paths
    });

    // --- Step 7-8: coverage + page projection. Context is built only from
    // the relations retained on this page, never from the full result set. ---
    const dependencySummary = currentDependencySummary;
    const truncated = traversal.truncated;
    const reserveContinuation = relations.length > offset + 1;
    const continuationReservation = reserveContinuation
      ? [{ tool: 'find_references', args: { cursor: REFERENCE_CURSOR_TOKEN_PLACEHOLDER }, reason: '使用该游标继续读取当前已锁定关联结果页。' }]
      : [];
    const baseRecord: Omit<ReferencePageRecord, 'page'> = {
      resolution,
      ...(rootUri ? {
        target: {
          workspaceId,
          domain: domainOfUri(rootUri, options.bundle),
          sourceUri: rootUri
        }
      } : {}),
      detail: normalized.detail as ReferenceDetail,
      ...(normalized.fieldIds ? { targetRead } : {}),
      ...(options.scan ? { scan: options.scan } : {}),
      relations,
      coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [...scanned], truncated, coverageStates: options.coverageStates }),
      diagnostics: [
        ...(options.sourceDiagnostics ?? []),
        ...shards.diagnostics
          .filter((diagnostic) => diagnostic.sourceUri === undefined || relatedTo(diagnostic.sourceUri, connected, rootUri))
          .map((diagnostic) => ({
            severity: diagnostic.severity === 'error' ? 'error' as const : diagnostic.severity === 'info' ? 'info' as const : 'warning' as const,
            code: diagnostic.code,
            message: diagnostic.message,
            ...(diagnostic.sourceUri ? { sourceUri: diagnostic.sourceUri } : {})
          }))
      ].slice(0, 16),
      nextActions: truncated
        ? [{ tool: 'find_references', args: {}, reason: traversal.truncationReason ?? '关联遍历达到上限；请缩小查询范围后重试。' }, ...continuationReservation]
        : continuationReservation
    };

    const built: BuiltPage = buildBoundedPage({
      record: baseRecord,
      limit,
      offset,
      ...(normalized.detail === 'context' && rootUri
        ? { contextForPage: (pageRelations) => contextFor(rootUri!, pageRelations, targetRead) }
        : {}),
      ...(reserveContinuation ? { nextCursorPlaceholder: REFERENCE_CURSOR_TOKEN_PLACEHOLDER } : {}),
      ...(traversal.truncationReason ? { truncationReason: traversal.truncationReason } : {})
    });
    const relationPageHasMore = offset + built.record.relations.length < relations.length;
    const nextCursor = relationPageHasMore
      ? cursorStore.issue({
          workspaceId,
          scope: cursorScopeFor(normalized),
          rootUri,
          relationOffset: offset + built.record.relations.length,
          sourceVersionKey: currentSourceVersionKey,
          dependencySummary,
          ...(options.providerRegistryDigest ? { providerRegistryDigest: options.providerRegistryDigest } : {})
        })
      : undefined;
    if (nextCursor) {
      built.record.page = {
        ...built.record.page,
        returnedCount: built.record.relations.length,
        hasMore: true,
        nextCursor,
        ...(traversal.truncationReason ? { truncationReason: traversal.truncationReason } : {})
      };
      built.record.nextActions = [
        ...built.record.nextActions.filter((action) => action.tool !== 'find_references'),
        { tool: 'find_references', args: { cursor: nextCursor }, reason: '使用该游标继续读取当前已锁定关联结果页。' }
      ];
    } else if (traversal.truncationReason) {
      built.record.page = {
        ...built.record.page,
        ...(built.record.page.truncationReason ? {} : { truncationReason: traversal.truncationReason })
      };
    }
    built.record.nextActions = built.record.nextActions.filter((action) =>
      action.args.cursor !== REFERENCE_CURSOR_TOKEN_PLACEHOLDER);
    return built.record;
  }

  function domainOfUri(uri: string, bundle: SymbolBundle): string {
    if ((bundle.params ?? []).some((item) => item.sourceUri === uri || item.rows.some((row) => row.uri === uri))) return 'param';
    if ((bundle.events ?? []).some((item) => item.events.some((event) => event.sourceUri === uri || event.uri === uri))) return 'emevd';
    if ((bundle.maps ?? []).some((item) => item.entities.some((entity) => entity.sourceUri === uri || entity.uri === uri) || item.regions.some((region) => region.sourceUri === uri || region.uri === uri))) return 'map';
    if ((bundle.msgs ?? []).some((item) => item.entries.some((entry) => entry.sourceUri === uri || entry.uri === uri))) return 'fmg';
    if ((bundle.scripts ?? []).some((item) => item.sourceUri === uri || item.scripts.some((child) => child.uri === uri))) return 'script';
    if ((bundle.tae ?? []).some((item) => item.sourceUri === uri || item.animations.some((animation) => (
      animation.events.some((event) => event.uri === uri)
        || `${item.sourceUri}#anim/${animation.animId}@${animation.taeEntryIndex ?? 'x'}` === uri
    )))) return 'tae';
    return 'resource';
  }

  function relatedTo(sourceUri: string, edges: import('@soulforge/shared').ReferenceEdge[], rootUri: string | undefined): boolean {
    if (rootUri && sourceUri === rootUri) return true;
    return edges.some((edge) => edge.evidence.some((item) => item.sourceUri === sourceUri));
  }

  return {
    query,
    deliveredFieldProofs: () => [...fieldProofs]
  };
}
