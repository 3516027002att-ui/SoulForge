import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyCiChanges(paths, { forceInstaller = false } = {}) {
  // Only well-known documentation/governance paths take the narrow route.
  // New or unclassified files conservatively get the product checks.
  const governanceOnly = paths.length > 0 && paths.every((path) =>
    path === 'AGENTS.md' || /^docs\/.*\.(?:md|png|jpe?g|svg)$/.test(path)
    || /^docs\/governance\/.*\.jsonl?$/.test(path) || /^\.github\/[^/]+\.md$/.test(path));
  const installer = forceInstaller || paths.length === 0 || paths.some((path) =>
    /^(?:package(?:-lock)?\.json|apps\/desktop\/(?:package\.json|electron[.-]|build\/)|bridge\/|prompt\/|mutter\.md$|LICENSE$|NOTICE$|licenses\/|\.github\/workflows\/windows-ci\.yml)/.test(path)
    || ['global.json', 'scripts/run-dotnet.mjs', 'scripts/prepare-electron-sqlite-binding.mjs'].includes(path)
    || /^scripts\/(?:.*(?:installer|release|packaging|launcher|production-build)|build-.*)/.test(path));
  return { build: !governanceOnly || installer, installer,
    tiers: governanceOnly && !installer ? 'governance' : 'governance,unit,synthetic' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { CI_BASE_SHA: base, CI_HEAD_SHA: head, CI_INSTALLER: force, GITHUB_OUTPUT: output } = process.env;
  let paths = [];
  let reason = 'no-comparable-base';
  if (/^[a-f0-9]{40,64}$/i.test(base ?? '') && !/^0+$/.test(base) && /^[a-f0-9]{40,64}$/i.test(head ?? '')) {
    try {
      paths = execFileSync('git', ['diff', '--name-only', '-z', base, head], { encoding: 'utf8' }).split('\0').filter(Boolean);
      reason = 'changed-paths';
    } catch { reason = 'unavailable-base-conservative-full-checks'; }
  }
  const result = process.env.CI_MANUAL === 'true'
    ? { build: true, installer: force === 'true', tiers: 'governance,unit,synthetic' }
    : classifyCiChanges(paths, { forceInstaller: force === 'true' });
  console.log(JSON.stringify({ ...result, reason, changedFiles: paths.length }));
  if (output) appendFileSync(output, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
}
