import assert from 'node:assert/strict';
import { literalSourceSearchPage } from '../ai/literalSourceSearchPage.js';
const base = { text: 'alpha\n目标1\n目标2\n目标3', query: '目标', sourceKey: 'workspace:file', sourceHash: 'hash', limit: 1 };
let page = literalSourceSearchPage(base);
const offsets = page.matches.map((item) => item.matchOffset);
while (page.nextCursor) { page = literalSourceSearchPage({ ...base, cursor: page.nextCursor }); offsets.push(...page.matches.map((item) => item.matchOffset)); }
assert.deepEqual(offsets, [6, 10, 14]);
assert.equal(page.searchComplete, true);
const cursor = literalSourceSearchPage(base).nextCursor!;
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceHash: 'other' }), /变化/);
assert.throws(() => literalSourceSearchPage({ ...base, cursor, sourceKey: 'other' }), /不匹配/);
assert.throws(() => literalSourceSearchPage({ ...base, query: '' }), /query/);
console.log('Literal source search smoke passed.');
