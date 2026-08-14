/**
 * 本机 Yapped Rune Bear 元数据只读导入（T5-1 / T5-3）。
 *
 * ── 这是什么 ──
 *
 * Smithbox 元数据（importPinnedSmithboxSdtParamMetadata）给的是 **英文** 字段名
 * （Param Annotations/English）。用户装的中文汉化版 Yapped 在
 * `Paramdex\SDT\Defs\*.xml` 里带 **中文 DisplayName / Description**，字段名读起来
 * 是「持续时间」「HP上限倍率」这种。本模块只从本机 Yapped 安装只读抽取这两样，
 * 覆盖到 Smithbox 文档上；Yapped 缺的字段保留 Smithbox 英文，禁止用日文
 * DisplayName 当主标签。
 *
 * 刻意不做成 Smithbox 那样的「钉死发布包」：Yapped 是本机第三方工具安装目录，
 * 不是可再分发来源，没有归档摘要可钉。这里只读、不入库、失败降级（拿不到就
 * 回落到 Smithbox 英文，绝不把「中文名不可用」升级成「PARAM 不可用」）。
 *
 * 同样读取 `Paramdex\SDT\Names\<EntryName>.txt` 的行名表（T5-3）：PARAM 行的名字
 * 优先由 Bridge 从文件内名称区解码；空时回落 Yapped 行名；再空显示 `—`。
 *
 * ── 路径归属 ──
 *
 * 本机 Yapped 路径只出现在 main 进程（ipc.ts），渲染器拿不到。Defs/Names 文件
 * 只在 main 侧读一次并缓存为内存索引，不进 app.db、不进工作区、不 commit 入库。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { ParamDefDocument, ParamFieldDef } from '@soulforge/shared';

const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_NAME_FILE_BYTES = 4 * 1024 * 1024;
/**
 * 字段 id 提取：只取 `类型 + 空格 + id` 前缀，后缀（数组/位域/默认值/枚举值表
 * 如 `[0,1,2,3]`）一律不解析 —— 本模块只需要 id 去对齐 Smithbox 字段。
 * 实测 Yapped 有 `u8 GroundMaterialType [0,1,2,3]` 这种带枚举值表的 Def，
 * 严格文法会把整张表拒掉；覆盖层只需要 id，宽松是正确取舍。
 */
const FIELD_ID = /^(?:u8|s8|u16|s16|u32|s32|f32|angle32|b32|dummy8|fixstr|fixstrW)\s+([A-Za-z_][A-Za-z0-9_]*)/u;

export interface YappedSourceDiagnostic {
  severity: 'error' | 'info';
  code: string;
  message: string;
}

/** 单个字段的 Yapped 覆盖（中文 DisplayName / Description）。 */
export interface YappedFieldOverlay {
  displayName?: string;
  description?: string;
}

/** 一个 param 的 Yapped 覆盖，按 ParamType 键。 */
export interface YappedParamOverlay {
  typeName: string;
  dataVersion?: number;
  /** fieldId → 覆盖。 */
  fields: ReadonlyMap<string, YappedFieldOverlay>;
}

export interface YappedSdtDefsResult {
  ok: boolean;
  /** ParamType → 覆盖。 */
  byTypeName: ReadonlyMap<string, YappedParamOverlay>;
  defCount: number;
  fieldCount: number;
  diagnostics: YappedSourceDiagnostic[];
}

export interface YappedSdtRowNamesResult {
  ok: boolean;
  /**
   * 容器条目名（如 `SpEffectParam`）→ 行 id → 名字。
   *
   * Names 文件名就是条目名（SpEffectParam.txt ↔ 容器条目 SpEffectParam.param），
   * 与 Defs 文件名（SpEffect.xml ↔ ParamType SP_EFFECT_PARAM_ST）不是同一把键。
   */
  byEntryName: ReadonlyMap<string, ReadonlyMap<number, string>>;
  nameFileCount: number;
  diagnostics: YappedSourceDiagnostic[];
}

