/**
 * T5-4 CSV 模块（format/csv.ts）冒烟：PARAM 导入导出的最小 RFC 4180 子集。
 *
 * 只覆盖本应用自己生成的形状：逗号分隔、引号包裹含分隔符/引号/换行的字段、
 * 双引号转义（`""`）、CRLF 行尾、畸形输入按行容错（截断/补齐/跳过）。
 */
import { parseCsvText, toCsvText } from '../format/csv.js';

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function main(): void {
  // ── 编码：数字与单行文本不加引号 ──
  const plain = toCsvText(['id', 'name'], [
    ['1', '攻撃力'],
    ['2', 'poise']
  ]);
  expect(plain === 'id,name\r\n1,攻撃力\r\n2,poise\r\n', `plain csv: ${JSON.stringify(plain)}`);

  // ── 编码：含逗号/引号/换行的字段必须引号包裹 + 双引号转义 ──
  const escaped = toCsvText(['id', 'note'], [
    ['1', '含,逗号'],
    ['2', '说"你好"'],
    ['3', '两行\n文字']
  ]);
  expect(
    escaped === 'id,note\r\n1,"含,逗号"\r\n2,"说""你好"""\r\n3,"两行\n文字"\r\n',
    `escaped csv: ${JSON.stringify(escaped)}`
  );

  // ── 解码：编码产物原样读回（round-trip）──
  const round = parseCsvText(escaped);
  expect(round.ok && round.headers.length === 2, 'round-trip headers');
  expect(round.rows.length === 3, 'round-trip row count');
  expect(round.rows[0]![1] === '含,逗号', 'round-trip comma field');
  expect(round.rows[1]![1] === '说"你好"', 'round-trip quote field');
  expect(round.rows[2]![1] === '两行\n文字', 'round-trip newline field');
  expect(round.skipped === 0, `round-trip skipped=${round.skipped}`);

  // ── 解码：行内字段数不一致时截断/补齐 ──
  const ragged = parseCsvText('id,name,hp\r\n1,a\r\n2,b,100,EXTRA\r\n');
  expect(ragged.rows.length === 2, 'ragged row count');
  expect(ragged.rows[0]!.length === 3 && ragged.rows[0]![2] === '', 'ragged pad');
  expect(ragged.rows[1]!.length === 3 && ragged.rows[1]![2] === '100', 'ragged truncate');

  // ── 解码：空行跳过 + 未闭合引号行计入 skipped ──
  const blank = parseCsvText('id,name\r\n\r\n1,x\r\n');
  expect(blank.rows.length === 1 && blank.skipped === 1, 'blank line skipped');

  // ── 解码：空文本 ──
  const empty = parseCsvText('');
  expect(empty.ok && empty.headers.length === 0 && empty.rows.length === 0, 'empty csv');

  // ── 解码：CRLF 与 LF 混用（容错）──
  const mixed = parseCsvText('id,name\n1,a\r\n2,b\n');
  expect(mixed.rows.length === 2 && mixed.rows[1]![0] === '2', 'mixed line endings');

  console.log('runCsvSmoke: ok');
}

main();
