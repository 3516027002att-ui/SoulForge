/**
 * Native MSB 9 图全量 smoke：解析 Sekiro 全部 9 张真实地图，验证实体类型并集
 * 与权威注册表精确一致（不得多出、不得遗漏），且每张图全表枚举。
 *
 * Authority: native-verified（偏移表驱动全枚举；per-type 内层载荷未语义解析，
 * 源字节重写保持无损）。缺真实资源环境时结构化跳过，不冒充。
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { decompressDfltDcx } from '../util/dcxDflt.js';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
import { resolveNativeFixture } from './nativeFixtureRegistry.js';
import {
  SEKIRO_MSB_ENTITY_TYPE_REGISTRY,
  isRegisteredMsbType,
  normalizeMsbTypeId,
  type MsbEntityFamilyKey
} from '@soulforge/shared';

interface MsbEnvelope {
  sourceHash: string;
  modelCount: number;
  partCount: number;
  regionCount: number;
  eventCount: number;
  routeCount: number;
  models: Array<{ name: string; offset: number; typeId: number }>;
  parts: Array<{ name: string; offset: number; typeId: number }>;
  regions: Array<{ name: string; offset: number; typeId: number }>;
  events: Array<{ name: string; offset: number; typeId: number }>;
  routes: Array<{ name: string; offset: number; typeId: number }>;
  roundTrip?: { semanticIdentical: boolean; byteIdentical: boolean };
}

const ALL_MAPS = ['m10', 'm11', 'm11_01', 'm11_02', 'm13', 'm15', 'm17', 'm20', 'm25'];

/**
 * registry 里以 testRole=msb-primary 登记的那张图。
 *
 * has-game-registry.json 实测只登记了 m11（localPath
 * mods/map/mapstudio/m11_00_00_00.msb.dcx，带 sha256），其余 8 张未登记。
 * 已登记的必须走 resolveNativeFixture 以获得哈希与 root 边界校验；把 9 张全部
 * 手拼路径（改动前的形态）等于对唯一有登记哈希的那张也放弃校验。
 */
const REGISTERED_MAP = 'm11';

// Sekiro map id 文件命名：基础图 mXX_00_00_00，子图 mXX_YY_00_00。
const MAP_FILES: Record<string, string> = {
  m10: 'm10_00_00_00.msb.dcx',
  m11: 'm11_00_00_00.msb.dcx',
  m11_01: 'm11_01_00_00.msb.dcx',
  m11_02: 'm11_02_00_00.msb.dcx',
  m13: 'm13_00_00_00.msb.dcx',
  m15: 'm15_00_00_00.msb.dcx',
  m17: 'm17_00_00_00.msb.dcx',
  m20: 'm20_00_00_00.msb.dcx',
  m25: 'm25_00_00_00.msb.dcx'
};

function registryTypeIds(family: MsbEntityFamilyKey): Set<number> {
  const def = SEKIRO_MSB_ENTITY_TYPE_REGISTRY.families[family];
  const types = 'types' in def ? def.types : {};
  return new Set(Object.keys(types).map((key) => normalizeMsbTypeId(Number(key))));
}

function familySamples(family: MsbEntityFamilyKey, envelope: MsbEnvelope): Array<{ name: string; typeId: number }> {
  switch (family) {
    case 'model': return envelope.models;
    case 'part': return envelope.parts;
    case 'region': return envelope.regions;
    case 'event': return envelope.events;
    case 'route': return envelope.routes;
    default: return [];
  }
}

