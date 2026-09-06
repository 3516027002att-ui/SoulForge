/**
 * 动作 / 地图的参数同构编址（问题 6）。
 *
 * 所有 padStart / 正则只准写在这里。各面板、索引、RAG、Agent 工具一律经
 * 本模块解析 / 格式化，禁止各面板手写一份。
 *
 * 地址语法（写死，与 docx/动作与地图Agent编址.docx 与 锐评/grok.txt 问题 6 同口径）：
 *
 *   动作：c1050 · c1050#A0200 · c1050#A0200.e0 · c1050#A0200.e0.startFrame
 *   地图：M11 · m11_01_00_00 · m11_01_00_00#c1050_0000 · m11_01_00_00#c1050_0000.posX
 *
 * symbolUri（稳定，给 RAG / cite）：
 *   action://c1050/A0200/e0
 *   action://c1050/tae/3/A0200/e0
 *   map://m11_01_00_00/part/c1050_0000
 *   map://m11_01_00_00/region/<name>
 *
 * 约定：
 *  - `cXXXX` 从路径 `chr/c1050.anibnd.dcx` / `c1050.chrbnd.dcx` 提取，
 *    正则 `(^|[/\\])c(\d{4})([./\\]|$)`。
 *  - `A0200` = `'A' + String(animId).padStart(4, '0')`，主键恒为 A+animId；
 *    合法 hkx 茎（如 `a000_020000`）只是检索别名，不做第二套主键。
 *  - `eN` 是该动画 `events[]` 的下标（不是 eventTypeId）。
 *  - 块 ID 必须是 `m\d{2}_\d{2}_\d{2}_\d{2}`，下划线是 ID 的一部分。
 *  - 实体名用 MSB part/region 原名，不翻译。
 */

export interface ActionAddress {
  /** `c1050`。 */
  chr: string;
  /** animId（如 200）。缺省表示只到角色级地址。 */
  animId?: number;
  /**
   * ANIBND 内 TAE child 的 section selector。直接写数字时表示 BND4
   * entryIndex；它只在当前 source 内有意义，不能替代 animId。
   */
  taeEntryIndex?: number;
  /** 显式的 BND4 entryId selector（与 taeEntryIndex/name/group 互斥）。 */
  taeEntryId?: number;
  /** 显式的 TAE child basename selector（与其他 selector 互斥）。 */
  taeEntryName?: string;
  /** 显式的逻辑 TAE group selector（与其他 selector 互斥）。 */
  taeGroup?: string;
  /** 该动画 events[] 下标（如 e0 的 0）。 */
  eventIndex?: number;
  /** 字段名（startFrame / endFrame / SoundID / …）。 */
  field?: string;
}

export interface MapAddress {
  /** 完整四段块 ID，如 `m11_01_00_00`。 */
  block: string;
  /** MSB part/region 原名；缺省表示只到块级地址。 */
  name?: string;
  /** 字段名（posX / posY / …）。 */
  field?: string;
}

