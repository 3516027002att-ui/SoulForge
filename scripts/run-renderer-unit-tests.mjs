#!/usr/bin/env node
/**
 * renderer 侧纯逻辑单元测试的执行入口。
 *
 * 为什么需要这个 wrapper：apps/desktop 的 tsconfig 是 noEmit（产物由 electron-vite
 * 生成），所以 `node --test` 拿不到可执行的 .js；而 Node 24 也不会把 `.js` 说明符
 * 解析回 `.ts`。这里沿用仓库既有做法（run-three-scene-functional-smoke.mjs 同一
 * 范式）：用 esbuild 把测试文件打成单个 ESM，再交给 node:test 跑。
 *
 * 只收 renderer 下的纯逻辑测试（无 DOM、无 IPC）。需要真实 Electron 或渲染的用例
 * 属于 test:renderer-e2e，不在这里——两者的失败含义不同，混在一个入口里会让
 * 「缺 Electron」和「逻辑回归」变成同一种红。
 */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = join(root, 'apps', 'desktop', 'src', 'renderer', 'src');

/** 递归收集 *.test.ts。约定式发现：新增测试文件不需要改本入口。 */
function collectTests(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTests(full));
      continue;
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) found.push(full);
  }
  return found;
}

if (!existsSync(rendererRoot)) {
  console.error(JSON.stringify({
    ok: false,
    suite: 'renderer-unit',
    code: 'RENDERER_SOURCE_MISSING',
    message: `renderer 源码目录不存在：${rendererRoot}`
  }, null, 2));
  process.exit(1);
}

const tests = collectTests(rendererRoot);
// 空集合必须失败关闭：这个入口的存在就是为了保证 renderer 有单元测试。
// 若允许「零文件 = 通过」，删掉最后一个测试文件反而会让门禁变绿。
if (tests.length === 0) {
  console.error(JSON.stringify({
    ok: false,
    suite: 'renderer-unit',
    code: 'RENDERER_UNIT_TESTS_EMPTY',
    message: 'renderer 下没有任何 *.test.ts；空集合视为失败，'
      + '避免「删掉测试」表现为「门禁通过」。',
    scannedRoot: relative(root, rendererRoot)
  }, null, 2));
  process.exit(1);
}

const outDir = join(root, 'node_modules', '.cache', 'soulforge-renderer-unit');
mkdirSync(outDir, { recursive: true });

const outfiles = [];
for (const test of tests) {
  const outfile = join(outDir, `${relative(rendererRoot, test).replace(/[\\/]/g, '__')}.mjs`);
  buildSync({
    entryPoints: [test],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    // node:test / node:assert 必须留给运行时；@soulforge/* 走真实实现（bundle 进来）。
    external: ['node:*']
  });
  outfiles.push(outfile);
}

const result = spawnSync(process.execPath, ['--test', ...outfiles], {
  cwd: root,
  stdio: 'inherit',
  encoding: 'utf8'
});

if (result.status !== 0) {
  console.error(JSON.stringify({
    ok: false,
    suite: 'renderer-unit',
    code: 'RENDERER_UNIT_TESTS_FAILED',
    testFiles: tests.map((test) => relative(root, test)),
    exitCode: result.status
  }, null, 2));
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify({
  ok: true,
  suite: 'renderer-unit',
  message: 'renderer 纯逻辑单元测试全部通过',
  testFiles: tests.map((test) => relative(root, test)),
  nonClaim: '本入口只覆盖无 DOM/IPC 依赖的纯逻辑；真实渲染与 Electron 行为由 '
    + 'test:renderer-e2e 负责，两者不可互相替代。'
}, null, 2));
