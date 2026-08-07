#!/usr/bin/env node
/**
 * 统一验证入口的负向 fixture。
 *
 * 为什么必须有：verify.mjs 的全部价值在于「exit 0 不等于验证过」。如果跳过
 * 检测悄悄失效，入口会把 19 个结构化跳过的套件报成 passed，而退出码依旧是
 * 0——退化后的表现和正常表现完全一样，没有任何人会发现。因此每条判定规则
 * 都要有一条负向用例证明它真的会触发。
 *
 * 本脚本只做纯静态断言（不 spawn 真实套件），因此在任何机器上都能跑。
 *
 * 诚实边界：端到端行为（wrapper 注入生效 / 不生效两种情况下同一套件分别被判
 * passed 与 skipped）本脚本不覆盖，也不假装覆盖。此前这里写的是「由
 * npm run verify:self 覆盖」——该 script 在 package.json 中并不存在，属于
 * 「注释声称有覆盖、实际没有」，比不写更误导，故改为如实声明缺口。
 */
import { classifyOutcome, detectSkipSignals, OUTCOME } from './verify/runner.mjs';
import { EXCLUDED, SILENT_ON_SUCCESS, TIER_BY_SCRIPT, TIER_ORDER } from './verify/tiers.mjs';
import { parseScriptCommand } from './verify/classify.mjs';
import { loadWorkspaces } from './verify/scriptGraph.mjs';

const failures = [];
let checks = 0;

function expect(label, actual, expected) {
  checks += 1;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    failures.push(`${label}\n    期望 ${expectedText}\n    实际 ${actualText}`);
  }
}

/* ---- 1. 跳过信号识别：四种真实形态都必须被认出 ------------------------ */

// 形态 1：status:'skipped'（runNativeFlverSmoke 等 7 处）
expect(
  'status:skipped 必须判为整体跳过',
  detectSkipSignals('{"ok":true,"status":"skipped","message":"FLVER fixture not available."}'),
  { wholeSkipped: true, skippedLegs: [] }
);

// 形态 2：skipped:true（runScriptContainerEvidenceSmoke 等 5 处）
expect(
  'skipped:true 必须判为整体跳过',
  detectSkipSignals('{"ok":true,"message":"real container not provided","skipped":true}'),
  { wholeSkipped: true, skippedLegs: [] }
);

// 形态 3：顶层字段值为 'skipped'（runEmevdCorpusMatrixSmoke 的 leg）
expect(
  '顶层 leg 字段值 skipped 必须判为部分跳过',
  detectSkipSignals('{"ok":true,"realCorpusLeg":"skipped","realEmedfLeg":"skipped"}'),
  { wholeSkipped: false, skippedLegs: ['realCorpusLeg', 'realEmedfLeg'] }
);

// 形态 4：嵌套字段值为 'skipped'
expect(
  '嵌套 leg 字段值 skipped 必须判为部分跳过',
  detectSkipSignals('{"ok":true,"legs":{"native":"skipped","synthetic":"passed"}}'),
  { wholeSkipped: false, skippedLegs: ['legs.native'] }
);

/* ---- 2. 不得误判：正常输出里出现 skip 字样不能算跳过 ------------------ */

expect(
  '计数为 0 的 skipped 字段不得误判',
  detectSkipSignals('{"ok":true,"cases":36,"skippedInstances":[]}'),
  { wholeSkipped: false, skippedLegs: [] }
);

expect(
  '自由文本提到 skipping 不得误判（只认结构化字段）',
  detectSkipSignals('{"ok":true,"message":"0 instructions skipped, all covered"}'),
  { wholeSkipped: false, skippedLegs: [] }
);

expect(
  '非 JSON 行不得影响判定',
  detectSkipSignals('> tsc -b\nskipped some cache\n{"ok":true,"cases":10}'),
  { wholeSkipped: false, skippedLegs: [] }
);

/* ---- 2b. 缩进（pretty-print）形态：本轮实测的真实失效形态 -------------
 *
 * 上面 1/2 节的用例全部是单行 JSON，而仓库里真正在跑的门禁几乎都用
 * `JSON.stringify(x, null, 2)` 输出。实测：pretty-print 的整体跳过曾被判成
 * passed —— CI 里 private-native-gate / section28-sekiro-gate /
 * me3-sekiro-session 三条门禁每次都把「什么都没跑」报成「真实执行并通过」。
 * 单行用例全绿而真实形态失效，正是「退化后与正常表现完全一致」的标本，
 * 所以这一节按输出形态而不是按字段种类补齐。
 */

