import { mkdir, open, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessCancellation, processSucceeded, readTimeoutMs, runProcess } from './subprocess-control.mjs';
import { createOwnedTemporaryDirectory } from './owned-temporary-directory.mjs';
import {windowsCommandEnvironment} from './windows-command-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = { database: 'SOULFORGE_BUILD_DATABASE_UTILITY_SMOKE', gateway: 'SOULFORGE_BUILD_ME3_GATEWAY_SMOKE', sekiro: 'SOULFORGE_BUILD_ME3_SEKIRO_SESSION_SMOKE' };

/** Direct Node invocations have no npm_execpath. Only Windows uses Node's sibling npm layout. */
export function desktopBuildCommand(environment = process.env, platform = process.platform, nodeExecutable = process.execPath) {
  const args = ['run', 'build', '-w', '@soulforge/desktop'];
  if (environment.npm_execpath) return { command: nodeExecutable, args: [environment.npm_execpath, ...args] };
  if (platform === 'win32') return {
    command: nodeExecutable,
    args: [win32.join(win32.dirname(nodeExecutable), 'node_modules/npm/bin/npm-cli.js'), ...args]
  };
  // Preserve PATH-based executable resolution without a shell or an assumed npm installation prefix.
  return { command: 'npm', args };
}

/** One output owner per test run; never publish smoke entries into production out. */
export async function withDesktopTestBuild(kind, execute, options = {}) {
  if (!Object.hasOwn(flags, kind)) throw new Error(`Unknown desktop smoke kind: ${kind}`);
  const repositoryRoot = options.repositoryRoot ?? root;
  const parent = join(repositoryRoot, 'output', 'desktop-smoke-builds');
  await mkdir(parent, { recursive: true });
  const workspace = await createOwnedTemporaryDirectory(`desktop-${kind}`, { parent });
  const outputRoot = workspace.root;
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
  // Windows PowerShell's special-folder lookup can be empty under an isolated
  // profile, making its module cache fall back to ./Microsoft at the repo root.
  const powershellCache=join(runtimeRoot,'powershell');
  env.PSModuleAnalysisCachePath=join(powershellCache,'ModuleAnalysisCache');
  for (const flag of Object.values(flags)) delete env[flag];
  env[flags[kind]] = '1';
  const cancellation = createProcessCancellation();
  try {
    for (const directory of new Set(Object.values(runtimeDirectories))) await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(powershellCache,{recursive:true});
    let nativeInput = null;
    if (options.reuseProductionBinding) {
      const source = join(repositoryRoot, 'apps/desktop/.native');
      const bytes = await readFile(join(source, 'better_sqlite3.node'));
      const metadataBytes = await readFile(join(source, 'better_sqlite3.json'));
      const metadata = JSON.parse(metadataBytes.toString('utf8'));
      const electronVersion = JSON.parse(await readFile(join(repositoryRoot, 'node_modules/electron/package.json'), 'utf8')).version;
      const sqliteVersion = JSON.parse(await readFile(join(repositoryRoot, 'node_modules/better-sqlite3/package.json'), 'utf8')).version;
      if (metadata.electronVersion !== electronVersion || metadata.betterSqlite3Version !== sqliteVersion
        || metadata.platform !== process.platform || metadata.arch !== process.arch) {
        throw new Error('PRODUCTION_NATIVE_BINDING_TARGET_MISMATCH');
      }
      await mkdir(dirname(env.SOULFORGE_SQLITE_NATIVE_BINDING), { recursive: true });
      await writeFile(env.SOULFORGE_SQLITE_NATIVE_BINDING, bytes);
      await writeFile(join(dirname(env.SOULFORGE_SQLITE_NATIVE_BINDING), 'better_sqlite3.json'), metadataBytes);
      nativeInput = { source: 'production-build', sha256: createHash('sha256').update(bytes).digest('hex'),
        metadataSha256: createHash('sha256').update(metadataBytes).digest('hex'),
        electronVersion, betterSqlite3Version: sqliteVersion, platform: process.platform, arch: process.arch };
    }
    if (options.build !== false) {
      const { command, args } = desktopBuildCommand(env);
      const buildEnv=process.platform==='win32'?windowsCommandEnvironment(env):env;
      const result = await runProcess({ command, args, cwd: repositoryRoot, env:buildEnv, owner: workspace,
        timeoutMs: readTimeoutMs('SOULFORGE_BUILD_TIMEOUT_MS', 20 * 60 * 1000), signal: cancellation.signal,
        onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
      if (!processSucceeded(result)) {
        // 诊断：构建失败时把 stderr 尾部带进异常。否则真正的编译/准备错误在抛错前就丢了，
        // 而 check 只保留套件级 tail（定位 me3 偶发失败时看不到 prepare 的真实输出）。
        const detail = (result.stderr ?? '').trim().split(/\r?\n/u).filter(Boolean).slice(-20).join('\n');
        throw new Error(`Desktop smoke build failed: ${result.terminationReason ?? result.code}${detail ? `\n${detail}` : ''}`);
      }
    }
    if (nativeInput) {
      const testedHash = createHash('sha256').update(await readFile(env.SOULFORGE_SQLITE_NATIVE_BINDING)).digest('hex');
      const testedMetadataHash = createHash('sha256').update(await readFile(join(dirname(env.SOULFORGE_SQLITE_NATIVE_BINDING), 'better_sqlite3.json'))).digest('hex');
      if (testedHash !== nativeInput.sha256 || testedMetadataHash !== nativeInput.metadataSha256) {
        throw new Error('PRODUCTION_NATIVE_SNAPSHOT_CHANGED');
      }
    }
    return await execute({ outputRoot, env, signal: cancellation.signal, nativeInput, processOwner: workspace });
  } finally { cancellation.dispose(); await workspace.dispose(); }
}

export function desktopSmokeArgs(entry, headless = false, logFile, userData) {
  return [entry, ...(headless ? ['--ozone-platform=headless'] : []),
    ...(userData ? [`--user-data-dir=${userData}`] : []),
    ...(logFile ? ['--enable-logging=file', `--log-file=${logFile}`] : [])];
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

export async function runDesktopSmoke(kind, entry, executable = process.execPath, { reuseProductionBinding = false, repositoryRoot = root } = {}) {
  return withDesktopTestBuild(kind, async ({ outputRoot, env, signal, nativeInput, processOwner }) => {
    if (nativeInput) console.log(JSON.stringify({ desktopSmokeNativeInput: nativeInput }));
    const logFile = join(outputRoot, '.runtime', 'electron.log');
    const entryPath = join(outputRoot, 'main', entry);
    // Select the profile before Chromium initializes; environment overrides
    // alone do not bind its actual DIR_USER_DATA to this output owner.
    const userData = join(outputRoot, '.runtime', 'electron-user-data');
    await mkdir(userData, { recursive: true });
    const result = await runProcess({ command: executable,
      args: desktopSmokeArgs(entryPath, process.platform === 'linux' && env.SF_E2E_HEADLESS === '1', logFile, userData), cwd: repositoryRoot,
      env: { ...env, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_LOG_FILE: logFile }, signal, owner: processOwner,
      timeoutMs: readTimeoutMs('SOULFORGE_SMOKE_TIMEOUT_MS', 10 * 60 * 1000),
      onStdout: chunk => process.stdout.write(chunk), onStderr: chunk => process.stderr.write(chunk) });
    if (!processSucceeded(result)) {
      let nativeLog;
      try { nativeLog = await readDesktopSmokeLog(logFile); }
      catch (error) { nativeLog = { available: false, error: error.message }; }
      let nativeBindingSha256 = null;
      try { nativeBindingSha256 = createHash('sha256').update(await readFile(env.SOULFORGE_SQLITE_NATIVE_BINDING)).digest('hex'); }
      catch { /* Failed builds/early exits do not imply a native binding exists. */ }
      console.error(JSON.stringify({ kind, status: 'failed', code: result.code,
        signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled,
        terminationReason: result.terminationReason, leakedDescendantCount: result.leakedDescendantCount,
        leakedDescendants: result.leakedDescendants, descendantSettleMs: result.descendantSettleMs, nativeLog, nativeBindingSha256 }, null, 2));
    } else if (result.descendantSettleMs !== undefined) {
      // Evidence for the Guardian grace window: how long Electron's own
      // descendants took to exit after the browser process did.
      console.error(JSON.stringify({ kind, status: 'passed', descendantSettleMs: result.descendantSettleMs }));
    }
    return processSucceeded(result) ? 0 : result.code || 1;
  }, { reuseProductionBinding, repositoryRoot });
}