/**
 * 读 `Defs/*.xml`：每个文件提取 ParamType + 逐字段 DisplayName/Description。
 *
 * ── 失败语义 ──
 *
 * 目录不存在 → ok:true + 空索引 + info 诊断（可选增强，不回失败）。
 * 某个 xml 畸形/DTD/Def 文法未知 → 记 error 诊断但**继续**读其它文件：一个坏
 * 文件不该让全部表失去中文名。ok 只表示「至少有一张表可读」—— 对可选增强而言
 * 部分成功也是成功；诊断里逐条给出坏文件。
 */
export async function readYappedSdtDefsIndex(defsRootDir: string): Promise<YappedSdtDefsResult> {
  const byTypeName = new Map<string, YappedParamOverlay>();
  const diagnostics: YappedSourceDiagnostic[] = [];
  let entries;
  try {
    entries = await readdir(defsRootDir, { withFileTypes: true });
  } catch {
    return {
      ok: true,
      byTypeName,
      defCount: 0,
      fieldCount: 0,
      diagnostics: [{
        severity: 'info',
        code: 'YAPPED_DEFS_NOT_FOUND',
        message: '未找到本机 Yapped Defs 目录，字段名回落 Smithbox 英文标注。'
      }]
    };
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (files.length === 0) {
    return {
      ok: false,
      byTypeName,
      defCount: 0,
      fieldCount: 0,
      diagnostics: [{
        severity: 'error',
        code: 'YAPPED_DEFS_EMPTY',
        message: 'Yapped Defs 目录存在但不含任何 .xml。'
      }]
    };
  }
  let fieldCount = 0;
  for (const entry of files) {
    const path = join(defsRootDir, entry.name);
    let xml: string;
    try {
      xml = await readBoundedText(path, MAX_XML_BYTES, 'YAPPED_DEF_TOO_LARGE');
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'YAPPED_DEF_READ_FAILED',
        message: `Yapped 定义 ${entry.name} 读取失败：${messageOf(error)}`
      });
      continue;
    }
    try {
      const parsed = parseYappedParamdefXml(xml);
      if (parsed.typeName) {
        const fields = new Map<string, YappedFieldOverlay>();
        for (const field of parsed.fields) {
          const overlay: YappedFieldOverlay = {};
          if (field.displayName) overlay.displayName = field.displayName;
          if (field.description) overlay.description = field.description;
          if (Object.keys(overlay).length > 0) fields.set(field.id, overlay);
        }
        if (byTypeName.has(parsed.typeName)) {
          diagnostics.push({
            severity: 'info',
            code: 'YAPPED_DEFS_DUPLICATE_TYPE',
            message: `Yapped 定义出现重复 ParamType：${parsed.typeName}（${entry.name}）。后见者忽略。`
          });
        } else {
          byTypeName.set(parsed.typeName, {
            typeName: parsed.typeName,
            ...(parsed.dataVersion !== undefined ? { dataVersion: parsed.dataVersion } : {}),
            fields
          });
          fieldCount += fields.size;
        }
      }
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'YAPPED_DEF_PARSE_FAILED',
        message: `Yapped 定义 ${entry.name} 解析失败：${messageOf(error)}`
      });
    }
  }
  return { ok: byTypeName.size > 0, byTypeName, defCount: byTypeName.size, fieldCount, diagnostics };
}

/**
 * 读 `Names/*.txt`：每行 `id name -- 日文名`，条目名 = 文件名。
 *
 * 名字区里的英文名是 HTML 实体编码的（实测 `Don&#39;t` = `Don't`、
 * `&amp;`/`&quot;`），解析时解码。日文侧只是对照参考，不参与显示名。
 */
