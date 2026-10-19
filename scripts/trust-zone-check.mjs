// The trust zone is the judge: CI, the gate, the check runner, the comparison
// oracle and the Patch Engine transaction core. A change to the judge must not
// ride along with the change it judges, so a diff may touch zone paths or
// other paths, never both.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Directory entries end with '/'. Keep in sync with .github/CODEOWNERS and AGENTS.md
// (scripts/gate.test.mjs asserts both).
export const TRUST_ZONE = Object.freeze([
  '.github/',
  'AGENTS.md',
  'CLAUDE.md',
  'compare/',
  'packages/core/src/patch/',
  'scripts/gate.mjs',
  'scripts/gate.test.mjs',
  'scripts/trust-zone-check.mjs',
  'scripts/trust-zone-check.test.mjs',
  'scripts/check.mjs',
  'scripts/check.fixture.mjs',
  'scripts/verify/',
  'scripts/verify-verify-entrypoint-fixtures.mjs',
  'scripts/verify-scheduling-fixtures.mjs'
]);

export function inTrustZone(path) {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  return TRUST_ZONE.some(entry => entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry);
}

export function classifyChange(paths) {
  const zone = [], other = [];
  for (const path of paths) (inTrustZone(path) ? zone : other).push(path);
  return { ok: zone.length === 0 || other.length === 0, zone, other };
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const absent = value => !value || /^0+$/u.test(value);

// An explicit base that cannot be resolved fails closed; only a missing base
// (local run, or a push that created the branch) falls back to origin/main.
export function resolveBase(cwd, explicit) {
  const ref = absent(explicit) ? 'origin/main' : explicit;
  try { return git(cwd, ['merge-base', ref, 'HEAD']).trim(); }
  catch { throw new Error(`TRUST_ZONE_BASE_UNRESOLVED: cannot find merge-base of ${ref} and HEAD`); }
}

export function changedPaths(cwd, base) {
  const split = text => text.split('\0').filter(Boolean);
  // Working tree against base, plus untracked files, so local runs see uncommitted work.
  return [...new Set([
    ...split(git(cwd, ['diff', '--name-only', '--no-renames', '-z', base])),
    ...split(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']))
  ])].sort();
}

export function runTrustZoneCheck({ cwd = process.cwd(), base = process.env.TRUST_ZONE_BASE } = {}) {
  const resolved = resolveBase(cwd, base);
  return { base: resolved, ...classifyChange(changedPaths(cwd, resolved)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--base');
  const base = index > 0 ? process.argv[index + 1] : undefined;
  try {
    const result = runTrustZoneCheck(base === undefined ? {} : { base });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error('TRUST_ZONE_MIXED: split trust-zone paths and other paths into separate changes (see AGENTS.md).');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
