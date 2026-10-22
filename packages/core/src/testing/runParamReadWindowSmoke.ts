import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpaqueCursor, parseOpaqueCursor } from '@soulforge/shared';
import { expandParamFieldQuery } from '../param/containerParamEdit.js';
import { paramContainerRecoveryUri, paramReadCoverage, paramReadSourceHash, paramReadWindow } from '../param/paramReadWindow.js';

const fixtureRoot = join(tmpdir(), 'soulforge-param-read-window-fixture');
const overlayRoot = join(fixtureRoot, 'mods');
assert.equal(
  paramContainerRecoveryUri(overlayRoot, join(overlayRoot, 'param', 'gameparam', 'gameparam.parambnd.dcx')),
  'file://param/gameparam/gameparam.parambnd.dcx'
);
assert.equal(paramContainerRecoveryUri(overlayRoot, join(fixtureRoot, 'outside', 'gameparam.parambnd.dcx')), undefined);
assert.equal(paramContainerRecoveryUri(overlayRoot, join(fixtureRoot, 'mods-other', 'gameparam.parambnd.dcx')), undefined);
assert.ok(expandParamFieldQuery('ninsatsuNum').includes('ninsatu'), 'near-name recovery must surface the trusted field ID spelling');

assert.deepEqual(paramReadCoverage({ missingRows: 0, missingFields: 0, hasMore: false }), {
  complete: true, status: 'complete'
});
for (const incomplete of [
  { missingRows: 1, missingFields: 0, hasMore: false },
  { missingRows: 0, missingFields: 1, hasMore: false },
  { missingRows: 0, missingFields: 0, hasMore: true }
]) {
  assert.deepEqual(paramReadCoverage(incomplete), { complete: false, status: 'partial' });
}

const cells = Array.from({ length: 20 }, (_, index) => ({ table: 'SpEffectParam', fieldId: `field${index}` }));
const versions = [{ table: 'A', entryIndex: 1, sourceHash: 'a' }, { table: 'B', entryIndex: 2, sourceHash: 'b' }];
assert.notEqual(paramReadSourceHash(versions), paramReadSourceHash(versions.map((v) => ({ ...v, sourceHash: v.sourceHash === 'a' ? 'b' : 'a' }))));
assert.equal(paramReadSourceHash(versions), paramReadSourceHash([...versions].reverse()));
assert.equal(paramReadSourceHash([versions[0]!]), 'a');
assert.throws(() => paramReadSourceHash([versions[0]!, { ...versions[0]!, sourceHash: 'other' }]), { code: 'PARAM_SOURCE_CHANGED_DURING_READ' });
const definitions = new Map(cells.map((cell) => [`${cell.table}\0${cell.fieldId}`, { fieldId: cell.fieldId, description: 'full metadata'.repeat(20) }]));
const legacyScope = `param-fields:file:///C:/private/container:workspace:${'long-field-scope'.repeat(1000)}`;
const input = { cells, definitions, legacyScope, sourceHash: 'a'.repeat(64), pageSize: 4,
  cellIdentity: (cell: typeof cells[number]) => [cell.table, cell.fieldId] };
let page = paramReadWindow(input);
assert.equal(page.items.length, 4);
assert.equal(page.fieldDefinitions.length, 4);
assert.ok(page.nextCursor && page.nextCursor.length < 400);
assert.ok(!page.queryScope.includes('private'));
const cursor = page.nextCursor!;
const delivered = [...page.items];
while (page.nextCursor) {
  page = paramReadWindow({ ...input, cursor: page.nextCursor });
  assert.deepEqual(page.fieldDefinitions.map((d) => d.fieldId), page.items.map((i) => i.fieldId));
  delivered.push(...page.items);
}
assert.deepEqual(delivered, cells);
assert.throws(() => paramReadWindow({ ...input, cursor, sourceHash: 'b'.repeat(64) }), { code: 'STALE_READ_CURSOR' });
assert.throws(() => paramReadWindow({ ...input, cursor, legacyScope: legacyScope + 'other-workspace' }), { code: 'PARAM_CURSOR_SCOPE_MISMATCH' });
assert.throws(() => paramReadWindow({ ...input, cursor, cells: [...cells].reverse() }), { code: 'PARAM_CURSOR_SCOPE_MISMATCH' });
assert.equal(paramReadWindow({ ...input, cursor, pageSize: 1 }).items[0]?.fieldId, 'field4');
const legacy = createOpaqueCursor({ sessionId: 'old-process-session', domain: 'param', sourceHash: input.sourceHash, scope: legacyScope, offset: 4 });
const migrated = paramReadWindow({ ...input, cursor: legacy });
assert.equal(migrated.offset, 4);
assert.ok(migrated.nextCursor && migrated.nextCursor.length < 400);
assert.equal(parseOpaqueCursor(migrated.nextCursor!).sessionId, 'param-fields-v2');
console.log('PARAM bounded cursor and per-page definitions smoke passed.');
