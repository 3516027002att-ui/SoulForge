import assert from 'node:assert/strict';
import {
  buildParamTextReferenceEdges,
  createParamTextFieldClassifier,
  isParamTextReferenceField
} from '../references/paramTextReferences.js';
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

const rawSchemaClassifier = createParamTextFieldClassifier([
  field({ fieldId: 'schema-field', description: 'raw numeric value' })
]);
assert.equal(
  rawSchemaClassifier.isTextReferenceField(field({ fieldId: 'schema-field', description: 'raw numeric value' })),
  false,
  'precompiled schema classifier must preserve the original negative classification'
);
const changedSchemaClassifier = createParamTextFieldClassifier([
  field({ fieldId: 'schema-field', description: 'localized text id' })
]);
assert.equal(
  changedSchemaClassifier.isTextReferenceField(field({ fieldId: 'schema-field', description: 'localized text id' })),
  true,
  'a schema description change must invalidate the previous field classification'
);

const edgeParams = [{
  rows: [{
    uri: 'param://Synthetic/1',
    sourceUri: 'file:///synthetic/gameparam.parambnd.dcx',
    paramName: 'SyntheticParam',
    rowId: 1,
    fields: [field({ fieldId: 'textId', name: 'textId', value: 77 })]
  }]
}];
const edgeMsgs = [{
  category: 'SyntheticText',
  entries: [
    {
      uri: 'file:///synthetic/SyntheticText.fmg#77',
      sourceUri: 'file:///synthetic/SyntheticText.fmg',
      textId: 77,
      text: 'synthetic text'
    },
    {
      uri: 'file:///synthetic/SyntheticText.fmg#78',
      sourceUri: 'file:///synthetic/SyntheticText.fmg',
      textId: 78,
      text: 'synthetic text 78'
    }
  ]
}];
const firstEdges = buildParamTextReferenceEdges(edgeParams, edgeMsgs);
const secondEdges = buildParamTextReferenceEdges(edgeParams, edgeMsgs);
assert.equal(firstEdges.length, 1);
assert.equal(
  secondEdges,
  firstEdges,
  'unchanged PARAM/MSG snapshots must reuse the prepared text-reference edge array'
);
edgeParams[0]!.rows[0]!.fields![0]!.value = 78;
const changedFieldEdges = buildParamTextReferenceEdges(edgeParams, edgeMsgs);
assert.equal(changedFieldEdges[0]?.toUri, 'file:///synthetic/SyntheticText.fmg#78');
edgeMsgs[0]!.entries[1]!.textId = 79;
edgeMsgs[0]!.entries[1]!.text = 'mutated synthetic text';
const changedMsgEdges = buildParamTextReferenceEdges(edgeParams, edgeMsgs);
assert.equal(changedMsgEdges.length, 0, 'in-place MSG mutation must invalidate the prepared edge snapshot');
edgeMsgs[0]!.entries.push({
  uri: 'file:///synthetic/SyntheticText.fmg#78-new',
  sourceUri: 'file:///synthetic/SyntheticText.fmg',
  textId: 78,
  text: 're-added synthetic text 78'
});
edgeParams.push({
  rows: [{
    uri: 'param://Synthetic/2',
    sourceUri: 'file:///synthetic/gameparam.parambnd.dcx',
    paramName: 'SyntheticParam',
    rowId: 2,
    fields: [field({ fieldId: 'textId', name: 'textId', value: 77 })]
  }]
});
const changedArrayEdges = buildParamTextReferenceEdges(edgeParams, edgeMsgs);
assert.equal(changedArrayEdges.length, 2, 'in-place export array mutation must invalidate the prepared edge snapshot');

console.log('runParamTextReferenceCacheSmoke: PASS');
