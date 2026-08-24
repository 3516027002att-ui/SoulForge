/**
 * DOCSTORE-04: owner-bound 编辑器文档仓库（§14.4 六签名闭合契约）。
 *
 * renderer 发送逻辑引用，main 从 trusted sender/session 推导 ownerKey 后调用
 * 本仓库。ownerKey、绝对路径与 locator 永远不出 main/core：本模块持有完整
 * NativeDocumentLocator（含 outerSourceUri），renderer 只拿 opaque
 * documentHandle。
 *
 * 数据与写链不在本模块：分页/内容由注入的 EditorDocumentDataSource 提供，
 * mutation 由注入的 EditorMutationApplyPort 执行（生产实现是 Patch Engine
 * 写链，smoke 用确定性桩）。本模块只负责 ownership、revision、TTL、能力与
 * bounded page 的裁定。
 */

import { randomUUID } from 'node:crypto';
import type {
  ApplyEditorMutationRequest,
  ApplyEditorMutationValue,
  EditTransactionState,
  EditorContentQuery,
  EditorContentValue,
  EditorDocumentErrorCode,
  EditorDocumentPageValue,
  EditorDocumentResult,
  EditorMutation,
  EditorPageItemDto,
  EditorPageQuery,
  OpenEditorDocumentValue,
  ReadEditorContentRequest,
  ReadOperationId,
  WriteOperationId
} from '@soulforge/shared';
import type { NativeDocumentLocator } from './nativeDocumentLocator.js';
import {
  mutationCapabilityForLocator,
  readOperationForQuery
} from './editorMutationService.js';

