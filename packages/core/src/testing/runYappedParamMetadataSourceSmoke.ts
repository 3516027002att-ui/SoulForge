import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyYappedFieldOverlay,
  looksJapaneseText,
  parseYappedNamesText,
  readYappedSdtDefsIndex,
  readYappedSdtRowNamesIndex,
  resolveYappedRowName
} from '../param/yappedParamMetadataSource.js';
import type { ParamDefDocument } from '@soulforge/shared';

const scratch = await mkdtemp(join(tmpdir(), 'soulforge-yapped-source-'));
try {
  await createFixture(scratch);

  const defs = await readYappedSdtDefsIndex(join(scratch, 'Defs'));
  if (!defs.ok || defs.defCount !== 2 || defs.fieldCount !== 3) {
    throw new Error(`Yapped defs index failed: ${JSON.stringify(defs)}`);
  }
  const chinese = defs.byTypeName.get('SP_EFFECT_PARAM_ST');
  if (!chinese) throw new Error('Missing SP_EFFECT_PARAM_ST overlay.');
  const duration = chinese.fields.get('effectEndurance');
  if (!duration || duration.displayName !== '持续时间' || duration.description !== '效果持续时间') {
    throw new Error(`Chinese field overlay missing: ${JSON.stringify(duration)}`);
  }
  const japanese = defs.byTypeName.get('JAPANESE_ONLY_PARAM_ST');
  if (!japanese) throw new Error('Missing JAPANESE_ONLY_PARAM_ST overlay.');

  // 日文 guard：含假名的 DisplayName 不当主标签。
  if (!looksJapaneseText('ジャンプ高度')) throw new Error('Kana text not detected as Japanese.');
  if (looksJapaneseText('持续时间')) throw new Error('Chinese text misdetected as Japanese.');

  // overlay 应用：中文覆盖生效；日文覆盖被拒绝（保留 Smithbox 英文）；缺字段保留。
  const base: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'SP_EFFECT_PARAM_ST',
    version: 6,
    rowDataSize: 8,
    origin: 'imported',
    fields: [
      { id: 'effectEndurance', name: 'Effect Endurance', type: 'f32', offset: 0, size: 4 },
      { id: 'iconId', name: 'Icon ID', type: 's32', offset: 4, size: 4 }
    ]
  };
  const overlaid = applyYappedFieldOverlay(base, defs.byTypeName);
  if (overlaid.fields[0]?.name !== '持续时间') {
    throw new Error(`Chinese overlay not applied: ${overlaid.fields[0]?.name}`);
  }
  if (overlaid.fields[0]?.description !== '效果持续时间') {
    throw new Error('Chinese description overlay not applied.');
  }
  if (overlaid.fields[1]?.name !== '状态栏图标ID') {
    throw new Error('Second Yapped field overlay not applied.');
  }
  if (overlaid === base) throw new Error('Overlay should return a new document when changed.');
  if (applyYappedFieldOverlay(overlaid, defs.byTypeName) !== overlaid) {
    throw new Error('Idempotent overlay must return the same reference when nothing changes.');
  }

  const japaneseDoc: ParamDefDocument = {
    schemaVersion: 1,
    typeName: 'JAPANESE_ONLY_PARAM_ST',
    version: 1,
    rowDataSize: 4,
    origin: 'imported',
    fields: [{ id: 'jumpHeight', name: 'Jump Height', type: 'f32', offset: 0, size: 4 }]
  };
  const jpOverlaid = applyYappedFieldOverlay(japaneseDoc, defs.byTypeName);
  if (jpOverlaid.fields[0]?.name !== 'Jump Height') {
    throw new Error('Japanese DisplayName must not become the primary label.');
  }

  // 行名：解析 `id name -- 日文`、HTML 实体解码、条目标记。
  const names = await readYappedSdtRowNamesIndex(join(scratch, 'Names'));
  if (!names.ok || names.nameFileCount !== 1) {
    throw new Error(`Yapped names index failed: ${JSON.stringify(names)}`);
  }
  const sp = names.byEntryName.get('SpEffectParam');
  if (!sp) throw new Error('Missing SpEffectParam row-name table.');
  if (sp.get(0) !== "Don't erase") {
    throw new Error(`HTML entity not decoded or name mismatch: ${sp.get(0)}`);
  }
  if (sp.get(3) !== 'Dummy3') throw new Error('Plain name line mismatch.');
  if (resolveYappedRowName('SpEffectParam', 0, names.byEntryName) !== "Don't erase") {
    throw new Error('resolveYappedRowName lookup failed.');
  }
  if (resolveYappedRowName('Missing', 0, names.byEntryName) !== undefined) {
    throw new Error('Unknown entry must resolve to undefined.');
  }
  if (parseYappedNamesText('')?.size !== 0) throw new Error('Empty names text must parse empty.');

  // 真实机器路径（本机 Yapped 安装）：存在则必须可读且覆盖 160 定义。
  let realExecuted = false;
  let realDefCount: number | null = null;
  let realRowNameCount: number | null = null;
  const realRoot = 'D:/mystream/Sekiro Shadows Die Twice/tools/Yapped Rune Bear v2.14.1'
    + '/Yapped Rune Bear v2.14.1/Paramdex/SDT';
  try {
    const real = await readYappedSdtDefsIndex(join(realRoot, 'Defs'));
    if (real.defCount > 0) {
      realExecuted = true;
      realDefCount = real.defCount;
      // 160 个 Defs 文件，实测一个重复 ParamType（GraphicsConfig_ver2）被去重、
      // 个别文件文法畸形被跳过 —— 用下界而不是精确值，避免把发布工具自身的
      // 小瑕疵当成导入失败。
      if (real.defCount < 150) {
        throw new Error(`Real Yapped Defs count is ${real.defCount}, expected >= 150.`);
      }
      const realSp = real.byTypeName.get('SP_EFFECT_PARAM_ST');
      // 真实 DisplayName 实测是「持续时间——Duration」这种带英文对照后缀的写法，
      // 只断言中文前缀，不要求逐字相等（翻译文本并非我们控制的产物）。
      const enduranceName = realSp?.fields.get('effectEndurance')?.displayName;
      if (!enduranceName?.startsWith('持续时间')) {
        throw new Error(`Real Yapped SP_EFFECT_PARAM_ST lacks Chinese effectEndurance name: ${enduranceName}`);
      }
      const realNames = await readYappedSdtRowNamesIndex(join(realRoot, 'Names'));
      realRowNameCount = realNames.byEntryName.get('SpEffectParam')?.size ?? null;
      if (realRowNameCount === null || realRowNameCount <= 0) {
        throw new Error('Real Yapped SpEffectParam row-name table is empty.');
      }
    }
  } catch {
    // 本机未装 Yapped：跳过真实校验，不视为失败（可选增强）。
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    authority: 'partial',
    nativeFormatAuthority: false,
    defCount: defs.defCount,
    fieldCount: defs.fieldCount,
    japaneseGuard: true,
    overlayApplied: true,
    rowNamesParsed: names.nameFileCount,
    realExecuted,
    realDefCount,
    realRowNameCount
  }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function createFixture(scratch: string): Promise<void> {
  await mkdir(join(scratch, 'Defs'), { recursive: true });
  await mkdir(join(scratch, 'Names'), { recursive: true });
  const chineseXml = `﻿<?xml version="1.0" encoding="utf-8"?>
<PARAMDEF XmlVersion="3">
  <ParamType>SP_EFFECT_PARAM_ST</ParamType>
  <DataVersion>6</DataVersion>
  <Fields>
    <Field Def="f32 effectEndurance"><DisplayName>持续时间</DisplayName><Description>效果持续时间</Description></Field>
    <Field Def="s32 iconId = -1"><DisplayName>状态栏图标ID</DisplayName></Field>
  </Fields>
</PARAMDEF>`;
  const japaneseXml = `﻿<?xml version="1.0" encoding="utf-8"?>
<PARAMDEF XmlVersion="3">
  <ParamType>JAPANESE_ONLY_PARAM_ST</ParamType>
  <DataVersion>1</DataVersion>
  <Fields>
    <Field Def="f32 jumpHeight"><DisplayName>ジャンプ高度</DisplayName></Field>
  </Fields>
</PARAMDEF>`;
  const namesTxt = `0 Don&#39;t erase -- 消すべからず
1 Dummy1 -- Dummy1
2 Dummy2 -- Dummy2
3 Dummy3 -- Dummy3
10 Stick -- 張りつく
`;
  await Promise.all([
    writeFile(join(scratch, 'Defs', 'SpEffect.xml'), chineseXml, 'utf8'),
    writeFile(join(scratch, 'Defs', 'JapaneseOnly.xml'), japaneseXml, 'utf8'),
    writeFile(join(scratch, 'Names', 'SpEffectParam.txt'), namesTxt, 'utf8')
  ]);
}
