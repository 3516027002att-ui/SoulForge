import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compareMsbLayers, inventoryMsbOmissions, compareMsbIndependentFields } from './compare-msb-independent-fields.mjs';
import { oracleSourcePrerequisites, missingDirectory, missingFile, verificationSkipReason } from '../verification-inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
function fixture() {
  const fields = {
    models: [{ entry: { kind: 'SoulsFormats.MSBS+Model+Enemy', Name: 'c1000', SibPath: 'c1000.sib', Unk1C: 0 } }],
    parts: [{ entry: { kind: 'SoulsFormats.MSBS+Part+Enemy', Name: 'enemy', Position: [1, 2, 3], Rotation: [4, 5, 6], Scale: [1, 1, 1], EntityID: 42, EntityGroupIDs: [8, -1], NPCParamID: 100, ThinkParamID: 200, 'native:ModelIndex': 0 } }],
    regions: [{ entry: { kind: 'SoulsFormats.MSBS+Region+Event', Name: 'duplicated {2}', Position: [7, 8, 9], Rotation: [0, 90, 0], EntityID: 43, Shape: { kind: 'SoulsFormats.MSB+Shape+Box', Width: 11, Depth: 13, Height: 17 }, 'native:ActivationPartIndex': 0 } }],
    events: [{ entry: { kind: 'SoulsFormats.MSBS+Event+Treasure', Name: 'treasure', EventID: 5, EntityID: 44, ItemLotID: 1234 } }],
    routes: []
  };
  const raw = { models: [{ name: 'c1000', offset: 0x80 }], parts: [{ name: 'enemy', offset: 0x100, internalEntryId: 0 }], regions: [{ name: 'duplicated', offset: 0x200, internalEntryId: 0 }], events: [{ name: 'treasure', offset: 0x300 }], routes: [] };
  const bridge = {
    modelCount: 1, partCount: 1, regionCount: 1, eventCount: 1, routeCount: 0,
    models: [{ name: 'c1000', nativeOffset: 0x80, typeId: 2, sibPath: 'c1000.sib' }],
    parts: [{ name: 'enemy', nativeOffset: 0x100, typeId: 2, modelIndex: 0, posX: 1, posY: 2, posZ: 3, rotX: 4, rotY: 5, rotZ: 6, scaleX: 1, scaleY: 1, scaleZ: 1, internalEntryId: 0, entityId: 42 }],
    regions: [{ name: 'duplicated', nativeOffset: 0x200, typeId: 15, shapeType: 5, posX: 7, posY: 8, posZ: 9, rotX: 0, rotY: 90, rotZ: 0, internalEntryId: 0, entityId: 43 }],
    events: [{ name: 'treasure', nativeOffset: 0x300, typeId: 4, eventId: 5 }], routes: []
  };
  return { fields, raw, bridge, core: structuredClone(bridge) };
}

test('independent MSB checks identify the first Bridge or core field divergence', () => {
  const { fields, raw, bridge, core } = fixture();
  const compare = () => compareMsbLayers(fields, raw, bridge, core);
  assert.equal(compare().supportedFieldStatus, 'passed');
  assert.equal(compare().layers.bridge.families.routes.status, 'unverified');
  bridge.regions[0].shapeType = 3;
  let report = compare();
  assert.equal(report.firstDivergentLayer, 'bridge');
  assert.deepEqual(report.layers.bridge.families.regions.checks.shapeType.firstMismatch, { index: 0, expected: 5, actual: 3 });
  bridge.regions[0].shapeType = 5;
  delete core.regions[0].shapeType;
  report = compare();
  assert.equal(report.firstDivergentLayer, 'core');
  assert.equal(report.layers.core.families.regions.checks.shapeType.firstMismatch.actual, null);
  core.regions[0].shapeType = 5;
  core.parts[0].entityId = 0;
  assert.equal(compare().layers.core.families.parts.checks.entityId.status, 'failed');
  bridge.regionCount = 99;
  assert.equal(compare().firstDivergentLayer, 'bridge');
  assert.equal(compare().layers.bridge.families.regions.checks.declaredCount.status, 'failed');
});

