// The merge gate. CI runs exactly this; agents run it before pushing.
// It must not need game files, private corpora, GPUs or network models.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBase, runTrustZoneCheck } from './trust-zone-check.mjs';

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

// A developer's machine paths must not land in the repository: defaults, tests and documents that name them work
// only on that machine. Added lines are compared with this machine's real paths (home, repository roots and every
// SOULFORGE_* value that exists on disk), not with a name pattern, so renaming a variable cannot hide a leak.
// On CI the needles are the runner's paths, so the run that catches a leak is the agent's local gate before pushing.
// docs/ai-logs/ is synced from local sessions; whether it stays public is the owner's open decision.
export const LOCAL_PATH_EXEMPT = Object.freeze(['docs/ai-logs/']);

export function localPathNeedles(env, { home, roots = [], exists = existsSync } = {}) {
  const configured = Object.entries(env).filter(([key]) => key.toUpperCase().startsWith('SOULFORGE_')).map(([, value]) => value);
  const needles = new Set();
  for (const candidate of [home, ...roots, ...configured]) {
    const value = candidate?.trim();
    if (!value || !win32.isAbsolute(value) || !exists(value)) continue;
    const normalized = value.replaceAll('\\', '/').replace(/\/+$/u, '');
    // A drive or filesystem root alone would match every absolute path.
    if (normalized.split('/').filter(Boolean).length < 2) continue;
    needles.add(normalized);
  }
  return [...needles];
}

// Source spells one path many ways: forward slashes, backslashes escaped any number of times, mixed, a file URL.
// All fold to one forward-slash form before matching. A match must end at a path boundary, so C:/Users/dev does
// not match C:/Users/developer.
function canonicalPathText(text) {
  return text.replace(/\\+/gu, '/').replaceAll('%20', ' ');
}

function containsPath(text, needle) {
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
    if (!/[\w-]/u.test(text[index + needle.length] ?? '')) return true;
  }
  return false;
}

export function findLocalPathLeaks(addedLines, needles, { platform = process.platform, exempt = LOCAL_PATH_EXEMPT } = {}) {
  const fold = platform === 'win32' ? value => value.toLowerCase() : value => value;
  const forms = needles.map(needle => ({ needle, form: fold(needle) }));
  const leaks = [];
  for (const { path, line, text } of addedLines) {
    if (exempt.some(prefix => path.startsWith(prefix))) continue;
    const folded = fold(canonicalPathText(text));
    const hit = forms.find(({ form }) => containsPath(folded, form));
    if (hit) leaks.push({ path, line, needle: hit.needle });
  }
  return leaks;
}

// `git diff -U0` output -> one entry per added line with its line number in the new file. Header lines are only
// read between `diff --git` and the first hunk, so an added line whose text starts with "++ " is not a header.
export function parseAddedLines(diff) {
  const added = [];
  let path, line, header = false;
  for (const raw of diff.split('\n')) {
    const text = raw.replace(/\r$/u, '');
    if (text.startsWith('diff --git ')) { header = true; path = undefined; line = undefined; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) { header = false; line = Number(hunk[1]); continue; }
    if (header) {
      if (text.startsWith('+++ ')) path = gitPath(text.slice(4).replace(/\t$/u, ''));
      continue;
    }
    if (path && line !== undefined && text.startsWith('+')) added.push({ path, line: line++, text: text.slice(1) });
  }
  return added;
}

function gitPath(target) {
  if (target === '/dev/null') return undefined;
  const unquoted = target.startsWith('"') ? target.slice(1, -1).replace(/\\(["\\])/gu, '$1') : target;
  return unquoted.replace(/^b\//u, '');
}

function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Untracked files are part of the change (trust-zone-check counts them too). Nested repositories and binaries are not.
function untrackedAddedLines(cwd) {
  const added = [];
  for (const path of gitText(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    if (path.endsWith('/')) continue;
    let bytes;
    try { bytes = readFileSync(resolve(cwd, path)); } catch { continue; }
    if (bytes.subarray(0, 8000).includes(0)) continue;
    bytes.toString('utf8').split('\n').forEach((text, index) => added.push({ path, line: index + 1, text: text.replace(/\r$/u, '') }));
  }
  return added;
}

export function runLocalPathCheck({ cwd = process.cwd(), base = process.env.TRUST_ZONE_BASE, env = process.env } = {}) {
  const resolved = resolveBase(cwd, base);
  const common = resolve(cwd, gitText(cwd, ['rev-parse', '--git-common-dir']).trim());
  const roots = [gitText(cwd, ['rev-parse', '--show-toplevel']).trim(), dirname(common)];
  const diff = gitText(cwd, ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', '--no-ext-diff', '--no-color', resolved]);
  const needles = localPathNeedles(env, { home: homedir(), roots });
  return { base: resolved, needleCount: needles.length,
    leaks: findLocalPathLeaks([...parseAddedLines(diff), ...untrackedAddedLines(cwd)], needles) };
}

function localPaths(root) {
  const { base, leaks } = runLocalPathCheck({ cwd: root });
  if (leaks.length) {
    const shown = leaks.slice(0, 20).map(leak => `${leak.path}:${leak.line}`).join(', ');
    throw new Error(`LOCAL_PATH_ADDED against ${base}: ${shown}${leaks.length > 20 ? `, ... (${leaks.length} lines)` : ''}. `
      + 'Read machine paths from SOULFORGE_* environment variables instead of writing them into the repository.');
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
  ['no added local paths', root => localPaths(root)],
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