expect(
  'pretty-print 的 status:skipped 必须判为整体跳过',
  detectSkipSignals(JSON.stringify({ ok: null, status: 'skipped', reason: '缺语料' }, null, 2)),
  { wholeSkipped: true, skippedLegs: [] }
);

expect(
  'pretty-print 的 skipped:true 必须判为整体跳过',
  detectSkipSignals(JSON.stringify({ ok: true, skipped: true }, null, 2)),
  { wholeSkipped: true, skippedLegs: [] }
);

expect(
  'pretty-print 的嵌套 leg 必须判为部分跳过',
  detectSkipSignals(JSON.stringify({ ok: true, legs: { native: 'skipped' } }, null, 2)),
  { wholeSkipped: false, skippedLegs: ['legs.native'] }
);

// 括号深度扫描不得把字符串字面量里的花括号当结构，否则正常输出里一句
// 说明文案就能把 passed 误判成 skipped——反方向的同一类错误。
expect(
  '字符串字面量内的 skip JSON 不得误判',
  detectSkipSignals(JSON.stringify({
    ok: true,
    hint: '缺语料时输出形如 {"status":"skipped"}'
  }, null, 2)),
  { wholeSkipped: false, skippedLegs: [] }
);

expect(
  '字符串内的转义引号不得打乱扫描',
  detectSkipSignals(JSON.stringify({
    ok: true,
    note: 'he wrote \\"status\\": \\"skipped\\" in the doc'
  }, null, 2)),
  { wholeSkipped: false, skippedLegs: [] }
);

// 数组元素里的对象不是顶层结论：若把它当整体结论，某个子项 skipped 会把
// 精确的 partial 误升成整条套件 skipped。
expect(
  '数组元素内的 skipped 不得当作整体跳过',
  detectSkipSignals('[{"status":"skipped"}]\n{"ok":true,"cases":3}'),
  { wholeSkipped: false, skippedLegs: [] }
);

expect(
  '同一段输出里多个顶层对象都要被扫到',
  detectSkipSignals(
    `${JSON.stringify({ ok: true, phase: 1 }, null, 2)}\n${JSON.stringify({ status: 'skipped' }, null, 2)}`
  ),
  { wholeSkipped: true, skippedLegs: [] }
);

// 结构化结论写到 stderr 的套件（verify-private-native-gate 用 console.error）
// 若只扫 stdout，它们的跳过信号会整体丢失。
expect(
  'stderr 里的跳过信号必须被采到',
  detectSkipSignals('', JSON.stringify({ status: 'skipped' }, null, 2)),
  { wholeSkipped: true, skippedLegs: [] }
);

/* ---- 3. 四态判定：exit 0 绝不无条件等于 passed ------------------------ */

expect(
  '非 0 退出码必须失败，即使输出声称 ok',
  classifyOutcome(1, '{"ok":true,"cases":10}').outcome,
  OUTCOME.FAILED
);

expect(
  'exit 0 + 整体跳过 必须判 skipped，不得判 passed',
  classifyOutcome(0, '{"ok":true,"skipped":true}').outcome,
  OUTCOME.SKIPPED
);

expect(
  'exit 0 + leg 跳过 必须判 partial，不得判 passed',
  classifyOutcome(0, '{"ok":true,"realEmedfLeg":"skipped"}').outcome,
  OUTCOME.PARTIAL
);

expect(
  'exit 0 且无跳过信号才判 passed',
  classifyOutcome(0, '{"ok":true,"cases":36}').outcome,
  OUTCOME.PASSED
);

// 混合场景：同时出现整体跳过与 leg 跳过时，整体跳过优先（更保守）
expect(
  '整体跳过优先于部分跳过',
  classifyOutcome(0, '{"ok":true,"skipped":true}\n{"ok":true,"realLeg":"skipped"}').outcome,
  OUTCOME.SKIPPED
);

expect(
  'pretty-print 的整体跳过必须判 skipped，不得判 passed',
  classifyOutcome(0, JSON.stringify({ ok: null, status: 'skipped' }, null, 2)).outcome,
  OUTCOME.SKIPPED
);

// 空输出不得算通过：本仓库要求每条套件输出结构化结论，什么都不输出说明
// 没跑到结论，算 passed 等于让「没跑」冒充「跑过并通过」。
expect(
  '未登记套件的空 stdout + exit 0 不得判 passed',
  classifyOutcome(0, '').outcome,
  OUTCOME.SKIPPED
);

