/**
 * 套件依赖自动判定（静态分析，唯一实现）。
 *
 * 为什么不手写一张 100+ 行的依赖表：手写表会立刻漂移——有人给某个 smoke
 * 加一行 process.env.SOULFORGE_NATIVE_FIXTURE_REGISTRY，表却不会跟着改，
 * 于是 verify.mjs 会把一个「缺环境就静默跳过」的套件当成静态套件报成通过。
 *
 * 因此依赖从代码本身推导：解析 npm script 链找到真实入口 .ts/.mjs 文件，
 * 再看该文件及其本仓库内的 import 闭包里读了哪些环境变量。表只保留无法
 * 从代码推导的事实（tier 归属、opt-in 开关语义）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 环境变量 → 需求类别。未列出的 SOULFORGE_* 不构成外部依赖。 */
const ENV_REQUIREMENT = Object.freeze({
  SOULFORGE_NATIVE_FIXTURE_REGISTRY: 'native-env',
  SOULFORGE_NATIVE_FIXTURE_ROOT: 'native-env',
  SOULFORGE_SEKIRO_GAME_ROOT: 'native-env',
  SOULFORGE_EMEDF_PATH: 'emedf',
  SOULFORGE_INSTALLER_LIFECYCLE_RUN: 'opt-in',
  SOULFORGE_FUNCTIONAL_SMOKE: 'opt-in',
  // script 容器 game-load 真实加载确认：opt-in 用户游戏内确认，未设置时该 leg 结构化跳过。
  SOULFORGE_SCRIPT_REAL_LOAD_CONFIRMED: 'opt-in',
  SOULFORGE_DOTNET: 'dotnet'
});

/** dotnet 依赖也可由这些模块引入（Bridge 进程）。 */
const DOTNET_MODULE_HINTS = Object.freeze([
  'scripts/run-dotnet.mjs',
  'bridge/runBridge',
  'bridgeDaemon'
]);

/**
 * 从 npm script 命令行解析出本仓库内的入口文件与转发目标。
 *
 * 支持的形态：
 * - `node scripts/x.mjs [args]`
 * - `npm run <name> -w <workspace>` / `--workspace <ws>`（转发）
 * - `tsc -b ... && node dist/testing/x.js`（workspace 内编译后执行）
 * - `a && b`（取全部段）
 *
 * @returns {{ entries: string[], forwards: Array<{script: string, workspace: string|null}> }}
 */
export function parseScriptCommand(command, workspaceDir) {
  const entries = [];
  const forwards = [];
  for (const segment of command.split('&&').map((part) => part.trim()).filter(Boolean)) {
    const tokens = segment.split(/\s+/);
    if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2]) {
      const wsIndex = tokens.findIndex((token) => token === '-w' || token === '--workspace');
      forwards.push({
        script: tokens[2],
        workspace: wsIndex >= 0 ? (tokens[wsIndex + 1] ?? null) : null
      });
      continue;
    }
    if (tokens[0] === 'node') {
      const file = tokens.slice(1).find((token) => !token.startsWith('-'));
      if (file) entries.push({ file, workspaceDir });
    }
  }
  return { entries, forwards };
}

/**
 * dist/testing/xSmoke.js → packages/<ws>/src/testing/xSmoke.ts
 * 编译产物不进版本库，静态分析必须回到源码。
 */
function toSourcePath(repoRoot, workspaceDir, file) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.startsWith('dist/')) {
    const relative = normalized.slice('dist/'.length).replace(/\.js$/, '.ts');
    return resolve(repoRoot, workspaceDir, 'src', relative);
  }
  return resolve(repoRoot, workspaceDir, normalized);
}

const IMPORT_PATTERN = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;

/** 解析相对 import 到实际文件（.ts / .mjs / .js / index）。 */
function resolveImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, 'index.ts')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * 收集入口文件 import 闭包内读到的环境变量与 dotnet 线索。
 * 闭包限定在本仓库源码内；node_modules 与包名 import 不跟进。
 */
export function analyzeEntry(entryFile, { maxFiles = 400 } = {}) {
  const seen = new Set();
  const envVars = new Set();
  let dotnetHint = false;
  const queue = [entryFile];

  while (queue.length > 0 && seen.size < maxFiles) {
    const file = queue.shift();
    if (!file || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const match of text.matchAll(/SOULFORGE_[A-Z0-9_]+/g)) envVars.add(match[0]);
    const normalizedFile = file.replaceAll('\\', '/');
    if (DOTNET_MODULE_HINTS.some((hint) => normalizedFile.includes(hint))) dotnetHint = true;
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      if (DOTNET_MODULE_HINTS.some((hint) => match[1].includes(hint))) dotnetHint = true;
      const resolved = resolveImport(file, match[1]);
      if (resolved) queue.push(resolved);
    }
  }

  const requirements = new Set();
  for (const envVar of envVars) {
    const requirement = ENV_REQUIREMENT[envVar];
    if (requirement) requirements.add(requirement);
  }
  if (dotnetHint) requirements.add('dotnet');

  return {
    analyzedFiles: seen.size,
    envVars: [...envVars].sort(),
    requirements: [...requirements].sort(),
    truncated: queue.length > 0
  };
}
