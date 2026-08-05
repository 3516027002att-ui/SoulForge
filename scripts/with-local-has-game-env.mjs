/**
 * Local has-game env injector for developer machines.
 *
 * Only fills missing SOULFORGE_* vars when BOTH:
 * - a readable local Sekiro root exists (see localGameRootCandidates), and
 * - testdata/native-fixtures/has-game-registry.json is readable.
 *
 * Never invents paths. Never writes game root/mods. Never overrides
 * already-set env values. Absence of local paths leaves env empty so
 * callers stay fail-closed / honest-skip.
 */
import { access, constants } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localGameRootCandidates = [
  'D:\\mystream\\Sekiro Shadows Die Twice\\Sekiro',
  resolve(repoRoot, 'Sekiro Shadows Die Twice')
];
const localRegistryPath = resolve(
  repoRoot,
  'testdata/native-fixtures/has-game-registry.json'
);

async function isReadable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error(
    JSON.stringify({
      ok: false,
      code: 'HAS_GAME_ENV_WRAPPER_USAGE',
      message: 'usage: node scripts/with-local-has-game-env.mjs <command> [args...]'
    })
  );
  process.exit(2);
}

const env = { ...process.env };
const existingGame = env.SOULFORGE_SEKIRO_GAME_ROOT?.trim() || '';
const existingFixtureRoot = env.SOULFORGE_NATIVE_FIXTURE_ROOT?.trim() || '';
const existingRegistry = env.SOULFORGE_NATIVE_FIXTURE_REGISTRY?.trim() || '';

if (!existingGame || !existingFixtureRoot || !existingRegistry) {
  const registryOk = await isReadable(localRegistryPath);
  if (registryOk) {
    for (const candidate of localGameRootCandidates) {
      if (!(await isReadable(candidate))) continue;
      if (!existingGame) env.SOULFORGE_SEKIRO_GAME_ROOT = candidate;
      if (!existingFixtureRoot) env.SOULFORGE_NATIVE_FIXTURE_ROOT = candidate;
      if (!existingRegistry) env.SOULFORGE_NATIVE_FIXTURE_REGISTRY = localRegistryPath;
      break;
    }
  }
}

const [command, ...args] = argv;
const isNpm = command.toLowerCase() === 'npm' || command.toLowerCase() === 'npm.cmd';
const npmCli = process.env.npm_execpath?.trim()
  || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const executable = isNpm ? process.execPath : command;
const childArgs = isNpm ? [npmCli, ...args] : args;
const child = spawn(executable, childArgs, {
  env,
  stdio: 'inherit',
  shell: false,
  windowsHide: true
});

child.on('error', (error) => {
  console.error(
    JSON.stringify({
      ok: false,
      code: 'HAS_GAME_ENV_WRAPPER_SPAWN_FAILED',
      message: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
