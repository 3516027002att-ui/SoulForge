#!/usr/bin/env node
/**
 * 测试按约定自动发现 vs `scripts/verify/tiers.mjs` 手工登记表（#35）。
 *
 * #35 的目标是"删掉登记表 + 297 个 test:* 脚本，改成按约定发现"。在动那张表之前
 * 必须先回答一个可量化的前置问题：**只靠约定能不能还原出现有登记表？** 差异在哪？
 *
 * 本工具只做对拍，不改任何东西：
 *   - 候选套件：根 package.json 里能"跑验证"的 script（名字 test:* 或以 node --test /
 *     *.test.js / run*Smoke.js 为目标）；
 *   - 约定归属：按 script 命令指向的路径与名字前缀推层级（见 CONVENTIONS）；
 *   - 与 TIER_BY_SCRIPT 对账：未登记 / 登记了但不存在 / 层级不一致 / 被排除但像套件。
 *
 * 实测（368 个 script，登记表 337 条）：
 *   - 初版约定（名字前缀 + 命令路径）：层级不一致 101；
 *   - 解析 `npm run X -w @pkg` 转发层 + 把 smoke 一律当 synthetic：138
 *     （把 66 个登记为 unit 的 hermetic smoke 误抬成 synthetic）；
 *   - 当前约定（治理/发布/原生按路径与名字判定，synthetic 只认名字里写明的）：84。
 *   - 这 40 条差异是"登记为 synthetic、但名字与路径都不带 synthetic/smoke 特征"的套件
 *     （asset-import、asset-writeback、emevd-session-cache…）——要把它们判对，只能
 *     逐条写明"这条要真实语料/较慢"，那就是把登记表换个写法。

 * 用法：
 *   node scripts/verify/discover.mjs            # 打印对账表
 *   node scripts/verify/discover.mjs --json     # 机器可读
 *   node scripts/verify/discover.mjs --strict   # 有差异即非零退出（用于切换前的门禁）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED, TIER_BY_SCRIPT, TIER_ORDER } from './tiers.mjs';
import {
  classifyByConvention,
  isSuiteScript,
  loadTierExceptions,
  loadWorkspaceScripts,
  resolveCommand
} from './tier-convention.mjs';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};

/** 例外表：约定表达不了的工程判断（由 --write-exceptions 生成并合并）。 */
const exceptions = loadTierExceptions();

const workspaceScripts = loadWorkspaceScripts(root);

const discovered = [];
for (const [name, command] of Object.entries(scripts)) {
  if (typeof command !== 'string') continue;
  if (EXCLUDED[name]) continue;
  if (!isSuiteScript(name, command)) continue;
  const conventionTier = classifyByConvention(name, resolveCommand(command, workspaceScripts));
  const exception = exceptions[name];
  discovered.push({
    name,
    tier: exception?.tier ?? conventionTier,
    ...(exception ? { exceptionReason: exception.reason, conventionTier } : {})
  });
}

const discoveredNames = new Set(discovered.map((entry) => entry.name));
const registered = Object.entries(TIER_BY_SCRIPT).map(([name, tier]) => ({ name, tier }));
const registeredNames = new Set(registered.map((entry) => entry.name));

const registeredMissingScript = registered.filter((entry) => !(entry.name in scripts)).map((entry) => entry.name);
const unregistered = discovered.filter((entry) => !registeredNames.has(entry.name));
const tierMismatch = discovered
  .filter((entry) => registeredNames.has(entry.name))
  .map((entry) => ({ name: entry.name, conventionTier: entry.tier, registeredTier: TIER_BY_SCRIPT[entry.name] }))
  .filter((entry) => entry.conventionTier !== entry.registeredTier);
const excludedButLooksLikeSuite = Object.keys(EXCLUDED)
  .filter((name) => name in scripts && isSuiteScript(name, String(scripts[name])) && name.startsWith('test:'));

const exceptionNames = new Set(Object.keys(exceptions));
const staleExceptions = [...exceptionNames].filter(
  (name) => !(name in scripts) || tierMismatch.every((entry) => entry.name !== name)
);

