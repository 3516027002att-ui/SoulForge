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
 * 端到端行为（wrapper 注入生效 / 不生效两种情况下同一套件被判 passed 与
 * skipped）由 npm run verify:self 覆盖。
 */
import { classifyOutcome, detectSkipSignals, OUTCOME } from './verify/runner.mjs';
import { EXCLUDED, TIER_BY_SCRIPT, TIER_ORDER } from './verify/tiers.mjs';
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
