/**
 * MSB models/parts parse + part position mutation smoke.
 * Authority: native-verified for part-transform write path on the real mods
 * DFLT .msb.dcx corpus sample（外层 DCX 直读 + DCX outer 写回）。
 * S19: read/write 直接走 .msb.dcx（Bridge 原生解 DCX），TS 侧不再 decompressDfltDcx。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { withSmokeWorkspace } from './harness/smokeWorkspace.js';
import { dirname, join } from 'node:path';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { readMsbDocumentViaBridge } from '../editing/msbBridgeRead.js';
import { buildMsbSceneManifest } from '../scene/msbSceneManifest.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  isRegisteredMsbType,
  type MsbEntityFamilyKey
} from '@soulforge/shared';

interface MsbEnvelope {
  sourceHash: string;
  version: number;
  modelCount: number;
  partCount: number;
  regionCount?: number;
  eventCount?: number;
  routeCount?: number;
  authority: string;
  entityEdit: string;
  models: Array<{ name: string; offset: number; sibPath?: string; typeId: number }>;
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
  regions?: Array<{ name: string; offset: number; typeId: number; posX: number; posY: number; posZ: number }>;
  events?: Array<{ name: string; offset: number; typeId: number }>;
  routes?: Array<{ name: string; offset: number; typeId: number; id?: number }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

function projectNativeScene(envelope: MsbEnvelope) {
  return buildMsbSceneManifest({
    sourceUri: 'file://map/m10.msb',
    sourcePath: 'map/mapstudio/m10.msb',
    game: 'sekiro',
    resourceKind: 'map',
    revision: envelope.sourceHash,
    models: envelope.models.map((model) => ({
      name: model.name,
      nativeOffset: model.offset,
      typeId: model.typeId
    })),
    parts: envelope.parts.map((part) => ({
      name: part.name,
      nativeOffset: part.offset,
      typeId: part.typeId,
      posX: part.posX,
      posY: part.posY,
      posZ: part.posZ,
      ...(part.rotX === undefined ? {} : { rotX: part.rotX }),
      ...(part.scaleX === undefined ? {} : { scaleX: part.scaleX }),
      ...(part.scaleY === undefined ? {} : { scaleY: part.scaleY }),
      ...(part.scaleZ === undefined ? {} : { scaleZ: part.scaleZ })
    })),
    regions: (envelope.regions ?? []).map((region) => ({
      name: region.name,
      nativeOffset: region.offset,
      typeId: region.typeId,
      posX: region.posX,
      posY: region.posY,
      posZ: region.posZ
    })),
    events: (envelope.events ?? []).map((event) => ({
      name: event.name,
      nativeOffset: event.offset,
      typeId: event.typeId
    })),
    sourceCounts: {
      models: envelope.modelCount,
      parts: envelope.partCount,
      regions: envelope.regionCount ?? 0,
      events: envelope.eventCount ?? 0
    }
  });
}

/**
 * S19：外层 .dcx 写回的暂存产物必须是 DCX outer（Patch 目标是外层字节），
 * 不能是裸 MSB payload。魔数断言在 TS 侧做，防 Bridge 写链退化成 raw 输出。
 */
async function assertDcxOuter(path: string): Promise<void> {
  const bytes = await readFile(path);
  if (bytes.length < 4 || bytes.subarray(0, 4).toString('ascii') !== 'DCX\0') {
    throw new Error(`MSB 写回产物不是 DCX outer（magic 缺失）：${path}`);
  }
}

function main(): Promise<void> {
  return withSmokeWorkspace('native-msb', (workspace) => mainInWorkspace(workspace.root));
}

