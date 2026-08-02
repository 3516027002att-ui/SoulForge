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
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BLOCKS, loadProjectionSources, projectHandoff, beginMarker, endMarker, HANDOFF } from './generate-handoff-projection.mjs';
import { TIER_ORDER, TIER_BY_SCRIPT, EXCLUDED } from './verify/tiers.mjs';

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
  'evidence-index': ['evidenceid', '能力/声明'],
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
  evidenceRecords: [],
  // scope-proposal 区块的边界源。少了它 BLOCKS(EDGE_SOURCES) 里该区块会直接
  // TypeError（实测：Cannot read properties of undefined (reading 'schemaVersion')）
  // ——边界循环当前只取表格区块，碰不到它，所以这一处曾是纯侥幸。
  // 字段集刻意最小：缺字段时投影必须产出 null 而不是崩溃或悄悄省略键，
  // 否则范围门禁读到的是一个键集不完整的提案。
  scopeData: { schemaVersion: '0.0.0', scopeItems: [] }
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

  // scope-proposal 在最小数据下必须仍产出结构完整、可解析的提案：
  // 缺字段渲染成 null，而不是崩溃或悄悄省略键——范围门禁按键集判定，
  // 少一个键它会报 FROZEN_POLICY_VALUE_INVALID 之类的错，指向的却是错的原因。
  const edgeProposal = edgeBlocks['scope-proposal']();
  const edgeLines = edgeProposal.split('\n');
  check('edge/scope-proposal-fenced', edgeLines[0] === '```json' && edgeLines.at(-1) === '```',
    '最小数据下仍必须是 json fenced block。');
  let edgeParsed = null;
  try {
    edgeParsed = JSON.parse(edgeLines.slice(1, -1).join('\n'));
  } catch (error) {
    check('edge/scope-proposal-parses', false, `最小数据下块内 JSON 必须可解析：${error.message}`);
  }
  if (edgeParsed !== null) {
    check('edge/scope-proposal-parses', true, '');
    check('edge/scope-proposal-empty-items', JSON.stringify(edgeParsed.scopeItems) === '[]',
      '空 scopeItems 应渲染为空数组而不是被省略。');
    check('edge/scope-proposal-missing-becomes-null', edgeParsed.ruling === null && edgeParsed.gameBuildRange === null,
      `缺失字段必须显式为 null，实际 ruling=${JSON.stringify(edgeParsed.ruling)} gameBuildRange=${JSON.stringify(edgeParsed.gameBuildRange)}`);
    check('edge/scope-proposal-key-count', Object.keys(edgeParsed).length === 18,
      `顶层键数必须恒为 18（缺数据也不省略键），实际 ${Object.keys(edgeParsed).length}`);
  }
}

/**
 * 非表格投影区。契约与表格完全不同，走独立断言而不是塞进表格循环。
 * 混在一起会让「第二行必须是表格分隔行」这类断言对 JSON 块报假失败，
 * 而放宽那条断言又会让真正的表格退化溜过去。
 */
const NON_TABLE_BLOCKS = new Set(['scope-proposal', 'command-index']);

