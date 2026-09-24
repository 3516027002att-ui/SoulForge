import { createHash } from 'node:crypto';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';

/** Mixed documents bind hashes to their physical children, not an unordered hash set. */
export function paramReadSourceHash(cells: readonly { table: string; entryIndex: number; sourceHash: string }[]): string {
  const hashes = new Set(cells.map((cell) => cell.sourceHash));
  if (hashes.size === 1) return [...hashes][0]!;
  const versions = new Map<string, string>();
  for (const cell of cells) {
    const key = JSON.stringify([cell.entryIndex, cell.table]);
    const previous = versions.get(key);
    if (previous !== undefined && previous !== cell.sourceHash) {
      throw Object.assign(new Error('PARAM 子文档在本次读取内出现不同版本。'), { code: 'PARAM_SOURCE_CHANGED_DURING_READ' });
    }
    versions.set(key, cell.sourceHash);
  }
  return createHash('sha256').update(JSON.stringify([...versions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest('hex');
}

/** Scope binds the complete request without copying its paths/field list into every cursor. */
export function paramReadWindow<T extends { table: string; fieldId: string }, D>(input: {
  cells: readonly T[];
  definitions: ReadonlyMap<string, D>;
  legacyScope: string;
  sourceHash: string;
  pageSize: number;
  cellIdentity: (cell: T) => unknown;
  cursor?: string;
}) {
  const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }); };
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 128) fail('PARAM_CURSOR_INVALID', 'PARAM pageSize 无效。');
  const scopeHash = createHash('sha256').update(input.legacyScope);
  // The legacy scope sorted requested IDs although the delivered cells kept
  // request order. Bind actual physical cell order too, or reordered requests
  // could silently skip/duplicate cells at an otherwise valid offset.
  for (const cell of input.cells) scopeHash.update('\0').update(JSON.stringify(input.cellIdentity(cell)));
  const queryScope = `param-fields-v2:${scopeHash.digest('hex')}`;
  let offset = 0;
  if (input.cursor) {
    const payload = parseOpaqueCursor(input.cursor);
    if (payload.domain !== 'param' || (payload.scope !== queryScope && payload.scope !== input.legacyScope)) {
      fail('PARAM_CURSOR_SCOPE_MISMATCH', 'PARAM 字段 cursor 与当前工作区、表、行或字段集合不匹配，请重新读取。');
    }
    if (payload.sourceHash !== input.sourceHash) fail('STALE_READ_CURSOR', 'PARAM 来源已改变，请重新读取。');
    offset = payload.offset;
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.cells.length) fail('PARAM_CURSOR_INVALID', 'PARAM 字段 cursor 的位置超出当前稳定结果集合。');
  const items = input.cells.slice(offset, offset + input.pageSize);
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < input.cells.length ? createOpaqueCursor({
    sessionId: 'param-fields-v2', offset: nextOffset, domain: 'param',
    sourceHash: input.sourceHash, scope: queryScope
  }) : null;
  const keys = new Set(items.map((item) => `${item.table}\0${item.fieldId}`));
  const fieldDefinitions: D[] = [];
  for (const key of keys) {
    const definition = input.definitions.get(key);
    if (definition !== undefined) fieldDefinitions.push(definition);
  }
  return { items, offset, nextCursor, queryScope, fieldDefinitions };
}
