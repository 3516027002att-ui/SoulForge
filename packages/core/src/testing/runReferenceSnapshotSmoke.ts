import assert from 'node:assert/strict';
import type { SymbolBundle } from '@soulforge/shared';
import { createReferenceQueryService } from '../references/referenceQueryService.js';
import { createReferenceCursorStore } from '../references/referenceCursorStore.js';

const sourceUri = 'file://param/test.parambnd.dcx';
const bundle: SymbolBundle = { params: [
  { paramName: 'Source', sourceUri, entryIndex: 0, rows: [{ uri: `${sourceUri}#Source/1`, sourceUri,
    paramName: 'Source', rowId: 1, raw: { padding: '种子🌱'.repeat(20000), optionalAbsent: undefined }, fields: [
      { fieldId: 'first', name: 'first', value: 2, refsProvenance: 'trusted-metadata', refs: [{ param: 'Target' }] },
      { fieldId: 'second', name: 'second', value: 3, refsProvenance: 'trusted-metadata', refs: [{ param: 'Target' }] }
    ] }] },
  { paramName: 'Target', sourceUri, entryIndex: 1, rows: [2, 3].map(rowId => ({
    uri: `${sourceUri}#Target/${rowId}`, sourceUri, paramName: 'Target', rowId, fields: []
  })) }
] };
const cursorStore = createReferenceCursorStore();
const service = createReferenceQueryService({ bundle, cursorStore });
const first = await service.query({
  uri: `${sourceUri}#Source/1`, direction: 'from', detail: 'context', limit: 1
});
assert.ok(first.page.nextCursor);
const reordered = JSON.parse(JSON.stringify(bundle)) as SymbolBundle;
reordered.params!.reverse();
const second = await createReferenceQueryService({ bundle: reordered, cursorStore }).query({ cursor: first.page.nextCursor });
assert.equal(second.relations.length, 1, 'async cache hydration order must not invalidate the same physical snapshot');
assert.notEqual(first.relations[0]!.to.rowId, second.relations[0]!.to.rowId);
const changed = structuredClone(reordered);
changed.params![1]!.rows[0]!.fields![0]!.value = 99;
await assert.rejects(createReferenceQueryService({ bundle: changed, cursorStore }).query({ cursor: first.page.nextCursor }),
  { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' }, 'real field changes must still invalidate the cursor');
bundle.params![0]!.rows[0]!.fields![0]!.value = 99;
await assert.rejects(service.query({ cursor: first.page.nextCursor }), { code: 'REFERENCE_CURSOR_SCOPE_MISMATCH' },
  'a reused service must fingerprint current input rather than memoize a past bundle');
console.log('reference snapshot ordering and full-content invalidation smoke passed');
