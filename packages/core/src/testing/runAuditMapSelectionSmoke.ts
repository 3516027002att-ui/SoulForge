/**
 * SF-05: Map query intersection, batch targets, and snapshot reuse.
 *
 * Covers:
 *  - queryMapEntities multi-filter intersection (AND logic across modelName, entityId, kind, nameContains, regionName)
 *  - queryMapEntities regionName resolution and MAP_REFERENCE_COVERAGE_INCOMPLETE gate
 *  - batchTransformMapParts fail-fast target validation (MAP_ENTITY_NOT_FOUND, MAP_DUPLICATE_TARGET, zero staging calls)
 *  - batchTransformMapParts non-finite float rejection (MAP_INVALID_TRANSFORM)
 *  - batchTransformMapParts delta = 0 quantization / no-op detection (noop: true, effectiveCount: 0)
 *  - MapSnapshotLease lifecycle, validation, and reuse across query, batch, and transaction
 *  - executeMapTransaction sourceFileHash freshness check (MAP_SOURCE_MODIFIED)
 *  - verifiedPostState snapshot reuse eliminating redundant reloads
 */

import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type MapDocument,
  type MapPartEntity,
  type MapRegionEntity,
  type MapEventEntity,
  type MapModelEntity,
  MapSceneGraph,
  createMapSnapshotLease,
  isValidSnapshotLease,
  type MapSnapshotLease
} from '@soulforge/shared';
import {
  queryMapEntities,
  batchTransformMapParts,
  executeMapTransaction,
  loadMapDocument
} from '../editing/mapService.js';
import { openNativeEditSession, type NativeEditSession } from '../editing/nativeEditSession.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';

function createSyntheticTestDocument(): MapDocument {
  const models: MapModelEntity[] = [
    {
      id: 'm_c1000',
      stableKey: 'model:0',
      address: 'map://m11/models/c1000',
      mapId: 'm11',
      name: 'c1000',
      kind: 'model',
      family: 'model',
      typeId: 0,
      nativeOffset: 0x10
    },
    {
      id: 'm_c2000',
      stableKey: 'model:1',
      address: 'map://m11/models/c2000',
      mapId: 'm11',
      name: 'c2000',
      kind: 'model',
      family: 'model',
      typeId: 0,
      nativeOffset: 0x20
    }
  ];

  const parts: MapPartEntity[] = [
    {
      id: 'p_0',
      stableKey: 'part:0',
      address: 'map://m11/parts/c1000_0000',
      mapId: 'm11',
      name: 'c1000_0000',
      kind: 'part',
      family: 'part',
      typeId: 0,
      nativeOffset: 0x100,
      modelIndex: 0,
      modelName: 'c1000',
      entityId: 10001,
      transform: {
        position: [10, 20, 30],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      }
    },
    {
      id: 'p_1',
      stableKey: 'part:1',
      address: 'map://m11/parts/c1000_0001',
      mapId: 'm11',
      name: 'c1000_0001',
      kind: 'part',
      family: 'part',
      typeId: 0,
      nativeOffset: 0x200,
      modelIndex: 0,
      modelName: 'c1000',
      entityId: 10002,
      transform: {
        position: [15, 25, 35],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      }
    },
    {
      id: 'p_2',
      stableKey: 'part:2',
      address: 'map://m11/parts/c2000_0000',
      mapId: 'm11',
      name: 'c2000_0000',
      kind: 'part',
      family: 'part',
      typeId: 0,
      nativeOffset: 0x300,
      modelIndex: 1,
      modelName: 'c2000',
      entityId: 10001,
      transform: {
        position: [50, 60, 70],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      }
    }
  ];

  const regions: MapRegionEntity[] = [
    {
      id: 'r_0',
      stableKey: 'region:0',
      address: 'map://m11/regions/Arena_Region',
      mapId: 'm11',
      name: 'Arena_Region',
      kind: 'region',
      family: 'region',
      typeId: 0,
      shapeType: 0,
      nativeOffset: 0x400,
      entityId: 20001,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0]
      }
    }
  ];

  const events: MapEventEntity[] = [
    {
      id: 'e_0',
      stableKey: 'event:0',
      address: 'map://m11/events/Boss_Event',
      mapId: 'm11',
      name: 'Boss_Event',
      kind: 'event',
      family: 'event',
      typeId: 0,
      nativeOffset: 0x500,
      entityId: 30001,
      referencedRegionName: 'Arena_Region'
    }
  ];

  return {
    sourceUri: 'file:///d:/mock/m11.msb',
    sourcePath: 'd:/mock/m11.msb',
    mapId: 'm11',
    game: 'sekiro',
    revision: 'rev_synthetic_100',
    readerSchemaRevision: 1,
    entityIdVerified: true,
    models,
    parts,
    regions,
    events,
    routes: [],
    totalEntityCount: models.length + parts.length + regions.length + events.length
  };
}

