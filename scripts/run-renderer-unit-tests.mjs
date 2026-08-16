#!/usr/bin/env node
/**
 * renderer 侧纯逻辑单元测试的执行入口。
 *
 * 为什么需要这个 wrapper：apps/desktop 的 tsconfig 是 noEmit（产物由 electron-vite
 * 生成），所以 `node --test` 拿不到可执行的 .js；而 Node 24 也不会把 `.js` 说明符
 * 解析回 `.ts`。这里沿用仓库既有做法（run-three-scene-functional-smoke.mjs 同一
 * 范式）：用 esbuild 把测试文件打成单个 ESM，再交给 node:test 跑。
 *
 * 只收**纯逻辑**测试（无 DOM、无 IPC、不 import electron）。需要真实 Electron 或
 * 渲染的用例属于 test:renderer-e2e / test:database-utility，不在这里——两者的失败
 * 含义不同，混在一个入口里会让「缺 Electron」和「逻辑回归」变成同一种红。
 *
 * 扫描根有两个：renderer/src 与 main。main 侧只允许放不 import electron 的纯逻辑
 * 模块（如 emevdOpenSlots：窗口 id 只是个数字）。加这个根是因为主进程里同样有
 * 靠读代码无法证伪的并发时序不变式，而它们此前没有任何单元测试入口可落——
 * 最近的替代品 test:database-utility 要起真 Electron，对纯逻辑过重。
 */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rendererRoot = join(root, 'apps', 'desktop', 'src', 'renderer', 'src');
const mainRoot = join(root, 'apps', 'desktop', 'src', 'main');
/**
 * 扫描根。每个根单独要求非空：只对合集判空的话，某个根下的测试被整体删掉
 * （或目录改名导致扫不到）仍然会绿，正是「删掉测试表现为门禁通过」那类假绿。
 */
const scanRoots = [
  { label: 'renderer', dir: rendererRoot },
  { label: 'main', dir: mainRoot }
];

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

const tests = [];
for (const { label, dir } of scanRoots) {
  if (!existsSync(dir)) {
    console.error(JSON.stringify({
      ok: false,
      suite: 'renderer-unit',
      code: 'UNIT_SOURCE_MISSING',
      message: `${label} 源码目录不存在：${dir}`
    }, null, 2));
    process.exit(1);
  }
  const found = collectTests(dir);
  // 空集合必须失败关闭：这个入口的存在就是为了保证这些目录下有单元测试。
  // 若允许「零文件 = 通过」，删掉最后一个测试文件反而会让门禁变绿。
  if (found.length === 0) {
    console.error(JSON.stringify({
      ok: false,
      suite: 'renderer-unit',
      code: 'UNIT_TESTS_EMPTY',
      message: `${label} 下没有任何 *.test.ts；空集合视为失败，`
        + '避免「删掉测试」表现为「门禁通过」。',
      scannedRoot: relative(root, dir)
    }, null, 2));
    process.exit(1);
  }
  tests.push(...found);
}

const outDir = join(root, 'node_modules', '.cache', 'soulforge-renderer-unit');
mkdirSync(outDir, { recursive: true });

const outfiles = [];
for (const test of tests) {
  // 相对**仓库根**而不是相对某个扫描根：后者对另一个根下的文件会算出 ../.. 前缀，
  // 展平后可能与别的路径撞名，撞了就是一个测试文件静默覆盖另一个。
  const outfile = join(outDir, `${relative(root, test).replace(/[\\/]/g, '__')}.mjs`);
  buildSync({
    entryPoints: [test],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    // node:test / node:assert 必须留给运行时；@soulforge/* 走真实实现（bundle 进来）。
    //
    // react / react-dom 也必须 external：它们是 CJS，bundle 进 ESM 产物后
    // esbuild 会把内部的 require('util') 变成运行期抛错的 shim
    // （"Dynamic require of util is not supported"）。留给 Node 自己解析即可 ——
    // 渲染期断言（*.test.tsx 用 react-dom/server 真渲染面板）依赖这一条，
    // 否则整个文件在导入阶段就崩，表现为「测试文件级失败」而非断言失败。
    external: ['node:*', 'react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    jsx: 'automatic',
    // 打包后 import.meta.url 指向 node_modules/.cache，任何靠它推算仓库相对路径的
    // 测试都会 ENOENT。注入编译期常量而不是让测试自己猜：靠 process.cwd() 会随
    // 调用目录漂移，而漂移的表现是「测试在 CI 上找不到文件」这类只在别处复现的红。
    define: {
      __SOULFORGE_REPO_ROOT__: JSON.stringify(root),
      __SOULFORGE_RENDERER_ROOT__: JSON.stringify(rendererRoot)
    }
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
