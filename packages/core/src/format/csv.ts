/**
 * 极简 CSV 读写（T5-4 PARAM 导入导出）。
 *
 * 只支持 RFC 4180 的最小必要子集：逗号分隔、双引号包裹含分隔符/引号/换行的字段、
 * 双引号转义（`""`）。不处理 CR 内部的嵌入换行以外的边界 —— PARAM 的 CSV 由
 * 本应用自己生成，字段值要么是数字要么是单行文本，外部导入的畸形文件按行容错。
 *
 * 刻意不引第三方库：CSV 是常见的注入面（公式注入、字段膨胀），自家小实现 +
 * 单测覆盖比拉进一个生态库更可控。
 */

/**
 * 把行数组编码成 CSV 文本。每行字段数应一致（不强校验，交给调用方语义）。
 */
export function toCsvText(headers: string[], rows: Array<Array<string>>): string {
  const escape = (value: string): string => {
    if (/[",\n\r]/u.test(value)) {
      return `"${value.replaceAll('"', '""')}"`;
    }
    return value;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map(escape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * 解析 CSV 文本为「表头 + 数据行」。
 *
 * 容错：行内字段数不一致时丢弃多余字段；整行解析失败（引号未闭合）跳过该行并
 * 记诊断。返回结构化结果而不是抛异常 —— 导入路径要能「部分成功」。
 */
export function parseCsvText(
  text: string
): { ok: true; headers: string[]; rows: Array<string[]>; skipped: number } {
  const records: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let malformed = 0;

  // 统一换行：兼容 \r\n 与 \n；解析时逐个字符推进，保证引号内的换行被保留。
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') {
      // \r 只作为 \r\n 的一部分被消费；单独出现的 \r 视作换行。
      if (text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (inQuotes) malformed += 1;
      records.push(row);
      row = [];
      inQuotes = false;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      field = '';
      if (inQuotes) malformed += 1;
      records.push(row);
      row = [];
      inQuotes = false;
      continue;
    }
    field += char;
  }
  // 末尾残余字段。
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  if (records.length === 0) {
    return { ok: true, headers: [], rows: [], skipped: 0 };
  }
  const headers = records[0]!;
  const dataRows: string[][] = [];
  let skipped = 0;
  for (const record of records.slice(1)) {
    if (record.length === 1 && record[0]!.trim() === '') {
      skipped += 1; // 空行
      continue;
    }
    // 行内字段多于表头：截断（按表头对齐）；少于表头：补齐空串。
    dataRows.push([
      ...record.slice(0, headers.length),
      ...Array<string>(Math.max(0, headers.length - record.length)).fill('')
    ]);
  }
  return { ok: true, headers, rows: dataRows, skipped: skipped + malformed };
}
