import type {
  MsgExport,
  ParamFieldSymbol,
  ParamRowSymbol,
  ReferenceEdge,
  TextEntrySymbol
} from '@soulforge/shared';

/**
 * PARAM 到 FMG 的文本关联。
 *
 * 这两类关系来自成熟工具使用的两种稳定语义：
 * - 字段自身明确是 nameId/textId/msgId 等文本引用；
 * - Sekiro 的 Row-FMG 注释把 EquipParamGoods 等参数行的 rowId 直接映射
 *   到对应的 Title_* 文本表。
 *
 * 这里只用于候选发现和证据图。它不会把文本 ID提升为 PARAM rowId，也
 * 不替代当前工作区的 Bridge 原生读取、sourceHash/sourceRevision 或写入门禁。
 */

export type ParamTextLinkKind = 'field-text-id' | 'row-fmg-id';

export interface ParamTextLink {
  fieldId?: string;
  referenceValue: number;
  kind: ParamTextLinkKind;
  entry: TextEntrySymbol;
}

export type TextEntryLookup = ReadonlyMap<number, readonly TextEntrySymbol[]>;

/**
 * 这些是 Smithbox SDT Row FMG Annotations 中当前已确认的参数→标题域。
 * category/sourceUri 允许不同 Bridge 导出使用 Title_Goods、Goods、item 或
 * アイテム名等不同名称，但必须仍然命中对应的文本容器，不对所有 FMG 做
 * rowId 猜测。
 */
const ROW_FMG_ASSOCIATIONS: Readonly<Record<string, readonly string[]>> = {
  equipparamaccessory: ['title_accessories', 'accessories', 'accessory'],
  equipparamgoods: ['title_goods', 'goods', 'item', 'itemname', 'アイテム名'],
  equipparamweapon: ['title_weapons', 'weapons', 'weapon'],
  equipparamprotector: ['title_armor', 'armor', 'protector'],
  magic: ['title_magic', 'magic']
};

const MAX_PARAM_TEXT_LINKS = 16;

export function buildTextEntryLookup(msgExports: readonly MsgExport[]): Map<number, TextEntrySymbol[]> {
  const lookup = new Map<number, TextEntrySymbol[]>();
  for (const msgExport of msgExports) {
    for (const entry of msgExport.entries) {
      const matches = lookup.get(entry.textId) ?? [];
      matches.push(entry);
      lookup.set(entry.textId, matches);
    }
  }
  return lookup;
}

/** 只接受明确的非负整数引用；-1 等 PARAM 空槽永远不会变成文本候选。 */
export function parseParamTextReference(value: ParamFieldSymbol['value']): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
      ? Number(value.trim())
      : null;
  return numeric !== null && Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * PARAM metadata 没有携带完整的 FmgRef XML 属性时，仍只能按字段语义识别
 * 文本引用。字段名/说明不满足明确模式就不查 FMG，避免把 itemId、iconId
 * 等普通整数误解释成 textId。
 */
export function isParamTextReferenceField(field: ParamFieldSymbol): boolean {
  const fieldId = compactToken(field.fieldId ?? '');
  if (fieldId.length > 0 && isTextIdToken(fieldId)) return true;

  const labels = [field.name, field.description].filter((value): value is string => (
    typeof value === 'string' && value.trim().length > 0
  ));
  return labels.some((label) => {
    const lower = label.toLowerCase();
    const hasTextWord = /text|msg|message|fmg|文本|文字|消息|名称|名字|标题|描述/iu.test(lower);
    const hasIdWord = /id|编号|索引|引用/iu.test(lower);
    return hasTextWord && hasIdWord;
  });
}

/**
 * Return all source-backed text entries for one PARAM row. The result is
 * deterministic and bounded so a wide row cannot create a RAG/CPU amplifier.
 */
