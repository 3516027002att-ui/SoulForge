import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProcessCancellation,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version;
const nativeRoot = join(root, 'apps', 'desktop', '.native');
const buildRoot = join(nativeRoot, 'electron-rebuild');
const isolatedModules = join(buildRoot, 'node_modules');
const sourceModule = join(root, 'node_modules', 'better-sqlite3');
const betterSqlite3Package = JSON.parse(
  await readFile(join(sourceModule, 'package.json'), 'utf8')
);
const isolatedModule = join(isolatedModules, 'better-sqlite3');
const isolatedBinding = join(isolatedModule, 'build', 'Release', 'better_sqlite3.node');
const targetBinding = join(nativeRoot, 'better_sqlite3.node');
const metadataPath = join(nativeRoot, 'better_sqlite3.json');

await run();

async function run() {
  assertInside(nativeRoot, buildRoot);

  // Idempotency: reuse the previously built binding when the Electron and
  // better-sqlite3 versions are unchanged, so a dev start no longer forces a
  // full native rebuild (and its rm/rebuild EBUSY window) every single time.
  if (await reusableBinding()) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      reused: true,
      electronVersion,
      targetBinding
    }, null, 2)}\n`);
    return;
  }

  await rmWithRetry(buildRoot);
  await mkdir(isolatedModules, { recursive: true });
  await writeFile(join(buildRoot, 'package.json'), `${JSON.stringify({
    name: 'soulforge-electron-native-build',
    private: true,
    dependencies: {
      'better-sqlite3': betterSqlite3Package.version
    }
  }, null, 2)}\n`, 'utf8');
  // Keep electron-rebuild's dependency walk inside the isolated copy instead of
  // discovering the repository-level node_modules through the workspace lockfile.
  await writeFile(join(buildRoot, 'package-lock.json'), '{}\n', 'utf8');
  await cp(sourceModule, isolatedModule, { recursive: true });

  const command = process.execPath;
  const args = [
    join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    '--force',
    '--version', electronVersion,
    '--module-dir', buildRoot,
    '--which-module', 'better-sqlite3',
    '--sequential'
  ];
  const buildEnv = {
    ...process.env,
    CL: appendFlag(process.env.CL, '/Brepro'),
    LINK: appendFlag(process.env.LINK, '/Brepro')
  };
  const rebuildTimeoutMs = readTimeoutMs(
    'SOULFORGE_SQLITE_REBUILD_TIMEOUT_MS',
    15 * 60 * 1000
  );
  const cancellation = createProcessCancellation();
  const rebuilt = await runProcess({
    command,
    args,
    cwd: buildRoot,
    env: buildEnv,
    timeoutMs: rebuildTimeoutMs,
    signal: cancellation.signal,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk)
  });
  cancellation.dispose();
  if (rebuilt.timedOut) {
    throw new Error(`Electron better-sqlite3 rebuild timed out after ${rebuilt.timeoutMs}ms; child process tree terminated.`);
  }
  if (rebuilt.cancelled) {
    throw new Error('Electron better-sqlite3 rebuild cancelled; child process tree terminated.');
  }
  if (rebuilt.code !== 0) {
    throw new Error(`Electron better-sqlite3 rebuild exited with ${rebuilt.code}.`);
  }

  const electronBinding = await readFile(isolatedBinding);
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(targetBinding, electronBinding);
  await writeFile(metadataPath, `${JSON.stringify({
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    betterSqlite3Version: betterSqlite3Package.version
  }, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    electronVersion,
    targetBinding,
    isolatedBuild: true
  }, null, 2)}\n`);
}

async function reusableBinding() {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const matches = metadata.electronVersion === electronVersion
      && metadata.platform === process.platform
      && metadata.arch === process.arch
      && metadata.betterSqlite3Version === betterSqlite3Package.version;
    if (!matches) return false;
    const binding = await readFile(targetBinding);
    return binding.length > 0;
  } catch {
    return false;
  }
}

async function rmWithRetry(target) {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const transient = error?.code === 'EBUSY' || error?.code === 'EPERM';
      if (!transient || attempt === attempts) throw error;
      // Windows keeps transient locks (Defender scan / stale handle) for a few
      // hundred ms after a build; back off and retry instead of failing dev.
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function assertInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  if (!childRelative || childRelative.startsWith('..') || isAbsolute(childRelative)) {
    throw new Error(`Refusing to clean native build path outside ${parent}.`);
  }
}

function appendFlag(value, flag) {
  const current = value?.trim() ?? '';
  const present = current.split(/\s+/).some((item) => item.toLowerCase() === flag.toLowerCase());
  return present ? current : `${current}${current ? ' ' : ''}${flag}`;
}