// 例外必须显式登记，且只对登记者生效——否则「允许空输出」会让所有套件的
// 静默退化一起变绿。
expect(
  'SILENT_ON_SUCCESS 登记的套件（tsc）空输出可判 passed',
  classifyOutcome(0, '', '', 'typecheck').outcome,
  OUTCOME.PASSED
);

expect(
  '未登记的套件名不得蹭到静默豁免',
  classifyOutcome(0, '', '', 'test:some-unregistered-suite').outcome,
  OUTCOME.SKIPPED
);

expect(
  '静默豁免不得掩盖跳过信号',
  classifyOutcome(0, JSON.stringify({ status: 'skipped' }, null, 2), '', 'typecheck').outcome,
  OUTCOME.SKIPPED
);

expect(
  '静默豁免不得掩盖非零退出码',
  classifyOutcome(1, '', '', 'typecheck').outcome,
  OUTCOME.FAILED
);

expect(
  '每条静默豁免都必须写明理由（否则会变成绕过验证的后门）',
  Object.entries(SILENT_ON_SUCCESS)
    .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length === 0)
    .map(([name]) => name),
  []
);

expect(
  '静默豁免不得登记不存在的 script',
  Object.keys(SILENT_ON_SUCCESS).filter((name) => !TIER_BY_SCRIPT[name]),
  []
);

expect(
  '仅 stderr 有跳过信号时也必须判 skipped',
  classifyOutcome(0, '', JSON.stringify({ status: 'skipped' }, null, 2)).outcome,
  OUTCOME.SKIPPED
);

/* ---- 4. npm script 命令解析 ------------------------------------------ */

expect(
  'workspace 转发必须被识别',
  parseScriptCommand('npm run test:native-fmg -w @soulforge/core', ''),
  { entries: [], forwards: [{ script: 'test:native-fmg', workspace: '@soulforge/core' }] }
);

expect(
  '&& 串联的多段必须全部收集',
  parseScriptCommand('tsc -b ../shared . && node dist/testing/runXSmoke.js', 'packages/core'),
  {
    entries: [{ file: 'dist/testing/runXSmoke.js', workspaceDir: 'packages/core' }],
    forwards: []
  }
);

expect(
  '同名 workspace 内转发（无 -w）必须识别为本 workspace',
  parseScriptCommand('npm run test:governance-data-fixtures', ''),
  { entries: [], forwards: [{ script: 'test:governance-data-fixtures', workspace: null }] }
);

/* ---- 5. 层级登记表自身的一致性 --------------------------------------- */

const workspaces = loadWorkspaces(process.cwd());
const allScripts = new Set(Object.keys(workspaces.rootScripts));

const unregistered = [...allScripts]
  .filter((name) => !TIER_BY_SCRIPT[name] && !EXCLUDED[name]);
expect('不得存在未登记的 npm script', unregistered, []);

const ghostRegistered = Object.keys(TIER_BY_SCRIPT).filter((name) => !allScripts.has(name));
expect('层级表不得登记不存在的 script', ghostRegistered, []);

const staleExclusions = Object.keys(EXCLUDED).filter((name) => !allScripts.has(name));
expect('排除表不得残留不存在的 script', staleExclusions, []);

const badTiers = Object.entries(TIER_BY_SCRIPT)
  .filter(([, tier]) => !TIER_ORDER.includes(tier))
  .map(([name, tier]) => `${name}=${tier}`);
expect('层级值必须在 TIER_ORDER 内', badTiers, []);

const emptyReasons = Object.entries(EXCLUDED)
  .filter(([, reason]) => typeof reason !== 'string' || reason.trim().length === 0)
  .map(([name]) => name);
expect('每条排除都必须写明理由（否则排除表会变成绕过验证的后门）', emptyReasons, []);

/* ---- 输出 ------------------------------------------------------------ */

const ok = failures.length === 0;
console.log(JSON.stringify({
  ok,
  message: ok
    ? '统一验证入口负向 fixture 全部通过'
    : `${failures.length} 条断言失败`,
  checks,
  registeredScripts: Object.keys(TIER_BY_SCRIPT).length,
  excludedScripts: Object.keys(EXCLUDED).length,
  ...(ok ? {} : { failures })
}, null, 2));
process.exit(ok ? 0 : 1);
