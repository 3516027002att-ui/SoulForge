import assert from 'node:assert/strict';
import { sourceTextPage } from '../ai/sourceTextPage.js';
import { contentSearchPage } from '../ai/contentSearchPage.js';
import { WorkspaceIndex } from '../indexing/workspaceIndex.js';
import { resolveEntity } from '../ai/entityResolution.js';
import { buildNameMatchEdges } from '../references/referenceProviderRegistry.js';
import { buildParamReferenceEdges } from '../references/paramReferenceProvider.js';

const original = ('函数("中文 😀", "\\路径");\n').repeat(600);
let cursor: string | undefined;
let assembled = '';
let pages = 0;
do {
  const page = sourceTextPage({ text: original, sourceKey: 'workspace:script/ai!/battle.lua', sourceHash: 'native-child', domain: 'script', ...(cursor ? { cursor } : {}) });
  assert.ok(page.sourceText.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(page.sourceText), 'utf8') <= 3200);
  assert.equal(page.sourceTextComplete, false);
  assembled += page.sourceText;
  cursor = page.nextCursor;
  pages += 1;
  assert.ok(pages < 100);
} while (cursor);
assert.equal(assembled, original);
const first = sourceTextPage({ text: original, sourceKey: 'script-a', sourceHash: 'version-a', domain: 'script' });
assert.ok(first.nextCursor);
assert.throws(() => sourceTextPage({ text: original, sourceKey: 'script-b', sourceHash: 'version-a', domain: 'script', cursor: first.nextCursor! }), { code: 'SOURCE_CURSOR_SCOPE_MISMATCH' });
assert.throws(() => sourceTextPage({ text: original + 'changed', sourceKey: 'script-a', sourceHash: 'version-a', domain: 'script', cursor: first.nextCursor! }), { code: 'STALE_READ_CURSOR' });
assert.equal(sourceTextPage({ text: '😀', sourceKey: 'script', sourceHash: 'version', domain: 'script', sourceLimit: 1 }).sourceText, '😀');
assert.equal(sourceTextPage({ text: '', sourceKey: 'script', sourceHash: 'version', domain: 'script' }).sourceTextComplete, true);
assert.throws(() => sourceTextPage({ text: '😀', sourceKey: 'script', sourceHash: 'version', domain: 'script', sourceOffset: 1 }), { code: 'INVALID_SOURCE_WINDOW' });

const index = new WorkspaceIndex('content-search-smoke');
const sourceUri = 'file://param/gameparam/gameparam.parambnd.dcx';
index.setFiles([{
  id: 'param-file', workspaceId: 'content-search-smoke', sourcePath: 'param/gameparam/gameparam.parambnd.dcx', parseStatus: 'parsed',
  sourceUri, relativePath: 'param/gameparam/gameparam.parambnd.dcx', absolutePath: '/mods/param/gameparam/gameparam.parambnd.dcx',
  game: 'sekiro', resourceKind: 'param', formatKind: 'dcx', formatLabel: 'PARAM', extension: '.dcx',
  compoundExtension: '.parambnd.dcx', size: 1, mtimeMs: 7, sha256: 'outer-hash', diagnostics: []
} as Parameters<typeof index.setFiles>[0][number]]);
index.upsertParamExport({
  sourceUri, paramName: 'EquipParamGoods', entryIndex: 39, sourceHash: 'child-hash', outerFileHash: 'outer-hash', sourceRevision: 7,
  rows: [{ uri: 'param://EquipParamGoods/4400', sourceUri, paramName: 'EquipParamGoods', rowId: 4400, rowName: '葫芦种子',
    fields: [], sourceHash: 'child-hash', outerFileHash: 'outer-hash', sourceRevision: 7 }]
});
const found = await resolveEntity({ index, query: '葫芦种子', domain: 'param' });
assert.equal(found.candidates.length, 1);
assert.notEqual(found.candidates[0]?.status, 'stale');
assert.equal(found.candidates[0]?.candidateId, 'param://EquipParamGoods/4400');
const nameMatches = buildNameMatchEdges({ ...index.toSymbolBundle(), msgs: [{ entries: [{
  uri: 'msg://zhocn/item/name/9801', sourceUri: 'file://msg/zhocn/item.msgbnd.dcx', textId: 9801, text: '葫芦种子'
}] }] });
assert.equal(nameMatches.edges.length, 1);
assert.equal(nameMatches.edges[0]?.kind, 'name_match');
assert.equal(nameMatches.edges[0]?.confidence, 'low');
assert.equal(nameMatches.edges[0]?.toUri, 'msg://zhocn/item/name/9801');
const nativePathRefs = buildParamReferenceEdges([
  { ...index.toSymbolBundle().params![0]!, entryName: 'N:\\authoring\\EquipParamGoods.param', rows: [{
    ...index.toSymbolBundle().params![0]!.rows[0]!, fields: [{ fieldId: 'effect', name: 'effect', type: 's32', value: 10,
      refs: [{ param: 'SpEffectParam' }], refsProvenance: 'trusted-metadata' }]
  }] },
  { paramName: 'SP_EFFECT_PARAM_ST', entryName: 'N:\\authoring\\SpEffectParam.param', sourceUri, rows: [{
    uri: 'param://SpEffectParam/10', sourceUri, paramName: 'SpEffectParam', rowId: 10, fields: []
  }] }
]);
assert.equal(nativePathRefs.edges.length, 1);
assert.equal(nativePathRefs.edges[0]?.toUri, 'param://SpEffectParam/10');
const searchRows = Array.from({ length: 15 }, (_, id) => ({ id, text: `文本 ${id}` }));
const searchOptions = {
  tool: 'search_text_entries' as const, workspaceId: 'content-search-smoke',
  search: () => searchRows, fingerprint: (row: typeof searchRows[number]) => row
};
let searchCursor: string | undefined;
const delivered: number[] = [];
do {
  const page = contentSearchPage({ ...searchOptions, input: searchCursor ? { cursor: searchCursor } : { query: '文本' } });
  delivered.push(...page.matches.map((item) => item.id));
  searchCursor = page.nextCursor;
} while (searchCursor);
assert.deepEqual(delivered, searchRows.map((item) => item.id));
const searchFirst = contentSearchPage({ ...searchOptions, input: { query: '文本' } });
assert.ok(searchFirst.nextCursor);
assert.throws(() => contentSearchPage({ ...searchOptions, input: { cursor: searchFirst.nextCursor, query: 'other' } }), { code: 'SEARCH_CURSOR_SCOPE_MISMATCH' });
searchRows[0]!.text = '变化';
assert.throws(() => contentSearchPage({ ...searchOptions, input: { cursor: searchFirst.nextCursor } }), { code: 'STALE_READ_CURSOR' });
console.log(JSON.stringify({ ok: true, suite: 'content-search', sourcePages: pages, searchRows: delivered.length, checks: ['lossless-source-continuation', 'cursor-scope', 'changed-source', 'unicode-boundaries', 'outer-child-hash-identity', 'lossless-search-pages'] }));
