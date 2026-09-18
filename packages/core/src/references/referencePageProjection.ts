/**
 * Bounded reference page projection under Agent envelope budget (8192 bytes/chars).
 * Prefers dropping whole relation items over truncating statements or identity hashes.
 */
import type {
  ReferenceCoverage,
  ReferencePageRecord,
  ReferenceRelationItem,
  ReferenceTargetRead
} from '@soulforge/shared';

export const REFERENCE_PAGE_BYTE_BUDGET = 8192;
export const REFERENCE_PAGE_CHAR_BUDGET = 8192;

export interface ProjectReferencePageInput {
  record: Omit<ReferencePageRecord, 'page'> & {
    page?: Partial<ReferencePageRecord['page']>;
  };
  /** Serializes the full envelope-shaped object for budget checks. */
  serialize: (record: ReferencePageRecord) => string;
  byteBudget?: number;
  charBudget?: number;
  cursorForOffset: (offset: number, digest: string) => string;
}

export type ProjectReferencePageResult = {
  ok: true;
  record: ReferencePageRecord;
  serialized: string;
  droppedCount: number;
} | {
  ok: false;
  code: 'REFERENCE_PAGE_ITEM_TOO_LARGE';
  message: string;
  details: unknown;
};

function measure(text: string): { bytes: number; chars: number } {
  return { bytes: Buffer.byteLength(text, 'utf8'), chars: text.length };
}

function withinBudget(text: string, byteBudget: number, charBudget: number): boolean {
  const m = measure(text);
  return m.bytes <= byteBudget && m.chars <= charBudget;
}

export function projectReferencePage(input: ProjectReferencePageInput): ProjectReferencePageResult {
  const byteBudget = input.byteBudget ?? REFERENCE_PAGE_BYTE_BUDGET;
  const charBudget = input.charBudget ?? REFERENCE_PAGE_CHAR_BUDGET;
  const dependencyDigest = input.record.page?.dependencyDigest ?? '';
  const sortVersion = input.record.page?.sortVersion ?? 'v1';

  const relations = [...input.record.relations];
  let droppedCount = 0;

  const build = (items: ReferenceRelationItem[], hasMore: boolean, nextCursor: string | undefined): ReferencePageRecord => {
    const inheritedHasMore = input.record.page?.hasMore === true;
    const finalHasMore = hasMore || inheritedHasMore;
    const inheritedCursor = input.record.page?.cursor;
    return ({
    ...input.record,
    relations: items,
    page: {
      returnedCount: items.length,
      hasMore: finalHasMore,
      ...(nextCursor ? { cursor: nextCursor } : inheritedHasMore && inheritedCursor ? { cursor: inheritedCursor } : {}),
      ...(input.record.page?.truncationReason && finalHasMore ? { truncationReason: input.record.page.truncationReason } : {}),
      dependencyDigest,
      sortVersion
    }
    });
  };

  // Single-item oversize: keep identity + tool entry, fail closed with recovery actions.
  if (relations.length === 1) {
    const single = build(relations, false, undefined);
    const singleText = input.serialize(single);
    if (!withinBudget(singleText, byteBudget, charBudget)) {
      return {
        ok: false,
        code: 'REFERENCE_PAGE_ITEM_TOO_LARGE',
        message: '单条关联语句连同必要身份超过页预算；请缩小读取窗口或改用字段级查询。',
        details: {
          relationId: relations[0]?.relationId,
          identity: relations[0]?.to,
          nextActions: input.record.nextActions
        }
      };
    }
    return { ok: true, record: single, serialized: singleText, droppedCount: 0 };
  }

  // Fit by removing whole relation items from the end; remainder goes to next page.
  for (let keep = relations.length; keep >= 0; keep -= 1) {
    const items = relations.slice(0, keep);
    const hasMore = keep < relations.length;
    const cursor = hasMore
      ? input.cursorForOffset(keep, dependencyDigest)
      : undefined;
    const record = build(items, hasMore, cursor);
    const text = input.serialize(record);
    if (withinBudget(text, byteBudget, charBudget)) {
      droppedCount = relations.length - keep;
      return { ok: true, record, serialized: text, droppedCount };
    }
  }

  // Even an empty relation page exceeds budget — preserve root identity/coverage only.
  const minimal = build([], relations.length > 0, relations.length > 0
    ? input.cursorForOffset(0, dependencyDigest)
    : undefined);
  const minimalText = input.serialize(minimal);
  if (!withinBudget(minimalText, byteBudget, charBudget)) {
    return {
      ok: false,
      code: 'REFERENCE_PAGE_ITEM_TOO_LARGE',
      message: '关联页基础身份/覆盖信息超过预算。',
      details: { nextActions: input.record.nextActions }
    };
  }
  return {
    ok: true,
    record: minimal,
    serialized: minimalText,
    droppedCount: relations.length
  };
}

/** Coverage for empty page that still scanned incompletely — never claim not_found. */
export function incompleteCoverage(input: {
  scopeDescription: string;
  notes?: string[];
}): ReferenceCoverage {
  return {
    scopeDescription: input.scopeDescription,
    predicateComplete: false,
    domains: [{
      domain: 'workspace',
      status: 'unscanned',
      notes: input.notes ?? ['coverage_incomplete']
    }],
    unresolvedSources: [],
    failedSources: [],
    unscannedSources: [],
    allowsNegativeClaim: false
  };
}

export function targetReadFromParamFields(input: {
  identity: ReferenceTargetRead['identity'];
  version: ReferenceTargetRead['version'];
  fields: Array<{ fieldId: string; value: unknown; displayName?: string }>;
  completeness?: ReferenceTargetRead['completeness'];
}): ReferenceTargetRead {
  return {
    identity: input.identity,
    version: input.version,
    fields: input.fields,
    completeness: input.completeness ?? 'complete'
  };
}
