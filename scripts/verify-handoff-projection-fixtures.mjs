#!/usr/bin/env node
/**
 * 交接书投影 fixture。
 *
 * 为什么需要独立 fixture 而不是只靠 --check：
 *
 * --check 只回答「当前 markdown 是否等于当前 JSON 的投影」。它抓得住手改表格，
 * 但抓不住投影器本身退化——比如渲染规则改动后把 `—` 写成空单元格、把叙述型
 * entryPoint 整条包进反引号、或者列序悄悄变了。那些改动会让 --check 与生成
 * 同时「一致」，却把交接书写坏，而门禁全绿。
 *
 * 所以这里断言的是投影器的输出契约本身：列集必须与 handoff-integrity-lib 的
 * *_HEADERS 逐 token 对齐、单元格不得含裸换行或裸竖线、空值必须是 —、
 * 生成幂等、标记缺失必须失败关闭。这些断言与 JSON 内容无关，改数据不会误伤。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS, loadProjectionSources, projectHandoff, beginMarker, endMarker, HANDOFF } from './generate-handoff-projection.mjs';

const root = process.cwd();
const findings = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) return;
  findings.push({ severity: 'error', code: 'PROJECTION_FIXTURE_FAILED', where: name, message: detail });
}

// handoff-integrity-lib 的列集是门禁契约。这里复制它期望的 token 而不是 import——
// 那个模块没有导出 *_HEADERS，而为了 fixture 去导出内部常量会扩大它的公开面。
// 复制的代价由本 fixture 自己承担：两边不一致时下面的对齐断言会失败。
const EXPECTED_HEADER_TOKENS = {
  'slice-panel': ['切片id', 'lifecycle', 'authority', 'blockerrefs', '目标能力', '可独立验收切片', '硬前置', '主要入口', 'requiredvalidation', 'authority上限'],
  'active-claims': ['sliceid', 'claimid', 'owner', 'claimedat', 'heartbeatat', 'recoverytrigger'],
  'blocker-index': ['blockerid', 'reason', '影响gate/切片', '责任方', '所需输入', '解锁验证', '复查触发器', 'evidence']
};

const headerToken = (cellText) => cellText.replaceAll('`', '').replace(/\*\*/g, '').replace(/\s+/g, '').toLowerCase();

/**
 * 按未转义竖线切列。不能用 line.split('|')——被 cell() 转义成 `\|` 的竖线也会
 * 被切开，一行含竖线的数据就会多出一列，而列数断言反倒把正确的转义判成错误。
 * 实测：goal='a | b' 的行 split('|') 得到 11 段而不是 10。
 */
const splitRow = (line) => {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') { current += '\\|'; i += 1; continue; }
    if (ch === '|') { cells.push(current); current = ''; continue; }
    current += ch;
  }
  cells.push(current);
  // 首尾是竖线外侧的空段，不是列。
  return cells.slice(1, -1).map((c) => c.trim());
};

const sources = loadProjectionSources(root);
const blocks = BLOCKS(sources);

// 合成边界数据。真实治理数据当前恰好没有空字符串字段、没有含竖线的文本、
// 也没有空数组以外的空值，所以只对真实数据断言会漏掉整类退化：实测把
// cell() 的空值返回从 — 改成 '' 时，全部 2858 项真实断言仍然通过。
// 边界值必须由 fixture 自己构造，不能指望生产数据碰巧覆盖。
const EDGE_SOURCES = {
  slicesData: {
    slices: [{
      sliceId: 'W-EDGE-01',
      targetRelease: 'V0.5',
      lifecycle: 'ready',
      authority: 'unverified',
      authorityCap: 'unverified',
      authorityCapNote: '',                       // 空字符串必须渲染成 —
      capabilityIds: [],                          // 空数组
      blockerRefs: [],
      goal: 'a | b',                              // 裸竖线必须转义
      hardPrerequisites: 'line1\nline2',          // 裸换行必须压平
      entryPoints: [],
      requiredValidation: '`unclosed',            // 不成对反引号必须被抓到
      declaresUnfrozenValidation: false
    }],
    activeClaims: [{
      sliceId: 'W-EDGE-01', claimId: 'claim-edge', owner: '', claimedAt: '', heartbeatAt: '', recoveryTrigger: ''
    }],
    invariants: []
  },
  gatesData: { gates: [], invariants: [] },
  blockersData: { blockers: [], invariants: [] },
  evidenceRecords: []
};

