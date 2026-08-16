/**
 * S17：TAE 模板目录（taeTemplateCatalog.ts）纯逻辑单测。
 *
 * 只测 XML 解析与参数体解码（无 IO、不 import electron）：
 * - parseTaeTemplateXml：event 块、参数标签类型/大小、entry 枚举；
 * - decodeTaeParamFields：按模板布局解 little-endian 字段，entry 命中显示枚举名；
 * - 无模板类型返回 null（未解码路径）。
 * 本机 XML 文件路径不入测试（只读本机、不入库）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeTaeParamFields,
  parseTaeTemplateXml,
  taeEventTypeLabel
} from './taeTemplateCatalog.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<event_template game="SDT">
  <bank id="14" name="Characters_SDT">
    <event id="0" name="JumpTable">
      <s32 name="JumpTableID">
        <entry value="0" name="0: Do Nothing"/>
        <entry value="9" name="9: InvokeAnimCancelStart_Guard"/>
      </s32>
      <b name="IsLockOnCheck"/>
      <u8 assert="0"/>
      <u8 assert="0"/>
      <u8 assert="0"/>
      <s32 assert="0"/>
      <s32 assert="0"/>
    </event>
    <event id="224" name="SetTurnSpeed(每秒可转向角度)">
      <f32 name="TurnSpeed"/>
      <b name="IsLockOnCheck"/>
      <u8 assert="0"/>
      <u8 assert="0"/>
      <u8 assert="0"/>
      <s32 assert="0"/>
      <s32 assert="0"/>
    </event>
    <event id="700" name="BehaviorDataUnk700(边缘保护)">
      <f32/>
      <f32/>
      <f32/>
      <f32/>
      <s32/>
      <u8 name="JumpTableID"/>
      <u8/>
      <u8/>
      <u8/>
      <f32/>
      <f32/>
      <f32/>
      <f32/>
    </event>
  </bank>
</event_template>`;

describe('parseTaeTemplateXml（S17 词条名 + 参数布局）', () => {
  it('解析 event 块：id + name + 字段类型/大小 + entry 枚举', () => {
    const { events, diagnostics } = parseTaeTemplateXml(SAMPLE_XML);
    assert.equal(diagnostics.length, 0);
    assert.equal(events.size, 3);
    const jumpTable = events.get(0)!;
    assert.equal(jumpTable.name, 'JumpTable');
    // s32 + b + u8×3 + s32×2 = 4+1+1+1+1+4+4 = 16。
    assert.equal(jumpTable.paramSize, 16);
    assert.equal(jumpTable.fields.length, 7);
    const first = jumpTable.fields[0]!;
    assert.equal(first.name, 'JumpTableID');
    assert.equal(first.type, 's32');
    assert.equal(first.entries?.length, 2);
    assert.deepEqual(first.entries?.[1], { value: 9, name: '9: InvokeAnimCancelStart_Guard' });
  });

  it('type 224（SetTurnSpeed）与 type 700 参数大小符合实测布局', () => {
    const { events } = parseTaeTemplateXml(SAMPLE_XML);
    // 224：f32+b+u8×3+s32×2 = 16（与 c1130 实测 body_len=16 一致）。
    assert.equal(events.get(224)!.paramSize, 16);
    // 700：f32×4+s32+u8×4+f32×4 = 40（实测 48，剩余 8 字节走 tailHex）。
    assert.equal(events.get(700)!.paramSize, 40);
  });

  it('空 XML / 无 event 块 → diagnostics 报解析为空', () => {
    const { events, diagnostics } = parseTaeTemplateXml('<root/>');
    assert.equal(events.size, 0);
    assert.ok(diagnostics.some((d) => d.code === 'TAE_TEMPLATE_PARSE_EMPTY'));
  });
});

describe('decodeTaeParamFields（按模板布局解 little-endian 字段）', () => {
  it('s32 entry 命中显示枚举名；未命中显示数字', () => {
    const { events } = parseTaeTemplateXml(SAMPLE_XML);
    const def = events.get(0)!;
    // JumpTableID=9 + IsLockOnCheck=0 + u8×3 + s32×2（全部 0）。
    const hex = '09000000' + '00' + '000000' + '00000000' + '00000000';
    const fields = decodeTaeParamFields(def, hex)!;
    assert.equal(fields.length, 7);
    assert.equal(fields[0]!.value, '9: InvokeAnimCancelStart_Guard');
    assert.equal(fields[1]!.name, 'IsLockOnCheck');
    assert.equal(fields[1]!.value, '0');
  });

  it('f32 字段解出浮点值', () => {
    const { events } = parseTaeTemplateXml(SAMPLE_XML);
    const def = events.get(224)!;
    // TurnSpeed = 1.5f。
    const hex = '0000c03f' + '00' + '000000' + '00000000' + '00000000';
    const fields = decodeTaeParamFields(def, hex)!;
    assert.equal(fields[0]!.name, 'TurnSpeed');
    assert.equal(fields[0]!.value, '1.5');
  });

  it('无模板定义 → null（未解码路径由调用方显示 hex）', () => {
    assert.equal(decodeTaeParamFields(undefined, '00000000'), null);
  });

  it('hex 短于布局 → 只解能解出的字段（不越界）', () => {
    const { events } = parseTaeTemplateXml(SAMPLE_XML);
    const def = events.get(0)!;
    const fields = decodeTaeParamFields(def, '09000000')!;
    assert.equal(fields.length, 1);
  });
});

describe('taeEventTypeLabel（词条名渲染）', () => {
  it('有模板用模板名，无模板「未命名」', () => {
    const { events } = parseTaeTemplateXml(SAMPLE_XML);
    const catalog = { origin: 'imported' as const, events, diagnostics: [] };
    assert.equal(taeEventTypeLabel(catalog, 0), 'JumpTable');
    assert.equal(taeEventTypeLabel(catalog, 999), '未命名');
  });
});