test('unrepresented numeric and structural subtype fields remain explicit omissions', () => {
  const { fields } = fixture();
  const omissions = inventoryMsbOmissions(fields);
  assert.deepEqual(omissions.parts.subtypes[0].omittedRoots, ['EntityGroupIDs', 'NPCParamID', 'ThinkParamID']);
  assert.ok(omissions.regions.subtypes[0].omittedRoots.includes('Shape.Depth'));
  assert.ok(omissions.regions.subtypes[0].omittedRoots.includes('native:ActivationPartIndex'));
  assert.ok(omissions.events.subtypes[0].omittedRoots.includes('ItemLotID'));
  assert.deepEqual(omissions.routes.unobservedSubtypes, ['MufflingPortalLink', 'MufflingBoxLink']);
  assert.equal(omissions.parts.coverage, 'partial');
});

const pinnedMsbReason = verificationSkipReason([
  ...oracleSourcePrerequisites(process.env.SOULFORGE_MSB_FIELDS,'SOULFORGE_MSB_FIELDS',oracle=>oracle.source,oracle=>{
    assert.equal(oracle.ok,true); assert.equal(oracle.decoded?.format,'MSBS');
    assert.equal(oracle.oracle?.commit,'ee1dd61958f60bdc51ce3da548e9a90a8ab39905');
  }),
  missingDirectory(process.env.SOULFORGE_MSB_CAPTURE,{kind:'independent-oracle',sourceEnv:'SOULFORGE_MSB_CAPTURE'}),
  missingFile(process.env.SOULFORGE_MSB_PRODUCER,{kind:'published-control',sourceEnv:'SOULFORGE_MSB_PRODUCER'})
]);
test('pinned MSB comparison rejects receipt tampering and localizes receipt-valid corruption', {
  skip: pinnedMsbReason ?? false
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sf-msb-receipts-'));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifestBytes = await readFile(join(process.env.SOULFORGE_MSB_CAPTURE, 'observation-manifest.json'));
  const observationBytes = await readFile(join(process.env.SOULFORGE_MSB_CAPTURE, 'msb.json'));
  const save = async (manifest = JSON.parse(manifestBytes), observation = observationBytes) => {
    await writeFile(join(temporary, 'observation-manifest.json'), JSON.stringify(manifest));
    await writeFile(join(temporary, 'msb.json'), observation);
  };
  const options = {
    oraclePath: resolve(process.env.SOULFORGE_MSB_FIELDS), observationsRoot: temporary,
    producerPath: resolve(process.env.SOULFORGE_MSB_PRODUCER),
    productRoot: resolve(process.env.SOULFORGE_TOOLING_ROOT ?? root),
    localMapperPath: resolve(root, 'packages/core/src/editing/msbBridgeRead.ts')
  };
  const compare = () => compareMsbIndependentFields(options);
  try {
    await save();
    const valid = await compare();
    assert.equal(valid.status, 'partial');
    assert.equal(valid.supportedFieldStatus, 'passed');
    assert.equal(valid.oracleDisplayAliases.length, 2);
    const observation = JSON.parse(observationBytes);
    observation.data.regions[0].shapeType = 99;
    const altered = Buffer.from(JSON.stringify(observation)), manifest = JSON.parse(manifestBytes);
    manifest.observations.find((entry) => entry.name === 'msb.json').sha256 = hash(altered);
    await save(manifest, altered);
    assert.equal((await compare()).firstDivergentLayer, 'bridge');
    await save();
    await writeFile(join(temporary, 'msb.json'), Buffer.concat([observationBytes, Buffer.from(' ')]));
    await assert.rejects(compare(), /MSB_CAPTURE_RECEIPT_MISMATCH/);
    const wrongSource = JSON.parse(manifestBytes);
    wrongSource.observations.find((entry) => entry.name === 'msb.json').sourceSha256 = '0'.repeat(64);
    await save(wrongSource);
    await assert.rejects(compare(), /MSB_CAPTURE_RECEIPT_MISMATCH/);
    const wrongCaptureTool = JSON.parse(manifestBytes); wrongCaptureTool.captureScriptSha256 = '0'.repeat(64);
    await save(wrongCaptureTool);
    await assert.rejects(compare(), /MSB_CAPTURE_TOOL_MISMATCH/);
    await save();
    const fakeProducer = join(temporary, 'wrong-producer'); await writeFile(fakeProducer, 'not the captured executable');
    await assert.rejects(() => compareMsbIndependentFields({ ...options, producerPath: fakeProducer }), /MSB_CAPTURE_PRODUCER_MISMATCH/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
