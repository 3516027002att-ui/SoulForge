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
const MAP_ADDR_RE = /\bm\d{2}_\d{2}_\d{2}_\d{2}#[^\s.]*(?:\.[\w]+)?/gi;

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

/** 动作地址 → 字符串：`{ chr:'c1050', animId:200, eventIndex:0, field:'startFrame' }` → `c1050#A0200.e0.startFrame`。 */
export function formatActionAddress(address: ActionAddress): string {
  let result = address.chr.toLowerCase();
  if (address.animId !== undefined) {
    result = `${result}#${formatAnimCode(address.animId)}`;
    if (address.eventIndex !== undefined) {
      result = `${result}.e${address.eventIndex}`;
      if (address.field && address.field.length > 0) result = `${result}.${address.field}`;
    }
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
  const text = value.trim();
  const match = /^c(\d{4})(?:#A(\d{1,5})(?:\.e(\d+))?(?:\.([A-Za-z0-9_]+))?)?$/i.exec(text);
  if (!match) return null;
  const result: ActionAddress = { chr: `c${match[1]}`.toLowerCase() };
  if (match[2] === undefined) return result;
  result.animId = Number(match[2]);
  if (match[3] !== undefined) result.eventIndex = Number(match[3]);
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

  // 完整地址（带 #）优先整体提取，保证 m11_01_00_00#c1050_0000.posX 不被拆。
  for (const match of text.matchAll(ACTION_ADDR_RE)) add(match[0]);
  for (const match of text.matchAll(MAP_ADDR_RE)) add(match[0]);

  // 再抽独立分量（c1050 / a0200 / m11 / m11_01_00_00 等）。
  for (const match of text.matchAll(CHR_RE)) add(`c${match[1]}`);
  for (const match of text.matchAll(ANIM_CODE_RE)) add(`a${match[1]}`);
  for (const match of text.matchAll(HKX_STEM_RE)) add(`a${match[1]}_${match[2]}`);
  for (const match of text.matchAll(MAP_AREA_RE)) add(`m${match[1]}`);
  for (const match of text.matchAll(MAP_BLOCK_RE)) add(`m${match[1]}_${match[2]}_${match[3]}_${match[4]}`);

  return tokens;
}
