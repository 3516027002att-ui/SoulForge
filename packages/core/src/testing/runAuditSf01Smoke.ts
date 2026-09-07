/**
 * SF-01 执行卡专项测试入口 (runAuditSf01Smoke.ts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与执行施工图 tasks/SF-01.md。
 * 派发 --layer unit|native：
 *  - unit：验证 validateMapTransaction 及 Blender delta 对三类危险操作的切断及错误码断言。
 *  - native：调用 runAuditMsbSafetyGateSmoke 执行真实 Bridge 安全拦截测试。
 */

import { strict as assert } from 'node:assert';
import {
  buildCanonicalMapDocument,
  validateMapTransaction,
  importBlenderDeltaToTransaction,
  type MapEditTransaction,
  type BlenderDeltaImport
} from '@soulforge/shared';
import { runAuditMsbSafetyGateSmoke } from './runAuditMsbSafetyGateSmoke.js';

function parseArgs(): { layer: string | undefined } {
  const args = process.argv.slice(2);
  let layer: string | undefined = undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--layer' && i + 1 < args.length) {
      layer = args[++i];
    }
  }
  return { layer };
}

function createSyntheticMapDoc() {
  return buildCanonicalMapDocument({
    sourceUri: 'file:///d:/mods/map/mapstudio/m11_00_00_00.msb',
    sourcePath: 'm11_00_00_00.msb',
    game: 'sekiro',
    revision: 'rev-sf01',
    models: [
      { name: 'm1000', nativeOffset: 0x100, typeId: 0 }
    ],
    parts: [
      {
        name: 'c1000_0000',
        typeId: 0,
        nativeOffset: 0x1000,
        posX: 10,
        posY: 20,
        posZ: 30,
        rotX: 0,
        rotY: 45,
        rotZ: 0,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
        entityId: 1100010
      }
    ],
    regions: [
      {
        name: 'r1000_0000',
        typeId: 0,
        nativeOffset: 0x2000,
        posX: 100,
        posY: 200,
        posZ: 300,
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        entityId: 1100020
      }
    ],
    events: [
      {
        name: 'e1000_0000',
        typeId: 0,
        nativeOffset: 0x3000,
        eventId: 1100030
      }
    ]
  });
}