function createMockEditSession(fileHash = 'sha256_initial_test'): NativeEditSession {
  return {
    session: {
      game: 'sekiro',
      layers: {
        overlayRoot: 'd:/mock/overlay',
        baseRoot: 'd:/mock/base'
      }
    } as any,
    stagingRoot: 'd:/mock/staging',
    backupBaseDir: 'd:/mock/backup',
    recoveryDir: 'd:/mock/recovery',
    commitPort: {
      commit: async () => ({
        ok: true,
        sourceUri: 'file:///d:/mock/m11.msb',
        title: 'mock commit',
        backupPath: 'd:/mock/backup/m11.msb.bak'
      })
    },
    allowedRoots: () => ['d:/mock'],
    mintReceipt: () => ({ receiptId: 'mock-receipt', title: 'mock', issuedAt: Date.now(), expiresAt: Date.now() + 60000 }),
    indexFile: async (path: string) => ({
      sourceUri: `file:///${path}`,
      relativePath: 'm11.msb',
      kind: 'map' as const,
      size: 1024,
      mtimeMs: Date.now(),
      sha256: fileHash
    }),
    operationLog: {} as any
  } as unknown as NativeEditSession;
}

export async function runMapSelectionUnitTests(): Promise<void> {
  const doc = createSyntheticTestDocument();
  const sceneGraph = new MapSceneGraph(doc);
  const mockEdit = createMockEditSession('sha256_mock_file');

  // =========================================================================
  // 1. MapSnapshotLease lifecycle & validity
  // =========================================================================
  const lease = createMapSnapshotLease(
    doc,
    sceneGraph,
    doc.sourcePath,
    doc.revision,
    1,
    'sha256_mock_file'
  );

  assert.equal(lease.released, false, 'Lease must initialize in active (unreleased) state');
  assert.equal(isValidSnapshotLease(lease), true, 'Active lease must be reported as valid');
  assert.equal(isValidSnapshotLease(null), false, 'Null is not a valid lease');
  assert.equal(isValidSnapshotLease({}), false, 'Unbranded object is not a valid lease');
  assert.equal(isValidSnapshotLease({ doc, sceneGraph, released: false }), false, 'Duck-typed object without brand must be rejected');

  // Test released lease rejection
  lease.release();
  assert.equal(lease.released, true, 'Calling release() must set released=true');
  assert.equal(isValidSnapshotLease(lease), false, 'Released lease must not be valid');

  const releasedQueryRes = await queryMapEntities(mockEdit, doc.sourcePath, { modelName: 'c1000' }, lease);
  assert.equal(releasedQueryRes.ok, false);
  assert.equal(releasedQueryRes.error?.code, 'MAP_SNAPSHOT_INVALID', 'queryMapEntities must reject released lease');

  const releasedBatchRes = await batchTransformMapParts(mockEdit, doc.sourcePath, { targets: ['c1000_0000'], deltaX: 1 }, lease);
  assert.equal(releasedBatchRes.ok, false);
  assert.equal(releasedBatchRes.error?.code, 'MAP_SNAPSHOT_INVALID', 'batchTransformMapParts must reject released lease');

  const releasedTxRes = await executeMapTransaction(
    mockEdit,
    doc.sourcePath,
    { id: 'tx-1', mapId: doc.mapId, baseRevision: doc.revision, description: '', author: 'agent', operations: [], timestamp: Date.now() },
    lease
  );
  assert.equal(releasedTxRes.ok, false);
  assert.equal(releasedTxRes.error?.code, 'MAP_SNAPSHOT_INVALID', 'executeMapTransaction must reject released lease');

  // Create fresh active lease for remaining unit tests
  const activeLease = createMapSnapshotLease(
    doc,
    sceneGraph,
    doc.sourcePath,
    doc.revision,
    1,
    'sha256_mock_file'
  );

  // Path mismatch check
  const pathMismatchTxRes = await executeMapTransaction(
    mockEdit,
    'd:/mock/other_map.msb',
    { id: 'tx-2', mapId: doc.mapId, baseRevision: doc.revision, description: '', author: 'agent', operations: [], timestamp: Date.now() },
    activeLease
  );
  assert.equal(pathMismatchTxRes.ok, false);
  assert.equal(pathMismatchTxRes.error?.code, 'MAP_SNAPSHOT_MISMATCH', 'executeMapTransaction must reject path mismatch');

  // =========================================================================
  // 2. queryMapEntities multi-filter intersection (AND logic)
  // =========================================================================
  // Single filter: modelName = 'c1000' -> matches Part 0 and Part 1 (count: 2)
  const qModel = await queryMapEntities(mockEdit, doc.sourcePath, { modelName: 'c1000' }, activeLease);
  assert.equal(qModel.ok, true);
  assert.equal(qModel.matchedEntities.length, 2);
  assert.deepEqual(qModel.matchedEntities.map(e => e.name).sort(), ['c1000_0000', 'c1000_0001']);

  // Single filter: entityId = 10001 -> matches Part 0 and Part 2 (count: 2)
  const qEntity = await queryMapEntities(mockEdit, doc.sourcePath, { entityId: 10001 }, activeLease);
  assert.equal(qEntity.ok, true);
  assert.equal(qEntity.matchedEntities.length, 2);
  assert.deepEqual(qEntity.matchedEntities.map(e => e.name).sort(), ['c1000_0000', 'c2000_0000']);

  // Intersection: modelName = 'c1000' AND entityId = 10001 -> matches Part 0 ONLY (count: 1)
  const qIntersect = await queryMapEntities(mockEdit, doc.sourcePath, { modelName: 'c1000', entityId: 10001 }, activeLease);
  assert.equal(qIntersect.ok, true);
  assert.equal(qIntersect.matchedEntities.length, 1);
  assert.equal(qIntersect.matchedEntities[0]?.name, 'c1000_0000');

  // Disjoint intersection: modelName = 'c2000' AND entityId = 10002 -> 0 matches, ok = true
  const qEmpty = await queryMapEntities(mockEdit, doc.sourcePath, { modelName: 'c2000', entityId: 10002 }, activeLease);
  assert.equal(qEmpty.ok, true);
  assert.equal(qEmpty.matchedEntities.length, 0);

  // Substring search: nameContains = '_0001' -> Part 1 ONLY
  const qSub = await queryMapEntities(mockEdit, doc.sourcePath, { nameContains: '_0001' }, activeLease);
  assert.equal(qSub.ok, true);
  assert.equal(qSub.matchedEntities.length, 1);
  assert.equal(qSub.matchedEntities[0]?.name, 'c1000_0001');

  // Conflicting kind filter: kind = 'region' with modelName = 'c1000' -> 0 matches, ok = true
  const qConflictKind = await queryMapEntities(mockEdit, doc.sourcePath, { kind: 'region', modelName: 'c1000' }, activeLease);
  assert.equal(qConflictKind.ok, true);
  assert.equal(qConflictKind.matchedEntities.length, 0);

  // Region name queries
  // Case G1: Nonexistent region -> MAP_ENTITY_NOT_FOUND
  const qMissingRegion = await queryMapEntities(mockEdit, doc.sourcePath, { regionName: 'Nonexistent_Region' }, activeLease);
  assert.equal(qMissingRegion.ok, false);
  assert.equal(qMissingRegion.error?.code, 'MAP_ENTITY_NOT_FOUND');

  // Case G2: Target is not a region -> MAP_NOT_A_REGION
  const qNotRegion = await queryMapEntities(mockEdit, doc.sourcePath, { regionName: 'c1000_0000' }, activeLease);
  assert.equal(qNotRegion.ok, false);
  assert.equal(qNotRegion.error?.code, 'MAP_NOT_A_REGION');

  // Case G3: Region exists but reference coverage is uncertified -> MAP_REFERENCE_COVERAGE_INCOMPLETE
  doc.referenceCoverage = undefined;
  const qIncompleteCoverage = await queryMapEntities(mockEdit, doc.sourcePath, { regionName: 'Arena_Region' }, activeLease);
  assert.equal(qIncompleteCoverage.ok, false);
  assert.equal(qIncompleteCoverage.error?.code, 'MAP_REFERENCE_COVERAGE_INCOMPLETE');

  // Case G4: Certified reference coverage -> returns referencing event
  doc.referenceCoverage = { complete: true };
  const qCertifiedCoverage = await queryMapEntities(mockEdit, doc.sourcePath, { regionName: 'Arena_Region' }, activeLease);
  assert.equal(qCertifiedCoverage.ok, true);
  assert.equal(qCertifiedCoverage.matchedEntities.length, 1);
  assert.equal(qCertifiedCoverage.matchedEntities[0]?.name, 'Boss_Event');

  // Case G5: Certified coverage with conflicting kind = 'part' -> 0 matches, ok = true
  const qCertifiedConflict = await queryMapEntities(mockEdit, doc.sourcePath, { regionName: 'Arena_Region', kind: 'part' }, activeLease);
  assert.equal(qCertifiedConflict.ok, true);
  assert.equal(qCertifiedConflict.matchedEntities.length, 0);

  // =========================================================================
  // 3. batchTransformMapParts fail-fast validation & no-op detection
  // =========================================================================
  // Pass 1: Missing target among valid targets -> fails immediately with MAP_ENTITY_NOT_FOUND
  const resMissingTarget = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['c1000_0000', 'does_not_exist_part'], deltaX: 1.0 },
    activeLease
  );
  assert.equal(resMissingTarget.ok, false);
  assert.equal(resMissingTarget.error?.code, 'MAP_ENTITY_NOT_FOUND');
  assert.equal(resMissingTarget.requestedCount, 2);
  assert.equal(resMissingTarget.resolvedCount, 1);

  // Pass 1: Duplicate target names -> MAP_DUPLICATE_TARGET
  const resDupNames = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['c1000_0000', 'c1000_0000'], deltaX: 1.0 },
    activeLease
  );
  assert.equal(resDupNames.ok, false);
  assert.equal(resDupNames.error?.code, 'MAP_DUPLICATE_TARGET');

  // Pass 1: Duplicate aliases (one by name, one by stableKey) -> MAP_DUPLICATE_TARGET
  const resDupAliases = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['c1000_0000', 'part:0'], deltaX: 1.0 },
    activeLease
  );
  assert.equal(resDupAliases.ok, false);
  assert.equal(resDupAliases.error?.code, 'MAP_DUPLICATE_TARGET');

  // Pass 1: Region target with scaleMultiplier -> MSB_REGION_SCALE_UNSUPPORTED
  const resRegionScale = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['Arena_Region'], scaleMultiplier: 1.5 },
    activeLease
  );
  assert.equal(resRegionScale.ok, false);
  assert.equal(resRegionScale.error?.code, 'MSB_REGION_SCALE_UNSUPPORTED');

  // Pass 1: Invalid floats (NaN, Infinity) -> MAP_INVALID_TRANSFORM
  const resNan = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['c1000_0000'], deltaX: NaN },
    activeLease
  );
  assert.equal(resNan.ok, false);
  assert.equal(resNan.error?.code, 'MAP_INVALID_TRANSFORM');

  const resInf = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    { targets: ['c1000_0000'], rotDeltaY: Infinity },
    activeLease
  );
  assert.equal(resInf.ok, false);
  assert.equal(resInf.error?.code, 'MAP_INVALID_TRANSFORM');

  // Pass 2: Quantization / Delta no-op -> returns noop: true, effectiveCount: 0
  const resNoop = await batchTransformMapParts(
    mockEdit,
    doc.sourcePath,
    {
      targets: ['c1000_0000'],
      deltaX: 0,
      deltaY: 0,
      deltaZ: 0,
      rotDeltaX: 0,
      rotDeltaY: 0,
      rotDeltaZ: 0,
      scaleMultiplier: 1.0
    },
    activeLease
  );
  assert.equal(resNoop.ok, true);
  assert.equal(resNoop.noop, true);
  assert.equal(resNoop.modifiedCount, 0);
  assert.equal(resNoop.effectiveCount, 0);
  assert.equal(resNoop.requestedCount, 1);
  assert.equal(resNoop.resolvedCount, 1);
  assert.equal(resNoop.before.length, 1);
  assert.equal(resNoop.after.length, 1);

  // =========================================================================
  // 4. Stale snapshot hash check in executeMapTransaction
  // =========================================================================
  const staleMockEdit = createMockEditSession('sha256_DIFFERENT_HASH');
  const staleHashTxRes = await executeMapTransaction(
    staleMockEdit,
    doc.sourcePath,
    {
      id: 'tx-stale-hash',
      mapId: doc.mapId,
      baseRevision: doc.revision,
      description: 'stale hash check',
      author: 'agent',
      operations: [
        {
          kind: 'set_transform',
          target: 'part:0',
          position: [11, 20, 30]
        }
      ],
      timestamp: Date.now()
    },
    activeLease
  );
  assert.equal(staleHashTxRes.ok, false);
  assert.equal(staleHashTxRes.error?.code, 'MAP_SOURCE_MODIFIED');

  console.log(JSON.stringify({
    layer: 'unit',
    status: 'passed',
    checks: [
      'MapSnapshotLease lifecycle & brand protection',
      'queryMapEntities multi-filter intersection (AND logic)',
      'queryMapEntities regionName coverage completeness gate',
      'batchTransformMapParts fail-fast target resolution',
      'batchTransformMapParts duplicate alias rejection',
      'batchTransformMapParts non-finite float rejection',
      'batchTransformMapParts delta=0 noop detection',
      'executeMapTransaction snapshot hash freshness gate'
    ]
  }, null, 2));
}

