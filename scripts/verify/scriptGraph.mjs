/** npm script 与 workspace 转发图；依赖按真实入口文件判定。 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { analyzeEntry, parseScriptCommand } from './classify.mjs';
import { forwardTargets } from './commandPlan.mjs';

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
  return { rootScripts: rootPkg.scripts ?? {}, byName, byDir, analysisCache: new Map() };
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
  const active = new Set();

  const walk = (name, workspaceDir, scriptTable) => {
    const key = `${workspaceDir}::${name}`;
    if (active.has(key)) {
      cycles.push(key);
      return;
    }
    if (visited.has(key)) return;
    visited.add(key);

    const command = scriptTable[name];
    if (typeof command !== 'string') {
      unresolved.push(`${workspaceDir || '.'}:${name}（script 不存在）`);
      return;
    }
    active.add(key);

    const { entries, forwards } = parseScriptCommand(command, workspaceDir);
    for (const entry of entries) {
      const normalized = entry.file.replaceAll('\\', '/');
      const absolute = resolve(repoRoot, entry.workspaceDir, normalized);
      const repositoryPath = relative(repoRoot, absolute).replaceAll('\\', '/');
      const sourceDir = [...workspaces.byDir.keys()].find((dir) => repositoryPath.startsWith(`${dir}/dist/`));
      const source = sourceDir
        ? resolve(repoRoot, sourceDir, 'src', repositoryPath.slice(`${sourceDir}/dist/`.length).replace(/\.js$/, '.ts'))
        : absolute;
      if (existsSync(source)) entryFiles.add(source);
      else unresolved.push(`${entry.workspaceDir || '.'}/${entry.file}（文件不存在）`);
    }
    for (const forward of forwards) {
      try {
        for (const target of forwardTargets(workspaces, forward, workspaceDir)) {
          if (forward.ifPresent && !(forward.script in target.scripts)) continue;
          walk(forward.script, target.dir, target.scripts);
        }
      } catch (error) {
        unresolved.push(error.message);
      }
    }
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (scriptTable[hook]) walk(hook, workspaceDir, scriptTable);
    }
    active.delete(key);
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
    const analysis = workspaces.analysisCache?.get(entry) ?? analyzeEntry(entry);
    workspaces.analysisCache?.set(entry, analysis);
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
