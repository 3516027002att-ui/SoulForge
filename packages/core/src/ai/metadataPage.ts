import { createHash } from 'node:crypto';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';

/** Pages an already parsed, finite metadata collection without losing a row to transport trimming. */
export function metadataPage<T>(options: {
  items: readonly T[];
  scope: unknown;
  sourceHash: string;
  domain: 'param' | 'script';
  cursor?: string;
  limit?: number;
}) {
  const limit = options.limit ?? 6;
  const reject = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) reject('INVALID_METADATA_WINDOW', 'limit 必须为 1 到 32 的安全整数。');
  const scope = createHash('sha256').update(JSON.stringify(options.scope)).digest('hex');
  const sourceHash = createHash('sha256').update(options.sourceHash).update(JSON.stringify(options.items)).digest('hex');
  let offset = 0;
  if (options.cursor) {
    const cursor = parseOpaqueCursor(options.cursor);
    if (cursor.sessionId !== 'metadata-v1' || cursor.domain !== options.domain || cursor.scope !== scope) {
      reject('METADATA_CURSOR_SCOPE_MISMATCH', '元数据游标与工作区、对象或查询不匹配。');
    }
    if (cursor.sourceHash !== sourceHash) reject('STALE_READ_CURSOR', '原生来源或元数据已改变，请从第一页重读。');
    offset = cursor.offset;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > options.items.length) reject('INVALID_METADATA_WINDOW', '元数据偏移越界。');
  const items: T[] = [];
  let bytes = 2;
  for (let i = offset; i < options.items.length && items.length < Math.min(limit, 6); i++) {
    const item = options.items[i]!;
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
    if (bytes + size > 3_000) {
      if (items.length === 0) {
        const identity = item && typeof item === 'object' ? item as Record<string, unknown> : {};
        throw Object.assign(new Error('单条元数据超过窗口预算；请按 span 或 fieldId 读取原文，不得将摘要当作完整结构。'), {
          code: 'METADATA_ITEM_TOO_LARGE', details: { itemIndex: i, total: options.items.length, span: identity.span, fieldId: identity.fieldId }
        });
      }
      break;
    }
    items.push(item);
    bytes += size;
  }
  const end = offset + items.length;
  const truncated = end < options.items.length;
  return {
    items, total: options.items.length, totalCount: options.items.length,
    offset, limit: Math.min(limit, 6), returned: items.length, returnedCount: items.length, truncated,
    ...(truncated ? { nextCursor: createOpaqueCursor({ sessionId: 'metadata-v1', domain: options.domain, scope, sourceHash, offset: end }) } : {})
  };
}