export async function readYappedSdtRowNamesIndex(
  namesRootDir: string
): Promise<YappedSdtRowNamesResult> {
  const byEntryName = new Map<string, ReadonlyMap<number, string>>();
  const diagnostics: YappedSourceDiagnostic[] = [];
  let entries;
  try {
    entries = await readdir(namesRootDir, { withFileTypes: true });
  } catch {
    return {
      ok: true,
      byEntryName,
      nameFileCount: 0,
      diagnostics: [{
        severity: 'info',
        code: 'YAPPED_NAMES_NOT_FOUND',
        message: '未找到本机 Yapped Names 目录，行名只在 Bridge 已解码时显示。'
      }]
    };
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  let ok = true;
  for (const entry of files) {
    const path = join(namesRootDir, entry.name);
    let text: string;
    try {
      text = await readBoundedText(path, MAX_NAME_FILE_BYTES, 'YAPPED_NAMES_TOO_LARGE');
    } catch (error) {
      ok = false;
      diagnostics.push({
        severity: 'error',
        code: 'YAPPED_NAMES_READ_FAILED',
        message: `Yapped 行名 ${entry.name} 读取失败：${messageOf(error)}`
      });
      continue;
    }
    const rows = parseYappedNamesText(text);
    const entryName = entry.name.slice(0, -4);
    byEntryName.set(entryName, rows);
    if (rows.size === 0) {
      diagnostics.push({
        severity: 'info',
        code: 'YAPPED_NAMES_EMPTY',
        message: `Yapped 行名 ${entry.name} 没有可解析的行。`
      });
    }
  }
  return { ok, byEntryName, nameFileCount: byEntryName.size, diagnostics };
}

/**
 * 文本是否判定为「日文」（含平假名或片假名）。
 *
 * 中文与日文共享 CJK 统一表意文字，光看汉字分不出；但平假名/片假名是日文
 * 独有。规则取保守侧：只要出现假名就当日文，避免把「状态」这类汉日同形词
 * 误判成日文 —— 误判只损失一次显示机会（回落到 Smithbox 英文），方向安全。
 */
export function looksJapaneseText(text: string): boolean {
  return /[぀-ゟ゠-ヿ]/u.test(text);
}

/**
 * 把 Yapped 覆盖套到 ParamDefDocument 上（T5-1）。
 *
 * 规则：
 *  · 字段 name ← Yapped 中文 DisplayName（含假名=日文时**不用**，保留 Smithbox 英文）。
 *  · 字段 description ← Yapped Description。
 *  · Yapped 没有的字段原样保留 Smithbox 值。
 *  · 没有任何实际改动时返回原引用（避免无谓的 identity 变化扰动下游 memo）。
 *
 * 这是**显示层覆盖**：origin 与偏移不动，写链（applyParamFieldMutation）只消费
 * 字段 id/type/offset，不受显示名影响。
 */
export function applyYappedFieldOverlay(
  document: ParamDefDocument,
  overlays: ReadonlyMap<string, YappedParamOverlay>
): ParamDefDocument {
  const overlay = overlays.get(document.typeName);
  if (!overlay || overlay.fields.size === 0) return document;
  let changed = false;
  const fields: ParamFieldDef[] = document.fields.map((field) => {
    const meta = overlay.fields.get(field.id);
    if (!meta) return field;
    let next = field;
    const displayName = meta.displayName?.trim();
    if (displayName && !looksJapaneseText(displayName) && displayName !== field.name) {
      next = { ...next, name: displayName };
      changed = true;
    }
    const description = meta.description?.trim();
    if (description && description !== field.description) {
      next = { ...next, description };
      changed = true;
    }
    return next;
  });
  return changed ? { ...document, fields } : document;
}

/** 查 Yapped 行名：entryName 是该 param 的容器条目名（不带 .param）。 */
export function resolveYappedRowName(
  entryName: string,
  rowId: number,
  rowNamesIndex: ReadonlyMap<string, ReadonlyMap<number, string>> | null
): string | undefined {
  if (!rowNamesIndex) return undefined;
  const table = rowNamesIndex.get(entryName);
  return table?.get(rowId);
}

/* ------------------------------------------------------------------ */
/*  Parsing                                                            */
/* ------------------------------------------------------------------ */

interface ParsedYappedField {
  id: string;
  displayName?: string;
  description?: string;
}

interface ParsedYappedParamdef {
  typeName: string;
  dataVersion: number | undefined;
  fields: ParsedYappedField[];
}

function parseYappedParamdefXml(xml: string): ParsedYappedParamdef {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw yappedError('YAPPED_XML_DTD_FORBIDDEN', 'Yapped 元数据禁止 DTD 与实体声明。');
  }
  let typeName = '';
  let dataVersion: number | undefined;
  const fields: ParsedYappedField[] = [];
  let currentField: ParsedYappedField | undefined;
  let textTarget: string | undefined;
  let text = '';
  let parseFailure: Error | undefined;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    parseFailure = yappedError('YAPPED_XML_DTD_FORBIDDEN', 'Yapped 元数据禁止 DTD。');
  });
  parser.on('opentag', (tag: SaxesTagPlain) => {
    if (tag.name === 'Field') {
      const def = attributeValue(tag, 'Def');
      if (!def) {
        parseFailure = yappedError('YAPPED_FIELD_DEF_MISSING', 'Yapped PARAMDEF 字段缺少 Def。');
        return;
      }
      const match = FIELD_ID.exec(def.trim());
      if (!match) {
        parseFailure = yappedError('YAPPED_FIELD_DEF_INVALID', 'Yapped 字段 Def 文法不支持。');
        return;
      }
      currentField = { id: match[1]! };
      return;
    }
    if (['ParamType', 'DataVersion', 'DisplayName', 'Description'].includes(tag.name)) {
      textTarget = tag.name;
      text = '';
    }
  });
  parser.on('text', (value: string) => {
    if (textTarget) text += value;
  });
  parser.on('closetag', (tag: SaxesTagPlain) => {
    const value = text.trim();
    if (tag.name === textTarget) {
      if (tag.name === 'ParamType') typeName = value;
      else if (tag.name === 'DataVersion') dataVersion = parseVersion(value);
      else if (currentField && tag.name === 'DisplayName') currentField.displayName = value;
      else if (currentField && tag.name === 'Description') currentField.description = value;
      textTarget = undefined;
      text = '';
    }
    if (tag.name === 'Field' && currentField) {
      fields.push(currentField);
      currentField = undefined;
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
  if (parseFailure || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(typeName)) {
    throw yappedError(
      'YAPPED_PARAMDEF_XML_INVALID',
      parseFailure?.message ?? 'Yapped PARAMDEF XML 缺少合法 ParamType。'
    );
  }
  return { typeName, dataVersion, fields };
}

function parseVersion(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * 解析一行 `id name -- 日文`。
 *
 * 分隔符 ` -- ` 存在时 name 取左侧；没有分隔符时 name 取 id 之后整段。
 * 英文名做 HTML 实体解码（`&#39;`/`&amp;`/`&quot;` 实测出现）。
 */
export function parseYappedNamesText(text: string): ReadonlyMap<number, string> {
  const rows = new Map<number, string>();
  const normalized = text.replace(/^﻿/u, '');
  for (const rawLine of normalized.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sepIndex = line.indexOf(' -- ');
    const body = sepIndex >= 0 ? line.slice(0, sepIndex) : line;
    const match = /^(\d+)\s+(.+)$/u.exec(body);
    if (!match) continue;
    const id = Number(match[1]!);
    if (!Number.isSafeInteger(id)) continue;
    const name = decodeHtmlEntities(match[2]!.trim());
    if (name.length === 0) continue;
    // 首个 id 优先：同 id 重复是行名表缺陷，取第一条稳定。
    if (!rows.has(id)) rows.set(id, name);
  }
  return rows;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

async function readBoundedText(path: string, maxBytes: number, code: string): Promise<string> {
  const fileStat = await stat(path);
  // 空文件合法（实测 DefaultKeyAssignParam0X.txt 是 0 字节占位）：按空文本返回，
  // 不判失败 —— 空行名表就是「没有名字」，不是读取错误。
  if (!fileStat.isFile() || fileStat.size < 0 || fileStat.size > maxBytes) {
    throw yappedError(code, 'Yapped 元数据文件超出支持的大小边界。');
  }
  if (fileStat.size === 0) return '';
  const bytes = await readFile(path);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw yappedError('YAPPED_TEXT_ENCODING_UNSUPPORTED', 'Yapped UTF-16BE 元数据不支持。');
  }
  return bytes.toString('utf8').replace(/^﻿/u, '');
}

function attributeValue(tag: SaxesTagPlain, name: string): string | undefined {
  const value = tag.attributes[name];
  return typeof value === 'string' ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yappedError(code: string, message: string): Error {
  return new YappedSourceError(code, message);
}

class YappedSourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'YappedSourceError';
  }
}
