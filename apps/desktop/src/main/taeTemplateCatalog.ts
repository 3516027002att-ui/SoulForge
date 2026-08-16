/**
 * 本机 TAE.Template.SDT.xml 的定位与解析（S17 词条名 + 参数布局）。
 *
 * 与 EMEDF 同一姿态：XML 只读本机、不入库；renderer 只拿到逻辑名与解码后的
 * 字段值，绝不接触该文件路径。解析只消费 XML 公开语法（event/bank 的 id+name、
 * 参数标签类型与 entry 枚举），不抄 DSAnimStudio 源码。
 *
 * XML 结构（已对 2026-08-16 本机 DSAS 4.9.9 的 SDT 模板实证）：
 *   <event_template game="SDT">
 *     <bank id="14" name="Characters_SDT">
 *       <event id="0" name="JumpTable">
 *         <s32 name="JumpTableID"><entry value="0" name="0: Do Nothing"/>…</s32>
 *         <u8 assert="0"/>
 *         …
 *       </event>
 * 参数标签类型 → 字节大小：u8/s8/b=1，u16/s16=2，u32/s32/f32=4。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type TaeParamFieldType = 'u8' | 's8' | 'b' | 'u16' | 's16' | 'u32' | 's32' | 'f32';

export interface TaeParamFieldDef {
  name: string;
  type: TaeParamFieldType;
  /** 枚举 entry（<entry value name>），用于把数值渲染成可读名。 */
  entries?: ReadonlyArray<{ value: number; name: string }>;
}

export interface TaeTemplateEventDef {
  eventTypeId: number;
  name: string;
  /** 参数体总大小（字段大小之和；模板无该类型时为 0）。 */
  paramSize: number;
  fields: readonly TaeParamFieldDef[];
}

export interface TaeTemplateCatalog {
  origin: 'imported' | 'unavailable';
  /** eventTypeId → 定义。无模板的类型不在表内。 */
  events: ReadonlyMap<number, TaeTemplateEventDef>;
  /** 定位失败 / 解析失败的原因（unavailable 时的诊断）。 */
  diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }>;
}

const PARAM_SIZE: Record<TaeParamFieldType, number> = {
  u8: 1, s8: 1, b: 1,
  u16: 2, s16: 2,
  u32: 4, s32: 4, f32: 4
};

/** 固定候选：DSAnimStudio 4.9.9 发布包的 Res 目录（本机真实落地）。 */
const TAE_TEMPLATE_FIXED_CANDIDATES: readonly string[] = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\tools\\DSAnimStudio-4.9.9[Build 4999]\\Res\\TAE.Template.SDT.xml'
];

/** 兄弟 tools/<一层子目录> 下的相对候选。 */
const TAE_TEMPLATE_RELATIVE_CANDIDATES: readonly string[] = [
  'DSAnimStudio-4.9.9[Build 4999]/Res/TAE.Template.SDT.xml',
  'DSAnimStudio/Res/TAE.Template.SDT.xml',
  'Res/TAE.Template.SDT.xml'
];

function pushToolsSubdirs(roots: string[], toolsParent: string | undefined): void {
  if (!toolsParent) return;
  try {
    const toolsDir = join(toolsParent, 'tools');
    if (!existsSync(toolsDir)) return;
    for (const entry of readdirNames(toolsDir)) {
      const candidate = join(toolsDir, entry, 'Res', 'TAE.Template.SDT.xml');
      if (existsSync(candidate)) roots.push(candidate);
    }
  } catch {
    // tools 目录不存在/不可读：跳过，继续其他候选。
  }
}

function readdirNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 定位本机 TAE 模板 XML。顺序：环境变量 → 固定候选 → 已挂 baseRoot /
 * overlay 上层 / SOULFORGE_SEKIRO_GAME_ROOT 的兄弟 tools 子目录。
 */
export function locateTaeTemplateSync(
  baseRoot?: string | null,
  overlayRoot?: string | null
): string | null {
  const explicit = process.env.SOULFORGE_TAE_TEMPLATE_PATH?.trim();
  if (explicit && existsSync(resolve(explicit))) return resolve(explicit);
  for (const candidate of TAE_TEMPLATE_FIXED_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 继续下一个候选。
    }
  }
  const roots: string[] = [];
  pushToolsSubdirs(roots, baseRoot ?? undefined);
  if (overlayRoot) pushToolsSubdirs(roots, dirname(dirname(overlayRoot)));
  const gameRootEnv = process.env.SOULFORGE_SEKIRO_GAME_ROOT?.trim();
  if (gameRootEnv) pushToolsSubdirs(roots, gameRootEnv);
  for (const root of roots) {
    for (const relative of TAE_TEMPLATE_RELATIVE_CANDIDATES) {
      try {
        const candidate = join(root, relative);
        if (existsSync(candidate)) return candidate;
      } catch {
        // 继续下一个候选。
      }
    }
  }
  return null;
}

/**
 * 解析模板 XML 文本 → 事件定义表。只消费公开语法；无法解析时返回诊断而不是
 * 抛异常（renderer 词条名可以降级为纯数字 id，不阻断动作工作台）。
 */
