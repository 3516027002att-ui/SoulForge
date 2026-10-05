import assert from 'node:assert/strict';
import { literalSourceSearchPage } from '../ai/literalSourceSearchPage.js';
import { assertCursorPrivacy } from './harness/assertCursorPrivacy.js';
import { createOpaqueCursor } from '@soulforge/shared';
const base = { text: 'alpha\n目标1\n目标2\n目标3', query: '目标', sourceKey: 'workspace:file', sourceHash: 'hash', limit: 1 };
let page = literalSourceSearchPage(base);
const privateKey = 'file:///home/alice/private-mod-workspace|file://script/battle.lua';
const privatePage = literalSourceSearchPage({ ...base, sourceKey: privateKey });
assert.equal(assertCursorPrivacy(privatePage, [privateKey, 'private-mod-workspace', '/home/alice']), 1);
assert.equal(literalSourceSearchPage({ ...base, sourceKey: privateKey, cursor: privatePage.nextCursor! }).matches[0]?.matchOffset, 10);
const legacy = createOpaqueCursor({ sessionId: 'literal-source-v1', domain: 'script', offset: 10,
  sourceHash: base.sourceHash, scope: JSON.stringify({ sourceKey: privateKey, query: base.query }) });
const migrated = literalSourceSearchPage({ ...base, sourceKey: privateKey, cursor: legacy });
assert.equal(migrated.matches[0]?.matchOffset, 10);
assert.equal(assertCursorPrivacy(migrated, [privateKey, 'private-mod-workspace']), 1);
const offsets = page.matches.map((item) => item.matchOffset);
while (page.nextCursor) { page = literalSourceSearchPage({ ...base, cursor: page.nextCursor }); offsets.push(...page.matches.map((item) => item.matchOffset)); }
assert.deepEqual(offsets, [6, 10, 14]);
assert.equal(page.searchComplete, true);
const cursor = literalSourceSearchPage(base).nextCursor!;
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceHash: 'other' }), /变化/);
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceKey: 'other' }), /不匹配/);
assert.throws(() => literalSourceSearchPage({ ...base, query: '' }), /query/);
console.log('Literal source search smoke passed.');
