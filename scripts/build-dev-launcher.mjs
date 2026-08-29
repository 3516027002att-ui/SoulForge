#!/usr/bin/env node
/**
 * 编译仓库根目录静默启动器 SoulForge.exe（scripts/launch-soulforge.cs）。
 *
 * SoulForge.exe = 双击直接打开编辑器（无 Doctor 诊断页）。
 * SoulForge.Doctor.exe / SoulForge.Launcher.exe = 环境体检，由 launcher:build 生成。
 * 这两个名字不能混：曾经把 Doctor 单文件发布成 SoulForge.exe，双击就会跳诊断控制台。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
const csc = resolve(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const src = resolve(root, 'scripts', 'launch-soulforge.cs');
const out = resolve(root, 'SoulForge.exe');

if (!existsSync(csc)) {
  console.error(`csc.exe 不存在：${csc}`);
  process.exit(1);
}
if (!existsSync(src)) {
  console.error(`缺少启动器源码：${src}`);
  process.exit(1);
}

const result = spawnSync(
  csc,
  ['/nologo', '/target:winexe', '/optimize+', `/out:${out}`, src],
  { cwd: root, stdio: 'inherit', windowsHide: true }
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status === null ? 1 : result.status);