{
  const edgeBlocks = BLOCKS(EDGE_SOURCES);
  const slicePanel = edgeBlocks['slice-panel']();
  const claimRow = edgeBlocks['active-claims']();
  const sliceCells = splitRow(slicePanel.split('\n')[2]);
  const claimCells = splitRow(claimRow.split('\n')[2]);

  // splitRow 已剥掉首尾空段，索引 0 起：
  // 0 切片ID / 1 lifecycle / 2 authority / 3 blockerRefs / 4 capabilityIds /
  // 5 goal / 6 hardPrerequisites / 7 entryPoints / 8 requiredValidation / 9 cap
  check('edge/empty-string-becomes-dash', sliceCells[9] === '—', `空 authorityCapNote 应渲染为 —，实际 ${JSON.stringify(sliceCells[9])}`);
  check('edge/empty-array-becomes-dash', sliceCells[4] === '—', `空 capabilityIds 应渲染为 —，实际 ${JSON.stringify(sliceCells[4])}`);
  check('edge/empty-entrypoints-becomes-dash', sliceCells[7] === '—', `空 entryPoints 应渲染为 —，实际 ${JSON.stringify(sliceCells[7])}`);
  check('edge/pipe-escaped', sliceCells[5].includes('\\|') && !/(?<!\\)\|/.test(sliceCells[5]), `goal 里的竖线必须转义，实际 ${JSON.stringify(sliceCells[5])}`);
  check('edge/newline-flattened', !/[\r\n]/.test(sliceCells[6]), 'hardPrerequisites 里的换行必须压平。');
  check('edge/row-not-broken-by-newline', slicePanel.split('\n').length === 3, `含换行的字段不得增加输出行数，实际 ${slicePanel.split('\n').length} 行`);
  check('edge/unbalanced-backtick-detected', (sliceCells[8].match(/`/g) ?? []).length % 2 === 0, `渲染后反引号必须成对，实际 ${JSON.stringify(sliceCells[8])}`);
  for (const [ci, text] of claimCells.entries()) {
    check(`edge/claim-col${ci}-not-blank`, text.length > 0, `claim 空字段应渲染为 —，实际第 ${ci} 列为空。`);
  }
}

for (const [name, build] of Object.entries(blocks)) {
  const body = build();
  const lines = body.split('\n');

  if (name === 'active-claims' && sources.slicesData.activeClaims.length === 0) {
    check(`${name}/empty-is-prose`, !body.startsWith('|'), '空 claim 列表应渲染为说明文字而不是空表格。');
    continue;
  }

  check(`${name}/has-separator`, lines[1] !== undefined && /^\|(?:---\|)+$/.test(lines[1]), '第二行必须是 markdown 表格分隔行。');

  const header = splitRow(lines[0]);
  const expected = EXPECTED_HEADER_TOKENS[name];
  if (expected !== undefined) {
    check(
      `${name}/header-matches-gate`,
      header.length === expected.length && expected.every((token, i) => headerToken(header[i] ?? '') === token),
      `列集必须与 handoff-integrity-lib 的门禁常量逐 token 对齐。实际 ${JSON.stringify(header.map(headerToken))}`
    );
  }

  const dataRows = lines.slice(2);
  check(`${name}/has-rows`, dataRows.length > 0, '投影区不能为空表格。');

  for (const [index, line] of dataRows.entries()) {
    const cells = splitRow(line);
    check(
      `${name}/row${index}/column-count`,
      cells.length === header.length,
      `第 ${index} 行 ${cells.length} 列，表头 ${header.length} 列。`
    );
    for (const [ci, text] of cells.entries()) {
      // 空单元格会让读者无法区分「无此项」与「漏填」，且 hasMeaningfulValue
      // 对空串与 — 的判定相同——但只有 — 是显式声明。
      check(`${name}/row${index}/col${ci}/not-blank`, text.length > 0, `第 ${index} 行第 ${ci} 列为空；空值必须写作 —。`);
      // 裸竖线截断列，裸换行截断行。两者都会静默破坏表格结构。
      check(`${name}/row${index}/col${ci}/escaped`, !/(?<!\\)\|/.test(text) && !/[\r\n]/.test(text), `第 ${index} 行第 ${ci} 列含未转义的竖线或换行。`);
      // 反引号必须成对，否则 markdown 渲染会把后续文本全部吞成代码。
      check(`${name}/row${index}/col${ci}/backticks-balanced`, (text.match(/`/g) ?? []).length % 2 === 0, `第 ${index} 行第 ${ci} 列反引号不成对。`);
    }
  }
}

