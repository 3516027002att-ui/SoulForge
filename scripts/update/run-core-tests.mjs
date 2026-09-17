#!/usr/bin/env node
/**
 * 编译并执行桌面更新核心单测。
 *
 * apps/desktop 的生产 tsconfig 是 noEmit，Node 的 strip-types 也不会把 .js
 * 说明符回映射到 .ts；这里用 esbuild 只把测试及其纯更新核心依赖打成临时
 * ESM，再交给 node:test。主进程 Electron 适配器不在此处伪造，Windows 安装
 * 仍由 installed suite 标记为未执行。
 */
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const outputDirectory = join(root, 'node_modules', '.cache', 'soulforge-update-unit');
const outputFile = join(outputDirectory, 'update.test.mjs');
mkdirSync(outputDirectory, { recursive: true });
buildSync({
  entryPoints: [join(root, 'apps/desktop/src/main/update/update.test.ts')],
  outfile: outputFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'inline'
});
const result = spawnSync(process.execPath, ['--test', outputFile], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
