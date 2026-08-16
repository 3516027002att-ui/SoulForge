import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseTaeEventTemplateXml,
  readTaeEventTemplateFile
} from '../tae/taeEventTemplate.js';

/**
 * S17 动作域：DSAS TAE.Template.SDT.xml 词条解析器 smoke。
 * 用合成微型模板验证：事件名、字段布局（kind/slotSize）、跨 bank 重复 id
 * 先见者优先、DTD 拒绝、缺事件空表拒绝。真实本机模板不 commit 入库，
 * 只在本机 smoke（SOULFORGE_TAE_TEMPLATE_PATH 存在时）验证字段数/类型集合。
 */
const scratch = await mkdtemp(join(tmpdir(), 'soulforge-tae-template-'));
try {
  const okXml = `<?xml version="1.0" encoding="utf-8"?>
<event_template game="SDT">
  <bank id="14" name="Characters_SDT">
    <event id="0" name="JumpTable">
      <s32 name="JumpTableID"/>
      <u8 name="UnkFlag"/>
    </event>
    <event id="144" name="InvokeRumbleCam_ByRange1">
      <f32 name="Range"/>
      <s16 name="Damage"/>
      <b name="Enabled"/>
    </event>
  </bank>
  <bank id="15" name="Menus_SDT">
    <event id="0" name="Blend">
      <s32 name="BlendId"/>
    </event>
  </bank>
</event_template>`;
  const parsed = parseTaeEventTemplateXml(okXml);
  if (!parsed.ok || parsed.eventCount !== 2 || parsed.byEventTypeId.size !== 2) {
    throw new Error(`basic parse failed: eventCount=${parsed.eventCount} size=${parsed.byEventTypeId.size} diag=${JSON.stringify(parsed.diagnostics)}`);
  }
  const jumpTable = parsed.byEventTypeId.get(0);
  if (!jumpTable
    || jumpTable.name !== 'JumpTable'
    || jumpTable.fields.length !== 2
    || jumpTable.fields[0]?.name !== 'JumpTableID'
    || jumpTable.fields[0]?.kind !== 's32'
    || jumpTable.fields[0]?.slotSize !== 4
    || jumpTable.fields[1]?.kind !== 'u8') {
    throw new Error(`JumpTable layout mismatch: ${JSON.stringify(jumpTable)}`);
  }
  // 跨 bank 重复 id：先见者优先（0 保留 Characters 的 JumpTable，不覆盖为 Blend）。
  const blend = parsed.byEventTypeId.get(0);
  if (blend?.name !== 'JumpTable') {
    throw new Error(`duplicate id first-wins violated: ${JSON.stringify(blend)}`);
  }
  if (parsed.diagnostics.length !== 1
    || parsed.diagnostics[0]?.code !== 'TAE_TEMPLATE_DUPLICATE_EVENT_ID') {
    throw new Error(`duplicate diagnostic missing: ${JSON.stringify(parsed.diagnostics)}`);
  }
  const rumble = parsed.byEventTypeId.get(144);
  if (!rumble || rumble.fields.map((f) => f.kind).join(',') !== 'f32,s16,b') {
    throw new Error(`field kinds mismatch: ${JSON.stringify(rumble)}`);
  }

  // DTD 拒绝。
  const dtdXml = `<?xml version="1.0"?><!DOCTYPE event_template [<!ENTITY x "y">]><event_template><bank><event id="1" name="X"><s32 name="A"/></event></bank></event_template>`;
  try {
    parseTaeEventTemplateXml(dtdXml);
    throw new Error('DTD should have been rejected');
  } catch (error) {
    if ((error as Error).name !== 'TAE_TEMPLATE_DTD_FORBIDDEN') throw error;
  }

  // 无事件 → 拒绝。
  const emptyXml = `<event_template game="SDT"><bank id="14" name="Characters_SDT"></bank></event_template>`;
  try {
    parseTaeEventTemplateXml(emptyXml);
    throw new Error('empty template should have been rejected');
  } catch (error) {
    if ((error as Error).name !== 'TAE_TEMPLATE_EMPTY') throw error;
  }

  // 文件路径读（含缺失路径降级 ok:false + 诊断，不抛）。
  const templatePath = join(scratch, 'TAE.Template.SDT.xml');
  await writeFile(templatePath, okXml, 'utf8');
  const fromFile = await readTaeEventTemplateFile(templatePath);
  if (!fromFile.ok || fromFile.byEventTypeId.size !== 2) {
    throw new Error(`file read failed: ${JSON.stringify(fromFile)}`);
  }
  const missing = await readTaeEventTemplateFile(join(scratch, 'missing.xml'));
  if (missing.ok
    || missing.diagnostics[0]?.code !== 'TAE_TEMPLATE_READ_FAILED') {
    throw new Error(`missing file should degrade: ${JSON.stringify(missing)}`);
  }

  // 本机真实模板（存在时）冒烟：字段类型集合与事件数在合理区间。
  const realPath = process.env.SOULFORGE_TAE_TEMPLATE_PATH?.trim();
  if (realPath) {
    const real = await readTaeEventTemplateFile(realPath);
    if (!real.ok || real.byEventTypeId.size < 100) {
      throw new Error(`real template parse failed: ${JSON.stringify(real.diagnostics)}`);
    }
    const kinds = new Set<string>();
    for (const info of real.byEventTypeId.values()) {
      for (const field of info.fields) kinds.add(field.kind);
    }
    for (const expected of ['s32', 'u32', 'f32', 's16', 'u16', 's8', 'u8', 'b']) {
      if (!kinds.has(expected)) throw new Error(`real template missing kind ${expected}`);
    }
    console.log(`TAE template smoke: real template ${real.byEventTypeId.size} events ok.`);
  }

  console.log('runTaeEventTemplateSmoke: PASS');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
