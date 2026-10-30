#!/usr/bin/env node
/**
 * 对拍：`package.json` 里 `test*` 脚本注册的套件 vs `scripts/verify/checkRegistry.mjs` 的文件发现。
 *
 * 动机（#35）：登记表 `scripts/verify/tiers.mjs` 已被删除，但仍有上百个 `test:*` 脚本。
 * 删它们之前必须知道：有没有哪个套件**只**由脚本条目注册、文件发现覆盖不到——
 * 那种情况直接删会让检查静默少跑，而不是报错。
 *
 * 只读，不修改任何文件。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverChecks } from './verify/checkRegistry.mjs';
import { loadWorkspaces } from './verify/scriptGraph.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const workspaces = loadWorkspaces(repoRoot);
const registry = discoverChecks(repoRoot, workspaces);

const scriptNames = [];
for (const workspace of Object.values(workspaces.byName ?? {})) {
  for (const name of Object.keys(workspace.scripts ?? {})) {
    if (name.startsWith('test')) scriptNames.push(name);
  }
}
for (const name of Object.keys(workspaces.rootScripts ?? {})) {
  if (name.startsWith('test')) scriptNames.push(name);
}

const registryNames = new Set(registry.keys());
const onlyInScripts = scriptNames.filter((name) => !registryNames.has(name));

console.log(JSON.stringify({
  workspacePackages: Object.keys(workspaces.byName ?? {}).length,
  rootScripts: Object.keys(workspaces.rootScripts ?? {}).length,
  registryChecks: registry.size,
  testScripts: scriptNames.length,
  onlyInScripts: onlyInScripts.length,
  sampleOnlyInScripts: onlyInScripts.slice(0, 20)
}, null, 2));
