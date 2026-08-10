#!/usr/bin/env node
/**
 * 「记住上次打开的目录」的边界验证。
 *
 * ── 守的问题 ──
 *
 * 用户要求像其他只狼工具那样记住上次打开的文件夹。这个功能的价值几乎全在边界：
 * 目录被删、外置盘拔掉、盘符变化、偏好文件损坏时，必须**静默回落**到系统默认，
 * 而不是让目录选择框打开一个无效位置或干脆打不开。这些分支编译期看不出来，
 * 也不会被 typecheck 覆盖。
 *
 * ── 为什么单独一个入口 ──
 *
 * apps/desktop/src/main 下此前没有任何测试文件，也没有主进程单测入口。
 * 新建一整套主进程测试基建超出本功能的范围；这里沿用仓库既有做法
 * （run-renderer-unit-tests / run-three-scene-functional-smoke 同一范式）：
 * 用 esbuild 把待测 TS 打成 ESM 再跑断言。
 *
 * 判据全部针对**真实文件系统**（系统临时目录），不用 mock —— 这条链的行为
 * 就是「路径还在不在」，mock 掉 fs 等于把要验的东西验掉了。
 */
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'recent-paths';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'apps', 'desktop', 'src', 'main', 'recentPaths.ts');

function report(payload, exitCode) {
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(payload, null, 2));
  process.exit(exitCode);
}

if (!existsSync(source)) {
  report({
    ok: false, gate: LABEL, status: 'failed', code: 'SOURCE_MISSING',
    message: `缺少待测源码：${source}。提取失败必须失败关闭，否则判据零样本恒真。`
  }, 1);
}

const work = mkdtempSync(join(tmpdir(), 'sf-recent-paths-'));
const findings = [];
let checked = 0;

try {
  const bundle = join(work, 'recentPaths.mjs');
  buildSync({
    entryPoints: [source],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  });
  const { readRecentPath, writeRecentPath } = await import(
    `file:///${bundle.replace(/\\/g, '/')}`
  );

  const settings = join(work, 'recent-paths.json');
  const overlayDir = join(work, 'mods');
  const baseDir = join(work, 'game');
  mkdirSync(overlayDir, { recursive: true });
  mkdirSync(baseDir, { recursive: true });

  const check = (condition, message) => {
    checked += 1;
    if (!condition) findings.push(message);
  };

  // ① 无记录
  check(readRecentPath(settings, 'overlay') === undefined, '无记录时应返回 undefined');

  // ② 写入后读回
  writeRecentPath(settings, 'overlay', overlayDir);
  check(readRecentPath(settings, 'overlay') === overlayDir, '写入后读回应一致');

  // ③ 两类目录互不干扰。合并成一个「上次目录」会让选原版目录时跳到某个 mod
  //    文件夹，反而更远 —— 这是刻意分开的原因。
  writeRecentPath(settings, 'base', baseDir);
  check(readRecentPath(settings, 'overlay') === overlayDir, '写 base 不得覆盖 overlay');
  check(readRecentPath(settings, 'base') === baseDir, 'base 读回应一致');

  // ④ 目录已不存在 → 视为无记录
  rmSync(overlayDir, { recursive: true, force: true });
  check(
    readRecentPath(settings, 'overlay') === undefined,
    '目录已不存在时必须视为无记录，否则对话框会打开一个无效位置'
  );

  // ⑤ 偏好文件损坏 → 静默视为无记录
  writeFileSync(settings, '{ this is not json', 'utf8');
  let threw = false;
  let corruptValue;
  try {
    corruptValue = readRecentPath(settings, 'base');
  } catch {
    threw = true;
  }
  check(!threw, '偏好文件损坏时不得抛异常（否则对话框打不开）');
  check(corruptValue === undefined, '偏好文件损坏时应视为无记录');

  /*
   * ⑥ 相对路径被拒：defaultPath 用相对路径会依赖进程 cwd，指向不可预期的位置。
   *
   * 关键是这个相对路径必须**在 cwd 下真实存在**，否则 existsSync 会先把它拦掉，
   * 于是「绝对路径检查」这条判据永远不会被真正考验 —— 两个保护重叠时，
   * 去掉其中一个不会让门禁报红。第一版就是这样，负向用例 N2 未报红才暴露出来。
   * 用仓库里必然存在的相对路径（scripts）来隔离出绝对路径这一条。
   */
  writeFileSync(settings, JSON.stringify({ overlay: 'scripts' }), 'utf8');
  check(
    readRecentPath(settings, 'overlay') === undefined,
    '相对路径必须被拒绝（即使该相对路径在 cwd 下确实存在）'
  );

  // ⑦ 写入相对路径不得落盘
  const before = readFileSync(settings, 'utf8');
  writeRecentPath(settings, 'base', 'not/absolute');
  check(readFileSync(settings, 'utf8') === before, '写入相对路径不应改动偏好文件');

  // ⑧ 不可写路径不抛：记不住上次位置只是少个便利，不该中断打开工作区的主流程
  let writeThrew = false;
  try {
    writeRecentPath(join(work, 'no-such-dir', 'x.json'), 'overlay', baseDir);
  } catch {
    writeThrew = true;
  }
  check(!writeThrew, '不可写路径不得抛异常');
} catch (error) {
  findings.push(`执行失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// 空集合失败关闭：若某次重构让断言一条都没跑，上面的 findings 会是空的而看着像通过。
if (checked < 10) {
  findings.push(`断言执行数过少（${checked}），判据可能已失效`);
}

if (findings.length > 0) {
  report({ ok: false, gate: LABEL, status: 'failed', code: 'RECENT_PATHS_VIOLATION', checked, findings }, 1);
}

report({
  ok: true,
  gate: LABEL,
  status: 'passed',
  checked,
  message: '记住上次目录的读写与失效回落行为符合预期。',
  nonClaim: '本判据只覆盖 recentPaths 的纯读写与回落逻辑（真实文件系统，无 mock）。'
    + '它不验证 Electron 对话框是否真的从 defaultPath 起步（那需要真实 GUI 交互），'
    + '也不验证启动自动挂载的时序 —— 后者由 workspace.lastSelection 的凭据签发'
    + '路径与 desktop-ipc-contract 覆盖。'
}, 0);
