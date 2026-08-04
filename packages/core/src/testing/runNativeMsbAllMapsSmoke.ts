/**
 * Native MSB 9 图全量 smoke：解析 Sekiro 全部 9 张真实地图，验证实体类型并集
 * 与权威注册表精确一致（不得多出、不得遗漏），且每张图全表枚举。
 *
 * Authority: native-verified（偏移表驱动全枚举；per-type 内层载荷未语义解析，
 * 源字节重写保持无损）。缺真实资源环境时结构化跳过，不冒充。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { runBridge, disposeBridgeDaemonPool } from '../bridge/runBridge.js';
import { createSmokeWorkspace } from './harness/smokeWorkspace.js';
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

function decompressDfltDcx(source: Buffer): Buffer {
  let dca = -1;
  for (let i = 0x30; i < 0x100; i++) {
    if (source[i] === 0x44 && source[i + 1] === 0x43 && source[i + 2] === 0x41 && source[i + 3] === 0) {
      dca = i;
      break;
    }
  }
  if (dca < 0) throw new Error('DCA missing');
  const dcaLen = source.readUInt32BE(dca + 4);
  const payloadOff = dca + dcaLen;
  const compressedSize = source.readUInt32BE(0x20);
  const format = source.subarray(0x28, 0x2c).toString('ascii');
  if (format !== 'DFLT') throw new Error(`expected DFLT, got ${format}`);
  return inflateSync(source.subarray(payloadOff, payloadOff + compressedSize));
}

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

  for (const map of ALL_MAPS) {
    let sourceDcx: string;
    if (explicitPath) {
      sourceDcx = join(explicitPath, MAP_FILES[map]!);
    } else {
      sourceDcx = join(gameRoot!, 'mods', 'map', 'mapstudio', MAP_FILES[map]!);
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
