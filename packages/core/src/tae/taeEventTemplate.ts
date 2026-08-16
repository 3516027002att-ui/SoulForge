/**
 * 本机 DSAnimStudio `TAE.Template.SDT.xml` 只读导入（S17 动作域词条）。
 *
 * ── 这是什么 ──
 *
 * DSAnimStudio 的 `Res\TAE.Template.SDT.xml` 是 Sekiro 事件类型的权威词条表：
 * 每个 `<event id name>` 声明一个事件类型（`0 JumpTable`、`144 InvokeRumbleCam…`），
 * 其下的 `<s32|u32|f32|s16|u16|s8|u8|b name>` 子元素声明该事件参数体的字段布局。
 * 本模块只读解析这张表，输出：
 *
 * - 事件类型名（事件行 `{typeId} {类型名}` 的「类型名」来源）；
 * - 每类的字段布局（name / kind / slotSize），随 read-tae-document 的
 *   `templateLayouts` 选项传给 Bridge，由 C# 侧按 4 字节槽对齐解码参数体
 *   （TaeNativeDocument.DecodeParamFields）。
 *
 * ── 刻意不做什么 ──
 *
 * 与 Yapped 导入同构：这是本机第三方工具安装目录，不是可再分发来源，只读、
 * 不入库、失败降级（拿不到就显示 `{typeId} {未命名}`，绝不把「词条不可用」
 * 升级成「TAE 不可用」）。字段的 `<entry value name>` 枚举值表不解析 ——
 * C# 侧当前只消费 name/kind/slotSize，枚举表留待需要时再扩。
 *
 * 路径归属同 Yapped：模板路径只出现在 main 进程（ipc.ts），渲染器拿不到；
 * main 侧读一次并缓存为内存索引，不落盘。
 */

import { readFile } from 'node:fs/promises';
import { SaxesParser, type SaxesTagPlain } from 'saxes';

const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 10_000;
const MAX_FIELDS_PER_EVENT = 256;

/** DSAS 模板字段类型集合（与 Bridge 侧 TaeFieldLayout.Kind 取值一致）。 */
export const TAE_EVENT_FIELD_KINDS = ['s32', 'u32', 'f32', 's16', 'u16', 's8', 'u8', 'b'] as const;
export type TaeEventFieldKind = (typeof TAE_EVENT_FIELD_KINDS)[number];

export interface TaeEventTemplateField {
  name: string;
  kind: string;
  /** 参数字段槽大小（字节）。DSAS 模板为 4 字节槽对齐。 */
  slotSize: number;
}

export interface TaeEventTemplateInfo {
  /** 事件类型中文/英文名（`0 JumpTable` 的 `JumpTable`）。 */
  name: string;
  fields: TaeEventTemplateField[];
}

export interface TaeEventTemplateDiagnostic {
  severity: 'error' | 'info';
  code: string;
  message: string;
}

export interface TaeEventTemplateResult {
  ok: boolean;
  /** eventTypeId → 词条。跨 bank 重复 id 先见者优先。 */
  byEventTypeId: ReadonlyMap<number, TaeEventTemplateInfo>;
  eventCount: number;
  diagnostics: TaeEventTemplateDiagnostic[];
}

function templateError(code: string, message: string): Error {
  const error = new Error(message);
  error.name = code;
  return error;
}

