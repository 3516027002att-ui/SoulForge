/**
 * 由「约定 + 例外表 + 入口声明」算出的层级表（#35）。
 *
 * verify.mjs 从这里拿 TIER_BY_SCRIPT，判据与 discover.mjs 完全一致，因此
 * "调度用什么"和"对账用什么"不再是两张表。
 *
 * 数据来源三层，优先级从高到低：
 *   1. suite-traits.json：非测试验证入口的显式声明（bridge:verify:* 等 45 条）；
 *   2. tier-exceptions.json：约定判错的层级例外（85 条）；
 *   3. tier-convention.mjs：名字 + 命令路径的约定（其余 255 条）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCLUDED } from './tiers.mjs';
import {
  classifyByConvention,
  isSuiteScript,
  loadSuiteTraits,
  loadTierExceptions,
  loadWorkspaceScripts,
  resolveCommand
} from './tier-convention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildTierMap() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  const exceptions = loadTierExceptions();
  const traits = loadSuiteTraits();
  const workspaceScripts = loadWorkspaceScripts(root);
  const map = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue;
    if (EXCLUDED[name]) continue;
    if (isSuiteScript(name, command)) {
      map[name] = exceptions[name]?.tier
        ?? classifyByConvention(name, resolveCommand(command, workspaceScripts));
      continue;
    }
    // 非测试验证入口：只认显式声明，不猜。
    if (traits[name]) map[name] = traits[name].tier;
  }
  return map;
}

export const TIER_BY_SCRIPT = Object.freeze(buildTierMap());