export function parseTaeTemplateXml(xml: string): {
  events: Map<number, TaeTemplateEventDef>;
  diagnostics: Array<{ severity: string; code: string; message: string }>;
} {
  const events = new Map<number, TaeTemplateEventDef>();
  const diagnostics: Array<{ severity: string; code: string; message: string }> = [];
  // bank 内的 event 块：非贪婪到第一个 </event>（event 内部没有嵌套 event）。
  const eventPattern = /<event\s+id="(\d+)"\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/event>/g;
  let eventMatch: RegExpExecArray | null;
  while ((eventMatch = eventPattern.exec(xml)) !== null) {
    const eventTypeId = Number(eventMatch[1]);
    const name = eventMatch[2] ?? '';
    const body = eventMatch[3] ?? '';
    const fields: TaeParamFieldDef[] = [];
    let paramSize = 0;
    // 参数标签：自闭合（<s32 …/>）或带 entry 子元素（<s32 …>…</s32>）。
    const fieldPattern = /<(u8|s8|b|u16|s16|u32|s32|f32)((?:\s+[^>]*?)?)\s*(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldPattern.exec(body)) !== null) {
      const type = fieldMatch[1] as TaeParamFieldType;
      const attrs = fieldMatch[2] ?? '';
      const children = fieldMatch[3] ?? '';
      const attrName = /name="([^"]*)"/.exec(attrs)?.[1] ?? '';
      paramSize += PARAM_SIZE[type];
      const entries: Array<{ value: number; name: string }> = [];
      if (children) {
        const entryPattern = /<entry\s+value="(-?\d+)"\s+name="([^"]*)"/g;
        let entryMatch: RegExpExecArray | null;
        while ((entryMatch = entryPattern.exec(children)) !== null) {
          entries.push({ value: Number(entryMatch[1]), name: entryMatch[2] ?? '' });
        }
      }
      fields.push({
        name: attrName,
        type,
        ...(entries.length > 0 ? { entries } : {})
      });
    }
    events.set(eventTypeId, { eventTypeId, name, paramSize, fields });
  }
  if (events.size === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'TAE_TEMPLATE_PARSE_EMPTY',
      message: 'TAE 模板解析结果为空：XML 结构与预期不符。'
    });
  }
  return { events, diagnostics };
}

let cachedTaeTemplate: { catalog: TaeTemplateCatalog } | null = null;

/** 缓存访问入口：首次调用定位 + 解析，之后复用（与 EMEDF registry 同一惰性模式）。 */
export function getTaeTemplateCatalog(input?: {
  baseRoot?: string | null;
  overlayRoot?: string | null;
}): TaeTemplateCatalog {
  if (!cachedTaeTemplate) {
    cachedTaeTemplate = { catalog: buildTaeTemplateCatalog(input) };
  }
  return cachedTaeTemplate.catalog;
}

export function buildTaeTemplateCatalog(input?: {
  baseRoot?: string | null;
  overlayRoot?: string | null;
}): TaeTemplateCatalog {
  const path = locateTaeTemplateSync(input?.baseRoot ?? null, input?.overlayRoot ?? null);
  if (!path) {
    return {
      origin: 'unavailable',
      events: new Map(),
      diagnostics: [{
        severity: 'error',
        code: 'TAE_TEMPLATE_NOT_FOUND',
        message: '未找到本机 TAE.Template.SDT.xml（DSAnimStudio Res 目录）；词条名与参数解码不可用，显示数字类型 id 与「未解码」。'
      }]
    };
  }
  let xml: string;
  try {
    xml = readFileSync(path, 'utf8');
  } catch (error) {
    return {
      origin: 'unavailable',
      events: new Map(),
      diagnostics: [{
        severity: 'error',
        code: 'TAE_TEMPLATE_READ_FAILED',
        message: `TAE 模板读取失败：${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
  const parsed = parseTaeTemplateXml(xml);
  return {
    origin: parsed.events.size > 0 ? 'imported' : 'unavailable',
    events: parsed.events,
    diagnostics: parsed.diagnostics
  };
}

/**
 * 按模板布局解码参数体 hex（little-endian）→ 字段值。
 * 只解模板定义的字段；超出部分由调用方作为尾部 hex 展示。无模板返回 null。
 */
export function decodeTaeParamFields(
  def: TaeTemplateEventDef | undefined,
  paramHex: string
): Array<{ name: string; type: TaeParamFieldType; value: string }> | null {
  if (!def || def.paramSize <= 0) return null;
  const bytes = Buffer.from(paramHex, 'hex');
  const out: Array<{ name: string; type: TaeParamFieldType; value: string }> = [];
  let offset = 0;
  for (const field of def.fields) {
    const size = PARAM_SIZE[field.type];
    if (offset + size > bytes.length) break;
    const raw = bytes.subarray(offset, offset + size);
    offset += size;
    let value: number;
    switch (field.type) {
      case 'f32':
        out.push({ name: field.name || `未命名 f32`, type: field.type, value: String(raw.readFloatLE(0)) });
        continue;
      case 'u8': case 'b': value = raw[0]!; break;
      case 's8': value = raw.readInt8(0); break;
      case 'u16': value = raw.readUInt16LE(0); break;
      case 's16': value = raw.readInt16LE(0); break;
      case 'u32': value = raw.readUInt32LE(0); break;
      default: value = raw.readInt32LE(0); break;
    }
    const entry = field.entries?.find((item) => item.value === value);
    out.push({
      name: field.name || `未命名 ${field.type}`,
      type: field.type,
      value: entry ? entry.name : String(value)
    });
  }
  return out;
}

/** 模板事件名：有模板用模板名，无模板给「未命名」。 */
export function taeEventTypeLabel(catalog: TaeTemplateCatalog, eventTypeId: number): string {
  return catalog.events.get(eventTypeId)?.name ?? '未命名';
}