function attributeValue(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 解析 DSAS `TAE.Template.SDT.xml` 单文件。
 *
 * 文法：`<event_template>` → `<bank>` → `<event id name>` → 字段元素（自闭合）。
 * 字段元素可带 `<entry value name/>` 子元素，本模块忽略。失败语义与 Yapped
 * 一致：坏文件记 error 诊断返回空索引，不抛（可选增强，失败回退裸 typeId）。
 */
export function parseTaeEventTemplateXml(xml: string): TaeEventTemplateResult {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw templateError('TAE_TEMPLATE_DTD_FORBIDDEN', 'TAE 模板禁止 DTD 与实体声明。');
  }
  const byEventTypeId = new Map<number, TaeEventTemplateInfo>();
  const diagnostics: TaeEventTemplateDiagnostic[] = [];
  let currentEvent: TaeEventTemplateInfo | undefined;
  let currentEventId = 0;
  let eventCount = 0;
  let parseFailure: Error | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    parseFailure = templateError('TAE_TEMPLATE_DTD_FORBIDDEN', 'TAE 模板禁止 DTD。');
  });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    if (tag.name === 'event') {
      const idText = attributeValue(tag, 'id');
      const name = attributeValue(tag, 'name') ?? '';
      if (idText === undefined || !/^-?\d+$/u.test(idText)) {
        parseFailure = templateError('TAE_TEMPLATE_EVENT_ID_INVALID', 'TAE 模板事件缺少合法 id。');
        return;
      }
      currentEventId = Number(idText);
      if (eventCount >= MAX_EVENTS) {
        parseFailure = templateError('TAE_TEMPLATE_TOO_MANY_EVENTS', 'TAE 模板事件数超出安全上限。');
        return;
      }
      if (byEventTypeId.has(currentEventId)) {
        // 跨 bank 重复 id：先见者优先（SDT Characters 在前），记 info 不失败。
        diagnostics.push({
          severity: 'info',
          code: 'TAE_TEMPLATE_DUPLICATE_EVENT_ID',
          message: `TAE 模板事件 id ${currentEventId} 重复（${byEventTypeId.get(currentEventId)?.name ?? ''} / ${name}）。先见者优先。`
        });
        currentEvent = undefined;
        return;
      }
      currentEvent = { name, fields: [] };
      byEventTypeId.set(currentEventId, currentEvent);
      eventCount += 1;
      return;
    }
    if (currentEvent && (TAE_EVENT_FIELD_KINDS as readonly string[]).includes(tag.name)) {
      const fieldName = (attributeValue(tag, 'name') ?? '').trim();
      if (!fieldName) return;
      if (currentEvent.fields.length >= MAX_FIELDS_PER_EVENT) {
        parseFailure = templateError('TAE_TEMPLATE_TOO_MANY_FIELDS', `TAE 模板事件 ${currentEventId} 字段数超出安全上限。`);
        return;
      }
      currentEvent.fields.push({ name: fieldName, kind: tag.name, slotSize: 4 });
    }
  });
  parser.on('error', (error: Error) => {
    parseFailure = error;
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    parseFailure = error instanceof Error ? error : new Error('invalid XML');
  }
  if (parseFailure) {
    throw templateError('TAE_TEMPLATE_XML_INVALID', parseFailure.message);
  }
  if (byEventTypeId.size === 0) {
    throw templateError('TAE_TEMPLATE_EMPTY', 'TAE 模板不含任何事件词条。');
  }
  return { ok: true, byEventTypeId, eventCount, diagnostics };
}

/** 有界读模板文件（超限记 error 诊断而非抛，可选增强保持降级路径）。 */
export async function readTaeEventTemplateFile(path: string): Promise<TaeEventTemplateResult> {
  const diagnostics: TaeEventTemplateDiagnostic[] = [];
  let xml: string;
  try {
    const buffer = await readFile(path);
    if (buffer.byteLength > MAX_TEMPLATE_BYTES) {
      diagnostics.push({
        severity: 'error',
        code: 'TAE_TEMPLATE_TOO_LARGE',
        message: `TAE 模板 ${path} 超出 2MiB 上限，忽略。`
      });
      return { ok: false, byEventTypeId: new Map(), eventCount: 0, diagnostics };
    }
    xml = buffer.toString('utf8');
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'TAE_TEMPLATE_READ_FAILED',
      message: `TAE 模板读取失败：${error instanceof Error ? error.message : String(error)}`
    });
    return { ok: false, byEventTypeId: new Map(), eventCount: 0, diagnostics };
  }
  try {
    const parsed = parseTaeEventTemplateXml(xml);
    return { ...parsed, diagnostics: [...diagnostics, ...parsed.diagnostics] };
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'TAE_TEMPLATE_PARSE_FAILED',
      message: `TAE 模板解析失败：${error instanceof Error ? error.message : String(error)}`
    });
    return { ok: false, byEventTypeId: new Map(), eventCount: 0, diagnostics };
  }
}