// 幂等：对同一份 JSON 连续投影两次必须得到相同结果。不幂等意味着渲染里有
// 顺序不稳定的成分（例如遍历 Map 或依赖时间），会让门禁随机变红。
const first = projectHandoff(root);
check('projection/no-marker-findings', first.findings.length === 0, `标记检查应无 finding，实际 ${JSON.stringify(first.findings)}`);
check('projection/idempotent', !first.drifted, '当前交接书应已是最新投影；先运行 npm run handoff:project。');

// 所有区块都必须真的落在交接书里。少一对标记就等于那张表脱离了投影，
// 会退回手抄状态而门禁不报错。
const handoffText = readFileSync(join(root, HANDOFF), 'utf8');
for (const name of Object.keys(blocks)) {
  check(`markers/${name}/begin-once`, handoffText.split(beginMarker(name)).length === 2, `BEGIN 标记必须恰好出现一次：${name}`);
  check(`markers/${name}/end-once`, handoffText.split(endMarker(name)).length === 2, `END 标记必须恰好出现一次：${name}`);
  check(
    `markers/${name}/order`,
    handoffText.indexOf(beginMarker(name)) < handoffText.indexOf(endMarker(name)),
    `BEGIN 必须在 END 之前：${name}`
  );
}

// 投影区之外不得残留同构表格：漏挂标记的表格会成为第二份副本，
// 而 §13.1 的 12 行 goal 分叉正是这样产生的。
//
// 判据是表头列集，不是「有没有治理 ID 开头的行」。交接书里另有语义不同、
// 恰好也以 Gate ID 开头的表——§18.1 的验收定义表列是
// 「Gate ID | 必须冻结的范围 | 通过条件 | 阻止通过的证据」，讲的是 Gate 该怎么算
// 通过，不是它当前什么状态。那张表不是副本，按行首匹配会误伤它。
const markerSpans = Object.keys(blocks)
  .map((name) => [handoffText.indexOf(beginMarker(name)), handoffText.indexOf(endMarker(name)) + endMarker(name).length])
  .filter(([start]) => start >= 0);
const insideProjection = (offset) => markerSpans.some(([start, end]) => offset >= start && offset < end);

const projectedHeaderTokens = new Set(
  Object.values(blocks)
    .map((build) => build())
    .filter((body) => body.startsWith('|'))
    .map((body) => splitRow(body.split('\n')[0]).map(headerToken).join('|'))
);
const strayTables = [];
for (const match of handoffText.matchAll(/^\|.*\|$/gm)) {
  if (insideProjection(match.index)) continue;
  const signature = splitRow(match[0]).map(headerToken).join('|');
  if (projectedHeaderTokens.has(signature)) strayTables.push(match[0].slice(0, 80));
}
check(
  'no-stray-projected-tables',
  strayTables.length === 0,
  `投影区之外存在与投影表同构的表头（会成为第二份副本）：${JSON.stringify(strayTables.slice(0, 3))}`
);

const errors = findings.filter((finding) => finding.severity === 'error');
console.log(JSON.stringify({
  ok: errors.length === 0,
  message: errors.length === 0
    ? `交接书投影 fixture 全部通过（${checks} 项）`
    : `交接书投影 fixture 失败 ${errors.length} 项`,
  checks,
  blocks: Object.keys(blocks),
  lockedBehaviours: [
    '生成的列集与 handoff-integrity-lib 门禁常量逐 token 对齐',
    '单元格不含裸竖线、裸换行或不成对反引号；空值一律写作 —',
    '每行列数与表头一致',
    '投影幂等；标记必须成对且各出现一次',
    '投影区之外不得残留治理表格行'
  ],
  findings
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
