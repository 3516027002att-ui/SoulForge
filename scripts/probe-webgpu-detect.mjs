#!/usr/bin/env node
/**
 * 在真实 Electron/Chromium 上跑一次 WebGPU 探测（#32 验收第 3 条）。
 *
 * 为什么要这个脚本：`webgpuDetect` 的可用性判定差异只在真实 Chromium 里才会
 * 暴露（`adapter.info` 有没有、`requestAdapterInfo` 是否还存在），单测只能
 * mock 形状。这里用仓库自带的 Electron 43 起一个隐藏窗口，加载打包后的
 * 探测入口，把 `detectWebGpu()` 的结果和 `resolveRendererBackend()` 的决策
 * 一起打出来。
 *
 * 用法：
 *   node scripts/probe-webgpu-detect.mjs            # 打印 JSON
 *   node scripts/probe-webgpu-detect.mjs --assert   # 额外校验 #32 的三条断言
 *
 * 退出码：0 探测完成（--assert 时断言通过）；1 探测/断言失败或环境缺失。
 * 副作用：Electron userData 指到系统临时目录，不碰用户正在用的会话数据。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PROBE_DIR = join(REPO_ROOT, 'scripts', 'webgpu-probe');
const BUNDLE = join(PROBE_DIR, 'probe.bundle.js');

const esbuild = join(REPO_ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
const electron = join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!existsSync(esbuild)) fail(`缺少 esbuild：${esbuild}（先 npm install）`);
if (!existsSync(electron)) fail(`缺少 Electron 二进制：${electron}（先 npm install）`);

const build = spawnSync(process.execPath, [
  esbuild,
  join(PROBE_DIR, 'entry.ts'),
  '--bundle',
  '--format=iife',
  '--platform=browser',
  '--target=chrome150',
  `--outfile=${BUNDLE}`,
  '--loader:.png=dataurl',
  '--loader:.svg=dataurl',
  '--loader:.css=empty',
  '--log-level=warning'
], { encoding: 'utf8' });
if (build.status !== 0) fail(`打包探测入口失败：\n${build.stdout ?? ''}${build.stderr ?? ''}`);

mkdirSync(dirname(BUNDLE), { recursive: true });
const run = spawnSync(electron, [join(PROBE_DIR, 'main.cjs')], { encoding: 'utf8', timeout: 120000 });
if (run.status !== 0) fail(`Electron 探测失败（exit ${run.status}）：\n${run.stderr ?? ''}`);

const stdout = run.stdout ?? '';
const start = stdout.indexOf('{');
if (start < 0) fail(`探测没有输出 JSON：\n${stdout}\n${run.stderr ?? ''}`);
/** @type {any} */
let result;
try {
  result = JSON.parse(stdout.slice(start));
} catch (error) {
  fail(`探测输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}\n${stdout}`);
}

writeFileSync(join(PROBE_DIR, 'last-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!process.argv.includes('--assert')) process.exit(0);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// renderer 里没有 nodeIntegration，读不到 process.versions；UA 里带着
// Electron/43.0.0 与 Chrome/150，用它确认跑的是目标构建。
const userAgent = String(result?.userAgent ?? '');
const electronVersion = /Electron\/([0-9.]+)/.exec(userAgent)?.[1] ?? '';
const chromeVersion = /Chrome\/([0-9.]+)/.exec(userAgent)?.[1] ?? '';
check('运行在 Electron 43.x 构建上', electronVersion.startsWith('43.'),
  { electronVersion, chromeVersion });
check('renderer 里 navigator.gpu 存在', result?.hasNavigatorGpu === true, result?.hasNavigatorGpu);
check('adapter 走 adapter.info（没有 legacy requestAdapterInfo）',
  result?.adapterShape?.hasInfo === true && result?.adapterShape?.hasRequestAdapterInfo === false,
  result?.adapterShape);
check('WebGPU 判为可用', result?.capability?.available === true, result?.capability?.available);
check('可用时不再报 WEBGPU_ADAPTER_INFO_UNAVAILABLE',
  !(result?.capability?.diagnostics ?? []).some((item) => item?.code === 'WEBGPU_ADAPTER_INFO_UNAVAILABLE'),
  (result?.capability?.diagnostics ?? []).map((item) => item?.code));
check('默认后端仍是 webgl2', result?.backendDefault === 'webgl2', result?.backendDefault);
check('显式开启 webgpuEnabled 时决策为 webgpu',
  result?.backendWhenExplicitlyEnabled === 'webgpu', result?.backendWhenExplicitlyEnabled);

const failed = checks.filter((item) => !item.ok);
for (const item of checks) {
  process.stderr.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${JSON.stringify(item.detail)}\n`);
}
if (failed.length > 0) fail(`${failed.length}/${checks.length} 条 #32 断言失败`);
process.stdout.write(`WebGPU 探测断言通过（${checks.length}/${checks.length}），结果写入 scripts/webgpu-probe/last-result.json\n`);
