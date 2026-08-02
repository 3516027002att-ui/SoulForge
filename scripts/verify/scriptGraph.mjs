/**
 * npm script 图。把根 package.json 的 script 名解析到真实入口源文件，
 * 跨 workspace 转发链一并跟进。
 *
 * 为什么需要：根 package.json 里 82 条 test:* 有 60+ 条只是
 * `npm run X -w @soulforge/core` 转发，真正的依赖藏在被转发的入口里。
 * 不跟进转发链，依赖判定必然错。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyzeEntry, parseScriptCommand } from './classify.mjs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * 建立 workspace 名 → 目录 的映射。目录来自 package.json 的 workspaces
 * 通配，名字来自各 workspace 自己的 name 字段。
 */
export function loadWorkspaces(repoRoot) {
  const rootPkg = readJson(resolve(repoRoot, 'package.json'));
  const patterns = rootPkg.workspaces ?? [];
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const parentPath = resolve(repoRoot, parent);
    if (!existsSync(parentPath)) continue;
    // 只接受含 package.json 的子目录，避免把 dist/ 之类当 workspace。
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(resolve(parentPath, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }

  const byName = new Map();
  const byDir = new Map();
  for (const dir of dirs) {
    const pkgPath = resolve(repoRoot, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    byName.set(pkg.name, { dir, scripts: pkg.scripts ?? {} });
    byDir.set(dir, { name: pkg.name, scripts: pkg.scripts ?? {} });
  }
  return { rootScripts: rootPkg.scripts ?? {}, byName, byDir };
}

/**
 * 解析一条根 script 的完整入口集合。
 *
 * @returns {{ entryFiles: string[], unresolved: string[], cycles: string[] }}
 */
export function resolveScriptEntries(repoRoot, workspaces, scriptName) {
  const entryFiles = new Set();
  const unresolved = [];
  const cycles = [];
  const visited = new Set();

  const walk = (name, workspaceDir, scriptTable) => {
    const key = `${workspaceDir}::${name}`;
    if (visited.has(key)) {
      cycles.push(key);
      return;
    }
    visited.add(key);

    const command = scriptTable[name];
    if (typeof command !== 'string') {
      unresolved.push(`${workspaceDir || '.'}:${name}（script 不存在）`);
      return;
    }

    const { entries, forwards } = parseScriptCommand(command, workspaceDir);
    for (const entry of entries) {
      const normalized = entry.file.replaceAll('\\', '/');
      const source = normalized.startsWith('dist/')
        ? resolve(repoRoot, entry.workspaceDir, 'src', normalized.slice(5).replace(/\.js$/, '.ts'))
        : resolve(repoRoot, entry.workspaceDir, normalized);
      if (existsSync(source)) entryFiles.add(source);
      else unresolved.push(`${entry.workspaceDir || '.'}/${entry.file}（文件不存在）`);
    }
    for (const forward of forwards) {
      if (forward.workspace === null) {
        walk(forward.script, workspaceDir, scriptTable);
        continue;
      }
      const target = workspaces.byName.get(forward.workspace);
      if (!target) {
        unresolved.push(`workspace ${forward.workspace}（未登记）`);
        continue;
      }
      walk(forward.script, target.dir, target.scripts);
    }
  };

  walk(scriptName, '', workspaces.rootScripts);
  return { entryFiles: [...entryFiles], unresolved, cycles };
}

/** 一条根 script 的完整依赖判定。 */
export function classifyScript(repoRoot, workspaces, scriptName) {
  const { entryFiles, unresolved, cycles } = resolveScriptEntries(repoRoot, workspaces, scriptName);
  const requirements = new Set();
  const envVars = new Set();
  let analyzedFiles = 0;
  for (const entry of entryFiles) {
    const analysis = analyzeEntry(entry);
    analyzedFiles += analysis.analyzedFiles;
    for (const requirement of analysis.requirements) requirements.add(requirement);
    for (const envVar of analysis.envVars) envVars.add(envVar);
  }
  return {
    scriptName,
    entryFiles,
    unresolved,
    cycles,
    analyzedFiles,
    envVars: [...envVars].sort(),
    requirements: requirements.size === 0 ? ['none'] : [...requirements].sort()
  };
}