export interface EditorDocumentStoreContract {
  open(ownerKey: string, locator: NativeDocumentLocator): Promise<EditorDocumentResult<OpenEditorDocumentValue>>;
  get(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>>;
  page(ownerKey: string, request: PageEditorDocumentRequestLike): Promise<EditorDocumentResult<EditorDocumentPageValue>>;
  readContent(ownerKey: string, request: ReadEditorContentRequest): Promise<EditorDocumentResult<EditorContentValue>>;
  apply(ownerKey: string, request: ApplyEditorMutationRequest): Promise<EditorDocumentResult<ApplyEditorMutationValue>>;
  close(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<{ closed: true }>>;
}

/** §14.4 PageEditorDocumentRequest 的 core-internal 形态（shared DTO 已解码）。 */
export interface PageEditorDocumentRequestLike {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly query: EditorPageQuery;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * Main-only context supplied to a production data/write adapter.
 *
 * The renderer still receives only the opaque handle.  Keeping the locator on
 * this injected boundary lets the main process resolve the actual source and
 * route the operation through Bridge/Patch Engine without leaking an absolute
 * path into the renderer-facing DTOs.
 */
export interface EditorDocumentDataSourceContext {
  readonly documentHandle: string;
  readonly expectedRevision: string;
  readonly locator: NativeDocumentLocator;
}

export interface EditorDocumentDataSource {
  /**
   * 加载一页。返回 items=null 表示该 query kind 没有数据源（capability
   * 未接通），与「空页」区分：空页是 items=[]。
   */
  loadPage(
    query: EditorPageQuery,
    cursor: string | null,
    limit: number,
    context?: EditorDocumentDataSourceContext
  ): Promise<{
    items: readonly EditorPageItemDto[] | null;
    nextCursor: string | null;
    totalKnown: number | null;
  }>;
  readContent(
    query: EditorContentQuery,
    context?: EditorDocumentDataSourceContext
  ): Promise<EditorContentValue | null>;
}

export type EditorMutationApplyOutcome =
  | { kind: 'committed'; operationId: string }
  | { kind: 'cancelled' }
  | { kind: 'rejected'; code: string };

export interface EditorMutationApplyPort {
  apply(
    mutation: EditorMutation,
    context?: EditorDocumentDataSourceContext
  ): Promise<EditorMutationApplyOutcome>;
}

export interface EditorDocumentStoreOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly dataSource: EditorDocumentDataSource;
  readonly applyPort: EditorMutationApplyPort;
  /** Production adapters may expose only the operations they actually route. */
  readonly capabilityResolver?: (
    locator: NativeDocumentLocator,
    base: ReturnType<typeof mutationCapabilityForLocator>
  ) => { readOperations: readonly ReadOperationId[]; writeOperations: readonly WriteOperationId[] };
}

interface OpenDocumentRecord {
  readonly handle: string;
  readonly ownerKey: string;
  readonly locator: NativeDocumentLocator;
  revision: number;
  lastAccessedAt: number;
}

/** query kind → item kind（§14.4：page 返回的 item kind 必须与 query kind 匹配）。 */
const ITEM_KIND_FOR_QUERY = {
  'param-tables': 'param-table',
  'param-rows': 'param-row',
  'param-fields': 'param-field',
  'gparam-groups': 'gparam-group',
  'gparam-fields': 'gparam-field',
  'fmg-entries': 'fmg-entry',
  'event-outline': 'event-outline',
  'container-entries': 'container-entry',
  'script-symbols': 'script-symbol',
  'resource-tree': 'resource-node',
  'properties': 'property'
} as const satisfies Record<EditorPageQuery['kind'], EditorPageItemDto['kind']>;

const READ_OPERATION_FOR_CONTENT = {
  'fmg-content': 'read-source',
  'event-source': 'read-source',
  'script-source': 'read-source',
  'resource-preview': 'read-preview'
} as const satisfies Record<EditorContentQuery['kind'], ReadOperationId>;

function ok<T>(value: T): EditorDocumentResult<T> {
  return { ok: true, value };
}

function fail(code: EditorDocumentErrorCode, retryable: boolean): EditorDocumentResult<never> {
  return { ok: false, code, retryable };
}

export class EditorDocumentStore implements EditorDocumentStoreContract {
  private readonly documents = new Map<string, OpenDocumentRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly dataSource: EditorDocumentDataSource;
  private readonly applyPort: EditorMutationApplyPort;
  private readonly capabilityResolver: EditorDocumentStoreOptions['capabilityResolver'];

  constructor(options: EditorDocumentStoreOptions) {
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? (() => Date.now());
    this.dataSource = options.dataSource;
    this.applyPort = options.applyPort;
    this.capabilityResolver = options.capabilityResolver;
  }

  private revisionOf(record: OpenDocumentRecord): string {
    return `rev:${record.revision}`;
  }

  private contextOf(record: OpenDocumentRecord): EditorDocumentDataSourceContext {
    return {
      documentHandle: record.handle,
      expectedRevision: this.revisionOf(record),
      locator: record.locator
    };
  }

  private capabilitiesOf(record: OpenDocumentRecord): ReturnType<typeof mutationCapabilityForLocator> {
    const base = mutationCapabilityForLocator(record.locator);
    return this.capabilityResolver ? this.capabilityResolver(record.locator, base) : base;
  }

  private toOpenValue(record: OpenDocumentRecord): OpenEditorDocumentValue {
    const { readOperations, writeOperations } = this.capabilitiesOf(record);
    return {
      documentHandle: record.handle,
      revision: this.revisionOf(record),
      loadState: { kind: 'ready' },
      readOperations,
      writeOperations
    };
  }

  private resolve(
    ownerKey: string,
    documentHandle: string
  ): EditorDocumentResult<OpenDocumentRecord> {
    const record = this.documents.get(documentHandle);
    if (!record) return fail('not-found', false);
    if (record.ownerKey !== ownerKey) return fail('owner-mismatch', false);
    if (this.now() - record.lastAccessedAt > this.ttlMs) {
      // 过期即废弃：后续访问也一律 expired，不再复活。
      this.documents.delete(documentHandle);
      return fail('expired', true);
    }
    record.lastAccessedAt = this.now();
    return ok(record);
  }

  async open(ownerKey: string, locator: NativeDocumentLocator): Promise<EditorDocumentResult<OpenEditorDocumentValue>> {
    const existing = [...this.documents.values()].find(
      (record) => record.locator.locatorId === locator.locatorId
    );
    if (existing) {
      if (existing.ownerKey !== ownerKey) return fail('owner-mismatch', false);
      existing.lastAccessedAt = this.now();
      return ok(this.toOpenValue(existing));
    }
    const record: OpenDocumentRecord = {
      handle: randomUUID(),
      ownerKey,
      locator,
      revision: 0,
      lastAccessedAt: this.now()
    };
    this.documents.set(record.handle, record);
    return ok(this.toOpenValue(record));
  }

  async get(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<OpenEditorDocumentValue>> {
    const resolved = this.resolve(ownerKey, documentHandle);
    if (!resolved.ok) return resolved;
    return ok(this.toOpenValue(resolved.value));
  }

  async page(
    ownerKey: string,
    request: PageEditorDocumentRequestLike
  ): Promise<EditorDocumentResult<EditorDocumentPageValue>> {
    const resolved = this.resolve(ownerKey, request.documentHandle);
    if (!resolved.ok) return resolved;
    const record = resolved.value;
    if (request.expectedRevision !== this.revisionOf(record)) return fail('stale-revision', false);

    const { readOperations } = this.capabilitiesOf(record);
    const requiredOperation = readOperationForQuery(request.query.kind);
    if (!readOperations.includes(requiredOperation)) return fail('capability-blocked', false);

    const loaded = await this.dataSource.loadPage(
      request.query,
      request.cursor,
      request.limit,
      this.contextOf(record)
    );
    if (loaded.items === null) return fail('capability-blocked', false);
    if (loaded.items.length > request.limit) return fail('invalid-request', false);

    // §14.4：page 返回的 item kind 必须与 query kind 匹配，否则 decoder 拒绝整页。
    // store 在 decoder 之外再兜底一层：数据源若返回错 kind，整页拒绝而不是
    // 静默透传给 renderer。
    const expectedKind = ITEM_KIND_FOR_QUERY[request.query.kind];
    if (loaded.items.some((item) => item.kind !== expectedKind)) {
      return fail('invalid-request', false);
    }

    return ok({
      documentHandle: record.handle,
      revision: this.revisionOf(record),
      queryKind: request.query.kind,
      items: loaded.items,
      nextCursor: loaded.nextCursor,
      totalKnown: loaded.totalKnown
    });
  }

  async readContent(
    ownerKey: string,
    request: ReadEditorContentRequest
  ): Promise<EditorDocumentResult<EditorContentValue>> {
    const resolved = this.resolve(ownerKey, request.documentHandle);
    if (!resolved.ok) return resolved;
    const record = resolved.value;
    if (request.expectedRevision !== this.revisionOf(record)) return fail('stale-revision', false);

    const { readOperations } = this.capabilitiesOf(record);
    const requiredOperation = READ_OPERATION_FOR_CONTENT[request.query.kind];
    if (!readOperations.includes(requiredOperation)) return fail('capability-blocked', false);

    const content = await this.dataSource.readContent(request.query, this.contextOf(record));
    if (content === null) return fail('capability-blocked', false);
    return ok(content);
  }

  async apply(
    ownerKey: string,
    request: ApplyEditorMutationRequest
  ): Promise<EditorDocumentResult<ApplyEditorMutationValue>> {
    const resolved = this.resolve(ownerKey, request.documentHandle);
    if (!resolved.ok) return resolved;
    const record = resolved.value;
    if (request.expectedRevision !== this.revisionOf(record)) return fail('stale-revision', false);

    const { writeOperations } = this.capabilitiesOf(record);
    if (!writeOperations.includes(request.mutation.kind as WriteOperationId)) {
      return fail('capability-blocked', false);
    }

    const outcome = await this.applyPort.apply(request.mutation, this.contextOf(record));
    if (outcome.kind === 'cancelled') return fail('cancelled', false);
    if (outcome.kind === 'rejected') return fail('mutation-rejected', false);

    record.revision += 1;
    const transactionState: EditTransactionState = {
      kind: 'committed',
      operationId: outcome.operationId,
      committedRevision: this.revisionOf(record)
    };
    return ok({
      documentHandle: record.handle,
      revision: this.revisionOf(record),
      transactionState
    });
  }

  async close(ownerKey: string, documentHandle: string): Promise<EditorDocumentResult<{ closed: true }>> {
    const resolved = this.resolve(ownerKey, documentHandle);
    if (!resolved.ok) return resolved;
    this.documents.delete(documentHandle);
    return ok({ closed: true });
  }
}
