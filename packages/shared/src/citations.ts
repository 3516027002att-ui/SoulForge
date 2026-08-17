/**
 * S10 引用框选的数据契约（PARAM 先行）。
 *
 * 框选 = 与带 `data-cite` 的 DOM 做矩形相交，再从工作台状态拼逻辑引用
 * （用户裁定 2026-08-16：不要 OCR、不要截图像素识别）。本模块是 renderer 与
 * main 共用的纯逻辑：
 *  - `CiteHit`：工作台 DOM 上 `data-cite` 的 JSON 内容（只含逻辑 id，禁止绝对
 *    路径；renderer 拼、main 解码校验后不信任 renderer 的合法性）。
 *  - `decodeCiteHit` / `decodeCiteHits`：main（IPC 边界）与测试共用的解码器，
 *    拒绝绝对路径、非法 kind、非数字行 id、空标识符。
 *  - `mergeCiteHits`：一次框选把「一行 + N 个字段」合并成一条引用（跨表/跨行
 *    不合并——一次框选一条 chip，可多次点「引用」累加）。
 *  - `formatParamCiteLabel`：固定可见标签
 *    `param/<库短名>/<表名>/<行id>-<行名>【<字段中文>：<值>】…`，
 *    字段按框中的字段列出，框中只有行则只到行名。
 *
 * 安全边界：本模块不接触磁盘、不携带绝对路径；「renderer 仍不能读盘」不因引用
 * 框选而改变——label/value 只是 renderer 已显示内容的只读副本，main 校验的是
 * 结构与标识符。
 */

/** 一次框选命中的可引用节点（data-cite 的 JSON 值）。 */
export type CiteHit =
  | {
      kind: 'param-row';
      library: string;
      table: string;
      rowId: number;
      name?: string;
    }
  | {
      kind: 'param-field';
      library: string;
      table: string;
      rowId: number;
      fieldId: string;
      label: string;
      value: string;
    }
  | {
      kind: 'fmg-entry';
      library: string;
      id: number;
    }
  | {
      kind: 'event-line';
      document: string;
      eventId?: number;
      line: number;
    };

/** 一次框选合并后的单条引用（一行 + 其命中的字段子集）。 */
export interface ParamCitation {
  library: string;
  table: string;
  rowId: number;
  rowName?: string;
  fields: Array<{ fieldId: string; label: string; value: string }>;
}

/** 绝对路径前缀（Windows 盘符 / 正反斜杠开头）。标识符字段一律拒绝。 */
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;
/** 逻辑标识符（库短名 / 表名 / 字段 id）：不允许路径分隔符与空格。 */
const IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;

function requireIdentifier(value: string, fieldName: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`${fieldName} 不是合法逻辑名（仅字母数字下划线）：${value}`);
  }
  if (ABSOLUTE_PATH_RE.test(value)) {
    throw new Error(`${fieldName} 不得包含绝对路径。`);
  }
}

/** 解码单条 data-cite 命中；格式非法 / 含路径 / 标识符非法时抛错（main 拒收）。 */
export function decodeCiteHit(raw: unknown): CiteHit {
  if (typeof raw !== 'object' || raw === null) throw new Error('引用命中必须是对象。');
  const record = raw as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'fmg-entry') {
    const library = typeof record.library === 'string' ? record.library : '';
    const id = typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : null;
    if (library === '' || ABSOLUTE_PATH_RE.test(library)) throw new Error('fmg-entry library 非法。');
    if (id === null) throw new Error('fmg-entry 缺少 id。');
    return { kind: 'fmg-entry', library, id };
  }
  if (kind === 'event-line') {
    const document = typeof record.document === 'string' ? record.document : '';
    const line = typeof record.line === 'number' && Number.isFinite(record.line) ? record.line : null;
    if (document === '' || ABSOLUTE_PATH_RE.test(document)) throw new Error('event-line document 非法。');
    if (line === null) throw new Error('event-line 缺少 line。');
    const eventId = typeof record.eventId === 'number' && Number.isFinite(record.eventId) ? record.eventId : undefined;
    return { kind: 'event-line', document, line, ...(eventId === undefined ? {} : { eventId }) };
  }
  if (kind !== 'param-row' && kind !== 'param-field') {
    throw new Error(`不支持的引用命中类型：${String(kind)}`);
  }
  const library = typeof record.library === 'string' ? record.library : '';
  const table = typeof record.table === 'string' ? record.table : '';
  const rowId = typeof record.rowId === 'number' && Number.isFinite(record.rowId) ? record.rowId : null;
  if (library === '') throw new Error('引用命中缺少 library。');
  if (table === '') throw new Error('引用命中缺少 table。');
  if (rowId === null) throw new Error('引用命中缺少行 id。');
  requireIdentifier(library, 'library');
  requireIdentifier(table, 'table');
  if (kind === 'param-row') {
    const name = typeof record.name === 'string' && record.name.trim() !== '' ? record.name : undefined;
    return { kind, library, table, rowId, ...(name !== undefined ? { name } : {}) };
  }
  const fieldId = typeof record.fieldId === 'string' ? record.fieldId : '';
  const label = typeof record.label === 'string' ? record.label : '';
  const value = typeof record.value === 'string' ? record.value : '';
  if (fieldId === '') throw new Error('引用命中缺少字段 id。');
  requireIdentifier(fieldId, 'fieldId');
  return { kind, library, table, rowId, fieldId, label, value };
}