async function mainInWorkspace(root: string): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  const discoveredPath = gameRoot ? join(gameRoot, 'map', 'mapstudio', 'm10_00_00_00.msb.dcx') : undefined;
  const registryConfigured = Boolean(
    process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim()
      && process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim()
  );
  if (!explicitPath && !discoveredPath && !registryConfigured) {
    console.log(JSON.stringify({
      ok: true,
      status: 'NOT_RUN_ENVIRONMENTAL',
      message: '未提供 MSB 原版路径；请设置 SOULFORGE_SEKIRO_GAME_ROOT 或显式传入 m10_00_00_00.msb.dcx。'
    }));
    return;
  }
  if (!explicitPath && discoveredPath && !existsSync(discoveredPath)) {
    throw new Error(`SOULFORGE_SEKIRO_GAME_ROOT 中缺少 ${discoveredPath}。`);
  }
  const sourceDcx = await resolveNativeFixture(
    explicitPath ?? discoveredPath,
    'msb-primary',
    '../../mods/map/mapstudio/m10_00_00_00.msb.dcx'
  );
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  // S19：直接喂外层 .msb.dcx —— NativeLeafPayload.Resolve 在 Bridge 侧解 DCX，
  // TS 不再先 decompressDfltDcx 再喂裸 .msb。这条链必须能开 mods 里的 DFLT 图。
  const msbPath = sourceDcx;
  const fixtureDir = dirname(sourceDcx);
  const oodleRoot = process.env.SOULFORGE_OODLE_RUNTIME_ROOT || (sourceDcx.includes('Sekiro') ? 'D:/mystream/Sekiro Shadows Die Twice/Sekiro' : undefined);

  const read = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: msbPath,
    allowedRoots: [root, fixtureDir, ...(oodleRoot ? [oodleRoot] : [])],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000
  });
  if (read.parseStatus === 'failed' || !read.data) {
    throw new Error(`MSB read failed: ${JSON.stringify(read.diagnostics)}`);
  }
  if (!read.data.roundTrip?.semanticIdentical) {
    throw new Error(`MSB semantic roundtrip failed: ${JSON.stringify(read.data.roundTrip)}`);
  }
  if (read.data.modelCount < 1 || read.data.partCount < 1) {
    throw new Error(`MSB expected models/parts, got models=${read.data.modelCount} parts=${read.data.partCount}`);
  }
  if (!read.data.entityEdit.includes('part-transform')) {
    throw new Error(`unexpected entityEdit: ${read.data.entityEdit}`);
  }
  // 注册表覆盖：真实实体 type 必须全部落在权威注册表内（负向由 writer 守卫 smoke 覆盖）。
  const families: Array<{ family: MsbEntityFamilyKey; samples: Array<{ name: string; typeId: number }> }> = [
    { family: 'model', samples: read.data.models },
    { family: 'part', samples: read.data.parts },
    { family: 'region', samples: read.data.regions ?? [] },
    { family: 'event', samples: read.data.events ?? [] },
    { family: 'route', samples: read.data.routes ?? [] }
  ];
  for (const { family, samples } of families) {
    for (const sample of samples) {
      if (!isRegisteredMsbType(family, sample.typeId)) {
        throw new Error(`未注册实体类型 ${family}/${sample.typeId}（${sample.name}）`);
      }
    }
  }
  const typeCoverage = families.reduce<Record<string, number>>((acc, { family, samples }) => {
    acc[family] = new Set(samples.map((s) => s.typeId)).size;
    return acc;
  }, {});

  // renderer-safe DTO 默认完整返回（三层截断已移除），nativeOffset 身份必须保留。
  const rendererRead = await readMsbDocumentViaBridge({
    sourcePath: msbPath,
    allowedRoots: [root, fixtureDir],
    timeoutMs: 120_000
  });
  if (!rendererRead.ok || !rendererRead.data
    || rendererRead.data.models.length !== read.data.modelCount
    || rendererRead.data.parts.length !== read.data.partCount
    || rendererRead.data.regions.length !== (read.data.regionCount ?? 0)
    || rendererRead.data.events.length !== (read.data.eventCount ?? 0)
    || rendererRead.data.routes.length !== (read.data.routeCount ?? 0)
    || rendererRead.data.parts.some((item) => item.nativeOffset === undefined)
    || rendererRead.data.regions.some((item) => item.nativeOffset === undefined)
    || rendererRead.data.routes.some((item) => item.nativeOffset === undefined)) {
    throw new Error(`renderer-safe MSB DTO 未完整返回或丢失 native identity: ${JSON.stringify(rendererRead)}`);
  }
  // 显式有界窗口（scaleAccess=bounded-window）仍按调用方窗口截断。
  const boundedRead = await readMsbDocumentViaBridge({
    sourcePath: msbPath,
    allowedRoots: [root, fixtureDir],
    timeoutMs: 120_000,
    maxModels: 64,
    maxParts: 64,
    maxRegions: 64,
    maxEvents: 64
  });
  if (!boundedRead.ok || !boundedRead.data) {
    throw new Error(`bounded-window MSB DTO 读取失败: ${JSON.stringify(boundedRead.diagnostics)}`);
  }
  if (boundedRead.data.parts.length > 64 || boundedRead.data.models.length > 64
    || boundedRead.data.regions.length > 64 || boundedRead.data.events.length > 64) {
    throw new Error('bounded-window MSB DTO 超出显式窗口');
  }
  const sceneBefore = projectNativeScene(read.data);
  if (sceneBefore.diagnostics.some((item) => item.code === 'SCENE_PROJECTION_PARTIAL')) {
    throw new Error('三层截断移除后 native 投影必须是完整投影，不得出现 SCENE_PROJECTION_PARTIAL');
  }
  if (sceneBefore.diagnostics.some((item) => item.code === 'SCENE_IDENTITY_FALLBACK')) {
    throw new Error('native MSB entities must retain offset-backed identity');
  }
  if (!sceneBefore.entities.some((entity) => entity.kind === 'msb-model')
    || !sceneBefore.entities.some((entity) => entity.kind === 'msb-event')
    || !sceneBefore.nodes.some((node) => node.kind === 'msb-region')) {
    throw new Error('native scene projection must include model/part/region/event entities');
  }

  const part = read.data.parts[0];
  if (!part) throw new Error('no part preview');
  const nextX = part.posX + 1.5;
  const nextY = part.posY - 0.25;
  const nextZ = part.posZ + 0.75;
  const staged = join(staging, 'm10.mut.msb.dcx');
  const written = await runBridge({
    command: 'write-msb',
    filePath: msbPath,
    allowedRoots: [root, staging, fixtureDir, ...(oodleRoot ? [oodleRoot] : [])],
    writableRoots: [staging],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: staged,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'set_part_position',
      partName: part.name,
      posX: nextX,
      posY: nextY,
      posZ: nextZ
    }
  });
  if (!written.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
    throw new Error(`MSB write failed: ${JSON.stringify(written.diagnostics)}`);
  }
  if ((written.data as { sourceFormat?: string } | null | undefined)?.sourceFormat !== 'dcx') {
    throw new Error(`MSB DCX 写回未走 outer 路径: ${JSON.stringify(written.data)}`);
  }
  // S19：外层源是 .msb.dcx 时，暂存产物必须仍是 DCX outer（patch 目标字节），
  // 不能裸写 MSB payload。
  await assertDcxOuter(staged);

  const after = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: staged,
    allowedRoots: [staging, ...(oodleRoot ? [oodleRoot] : [])],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000
  });
  const updated = after.data?.parts.find((p) => p.name === part.name);
  if (!updated) throw new Error('mutated part missing on reread');
  const close = (a: number, b: number) => Math.abs(a - b) < 0.001;
  if (!close(updated.posX, nextX) || !close(updated.posY, nextY) || !close(updated.posZ, nextZ)) {
    throw new Error(`position not updated: ${JSON.stringify(updated)}`);
  }
  // Sibling first model name stable
  if (after.data?.models[0]?.name !== read.data.models[0]?.name) {
    throw new Error('model table corrupted by part write');
  }
  if (after.data?.partCount !== read.data.partCount) {
    throw new Error('part count changed unexpectedly');
  }
  if (!after.data) throw new Error('mutated MSB envelope missing');
  const sceneAfter = projectNativeScene(after.data);
  const beforePartId = sceneBefore.nodes.find((node) => node.nativeOffset === part.offset)?.id;
  const afterPartId = sceneAfter.nodes.find((node) => node.nativeOffset === part.offset)?.id;
  if (!beforePartId || beforePartId !== afterPartId) {
    throw new Error('part scene identity changed after transform-only mutation');
  }

  if ((read.data.regionCount ?? 0) < 1) {
    throw new Error(`expected regions, got ${read.data.regionCount}`);
  }
  if ((read.data.eventCount ?? 0) < 1) {
    throw new Error(`expected map events, got ${read.data.eventCount}`);
  }
  if ((read.data.routeCount ?? 0) < 1 || (read.data.routes?.length ?? 0) < 1) {
    throw new Error(`expected routes, got ${read.data.routeCount}`);
  }
  const region = read.data.regions?.[0];
  if (!region) throw new Error('no region sample');
  const rX = region.posX + 2.25;
  const rY = region.posY + 1.0;
  const rZ = region.posZ - 0.5;
  const stagedRegion = join(staging, 'm10.region.msb.dcx');
  const writtenRegion = await runBridge({
    command: 'write-msb',
    filePath: msbPath,
    allowedRoots: [root, staging, fixtureDir, ...(oodleRoot ? [oodleRoot] : [])],
    writableRoots: [staging],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: stagedRegion,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'set_region_position',
      partName: region.name,
      posX: rX,
      posY: rY,
      posZ: rZ
    }
  });
  if (!writtenRegion.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
    throw new Error(`MSB region write failed: ${JSON.stringify(writtenRegion.diagnostics)}`);
  }
  await assertDcxOuter(stagedRegion);
  const afterRegion = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: stagedRegion,
    allowedRoots: [staging, ...(oodleRoot ? [oodleRoot] : [])],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000
  });
  const updatedRegion = afterRegion.data?.regions?.find((r) => r.name === region.name);
  if (!updatedRegion) throw new Error('region missing after write');
  if (!close(updatedRegion.posX, rX) || !close(updatedRegion.posY, rY) || !close(updatedRegion.posZ, rZ)) {
    throw new Error(`region position not updated: ${JSON.stringify(updatedRegion)}`);
  }
  if (afterRegion.data?.eventCount !== read.data.eventCount) {
    throw new Error('event count changed by region write');
  }

  // set_part_transform: rotation/scale fields must survive and be re-read
  // verified by the writer (rotX/scaleX/scaleY/scaleZ).
  if (part.rotX === undefined || part.scaleX === undefined
    || part.scaleY === undefined || part.scaleZ === undefined) {
    throw new Error('part envelope missing rot/scale fields');
  }
  const nextRotX = part.rotX + 0.5;
  const nextScaleX = part.scaleX * 1.05;
  const nextScaleY = part.scaleY * 1.1;
  const nextScaleZ = part.scaleZ * 0.95;
  const stagedTransform = join(staging, 'm10.transform.msb.dcx');
  const writtenTransform = await runBridge({
    command: 'write-msb',
    filePath: msbPath,
    allowedRoots: [root, staging, fixtureDir, ...(oodleRoot ? [oodleRoot] : [])],
    writableRoots: [staging],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000,
    commandOptions: {
      outputPath: stagedTransform,
      expectedDocumentHash: read.data.sourceHash,
      mutation: 'set_part_transform',
      partName: part.name,
      posX: nextX,
      posY: nextY,
      posZ: nextZ,
      rotX: nextRotX,
      scaleX: nextScaleX,
      scaleY: nextScaleY,
      scaleZ: nextScaleZ
    }
  });
  if (!writtenTransform.diagnostics.some((d) => d.code === 'MSB_STAGING_WRITE_VERIFIED')) {
    throw new Error(`MSB transform write failed: ${JSON.stringify(writtenTransform.diagnostics)}`);
  }
  await assertDcxOuter(stagedTransform);
  const afterTransform = await runBridge<MsbEnvelope>({
    command: 'read-msb-document',
    filePath: stagedTransform,
    allowedRoots: [staging, ...(oodleRoot ? [oodleRoot] : [])],
    ...(oodleRoot ? { oodleRuntimeRoot: oodleRoot } : {}),
    timeoutMs: 120_000
  });
  const updatedTransform = afterTransform.data?.parts.find((p) => p.name === part.name);
  if (!updatedTransform) throw new Error('transform-mutated part missing on reread');
  if (!close(updatedTransform.posX, nextX) || !close(updatedTransform.posY, nextY)
    || !close(updatedTransform.posZ, nextZ)) {
    throw new Error(`transform position not updated: ${JSON.stringify(updatedTransform)}`);
  }
  if (updatedTransform.rotX === undefined || updatedTransform.scaleX === undefined
    || updatedTransform.scaleY === undefined || updatedTransform.scaleZ === undefined) {
    throw new Error('transform reread envelope missing rot/scale fields');
  }
  if (!close(updatedTransform.rotX, nextRotX)) {
    throw new Error(`transform rotX not updated: ${JSON.stringify(updatedTransform)}`);
  }
  if (!close(updatedTransform.scaleX, nextScaleX)
    || !close(updatedTransform.scaleY, nextScaleY)
    || !close(updatedTransform.scaleZ, nextScaleZ)) {
    throw new Error(`transform scale not updated: ${JSON.stringify(updatedTransform)}`);
  }
  if (afterTransform.data?.partCount !== read.data.partCount) {
    throw new Error('part count changed by transform write');
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'MSB models/parts/regions/events 解析与 part/region 位置写入重读验证通过',
    version: read.data.version,
    modelCount: read.data.modelCount,
    partCount: read.data.partCount,
    regionCount: read.data.regionCount,
    eventCount: read.data.eventCount,
    routeCount: read.data.routeCount,
    typeCoverage,
    sampleRoute: read.data.routes?.[0]?.name,
    sampleRegion: region.name,
    sampleEvent: read.data.events?.[0]?.name,
    sampleModel: read.data.models[0]?.name,
    samplePart: part.name,
    position: {
      before: { x: part.posX, y: part.posY, z: part.posZ },
      after: { x: updated.posX, y: updated.posY, z: updated.posZ }
    },
    transform: {
      rotX: updatedTransform.rotX,
      scale: [updatedTransform.scaleX, updatedTransform.scaleY, updatedTransform.scaleZ],
      rereadVerified: true
    },
    authority: after.data?.authority,
    entityEdit: read.data.entityEdit,
    writeSourceFormat: (written.data as { sourceFormat?: string } | null | undefined)?.sourceFormat,
    sceneProjection: {
      authority: sceneBefore.authority,
      schemaVersion: sceneBefore.schemaVersion,
      projectedEntities: sceneBefore.entityCount,
      projectedNodes: sceneBefore.nodeCount,
      sourceCounts: sceneBefore.sourceCounts,
      stableIdentityAfterMutation: true,
      diagnostics: sceneBefore.diagnostics.map((item) => item.code)
    }
  }, null, 2));
  await disposeBridgeDaemonPool();
}

main().catch(async (error) => {
  await disposeBridgeDaemonPool();
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
