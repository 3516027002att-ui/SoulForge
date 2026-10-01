import { mkdtemp, mkdir, rm, open, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  // Electron startup and utility processes must not reuse a developer's profile,
  // runtime sockets or caches. Keep these with the existing per-run output owner.
  const runtimeRoot = join(outputRoot, '.runtime');
  const runtimeDirectories = {
    HOME: join(runtimeRoot, 'home'), XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'), XDG_DATA_HOME: join(runtimeRoot, 'data'),
    XDG_STATE_HOME: join(runtimeRoot, 'state'), XDG_RUNTIME_DIR: join(runtimeRoot, 'runtime'),
    ...(process.platform === 'win32' ? { USERPROFILE: join(runtimeRoot, 'home'),
      APPDATA: join(runtimeRoot, 'app-data'), LOCALAPPDATA: join(runtimeRoot, 'local-app-data') } : {})
  };
  Object.assign(env, runtimeDirectories);
  for (const flag of Object.values(flags)) delete env[flag];
  env[flags[kind]] = '1';
  const cancellation = createProcessCancellation();
  try {
    for (const directory of new Set(Object.values(runtimeDirectories))) await mkdir(directory, { recursive: true, mode: 0o700 });
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

export function desktopSmokeArgs(entry, headless = false, logFile) {
  return [entry, ...(headless ? ['--ozone-platform=headless'] : []),
    ...(logFile ? ['--enable-logging=file', `--log-file=${logFile}`] : [])];
}

/** Use a native path only for the CJS launcher; the actual ESM entry is a URL. */
export function desktopSmokeBootstrap(entry, marker) {
  return `const fs=require('node:fs');
const mark=value=>fs.appendFileSync(${JSON.stringify(marker)},value+'\\n');
mark('bootstrap-entry');
process.on('uncaughtExceptionMonitor',error=>mark('uncaught:'+error.message));
import(${JSON.stringify(pathToFileURL(entry).href)}).then(()=>mark('module-loaded')).catch(error=>{
  mark('import-failed:'+error.message);console.error(error);
  const{app}=require('electron');app.exit(1);
});\n`;
}

/** Windows Chromium child logs do not reach stderr; read only the owned tail. */
export async function readDesktopSmokeLog(logFile, maxBytes = 64 * 1024) {
  let file;
  try {
    file = await open(logFile, 'r');
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return { available: true, bytes: size, truncated: size > bytes.length, tail: bytes.subarray(0, bytesRead).toString('utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false };
    throw error;
  } finally { await file?.close(); }
}

export async function runDesktopSmoke(kind, entry, executable = process.execPath, { useBootstrap = process.platform === 'win32' } = {}) {
  return withDesktopTestBuild(kind, async ({ outputRoot, env, signal }) => {
    const logFile = join(outputRoot, '.runtime', 'electron.log');
    const entryPath = join(outputRoot, 'main', entry);
    const marker = join(outputRoot, '.runtime', 'bootstrap-stages.txt');
    const bootstrap = join(outputRoot, '.runtime', 'bootstrap.cjs');
    if (useBootstrap) await writeFile(bootstrap, desktopSmokeBootstrap(entryPath, marker));
    const result = await runProcess({ command: executable,
      args: desktopSmokeArgs(useBootstrap ? bootstrap : entryPath, process.platform === 'linux' && env.SF_E2E_HEADLESS === '1', logFile), cwd: root,
      env: { ...env, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: logFile }, signal,
      timeoutMs: readTimeoutMs('SOULFORGE_SMOKE_TIMEOUT_MS', 10 * 60 * 1000),
      onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
    if (!processSucceeded(result)) {
      let nativeLog;
      try { nativeLog = await readDesktopSmokeLog(logFile); }
      catch (error) { nativeLog = { available: false, error: error.message }; }
      let stages = { available: false }, nativeBindingSha256 = null;
      try { stages = await readDesktopSmokeLog(marker); } catch (error) { stages.error = error.message; }
      try { nativeBindingSha256 = createHash('sha256').update(await readFile(env.SOULFORGE_SQLITE_NATIVE_BINDING)).digest('hex'); }
      catch { /* Failed builds/early exits do not imply a native binding exists. */ }
      console.error(JSON.stringify({ kind, status: 'failed', code: result.code,
        signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled,
        terminationReason: result.terminationReason, nativeLog, stages, nativeBindingSha256 }, null, 2));
    }
    return processSucceeded(result) ? 0 : result.code || 1;
  });
}
