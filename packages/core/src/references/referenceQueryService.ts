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
 * 6. 有界事件调用链遍历补充 indirect 路径；稳定排序。
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
  edgeIdentityKey,
  identityForUri,
  decodeCursor,
  encodeCursor,
  type BuiltPage
} from './referencePageProjection.js';
import { REFERENCE_PROVIDERS, type ProviderBuildOptions } from './referenceProviderRegistry.js';
import { buildEventCallChain } from './eventReferenceProvider.js';
import type { EmedfRegistry } from '../emevd/emedfSchema.js';
import { dependencySummariesMatch, type DependencySummary } from '../runtime/resourceVersion.js';

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

interface CursorRegistration {
  workspaceId: string;
  scopeKey: string;
  /** Root resolved at issue time; continuation re-reads the same object. */
  rootUri: string;
  offset: number;
  sourceOffset: number;
  dependencySummary: DependencySummary;
}

export interface ReferenceQueryService {
  query(input: ReferenceQueryInput): Promise<ReferencePageRecord>;
  /** Field observations actually delivered to the caller (T09 proof input). */
  deliveredFieldProofs(): Array<{ sourceUri: string; rowId: number; rowIndex?: number; fieldId: string; dataHash?: string }>;
}

export function createReferenceQueryService(options: ReferenceQueryServiceOptions): ReferenceQueryService {
  const workspaceId = options.workspaceId ?? 'workspace';
  const maxSources = options.maxSources ?? 64;
  const cursors = new Map<string, CursorRegistration>();
  const fieldProofs: Array<{ sourceUri: string; rowId: number; rowIndex?: number; fieldId: string; dataHash?: string }> = [];
  let shardCache: { key: string; edges: import('@soulforge/shared').ReferenceEdge[]; diagnostics: import('@soulforge/shared').Diagnostic[] } | undefined;

  function collectShards(): { edges: import('@soulforge/shared').ReferenceEdge[]; diagnostics: import('@soulforge/shared').Diagnostic[] } {
    const bundle = options.bundle;
    const versions = `${bundleVersionKey(bundle)}|providers:${options.providerRegistryDigest ?? 'default'}`;
    if (shardCache && shardCache.key === versions) return shardCache;
    const edges: import('@soulforge/shared').ReferenceEdge[] = [];
    const diagnostics: import('@soulforge/shared').Diagnostic[] = [];
    const buildOptions: ProviderBuildOptions = {
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.buildOptions ?? {})
    };
    for (const provider of REFERENCE_PROVIDERS) {
      const shard = provider.build(bundle, buildOptions);
      edges.push(...shard.edges);
      diagnostics.push(...shard.diagnostics);
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

  function scopeKeyFor(input: NormalizedReferenceQuery): string {
    // Only the root-resolving fields matter for continuation re-resolution;
    // cursor/limit/offset are page state, not scope.
    return JSON.stringify({
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {})
    });
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

  function insufficientRecord(message: string): ReferencePageRecord {
    return {
      resolution: 'insufficient_evidence',
      relations: [],
      coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [], truncated: false, coverageStates: options.coverageStates }),
      page: { returnedCount: 0, hasMore: false },
      diagnostics: [{ severity: 'warning', code: 'REFERENCE_INSUFFICIENT_EVIDENCE', message }],
      nextActions: []
    };
  }

  async function query(input: ReferenceQueryInput): Promise<ReferencePageRecord> {
    const decoded = decodeReferenceQueryInput(input);
    if (!decoded.ok) {
      throw Object.assign(new Error(decoded.message), { code: decoded.code, field: decoded.field });
    }
    const normalized = decoded.input;
    const limit = normalized.limit ?? REFERENCE_LIMIT_DEFAULT;
    const depth = normalized.depth ?? REFERENCE_DEPTH_DEFAULT;

    // --- Cursor continuation (投影 8): validate against host registration. ---
    let offset = 0;
    let cursorRegistration: CursorRegistration | undefined;
    if (normalized.cursor) {
      const parsed = decodeCursor(normalized.cursor);
      if (!parsed) throw Object.assign(new Error('关联游标格式无效。'), { code: 'REFERENCE_INVALID_INPUT' });
      const registration = cursors.get(normalized.cursor);
      if (!registration) throw Object.assign(new Error('游标未由本会话签发或已过期；请重新发起查询。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      if (registration.workspaceId !== workspaceId) {
        throw Object.assign(new Error('游标属于其他 workspace。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      // The query scope lives in the host registration (the decoder forbids
      // re-declaring uri/target/query on continuation); the cursor token itself
      // is the scope binding. Version drift invalidates the old page snapshot.
      const summary = buildDependencySummary(options.bundle);
      if (!dependencySummariesMatch(registration.dependencySummary, summary)) {
        throw Object.assign(new Error('来源版本在分页期间变化；旧游标失效，请重新查询。'), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' });
      }
      offset = parsed.offset;
      cursorRegistration = registration;
    }

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

    // --- Step 5: shards (merged per source/version via cache). ---
    const shards = collectShards();
    const scanned = new Set<string>();
    const rootSourceUri = rootUri.split('#')[0] ?? rootUri;
    scanned.add(rootSourceUri);
    const direction = normalized.direction ?? 'both';
    const includeHypotheses = normalized.includeHypotheses === true;
    const allConnected = shards.edges.filter((edge) => {
      if (!includeHypotheses && edge.confidence === 'low' && edge.reason.includes('hypothesis(')) return false;
      if (direction === 'from') return edge.fromUri === rootUri;
      if (direction === 'to') return edge.toUri === rootUri;
      return edge.fromUri === rootUri || edge.toUri === rootUri;
    });
    const allSourceUris = [...new Set([
      ...scanned,
      ...allConnected.flatMap((edge) => [edge.fromUri.split('#')[0] ?? edge.fromUri, edge.toUri.split('#')[0] ?? edge.toUri])
    ])].sort();
    const sourceOffset = cursorRegistration
      ? (decodeCursor(normalized.cursor!)?.sourceOffset ?? cursorRegistration.sourceOffset)
      : 0;
    const selectedSourceUris = new Set(allSourceUris.slice(sourceOffset, sourceOffset + maxSources));
    const connected = allConnected.filter((edge) => {
      const fromSource = edge.fromUri.split('#')[0] ?? edge.fromUri;
      const toSource = edge.toUri.split('#')[0] ?? edge.toUri;
      return selectedSourceUris.has(fromSource) || selectedSourceUris.has(toSource);
    });
    for (const edge of connected) {
      scanned.add(edge.fromUri.split('#')[0] ?? edge.fromUri);
      scanned.add(edge.toUri.split('#')[0] ?? edge.toUri);
    }
    const truncated = sourceOffset + maxSources < allSourceUris.length;

    // --- Step 6: bounded call-chain for indirect paths + stable order. ---
    const indirectKeys = rootUri.includes('#event/') ? indirectEdgeKeys(rootUri, depth) : new Set<string>();
    const versions = collectSourceVersions(options.bundle);
    const relations = assembleRelations({
      edges: connected,
      bundle: options.bundle,
      workspaceId,
      versions,
      indirectEdgeKeys: indirectKeys
    });

    // --- Steps 7-8: coverage, dependency summary, envelope page. ---
    const dependencySummary = buildDependencySummary(options.bundle);
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
      ...(normalized.detail === 'context' && rootUri
        ? { context: contextFor(rootUri, relations, targetRead) }
        : {}),
      relations,
      coverage: buildCoverage({ bundle: options.bundle, scannedDomains: [...scanned], truncated, coverageStates: options.coverageStates }),
      diagnostics: shards.diagnostics
        .filter((diagnostic) => diagnostic.sourceUri === undefined || relatedTo(diagnostic.sourceUri, connected, rootUri))
        .slice(0, 16)
        .map((diagnostic) => ({
          severity: diagnostic.severity === 'error' ? 'error' as const : 'warning' as const,
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.sourceUri ? { sourceUri: diagnostic.sourceUri } : {})
        })),
      nextActions: truncated
        ? [{ tool: 'find_references', args: {}, reason: '扫描来源超过上限，用返回的 nextCursor 续页获取剩余关系' }]
        : []
    };

    const built: BuiltPage = buildBoundedPage({ record: baseRecord, limit, offset });
    if (rootUri) {
      const relationCursor = built.record.page.nextCursor
        ? decodeCursor(built.record.page.nextCursor)
        : undefined;
      const nextSourceOffset = sourceOffset + maxSources;
      const continuationSourceOffset = relationCursor
        ? sourceOffset
        : truncated
          ? nextSourceOffset
          : sourceOffset;
      const nextCursor = relationCursor
        ? encodeCursor(relationCursor.offset, continuationSourceOffset)
        : truncated
          ? encodeCursor(0, continuationSourceOffset)
          : undefined;
      if (nextCursor) {
        built.record.page = {
          ...built.record.page,
          hasMore: true,
          nextCursor
        };
      }
      if (nextCursor) {
        cursors.set(nextCursor, {
        workspaceId,
        scopeKey: scopeKeyFor(normalized),
        rootUri,
        offset: relationCursor?.offset ?? 0,
        sourceOffset: continuationSourceOffset,
        dependencySummary
      });
      if (truncated || relationCursor) {
        built.record.nextActions = built.record.nextActions.map((action) =>
          action.tool === 'find_references'
            ? { ...action, args: { cursor: nextCursor } }
            : action);
      }
      }
    }
    return built.record;
  }

  function domainOfUri(uri: string, bundle: SymbolBundle): string {
    if ((bundle.params ?? []).some((item) => item.rows.some((row) => row.uri === uri))) return 'param';
    if ((bundle.events ?? []).some((item) => item.events.some((event) => event.uri === uri))) return 'emevd';
    if ((bundle.maps ?? []).some((item) => item.entities.some((entity) => entity.uri === uri) || item.regions.some((region) => region.uri === uri))) return 'map';
    if ((bundle.msgs ?? []).some((item) => item.entries.some((entry) => entry.uri === uri))) return 'fmg';
    if ((bundle.scripts ?? []).some((item) => item.scripts.some((child) => child.uri === uri))) return 'script';
    if ((bundle.tae ?? []).some((item) => item.animations.some((animation) => (
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