/** 把当前差异写成例外清单（只在 --write-exceptions 时执行）。 */
if (process.argv.includes('--write-exceptions')) {
  const REASONS = {
    synthetic: '需要较慢/真实语料的合成路径验证，名字与路径不带 synthetic 特征，约定无法推导',
    native: '依赖原生 Bridge 或真实语料往返，约定只能从名字猜',
    governance: '验证对象是治理工具/治理数据，路径不在 scripts/verify/ 下',
    release: '发布打包/安装链路验证，约定规则未覆盖该命名',
    unit: '产物是单元级检查，但名字或路径让约定判成了更重的层'
  };
  const next = {
    $comment: 'scripts/verify/discover.mjs 的层级例外表（#35 实测产物）。约定能判对的不要写进来；新增条目必须带 reason。',
    // 合并而不是覆盖：已生效的例外不会出现在本次 tierMismatch 里，覆盖会把它们丢掉，
    // 下一次跑立刻回到 84 条差异。
    exceptions: Object.fromEntries([
      ...Object.entries(exceptions),
      ...tierMismatch.map((entry) => [
        entry.name,
        {
          tier: entry.registeredTier,
          reason: REASONS[entry.registeredTier] ?? REASONS.unit
        }
      ])
    ])
  };
  writeFileSync(EXCEPTIONS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`wrote ${Object.keys(next.exceptions).length} exceptions -> scripts/verify/tier-exceptions.json\n`);
  process.exit(0);
}

const report = {
  ok: unregistered.length === 0 && registeredMissingScript.length === 0 && tierMismatch.length === 0,
  scriptCount: Object.keys(scripts).length,
  discoveredSuites: discovered.length,
  registeredSuites: registered.length,
  tiers: TIER_ORDER,
  inRegistryOnly: registeredMissingScript,
  discoveredOnly: unregistered.map((entry) => ({ name: entry.name, conventionTier: entry.tier })),
  tierMismatch,
  excludedButLooksLikeSuite,
  exceptionsApplied: Object.keys(exceptions).length,
  staleExceptions,
  summary: {
    inRegistryOnly: registeredMissingScript.length,
    discoveredOnly: unregistered.length,
    tierMismatch: tierMismatch.length,
    excludedButLooksLikeSuite: excludedButLooksLikeSuite.length,
    exceptionsApplied: Object.keys(exceptions).length,
    staleExceptions: staleExceptions.length
  },
  note: '约定只根据 script 名字前缀与命令路径推断层级；差异项就是"约定暂时替代不了人工判断"的部分。'
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(process.argv.includes('--strict') && !report.ok ? 1 : 0);
}

process.stdout.write([
  `scripts=${report.scriptCount} discovered=${report.discoveredSuites} registered=${report.registeredSuites}`,
  `登记了但脚本不存在: ${report.summary.inRegistryOnly}`,
  `发现但未登记: ${report.summary.discoveredOnly}`,
  `层级不一致: ${report.summary.tierMismatch}`,
  `被排除但像套件: ${report.summary.excludedButLooksLikeSuite}`,
  ''
].join('\n'));

if (unregistered.length > 0) {
  process.stdout.write(`发现但未登记（前 20）：\n${unregistered.slice(0, 20).map((entry) => `  ${entry.name} -> ${entry.tier}`).join('\n')}\n`);
}
if (tierMismatch.length > 0) {
  process.stdout.write(`层级不一致（前 20）：\n${tierMismatch.slice(0, 20).map((entry) => `  ${entry.name}: 约定=${entry.conventionTier} 登记=${entry.registeredTier}`).join('\n')}\n`);
}
if (registeredMissingScript.length > 0) {
  process.stdout.write(`登记了但 package.json 里没有（前 20）：\n${registeredMissingScript.slice(0, 20).map((name) => `  ${name}`).join('\n')}\n`);
}

process.exit(process.argv.includes('--strict') && !report.ok ? 1 : 0);
