/**
 * 层级约定（#35）。
 *
 * 从 `discover.mjs` 抽出来的原因：`verify.mjs` 的调度也要用同一套判据。判据复制两份
 * 就会漂移——那正是 #35 要消灭的"两张表各说各话"。这里只放纯函数，不读进程参数、
 * 不写文件，两边都能 import。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 命令里出现这些目标就算"跑验证"。 */
export const SUITE_TARGETS = [
  /node\s+--test\b/,
  /\.test\.(js|mjs|cjs)\b/,
  /run[A-Za-z]+Smoke\.js\b/,
  /electron-vite\s+preview|playwright/i
];

/**
 * 约定规则。只看两条信息：script 名字、以及展开转发后的命令文本。
 *
 * 为什么治理/发布/原生三层要"路径 + 名字"共同判定：现有登记表把 `scripts/verify/`
 * 下的工具归 governance，而把 `test:first-party-schema-*` 也归 governance——判据是
 * "验证对象是治理工具还是产品行为"，路径与名字各覆盖一半。
 */
export const CONVENTIONS = [
  {
    tier: 'governance',
    match: (name, command) => [
      /scripts[\\/]verify[\\/]/.test(command),
      /^test:(governance|handoff|release-scope|verify|gov|ci)/.test(name),
      /first-party-schema/.test(name)
    ].some(Boolean)
  },
  {
    tier: 'release',
    match: (name, command) => [
      /^test:(release|e2e|installed|update:(integration|installed|all))/.test(name),
      /verify-(release|reproducible|portable-packaging)/.test(command)
    ].some(Boolean)
  },
  {
    tier: 'native',
    match: (name, command) => [
      /native|real-corpus|corpus|roundtrip|luap|hks/.test(name),
      /verify-first-party-(lua|luap|hks)/.test(command)
    ].some(Boolean)
  },
  {
    tier: 'synthetic',
    // 只有名字里明确写 synthetic 的才归这层：凭"命令里跑的是 run*Smoke.js"判定会把
    // 66 个登记为 unit 的 hermetic smoke 误抬成 synthetic（实测）。
    match: (name) => /synthetic/.test(name)
  },
  { tier: 'unit', match: () => true }
];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 例外表：约定表达不了的工程判断（由 discover --write-exceptions 生成并合并）。 */
export function loadTierExceptions() {
  try {
    const parsed = JSON.parse(
      readFileSync(resolve(repoRoot, 'scripts', 'verify', 'tier-exceptions.json'), 'utf8')
    );
    return parsed.exceptions ?? {};
  } catch {
    return {};
  }
}

export function classifyByConvention(name, command) {
  for (const rule of CONVENTIONS) {
    if (rule.match(name, command)) return rule.tier;
  }
  return 'unit';
}

/**
 * 非测试验证入口的显式声明（#35）。
 *
 * `bridge:verify:*`、`release:manifest`、`probe:*` 这些入口不以 test:/verify: 开头，
 * 命令也不跑测试文件，isSuiteScript 判不到；它们是否依赖真实原生运行时也无法从名字
 * 推导（实测 `esd` 是原生、`esd-writer` 是模拟，而后缀相同的 `bnd4-writer` 又是原生）。
 * 所以把判断写成数据。tier 目前与 tiers.mjs 对齐生成，尚未独立验证。
 */
export function loadSuiteTraits() {
  try {
    const parsed = JSON.parse(readFileSync(resolve(repoRoot, 'scripts', 'verify', 'suite-traits.json'), 'utf8'));
    return parsed.entries ?? {};
  } catch {
    return {};
  }
}

export function isSuiteScript(name, command) {
  if (!/^test:|^verify:/.test(name)) {
    return SUITE_TARGETS.some((pattern) => pattern.test(command));
  }
  return true;
}

/** 子包 scripts：根 script 大量只是 `npm run X -w @pkg` 的转发。 */
export function loadWorkspaceScripts(root, directories = ['packages/core', 'packages/shared', 'apps/desktop']) {
  const table = new Map();
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
      table.set(manifest.name, manifest.scripts ?? {});
    } catch {
      // 没有该子包就跳过：约定解析尽力而为。
    }
  }
  return table;
}

/** 把 `npm run X -w @pkg` 展开成子包里 X 的真实命令（最多 3 层）。 */
export function resolveCommand(command, workspaceScripts, depth = 0) {
  if (depth >= 3) return command;
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== 'npm' || tokens[1] !== 'run') return command;
  const inner = tokens[2];
  if (!inner) return command;
  const flagIndex = tokens.findIndex(
    (token, index) => index > 2 && (token === '-w' || token === '--workspace')
  );
  const flagValue = flagIndex >= 0
    ? tokens[flagIndex + 1]
    : tokens.find((token) => token.startsWith('--workspace='))?.slice('--workspace='.length);
  const table = flagValue ? workspaceScripts.get(flagValue) : undefined;
  const next = table?.[inner];
  return typeof next === 'string' ? resolveCommand(next, workspaceScripts, depth + 1) : command;
}
