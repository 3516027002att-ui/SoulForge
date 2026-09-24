/**
 * Runtime regression for the bounded native PARAM row decoder.
 *
 * This intentionally stays below the Bridge boundary: the optimized loop is
 * fed a multi-row native-shaped envelope so output equivalence and mid-batch
 * AbortController cancellation are exercised without requiring a game install
 * or synthetic binary parser authority.
 */
import assert from 'node:assert/strict';
import type { MsgExport, ParamDefDocument, ParamRowSymbol } from '@soulforge/shared';
import { decodeRowFields } from '../param/paramdefLayout.js';
import { decodeNativeParamRows } from '../indexing/nativeSemanticRefresh.js';
import { buildParamTextReferenceEdges } from '../references/paramTextReferences.js';

const definition: ParamDefDocument = {
  schemaVersion: 1,
  typeName: 'SYNTHETIC_PARAM_ST',
  version: 1,
  rowDataSize: 16,
  origin: 'fixture',
  fields: [
    { id: 'id', name: 'id', type: 's32', offset: 0, size: 4 },
    { id: 'hp', name: 'hp', type: 'u16', offset: 4, size: 2, description: 'fixture hp' },
    { id: 'rate', name: 'rate', type: 'f32', offset: 8, size: 4 }
  ]
};

const file = {
  sourceUri: 'file:///fixture/param/gameparam.parambnd.dcx',
  sha256: 'fixture-source-hash',
  mtimeMs: 123
} as const;

const nativeRows = Array.from({ length: 130 }, (_, index) => {
  const bytes = Buffer.alloc(definition.rowDataSize);
  bytes.writeInt32LE(10_000 + index, 0);
  bytes.writeUInt16LE(100 + index, 4);
  bytes.writeFloatLE(1.5 + index / 10, 8);
  return {
    id: 10_000 + index,
    name: `row-${index}`,
    dataBase64: bytes.toString('base64'),
    dataHash: `hash-${index}`
  };
});

function legacyDecode(): ParamRowSymbol[] {
  const fieldsById = new Map(definition.fields.map((field) => [field.id, field]));
  return nativeRows.map((record) => {
    const bytes = Buffer.from(record.dataBase64, 'base64');
    const fields = decodeRowFields(bytes, definition).map((field) => {
      const definitionField = fieldsById.get(field.fieldId);
      return {
        fieldId: field.fieldId,
        name: field.name,
        type: field.type,
        ...(definitionField?.description ? { description: definitionField.description } : {}),
        value: field.value
      };
    });
    return {
      uri: `${file.sourceUri}#SyntheticParam/${record.id}`,
      sourceUri: file.sourceUri,
      paramName: 'SyntheticParam',
      entryName: 'SyntheticParam.param',
      entryIndex: 3,
      rowId: record.id,
      rowName: record.name,
      sourceHash: file.sha256,
      outerFileHash: file.sha256,
      sourceRevision: file.mtimeMs,
      fields,
      raw: { typeName: definition.typeName, dataHash: record.dataHash }
    };
  });
}

