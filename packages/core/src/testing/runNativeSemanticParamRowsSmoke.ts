/**
 * Runtime regression for the bounded native PARAM row decoder.
 *
 * This intentionally stays below the Bridge boundary: the optimized loop is
 * fed a multi-row native-shaped envelope so output equivalence and mid-batch
 * AbortController cancellation are exercised without requiring a game install
 * or synthetic binary parser authority.
 */
import assert from 'node:assert/strict';
import type { ParamDefDocument, ParamRowSymbol } from '@soulforge/shared';
import { decodeRowFields } from '../param/paramdefLayout.js';
import { decodeNativeParamRows } from '../indexing/nativeSemanticRefresh.js';

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
