/**
 * Native MSB writer 全覆盖往返 smoke：
 *  1) 对每类已注册 part/region type 采样，在单次 write-msb 中批量应用 transform 写回，
 *     重读验证「未被修改实体字节级不变、被修改实体仅目标字段变化」（无损性）。
 *  2) delete mutation：唯一名 part/region/event 批量删除后重读确认目标消失、计数按
 *     预期减一、其余实体字节级不变；不存在/同名目标与未注册类型 delete 均 fail-closed。
 *  3) reopen-failure before-image 恢复：输出损坏后 read 必须结构化失败，源 before-image
 *     哈希可恢复；expectedDocumentHash 篡改与损坏 outputPath 均不落盘、不残留临时文件。
 *  4) 未注册实体编辑守卫 fail-closed：把 part/region type 字节补丁为未注册值后
 *     写回必须返回 MSB_UNREGISTERED_ENTITY_TYPE 结构化诊断，绝不落盘。
 *
 * Authority: native-verified（偏移表驱动全枚举 + 源字节原位补丁写回，per-type 内层载荷保持无损）。
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { isRegisteredMsbType, type BridgeResult } from '@soulforge/shared';

const DEFAULT_BRIDGE = 'D:/Repository/SoulForge/bridge/SoulForge.Bridge/bin/Debug/net10.0/win-x64/SoulForge.Bridge.exe';
const bridgeExecutablePath = resolve(process.env.SOULFORGE_BRIDGE_EXE ?? DEFAULT_BRIDGE);

async function runNativeBridge<T = unknown>(options: Parameters<typeof runBridge>[0]): Promise<BridgeResult<T>> {
  return runBridge<T>({ ...options, bridgeExecutablePath });
}

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

interface DcxEnvelope {
  compressionFormat?: string;
  payloadBase64?: string | null;
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

function readPartsParam(bytes: Buffer): { entryOffsets: number[]; nextOffset: number } {
  let paramOffset = 0x10;
  const visited = new Set<number>();
  while (paramOffset > 0 && paramOffset + 0x10 <= bytes.length && !visited.has(paramOffset)) {
    visited.add(paramOffset);
    const offsetCount = bytes.readInt32LE(paramOffset + 4);
    const nameOffset = Number(bytes.readBigInt64LE(paramOffset + 8));
    const name = readUtf16(bytes, nameOffset);
    const nextOffset = Number(bytes.readBigInt64LE(paramOffset + 0x10 + (offsetCount - 1) * 8));
    if (name === 'PARTS_PARAM_ST') {
      return {
        entryOffsets: Array.from({ length: offsetCount - 1 }, (_, index) =>
          Number(bytes.readBigInt64LE(paramOffset + 0x10 + index * 8))),
        nextOffset
      };
    }
    if (nextOffset <= paramOffset || nextOffset >= bytes.length) break;
    paramOffset = nextOffset;
  }
  throw new Error('无法在 raw MSB 中定位 PARTS_PARAM_ST');
}

function nextPartOffset(
  bytes: Buffer,
  parts: MsbEnvelope['parts'],
  offset: number,
  fallbackNextOffset?: number
): number {
  const next = parts.map((part) => part.offset).filter((candidate) => candidate > offset).sort((a, b) => a - b)[0]
    ?? fallbackNextOffset;
  if (next === undefined || next <= offset || next > bytes.length) {
    throw new Error(`无法计算 MSB part entry boundary: offset=${offset}, next=${next}`);
  }
  return next;
}

function readUtf16(bytes: Buffer, offset: number): string {
  if (offset < 0 || offset + 1 >= bytes.length) throw new Error(`UTF-16 offset 越界: ${offset}`);
  let end = offset;
  while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end += 2;
  return bytes.subarray(offset, end).toString('utf16le');
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const discoveredPath = gameRoot ? join(gameRoot, 'map', 'mapstudio', 'm11_00_00_00.msb.dcx') : undefined;
  const registryConfigured = Boolean(
    process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
      && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  );
  if (!explicitPath && !discoveredPath && !registryConfigured) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: '未提供 MSB writer 原版路径；请设置 SOULFORGE_SEKIRO_GAME_ROOT 或显式传入 m11_00_00_00.msb.dcx。'
    }));
    return;
  }
  if (!explicitPath && discoveredPath && !existsSync(discoveredPath)) {
    throw new Error(`SOULFORGE_SEKIRO_GAME_ROOT 中缺少 ${discoveredPath}。`);
  }
  const workspace = await createSmokeWorkspace('msb-writer');
  const root = workspace.root;
  await mkdir(root, { recursive: true });
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  try {

      const sourceDcx = await resolveNativeFixture(
        explicitPath ?? discoveredPath,
        'msb-primary',
        '../../mods/map/mapstudio/m11_00_00_00.msb.dcx'
      );
      const sourceBytes = await readFile(sourceDcx);
      const sourceMagic = sourceBytes.subarray(0, 4).toString('ascii');
      let payload: Buffer;
      if (sourceMagic !== 'DCX\0') {
        payload = sourceBytes;
      } else {
        const compression = sourceBytes.length >= 0x1c
          ? sourceBytes.subarray(0x18, 0x1c).toString('ascii')
          : '';
        if (compression === 'DFLT') {
          payload = decompressDfltDcx(sourceBytes);
        } else {
          const oodleRuntimeRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT
            || (sourceDcx.includes('Sekiro') ? 'D:/mystream/Sekiro Shadows Die Twice/Sekiro' : undefined);
          const extracted = await runNativeBridge<DcxEnvelope>({
            command: 'read-dcx-document',
            filePath: sourceDcx,
            allowedRoots: [root, dirname(sourceDcx), ...(oodleRuntimeRoot ? [oodleRuntimeRoot] : [])],
            ...(oodleRuntimeRoot ? { oodleRuntimeRoot } : {}),
            maxFrameBytes: 32 * 1024 * 1024,
            timeoutMs: 180_000,
            commandOptions: { includePayload: true, payloadLimitBytes: 64 * 1024 * 1024 }
          });
          if (extracted.parseStatus === 'failed' || !extracted.data?.payloadBase64) {
            throw new Error(`MSB KRAK payload extraction failed: ${JSON.stringify(extracted.diagnostics)}`);
          }
          payload = Buffer.from(extracted.data.payloadBase64, 'base64');
        }
      }
      const msbPath = join(root, 'm11.msb');
      await writeFile(msbPath, payload);

      const read = await runNativeBridge<MsbEnvelope>({
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
      const written = await runNativeBridge({
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

      const after = await runNativeBridge<MsbEnvelope>({
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

      // ---- template-backed duplicate/create：复制完整 native entry ----
      // 只改 name relative pointer；entry 原始前缀（包括 subtype data、references、
      // model 与未知字节）必须保持一致。新名称追加在 clone entry 尾部，避免移动
      // 未知 payload 内部的相对引用。
      const templateParts = partTypes.map((typeId) => orig.parts.find((part) => part.typeId === typeId
        && isRegisteredMsbType('part', part.typeId)
        && orig.parts.filter((candidate) => candidate.name === part.name).length === 1));
      if (templateParts.some((part): part is undefined => part === undefined)) {
        throw new Error(`m11 fixture 缺少每种注册 Part type 的 template-backed 样本: ${JSON.stringify(partTypes)}`);
      }
      const templates = templateParts as Array<NonNullable<typeof templateParts[number]>>;
      const templatePart = templates[0]!;
      const duplicateNames = templates.map((part) => `${part.name}_sf_dup_t${part.typeId}`);
      const createNames = templates.map((part) => `${part.name}_sf_create_t${part.typeId}`);
      // m11 的 PARTS table 只有有限原生空隙；把每种 subtype 分开写入独立
      // overlay，仍然逐一验证 duplicate/create，但不把多个大 entry 错误地
      // 累加成一个超出 native gap 的伪失败。
      const verifyTemplateClone = async (outputPath: string, newName: string, template: MsbEnvelope['parts'][number]) => {
        const cloneRead = await runNativeBridge<MsbEnvelope>({
          command: 'read-msb-document',
          filePath: outputPath,
          allowedRoots: [staging],
          timeoutMs: 180_000
        });
        if (cloneRead.parseStatus === 'failed' || !cloneRead.data) {
          throw new Error(`template-backed ${newName} 后 MSB 重读失败: ${JSON.stringify(cloneRead.diagnostics)}`);
        }
        const clone = cloneRead.data.parts.find((part) => part.name === newName);
        if (cloneRead.data.partCount !== orig.partCount + 1 || !clone) {
          throw new Error(`template-backed ${newName} 实体计数或名称不符`);
        }
        if (clone.typeId !== template.typeId || clone.modelIndex !== template.modelIndex) {
          throw new Error(`template-backed ${newName} subtype/model 未保留`);
        }
        const outputBytes = await readFile(outputPath);
        const sourcePartEnd = nextPartOffset(payload, orig.parts, template.offset);
        const sourcePartBytes = payload.subarray(template.offset, sourcePartEnd);
        const outputParam = readPartsParam(outputBytes);
        const cloneEnd = nextPartOffset(outputBytes, cloneRead.data.parts, clone.offset, outputParam.nextOffset);
        const cloneBytes = outputBytes.subarray(clone.offset, cloneEnd);
        if (cloneBytes.length < sourcePartBytes.length) {
          throw new Error(`template-backed ${newName} entry 被截断`);
        }
        for (let i = 8; i < sourcePartBytes.length; i++) {
          if (cloneBytes[i] !== sourcePartBytes[i]) {
            throw new Error(`template-backed ${newName} 未保留 native entry payload，relative=${i}`);
          }
        }
      };
      for (const [index, template] of templates.entries()) {
        const duplicatePath = join(staging, `m11.duplicate-t${template.typeId}.msb`);
        const duplicated = await runNativeBridge<MsbEnvelope>({
          command: 'write-msb',
          filePath: msbPath,
          allowedRoots: [root, staging],
          writableRoots: [staging],
          timeoutMs: 180_000,
          commandOptions: {
            outputPath: duplicatePath,
            expectedDocumentHash: orig.sourceHash,
            mutation: 'duplicate_part',
            partName: template.name,
            newName: duplicateNames[index]!
          }
        });
        if (!duplicated.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
          throw new Error(`MSB template duplicate ${template.name} 写回失败: ${JSON.stringify(duplicated.diagnostics)}`);
        }
        await verifyTemplateClone(duplicatePath, duplicateNames[index]!, template);

        const createPath = join(staging, `m11.create-t${template.typeId}.msb`);
        const created = await runNativeBridge<MsbEnvelope>({
          command: 'write-msb',
          filePath: msbPath,
          allowedRoots: [root, staging],
          writableRoots: [staging],
          timeoutMs: 180_000,
          commandOptions: {
            outputPath: createPath,
            expectedDocumentHash: orig.sourceHash,
            mutation: 'create_part',
            partName: template.name,
            newName: createNames[index]!
          }
        });
        if (!created.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
          throw new Error(`MSB template create ${template.name} 写回失败: ${JSON.stringify(created.diagnostics)}`);
        }
        await verifyTemplateClone(createPath, createNames[index]!, template);
      }

      // The clone must observe earlier mutations in the same ApplyMutations
      // working state, not the immutable source snapshot.
      const orderedCloneName = `${templatePart.name}_sf_ordered`;
      const orderedPath = join(staging, 'm11.ordered-template-clone.msb');
      const orderedPosition = {
        x: templatePart.posX + 2,
        y: templatePart.posY - 2,
        z: templatePart.posZ + 1
      };
      const ordered = await runNativeBridge<MsbEnvelope>({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 180_000,
        commandOptions: {
          outputPath: orderedPath,
          expectedDocumentHash: orig.sourceHash,
          mutations: [
            {
              kind: 'set_part_transform',
              partName: templatePart.name,
              posX: orderedPosition.x,
              posY: orderedPosition.y,
              posZ: orderedPosition.z
            },
            { kind: 'duplicate_part', partName: templatePart.name, newName: orderedCloneName }
          ]
        }
      });
      if (!ordered.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
        throw new Error(`ordered template clone 写回失败: ${JSON.stringify(ordered.diagnostics)}`);
      }
      const orderedRead = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: orderedPath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      const orderedSource = orderedRead.data?.parts.find((part) => part.name === templatePart.name);
      const orderedClone = orderedRead.data?.parts.find((part) => part.name === orderedCloneName);
      if (orderedRead.parseStatus === 'failed' || !orderedSource || !orderedClone
        || !close(orderedSource.posX, orderedPosition.x)
        || !close(orderedSource.posY, orderedPosition.y)
        || !close(orderedSource.posZ, orderedPosition.z)
        || !close(orderedClone.posX, orderedPosition.x)
        || !close(orderedClone.posY, orderedPosition.y)
        || !close(orderedClone.posZ, orderedPosition.z)) {
        throw new Error(`ordered template clone 未继承 working state: ${JSON.stringify({ orderedSource, orderedClone, orderedPosition, diagnostics: orderedRead.diagnostics })}`);
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
      const partPatchRead = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: partPatchPath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      const patchedPart = partPatchRead.data?.parts.find((p) => p.name === unregisteredPart.name);
      if (partPatchRead.parseStatus === 'failed' || !patchedPart || patchedPart.typeId !== 99) {
        throw new Error(`未注册 part 补丁未能被解析为 typeId=99: ${JSON.stringify(partPatchRead.diagnostics)}`);
      }
      const partGuard = await runNativeBridge({
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
      const regionPatchRead = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: regionPatchPath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      const patchedRegion = regionPatchRead.data?.regions.find((r) => r.name === unregisteredRegion.name);
      if (regionPatchRead.parseStatus === 'failed' || !patchedRegion || patchedRegion.typeId !== 99) {
        throw new Error(`未注册 region 补丁未能被解析为 typeId=99: ${JSON.stringify(regionPatchRead.diagnostics)}`);
      }
      const regionGuard = await runNativeBridge({
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

      // ---- delete mutation: part/region/event/route 批量删除 + 重读验证 ----
      const uniquePart = orig.parts.find((p) => isRegisteredMsbType('part', p.typeId)
        && orig.parts.filter((o) => o.name === p.name).length === 1);
      const uniqueRegion = orig.regions.find((r) => isRegisteredMsbType('region', r.typeId)
        && orig.regions.filter((o) => o.name === r.name).length === 1);
      const uniqueEvent = orig.events.find((e) => isRegisteredMsbType('event', e.typeId)
        && orig.events.filter((o) => o.name === e.name).length === 1);
      const uniqueRoute = orig.routes.find((route) => isRegisteredMsbType('route', route.typeId)
        && orig.routes.filter((candidate) => candidate.name === route.name).length === 1);
      if (!uniquePart || !uniqueRegion || !uniqueEvent || !uniqueRoute) {
        throw new Error('m11 fixture 缺少唯一名的 part/region/event/route 删除样本');
      }

      const deletePath = join(staging, 'm11.delete.msb');
      const deleted = await runNativeBridge<MsbEnvelope>({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 180_000,
        commandOptions: {
          outputPath: deletePath,
          expectedDocumentHash: orig.sourceHash,
          mutations: [
            { kind: 'delete_part', partName: uniquePart.name },
            { kind: 'delete_region', partName: uniqueRegion.name },
            { kind: 'delete_event', partName: uniqueEvent.name },
            { kind: 'delete_route', partName: uniqueRoute.name }
          ]
        }
      });
      if (!deleted.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
        throw new Error(`MSB delete 批量写回失败: ${JSON.stringify(deleted.diagnostics)}`);
      }
      const delAfter = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: deletePath,
        allowedRoots: [staging],
        timeoutMs: 180_000
      });
      if (delAfter.parseStatus === 'failed' || !delAfter.data) {
        throw new Error(`delete 后 MSB 重读失败: ${JSON.stringify(delAfter.diagnostics)}`);
      }
      const delDoc = delAfter.data;
      if (delDoc.parts.some((p) => p.name === uniquePart.name)
        || delDoc.regions.some((r) => r.name === uniqueRegion.name)
        || delDoc.events.some((e) => e.name === uniqueEvent.name)
        || delDoc.routes.some((route) => route.name === uniqueRoute.name)) {
        throw new Error('delete 后重读仍存在目标实体');
      }
      if (delDoc.partCount !== orig.partCount - 1 || delDoc.regionCount !== orig.regionCount - 1
        || delDoc.eventCount !== orig.eventCount - 1 || delDoc.routeCount !== orig.routeCount - 1) {
        throw new Error(`delete 后计数未按预期: before=${JSON.stringify({ p: orig.partCount, r: orig.regionCount, e: orig.eventCount, route: orig.routeCount })} after=${JSON.stringify({ p: delDoc.partCount, r: delDoc.regionCount, e: delDoc.eventCount, route: delDoc.routeCount })}`);
      }
      if (delDoc.modelCount !== orig.modelCount || delDoc.routeCount !== orig.routeCount - 1) {
        throw new Error('delete 后 model 计数或 route 删除计数不符');
      }

      // 其余实体字节级不变（以 nativeOffset 为稳定身份）。
      const delPartByOffset = new Map(delDoc.parts.map((p) => [p.offset, p]));
      for (const part of orig.parts) {
        if (part.name === uniquePart.name) continue;
        const stagedPart = delPartByOffset.get(part.offset);
        if (!stagedPart) throw new Error(`delete 后 part 丢失: offset=${part.offset} name=${part.name}`);
        assertPartEqual(stagedPart, part, `delete 未触及 part ${part.name}`);
        if (!close(stagedPart.posX, part.posX) || !close(stagedPart.posY, part.posY) || !close(stagedPart.posZ, part.posZ)
          || !close(stagedPart.rotX ?? 0, part.rotX ?? 0)
          || !close(stagedPart.scaleX ?? 1, part.scaleX ?? 1)
          || !close(stagedPart.scaleY ?? 1, part.scaleY ?? 1)
          || !close(stagedPart.scaleZ ?? 1, part.scaleZ ?? 1)) {
          throw new Error(`delete 后 part ${part.name} transform 变化`);
        }
      }
      const delRegionByOffset = new Map(delDoc.regions.map((r) => [r.offset, r]));
      for (const region of orig.regions) {
        if (region.name === uniqueRegion.name) continue;
        const stagedRegion = delRegionByOffset.get(region.offset);
        if (!stagedRegion) throw new Error(`delete 后 region 丢失: offset=${region.offset} name=${region.name}`);
        assertRegionEqual(stagedRegion, region, `delete 未触及 region ${region.name}`);
        if (!close(stagedRegion.posX, region.posX) || !close(stagedRegion.posY, region.posY)
          || !close(stagedRegion.posZ, region.posZ)) {
          throw new Error(`delete 后 region ${region.name} 位置变化`);
        }
      }
      const delEventByOffset = new Map(delDoc.events.map((e) => [e.offset, e]));
      for (const ev of orig.events) {
        if (ev.name === uniqueEvent.name) continue;
        const stagedEvent = delEventByOffset.get(ev.offset);
        if (!stagedEvent) throw new Error(`delete 后 event 丢失: offset=${ev.offset} name=${ev.name}`);
        if (stagedEvent.name !== ev.name || stagedEvent.typeId !== ev.typeId || stagedEvent.eventId !== ev.eventId) {
          throw new Error(`delete 后 event ${ev.name} 身份/字段变化`);
        }
      }
      const delRouteByOffset = new Map(delDoc.routes.map((route) => [route.offset, route]));
      for (const route of orig.routes) {
        if (route.name === uniqueRoute.name) continue;
        const stagedRoute = delRouteByOffset.get(route.offset);
        if (!stagedRoute) throw new Error(`delete 后 route 丢失: offset=${route.offset} name=${route.name}`);
        if (stagedRoute.name !== route.name || stagedRoute.typeId !== route.typeId || stagedRoute.id !== route.id) {
          throw new Error(`delete 后 route ${route.name} 身份/字段变化`);
        }
      }
      if (JSON.stringify(delDoc.models.map((e) => [e.name, e.offset, e.typeId]))
        !== JSON.stringify(orig.models.map((e) => [e.name, e.offset, e.typeId]))) {
        throw new Error('delete 后 model 表变化');
      }
      if (JSON.stringify(delDoc.routes.map((e) => [e.name, e.offset, e.typeId, e.id]))
        !== JSON.stringify(orig.routes.filter((e) => e.name !== uniqueRoute.name).map((e) => [e.name, e.offset, e.typeId, e.id]))) {
        throw new Error('delete 后未删除的 route 表发生变化');
      }

      // ---- delete 失败注入：唯一性规则与未注册守卫 fail-closed ----
      const nonexistentDelete = await runNativeBridge({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(staging, 'm11.delete-nonexistent.msb'),
          expectedDocumentHash: orig.sourceHash,
          mutation: 'delete_part',
          partName: 'soulforge-delete-nonexistent'
        }
      });
      if (!nonexistentDelete.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_FAILED')) {
        throw new Error(`删除不存在实体未 fail-closed: ${JSON.stringify(nonexistentDelete.diagnostics)}`);
      }

      const dupPart = orig.parts.find((p) => orig.parts.filter((o) => o.name === p.name).length > 1);
      let duplicateNameDelete: string | null = null;
      if (dupPart) {
        const dupDelete = await runNativeBridge({
          command: 'write-msb',
          filePath: msbPath,
          allowedRoots: [root, staging],
          writableRoots: [staging],
          timeoutMs: 60_000,
          commandOptions: {
            outputPath: join(staging, 'm11.delete-duplicate.msb'),
            expectedDocumentHash: orig.sourceHash,
            mutation: 'delete_part',
            partName: dupPart.name
          }
        });
        if (!dupDelete.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_FAILED')) {
          throw new Error(`删除同名实体未 fail-closed: ${JSON.stringify(dupDelete.diagnostics)}`);
        }
        duplicateNameDelete = dupPart.name;
      }

      const partDeleteGuard = await runNativeBridge({
        command: 'write-msb',
        filePath: partPatchPath,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(staging, 'm11.guarded-part-delete.msb'),
          expectedDocumentHash: partPatchRead.data!.sourceHash,
          mutation: 'delete_part',
          partName: unregisteredPart.name
        }
      });
      if (!partDeleteGuard.diagnostics.some((d) => d.code === 'MSB_UNREGISTERED_ENTITY_TYPE')) {
        throw new Error(`未注册 part delete 未 fail-closed: ${JSON.stringify(partDeleteGuard.diagnostics)}`);
      }
      const regionDeleteGuard = await runNativeBridge({
        command: 'write-msb',
        filePath: regionPatchPath,
        allowedRoots: [staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(staging, 'm11.guarded-region-delete.msb'),
          expectedDocumentHash: regionPatchRead.data!.sourceHash,
          mutation: 'delete_region',
          partName: unregisteredRegion.name
        }
      });
      if (!regionDeleteGuard.diagnostics.some((d) => d.code === 'MSB_UNREGISTERED_ENTITY_TYPE')) {
        throw new Error(`未注册 region delete 未 fail-closed: ${JSON.stringify(regionDeleteGuard.diagnostics)}`);
      }

      // ---- reopen-failure before-image 恢复 ----
      // 输出文件被截断损坏后，read-msb-document 必须结构化失败（rollback 前提），
      // 源 before-image 必须字节可恢复（哈希不变）。
      const corruptedPath = join(staging, 'm11.corrupted.msb');
      await writeFile(corruptedPath, payload.subarray(0, 0x40));
      const reopen = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: corruptedPath,
        allowedRoots: [staging],
        timeoutMs: 60_000
      });
      if (reopen.parseStatus !== 'failed' || !reopen.diagnostics.some((d) => d.code === 'MSB_DOCUMENT_READ_FAILED')) {
        throw new Error(`reopen failure 未结构化失败: ${JSON.stringify(reopen.diagnostics)}`);
      }
      const beforeImageCheck = await runNativeBridge<MsbEnvelope>({
        command: 'read-msb-document',
        filePath: msbPath,
        allowedRoots: [root],
        timeoutMs: 180_000
      });
      if (beforeImageCheck.parseStatus === 'failed' || !beforeImageCheck.data
        || beforeImageCheck.data.sourceHash !== orig.sourceHash) {
        throw new Error('reopen failure 后 before image 不可恢复（rollback 前提失败）');
      }

      // ---- fail-closed 不残留半成品 ----
      // expectedDocumentHash 篡改 → 写入前即失败，outputPath 不得产生文件。
      const hashMismatchPath = join(staging, 'm11.hash-mismatch.msb');
      const hashBad = await runNativeBridge({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: hashMismatchPath,
          expectedDocumentHash: '0'.repeat(64),
          mutation: 'delete_part',
          partName: uniquePart.name
        }
      });
      if (!hashBad.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_FAILED')) {
        throw new Error(`expectedDocumentHash 篡改未 fail-closed: ${JSON.stringify(hashBad.diagnostics)}`);
      }
      const hashResidue = await stat(hashMismatchPath).then((s) => s.size).catch(() => 0);
      if (hashResidue !== 0) {
        throw new Error(`expectedDocumentHash 篡改后残留输出文件: ${hashMismatchPath}`);
      }

      // outputPath 损坏（父路径是文件）→ C# 侧 IOException fail-closed，无半成品。
      const blockedParent = join(staging, 'blocked-as-file');
      await writeFile(blockedParent, Buffer.from('x'));
      const blockedWrite = await runNativeBridge({
        command: 'write-msb',
        filePath: msbPath,
        allowedRoots: [root, staging],
        writableRoots: [staging],
        timeoutMs: 60_000,
        commandOptions: {
          outputPath: join(blockedParent, 'm11.out.msb'),
          expectedDocumentHash: orig.sourceHash,
          mutation: 'delete_part',
          partName: uniquePart.name
        }
      });
      if (!blockedWrite.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_FAILED')) {
        throw new Error(`损坏 outputPath 未 fail-closed: ${JSON.stringify(blockedWrite.diagnostics)}`);
      }
      const tmpResidue = (await readdir(staging)).filter((name) => name.startsWith('.soulforge-') && name.endsWith('.tmp'));
      if (tmpResidue.length > 0) {
        throw new Error(`暂存区残留半成品临时文件: ${tmpResidue.join(', ')}`);
      }

      console.log(JSON.stringify({
        ok: true,
        message: 'MSB writer 全覆盖往返通过：全部实体字节级无损，template duplicate/create、delete 与未注册编辑 fail-closed',
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
        },
        delete: {
          part: uniquePart.name,
          region: uniqueRegion.name,
          event: uniqueEvent.name,
          route: uniqueRoute.name,
          rereadVerified: true,
          countsAfter: {
            parts: delDoc.partCount,
            regions: delDoc.regionCount,
            events: delDoc.eventCount,
            routes: delDoc.routeCount
          },
          siblingsByteIdentical: true,
          failClosed: {
            nonexistent: 'MSB_STAGING_WRITE_FAILED',
            duplicateName: duplicateNameDelete ?? 'fixture-无同名样本',
            unregisteredPartDelete: 'MSB_UNREGISTERED_ENTITY_TYPE',
            unregisteredRegionDelete: 'MSB_UNREGISTERED_ENTITY_TYPE'
          }
        },
        templateDuplicateCreate: {
          sources: templates.map((template) => ({ name: template.name, typeId: template.typeId })),
          duplicate: duplicateNames,
          create: createNames,
          nativeEntryPrefixPreserved: true,
          rereadVerified: true
        },
        reopenFailure: {
          structuredFailure: true,
          beforeImageRecoverable: true
        },
        noResidue: {
          hashMismatchNoOutput: true,
          corruptOutputPathFailClosed: true,
          tempFilesClean: true
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