function runUnitTests(): void {
  const doc = createSyntheticMapDoc();
  const part = doc.parts[0]!;
  const region = doc.regions[0]!;

  // 1. set_property(entityId) 必须被切断 -> MSB_ENTITY_SCHEMA_UNVERIFIED
  const txEntityId: MapEditTransaction = {
    id: 'tx-entity-id',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Set EntityID',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'set_property',
        target: part.stableKey,
        property: 'entityId',
        value: 123456
      }
    ]
  };
  const resEntityId = validateMapTransaction(doc, txEntityId);
  assert.equal(resEntityId.valid, false, 'EntityID mutation must be invalid');
  assert.equal(
    resEntityId.diagnostics.some((d) => d.code === 'MSB_ENTITY_SCHEMA_UNVERIFIED'),
    true,
    'Must return MSB_ENTITY_SCHEMA_UNVERIFIED'
  );

  // 2. Region scale 必须被切断 -> MSB_REGION_SCALE_UNSUPPORTED
  // 2.1 set_transform with scale: [1, 1, 1]
  const txRegionScale1: MapEditTransaction = {
    id: 'tx-region-scale1',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Region scale [1,1,1]',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'set_transform',
        target: region.stableKey,
        scale: [1, 1, 1]
      }
    ]
  };
  const resRegionScale1 = validateMapTransaction(doc, txRegionScale1);
  assert.equal(resRegionScale1.valid, false);
  assert.equal(resRegionScale1.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'), true);

  // 2.2 set_transform with scale: [0, 0, 0] (零值仍被拒绝)
  const txRegionScale0: MapEditTransaction = {
    id: 'tx-region-scale0',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Region scale [0,0,0]',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'set_transform',
        target: region.stableKey,
        scale: [0, 0, 0]
      }
    ]
  };
  const resRegionScale0 = validateMapTransaction(doc, txRegionScale0);
  assert.equal(resRegionScale0.valid, false);
  assert.equal(resRegionScale0.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'), true);

  // 2.3 batch_transform on region with scaleDelta: [0, 0, 0]
  const txRegionScaleDelta: MapEditTransaction = {
    id: 'tx-region-delta',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Region batch scaleDelta',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'batch_transform',
        targets: [region.stableKey],
        scaleDelta: [0, 0, 0]
      }
    ]
  };
  const resRegionScaleDelta = validateMapTransaction(doc, txRegionScaleDelta);
  assert.equal(resRegionScaleDelta.valid, false);
  assert.equal(resRegionScaleDelta.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'), true);

  // 2.4 Blender delta import with Region scale
  const deltaRegionScale: BlenderDeltaImport = {
    schemaVersion: 1,
    mapId: doc.mapId,
    baseRevision: doc.revision,
    importedAt: new Date().toISOString(),
    mutations: [
      {
        action: 'modify',
        stableKey: region.stableKey,
        family: region.family,
        nativeOffset: region.nativeOffset,
        scale: [1, 1, 1]
      }
    ]
  };
  const resBlenderScale = importBlenderDeltaToTransaction(doc, deltaRegionScale);
  assert.equal(resBlenderScale.ok, false);
  assert.equal(resBlenderScale.error.includes('MSB_REGION_SCALE_UNSUPPORTED'), true);

  // 3. 结构删除必须被切断 -> MSB_REFERENCE_COVERAGE_INCOMPLETE
  const txDelete: MapEditTransaction = {
    id: 'tx-delete',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Delete Part',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'delete',
        target: part.stableKey
      }
    ]
  };
  const resDelete = validateMapTransaction(doc, txDelete);
  assert.equal(resDelete.valid, false);
  assert.equal(resDelete.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'), true);

  // Blender delta delete
  const deltaDelete: BlenderDeltaImport = {
    schemaVersion: 1,
    mapId: doc.mapId,
    baseRevision: doc.revision,
    importedAt: new Date().toISOString(),
    mutations: [
      {
        action: 'delete',
        stableKey: part.stableKey,
        family: part.family,
        nativeOffset: part.nativeOffset
      }
    ]
  };
  const resBlenderDelete = importBlenderDeltaToTransaction(doc, deltaDelete);
  assert.equal(resBlenderDelete.ok, false);
  assert.equal(resBlenderDelete.error.includes('MSB_REFERENCE_COVERAGE_INCOMPLETE'), true);

  // 4. 正向对照：正常的 Part 变换与正常的 Region 平移/旋转依然有效
  const txValidPart: MapEditTransaction = {
    id: 'tx-valid-part',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Valid Part Transform',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'set_transform',
        target: part.stableKey,
        position: [11, 21, 31],
        scale: [1.1, 1.1, 1.1]
      }
    ]
  };
  const resValidPart = validateMapTransaction(doc, txValidPart);
  assert.equal(resValidPart.valid, true, `Part transform should remain valid, got: ${JSON.stringify(resValidPart.diagnostics)}`);

  const txValidRegion: MapEditTransaction = {
    id: 'tx-valid-region',
    mapId: doc.mapId,
    baseRevision: doc.revision,
    description: 'Valid Region Position/Rotation',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'set_transform',
        target: region.stableKey,
        position: [105, 205, 305],
        rotation: [0, 90, 0]
      }
    ]
  };
  const resValidRegion = validateMapTransaction(doc, txValidRegion);
  assert.equal(resValidRegion.valid, true, `Region translation should remain valid, got: ${JSON.stringify(resValidRegion.diagnostics)}`);

  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-01',
    layer: 'unit',
    message: 'SF-01 unit audit passed: 3 danger operations safely blocked, normal transforms preserved.',
    checks: [
      'MSB_ENTITY_SCHEMA_UNVERIFIED',
      'MSB_REGION_SCALE_UNSUPPORTED',
      'MSB_REFERENCE_COVERAGE_INCOMPLETE',
      'part_transform_permitted',
      'region_transform_without_scale_permitted'
    ]
  }, null, 2));
}

async function runNativeTests(): Promise<void> {
  const result = await runAuditMsbSafetyGateSmoke();
  console.log(JSON.stringify({
    ok: result.ok,
    taskId: 'SF-01',
    layer: 'native',
    message: result.message,
    testedNegativeGates: result.testedNegativeGates,
    testedPositiveControls: result.testedPositiveControls
  }, null, 2));
}

async function main(): Promise<void> {
  const { layer } = parseArgs();
  if (layer === 'unit') {
    runUnitTests();
  } else if (layer === 'native') {
    await runNativeTests();
  } else {
    console.error(`Unknown or missing layer: "${layer}". Must specify --layer unit|native.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