async function main(): Promise<void> {
  const explicitPath = process.argv[2]?.trim();
  const gameRoot = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim()
    ?? process.env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim();
  if (!gameRoot && !explicitPath) {
    console.log(JSON.stringify({
      ok: true,
      status: 'skipped',
      message: '缺少 SOULFORGE_SEKIRO_GAME_ROOT / SOULFORGE_NATIVE_FIXTURE_ROOT 且未提供显式路径：9 图全量 MSB smoke 结构化跳过。'
    }));
    return;
  }

  const workspace = await createSmokeWorkspace('msb-all-maps');
  const root = workspace.root;
  await mkdir(root, { recursive: true });
  try {

  const perMap: Record<string, { counts: Record<string, number>; types: Record<string, number[]> }> = {};
  const union = new Map<MsbEntityFamilyKey, Set<number>>();
  const registeredFamilies: Array<{ family: MsbEntityFamilyKey; label: string }> = [
    { family: 'model', label: 'Model' },
    { family: 'part', label: 'Part' },
    { family: 'region', label: 'Region' },
    { family: 'event', label: 'Event' },
    { family: 'route', label: 'Route' }
  ];
  for (const { family } of registeredFamilies) union.set(family, new Set());

  // 语料根：显式传参优先，否则用环境变量给的游戏根 + 固定相对目录。
  const mapDir = explicitPath ?? join(gameRoot!, 'mods', 'map', 'mapstudio');
  const canonicalMapDir = await realpath(resolve(mapDir));

  for (const map of ALL_MAPS) {
    // 本套件读 9 张图，而 registry 只登记了其中一张（msb-primary = m11）。
    // 已登记的那张必须走 resolveNativeFixture，未登记的仍需最低边界校验——
    // 此前整条路径是手拼 join()，两道保护全绕过了：
    //   · NATIVE_FIXTURE_HASH_MISMATCH（文件内容与登记哈希不符）
    //   · NATIVE_FIXTURE_OUTSIDE_ROOT（路径越出 fixture root）
    // 绕过的后果不是报错而是**静默读到别的文件**：解析结果照样产出，
    // 而「我们验证的是哪份字节」变得不可知。
    // resolveNativeFixture(explicitPath, testRole, legacyRelativePath)：第一个参数
    // 是显式覆盖路径（给就直接用），所以这里必须传 undefined 才会真正走 registry
    // 的哈希与 root 校验；legacy 相对路径与 registry 登记的 localPath 保持一致。
    const sourceDcx = map === REGISTERED_MAP && !explicitPath
      ? await resolveNativeFixture(
        undefined,
        'msb-primary',
        join(canonicalMapDir, MAP_FILES[map]!)
      )
      : join(canonicalMapDir, MAP_FILES[map]!);

    // 未登记的 8 张图至少要证明没有路径穿越（MAP_FILES 是本文件内的常量，
    // 但把边界判据建在「常量当前是干净的」之上，等于下次改常量时无人拦）。
    const relativeToDir = relative(canonicalMapDir, resolve(sourceDcx));
    if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) {
      throw new Error(
        `MSB_ALL_MAPS_SOURCE_OUTSIDE_ROOT: ${map} 的语料路径越出语料根 ${canonicalMapDir}。`
      );
    }
    const payload = decompressDfltDcx(await readFile(sourceDcx));
    const msbPath = join(root, `${map}.msb`);
    await writeFile(msbPath, payload);

    const read = await runBridge<MsbEnvelope>({
      command: 'read-msb-document',
      filePath: msbPath,
      allowedRoots: [root],
      timeoutMs: 180_000
    });
    if (read.parseStatus === 'failed' || !read.data) {
      throw new Error(`${map}: MSB read failed: ${JSON.stringify(read.diagnostics)}`);
    }
    if (!read.data.roundTrip?.semanticIdentical) {
      throw new Error(`${map}: MSB semantic roundtrip failed: ${JSON.stringify(read.data.roundTrip)}`);
    }
    if (read.data.modelCount < 1 || read.data.partCount < 1
      || read.data.regionCount < 1 || read.data.eventCount < 1) {
      throw new Error(`${map}: 四族实体不完整: ${JSON.stringify({
        models: read.data.modelCount,
        parts: read.data.partCount,
        regions: read.data.regionCount,
        events: read.data.eventCount
      })}`);
    }

    const typeIds: Record<string, number[]> = {};
    for (const { family } of registeredFamilies) {
      const samples = familySamples(family, read.data);
      const ids = new Set(samples.map((s) => normalizeMsbTypeId(s.typeId)));
      for (const id of ids) union.get(family)!.add(id);
      for (const sample of samples) {
        if (!isRegisteredMsbType(family, sample.typeId)) {
          throw new Error(`${map}: 未注册实体类型 ${family}/${sample.typeId}（${sample.name}）`);
        }
      }
      typeIds[family] = [...ids].sort((a, b) => a - b);
    }

    perMap[map] = {
      counts: {
        models: read.data.modelCount,
        parts: read.data.partCount,
        regions: read.data.regionCount,
        events: read.data.eventCount,
        routes: read.data.routeCount
      },
      types: typeIds
    };
  }

  // 并集必须与注册表精确一致：不得多出真实未出现的类型，不得遗漏真实出现的类型。
  const unionReport: Record<string, number[]> = {};
  for (const { family, label } of registeredFamilies) {
    const observed = union.get(family)!;
    const registered = registryTypeIds(family);
    const missing = [...registered].filter((id) => !observed.has(id));
    const extra = [...observed].filter((id) => !registered.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`注册表与 9 图并集不一致（${label} 族）: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
    }
    unionReport[family] = [...observed].sort((a, b) => a - b);
  }

  console.log(JSON.stringify({
    ok: true,
    message: 'Sekiro MSB 9 图全量解析通过：实体类型并集与权威注册表精确一致',
    corpus: ALL_MAPS,
    authority: 'native-verified',
    perMap,
    typeUnion: unionReport
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