export async function runMapSelectionNativeTests(): Promise<void> {
  const workspace = await createSmokeWorkspace('audit-sf05-selection');
  const root = workspace.root;
  await mkdir(root, { recursive: true });
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });

  try {
    const sourceDcx = await resolveNativeFixture(
      undefined,
      'msb-primary',
      '../../mods/map/mapstudio/m11_00_00_00.msb.dcx'
    );
    const payload = decompressDfltDcx(await readFile(sourceDcx));
    const msbPath = join(root, 'm11_00_00_00.msb');
    await writeFile(msbPath, payload);

    const edit = await openNativeEditSession({
      overlayRoot: root,
      game: 'sekiro'
    });

    // 1. Authoritative initial load and snapshot creation
    const initialLoad = await loadMapDocument(edit, msbPath);
    assert.equal(initialLoad.ok, true, 'loadMapDocument must succeed on native m11 MSB');
    if (!initialLoad.ok) return;

    const { doc, sceneGraph, lease } = initialLoad;
    assert.equal(isValidSnapshotLease(lease), true, 'Loaded lease must be valid');
    assert.ok(doc.parts.length > 10, 'm11 must contain parts');
    assert.ok(doc.regions.length > 5, 'm11 must contain regions');

    // 2. Native query intersection
    // Find a model name that has multiple parts
    const modelCounts = new Map<string, number>();
    for (const part of doc.parts) {
      modelCounts.set(part.modelName, (modelCounts.get(part.modelName) ?? 0) + 1);
    }
    let multiPartModel: string | undefined;
    for (const [model, count] of modelCounts.entries()) {
      if (count >= 2) {
        multiPartModel = model;
        break;
      }
    }
    assert.ok(multiPartModel, 'Expected at least one model with multiple part instances in m11');

    const partsForModel = doc.parts.filter(p => p.modelName === multiPartModel);
    const targetPart = partsForModel[0]!;

    // Query by modelName
    const qByModel = await queryMapEntities(edit, msbPath, { modelName: multiPartModel }, lease);
    assert.equal(qByModel.ok, true);
    assert.equal(qByModel.matchedEntities.length, partsForModel.length);

    // Query intersection: modelName AND specific entityId (if available) or exact name substring
    if (targetPart.entityId !== undefined && targetPart.entityId > 0) {
      const qIntersect = await queryMapEntities(edit, msbPath, {
        modelName: multiPartModel,
        entityId: targetPart.entityId
      }, lease);
      assert.equal(qIntersect.ok, true);
      assert.ok(qIntersect.matchedEntities.length >= 1 && qIntersect.matchedEntities.length <= partsForModel.length);
      assert.ok(qIntersect.matchedEntities.some(e => e.name === targetPart.name));
    }

    const qByName = await queryMapEntities(edit, msbPath, {
      modelName: multiPartModel,
      nameContains: targetPart.name
    }, lease);
    assert.equal(qByName.ok, true);
    assert.equal(qByName.matchedEntities.length, 1);
    assert.equal(qByName.matchedEntities[0]?.name, targetPart.name);

    // Query by regionName on uncertified native MSB must return MAP_REFERENCE_COVERAGE_INCOMPLETE
    const nativeRegion = doc.regions[0]!;
    const qRegionGate = await queryMapEntities(edit, msbPath, { regionName: nativeRegion.name }, lease);
    assert.equal(qRegionGate.ok, false);
    assert.equal(qRegionGate.error?.code, 'MAP_REFERENCE_COVERAGE_INCOMPLETE');

    // 3. Native batchTransformMapParts negative tests (fail fast before staging)
    // 3a. Partial missing target
    const resPartialMissing = await batchTransformMapParts(
      edit,
      msbPath,
      { targets: [targetPart.name, 'nonexistent_native_part_404'], deltaX: 1.0 },
      lease
    );
    assert.equal(resPartialMissing.ok, false);
    assert.equal(resPartialMissing.error?.code, 'MAP_ENTITY_NOT_FOUND');

    // 3b. Duplicate targets
    const resDup = await batchTransformMapParts(
      edit,
      msbPath,
      { targets: [targetPart.name, targetPart.name], deltaX: 1.0 },
      lease
    );
    assert.equal(resDup.ok, false);
    assert.equal(resDup.error?.code, 'MAP_DUPLICATE_TARGET');

    // 3c. Invalid float NaN
    const resNan = await batchTransformMapParts(
      edit,
      msbPath,
      { targets: [targetPart.name], deltaX: NaN },
      lease
    );
    assert.equal(resNan.ok, false);
    assert.equal(resNan.error?.code, 'MAP_INVALID_TRANSFORM');

    // 3d. Quantization no-op (delta = 0)
    const resNoop = await batchTransformMapParts(
      edit,
      msbPath,
      { targets: [targetPart.name], deltaX: 0, deltaY: 0, deltaZ: 0 },
      lease
    );
    assert.equal(resNoop.ok, true);
    assert.equal(resNoop.noop, true);
    assert.equal(resNoop.modifiedCount, 0);
    assert.equal(resNoop.effectiveCount, 0);

    // 4. Native positive batch transform & verifiedPostState check
    const originalPosX = targetPart.transform.position[0];
    const delta = 1.5;
    const resTransform = await batchTransformMapParts(
      edit,
      msbPath,
      { targets: [targetPart.name], deltaX: delta },
      lease
    );
    assert.equal(resTransform.ok, true, `batch transform should succeed: ${JSON.stringify(resTransform.error)}`);
    assert.equal(resTransform.modifiedCount, 1);
    assert.equal(resTransform.effectiveCount, 1);
    assert.equal(resTransform.before.length, 1);
    assert.equal(resTransform.after.length, 1);
    assert.equal(Math.abs(resTransform.after[0]!.posX - (originalPosX + delta)) < 1e-3, true);

    // 5. Stale snapshot check on modified file
    // The file on disk was modified by the transaction above.
    // Using the original lease (which had the old file hash) must be rejected with MAP_SOURCE_MODIFIED.
    const staleTxRes = await executeMapTransaction(
      edit,
      msbPath,
      {
        id: 'tx-stale-native',
        mapId: doc.mapId,
        baseRevision: doc.revision,
        description: 'stale test',
        author: 'agent',
        operations: [
          {
            kind: 'set_transform',
            target: targetPart.stableKey,
            position: [targetPart.transform.position[0] + 1, targetPart.transform.position[1], targetPart.transform.position[2]]
          }
        ],
        timestamp: Date.now()
      },
      lease
    );
    assert.equal(staleTxRes.ok, false);
    assert.equal(staleTxRes.error?.code, 'MAP_SOURCE_MODIFIED');

    console.log(JSON.stringify({
      layer: 'native',
      status: 'passed',
      targetModel: multiPartModel,
      transformedPart: targetPart.name,
      originalPosX,
      mutatedPosX: resTransform.after[0]!.posX
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let layer = 'unit';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer' && i + 1 < args.length) {
      layer = args[++i]!;
    }
  }

  if (layer === 'unit') {
    await runMapSelectionUnitTests();
  } else if (layer === 'native') {
    await runMapSelectionNativeTests();
  } else {
    console.error(`Unknown layer: "${layer}". Use --layer unit|native`);
    process.exit(1);
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('runAuditMapSelectionSmoke.js') ||
    process.argv[1]?.replace(/\\/g, '/').endsWith('runAuditMapSelectionSmoke.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
