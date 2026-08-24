import assert from 'node:assert/strict';
import {
  buildCanonicalMapDocument,
  exportMapSceneForBlender,
  importBlenderDeltaToTransaction,
  MapSceneGraph,
  validateMapTransaction,
  type BlenderDeltaImport,
  type MapDocument,
  type MapEditTransaction
} from '@soulforge/shared';

export async function runMapDocument10kScaleSmoke(): Promise<void> {
  console.log('[Smoke] Testing 10k Scale MapDocument & SceneGraph...');

  const totalParts = 8000;
  const totalRegions = 1500;
  const totalEvents = 500;

  const parts = Array.from({ length: totalParts }, (_, i) => ({
    name: `c1050_${i.toString().padStart(4, '0')}`,
    typeId: 0,
    modelIndex: i % 10,
    posX: i * 1.5,
    posY: 0,
    posZ: i * 2.0,
    rotX: 0,
    rotY: (i % 360),
    rotZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    entityId: 100000 + i,
    nativeOffset: 0x1000 + i * 0x80
  }));

  const regions = Array.from({ length: totalRegions }, (_, i) => ({
    name: `Region_${i.toString().padStart(4, '0')}`,
    typeId: 1,
    posX: i * 10,
    posY: 0,
    posZ: i * 10,
    entityId: 200000 + i,
    nativeOffset: 0x500000 + i * 0x40
  }));

  const events = Array.from({ length: totalEvents }, (_, i) => ({
    name: `Event_${i.toString().padStart(4, '0')}`,
    typeId: 2,
    eventId: 300000 + i,
    nativeOffset: 0x600000 + i * 0x30
  }));

  const models = Array.from({ length: 10 }, (_, i) => ({
    name: `m000${i.toString().padStart(3, '0')}`,
    typeId: 0,
    nativeOffset: 0x700000 + i * 0x20
  }));

  const doc = buildCanonicalMapDocument({
    sourceUri: 'game://map/m10_00_00_00.msb.dcx',
    sourcePath: 'map/m10_00_00_00.msb.dcx',
    game: 'sekiro',
    revision: 'rev_10k_init',
    models,
    parts,
    regions,
    events
  });

  assert.equal(doc.parts.length, totalParts, '10k parts must be loaded completely without truncation');
  assert.equal(doc.regions.length, totalRegions, '1500 regions must be loaded');
  assert.equal(doc.events.length, totalEvents, '500 events must be loaded');
  assert.equal(doc.models.length, 10, '10 models must be loaded');
  assert.equal(doc.totalEntityCount, totalParts + totalRegions + totalEvents + 10, 'Total entities must match');

  const graph = new MapSceneGraph(doc);

  // Test query parts sharing model
  const partsWithModel0 = graph.queryPartsByModel('m000000');
  assert.equal(partsWithModel0.length, totalParts / 10, 'Parts sharing model m000000 must match');
  assert.equal(partsWithModel0[0]?.modelName, 'm000000');

  // Test find entity by stableKey and address
  const firstPart = doc.parts[0]!;
  assert.equal(graph.findEntity(firstPart.stableKey), firstPart);
  assert.equal(graph.findEntity(firstPart.address), firstPart);

  console.log('[Smoke] Testing validateMapTransaction...');
  const validTx: MapEditTransaction = {
    id: 'tx-1',
    mapId: 'm10_00_00_00',
    baseRevision: 'rev_10k_init',
    description: 'Move part',
    author: 'agent',
    operations: [
      { kind: 'set_transform', target: firstPart.stableKey, position: [15, 0, 15] }
    ],
    timestamp: Date.now()
  };
  const validResult = validateMapTransaction(doc, validTx);
  assert.equal(validResult.valid, true, 'Valid transaction must pass validation');

  // Test invalid target transaction
  const invalidTx: MapEditTransaction = {
    id: 'tx-2',
    mapId: 'm10_00_00_00',
    baseRevision: 'rev_10k_init',
    description: 'Move non-existent part',
    author: 'agent',
    operations: [
      { kind: 'set_transform', target: 'part:non_existent', position: [0, 0, 0] }
    ],
    timestamp: Date.now()
  };
  const invalidResult = validateMapTransaction(doc, invalidTx);
  assert.equal(invalidResult.valid, false, 'Invalid transaction must be rejected');
  assert.equal(invalidResult.diagnostics[0]?.code, 'MAP_ENTITY_NOT_FOUND');

  console.log('[Smoke] Testing Blender export & import round-trip...');
  const exported = exportMapSceneForBlender(doc);
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.mapId, 'm10_00_00_00');
  assert.equal(exported.revision, 'rev_10k_init');
  assert.equal(exported.objects.length, totalParts + totalRegions);

  const delta: BlenderDeltaImport = {
    schemaVersion: 1,
    mapId: 'm10_00_00_00',
    baseRevision: 'rev_10k_init',
    importedAt: new Date().toISOString(),
    mutations: [
      {
        stableKey: firstPart.stableKey,
        action: 'modify',
        position: [120, 10, -30],
        rotation: [0, 180, 0]
      }
    ]
  };

  const importResult = importBlenderDeltaToTransaction(doc, delta);
  assert.equal(importResult.ok, true, 'Blender import must succeed for matching revision');
  if (importResult.ok) {
    assert.equal(importResult.transaction.author, 'blender');
    assert.equal(importResult.transaction.operations.length, 1);
  }

  // Test template-backed duplicate translation and malformed-name refusal.
  const duplicateDelta: BlenderDeltaImport = {
    schemaVersion: 1,
    mapId: 'm10_00_00_00',
    baseRevision: 'rev_10k_init',
    importedAt: new Date().toISOString(),
    mutations: [
      {
        stableKey: firstPart.stableKey,
        action: 'duplicate',
        name: 'm10_template_duplicate',
        position: [200, 10, -30]
      }
    ]
  };
  const duplicateResult = importBlenderDeltaToTransaction(doc, duplicateDelta);
  assert.equal(duplicateResult.ok, true, 'Template-backed Part duplicate must translate to a MapEditTransaction');
  if (duplicateResult.ok) {
    assert.equal(duplicateResult.transaction.operations[0]?.kind, 'duplicate');
  }
  const malformedDuplicate = importBlenderDeltaToTransaction(doc, {
    ...duplicateDelta,
    mutations: [{ stableKey: firstPart.stableKey, action: 'duplicate' }]
  });
  assert.equal(malformedDuplicate.ok, false, 'Duplicate without a new name must be rejected');
  if (!malformedDuplicate.ok) {
    assert.match(malformedDuplicate.error, /MAP_DUPLICATE_NAME_REQUIRED/);
  }

  // Test multi-op batch transaction validation (Section 3: single batch atomic commit)
  const batchTx: MapEditTransaction = {
    id: 'tx-batch-1',
    mapId: 'm10_00_00_00',
    baseRevision: 'rev_10k_init',
    description: 'Batch edit multiple parts and regions',
    author: 'human',
    operations: [
      { kind: 'set_transform', target: doc.parts[0]!.stableKey, position: [10, 20, 30] },
      { kind: 'set_transform', target: doc.parts[1]!.stableKey, rotation: [0, 90, 0] },
      { kind: 'set_transform', target: doc.regions[0]!.stableKey, position: [100, 0, 100] },
      { kind: 'change_model', target: doc.parts[2]!.stableKey, newModelName: 'm000001' },
      { kind: 'delete', target: doc.parts[3]!.stableKey }
    ],
    timestamp: Date.now()
  };
  const batchValidation = validateMapTransaction(doc, batchTx);
  assert.equal(batchValidation.valid, true, 'Batch transaction with 5 diverse operations must pass validation');

  console.log('[Smoke] 10k Scale MapDocument & SceneGraph Smoke PASSED.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('runMapDocument10kScaleSmoke.js')) {
  runMapDocument10kScaleSmoke().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
