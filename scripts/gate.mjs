// The merge gate. CI runs exactly this; agents run it before pushing.
// It must not need game files, private corpora, GPUs or network models.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrustZoneCheck } from './trust-zone-check.mjs';

// Every `npm run <script>` / `node <file>` that an agent document tells agents
// to run must exist, so the entry document cannot drift from the repository.
export function findMissingDocumentedCommands(text, scripts, fileExists) {
  const missing = [];
  for (const [, command] of text.matchAll(/`([^`\n]+)`/gu)) {
    const npm = /^npm run ([\w:.-]+)/u.exec(command);
    if (npm && !Object.hasOwn(scripts, npm[1])) missing.push(command);
    const node = /^node ((?:scripts|tools|compare)\/[\w./-]+\.m?js)/u.exec(command);
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

// One .NET SDK for the whole gate. `npm run bridge:publish` already prefers SOULFORGE_DOTNET or the
// repository-local SDK (scripts/run-dotnet.mjs), but fixtures spawn bare `dotnet`; on a machine whose
// PATH dotnet cannot satisfy global.json they fail with 0x80008091 while publish succeeds. CI has
// neither override, so its setup-dotnet SDK on PATH is used unchanged.
// DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: under a fresh DOTNET_CLI_HOME the SDK's first run otherwise appends
// <home>\.dotnet\tools to the persistent user PATH. Fixtures set it too; this covers one that forgets.
export function gateEnvironment(env, fileExists = existsSync) {
  const local = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'SoulForge', 'dotnet', 'dotnet.exe') : undefined;
  const sdk = [env.SOULFORGE_DOTNET, local].find(candidate => candidate && fileExists(candidate));
  const result = { ...env, SOULFORGE_CONTRACT_REQUIRE_BUNDLES: '1', DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: 'false' };
  if (!sdk) return result;
  // Windows environment keys are case-insensitive; reuse the existing key instead of adding a second PATH.
  const pathKey = Object.keys(result).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  result[pathKey] = [dirname(sdk), result[pathKey]].filter(Boolean).join(delimiter);
  return result;
}

// On Windows every step runs through cmd.exe, which stops searching PATH once it is longer than
// 8191 characters (measured: 8191 still resolves npm, 8192 reports "'npm' is not recognized").
export const CMD_PATH_LIMIT = 8191;

export function overlongCmdPath(env, platform = process.platform) {
  if (platform !== 'win32') return undefined;
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const length = pathKey ? (env[pathKey] ?? '').length : 0;
  return length > CMD_PATH_LIMIT ? length : undefined;
}

function cmdPath() {
  const length = overlongCmdPath(gateEnvironment(process.env));
  if (length) {
    throw new Error(`GATE_PATH_TOO_LONG: PATH is ${length} characters and cmd.exe cannot search past ${CMD_PATH_LIMIT}. `
      + 'Remove stale user PATH entries, such as <temp>\\dotnet-home\\.dotnet\\tools left by dotnet first runs.');
  }
}

function run(root, command) {
  // shell: npm is a .cmd shim on Windows. Commands are fixed strings, not input.
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true, env: gateEnvironment(process.env) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`exit ${result.status ?? result.signal}`);
}

export const GATE_STEPS = Object.freeze([
  ['PATH fits cmd.exe', () => cmdPath()],
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
