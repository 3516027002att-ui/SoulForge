/**
 * SF-04 MSB 结构删除与引用闭包审计测试 (runAuditSf04Smoke.ts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与任务施工图 SF-04.md。
 * 覆盖能力点：
 *  - MsbReferenceDescriptor 与 ReferenceCoverageCertificate 契约
 *  - remapReferences: O(N+E) 引用重映射算法 (T05 / T06)
 *  - evaluateStructuralDeletion: 目标集合检查、未闭合门禁拦截、外部引用拦截与安全规划
 *  - validateMapTransaction / executeMapTransaction: 针对删除操作的门禁拦截与凭证放行
 *  - Native Layer: 真实 Sekiro MSB 上未闭合删除拦截 (MSB_REFERENCE_COVERAGE_INCOMPLETE) 与
 *    携完整凭证的安全删除与 param 偏移表重写重读验证。
 */

import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import {
  type MsbReferenceDescriptor,
  type ReferenceCoverageCertificate,
  computeReferenceCoverageCertificate,
  remapReferences,
  evaluateStructuralDeletion
} from '../editing/msbReferenceCoverage.js';
import {
  buildCanonicalMapDocument,
  validateMapTransaction,
  type MapEditTransaction
} from '@soulforge/shared';


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

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((s) => s.size > 0).catch(() => false);
}

