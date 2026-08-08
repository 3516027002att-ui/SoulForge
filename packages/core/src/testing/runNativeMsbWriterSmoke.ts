/**
 * Native MSB writer 全覆盖往返 smoke：
 *  1) 对每类已注册 part/region type 采样，在单次 write-msb 中批量应用 transform 写回，
 *     重读验证「未被修改实体字节级不变、被修改实体仅目标字段变化」（无损性）。
 *  2) 未注册实体编辑守卫 fail-closed：把 part/region type 字节补丁为未注册值后
 *     写回必须返回 MSB_UNREGISTERED_ENTITY_TYPE 结构化诊断，绝不落盘。
 *
 * Authority: native-verified（偏移表驱动全枚举 + 源字节原位补丁写回，per-type 内层载荷保持无损）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { isRegisteredMsbType } from '@soulforge/shared';

interface MsbEnvelope {
  sourceHash: string;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  routeCount: number;
  models: Array<{ name: string; offset: number; typeId: number }>;
  parts: Array<{
    name: string;
    offset: number;
    typeId: number;
    modelIndex?: number;
    posX: number;
    posY: number;
    posZ: number;
    rotX?: number;
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
  }>;
  regions: Array<{ name: string; offset: number; typeId: number; posX: number; posY: number; posZ: number }>;
  events: Array<{ name: string; offset: number; typeId: number; eventId?: number }>;
  routes: Array<{ name: string; offset: number; typeId: number; id?: number }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.001;

function assertPartEqual(actual: MsbEnvelope['parts'][number], expected: MsbEnvelope['parts'][number], label: string): void {
  if (actual.name !== expected.name || actual.offset !== expected.offset || actual.typeId !== expected.typeId
    || actual.modelIndex !== expected.modelIndex) {
    throw new Error(`${label}: part 身份/类型字段不一致: ${JSON.stringify({ actual, expected })}`);
  }
}

function assertRegionEqual(actual: MsbEnvelope['regions'][number], expected: MsbEnvelope['regions'][number], label: string): void {
  if (actual.name !== expected.name || actual.offset !== expected.offset || actual.typeId !== expected.typeId) {
    throw new Error(`${label}: region 身份/类型字段不一致: ${JSON.stringify({ actual, expected })}`);
  }
}

async function main(): Promise<void> {
  const workspace = await createSmokeWorkspace('msb-writer');
  const root = workspace.root;
  await mkdir(root, { recursive: true });
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  try {

      const sourceDcx = await resolveNativeFixture(
        process.argv[2],
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
        timeoutMs: 180_000
      });
      if (read.parseStatus === 'failed' || !read.data) {
        throw new Error(`MSB read failed: ${JSON.stringify(read.diagnostics)}`);
      }
      const orig = read.data;

      // 每类 part type 采样 + 每类 region type 采样，构造批量 mutation。
      const partTypes = [...new Set(orig.parts.map((p) => p.typeId))].sort((a, b) => a - b);
      const regionTypes = [...new Set(orig.regions.map((r) => r.typeId))].sort((a, b) => a - b);
      for (const typeId of [...partTypes, ...regionTypes]) {
        if (!isRegisteredMsbType('part', typeId) && !isRegisteredMsbType('region', typeId)) {
          throw new Error(`采样实体存在未注册 typeId=${typeId}`);
        }
      }
      const mutations: Array<Record<string, unknown>> = [];
      const expectedParts = new Map<number, { posX: number; posY: number; posZ: number; rotX: number; scaleX: number; scaleY: number; scaleZ: number }>();
      for (const typeId of partTypes) {
        // writer 要求 mutation 目标唯一解析：样本必须取唯一名实体。
        const sample = orig.parts.find((p) => p.typeId === typeId
          && orig.parts.filter((o) => o.name === p.name).length === 1);
        if (!sample) throw new Error(`part type ${typeId} 缺少唯一名样本`);
        const posX = sample.posX + 1.25;
        const posY = sample.posY - 0.5;
        const posZ = sample.posZ + 0.75;
        const rotX = (sample.rotX ?? 0) + 0.5;
        const scaleX = (sample.scaleX ?? 1) * 1.1;
        const scaleY = (sample.scaleY ?? 1) * 1.2;
        const scaleZ = (sample.scaleZ ?? 1) * 0.9;
        mutations.push({
          kind: 'set_part_transform',
          partName: sample.name,
          posX, posY, posZ, rotX, scaleX, scaleY, scaleZ
        });
        expectedParts.set(sample.offset, { posX, posY, posZ, rotX, scaleX, scaleY, scaleZ });
      }
      const expectedRegions = new Map<number, { posX: number; posY: number; posZ: number }>();
      for (const typeId of regionTypes) {
        const sample = orig.regions.find((r) => r.typeId === typeId
          && orig.regions.filter((o) => o.name === r.name).length === 1);
        if (!sample) throw new Error(`region type ${typeId} 缺少唯一名样本`);
        const posX = sample.posX + 1.0;
        const posY = sample.posY + 2.0;
        const posZ = sample.posZ - 1.5;
        mutations.push({ kind: 'set_region_position', partName: sample.name, posX, posY, posZ });
        expectedRegions.set(sample.offset, { posX, posY, posZ });
      }

      const staged = join(staging, 'm11.mut.msb');
      const written = await runBridge({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 180_000,
        commandOptions: {
          outputPath: staged,
          expectedDocumentHash: orig.sourceHash,
          mutations
        }
      });
      if (!written.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
        throw new Error(`MSB 批量写回失败: ${JSON.stringify(written.diagnostics)}`);
      }

      const after = await runBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: staged,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      if (after.parseStatus === 'failed' || !after.data) {
        throw new Error(`mutated MSB reread failed: ${JSON.stringify(after.diagnostics)}`);
      }
      const updated = after.data;
      if (!updated.roundTrip?.semanticIdentical) {
        throw new Error(`mutated MSB semantic roundtrip failed: ${JSON.stringify(updated.roundTrip)}`);
      }
      if (updated.modelCount !== orig.modelCount || updated.partCount !== orig.partCount
        || updated.regionCount !== orig.regionCount || updated.eventCount !== orig.eventCount
        || updated.routeCount !== orig.routeCount) {
        throw new Error(`写回后实体计数变化: before=${JSON.stringify({ m: orig.modelCount, p: orig.partCount, r: orig.regionCount, e: orig.eventCount, rt: orig.routeCount })} after=${JSON.stringify({ m: updated.modelCount, p: updated.partCount, r: updated.regionCount, e: updated.eventCount, rt: updated.routeCount })}`);
      }

      // 未被修改 part 必须字节级不变；被修改 part 仅目标字段变化。
      // 以 nativeOffset 作为稳定身份（实体名不唯一，不得按 name 映射）。
      const stagedPartByOffset = new Map(updated.parts.map((p) => [p.offset, p]));
      for (const part of orig.parts) {
        const stagedPart = stagedPartByOffset.get(part.offset);
        if (!stagedPart) throw new Error(`写回后 part 丢失: offset=${part.offset} name=${part.name}`);
        const expected = expectedParts.get(part.offset);
        if (!expected) {
          assertPartEqual(stagedPart, part, `未修改 part ${part.name}`);
        } else {
          assertPartEqual(stagedPart, part, `修改 part ${part.name} 身份`);
          if (!close(stagedPart.posX, expected.posX) || !close(stagedPart.posY, expected.posY)
            || !close(stagedPart.posZ, expected.posZ)) {
            throw new Error(`修改 part ${part.name} 位置未按预期更新`);
          }
          if (stagedPart.rotX === undefined || !close(stagedPart.rotX, expected.rotX)
            || stagedPart.scaleX === undefined || !close(stagedPart.scaleX, expected.scaleX)
            || stagedPart.scaleY === undefined || !close(stagedPart.scaleY, expected.scaleY)
            || stagedPart.scaleZ === undefined || !close(stagedPart.scaleZ, expected.scaleZ)) {
            throw new Error(`修改 part ${part.name} 旋转/缩放未按预期更新`);
          }
        }
      }

      // 未被修改 region 必须不变；被修改 region 仅位置字段变化。
      const stagedRegionByOffset = new Map(updated.regions.map((r) => [r.offset, r]));
      for (const region of orig.regions) {
        const stagedRegion = stagedRegionByOffset.get(region.offset);
        if (!stagedRegion) throw new Error(`写回后 region 丢失: offset=${region.offset} name=${region.name}`);
        const expected = expectedRegions.get(region.offset);
        if (!expected) {
          assertRegionEqual(stagedRegion, region, `未修改 region ${region.name}`);
        } else {
          assertRegionEqual(stagedRegion, region, `修改 region ${region.name} 身份`);
          if (!close(stagedRegion.posX, expected.posX) || !close(stagedRegion.posY, expected.posY)
            || !close(stagedRegion.posZ, expected.posZ)) {
            throw new Error(`修改 region ${region.name} 位置未按预期更新`);
          }
        }
      }

      // models / events / routes 全部实体必须字节级不变。
      if (JSON.stringify(updated.models.map((e) => [e.name, e.offset, e.typeId]))
        !== JSON.stringify(orig.models.map((e) => [e.name, e.offset, e.typeId]))) {
        throw new Error('写回后 model 表变化');
      }
      if (JSON.stringify(updated.events.map((e) => [e.name, e.offset, e.typeId, e.eventId]))
        !== JSON.stringify(orig.events.map((e) => [e.name, e.offset, e.typeId, e.eventId]))) {
        throw new Error('写回后 event 表变化');
      }
      if (JSON.stringify(updated.routes.map((e) => [e.name, e.offset, e.typeId, e.id]))
        !== JSON.stringify(orig.routes.map((e) => [e.name, e.offset, e.typeId, e.id]))) {
        throw new Error('写回后 route 表变化');
      }

      // ---- 未注册实体守卫 fail-closed ----
      const unregisteredPart = orig.parts.find((p) => p.typeId === 0
        && orig.parts.filter((o) => o.name === p.name).length === 1)!;
      const unregisteredRegion = orig.regions.find((r) => r.typeId === 0
        && orig.regions.filter((o) => o.name === r.name).length === 1)!;
      const patchedPartBytes = Buffer.from(payload);
      patchedPartBytes.writeUInt32LE(99, unregisteredPart.offset + 0x08); // part type@+0x08
      const partPatchPath = join(staging, 'm11.unregistered-part.msb');
      await writeFile(partPatchPath, patchedPartBytes);
      const partPatchRead = await runBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: partPatchPath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      const patchedPart = partPatchRead.data?.parts.find((p) => p.name === unregisteredPart.name);
      if (partPatchRead.parseStatus === 'failed' || !patchedPart || patchedPart.typeId !== 99) {
        throw new Error(`未注册 part 补丁未能被解析为 typeId=99: ${JSON.stringify(partPatchRead.diagnostics)}`);
      }
      const partGuard = await runBridge({
        command: 'write-msb',
        filePath: partPatchPath,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 180_000,
        commandOptions: {
          outputPath: join(staging, 'm11.guarded-part.msb'),
          expectedDocumentHash: partPatchRead.data!.sourceHash,
          mutation: 'set_part_transform',
          partName: unregisteredPart.name,
          posX: 1, posY: 1, posZ: 1
        }
      });
      if (!partGuard.diagnostics.some((d) => d.code === 'MSB_UNREGISTERED_ENTITY_TYPE')) {
        throw new Error(`未注册 part 类型未 fail-closed: ${JSON.stringify(partGuard.diagnostics)}`);
      }

      const patchedRegionBytes = Buffer.from(payload);
      patchedRegionBytes.writeUInt32LE(99, unregisteredRegion.offset + 0x08); // region type@+0x08
      const regionPatchPath = join(staging, 'm11.unregistered-region.msb');
      await writeFile(regionPatchPath, patchedRegionBytes);
      const regionPatchRead = await runBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: regionPatchPath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      const patchedRegion = regionPatchRead.data?.regions.find((r) => r.name === unregisteredRegion.name);
      if (regionPatchRead.parseStatus === 'failed' || !patchedRegion || patchedRegion.typeId !== 99) {
        throw new Error(`未注册 region 补丁未能被解析为 typeId=99: ${JSON.stringify(regionPatchRead.diagnostics)}`);
      }
      const regionGuard = await runBridge({
        command: 'write-msb',
        filePath: regionPatchPath,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 180_000,
        commandOptions: {
          outputPath: join(staging, 'm11.guarded-region.msb'),
          expectedDocumentHash: regionPatchRead.data!.sourceHash,
          mutation: 'set_region_position',
          partName: unregisteredRegion.name,
          posX: 1, posY: 1, posZ: 1
        }
      });
      if (!regionGuard.diagnostics.some((d) => d.code === 'MSB_UNREGISTERED_ENTITY_TYPE')) {
        throw new Error(`未注册 region 类型未 fail-closed: ${JSON.stringify(regionGuard.diagnostics)}`);
      }

      console.log(JSON.stringify({
        ok: true,
        message: 'MSB writer 全覆盖往返通过：全部实体字节级无损，未注册类型编辑 fail-closed',
        authority: 'native-verified',
        partTypesCovered: partTypes,
        regionTypesCovered: regionTypes,
        mutationCount: mutations.length,
        entityCounts: {
          models: orig.modelCount,
          parts: orig.partCount,
          regions: orig.regionCount,
          events: orig.eventCount,
          routes: orig.routeCount
        },
        guard: {
          part: 'MSB_UNREGISTERED_ENTITY_TYPE',
          region: 'MSB_UNREGISTERED_ENTITY_TYPE',
          verified: true
        }
      }, null, 2));
  } finally {
    await workspace.dispose();
  }
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
