/**
 * SF-01 MSB 安全门禁原生测试 (runAuditMsbSafetyGateSmoke.ts)
 *
 * 依据：《SoulForge 全域审查与演进研究报告》与执行施工图 tasks/SF-01.md。
 * 验证三类危险操作直达 Bridge write-msb 时必须 fail-closed：
 *  1) set_entity_id / set_property(entityId) -> MSB_ENTITY_SCHEMA_UNVERIFIED
 *  2) Region 任何 scale 字段 -> MSB_REGION_SCALE_UNSUPPORTED
 *  3) delete_part / delete_region / delete_event -> MSB_REFERENCE_COVERAGE_INCOMPLETE
 *  4) 正常 Part 平移和正常 Region 平移依然成功，不破坏正常写链。
 */

import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';

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

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then((s) => s.size > 0).catch(() => false);
}

export async function runAuditMsbSafetyGateSmoke(): Promise<{
  ok: boolean;
  message: string;
  testedNegativeGates: string[];
  testedPositiveControls: string[];
}> {
  const workspace = await createSmokeWorkspace('audit-msb-safety');
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
    const testPart = orig.parts[0]!;
    const testRegion = orig.regions[0]!;
    const testEvent = orig.events[0]!;

    const testedNegativeGates: string[] = [];
    const testedPositiveControls: string[] = [];

    // 1. 负例：set_entity_id 必须被拦截为 MSB_ENTITY_SCHEMA_UNVERIFIED
    const outEntityId = join(staging, 'gate-entityid.msb');
    const resEntityId = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outEntityId,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'set_entity_id',
            family: 'event',
            nativeOffset: testEvent.offset,
            expectedName: testEvent.name,
            entityId: 999999
          }
        ]
      }
    });
    assert.equal(
      resEntityId.diagnostics.some((d) => d.code === 'MSB_ENTITY_SCHEMA_UNVERIFIED'),
      true,
      `Expected MSB_ENTITY_SCHEMA_UNVERIFIED for set_entity_id, got: ${JSON.stringify(resEntityId.diagnostics)}`
    );
    assert.equal(await fileExists(outEntityId), false, 'Output file must NOT exist on set_entity_id rejection');
    testedNegativeGates.push('MSB_ENTITY_SCHEMA_UNVERIFIED');

    // 2. 负例：Region scale 写入必须被拦截为 MSB_REGION_SCALE_UNSUPPORTED
    const outRegionScale1 = join(staging, 'gate-region-scale1.msb');
    const resRegionScale1 = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outRegionScale1,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'set_region_transform',
            family: 'region',
            nativeOffset: testRegion.offset,
            expectedName: testRegion.name,
            scaleX: 1.0,
            scaleY: 1.0,
            scaleZ: 1.0
          }
        ]
      }
    });
    assert.equal(
      resRegionScale1.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'),
      true,
      `Expected MSB_REGION_SCALE_UNSUPPORTED for region scale, got: ${JSON.stringify(resRegionScale1.diagnostics)}`
    );
    assert.equal(await fileExists(outRegionScale1), false, 'Output file must NOT exist on region scale rejection');

    // 负例：Region scaleX = 0 零值意图同样被拦截
    const outRegionScale0 = join(staging, 'gate-region-scale0.msb');
    const resRegionScale0 = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outRegionScale0,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'set_region_transform',
            family: 'region',
            nativeOffset: testRegion.offset,
            expectedName: testRegion.name,
            scaleX: 0
          }
        ]
      }
    });
    assert.equal(
      resRegionScale0.diagnostics.some((d) => d.code === 'MSB_REGION_SCALE_UNSUPPORTED'),
      true
    );
    assert.equal(await fileExists(outRegionScale0), false);
    testedNegativeGates.push('MSB_REGION_SCALE_UNSUPPORTED');

    // 3. 负例：delete_part / delete_region / delete_event 必须被拦截为 MSB_REFERENCE_COVERAGE_INCOMPLETE
    const outDeletePart = join(staging, 'gate-delete-part.msb');
    const resDeletePart = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outDeletePart,
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
      resDeletePart.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'),
      true,
      `Expected MSB_REFERENCE_COVERAGE_INCOMPLETE for delete_part, got: ${JSON.stringify(resDeletePart.diagnostics)}`
    );
    assert.equal(await fileExists(outDeletePart), false, 'Output file must NOT exist on delete_part rejection');

    const outDeleteRegion = join(staging, 'gate-delete-region.msb');
    const resDeleteRegion = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outDeleteRegion,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'delete_region',
            family: 'region',
            nativeOffset: testRegion.offset,
            expectedName: testRegion.name
          }
        ]
      }
    });
    assert.equal(
      resDeleteRegion.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'),
      true
    );
    assert.equal(await fileExists(outDeleteRegion), false);

    const outDeleteEvent = join(staging, 'gate-delete-event.msb');
    const resDeleteEvent = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outDeleteEvent,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'delete_event',
            family: 'event',
            nativeOffset: testEvent.offset,
            expectedName: testEvent.name
          }
        ]
      }
    });
    assert.equal(
      resDeleteEvent.diagnostics.some((d) => d.code === 'MSB_REFERENCE_COVERAGE_INCOMPLETE'),
      true
    );
    assert.equal(await fileExists(outDeleteEvent), false);
    testedNegativeGates.push('MSB_REFERENCE_COVERAGE_INCOMPLETE');

    // 4. 正向对照 1：正常 Part 平移依然成功
    const outPartSuccess = join(staging, 'part-success.msb');
    const resPartSuccess = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outPartSuccess,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'set_part_position',
            family: 'part',
            nativeOffset: testPart.offset,
            expectedName: testPart.name,
            posX: testPart.posX + 1.5,
            posY: testPart.posY,
            posZ: testPart.posZ
          }
        ]
      }
    });
    assert.equal(
      resPartSuccess.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED'),
      true,
      `Expected MSB_STAGING_WRITE_VERIFIED for normal part translate, got: ${JSON.stringify(resPartSuccess.diagnostics)}`
    );
    assert.equal(await fileExists(outPartSuccess), true, 'Output file must exist for valid part translate');
    testedPositiveControls.push('set_part_position');

    // 5. 正向对照 2：正常 Region 平移依然成功
    const outRegionSuccess = join(staging, 'region-success.msb');
    const resRegionSuccess = await runBridge({
      command: 'write-msb',
      filePath: msbPath,
      allowedRoots: [root, staging],
      writableRoots: [staging],
      timeoutMs: 60_000,
      commandOptions: {
        outputPath: outRegionSuccess,
        expectedDocumentHash: orig.sourceHash,
        mutations: [
          {
            kind: 'set_region_position',
            family: 'region',
            nativeOffset: testRegion.offset,
            expectedName: testRegion.name,
            posX: testRegion.posX + 2.0,
            posY: testRegion.posY,
            posZ: testRegion.posZ
          }
        ]
      }
    });
    assert.equal(
      resRegionSuccess.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED'),
      true,
      `Expected MSB_STAGING_WRITE_VERIFIED for normal region translate, got: ${JSON.stringify(resRegionSuccess.diagnostics)}`
    );
    assert.equal(await fileExists(outRegionSuccess), true, 'Output file must exist for valid region translate');
    testedPositiveControls.push('set_region_position');

    return {
      ok: true,
      message: 'MSB safety gate smoke passed: EntityID, Region scale, and structural deletion safely blocked; normal Part and Region translations intact.',
      testedNegativeGates,
      testedPositiveControls
    };
  } finally {
    await disposeBridgeDaemonPool();
    await workspace.dispose();
  }
}

if (process.argv[1]?.endsWith('runAuditMsbSafetyGateSmoke.ts') || process.argv[1]?.endsWith('runAuditMsbSafetyGateSmoke.js')) {
  runAuditMsbSafetyGateSmoke()
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