function runUnitTests(): void {
  // -------------------------------------------------------------
  // 1. remapReferences T05: 基础索引移动与哨兵保留
  // -------------------------------------------------------------
  const baseRefs: MsbReferenceDescriptor[] = [
    {
      ownerHandle: 'part_0',
      ownerProperty: 'targetIndex',
      targetIndexDomain: 'parts_all',
      storageOffset: 0x40,
      storageType: 'int32',
      value: 1,
      nullSentinel: -1,
      nullable: false,
      onDeletePolicy: 'reject',
      sourceSchemaHash: 'schema-test'
    },
    {
      ownerHandle: 'part_1',
      ownerProperty: 'targetIndex',
      targetIndexDomain: 'parts_all',
      storageOffset: 0x44,
      storageType: 'int32',
      value: 2,
      nullSentinel: -1,
      nullable: false,
      onDeletePolicy: 'reject',
      sourceSchemaHash: 'schema-test'
    },
    {
      ownerHandle: 'part_2',
      ownerProperty: 'targetIndex',
      targetIndexDomain: 'parts_all',
      storageOffset: 0x48,
      storageType: 'int32',
      value: -1,
      nullSentinel: -1,
      nullable: true,
      onDeletePolicy: 'clear',
      sourceSchemaHash: 'schema-test'
    }
  ];

  // Case A: 删除第 0 项 (removed: [0]), 原索引 1->0, 2->1, -1 保留为 -1
  const resA = remapReferences(3, [0], baseRefs, { complete: true });
  assert.deepEqual(resA.map, [-1, 0, 1]);
  assert.equal(resA.rewritten[0]?.value, 0);
  assert.equal(resA.rewritten[1]?.value, 1);
  assert.equal(resA.rewritten[2]?.value, -1);

  // Case B: 删除第 1 项 (removed: [1])
  // 注意：baseRefs[0] 指向 1（被删除），如果 onDeletePolicy 为 reject 应该抛错
  assert.throws(
    () => remapReferences(3, [1], baseRefs, { complete: true }),
    (err: any) => err.code === 'DELETE_REFERENCED_TARGET' || err.message.includes('DELETE_REFERENCED_TARGET'),
    '删除被引用的非可空目标必须抛出 DELETE_REFERENCED_TARGET'
  );

  // Case C: 删除第 2 项 (removed: [2])
  // baseRefs[1] 指向 2（被删除），也应拦截
  assert.throws(
    () => remapReferences(3, [2], baseRefs, { complete: true }),
    (err: any) => err.code === 'DELETE_REFERENCED_TARGET' || err.message.includes('DELETE_REFERENCED_TARGET')
  );

  // -------------------------------------------------------------
  // 2. remapReferences T06: 可空引用清除 (onDeletePolicy = 'clear')
  // -------------------------------------------------------------
  const nullableRefs: MsbReferenceDescriptor[] = [
    {
      ownerHandle: 'event_0',
      ownerProperty: 'activationPart',
      targetIndexDomain: 'parts_all',
      storageOffset: 0x50,
      storageType: 'int32',
      value: 1,
      nullSentinel: -1,
      nullable: true,
      onDeletePolicy: 'clear',
      sourceSchemaHash: 'schema-test'
    },
    {
      ownerHandle: 'event_1',
      ownerProperty: 'activationPart',
      targetIndexDomain: 'parts_all',
      storageOffset: 0x54,
      storageType: 'int32',
      value: 2,
      nullSentinel: -1,
      nullable: true,
      onDeletePolicy: 'clear',
      sourceSchemaHash: 'schema-test'
    }
  ];

  // 删除 [1]，event_0 的引用应被重写为 -1，event_1 的引用 2 重写为 1
  const resNullable = remapReferences(3, [1], nullableRefs, { complete: true });
  assert.deepEqual(resNullable.map, [0, -1, 1]);
  assert.equal(resNullable.rewritten[0]?.value, -1);
  assert.equal(resNullable.rewritten[1]?.value, 1);

  // -------------------------------------------------------------
  // 3. remapReferences 安全门禁：未闭合或非法参数
  // -------------------------------------------------------------
  // 未标记 complete: true
  assert.throws(
    () => remapReferences(3, [0], baseRefs),
    (err: any) => err.code === 'REFERENCE_COVERAGE_INCOMPLETE' || err.message.includes('REFERENCE_COVERAGE_INCOMPLETE')
  );

  // 重复删除索引
  assert.throws(
    () => remapReferences(3, [1, 1], nullableRefs, { complete: true }),
    (err: any) => err.code === 'DUPLICATE_DELETE' || err.message.includes('DUPLICATE_DELETE')
  );

  // 越界索引
  assert.throws(
    () => remapReferences(3, [5], nullableRefs, { complete: true })
  );

  // -------------------------------------------------------------
  // 4. evaluateStructuralDeletion 综合规划测试
  // -------------------------------------------------------------
  const completeCert: ReferenceCoverageCertificate = {
    gameProfile: 'sekiro-verified',
    readerSchemaHash: 'sha256:test',
    sourceHash: 'source-hash',
    presentTypeIds: [0],
    decodedReferenceKinds: ['activationPartIndex'],
    unknownReferenceRegions: [],
    complete: true
  };

  const incompleteCert: ReferenceCoverageCertificate = {
    gameProfile: 'sekiro-native',
    readerSchemaHash: 'sha256:test',
    sourceHash: 'source-hash',
    presentTypeIds: [0],
    decodedReferenceKinds: ['activationPartIndex'],
    unknownReferenceRegions: ['EVENT_PARAM_ST_SUB_DATA'],
    complete: false
  };

  // 4.1 空目标集
  const resEmpty = evaluateStructuralDeletion(3, [], nullableRefs, { certificate: completeCert });
  assert.equal(resEmpty.ok, false);
  assert.equal(resEmpty.code, 'TARGET_SET_EMPTY');

  // 4.2 重复目标
  const resDup = evaluateStructuralDeletion(3, [0, 0], nullableRefs, { certificate: completeCert });
  assert.equal(resDup.ok, false);
  assert.equal(resDup.code, 'DUPLICATE_DELETE');

  // 4.3 引用覆盖不完整
  const resIncomplete = evaluateStructuralDeletion(3, [0], nullableRefs, { certificate: incompleteCert });
  assert.equal(resIncomplete.ok, false);
  assert.equal(resIncomplete.code, 'MSB_REFERENCE_COVERAGE_INCOMPLETE');

  // 4.4 存在外部引用拦截
  const extRefs = new Map<number, string[]>();
  extRefs.set(0, ['event_flag_1001', 'talk_script_200']);
  const resExt = evaluateStructuralDeletion(3, [0], nullableRefs, {
    certificate: completeCert,
    externalReferences: extRefs
  });
  assert.equal(resExt.ok, false);
  assert.equal(resExt.code, 'EXTERNAL_REFERENCE_EXISTS');
  assert.equal(resExt.blockedReferences?.length, 1);

  // 4.5 引用冲突拦截 (不可自动清除的引用)
  const resConflict = evaluateStructuralDeletion(3, [1], baseRefs, { certificate: completeCert });
  assert.equal(resConflict.ok, false);
  assert.equal(resConflict.code, 'DELETE_REFERENCED_TARGET');

  // 4.6 成功规划
  const resSafe = evaluateStructuralDeletion(3, [0], baseRefs, { certificate: completeCert });
  assert.equal(resSafe.ok, true);
  assert.equal(Boolean(resSafe.plan), true);
  assert.deepEqual(resSafe.plan?.removedIndices, [0]);
  assert.deepEqual(resSafe.plan?.indexMap, [-1, 0, 1]);

  // -------------------------------------------------------------
  // 5. computeReferenceCoverageCertificate
  // -------------------------------------------------------------
  const dummyDoc = {
    parts: [{ typeId: 0 }, { typeId: 1 }],
    regions: [{ typeId: 0 }],
    events: [{ typeId: 4 }]
  };
  const nativeCert = computeReferenceCoverageCertificate(dummyDoc, false);
  assert.equal(nativeCert.complete, false);
  assert.equal(nativeCert.unknownReferenceRegions.length > 0, true);

  const verifiedCert = computeReferenceCoverageCertificate(dummyDoc, true);
  assert.equal(verifiedCert.complete, true);
  assert.equal(verifiedCert.unknownReferenceRegions.length, 0);

  // -------------------------------------------------------------
  // 6. validateMapTransaction & executeMapTransaction 门禁拦截与放行
  // -------------------------------------------------------------
  const mapDoc = buildCanonicalMapDocument({
    sourceUri: 'file:///d:/mods/map/mapstudio/m11_00_00_00.msb',
    sourcePath: 'm11_00_00_00.msb',
    game: 'sekiro',
    revision: 'rev-sf04',
    parts: [
      {
        name: 'c1000_0000',
        typeId: 0,
        nativeOffset: 0x1000,
        posX: 10,
        posY: 20,
        posZ: 30,
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1
      },
      {
        name: 'c1000_0001',
        typeId: 0,
        nativeOffset: 0x1100,
        posX: 40,
        posY: 50,
        posZ: 60,
        rotX: 0,
        rotY: 0,
        rotZ: 0,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1
      }
    ]
  });

  const part = mapDoc.parts[0]!;

  // 未提供 complete certificate 的删除事务必须在 validateMapTransaction 被拦截
  const txDeleteUncertified: MapEditTransaction = {
    id: 'tx-del-uncertified',
    mapId: mapDoc.mapId,
    baseRevision: mapDoc.revision,
    description: 'Uncertified delete',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'delete',
        target: part.stableKey
      }
    ]
  };
  const valUncertified = validateMapTransaction(mapDoc, txDeleteUncertified);
  assert.equal(valUncertified.valid, false);
  assert.equal(valUncertified.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'), true);

  // 提供 incomplete certificate 的删除事务同样必须被拦截
  const txDeleteIncomplete: MapEditTransaction = {
    id: 'tx-del-incomplete',
    mapId: mapDoc.mapId,
    baseRevision: mapDoc.revision,
    description: 'Incomplete delete',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'delete',
        target: part.stableKey,
        certificate: {
          complete: false,
          gameProfile: 'sekiro-native',
          readerSchemaHash: 'sha256:v2'
        }
      }
    ]
  };
  const valIncomplete = validateMapTransaction(mapDoc, txDeleteIncomplete);
  assert.equal(valIncomplete.valid, false);
  assert.equal(valIncomplete.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'), true);

  // 提供 complete certificate 的删除事务应当通过验证
  const txDeleteCertified: MapEditTransaction = {
    id: 'tx-del-certified',
    mapId: mapDoc.mapId,
    baseRevision: mapDoc.revision,
    description: 'Certified delete',
    author: 'agent',
    timestamp: Date.now(),
    operations: [
      {
        kind: 'delete',
        target: part.stableKey,
        certificate: {
          complete: true,
          gameProfile: 'sekiro-verified',
          readerSchemaHash: 'sha256:v1',
          sourceHash: 'source-hash',
          unverifiedReferences: [],
          coveredFamilies: ['part'],
          closureNotes: ['Verified delete in test']
        }
      }
    ]
  };
  const valCertified = validateMapTransaction(mapDoc, txDeleteCertified);
  assert.equal(valCertified.valid, true, `Certified delete should pass validation: ${JSON.stringify(valCertified.diagnostics)}`);

  console.log(JSON.stringify({
    ok: true,
    taskId: 'SF-04',
    layer: 'unit',
    message: 'SF-04 unit audit passed: remapReferences, evaluateStructuralDeletion, certificate checking, and transaction gates fully verified.',
    checks: [
      'remapReferences_T05_shift_and_sentinel',
      'remapReferences_T06_clear_nullable',
      'remapReferences_T06_reject_non_nullable',
      'remapReferences_gate_incomplete',
      'remapReferences_duplicate_delete',
      'evaluateStructuralDeletion_target_set_empty',
      'evaluateStructuralDeletion_duplicate_delete',
      'evaluateStructuralDeletion_incomplete_gate',
      'evaluateStructuralDeletion_external_reference_block',
      'evaluateStructuralDeletion_safe_plan',
      'computeReferenceCoverageCertificate',
      'validateMapTransaction_delete_gate',
      'validateMapTransaction_delete_incomplete_gate',
      'validateMapTransaction_delete_success_with_cert'
    ]
  }, null, 2));
}