const CHR_RE = /\bc(\d{4})(?![\w])/gi;
const ANIM_CODE_RE = /\bA(\d{1,5})(?![\w])/gi;
const HKX_STEM_RE = /\ba(\d{3})_(\d+)(?![\w])/gi;
const MAP_AREA_RE = /\b[Mm](\d{2})(?![\w])/g;
const MAP_BLOCK_RE = /\bm(\d{2})_(\d{2})_(\d{2})_(\d{2})(?![\w])/g;
const ACTION_ADDR_RE = /\bc\d{4}#(?:A\d{1,5}|a\d{3}_\d+)(?:\.e\d+)?(?:\.\w+)?/gi;
const ACTION_URI_ADDR_RE = /\baction:\/\/c\d{4}\/(?:A\d{1,5}(?:\/e\d+(?:\.[A-Za-z0-9_]+)?)?|tae\/(?:(?:0|[1-9]\d*)|index\/(?:0|[1-9]\d*)|id\/-?\d+|(?:name|group)\/[^\s/?#]+)\/A\d{1,5}(?:\/e\d+(?:\.[A-Za-z0-9_]+)?)?)/gi;
const MAP_ADDR_RE = /\bm\d{2}_\d{2}_\d{2}_\d{2}#[^\s.]*(?:\.[\w]+)?/gi;

type ActionSectionSelector =
  | { taeEntryIndex: number }
  | { taeEntryId: number }
  | { taeEntryName: string }
  | { taeGroup: string };

function parseSafeIntegerSegment(value: string, allowNegative: boolean, canonical = true): number | null {
  const pattern = canonical
    ? allowNegative ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/
    : allowNegative ? /^-?\d+$/ : /^\d+$/;
  if (!pattern.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decodeSectionText(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (decoded.length === 0 || /[\u0000-\u001f\u007f]/.test(decoded) || /[\\/?#]/.test(decoded)) return null;
  return decoded;
}

function parseActionSectionSelector(kind: string, value: string | undefined): ActionSectionSelector | null {
  const normalizedKind = kind.toLowerCase();
  if (normalizedKind === 'index') {
    if (value === undefined) return null;
    const taeEntryIndex = parseSafeIntegerSegment(value, false);
    return taeEntryIndex === null ? null : { taeEntryIndex };
  }
  if (normalizedKind === 'id') {
    if (value === undefined) return null;
    const taeEntryId = parseSafeIntegerSegment(value, true);
    return taeEntryId === null ? null : { taeEntryId };
  }
  if (normalizedKind === 'name') {
    const taeEntryName = value === undefined ? null : decodeSectionText(value);
    return taeEntryName === null ? null : { taeEntryName };
  }
  if (normalizedKind === 'group') {
    const taeGroup = value === undefined ? null : decodeSectionText(value);
    return taeGroup === null ? null : { taeGroup };
  }
  return null;
}

function parseActionTail(parts: string[], codeIndex: number, section?: ActionSectionSelector): ActionAddress | null {
  const code = parts[codeIndex];
  if (code === undefined || !/^A\d{1,5}$/i.test(code)) return null;
  const animId = parseAnimCode(code);
  if (animId === null) return null;
  if (parts.length > codeIndex + 2) return null;

  const result: ActionAddress = { chr: '', animId, ...section };
  if (parts.length === codeIndex + 2) {
    const eventMatch = /^e(\d+)(?:\.([A-Za-z0-9_]+))?$/i.exec(parts[codeIndex + 1] ?? '');
    if (!eventMatch) return null;
    const eventIndex = parseSafeIntegerSegment(eventMatch[1]!, false, false);
    if (eventIndex === null) return null;
    result.eventIndex = eventIndex;
    if (eventMatch[2] !== undefined) result.field = eventMatch[2];
  }
  return result;
}

function parseActionUri(value: string): ActionAddress | null {
  const match = /^action:\/\/(c\d{4})\/(.+)$/i.exec(value);
  if (!match) return null;
  const parts = match[2]!.split('/');
  if (parts.some((part) => part.length === 0)) return null;

  if (parts[0]!.toLowerCase() !== 'tae') {
    const result = parseActionTail(parts, 0);
    return result === null ? null : { ...result, chr: match[1]!.toLowerCase() };
  }

  if (parts.length < 3) return null;
  let selector: ActionSectionSelector | null = null;
  let codeIndex = 2;
  const selectorHead = parts[1]!;
  if (/^(?:0|[1-9]\d*)$/.test(selectorHead)) {
    selector = parseActionSectionSelector('index', selectorHead);
  } else if (/^(?:index|id|name|group)$/i.test(selectorHead)) {
    selector = parseActionSectionSelector(selectorHead, parts[2]);
    codeIndex = 3;
  }
  if (selector === null) return null;

  const result = parseActionTail(parts, codeIndex, selector);
  return result === null ? null : { ...result, chr: match[1]!.toLowerCase() };
}

function formatActionSectionSelector(address: ActionAddress): string | null {
  const selectors: Array<{ key: 'index' | 'id' | 'name' | 'group'; value: number | string }> = [];
  if (address.taeEntryIndex !== undefined) selectors.push({ key: 'index', value: address.taeEntryIndex });
  if (address.taeEntryId !== undefined) selectors.push({ key: 'id', value: address.taeEntryId });
  if (address.taeEntryName !== undefined) selectors.push({ key: 'name', value: address.taeEntryName });
  if (address.taeGroup !== undefined) selectors.push({ key: 'group', value: address.taeGroup });
  if (selectors.length === 0) return null;
  if (selectors.length > 1) {
    throw new TypeError('ActionAddress 只能包含一个 TAE section selector。');
  }

  const selector = selectors[0]!;
  if (selector.key === 'index') {
    if (typeof selector.value !== 'number' || !Number.isSafeInteger(selector.value) || selector.value < 0) {
      throw new TypeError('ActionAddress.taeEntryIndex 必须是非负 safe integer。');
    }
    return `tae/${String(selector.value)}`;
  }
  if (selector.key === 'id') {
    if (typeof selector.value !== 'number' || !Number.isSafeInteger(selector.value)) {
      throw new TypeError('ActionAddress.taeEntryId 必须是 safe integer。');
    }
    return `tae/id/${String(selector.value)}`;
  }

  if (typeof selector.value !== 'string' || decodeSectionText(encodeURIComponent(selector.value)) === null) {
    throw new TypeError(`ActionAddress.${selector.key} 必须是非空且不含路径分隔符的字符串。`);
  }
  return `tae/${selector.key}/${encodeURIComponent(selector.value)}`;
}

/** animId → `A0200`。 */
export function formatAnimCode(animId: number): string {
  if (!Number.isFinite(animId) || animId < 0) return `A${String(animId)}`;
  return `A${String(Math.trunc(animId)).padStart(4, '0')}`;
}

/** `A0200` / `A200` → 200；解析不出返回 null。 */
export function parseAnimCode(value: string): number | null {
  const match = /^A(\d{1,5})$/i.exec(value.trim());
  return match ? Number(match[1]) : null;
}

/** 从路径 / 茎提取角色 id：`chr/c1050.anibnd.dcx` / `c1050.chrbnd.dcx` → `c1050`。 */
export function formatChrId(pathOrStem: string): string | null {
  const match = /(?:^|[/\\])c(\d{4})(?:[./\\]|$)/i.exec(pathOrStem.trim());
  return match ? `c${match[1]}`.toLowerCase() : null;
}

/** 提取完整四段块 ID：`map/m11_01_00_00/m11_01_00_00.msb.dcx` → `m11_01_00_00`。 */
export function formatMapBlock(pathOrId: string): string | null {
  const match = /\bm(\d{2})_(\d{2})_(\d{2})_(\d{2})(?![\w])/i.exec(pathOrId.trim());
  return match ? `m${match[1]}_${match[2]}_${match[3]}_${match[4]}`.toLowerCase() : null;
}

/** 块 → 区域号：`m11_01_00_00` → `M11`。解析不出返回空串。 */
export function formatMapArea(block: string): string {
  const bare = formatMapBlock(block) ?? block.trim().toLowerCase();
  const match = /m(\d{2})/.exec(bare);
  return match ? `M${match[1]}` : '';
}

/**
 * 动作地址 → 字符串。无 section selector 时保留旧语法
 * `c1050#A0200.e0.startFrame`；有 selector 时输出 canonical action URI，
 * 例如 `{ chr:'c1050', taeEntryIndex:3, animId:200, eventIndex:0 }` →
 * `action://c1050/tae/3/A0200/e0`。
 */
export function formatActionAddress(address: ActionAddress): string {
  let result = address.chr.toLowerCase();
  if (address.animId !== undefined) {
    const section = formatActionSectionSelector(address);
    if (section !== null) {
      if (!Number.isSafeInteger(address.animId) || address.animId < 0) {
        throw new TypeError('canonical ActionAddress.animId 必须是非负 safe integer。');
      }
      if (address.animId > 99999) throw new TypeError('canonical ActionAddress.animId 必须不超过 5 位。');
      if (address.eventIndex !== undefined
        && (!Number.isSafeInteger(address.eventIndex) || address.eventIndex < 0)) {
        throw new TypeError('canonical ActionAddress.eventIndex 必须是非负 safe integer。');
      }
      if (address.field && address.field.length > 0 && !/^[A-Za-z0-9_]+$/.test(address.field)) {
        throw new TypeError('canonical ActionAddress.field 只能包含字母、数字和下划线。');
      }
    }
    result = section === null
      ? `${result}#${formatAnimCode(address.animId)}`
      : `action://${result}/${section}/${formatAnimCode(address.animId)}`;
    if (address.eventIndex !== undefined) {
      result = section === null
        ? `${result}.e${address.eventIndex}`
        : `${result}/e${address.eventIndex}`;
      if (address.field && address.field.length > 0) result = `${result}.${address.field}`;
    }
  } else if (address.taeEntryIndex !== undefined
    || address.taeEntryId !== undefined
    || address.taeEntryName !== undefined
    || address.taeGroup !== undefined) {
    throw new TypeError('带 TAE section selector 的 ActionAddress 必须包含 animId。');
  }
  return result;
}

/**
 * 解析动作地址字符串（A 主键形式：`c1050#A0200.e0.startFrame`）。
 *
 * hkx 茎别名（`c1050#a000_020000`）能被 extractAtomicAddressTokens 整体保留供
 * 检索，但别名无法从本身无损还原 animId（stem 编号与 AE animId 不是同一套数，
 * 对应表本版没有），而 write-tae-document 需要数值 animId。故解析器对别名形式
 * fail-closed 返回 null，不编造主键 —— 未知映射不能开放读写目标。
 */
export function parseActionAddress(value: string): ActionAddress | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const uriResult = parseActionUri(text);
  if (uriResult !== null) return uriResult;
  const match = /^c(\d{4})(?:#A(\d{1,5})(?:\.e(\d+))?(?:\.([A-Za-z0-9_]+))?)?$/i.exec(text);
  if (!match) return null;
  const result: ActionAddress = { chr: `c${match[1]}`.toLowerCase() };
  if (match[2] === undefined) return result;
  result.animId = Number(match[2]);
  if (match[3] !== undefined) {
    const eventIndex = parseSafeIntegerSegment(match[3], false, false);
    if (eventIndex === null) return null;
    result.eventIndex = eventIndex;
  }
  if (match[4]) result.field = match[4];
  return result;
}

/** 地图地址 → 字符串：`{ block:'m11_01_00_00', name:'c1050_0000', field:'posX' }` → `m11_01_00_00#c1050_0000.posX`。 */
export function formatMapAddress(address: MapAddress): string {
  const block = formatMapBlock(address.block) ?? address.block.toLowerCase();
  let result = block;
  if (address.name && address.name.length > 0) {
    result = `${result}#${address.name}`;
    if (address.field && address.field.length > 0) result = `${result}.${address.field}`;
  }
  return result;
}

/** 解析地图地址字符串：`m11_01_00_00#c1050_0000.posX`。 */
export function parseMapAddress(value: string): MapAddress | null {
  const text = value.trim();
  const match = /^(m\d{2}_\d{2}_\d{2}_\d{2})(?:#([^\s.#]+)(?:\.([A-Za-z0-9_]+))?)?$/i.exec(text);
  if (!match) return null;
  const result: MapAddress = { block: (match[1] ?? '').toLowerCase() };
  if (match[2] !== undefined) {
    result.name = match[2];
    if (match[3]) result.field = match[3];
  }
  return result;
}

/**
 * 从文本里抽出原子地址 token（大小写不敏感，一律小写；下划线是 ID 一部分，
 * 保留不拆）。至少覆盖：`c\d{4}`、`A\d{1,5}`、`a\d{3}_\d+`（hkx 茎）、`M\d{2}`、
 * `m\d{2}_\d{2}_\d{2}_\d{2}`、以及带 `#` 的完整地址（含 .eN / .field）。
 * 供 queryParse tokenize 与 lookupIndex 在切词前先抽地址，避免被 replaceAll 拆碎。
 */
export function extractAtomicAddressTokens(text: string): string[] {
  const tokens: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value || value.length === 0) return;
    const normalized = value.toLowerCase();
    if (!tokens.includes(normalized)) tokens.push(normalized);
  };

  // 完整地址优先整体提取，保证带 # 的旧地址及 action:// section URI 不被拆。
  for (const match of text.matchAll(ACTION_ADDR_RE)) add(match[0]);
  for (const match of text.matchAll(ACTION_URI_ADDR_RE)) add(match[0]);
  for (const match of text.matchAll(MAP_ADDR_RE)) add(match[0]);

  // 再抽独立分量（c1050 / a0200 / m11 / m11_01_00_00 等）。
  for (const match of text.matchAll(CHR_RE)) add(`c${match[1]}`);
  for (const match of text.matchAll(ANIM_CODE_RE)) add(`a${match[1]}`);
  for (const match of text.matchAll(HKX_STEM_RE)) add(`a${match[1]}_${match[2]}`);
  for (const match of text.matchAll(MAP_AREA_RE)) add(`m${match[1]}`);
  for (const match of text.matchAll(MAP_BLOCK_RE)) add(`m${match[1]}_${match[2]}_${match[3]}_${match[4]}`);

  return tokens;
}
