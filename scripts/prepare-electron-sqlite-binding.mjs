import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import {
  createProcessCancellation,
  readTimeoutMs,
  runProcess
} from './subprocess-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electronVersion = JSON.parse(
  await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version;
const nativeRoot = process.env.SOULFORGE_TEST_BUILD_ROOT
  ? join(resolve(process.env.SOULFORGE_TEST_BUILD_ROOT), '.native')
  : join(root, 'apps', 'desktop', '.native');
const sourceModule = join(root, 'node_modules', 'better-sqlite3');
const betterSqlite3Package = JSON.parse(
  await readFile(join(sourceModule, 'package.json'), 'utf8')
);
const targetBinding = join(nativeRoot, 'better_sqlite3.node');
const metadataPath = join(nativeRoot, 'better_sqlite3.json');

await run();

async function run() {

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

  // MSVC still enforces MAX_PATH in generated tlogs. Publish the binding into
  // its output owner after compiling in a shorter, separately owned scratch.
  const scratch = process.platform === 'win32'
    ? await createOwnedTemporaryDirectory('sqlite') : null;
  const buildRoot = scratch?.root ?? join(nativeRoot, 'electron-rebuild');
  const isolatedModules = join(buildRoot, 'node_modules');
  const isolatedModule = join(isolatedModules, 'better-sqlite3');
  const isolatedBinding = join(isolatedModule, 'build', 'Release', 'better_sqlite3.node');
  try {
    if (!scratch) {
      assertInside(nativeRoot, buildRoot);
      await rmWithRetry(buildRoot);
    }
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
    // Resolve with node-gyp's existing selection/validation before removing the
    // caller's search paths. Python may be installed outside Windows itself.
    const pythonExecutable = process.platform === 'win32'
      ? await resolveWindowsRebuildPython() : undefined;
    const buildEnv = {
      ...(process.platform === 'win32'
        ? createWindowsRebuildEnvironment(process.env, process.execPath, pythonExecutable)
        : process.env),
      // @electron/rebuild resolves its header cache from os.homedir(). Keep
      // compiler/download caches local to this task, even on a restricted host.
      ...(process.platform === 'win32'
        ? { USERPROFILE: resolve(buildRoot, 'home') }
        : { HOME: resolve(buildRoot, 'home') }),
      npm_config_cache: resolve(buildRoot, 'cache/npm'),
      electron_config_cache: resolve(buildRoot, 'cache/electron'),
      ...(process.platform === 'win32' ? {
        CL: appendFlag(process.env.CL, '/Brepro'),
        LINK: appendFlag(process.env.LINK, '/Brepro')
      } : {})
    };
    await mkdir(resolve(buildRoot, 'home'), { recursive: true });
    const rebuildTimeoutMs = readTimeoutMs(
      'SOULFORGE_SQLITE_REBUILD_TIMEOUT_MS',
      15 * 60 * 1000
    );
    const cancellation = createProcessCancellation();
    const rebuilt = await runProcess({
      command,
      args,
      owner: scratch ?? undefined,
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
  } finally { await scratch?.dispose(); }
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

async function resolveWindowsRebuildPython() {
  const { default: PythonFinder } = await import('node-gyp/lib/find-python.js');
  return PythonFinder.findPython(process.env.npm_config_python);
}

function createWindowsRebuildEnvironment(env, nodeExecutable, pythonExecutable) {
  const child = { ...env };
  const systemRoot = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1]
    ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'WINDIR')?.[1];
  if (!systemRoot) throw new Error('ELECTRON_SQLITE_REBUILD_WINDOWS_ENV_MISSING: SystemRoot was not found.');
  if (!pythonExecutable) throw new Error('ELECTRON_SQLITE_REBUILD_PYTHON_MISSING: node-gyp did not resolve a Python executable.');
  // MSBuild's SQLite copy action invokes bare node. Give this owned child the
  // actual runtime plus system supervision tools, avoiding cmd's PATH limit and
  // duplicate case-insensitive PATH keys inherited from npm/developer shells.
  for (const key of Object.keys(child)) {
    if (['PATH', '__VSCMD_PREINIT_PATH'].includes(key.toUpperCase())) delete child[key];
  }
  child.PATH = [dirname(nodeExecutable), join(systemRoot, 'System32'), systemRoot,
    join(systemRoot, 'System32/Wbem'), join(systemRoot, 'System32/WindowsPowerShell/v1.0')].join(';');
  child.NODE_GYP_FORCE_PYTHON = pythonExecutable;
  return child;
}
