import assert from 'node:assert/strict';
import { literalSourceSearchPage } from '../ai/literalSourceSearchPage.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
const base = { text: 'alpha\n目标1\n目标2\n目标3', query: '目标', sourceKey: 'workspace:file', sourceHash: 'hash', limit: 1 };
let page = literalSourceSearchPage(base);
// sourceKey embeds the workspace id (absolute file:// URL); the wire carries only its digest.
const privateKey = 'file:///home/alice/private-mod-workspace|file://script/battle.lua';
const privatePage = literalSourceSearchPage({ ...base, sourceKey: privateKey });
assert.equal(assertCursorPrivacy(privatePage, [privateKey, 'private-mod-workspace', '/home/alice']), 1);
assert.equal(parseOpaqueCursor(privatePage.nextCursor!).sessionId, 'literal-source-v2');
assert.equal(literalSourceSearchPage({ ...base, sourceKey: privateKey, cursor: privatePage.nextCursor! }).matches[0]?.matchOffset, 10);
assert.throws(() => literalSourceSearchPage({ ...base, sourceKey: privateKey + '-other', cursor: privatePage.nextCursor! }), { code: 'SOURCE_CURSOR_SCOPE_MISMATCH' });
// Unhashed v1 cursors are rejected (not migrated).
const legacy = createOpaqueCursor({ sessionId: 'literal-source-v1', domain: 'script', offset: 10,
  sourceHash: base.sourceHash, scope: JSON.stringify({ sourceKey: privateKey, query: base.query }) });
assert.throws(() => literalSourceSearchPage({ ...base, sourceKey: privateKey, cursor: legacy }), (error: unknown) => {
  assert.ok(!String(error).includes('private-mod-workspace'), 'rejection must not echo the decodable path');
  return (error as { code?: string }).code === 'SOURCE_CURSOR_SCOPE_MISMATCH';
});
// A v2 token carrying the raw sourceKey instead of its digest is rejected too.
const rawV2 = createOpaqueCursor({ ...parseOpaqueCursor(privatePage.nextCursor!), scope: JSON.stringify({ sourceKey: privateKey, query: base.query }) });
assert.throws(() => literalSourceSearchPage({ ...base, sourceKey: privateKey, cursor: rawV2 }), { code: 'SOURCE_CURSOR_SCOPE_MISMATCH' });
const offsets = page.matches.map((item) => item.matchOffset);
while (page.nextCursor) { page = literalSourceSearchPage({ ...base, cursor: page.nextCursor }); offsets.push(...page.matches.map((item) => item.matchOffset)); }
assert.deepEqual(offsets, [6, 10, 14]);
assert.equal(page.searchComplete, true);
const cursor = literalSourceSearchPage(base).nextCursor!;
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceHash: 'other' }), /变化/);
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceKey: 'other' }), /不匹配/);
assert.throws(() => literalSourceSearchPage({ ...base, query: '' }), /query/);
console.log('Literal source search smoke passed.');