async function main(): Promise<void> {
  const expected = legacyDecode();
  const actual = await decodeNativeParamRows({
    file,
    tableName: 'SyntheticParam',
    entryName: 'SyntheticParam.param',
    entryIndex: 3,
    typeName: definition.typeName,
    definition,
    rows: nativeRows
  });
  assert.deepEqual(actual, expected, 'bounded decoder changed the semantic row projection');
  assert.equal(actual.length, 130);
  const probe = actual[64];
  assert.ok(probe);
  assert.equal(probe.fields?.find((field) => field.fieldId === 'hp')?.value, 164);

  const explicitDomains = await decodeNativeParamRows({
    file,
    sourceHash: 'native-child-hash',
    outerFileHash: 'packed-outer-hash',
    tableName: 'SyntheticParam',
    entryName: 'SyntheticParam.param',
    entryIndex: 3,
    typeName: definition.typeName,
    definition,
    rows: nativeRows.slice(0, 2)
  });
  assert.equal(explicitDomains.length, 2);
  for (const row of explicitDomains) {
    assert.equal(row.sourceHash, 'native-child-hash');
    assert.equal(row.outerFileHash, 'packed-outer-hash');
    assert.notEqual(row.sourceHash, row.outerFileHash);
  }

  let unrelatedDecodeCount = 0;
  const unrelatedField = {
    id: 'unrelated',
    name: 'unrelated',
    type: 'u32' as const,
    offset: 0,
    size: 4
  };
  Object.defineProperty(unrelatedField, 'type', {
    enumerable: true,
    get() {
      return 'u32';
    }
  });
  Object.defineProperty(unrelatedField, 'offset', {
    enumerable: true,
    get() {
      unrelatedDecodeCount += 1;
      return 0;
    }
  });
  const referenceDefinition: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'REFERENCE_ONLY_PARAM_ST',
    version: 1,
    rowDataSize: 16,
    origin: 'fixture',
    fields: [
      unrelatedField as ParamDefDocument['fields'][number],
      { id: 'refId', name: 'refId', type: 'u32', offset: 4, size: 4, refs: 'TargetParam(refType=1)' },
      { id: 'refType', name: 'refType', type: 'u8', offset: 8, size: 1 },
      { id: 'textId', name: 'textId', type: 'u16', offset: 9, size: 2 },
      {
        id: 'bitRefId',
        name: 'bitRefId',
        type: 'u8',
        offset: 11,
        size: 1,
        bitfield: { bitOffset: 1, bitWidth: 3 },
        refs: 'TargetParam(refType=1)'
      },
      { id: 'padding', name: 'padding', type: 'bytes', offset: 12, size: 4 }
    ]
  };
  const referenceBytes = Buffer.alloc(referenceDefinition.rowDataSize);
  referenceBytes.writeUInt32LE(42, 4);
  referenceBytes.writeUInt8(1, 8);
  referenceBytes.writeUInt16LE(77, 9);
  referenceBytes.writeUInt8(0b00001010, 11);
  const referenceRows = [{ id: 7, dataBase64: referenceBytes.toString('base64') }];
  unrelatedDecodeCount = 0;
  const referenceOnly = await decodeNativeParamRows({
    file,
    sourceHash: 'native-child-hash',
    outerFileHash: 'packed-outer-hash',
    tableName: 'ReferenceOnlyParam',
    entryName: 'ReferenceOnlyParam.param',
    entryIndex: 4,
    typeName: referenceDefinition.typeName,
    definition: referenceDefinition,
    rows: referenceRows,
    referenceFieldsOnly: true
  });
  assert.deepEqual(
    referenceOnly[0]?.fields?.map((field) => field.fieldId),
    ['refId', 'refType', 'textId', 'bitRefId'],
    'reference-only projection must include refs, condition siblings, text-id fields, and bitfields, but no unrelated fields'
  );
  assert.equal(referenceOnly[0]?.fields?.find((field) => field.fieldId === 'refId')?.value, 42);
  assert.equal(referenceOnly[0]?.fields?.find((field) => field.fieldId === 'refType')?.value, 1);
  assert.equal(
    referenceOnly[0]?.fields?.find((field) => field.fieldId === 'textId')?.value,
    77,
    'reference-only projection must preserve a no-refs textId field'
  );
  assert.equal(
    referenceOnly[0]?.fields?.find((field) => field.fieldId === 'bitRefId')?.value,
    5,
    'reference-only projection must preserve native bitfield decoding'
  );
  assert.equal(
    unrelatedDecodeCount,
    0,
    'reference-only projection must not decode unrelated wide-row fields'
  );
  assert.equal(referenceOnly[0]?.sourceHash, 'native-child-hash');
  assert.equal(referenceOnly[0]?.outerFileHash, 'packed-outer-hash');
  assert.equal(referenceOnly[0]?.sourceRevision, file.mtimeMs);

  const syntheticMsg: MsgExport = {
    category: 'SyntheticText',
    entries: [{
      uri: 'file:///fixture/msg/SyntheticText.fmg#77',
      sourceUri: 'file:///fixture/msg/SyntheticText.fmg',
      textId: 77,
      text: 'Synthetic localized text',
      confidence: 'high'
    }]
  };
  const textEdges = buildParamTextReferenceEdges([{ rows: referenceOnly }], [syntheticMsg]);
  assert.equal(textEdges.length, 1, 'no-refs textId must produce a PARAM↔FMG edge');
  assert.equal(textEdges[0]?.kind, 'references_text');
  assert.equal(textEdges[0]?.toUri, syntheticMsg.entries[0]?.uri);

  const controller = new AbortController();
  let abortScheduled = false;
  const cancelled = decodeNativeParamRows({
    file,
    tableName: 'SyntheticParam',
    entryName: 'SyntheticParam.param',
    entryIndex: 3,
    typeName: definition.typeName,
    definition,
    rows: nativeRows,
    signal: controller.signal
  });
  setImmediate(() => {
    abortScheduled = true;
    controller.abort('mid-batch-fixture-cancel');
  });
  await assert.rejects(cancelled, /native semantic refresh aborted/);
  assert.equal(abortScheduled, true, 'cancellation was not scheduled after the decoder yielded');

  console.log(JSON.stringify({
    ok: true,
    checks: 5,
    rows: actual.length,
    cancellation: 'mid-batch rejected with structured abort error',
    message: 'native PARAM semantic row decoder smoke passed'
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
