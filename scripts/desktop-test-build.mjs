import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessCancellation, processSucceeded, readTimeoutMs, runProcess } from './subprocess-control.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = { database: 'SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE', gateway: 'SOULFORGE_BUILD_ME3_GATEWAY_SMOKE', sekiro: 'SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE' };

/** One output owner per test run; never publish smoke entries into production out. */
export async function withDesktopTestBuild(kind, execute, options = {}) {
  if (!Object.hasOwn(flags, kind)) throw new Error(`Unknown desktop smoke kind: ${kind}`);
  const repositoryRoot = options.repositoryRoot ?? root;
  const parent = join(repositoryRoot, 'output', 'desktop-smoke-builds');
  await mkdir(parent, { recursive: true });
  const outputRoot = await mkdtemp(join(parent, `${kind}-`));
  const env = { ...process.env, SOULFORGE_TEST_BUILD_ROOT: outputRoot,
    SOULFORGE_SQLITE_NATIVE_BINDING: join(outputRoot, '.native', 'better_sqlite3.node') };
  for (const flag of Object.values(flags)) delete env[flag];
  env[flags[kind]] = '1';
  const cancellation = createProcessCancellation();
  try {
    if (options.build !== false) {
      const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build -w @soulforge/desktop'] : ['run', 'build', '-w', '@soulforge/desktop'];
      const result = await runProcess({ command, args, cwd: repositoryRoot, env,
        timeoutMs: readTimeoutMs('SOULFORGE_BUILD_TIMEOUT_MS', 20 * 60 * 1000), signal: cancellation.signal,
        onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
      if (!processSucceeded(result)) throw new Error(`Desktop smoke build failed: ${result.terminationReason ?? result.code}`);
    }
    return await execute({ outputRoot, env, signal: cancellation.signal });
  } finally { cancellation.dispose(); await rm(outputRoot, { recursive: true, force: true }); }
}

export async function runDesktopSmoke(kind, entry, executable = process.execPath) {
  return withDesktopTestBuild(kind, async ({ outputRoot, env, signal }) => {
    const result = await runProcess({ command: executable, args: [join(outputRoot, 'main', entry)], cwd: root, env, signal,
      timeoutMs: readTimeoutMs('SOULFORGE_SMOKE_TIMEOUT_MS', 10 * 60 * 1000),
      onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
    return processSucceeded(result) ? 0 : result.code || 1;
  });
}