{
  // §15 命令清单。原为手写分组裸命令：实测列出 38 条而 package.json 有 144 条,
  // 106 条从未出现在交接书里，且落后不被任何门禁发现（§15 不参与指纹）。
  // 权威是 scripts/verify/tiers.mjs——漏登记由 verify:audit 失败关闭。
  const body = blocks['command-index']();
  // 只取代码块内的命令。散文里也会出现 npm run（例如指路 verify:all 这个入口
  // 本身——它是 EXCLUDED 条目，出现在说明里是对的，出现在清单里才是错的）。
  const fencedCommands = [...body.matchAll(/~~~powershell\n([\s\S]*?)~~~/g)]
    .map((match) => match[1])
    .join('\n');
  const listed = [...fencedCommands.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((match) => match[1]);
  const registered = Object.keys(TIER_BY_SCRIPT);
  check('command-index/covers-every-registered-script',
    registered.every((script) => listed.includes(script)),
    `已登记层级的 script 必须全部出现，缺 ${registered.filter((s) => !listed.includes(s)).join(', ')}`);
  check('command-index/no-unregistered-script',
    listed.every((script) => registered.includes(script)),
    `不得出现未登记 script，多出 ${listed.filter((s) => !registered.includes(s)).join(', ')}`);
  check('command-index/no-duplicate', new Set(listed).size === listed.length,
    '同一命令不得重复列出——一条 script 只属一个层级。');
  // 层级顺序即执行顺序，乱序会误导 agent 先跑慢层。
  const tierHeadings = [...body.matchAll(/\*\*([a-z]+)\*\*（\d+ 条）/g)].map((match) => match[1]);
  check('command-index/tier-order-preserved',
    JSON.stringify(tierHeadings) === JSON.stringify(TIER_ORDER.filter((tier) => tierHeadings.includes(tier))),
    `层级必须按 TIER_ORDER 排列，实际 ${JSON.stringify(tierHeadings)}`);
  // 排除项必须逐条带理由。只列名字等于「无人解释为什么不跑」。
  const excludedEntries = Object.entries(EXCLUDED);
  check('command-index/excluded-listed-with-reason',
    excludedEntries.every(([script, reason]) => body.includes(`\`${script}\`：${reason}`)),
    '每条排除项必须连同排除理由一起呈现。');

  check('command-index/counts-match-authority',
    body.includes(`全部 ${registered.length} 条`) && body.includes(`另有 ${excludedEntries.length} 条`),
    `计数必须与 tiers.mjs 一致（登记 ${registered.length} / 排除 ${excludedEntries.length}）。`);
}

{
  /**
   * §18.2.1 提案块的解析方登记表。
   *
   * 这个块被四处独立解析，各自写着自己的正则。本轮给它加投影标记时，前三处
   * 都在治理门禁里、当场报错，第四处在 packages/core 的 TS smoke 里——
   * 治理门禁全绿，只有 npm test 才炸，而那是本轮最后才跑的命令。
   *
   * 抽公共解析器要跨 scripts/（ESM .mjs）与 packages/core（TS 构建产物）两个
   * 模块体系，代价大于收益；改为登记 + 静态门禁：新增第五个解析方必须登记，
   * 否则这里失败关闭并指出漏改的风险。判据是「文件里出现 BEGIN marker 字面量」，
   * 不是正则形状——形状可以各不相同，存在性不能漏。
   */
  const PROPOSAL_PARSERS = Object.freeze({
    'scripts/verify-release-scope.mjs': '范围裁定门禁（提案语义与冻结值的权威判定）',
    'scripts/verify-release-scope-fixtures.mjs': '范围门禁的负向 fixture（构造带/不带投影标记两种形态）',
    'scripts/handoff-integrity-lib.mjs': 'REL-SCOPE 主题域锚点（只用 marker 定位，不解析块内 JSON）',
    'packages/core/src/testing/runReleaseEditorAcceptanceSmoke.ts': '发布编辑器验收：核对 SCOPE-EDITORS 的冻结 editorIds'
  });
  const marker = '<!-- SOULFORGE_RELEASE_SCOPE_PROPOSAL_BEGIN -->';

  // 必须真的扫仓库，不能只遍历登记表里的四条路径。
  // 实测过一版只遍历登记表的写法：往第五个文件里加 marker，门禁照旧 2973 项
  // 全绿——它压根没去找新增的解析方，那种「登记表」只是一份注释。
  const scanRoots = ['scripts', 'packages', 'apps'];
  const skipDirs = new Set(['node_modules', 'dist', '.git', 'bin', 'obj']);
  const sourceFiles = [];
  const walk = (relativeDir) => {
    let entries = [];
    try {
      entries = readdirSync(join(root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(childRelative);
      } else if (/\.(?:mjs|js|cjs|ts|tsx)$/.test(entry.name)) {
        sourceFiles.push(childRelative);
      }
    }
  };
  for (const scanRoot of scanRoots) walk(scanRoot);

  const selfPath = 'scripts/verify-handoff-projection-fixtures.mjs';
  const actual = sourceFiles
    .filter((relativePath) => relativePath !== selfPath)
    .filter((relativePath) => readFileSync(join(root, relativePath), 'utf8').includes(marker))
    .sort();
  const registeredPaths = Object.keys(PROPOSAL_PARSERS).sort();

  check('proposal-parsers/scan-found-files', sourceFiles.length > 100,
    `扫描必须真的遍历到源文件，实际只有 ${sourceFiles.length} 个——扫描根或后缀过滤写错了。`);
  check('proposal-parsers/registry-matches-repository',
    JSON.stringify(actual) === JSON.stringify(registeredPaths),
    `引用提案 marker 的文件集必须与登记表一致。`
      + `未登记：${actual.filter((p) => !registeredPaths.includes(p)).join(', ') || '无'}；`
      + `登记了但已不引用：${registeredPaths.filter((p) => !actual.includes(p)).join(', ') || '无'}。`
      + '新增解析方必须在此登记并写明用途——本轮实测：加投影标记时前三处在治理门禁里'
      + '当场报错，第四处（packages/core 的 TS smoke）只有 npm test 才炸。');
  for (const [relativePath, purpose] of Object.entries(PROPOSAL_PARSERS)) {
    check(`proposal-parsers/${relativePath}/purpose-documented`, purpose.length > 0,
      '每个解析方必须写明用途，否则下一个人不知道改动会波及什么。');
  }
}

{
  // §18.2.1 范围提案块。它是 scope.json + gates.json 的投影，
  // 而 verify-release-scope.mjs 直接解析这段 markdown——渲染形状本身承担门禁职责：
  // fence 少一层、字段顺序变了、JSON 不可解析，范围门禁就读不到权威数据。
  const body = blocks['scope-proposal']();
  const lines = body.split('\n');
  check('scope-proposal/json-fence', lines[0] === '```json' && lines.at(-1) === '```',
    `必须是单一 json fenced block，实际首行 ${JSON.stringify(lines[0])} 末行 ${JSON.stringify(lines.at(-1))}`);
  check('scope-proposal/single-fence', body.split('```').length === 3,
    '只能出现一对 fence——verify-release-scope.mjs 的 fence 正则要求块内唯一。');

  let parsed = null;
  try {
    parsed = JSON.parse(lines.slice(1, -1).join('\n'));
  } catch (error) {
    check('scope-proposal/parses', false, `块内 JSON 必须可解析：${error.message}`);
  }
  if (parsed !== null) {
    check('scope-proposal/parses', true, '');
    // 与权威 JSON 逐条目比对。这是本轮引入投影的直接理由：改成投影之前
    // 27 条 scopeItem 全部缺 targetRelease/deferredTrack/resumeRequires，
    // deferredToRelease 缺 15 处，而范围门禁只读这份复制所以判不出分叉。
    check('scope-proposal/schema-version-follows-authority',
      parsed.schemaVersion === sources.scopeData.schemaVersion,
      `schemaVersion 必须等于 scope.json 的 ${sources.scopeData.schemaVersion}，实际 ${JSON.stringify(parsed.schemaVersion)}`);
    check('scope-proposal/items-verbatim',
      JSON.stringify(parsed.scopeItems) === JSON.stringify(sources.scopeData.scopeItems),
      'scopeItems 必须与 scope.json 逐字节相同——投影不得裁剪字段。');
    check('scope-proposal/gate-coverage-count',
      parsed.gateCoverage.length === sources.gatesData.gates.length,
      `gateCoverage 条数必须等于 gates.json 的 ${sources.gatesData.gates.length}，实际 ${parsed.gateCoverage.length}`);
    check('scope-proposal/gate-coverage-derived',
      parsed.gateCoverage.every((entry, i) => {
        const gate = sources.gatesData.gates[i];
        return entry.gateId === gate.gateId
          && entry.currentState === gate.gateState
          && JSON.stringify(entry.scopeItemIds) === JSON.stringify(gate.scopeItemIds)
          && JSON.stringify(entry.blockerRefs) === JSON.stringify(gate.blockerRefs)
          && JSON.stringify(entry.openRulings) === JSON.stringify(gate.openRulings);
      }),
      'gateCoverage 必须是 gates.json 的逐字段投影（currentState ← gateState）。');
    // 不得夹带非投影字段：多一个手写字段就是重新开一处第二权威。
    const expectedKeys = [
      'schemaVersion', 'proposalId', 'release', 'game', 'gameBuildRange', 'ruling', 'proposalStatus',
      'unlistedPolicy', 'corpusPolicy', 'scopeDeferralPolicy', 'authoritySnapshotPolicy',
      'paramMetadataSourcePolicy', 'providerCredentialPolicy', 'runtimeToolPolicy',
      'renderingAcceptancePolicy', 'quantitativeAcceptancePolicy', 'gateCoverage', 'scopeItems'
    ];
    check('scope-proposal/key-set-locked',
      JSON.stringify(Object.keys(parsed)) === JSON.stringify(expectedKeys),
      `顶层字段集与顺序被锁定，实际 ${JSON.stringify(Object.keys(parsed))}`);
  }
}

for (const [name, build] of Object.entries(blocks)) {
  if (NON_TABLE_BLOCKS.has(name)) continue;
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

// 行尾无关性。
//
// 实测的 agent 阻塞：本仓库 core.autocrlf=true，checkout 把交接书整篇转成 CRLF，
// 而区块是用 '\n'.join 生成的，于是 drifted 恒为 true——--check 每次 checkout 后
// 必红，诊断说「运行重新生成」，但重新生成后 git diff 输出 0 行（autocrlf 在索引侧
// 又归一化回去）。agent 看到「门禁红 + diff 空」，照诊断做也不解决，只能空转。
//
// 判定必须行尾无关，同时真实分叉仍要抓到——只放宽前者不验证后者，等于把门禁关掉。
{
  const eolRoot = mkdtempSync(join(tmpdir(), 'sf-handoff-eol-'));
  try {
    mkdirSync(join(eolRoot, 'docs/governance'), { recursive: true });
    cpSync(join(root, 'docs/governance'), join(eolRoot, 'docs/governance'), { recursive: true });
    const baseline = readFileSync(join(root, HANDOFF), 'utf8').replaceAll('\r\n', '\n');

    const writeWithEol = (text) => writeFileSync(join(eolRoot, HANDOFF), text, 'utf8');

    writeWithEol(baseline);
    const asLf = projectHandoff(eolRoot);
    check('projection/eol-lf-not-drifted', !asLf.drifted,
      `全 LF 的交接书不应判为分叉，实际 drifted=${asLf.drifted}`);

    writeWithEol(baseline.replaceAll('\n', '\r\n'));
    const asCrlf = projectHandoff(eolRoot);
    check('projection/eol-crlf-not-drifted', !asCrlf.drifted,
      `全 CRLF 的交接书不应判为分叉（autocrlf=true 时 checkout 必然产生这种形态），实际 drifted=${asCrlf.drifted}`);

    // 写回必须沿用原文件主导行尾，否则投影命令会把整篇 3860 行的行尾改掉，
    // 制造一个伪 diff 把真实改动淹没。
    check('projection/eol-crlf-preserved-on-write',
      asCrlf.projected.includes('\r\n') && !/(?<!\r)\n/.test(asCrlf.projected),
      'CRLF 原文件的投影结果必须仍是纯 CRLF。');
    check('projection/eol-lf-preserved-on-write',
      !asLf.projected.includes('\r\n'),
      'LF 原文件的投影结果必须仍是纯 LF。');

    // 放宽行尾不能顺带放过真实分叉。篡改一处投影区内容，两种行尾下都必须报红。
    for (const [label, text] of [['lf', baseline], ['crlf', baseline.replaceAll('\n', '\r\n')]]) {
      const tamperedSliceId = asLf.projected.includes('W-BEHAVIOR-MAP-01') ? 'W-BEHAVIOR-MAP-01' : null;
      if (tamperedSliceId === null) {
        check(`projection/eol-${label}-tamper-anchor-found`, false,
          '找不到用于篡改的锚点切片 ID，本组负向断言会测不到东西却全绿。');
        continue;
      }
      writeWithEol(text.replace(tamperedSliceId, 'W-FIXTURE-TAMPERED-01'));
      const tampered = projectHandoff(eolRoot);
      check(`projection/eol-${label}-tamper-still-detected`, tampered.drifted,
        `${label} 行尾下篡改投影区内容仍必须判为分叉，实际 drifted=${tampered.drifted}`);
    }
  } finally {
    rmSync(eolRoot, { recursive: true, force: true });
  }
}

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

// npm 脚本名提取契约。verify-handoff-integrity.mjs 用一条正则从交接书里找
// npm run X 并要求 X 存在于 package.json，此前完全没有 fixture 覆盖。
//
// 锁定的是「宽松」这个选择本身，不是某种豁免。同一个歧义踩过两次：治理数据
// 里写「`npm run` script 存在性」，归一化剥掉反引号后成为 npm run script，
// 撞出 NPM_SCRIPT_MISSING。当时试过加负向先行断言 /npm run(?!`) …/ 排除，
// 实测对触发时的真实文本形式都不生效（触发时反引号已经不在 run 之后了），
// 已回退。
//
// 所以这里断言归一化后的歧义写法确实会被抓到——那是刻意的：措辞是可控的
// （写「npm run 脚本名」就没歧义），而放宽正则会让真实的脚本名笔误漏报，
// 那是本检查唯一的价值。
//
// 诚实边界：这几条断言锁的是当前五种输入下的行为，不能拦住任意放宽改动。
// 试过构造一条能拦住先行断言的输入，实测不成立——`npm run` 后紧跟反引号时
// run 与后词之间没有空格，正则本就不匹配，与先行断言无关。真要防住任意
// 放宽，得改成正向枚举脚本名而不是模式匹配，那是更大的改动。
{
  const integritySource = readFileSync(join(root, 'scripts/verify-handoff-integrity.mjs'), 'utf8');
  const declared = /const runPattern = (\/[^;]+\/g);/.exec(integritySource);
  check('npm-script-pattern/declared', declared !== null, '未能在 verify-handoff-integrity.mjs 中定位 runPattern 声明；契约断言失效。');
  if (declared !== null) {
    const pattern = new RegExp(declared[1].slice(1, -2), 'g');
    const extract = (text) => [...new Set([...text.matchAll(pattern)].map((m) => m[1]))];
    const patternCases = [
      ['quoted-full-command', '`npm run test:handoff-integrity` exit 0', ['test:handoff-integrity']],
      ['bare-in-code-block', 'npm run bridge:build\nnpm run bridge:verify:daemon', ['bridge:build', 'bridge:verify:daemon']],
      ['missing-script-still-extracted', '`npm run test:definitely-not-real`', ['test:definitely-not-real']],
      // 归一化后的歧义文本必须仍被提取：宽松是选择，不是缺陷。
      ['normalized-prose-is-caught', 'markdown 链接、npm run script 存在性', ['script']],
      // 反引号闭合在 run 之后时本就不匹配（run 与后词之间是反引号不是空格）。
      // 这条记录该形式的实际行为，避免下次又误以为先行断言在起作用。
      ['backtick-closes-after-run', 'markdown 链接、`npm run` script 存在性', []]
    ];
    for (const [name, text, expected] of patternCases) {
      const got = extract(text);
      check(
        `npm-script-pattern/${name}`,
        JSON.stringify(got) === JSON.stringify(expected),
        `提取结果应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`
      );
    }
  }
}

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
    '投影区之外不得残留与投影表同构的表头',
    'npm 脚本名提取正则保持宽松：归一化后的叙述文本也会被抓到（措辞可控，漏报不可控）',
    '分叉判定与行尾无关（autocrlf=true 的 checkout 会整篇转 CRLF），写回沿用原文件主导行尾；放宽行尾不放过真实分叉',
    '引用提案 marker 的文件集由仓库扫描双向比对，不是只遍历登记表自身'
  ],
  findings
}, null, 2));
process.exitCode = errors.length === 0 ? 0 : 1;