/** 解码整批框选命中（空数组视为非法——空框选不产生引用）。 */
export function decodeCiteHits(value: unknown): CiteHit[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('引用框选结果为空。');
  }
  return value.map((item, index) => {
    try {
      return decodeCiteHit(item);
    } catch (error) {
      throw new Error(
        `第 ${index + 1} 条命中无效：${error instanceof Error ? error.message : '格式非法'}`
      );
    }
  });
}

/**
 * 把一次框选的命中合并成一条引用。
 *
 * 锚定策略（S10 拍死「一次框选一条 chip」）：字段命中锚定行——字段栏永远显示
 * **选中行**的字段，框里扫到的其他行（同表不同 rowId）是误框，丢弃不并入；
 * 无字段命中时取第一行。跨表字段/行（当前 UI 不会出现，防御性处理）同样按
 * 锚定的 library+table+rowId 过滤。同字段去重（框选重叠时同一字段命中多次）。
 * 没有任何行与字段命中时返回 null（「这块还不能引用」）。
 */
export function mergeCiteHits(hits: readonly CiteHit[]): ParamCitation | null {
  const rows = hits.filter((hit): hit is Extract<CiteHit, { kind: 'param-row' }> => hit.kind === 'param-row');
  const fields = hits.filter(
    (hit): hit is Extract<CiteHit, { kind: 'param-field' }> => hit.kind === 'param-field'
  );
  const anchor = fields[0] ?? rows[0];
  if (anchor === undefined) return null;
  const anchorRow = rows.find(
    (hit) => hit.library === anchor.library && hit.table === anchor.table && hit.rowId === anchor.rowId
  );
  const seenFieldIds = new Set<string>();
  const mergedFields: ParamCitation['fields'] = [];
  for (const field of fields) {
    if (field.library !== anchor.library || field.table !== anchor.table || field.rowId !== anchor.rowId) {
      continue;
    }
    if (seenFieldIds.has(field.fieldId)) continue;
    seenFieldIds.add(field.fieldId);
    mergedFields.push({ fieldId: field.fieldId, label: field.label, value: field.value });
  }
  return {
    library: anchor.library,
    table: anchor.table,
    rowId: anchor.rowId,
    ...(anchorRow?.name !== undefined ? { rowName: anchorRow.name } : {}),
    fields: mergedFields
  };
}

/**
 * 引用的固定可见标签（S10 拍死格式）：
 * `param/<库短名>/<表名>/<行id>-<行名>【<字段中文>：<值>】…`
 * 字段按框中的字段列出；框中只有行则只到行名。库短名用 `gameparam` 这类逻辑名，
 * 绝不出 `D:\...`。
 */
export function formatParamCiteLabel(citation: ParamCitation): string {
  const head = `param/${citation.library}/${citation.table}/${citation.rowId}`
    + (citation.rowName !== undefined ? `-${citation.rowName}` : '');
  if (citation.fields.length === 0) return head;
  return head + citation.fields.map((field) => `【${field.label}：${field.value}】`).join('');
}