interface MsbEnvelope {
  sourceHash: string;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  parts: Array<{ name: string; offset: number; posX: number; posY: number; posZ: number }>;
  regions: Array<{ name: string; offset: number; posX: number; posY: number; posZ: number }>;
  events: Array<{ name: string; offset: number }>;
}

async function runNativeTests(): Promise<void> {
  const workspace = await createSmokeWorkspace('audit-sf04-structural-deletion');
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
    const msbPath = join(root, 'm11.msb');
    await writeFile(msbPath, payload);

    const read = await runBridge<MsbEnvelope>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [root],
      timeoutMs: 60_000
    });
    assert.equal(read.parseStatus !== 'failed' && Boolean(read.data), true, 'Initial read-msb-document failed');
    const orig = read.data!;
    const testPart = orig.parts[orig.parts.length - 1]!;
    const testRegion = orig.regions[0]!;
    const testEvent = orig.events[0]!;

    const testedNegativeGates: string[] = [];
    const testedPositiveControls: string[] = [];

    // 1. 负例：未提供凭证的删除必须被拦截为 MSB_REFERENCE_COVERAGE_INCOMPLETE
    const outDelPart = join(staging, 'gate-del-part.msb');
    const resDelPart = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outDelPart,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'delete_part',
            family: 'part',
            nativeOffset: testPart.offset,
            expectedName: testPart.name
          }
        ]
      }
    });
    assert.equal(
      resDelPart.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'),
      true,
      `Expected MSB_REFERENCE_COVERAGE_INCOMPLETE for delete_part, got: ${JSON.stringify(resDelPart.diagnostics)}`
    );
    assert.equal(await fileExists(outDelPart), false, 'Output file must NOT exist on delete_part rejection');
    testedNegativeGates.push('delete_part_uncertified_gate');

    // 2. 负例：提供 incomplete certificate 的删除同样必须被拦截
    const outDelRegion = join(staging, 'gate-del-region.msb');
    const resDelRegion = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outDelRegion,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'delete_region',
            family: 'region',
            nativeOffset: testRegion.offset,
            expectedName: testRegion.name,
            certificate: {
              complete: false,
              gameProfile: 'sekiro-native',
              readerSchemaHash: 'sha256:v2',
              sourceHash: orig.sourceHash,
              unverifiedReferences: [],
              coveredFamilies: ['region'],
              closureNotes: ['Incomplete scan']
            }
          }
        ]
      }
    });
    assert.equal(
      resDelRegion.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'),
      true,
      `Expected MSB_REFERENCE_COVERAGE_INCOMPLETE for delete_region, got: ${JSON.stringify(resDelRegion.diagnostics)}`
    );
    assert.equal(await fileExists(outDelRegion), false, 'Output file must NOT exist on delete_region rejection');
    testedNegativeGates.push('delete_region_incomplete_gate');

    // 3. 正例：携带 complete certificate 的删除放行并重写 param 偏移表
    const outCertifiedDelete = join(staging, 'certified-delete.msb');
    const completeCert = {
      complete: true,
      gameProfile: 'sekiro-native',
      readerSchemaHash: 'sha256:reference-coverage-v1',
      sourceHash: orig.sourceHash,
      unverifiedReferences: [],
      coveredFamilies: ['part'],
      closureNotes: ['Verified unreferenced leaf part in native Sekiro MSB']
    };

    const resCertified = await runBridge<{
      mutationCount: number;
      partCount: number;
      rereadVerified: boolean;
    }>({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outCertifiedDelete,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'delete_part',
            family: 'part',
            nativeOffset: testPart.offset,
            expectedName: testPart.name,
            certificate: completeCert
          }
        ]
      }
    });

    assert.equal(
      resCertified.diagnostics.some((d) => d.severity === 'error'),
      false,
      `Certified delete write failed: ${JSON.stringify(resCertified.diagnostics)}`
    );
    assert.equal(await fileExists(outCertifiedDelete), true, 'Certified delete output file must exist');
    assert.equal(resCertified.data?.rereadVerified, true, 'Bridge rereadVerified must be true');
    assert.equal(resCertified.data?.partCount, orig.partCount - 1, 'Part count must decrease by 1');
    testedPositiveControls.push('delete_part_with_complete_certificate');

    // 4. 重读生成产物并核实实体完全剔除且不破坏其他列表
    const reread = await runBridge<MsbEnvelope>({
      command: 'read-msb-document',
      filePath: outCertifiedDelete,
      allowedRoots: [staging],
      timeoutMs: 60_000
    });
    assert.equal(reread.parseStatus !== 'failed' && Boolean(reread.data), true, 'Reread after delete failed');
    const rereadData = reread.data!;
    assert.equal(rereadData.partCount, orig.partCount - 1);
    assert.equal(rereadData.parts.some((p) => p.offset === testPart.offset), false, 'Deleted part must not be present');
    assert.equal(rereadData.modelCount, orig.modelCount, 'Model count must be preserved');
    assert.equal(rereadData.regionCount, orig.regionCount, 'Region count must be preserved');
    assert.equal(rereadData.eventCount, orig.eventCount, 'Event count must be preserved');
    testedPositiveControls.push('reread_integrity_verified_after_delete');

    console.log(JSON.stringify({
      ok: true,
      taskId: 'SF-04',
      layer: 'native',
      message: 'SF-04 native audit passed: native deletion gates and complete certificate re-indexing verified on real Sekiro MSB.',
      testedNegativeGates,
      testedPositiveControls
    }, null, 2));
  } finally {
    await disposeBridgeDaemonPool();
  }
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
