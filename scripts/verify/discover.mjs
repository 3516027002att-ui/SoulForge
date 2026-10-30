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
 * 用法：
 *   node scripts/verify/discover.mjs            # 打印对账表
 *   node scripts/verify/discover.mjs --json     # 机器可读
 *   node scripts/verify/discover.mjs --strict   # 有差异即非零退出（用于切换前的门禁）
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED, TIER_BY_SCRIPT, TIER_ORDER } from './tiers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts ?? {};

/** 命令里出现这些目标就算"跑验证"。 */
const SUITE_TARGETS = [
  /node\s+--test\b/,
  /\.test\.(js|mjs|cjs)\b/,
  /run[A-Za-z]+Smoke\.js\b/,
  /electron-vite\s+preview|playwright/i
];

/**
 * 约定（写进 ARCHITECTURE.md 的那一条）。
 *
 * 只看两条信息：script 名字前缀、以及命令指向的路径。之所以不用"script 名里有没有
 * governance 字样"这种单条规则：现有登记表把 `test:verify-entrypoint` 这类
 * scripts/verify 下的脚本归 governance，而把 `test:editor-layout-*` 归 unit——
 * 判据是"它验证的是治理工具还是产品行为"，路径比名字更接近这个判据。
 */
const CONVENTIONS = [
  { tier: 'governance', match: (name, command) => /^scripts[\\/]verify[\\/]|verify\/|handoff:|gov:/.test(command) || /^test:(governance|handoff|release-scope|verify|gov|ci)/.test(name) },
  { tier: 'release', match: (name, command) => /e2e|installed|installer|update:/.test(name) || /scripts[\\/].*e2e/.test(command) },
  { tier: 'native', match: (name, command) => /native|bridge:verify:real|dotnet/.test(name) || /bridge[\\/]SoulForge/.test(command) },
  { tier: 'synthetic', match: (name, command) => /synthetic|smoke/.test(name) || /run[A-Za-z]+Smoke\.js/.test(command) },
  { tier: 'unit', match: () => true }
];

export function classifyByConvention(name, command) {
  for (const rule of CONVENTIONS) {
    if (rule.match(name, command)) return rule.tier;
  }
  return 'unit';
}

function isSuite(name, command) {
  if (!/^test:|^verify:/.test(name)) {
    // 名字不像验证，但命令确实在跑测试文件，也算候选（#35 要抓的正是"没登记"）。
    return SUITE_TARGETS.some((pattern) => pattern.test(command));
  }
  return true;
}

const discovered = [];
for (const [name, command] of Object.entries(scripts)) {
  if (typeof command !== 'string') continue;
  if (EXCLUDED[name]) continue;
  if (!isSuite(name, command)) continue;
  discovered.push({ name, tier: classifyByConvention(name, command) });
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
  .filter((name) => name in scripts && isSuite(name, String(scripts[name])) && name.startsWith('test:'));

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
  summary: {
    inRegistryOnly: registeredMissingScript.length,
    discoveredOnly: unregistered.length,
    tierMismatch: tierMismatch.length,
    excludedButLooksLikeSuite: excludedButLooksLikeSuite.length
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
