// The merge gate. CI runs exactly this; agents run it before pushing.
// It must not need game files, private corpora, GPUs or network models.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrustZoneCheck } from './trust-zone-check.mjs';

// Every `npm run <script>` / `node <file>` that an agent document tells agents
// to run must exist, so the entry document cannot drift from the repository.
export function findMissingDocumentedCommands(text, scripts, fileExists) {
  const missing = [];
  for (const [, command] of text.matchAll(/`([^`\n]+)`/gu)) {
    const npm = /^npm run ([\w:.-]+)/u.exec(command);
    if (npm && !Object.hasOwn(scripts, npm[1])) missing.push(command);
    const node = /^node ((?:scripts|tools)\/[\w./-]+\.m?js)/u.exec(command);
    if (node && !fileExists(node[1])) missing.push(command);
  }
  return missing;
}

function documentedCommands(root) {
  const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {};
  const missing = findMissingDocumentedCommands(readFileSync(resolve(root, 'AGENTS.md'), 'utf8'), scripts,
    path => existsSync(resolve(root, path)));
  if (missing.length) throw new Error(`AGENTS.md names commands that do not exist: ${missing.join(', ')}`);
}

function trustZone(root) {
  const result = runTrustZoneCheck({ cwd: root });
  if (!result.ok) {
    throw new Error(`TRUST_ZONE_MIXED against ${result.base}: zone [${result.zone.join(', ')}] with other [${result.other.slice(0, 20).join(', ')}${result.other.length > 20 ? ', ...' : ''}]`);
  }
}

function run(root, command) {
  // shell: npm is a .cmd shim on Windows. Commands are fixed strings, not input.
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true,
    env: { ...process.env, SOULFORGE_CONTRACT_REQUIRE_BUNDLES: '1' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`exit ${result.status ?? result.signal}`);
}

export const GATE_STEPS = Object.freeze([
  ['documented commands exist', root => documentedCommands(root)],
  ['trust-zone isolation', root => trustZone(root)],
  ['bridge publish', root => run(root, 'npm run bridge:publish')],
  ['build', root => run(root, 'npm run build')],
  // typecheck, unit tests, Bridge synthetic fixtures and the check runner's own tests.
  ['checks', root => run(root, 'node scripts/check.mjs --tier governance,unit,synthetic --json-out output/gate-checks.json --timeout-ms 2700000')]
]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  for (const [name, step] of GATE_STEPS) {
    const started = Date.now();
    console.log(`\n[gate] ${name}`);
    try { step(root); }
    catch (error) {
      console.error(`[gate] FAILED: ${name}: ${error.message}`);
      process.exit(1);
    }
    console.log(`[gate] ok: ${name} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  console.log('\n[gate] all steps passed');
}
