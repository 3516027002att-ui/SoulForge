/** SoulForge first-party TAE registry projection tests. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeTaeParamFields,
  getTaeTemplateCatalog,
  taeEventTypeLabel
} from './taeTemplateCatalog.js';

describe('first-party TAE catalog', () => {
  it('exposes the versioned registry without an external template path', () => {
    const catalog = getTaeTemplateCatalog();
    assert.equal(catalog.origin, 'first-party');
    assert.equal(catalog.package, 'soulforge-sekiro-tae-schema');
    assert.match(catalog.contentDigest, /^sha256:[0-9a-f]{64}$/);
    assert.ok(catalog.events.size > 0);
    assert.ok(catalog.variants.size > 0);
    assert.ok(catalog.events.has(0));
  });

  it('projects field layout and enum names from the built-in schema', () => {
    const catalog = getTaeTemplateCatalog();
    const jumpTable = catalog.events.get(0)!;
    assert.equal(jumpTable.name, 'JumpTable');
    assert.equal(jumpTable.paramSize, 16);
    assert.ok(jumpTable.fields.length > 0);
    assert.ok(jumpTable.fields.some((field) => field.entries && field.entries.length > 0));

    const hex = '09000000' + '00' + '000000' + '00000000' + '00000000';
    const fields = decodeTaeParamFields(jumpTable, hex)!;
    assert.ok(fields.length > 0);
    assert.equal(fields[0]!.value, '9: InvokeAnimCancelStart_Guard');
  });

  it('renders a deterministic first-party fallback for an unknown event id', () => {
    const catalog = getTaeTemplateCatalog();
    assert.equal(taeEventTypeLabel(catalog, 999999), '未命名');
  });
});
