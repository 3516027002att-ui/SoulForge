import assert from 'node:assert/strict';
import type { EmevdEditorDocument } from '@soulforge/shared';
import { indexDocumentSymbols } from '../emevd/language-service/eventSymbolIndexer.js';
import { encodeInstructionArgs } from '../emevd/emedfSchema.js';
import { loadFirstPartyEmedfRegistry } from '../schema/sekiro/firstPartySchema.js';
import { documentToNativeEventExport } from '../references/nativeReferenceContent.js';
import { buildEventReferenceEdges } from '../references/eventReferenceProvider.js';
import { matchEmevdRoleRule } from '../references/emevdRoleRules.js';

function testCommonEventReferencePosition(): void {
  const indexed = indexDocumentSymbols(`$Event(1, Default, function() {
  InitializeCommonEvent(123456, 90017000);
  InitializeEvent(0, 234567, 0);
});`);
  assert.deepEqual(
    indexed.references.map((reference) => reference.targetEventId),
    [123456, 234567],
    'InitializeCommonEvent must use its first argument as eventId'
  );
}

function makeDocument(argsBase64: string): EmevdEditorDocument {
  return {
    schemaVersion: 1,
    resourceUri: 'file://synthetic/common.emevd.dcx',
    revision: 1,
    bytesBase64: '',
    diagnostics: [],
    events: [{
      eventUri: 'file://synthetic/common.emevd.dcx#event/1000',
      eventId: 1000,
      restBehavior: 0,
      layer: -1,
      instructions: [{
        instructionUri: 'file://synthetic/common.emevd.dcx#event/1000/instruction/0',
        bank: 2003,
        id: 4,
        argsBase64,
        unknown: false
      }]
    }]
  };
}

function testAwardItemLotScopedReference(): void {
  const loaded = loadFirstPartyEmedfRegistry();
  assert.equal(loaded.ok, true, 'first-party EMEDF registry must load');
  if (!loaded.ok) return;
  const registry = loaded.registry;
  const rule = matchEmevdRoleRule(registry, 2003, 4, 0);
  assert.equal(rule?.instructionName, 'AwardItemLot');
  assert.equal(rule?.argName, 'itemLotId');
  assert.equal((rule as { targetParamName?: string } | undefined)?.targetParamName, 'ItemLotParam');

  const encoded = encodeInstructionArgs(registry, 2003, 4, { itemLotId: 90017000 });
  assert.equal(encoded.ok, true, 'AwardItemLot argument must encode');
  if (!encoded.ok) return;
  const exported = documentToNativeEventExport({
    sourceUri: 'file://synthetic/common.emevd.dcx',
    sourceHash: 'synthetic-source',
    outerFileHash: 'synthetic-outer',
    sourceRevision: 1,
    document: makeDocument(encoded.args.toString('base64')),
    registry
  });
  const arg = exported.events[0]?.instructions[0]?.args[0];
  assert.equal(arg?.value, 90017000);
  assert.equal(arg?.role, 'paramId');
  assert.equal(arg?.paramName, 'ItemLotParam');

  const unscoped = structuredClone(exported);
  delete unscoped.events[0]!.instructions[0]!.args[0]!.paramName;
  const graph = buildEventReferenceEdges([unscoped], {
    mapEntitiesByEntityId: new Map(),
    paramRowsById: new Map([[90017000, [
      { uri: 'param://NpcParam/90017000' },
      { uri: 'param://ItemLotParam/90017000' }
    ]]]),
    paramRowsByScopedId: new Map([
      ['npcparam#90017000', [{ uri: 'param://NpcParam/90017000' }]],
      ['itemlotparam#90017000', [{ uri: 'param://ItemLotParam/90017000' }]]
    ]),
    textsById: new Map()
  }, { registry });
  assert.deepEqual(
    graph.edges.map((edge) => edge.toUri),
    ['param://ItemLotParam/90017000'],
    'AwardItemLot must not fan out to unrelated parameter tables'
  );
}

function main(): void {
  testCommonEventReferencePosition();
  testAwardItemLotScopedReference();
  console.log(JSON.stringify({
    ok: true,
    message: 'deterministic EMEVD reference smoke passed'
  }, null, 2));
}

main();