export function collectParamTextLinks(
  row: ParamRowSymbol,
  textEntriesById: TextEntryLookup,
  maxLinks = MAX_PARAM_TEXT_LINKS
): ParamTextLink[] {
  if (maxLinks <= 0) return [];
  const byUri = new Map<string, ParamTextLink>();

  for (const field of row.fields ?? []) {
    if (!isParamTextReferenceField(field)) continue;
    const referenceValue = parseParamTextReference(field.value);
    if (referenceValue === null) continue;
    for (const entry of textEntriesById.get(referenceValue) ?? []) {
      byUri.set(entry.uri, {
        ...(field.fieldId ? { fieldId: field.fieldId } : {}),
        referenceValue,
        kind: 'field-text-id',
        entry
      });
    }
  }

  const association = rowFmgAssociation(row.paramName);
  if (association.length > 0) {
    for (const entry of textEntriesById.get(row.rowId) ?? []) {
      if (!matchesTextDomain(entry, association)) continue;
      // An explicit field relation is stronger than the row-FMG fallback when
      // both point to the same URI.
      if (byUri.has(entry.uri)) continue;
      byUri.set(entry.uri, {
        referenceValue: row.rowId,
        kind: 'row-fmg-id',
        entry
      });
    }
  }

  return [...byUri.values()]
    .sort((left, right) => {
      const kindDelta = linkRank(right.kind) - linkRank(left.kind);
      if (kindDelta !== 0) return kindDelta;
      const categoryDelta = (left.entry.category ?? '').localeCompare(right.entry.category ?? '');
      if (categoryDelta !== 0) return categoryDelta;
      return left.entry.uri.localeCompare(right.entry.uri);
    })
    .slice(0, maxLinks);
}

/** Search projection shared by native PARAM search and RAG chunk building. */
export function paramTextLinkSearchText(links: readonly ParamTextLink[]): string {
  return links.map((link) => [
    `textRef=${link.kind}`,
    link.fieldId,
    `textId=${link.referenceValue}`,
    link.entry.category,
    link.entry.text,
    link.entry.uri
  ].filter(Boolean).join(' ')).join(' ');
}

/** Build graph edges for PARAM↔FMG links without numeric-fallback noise. */
export function buildParamTextReferenceEdges(
  params: readonly { rows: readonly ParamRowSymbol[] }[],
  msgExports: readonly MsgExport[]
): ReferenceEdge[] {
  const lookup = buildTextEntryLookup(msgExports);
  const edges: ReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const paramExport of params) {
    for (const row of paramExport.rows) {
      for (const link of collectParamTextLinks(row, lookup)) {
        const key = `${row.uri}\u0000${link.entry.uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const relation = link.kind === 'field-text-id'
          ? `字段 ${link.fieldId ?? 'text-reference'} 明确指向文本 ID ${link.referenceValue}`
          : `已声明的 Row-FMG 关联将 ${row.paramName} 行 ${row.rowId} 映射到文本 ID ${link.referenceValue}`;
        edges.push({
          fromUri: row.uri,
          toUri: link.entry.uri,
          kind: 'references_text',
          confidence: 'high',
          reason: `PARAM↔FMG source-backed link: ${relation}。`,
          evidence: [{
            sourceUri: row.sourceUri,
            fieldName: link.fieldId ?? 'rowId',
            value: link.referenceValue,
            excerpt: `${row.paramName}#${row.rowId} -> ${link.entry.category ?? 'text'}#${link.entry.textId}: ${link.entry.text}`
          }]
        });
      }
    }
  }
  return edges;
}

function rowFmgAssociation(paramName: string): readonly string[] {
  // Native ParamDef exports use the physical *_ST names (for example
  // EQUIP_PARAM_GOODS_ST), while the mature-tool annotations use the logical
  // domain name (EquipParamGoods). Normalize only that documented suffix; do
  // not strip arbitrary digits or names because those can identify a
  // different table.
  const normalized = compactToken(paramName).replace(/st$/u, '');
  return ROW_FMG_ASSOCIATIONS[normalized] ?? [];
}

function matchesTextDomain(entry: TextEntrySymbol, domains: readonly string[]): boolean {
  const haystack = compactToken([
    entry.category,
    entry.sourceUri,
    entry.uri
  ].filter(Boolean).join(' '));
  return domains.some((domain) => haystack.includes(compactToken(domain)));
}

function isTextIdToken(value: string): boolean {
  return /(?:^|\d)(?:name|description|desc|title|caption|role|text|msg|message|fmg)(?:id|index|idx)?$/.test(value)
    || /(?:name|description|desc|title|caption|role|text|msg|message|fmg)(?:id|index|idx)/.test(value);
}

function compactToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/giu, '');
}

function linkRank(kind: ParamTextLinkKind): number {
  return kind === 'field-text-id' ? 2 : 1;
}
