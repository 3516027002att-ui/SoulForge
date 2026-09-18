import assert from 'node:assert/strict';
import { isParamTextReferenceField } from '../references/paramTextReferences.js';
import type { ParamFieldSymbol } from '@soulforge/shared';

function field(overrides: Partial<ParamFieldSymbol> = {}): ParamFieldSymbol {
  return {
    fieldId: 'shared-field-id',
    name: 'value',
    type: 's32',
    description: 'raw numeric value',
    refsProvenance: 'unknown',
    value: 1,
    ...overrides
  };
}

assert.equal(isParamTextReferenceField(field()), false);
assert.equal(
  isParamTextReferenceField(field({ description: 'localized text id' })),
  true,
  'same fieldId/name with a different description must not reuse the negative cache entry'
);
assert.equal(
  isParamTextReferenceField(field({ description: 'raw numeric value', type: 'f32' })),
  false,
  'same fieldId/name with a different type remains independently classified'
);

for (let index = 0; index < 5_000; index += 1) {
  isParamTextReferenceField(field({
    fieldId: `field-${index}`,
    description: index % 2 === 0 ? 'localized text id' : 'raw numeric value'
  }));
}
assert.equal(isParamTextReferenceField(field({ description: 'localized text id' })), true);

console.log('runParamTextReferenceCacheSmoke: PASS');
